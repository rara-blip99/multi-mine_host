# Multi-Mine Host

**Dezentrales Minecraft-Hosting für Freundesgruppen.**

Mehrere PCs einer Freundesgruppe bilden gemeinsam einen Minecraft-Host. Fällt der
aktuelle Host aus, übernimmt automatisch ein anderes Mitglied – die Welt bleibt
konsistent und nachvollziehbar.

> **Status:** Frühe Entwicklungsversion (v0.1.0). Die Kernmechanik (Lease/Fencing,
> Weltübertragung, Backups, Recovery) ist implementiert und automatisiert getestet.
> Die Details des aktuellen Implementierungsstands stehen in
> [docs/IMPLEMENTIERUNG.md](docs/IMPLEMENTIERUNG.md).

---

## Inhalt

1. [Projektbeschreibung](#projektbeschreibung)
2. [Schnellstart](#schnellstart)
3. [Architektur](#architektur)
4. [Voraussetzungen](#voraussetzungen)
5. [Installation](#installation)
6. [Entwicklung und Build](#entwicklung-und-build)
7. [Einrichtung einer Gruppe](#einrichtung-einer-gruppe)
8. [Import einer vorhandenen Welt](#import-einer-vorhandenen-welt)
9. [Konfiguration eines Hosts](#konfiguration-eines-hosts)
10. [Verbindung über das Internet](#verbindung-über-das-internet)
11. [Backup- und Wiederherstellungsprozess](#backup--und-wiederherstellungsprozess)
12. [Sicherheitsmodell](#sicherheitsmodell)
13. [Bekannte Einschränkungen](#bekannte-einschränkungen)
14. [Fehlerbehebung](#fehlerbehebung)
15. [Tests](#tests)
16. [Projektstruktur](#projektstruktur)

---

## Projektbeschreibung

### Das Problem

Wenn ein Freund Minecraft auf seinem PC hostet, ist die Welt weg, sobald dieser PC
ausgeschaltet wird. Bestehende Lösungen sind entweder ein kostenpflichtiger
Hosting-Dienst oder eine manuelle Playlist, bei der jeder selbst entscheidet,
wann er „drann" ist.

### Die Lösung

Multi-Mine Host ist eine Desktop-Anwendung für Windows, die mehrere PCs zu
einer Gruppe verbindet:

- Jeder PC meldet seine **tatsächliche Leistung** (CPU-Auslastung, freier
  Arbeitsspeicher, Festplatte, Netzwerk, Stabilität).
- Ein **Koordinationsdienst (Hub)** vergibt eine *Host-Lease* mit monoton
  steigender Epoche. Es gibt immer nur einen schreibberechtigten Host.
- Bei einem Host-Ausfall übernimmt das am besten geeignete Mitglied – aber erst
  nach Ablauf der Lease und einer Grazienzeit.
- Die Welt wird **kontrolliert gespeichert**, per SHA-256 geprüft und auf den
  neuen Host übertragen.
- Ein alter Host, der zurückkehrt, wird **fenced**: er startet nicht wieder,
  seine lokale Welt wandert in die Quarantäne.

**Datenintegrität hat Vorrang vor Verfügbarkeit.** Wenn nicht eindeutig
feststeht, dass der vorherige Host nicht mehr schreiben kann, startet kein
zweiter Host.

---

## Schnellstart

### 1. Koordinationsdienst

Es gibt zwei Betriebsarten:

- **Eingebauter Hub (Standard):** Die Anwendung startet automatisch einen
  eigenen Koordinationsdienst (Zufallsport, in *Einstellungen* abschalt- und
  konfigurierbar). Das genügt, um eine Gruppe im Heimnetzwerk anzulegen – es
  muss nichts zusätzlich installiert werden.
- **Standalone-Hub (empfohlen für dauerhafte Gruppen):** Auf einem Rechner,
  der immer erreichbar ist (Raspberry Pi, Heimserver, PC eines Freundes, VPS):

  ```bash
  MMH_HUB_PORT=4001 MMH_HUB_TOKEN=geheim npm run hub
  ```

  Der Hub gibt seine Adresse aus, z. B.:

  ```
  Peer-ID : 12D3KooW...
  Adressen: /ip4/192.168.1.20/tcp/4001/p2p/12D3KooW...
  ```

### 2. Anwendung installieren

Auf jedem Mitglieds-PC: `npm install`, dann `npm run dev` (Entwicklung) oder den
Installer aus `npm run dist` verwenden.

### 3. Gruppe erstellen oder beitreten

- **Erster PC:** Reiter *Gruppe* → *Gruppe erstellen* → Gruppe benennen.
  Bleibt die Hub-Adresse leer, wird der eingebaute Hub genutzt. Danach zeigt
  der Besitzer pro Einladung den Code **und einen kompletten Einladungslink**.
- **Weitere PCs:** Reiter *Gruppe* → *Gruppe beitreten* → den Einladungslink
  in eines der Felder einfügen – Hub-Adresse, Gruppen-ID und Einladungscode
  werden automatisch übernommen. Alternativ die drei Werte einzeln eintragen.

Der Einladungscode hat das Format `MMH-XXXX-XXXX-XXXX` und kann am Telefon
abgelesen werden. Er ist 60 Bit stark, hat ein optionales Ablaufdatum und eine
optionale maximale Nutzungszahl. Er kann jederzeit widerrufen werden.

Der Einladungslink kombiniert alle drei Werte in einem kopierbaren Text:

```
MMH-INV:<b64url(Hub-Adresse)>.<b64url(Gruppen-ID)>.<b64url(Einladungscode)>
```

### 4. Welt bereitstellen

Reiter *Welt* → *Welt importieren* → Pfad zum bestehenden Weltordner angeben
(den Ordner, der `level.dat` enthält).

### 5. Welt starten (Ein Klick)

Reiter *Dashboard* → **▶ Welt starten**. Ein Klick orchestriert den gesamten
Weg – über denselben Codepfad wie das automatische Failover:

1. Hub-Verbindung sicherstellen (bei Verlust automatisch alle 15 s versucht),
2. Host-Lease erwerben (dieselbe Lease-Logik wie bei einer Host-Übernahme),
3. Welt bereitstellen (lokal, vom bisherigen Host, aus dem replizierten
   Backup oder als neue Welt – bei Unsicherheit kein Start),
4. Paper-Server herunterladen (nur beim ersten Mal, ca. 43 MB) und starten.

Der Fortschritt wird im Dashboard angezeigt. Werden nur Adressen aus dem
Heimnetzwerk angezeigt, weist die Oberfläche darauf hin, dass Spieler aus
anderen Netzwerken eine Port-Weiterleitung oder ein VPN am Host brauchen –
das kann die App nicht automatisch erledigen.

---

## Architektur

```
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  PC A (Host)     │        │  PC B             │        │  PC C             │
│                  │        │                  │        │                  │
│  Electron-App    │◄──────►│  Electron-App    │◄──────►│  Electron-App    │
│  ┌────────────┐  │  Noise │  ┌────────────┐  │        │  ┌────────────┐  │
│  │ libp2p    │  │  /Yamux│  │ libp2p    │  │        │  │ libp2p    │  │
│  └────────────┘  │        │  └────────────┘  │        │  └────────────┘  │
└────────┬─────────┘        └────────┬─────────┘        └────────┬─────────┘
         │  WSS/TCP                   │                            │
         └──────────────┬────────────┴────────────────────────────┘
                        │
              ┌─────────▼──────────┐
              │  Koordinations-Hub  │  (libp2p + Circuit Relay v2)
              │  - Host-Lease       │
              │  - Epochen/Fencing  │
              │  - Mitglieder/Invites│
              │  - Welt-Registry    │
              └────────────────────┘
```

### Module

| Modul | Verantwortung |
|---|---|
| `core/atomic-store` | Dauerhafter, atomarer Zustand (Temp-Datei → fsync → rename) + Journal |
| `core/logger` | Strukturierte Logs mit Redigierung sensibler Werte |
| `security/identity` | Ed25519-Identität, nodeId-Ableitung, Signieren/Prüfen |
| `security/path-guard` | Schutz gegen Path Traversal, manipulierte Archivpfade |
| `security/invites` | Einladungscodes (Hash gespeichert, Ablauf, Widerruf) |
| `security/keystore` | Verschlüsselter Geheimnisspeicher (Electron `safeStorage`/DPAPI) |
| `net/transport` | libp2p-Adapter (TCP, WebSocket, Circuit Relay v2, Noise, Yamux) |
| `net/framing` | Längenpräfixierte Frames mit Größenbegrenzung |
| `net/rpc` | Signierter Request/Response mit Replay-Schutz |
| `net/peer-manager` | Direkte Peer-Verbindungen, signierte Weltanfragen |
| `hub/hub-service` | Gruppen-, Mitglieder-, Einladungs- und Lease-Logik (ohne Netzwerk) |
| `hub/hub-node` | Netzwerk-Frontend des Hubs |
| `host/lease-authority` | Lease-Vergabe mit monotonen Epochen (Fencing-Quelle) |
| `host/lease-client` | Lease-Client mit Fencing-Erkennung |
| `host/performance` | Messung von CPU, RAM, Laufwerk, Java |
| `host/election` | Gewichtete, nachvollziehbare Kandidatenbewertung |
| `minecraft/server-manager` | Start/Stop/Save/Status des Minecraft-Servers |
| `minecraft/jar-manager` | Paper-Download mit SHA-256-Verifikation |
| `minecraft/world` | Welt-Inspektion, Integritätsprüfung, DataVersion |
| `minecraft/versions` | Minecraft-/DataVersion-Kompatibilität |
| `sync/manifest` | Welt-Manifest mit Prüfsummen, Versionierung, Diffs |
| `sync/world-sync` | Übertragungsprotokoll mit Resume und atomarer Aktivierung |
| `backup/backup-manager` | Komprimierte Backups, Prüfsummen, Aufbewahrung, Wiederherstellung |
| `app-service` | Zustandsautomat, der alles verbindet |

### Host-Übergabe (Zustandsautomat)

```
idle → detected → lease-acquired → draining → quiescing
     → transferring → verifying → starting → completed
                         ↘ failed / blocked
```

Jeder Übergang wird in das Journal (`journal.log`) geschrieben. Nach einem
Absturz lässt sich der letzte bestätigte Zustand rekonstruieren.

### Welt-Übergabe im Detail

1. Der Koordinator erkennt, dass die Lease abgelaufen ist und der bisherige
   Host sich nicht mehr meldet.
2. Ein Kandidat beantragt die Lease. Der Hub verweigert die Vergabe, solange
   die bestehende Lease gültig ist, und vergibt nach Ablauf + Grazienzeit eine
   **neue Epoche**.
3. Der neue Host fragt die Welt beim letzten Host an (signierte Anfrage).
4. Der alte Host sendet Manifest und Dateien; jede Datei wird per SHA-256
   geprüft. Unvollständige Dateien können fortgesetzt werden (Resume).
5. Der Empfänger verifiziert die Welt gegen das Manifest und aktiviert sie
   **atomar** (Staging → `rename`). Die alte Welt wandert in die Quarantäne.
6. Erst danach startet der Minecraft-Server.
7. Der neue Host committet die Weltversion beim Hub. Ein Commit mit veralteter
   Epoche wird abgelehnt (**Fencing**).
8. Der alte Host, falls er zurückkehrt, erkennt beim nächsten Lease-Renew,
   dass seine Epoche veraltet ist, stoppt den Server sofort und verschiebt
   seine lokale Welt in die Quarantäne.

---

## Voraussetzungen

### Für alle Mitglieder

- Windows 10/11 (x64) – die Anwendung ist primär für Windows developed
- [Node.js](https://nodejs.org) 20 oder neuer (nur für die Installation aus
  Quellcode nötig)
- **Java 17** (Temurin empfohlen) für Minecraft 1.20.4.
  Für 1.20.6 / 1.21.x wird **Java 21** benötigt.
  Die Anwendung findet Java automatisch über `JAVA_HOME` und `PATH` und zeigt
  die erkannte Version im Reiter *Einstellungen* an.
- ~2 GB freier Speicherplatz (Server-JAR + Welt + Backups)
- Mindestens 2 GB freier Arbeitsspeicher (4 GB empfohlen)

### Für den Hub

- Ein dauerhaft verfügbarer Rechner mit Node.js 20+
- Ein erreichbarer TCP-Port (Standard 4001)

---

## Installation

### Aus dem Quellcode (Entwickler)

```bash
git clone https://github.com/rara-blip99/multi-mine_host.git
cd multi-mine_host
npm install
npm run dev
```

### Installer erstellen

```bash
npm run dist
```

Erzeugt einen NSIS-Installer unter `release/`. Installation ohne Administrator-
rechte ist möglich.

---

## Entwicklung und Build

| Befehl | Zweck |
|---|---|
| `npm run dev` | Startet die App mit Hot Reload |
| `npm run build` | Typecheck + Produktions-Build (`out/`) |
| `npm run typecheck` | TypeScript-Prüfung (Node- und Renderer-Projekt) |
| `npm test` | Vitest-Testsuite (alle Tests) |
| `npm run test:watch` | Tests im Watch-Modus |
| `npm run hub` | Startet den Koordinations-Hub standalone |
| `npm run hub:built` | Startet den gebauten Hub (`out/main/hub.mjs`) |
| `npm run icon` | Erzeugt das Anwendungs-Icon neu |
| `npm run dist` | Build + Windows-Installer |

### Architekturregeln

- **Keine Logik im Renderer.** Der Renderer ist eine reine Ansicht; alle
  Entscheidungen fallen im Main-Prozess.
- **Framework-freie Kernmodule.** `hub-service`, `lease-authority`, `election`,
  `manifest` und `backup-manager` haben keine Electron- oder Netzwerk-
  Abhängigkeiten und sind dadurch vollständig testbar.
- **Netzwerkdaten sind Daten.** Aus dem Netzwerk kommende Pfade werden
  ausschließlich über `security/path-guard` aufgelöst. Kommandos von Mitgliedern
  werden nie als Systembefehle ausgeführt.

---

## Einrichtung einer Gruppe

### Rolle des Koordinationsdienstes

Der Hub ist die **einzige** Instanz, die Host-Leases und Epochen verwaltet.
Das ist der Grund, warum zwei Hosts nie gleichzeitig schreiben können: nur der
Hub kann eine Epoche vergeben, und er vergibt sie an genau ein Mitglied.

| Betriebsart | Wann sinnvoll |
|---|---|
| **Eingebetteter Hub** (`Einstellungen → Eingebetteter Hub`) | Ein PC in der Gruppe ist dauerhaft verfügbar (z. B. der, auf dem auch Minecraft läuft) |
| **Standalone-Hub** (`npm run hub`) | Raspberry Pi, Heimserver, VPS – empfohlen |
| **VPS** | Wenn alle Mitglieder in differenten Heimnetzen sind und der Hub port-forwarded wird |

### Schritte

1. Betriebsart wählen: eingebauter Hub (Standard) oder Standalone-Hub starten
   und Adresse notieren.
2. Erster PC: *Gruppe → Gruppe erstellen* → Name → Einladungscode und
   Einladungslink (`MMH-INV:…`) werden angezeigt.
3. Weitere PCs: *Gruppe → Gruppe beitreten* → Einladungslink einfügen (oder
   Adresse, Gruppen-ID, Code einzeln).
4. Der Besitzer kann im Reiter *Gruppe* Mitglieder entfernen, die Hosting-
   Freigabe entziehen und Einladungen widerrufen.

---

## Import einer vorhandenen Welt

1. Minecraft-Server stoppen (damit die Welt konsistent ist).
2. Reiter *Welt* → *Welt importieren*.
3. Pfad zum Weltordner angeben (der Ordner mit `level.dat`).
4. Name vergeben – die Welt wird in den Weltspeicher kopiert.

**Kompatibilitätsprüfung:** Multi-Mine Host liest die `DataVersion` aus
`level.dat` und vergleicht sie mit der konfigurierten Server-Version.

| Situation | Verhalten |
|---|---|
| DataVersion identisch | Start erlaubt |
| DataVersion älter | Start erlaubt, Hinweis „Welt wird beim Start upgradet" |
| DataVersion neuer | **Start verhindert** – ein Downgrade würde Daten zerstören |

Eine Welt aus einem zweiten laufenden Server sollte **nicht** importiert
werden. Kopieren Sie nur Welten, die nicht gerade beschrieben werden.

---

## Konfiguration eines Hosts

| Einstellung | Bedeutung |
|---|---|
| Hosting-Priorität (0–100) | Eigener Wunsch, hosten zu dürfen. Fließt mit 15 von 100 Punkten in die Bewertung ein – garantiert aber keinen Host-Status. |
| „Dieses PC darf hosten" | Abschalter. Gesperrte PCs werden nie gewählt. |
| Server-RAM | JVM-`-Xmx`. Muss zur installierten RAM-Menge passen. |
| Server-Port | TCP-Port des Minecraft-Servers. |
| Backup-Intervall | Standard: 5 Minuten. |
| Aufbewahrung | Anzahl Backups pro Art. Das letzte gültige Backup bleibt **immer** erhalten. |

### Wie die Bewertung funktioniert

Die Bewertung ist gewichtet und in der Oberfläche nachvollziehbar:

| Kriterium | Gewicht |
|---|---|
| CPU-Leistung (Kernzahl **und** Modellklasse **und** aktuelle Auslastung) | 22 |
| Netzwerk (Upload, Download, Latenz, Jitter, Relay-Penalty) | 20 |
| Stabilität (bisherige Verfügbarkeit, Laufzeit) | 15 |
| Hosting-Priorität (Vorgabe des Benutzers) | 15 |
| Arbeitsspeicher (Überschuss über den Bedarf) | 13 |
| Laufwerk (freier Platz, Schreibrate) | 10 |
| Welt bereits lokal vorhanden (kein Transfer nötig) | 5 |

Die Netzwerkwerte werden **gemessen**, nicht geschätzt: Der Hub stellt einen
Messstrom bereit, über den Upload, Download, Latenz und Jitter ermittelt
werden (alle 5 Minuten, 4 MB je Richtung).

**Harte Ausschlusskriterien** (ein Kandidat muss alle erfüllen):

- Hosting ist für das Mitglied freigegeben
- Java ist vorhanden und mindestens so neu wie erforderlich
- Freier Arbeitsspeicher ≥ benötigter Arbeitsspeicher
- Freier Speicherplatz ≥ benötigter Platz × Sicherheitsfaktor
- Der PC ist als Kandidat grundsätzlich zugelassen

Ein starker PC mit instabiler Verbindung oder zu wenig RAM wird **nicht**
bevorzugt, weil er auf der Skala nicht mit einem schwächeren, aber verfügbaren
PC mithalten kann.

---

## Verbindung über das Internet

### Was tatsächlich funktioniert

Die Software nutzt **libp2p** mit:

- **TCP** für direkte Verbindungen im selben LAN und mit Port-Weiterleitung
- **WebSocket** für Verbindungen über Proxys
- **Circuit Relay v2** als Ausweichweg: der Hub leitet Daten weiter, wenn
  eine direkte Verbindung nicht zustande kommt
- **Noise** für die Verschlüsselung (authentifiziert, Forward Secrecy)
- **Yamux** für das Multiplexing

Die eigentliche Weltübertragung läuft **direkt zwischen den PCs**, wenn das
möglich ist. Nur wenn das scheitert, wird der Relay-Weg des Hubs genutzt. Der
Hub kann die Weltdaten nicht lesen: die Verbindung zwischen den Mitgliedern ist
Ende-zu-Ende verschlüsselt.

### Was Sie brauchen

| Szenario | Voraussetzung |
|---|---|
| Alle PCs im selben LAN | Keine – läuft sofort |
| PCs in verschiedenen Heimnetzen | **Der Hub muss aus dem Internet erreichbar sein.** Dazu eine Port-Weiterleitung (TCP 4001) auf dem Hub-Rechner oder ein VPN/Overlay-Netz. |
| Der Hub steht in einem Heimnetz ohne Port-Weiterleitung | Andere Mitglieder erreichen ihn nicht → **kein Host-Wechsel möglich**. Der bestehende Server läuft weiter, aber ein Ausfall kann nicht aufgefangen werden. |

### Ehrliche Einschränkung

**Ein automatisches Hosting über das Internet ohne jede Konfiguration ist mit
den hier beschriebenen Mitteln nicht möglich.** NAT verhindert, dass ein PC
von außen kontaktiert wird. Entweder:

1. **Port-Weiterleitung** auf dem Hub (Router-Konfiguration nötig),
2. **VPN/Overlay-Netz** (z. B. WireGuard zwischen den Mitgliedern, oder Tailscale),
3. **VPS als Hub** (kleinste Variante des Rechners genügt).

Für Option 3 ist ein kostenloser Tarif oft ausreichend, ist aber nicht
garantiert verfügbar. Die Software setzt **keinen** kostenpflichtigen Dienst
voraus.

### Spieler verbinden

Der Minecraft-Server hört auf dem konfigurierten Port. Spieler verbinden sich
mit der IP-Adresse des **aktuellen Hosts** (nicht des Hubs!). Nach einem
Host-Wechsel ändert sich diese Adresse – die Oberfläche zeigt den aktuellen
Host deutlich an.

Damit Spieler keine Adresse neu eintippen müssen, ist eine stabile Adresse
nötig. Dafür gibt es drei Wege:

1. **Eigener DNS-Eintrag** (z. B. `minecraft.familie-wolff.de`) per Dynamic
   DNS auf den jeweils aktiven Host.
2. **VPN/Overlay-Netz**: alle Spieler verbinden sich mit einem festen
   Overlay-Netznamen, der immer den aktiven Host erreicht.
3. **Port-Weiterleitung + Router**: wenn der Host wechselt, muss die
   Weiterleitung angepasst werden.

Multi-Mine Host stellt **keinen** öffentlichen Tunnel-Dienst bereit; das wäre
ein kostenpflichtiger Dienst und widerspräche der Vorgabe.

---

## Backup- und Wiederherstellungsprozess

### Automatische Backups

- Standard: alle **5 Minuten**, sofern die Welt in einem konsistenten Zustand
  gesichert werden kann.
- Vor dem Backup wird der Server explizit gespeichert
  (`save-off` → `save-all flush` → `save-on`). Es wird **nie** unkontrolliert
  eine gerade veränderte Welt kopiert.
- Das Archiv ist ein komprimiertes `tar.gz`.
- Jedes Backup enthält Zeitstempel, Weltversion (Inhalts-Hash), DataVersion,
  Minecraft-Version, Größe und die **SHA-256-Prüfsumme** des Archivs.

### Aufbewahrung

- Die konfigurierte Anzahl Backups pro Art wird behalten.
- Das **letzte gültige** Backup wird immer geschützt, auch wenn die
  Aufbewahrungsregel es entfernen würde.
- Vor einer automatischen Löschung wird geprüft, ob das Backup als
  Wiederherstellungsquelle benötigt wird.

### Wiederherstellung

1. Das Archiv wird **vorher** geprüft (Prüfsumme + Archivstruktur).
2. Es wird in ein temporäres Verzeichnis entpackt.
3. Die Weltstruktur wird geprüft (`level.dat` vorhanden?).
4. Es wird automatisch ein „Vorher"-Backup angelegt.
5. Die aktive Welt wandert in die Quarantäne, die wiederhergestellte Welt wird
   aktiviert.

Ein beschädigtes Backup wird **nicht** wiederhergestellt – die aktive Welt
bleibt unangetastet.

### Replikation

Backups können auf einen zweiten Gruppen-PC kopiert werden. Der Replikations-
Mechanismus nutzt dieselbe verschlüsselte Verbindung wie die Weltübertragung.

---

## Sicherheitsmodell

### Grundsätze

1. **Verschlüsselt und authentifiziert.** Alle Peer-Verbindungen laufen über
   Noise (Ed25519 + X25519 + ChaCha20-Poly1305). Der Hub ist über die
   Peer-ID authentifiziert.
2. **Signierte Nachrichten.** Jede steuernde Nachricht wird mit dem Ed25519-
   Schlüssel des Absenders signiert. Die Signatur deckt auch das Sitzungstoken
   ab.
3. **Replay-Schutz.** Zeitstempel (max. 60 s alt) + einmalige Nonce je
   Absender.
4. **Pfadschutz.** Aus dem Netzwerk kommende Pfade sind immer relativ. Es
   werden absolute Pfade, `..`-Segmente, Laufwerksbuchstaben, UNC-Pfade,
   Nullbytes und reservierte Windows-Namen abgewiesen. Symlinks, die aus dem
   freigegebenen Verzeichnis herausführen, werden erkannt.
5. **Least Privilege.** Mitglieder sehen nur die Welt des aktiven Hosts, und
   nur während einer Host-Phase. Ein Mitglied kann keine beliebigen Dateien auf
   fremden PCs lesen.
6. **Keine Remote-Befehlsausführung.** Es gibt keinen Kanal, über den ein
   Gruppenmitglied ein Kommando auf einem fremden PC auslösen kann.
7. **Getrennte Domänen.** Netzwerkdaten werden niemals zu Systembefehlen
   zusammengesetzt.
8. **Fencing.** Der Host darf die Welt nur beschreiben, solange seine Lease
   gültig ist. Die Epoche ist monoton steigend und wird nie wiederverwendet.
9. **Sichere Geheimnisse.** Tokens werden über Electron `safeStorage`
   (Windows: DPAPI) verschlüsselt abgelegt – nie im Klartext.
10. **Keine Klartext-Passwörter in Logs.** Das Logger-Modul redigiert
    Schlüssel-artige Felder.

### Bedrohungsmodell (kurz)

| Angriff | Schutz |
|---|---|
| Fremder schickt manipulierte Welt-Dateien | SHA-256 je Datei, Manifest-Abgleich, Pfadschutz |
| Zwei Hosts schreiben gleichzeitig | Lease + monotone Epoche + Fencing-Commit |
| Alte Aufnahme wird erneut gesendet | Zeitstempelfenster + Nonce-Speicher |
| Einladungscode wird geraten | 60 Bit Entropie, Hash gespeichert, optional Ablauf/Nutzungszahl |
| Ein Mitglied liest fremde Dateien | Nur die Welt des aktiven Hosts wird angeboten, nur mit gültigem Lease |
| Tampering an Backup-Archiven | Prüfsumme, Pfadfilter beim Entpacken, Temp-Verzeichnis |
| Programmabbruch mitten im Schreiben | Atomarer Zustand + `.bak` + Journal |

---

## Bekannte Einschränkungen

Diese Punkte sind **bewusst und ehrlich** dokumentiert:

1. **Nur Minecraft Java Edition.** Die Architektur ist edition-agnostisch
   (Edition ist Teil der Einstellungen), aber Bedrock ist nicht implementiert.
2. **Nur Paper 1.20.4 ist vollständig getestet.** Weitere Versionen sind in den
   Einstellungen wählbar, benötigen aber Java 21.
3. **Der Hub ist eine Abhängigkeit.** Fällt er aus, kann kein neuer Host
   bestimmt werden. Der bestehende Server läuft weiter, bis die Lease abläuft.
4. **Kein öffentlicher Tunnel-Dienst.** Für eine stabile Adresse braucht es
   Port-Weiterleitung, VPN oder DNS.
5. **Keine automatische Port-Weiterleitung** (UPnP/NAT-PMP ist nicht
   implementiert).
6. **Die Spieleradresse ändert sich beim Host-Wechsel**, sofern kein DNS/VPN
   eingerichtet ist.
7. **Die Backup-Replikation ist manuell angestoßen** (die Übertragung läuft
   über die Peer-Verbindung, aber es gibt keinen automatischen Replikations-
   Scheduler).
8. **Es gibt noch keinen Installer-Test auf einer frischen Windows-Maschine**
   in der CI – der Installer wird erzeugt, aber nicht automatisiert geprüft.
9. **Ein Relay über den Hub** ist langsamer als eine direkte Verbindung. Die
   Oberfläche weist auf Relay-only-Kandidaten hin.
10. **Die Provider-Liste der Auswahl ist statisch.** Eine sehr seltene CPU
    (z. B. alter Xeon) wird auf die mittlere Modellstufe eingeschätzt.

---

## Fehlerbehebung

### „Der Server startet nicht"

| Ursache | Behebung |
|---|---|
| „Kein Host-Lease vorhanden" | Der PC ist nicht als Host bestimmt. Reiter *Gruppe* prüfen, ob die Hosting-Freigabe aktiv ist. |
| „Dieser Host ist gefenced" | Ein anderes Mitglied hat die Lease übernommen. Der Server bleibt zu Recht gestoppt. |
| Java-Version zu alt | Für 1.20.4 wird Java 17 benötigt, für 1.21.x Java 21. `JAVA_HOME` prüfen. |
| „Die Welt stammt aus einer neueren Minecraft-Version" | In *Einstellungen* eine passendere Version wählen oder die Welt mit der neueren Version öffnen und erneut importieren. |
| Server-JAR lädt nicht | Internetverbindung prüfen; der Download kommt von `fill-data.papermc.io`. |

### „Der Hub ist nicht erreichbar"

- Port-Weiterleitung (TCP 4001) prüfen.
- Prüfen, ob die Multiaddr-Adresse im Reiter *Gruppe* die **öffentliche**
  Adresse enthält, nicht `127.0.0.1`.
- `MMH_HUB_TOKEN` auf Hub und Clients identisch? (Nur relevant, wenn Token
  gesetzt.)

### „Die Weltübertragung bricht ab"

- Der Ziel-PC muss mindestens so viel freien Speicherplatz haben wie die Welt
  groß ist (Faktor 1,35).
- Bei einem abgebrochenen Transfer wird beim nächsten Versuch automatisch
  fortgesetzt – die `.part`-Dateien bleiben erhalten.

### „Die Übertragung ist sehr langsam"

- Der Kandidat ist nur über Relay erreichbar (in der Bewertung sichtbar).
- Eine Port-Weiterleitung auf dem Host verbessert die Geschwindigkeit
  deutlich.

### Logs

Protokolle liegen unter `%APPDATA%/multi-mine-host/logs/`. Der Reiter
*Einstellungen → Diagnosebericht* erzeugt einen kopierfertigen Bericht.

---

## Tests

```bash
npm test                 # alle Unit- und Integrationstests
npm run smoke:minecraft  # echter Paper-Server: JAR-Download, Start, SLP-Ping, Backup
npm run smoke:failover   # echte Absturz-Simulation: Backup-Replikation, Lease-Übernahme, Restore
```

Abgedeckte Bereiche:

| Bereich | Testdatei |
|---|---|
| Host-Auswahl nach Leistung | `tests/election.test.ts` |
| Lease, Epochen, Fencing | `tests/lease-authority.test.ts` |
| Gleichzeitige Host-Wahl, Netzwerktrennung | `tests/failover-scenario.test.ts` |
| Gruppen-, Mitglieder-, Einladungslogik | `tests/hub-service.test.ts` |
| Weltübertragung, Resume, Path Traversal | `tests/world-sync.test.ts` |
| Prüfsummen, Manifest, Diffs | `tests/manifest.test.ts` |
| Backups, Wiederherstellung, Aufbewahrung | `tests/backup.test.ts` |
| Absturz während des Schreibens | `tests/atomic-store.test.ts` |
| Replay, falsche Signatur, unbekannter Absender | `tests/rpc-security.test.ts` |
| Versionskonflikte, NBT-Leser | `tests/minecraft-versions.test.ts` |
| Pfadschutz | `tests/path-guard.test.ts` |
| Einladungscodes | `tests/invites.test.ts` |
| Einladungslink (kodieren/parsen) | `tests/invite-link.test.ts` |
| Framing | `tests/framing.test.ts` |
| Backup-Replikation über echtes libp2p (Regressionstest für einen Deadlock) | `tests/integration-backup-replication.test.ts` |
| Hub, Beitritt, Lease-Rennen über echtes Netzwerk | `tests/integration-network.test.ts` |

Ein Testplan für mehrere echte Windows-PCs liegt in
[docs/TESTPLAN.md](docs/TESTPLAN.md).

---

## Projektstruktur

```
multi-mine_host/
├── src/
│   ├── main/            # Main-Prozess (Node)
│   │   ├── core/        # Zustand, Logging, Pfade
│   │   ├── security/    # Identität, Schlüssel, Pfadschutz, Einladungen
│   │   ├── net/         # Transport, Framing, RPC, Peer-Verbindungen
│   │   ├── hub/         # Koordinations-Hub (Logik + Netzwerk)
│   │   ├── host/        # Lease, Election, Leistungsmessung
│   │   ├── minecraft/   # Server, JAR, Welt, Versionen
│   │   ├── sync/        # Manifest, Weltübertragung
│   │   ├── backup/      # Backup-Manager
│   │   ├── app-service.ts
│   │   └── index.ts     # Electron-Einstieg
│   ├── preload/         # Sichere IPC-Brücke
│   ├── renderer/        # React-Oberfläche
│   └── shared/          # Geteilte Typen und Protokolle
├── hub/main.ts          # Standalone-Hub
├── tests/               # Vitest-Suite
└── docs/                # Architektur, Sicherheit, Testplan
```

---

## Lizenz

MIT
