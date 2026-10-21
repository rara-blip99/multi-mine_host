# Architektur

Dieses Dokument beschreibt die technische Struktur von Multi-Mine Host, die
Grundprinzipien und die bewussten Entscheidungen.

## 1. Grundprinzipien

| Prinzip | Umsetzung |
|---|---|
| **Datenintegrität vor Verfügbarkeit** | Ohne eindeutig gültige Lease wird kein Server gestartet und keine Welt beschrieben. |
| **Ein Host, eine Wahrheit** | Der Koordinations-Hub ist die einzige Instanz, die Host-Leases und Epochen verwaltet. |
| **Kernlogik ohne Framework** | `hub-service`, `lease-authority`, `election`, `manifest`, `backup-manager` haben keine Electron- oder Netzwerkabhängigkeiten. |
| **Netzwerkdaten sind Daten** | Es gibt keinen Weg, über den ein Gruppenmitglied ein Kommando auf einem fremden PC auslösen kann. |
| **Nachvollziehbarkeit** | Jede Entscheidung (Host-Wahl, Lease-Vergabe, Fencing, Backup) wird protokolliert und in der Oberfläche erklärt. |

## 2. Schichten

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React)                                            │
│  - reine Ansicht, kein Zugriff auf Node-APIs                │
│  - IPC über die Preload-Brücke (contextIsolation)            │
└──────────────────────────┬───────────────────────────────────┘
                           │ typisierte IPC-Kanäle
┌──────────────────────────▼───────────────────────────────────┐
│  Main-Prozess (Electron / Node)                              │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐  │
│  │ app-service│  │   IPC-     │  │  Logging & Diagnose   │  │
│  │ (Zustands- │  │  Handler   │  │                        │  │
│  │  automaten)│  └────────────┘  └────────────────────────┘  │
│  └─────┬──────┘                                               │
│        │                                                      │
│  ┌─────▼──────────────────────────────────────────────────┐  │
│  │ Fachmodule                                             │  │
│  │  group · election · lease · peer · world · backup      │  │
│  └─────┬──────────────────────────────────────────────────┘  │
│        │                                                      │
│  ┌─────▼──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ net (libp2p)       │  │ security     │  │ core         │  │
│  │ transport, framing │  │ identity     │  │ atomic-store │  │
│  │ rpc, peer-manager  │  │ path-guard   │  │ logger       │  │
│  │                    │  │ keystore     │  │ paths        │  │
│  └────────────────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │ libp2p (Noise/Yamux)
┌──────────────────────────▼───────────────────────────────────┐
│  Koordinations-Hub                                            │
│  - Lease-Autorität (Epochen)                                 │
│  - Gruppen, Mitglieder, Einladungen                          │
│  - Welt-Registry                                             │
│  - Circuit Relay v2 (Ausweichweg für Weltdaten)              │
└──────────────────────────────────────────────────────────────┘
```

## 3. Host-Lease und Fencing

### Zustände

```
                ┌──────────┐
                │  keine  │
                └────┬─────┘
                     │ acquire
                     ▼
              ┌─────────────┐  renew (erfolgreich)   ┌─────────────┐
              │   gültig    │ ───────────────────▶  │   gültig    │
              │  (Epoche n) │ ◀───────────────────  │  (Epoche n) │
              └──────┬──────┘      renew abgelehnt   └─────────────┘
                     │
       Ablauf+Grace  │  /  superseded durch höhere Epoche
                     ▼
              ┌─────────────┐
              │   fenced    │  → Server stoppen, Welt quarantänisieren
              └─────────────┘
```

### Regeln der Lease-Autorität

1. Pro Gruppe existiert zu jedem Zeitpunkt **höchstens eine** gültige Lease.
2. Jede Vergabe erhöht die Epoche um 1. Epochen werden **nie** wiederverwendet.
3. Eine abgelaufene Lease kann erst nach Ablauf der **Grazienzeit** (3 s)
   übernommen werden. Das gibt dem bisherigen Host Zeit, seine Verlängerung
   noch abzusetzen.
4. Eine Verlängerung mit falscher Epoche oder falschem Holder wird abgelehnt
   und **fenced** den Aufrufer.
5. Ein Welt-Commit wird nur akzeptiert, wenn der Aufrufer eine gültige Lease
   mit **exakt** dieser Epoche hält.

### Warum das Split-Brain verhindert

Der entscheidende Punkt: **Es kann nicht feststehen, dass der alte Host nicht
noch schreibt** – außer der Hub sagt es. Der Hub weiß, weil er die Lease
verwaltet. Deshalb:

- Solange der Hub erreichbar ist, kann es nur einen Lease-Halter geben.
- Fällt der Host aus, läuft die Lease ab; erst danach darf ein anderer
  übernehmen (mit neuer Epoche).
- Kommt der alte Host zurück, ist seine Epoche veraltet → er wird gefenced →
  er stoppt den Server und verschiebt seine Welt in die Quarantäne.
- Fällt der Hub aus, wird **kein** neuer Host gestartet. Der bestehende Host
  läuft weiter, bis seine Lease abläuft.

### Grenzen des Modells

Der Hub ist ein Single Point of Failure. Das ist eine bewusste Abwägung:

- Eine verteilte Wahl (Raft/Paxos) unter Freunden wäre ohnehin ein
  Quorum-Problem: Bei zwei Mitgliedern braucht man 2 Stimmen, d. h. bei
  Ausfall eines Mitglieds kann niemand übernehmen – genau der Fall, den das
  Produkt abdecken soll.
- Die Alternative (Quorum-Lease unter den Mitgliedern) scheitert an der
  Partition: Zwei getrennte Netze können jeweils eine Mehrheit "sehen", wenn
  die Gruppe ≥ 3 Mitglieder hat und sich aufgeteilt.

Der Hub ist deshalb bewusst klein, simpel und austauschbar gehalten. Er läuft
auf einem Raspberry Pi genauso wie auf einem PC.

## 4. Welt-Identität

Die **Weltversion** (`versionId`) ist der SHA-256-Hash über die kanonische
Darstellung aller Manifest-Einträge (Pfad, Größe, SHA-256).

Damit gilt:

- Zwei Nodes, die dieselbe `versionId` melden, haben dieselbe Welt.
- Eine Änderung an einer einzigen Datei ändert die `versionId`.
- Die `versionId` ist unabhängig von der Reihenfolge der Dateien.

Zusätzlich wird die Minecraft-**DataVersion** aus `level.dat` gelesen (eigener
NBT-Leser, gzip-komprimiert). Sie entscheidet, ob eine Welt mit der
konfigurierten Server-Version kompatibel ist:

| DataVersion | Server | Ergebnis |
|---|---|---|
| gleich | gleich | Start erlaubt |
| kleiner | neuer | Start erlaubt, Welt wird beim Start upgradet (Hinweis) |
| größer | älter | **Start verhindert** (Downgrade würde Daten zerstören) |

## 5. Netzwerk

### Transports

| Transport | Zweck |
|---|---|
| TCP | Direkte Verbindung im LAN und mit Port-Weiterleitung |
| WebSocket | Verbindung über Proxys, die kein TCP weiterreichen |
| Circuit Relay v2 | Ausweichweg über den Hub, wenn keine direkte Verbindung zustande kommt |

### Sicherheit

- **Noise** (Ed25519 + X25519 + ChaCha20-Poly1305): authentifizierte,
  forward-secure Verschlüsselung auf Transportebene.
- **Yamux**: Multiplexing mehrerer Streams über eine Verbindung.
- **Anwendungsschicht**: Jede steuernde Nachricht ist zusätzlich mit dem
  Ed25519-Schlüssel des Absenders signiert. Das schützt auch dann, wenn ein
  Angreifer einen Relay-Pfad kontrolliert.

### Protokolle

| Protokoll | Richtung | Inhalt |
|---|---|---|
| `/multimine/hub/1.0.0` | Client ↔ Hub | Koordination (Gruppe, Lease, Welt-Registry) |
| `/multimine/peer/1.0.0` | Peer ↔ Peer | (vorgesehen) direkte Metriken |
| `/multimine/world/1.0.0` | Peer ↔ Peer | Weltübertragung |

### Framing

Alle Nachrichten werden längenpräfixiert (4 Byte Big Endian) mit einer
maximalen Frame-Größe (16 MB für Weltdaten, 8 MB sonst). Eine manipulierte
Längenangabe kann den Speicher des Empfängers nicht erschöpfen.

## 6. Zustandsmodell der Anwendung

`AppService` hält den gesamten Anwendungszustand (`AppState`) und meldet
jede Änderung an den Renderer. Die Zustände sind in `src/shared/types.ts`
typisiert.

Wichtige Zustandsübergänge:

- `hubConnected` – Ergebnis des letzten Heartbeats (10 s Intervall)
- `lease` / `fence` – Lease-Zustand und Fencing-Status
- `server` – Zustand des Minecraft-Prozesses inkl. Spielerzahl
- `sync` – Fortschritt der Weltübertragung
- `failover` – Phase des Host-Wechsels

### Dauerhafte Zustände

| Datei | Inhalt |
|---|---|
| `state/settings.json` | Benutzereinstellungen |
| `state/session.json` | Gruppen-ID, Sitzungstoken, Weltpfade, Zähler |
| `state/journal.log` | Append-only Journal aller sicherheitsrelevanten Ereignisse |
| `keys/identity.json` | Ed25519-Schlüsselpaar (Datei mit restriktiven Rechten) |
| `keys/secrets.json` | Verschlüsselte Geheimnisse (Electron `safeStorage`) |

Das Schreiben erfolgt **atomar**: temporäre Datei → `fsync` → `rename`.
Die vorherige Version bleibt als `.bak` erhalten, damit ein Absturz während
des Schreibens nicht zu Datenverlust führt.

## 7. Fehlerbehandlung

Grundsatz: **Die Anwendung bleibt bei Fehlern benutzbar.**

- Fehler in einem Hintergrund-Task (Heartbeat, Backup, Leistungsmessung) werden
  protokolliert, aber nie zum Absturz führen.
- Der Renderer bekommt Fehler als Toast-Notification, nicht als leeres Fenster.
- Kritische Fehler (keine Lease, inkompatible Welt) blockieren nur den
  Serverstart – die Oberfläche bleibt bedienbar und erklärt den Grund.
- Jeder `unhandledRejection` und jede `uncaughtException` wird protokolliert.

## 8. Erweiterbarkeit

### Bedrock Edition

Die Edition ist Teil von `AppSettings` und der Weltinformation
(`WorldRegistryEntry`). Für eine Bedrock-Implementierung müssten ergänzt
werden:

1. Ein Bedrock-Weltformat (LevelDB statt NBT/Region-Dateien).
2. Ein Bedrock-Server (z. B. BDS) statt Paper.
3. Eine eigene Kompatibilitätsprüfung (Bedrock nutzt andere Versionsnummern).

Die Module `lease-authority`, `election`, `hub-service`, `manifest` und
`world-sync` sind edition-unabhängig und müssten nicht geändert werden.

### Weitere Server-Implementierungen

`minecraft/jar-manager.ts` kapselt die Beschaffung der Server-Datei. Ein
Vanilla- oder Fabric-Server würde dort als weitere Option ergänzt; die
Konsistenzsteuerung (`save-all flush`, `stop`) ist bei allen Bukkit-Servern
identisch.

### Weitere Transport-Wege

`net/transport.ts` ist der einzige Ort, der libp2p kennt. Eine zusätzliche
Transportart (z. B. WebRTC) käme dort hinzu, ohne dass andere Module betroffen
wären.
