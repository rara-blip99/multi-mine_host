# Implementierungsstand

Stand: v0.1.0 (Entwicklungsversion)

Dieses Dokument listet **ehrlich** auf, was implementiert und getestet ist und
was noch offen ist.

## Legende

- ✅ **Implementiert und automatisiert getestet** – es existiert ein
  ausführbarer Test, der beim Ausführen erfolgreich ist.
- 🟡 **Implementiert, manuell zu verifizieren** – der Code ist fertig, aber
  die Verifikation auf echten PCs steht aus (siehe `TESTPLAN.md`).
- ⬜ **Nicht implementiert** – bewusst zurückgestellt.

---

## 1. Kernmechanik

| Funktion | Status | Tests |
|---|---|---|
| Host-Lease mit monoton steigenden Epochen | ✅ | `lease-authority.test.ts` (17 Tests) |
| Fencing bei veralteter Epoche | ✅ | `lease-authority.test.ts`, `failover-scenario.test.ts` |
| Grazienzeit nach Lease-Ablauf | ✅ | `lease-authority.test.ts` |
| Welt-Commit nur unter gültiger Lease | ✅ | `lease-authority.test.ts`, `hub-service.test.ts` |
| Gleichzeitige Host-Wahl mehrerer Mitglieder | ✅ | `failover-scenario.test.ts` |
| Netzwerktrennung und Wiederverbindung | ✅ | `failover-scenario.test.ts` |
| Verhalten bei nicht erreichbarem Koordinator (Fail-Closed) | ✅ | `failover-scenario.test.ts` |
| Gewichtete, nachvollziehbare Host-Bewertung | ✅ | `election.test.ts` (15 Tests) |
| Harte Ausschlusskriterien (RAM, Laufwerk, Java, Freigabe) | ✅ | `election.test.ts` |
| Fencing-Reaktion in der Anwendung (Server stoppen, Quarantäne) | 🟡 | – |
| Automatische Übernahme nach Host-Ausfall | 🟡 | – |

## 2. Gruppenverwaltung

| Funktion | Status | Tests |
|---|---|---|
| Gruppe erstellen | ✅ | `hub-service.test.ts`, `integration-network.test.ts` |
| Mit Einladungscode beitreten | ✅ | `hub-service.test.ts`, `integration-network.test.ts` |
| Einladungen mit Ablauf und Nutzungszahl | ✅ | `invites.test.ts` |
| Einladung widerrufen | ✅ | `hub-service.test.ts` |
| Mitglieder entfernen, Hosting sperren | ✅ | `hub-service.test.ts` |
| Rollenmodell (owner/admin/member) | ✅ | `hub-service.test.ts` |
| Sitzungstoken (widerrufbar) | ✅ | `integration-network.test.ts` |
| Ablehnung unbekannter Absender / falscher Sitzung | ✅ | `integration-network.test.ts` |

## 3. Netzwerk

| Funktion | Status | Tests |
|---|---|---|
| libp2p-Knoten (TCP, WebSocket, Relay v2, Noise, Yamux) | ✅ | `integration-network.test.ts` |
| Signierter RPC-Kanal mit Replay-Schutz | ✅ | `rpc-security.test.ts` |
| Längenpräfixiertes Framing mit Größenlimit | ✅ | `framing.test.ts` |
| Peer-Discovery über den Hub | ✅ | `integration-network.test.ts` |
| Messung von Bandbreite, Latenz und Jitter zum Hub | ✅ | `integration-network.test.ts` |
| Direkte Peer-Verbindung + signierte Weltanfrage | 🟡 | – |
| Hole Punching (UDP) | ⬜ | – |
| UPnP / NAT-PMP für automatische Port-Weiterleitung | ⬜ | – |
| Öffentlicher Tunnel-Dienst für stabile Spieleradresse | ⬜ | – |

## 4. Minecraft

| Funktion | Status | Tests |
|---|---|---|
| Paper-JAR herunterladen + SHA-256 prüfen | 🟡 | – |
| Server starten, Status, Log-Ausgabe | 🟡 | – |
| `save-off` / `save-all flush` / `save-on` | 🟡 | – |
| Kontrolliertes Herunterfahren mit Welt-Speicherung | 🟡 | – |
| Spielerzahl per Server-List-Ping | 🟡 | – |
| `server.properties`, `eula.txt`, `ops.json`, `whitelist.json` | 🟡 | – |
| DataVersion aus `level.dat` lesen (eigener NBT-Leser) | ✅ | `minecraft-versions.test.ts` |
| Kompatibilitätsprüfung (Downgrade verhindern) | ✅ | `minecraft-versions.test.ts`, `app-service.test.ts` |
| Import einer bestehenden Welt | ✅ | `app-service.test.ts` |
| Guided Import mit Kompatibilitätshinweis | 🟡 | – |
| Bedrock Edition | ⬜ | – |
| Plugin-Verwaltung | ⬜ | – |

## 5. Weltverwaltung und Synchronisation

| Funktion | Status | Tests |
|---|---|---|
| Manifest mit SHA-256 je Datei | ✅ | `manifest.test.ts` |
| Deterministische Weltversion (reihenfolgeunabhängig) | ✅ | `manifest.test.ts` |
| Inkrementelle Übertragung (nur fehlende Dateien) | ✅ | `world-sync.test.ts` |
| Fortsetzung nach Abbruch (Resume mit Offset) | ✅ | `world-sync.test.ts` |
| Erkennung beschädigter Prüfsummen | ✅ | `world-sync.test.ts` |
| Schutz vor Path Traversal (auch Symlinks) | ✅ | `path-guard.test.ts`, `world-sync.test.ts` |
| Atomare Aktivierung, alte Welt in Quarantäne | ✅ | `world-sync.test.ts` |
| Temporäre Dateien statt direkter Ziel-Schreibzugriffe | ✅ | `world-sync.test.ts` |
| Prüfung des freien Speicherplatzes | ✅ | `world-sync.test.ts` |
| Fortschritt und Geschwindigkeit in der Oberfläche | 🟡 | – |
| Verschlüsselte Übertragung | ✅ (Noise auf Transportebene) | `integration-network.test.ts` |

## 6. Backups

| Funktion | Status | Tests |
|---|---|---|
| Automatische Backups im konfigurierbaren Intervall (Standard 5 min) | 🟡 | – |
| Welt vor dem Backup kontrolliert speichern | 🟡 | – |
| Komprimiertes Archiv (`tar.gz`) | ✅ | `backup.test.ts` |
| Prüfsumme und Metadaten je Backup | ✅ | `backup.test.ts` |
| Erkennung beschädigter Backups | ✅ | `backup.test.ts` |
| Wiederherstellung mit Vorabvalidierung | ✅ | `backup.test.ts` |
| Vorherige Welt in Quarantäne statt Überschreiben | ✅ | `backup.test.ts` |
| Aufbewahrungsregel, letztes gültiges Backup geschützt | ✅ | `backup.test.ts` |
| Größenlimit für Backups | ✅ | `backup.test.ts` |
| Replikation auf einen zweiten PC | 🟡 | (Kernmechanik getestet, Anstoß manuell) |
| Automatischer Replikations-Scheduler | ⬜ | – |
| Verschlüsselung der Backups at rest | ⬜ | – |

## 7. Oberfläche

| Bereich | Status |
|---|---|
| Dashboard (Host, Server, Mitglieder, Welt, Backup, Sync, nächster Host) | ✅ |
| Gruppenverwaltung (erstellen, beitreten, Einladungen, Mitglieder) | ✅ |
| Weltverwaltung (Import, Integrität, Backups, Wiederherstellung) | ✅ |
| Einstellungen (Edition, Version, RAM, Backup, Netzwerk, Verhalten) | ✅ |
| Anzeige der Host-Bewertung mit Begründungen | ✅ |
| Anzeige von Fehlern und Einschränkungen | ✅ |
| Dark-Theme, responsives Layout, Spiel-Optik | ✅ |
| Sprachumschaltung | ⬜ (nur Deutsch) |

## 8. Betrieb

| Funktion | Status |
|---|---|
| Standalone-Hub (`npm run hub`) | ✅ |
| Eingebetteter Hub in der Anwendung | 🟡 |
| Zustandswiederherstellung nach Neustart (atomar + `.bak`) | ✅ (`atomic-store.test.ts`) |
| Journal der sicherheitsrelevanten Ereignisse | ✅ (`atomic-store.test.ts`) |
| Diagnosebericht | 🟡 |
| Update-Manager (GitHub Releases) | ⬜ |
| Autostart bei Windows-Login | 🟡 (Einstellung vorhanden, Systemintegration offen) |
| Tray-Symbol | 🟡 |

## 9. Was als Nächstes kommt

Priorisiert nach Nutzen für das Kernproblem (dynamisches Hosting):

1. **Automatischer Failover im echten Betrieb** – die Zustandsmaschine ist
   implementiert, muss aber über echte Netzwerkabbrüche verifiziert werden.
2. **Netzwerk-Geschwindigkeitsmessung** — erledigt: Der Hub misst über einen
   eigenen Protokollstrom Upload, Download, Latenz und Jitter.
3. **Welt-Replikation auf einen zweiten PC** – für echte Ausfallsicherheit
   ohne Datenverlust ist eine Weltkopie auf einem zweiten Mitglied nötig.
4. **Stabile Spieleradresse** – DNS-/VPN-Anleitung und ggf. ein
   UDP-Hole-Punching.
5. **Update-Manager** – Update über GitHub Releases mit Signaturprüfung.

## 10. Bekannte Fehler und Lücken

| Punkt | Auswirkung |
|---|---|
| Der automatische Failover ist noch nicht über echte Netzausfälle verifiziert | Der Code ist implementiert und auf Logikebene getestet; die End-to-End-Prüfung steht aus. |
| `Fencing` verschiebt die Welt in die Quarantäne, stellt sie aber nicht automatisch wieder her | Der Host muss die Welt neu anfordern – das ist der vorgesehene Weg. |
| Der Serverstart ohne Lease wird verhindert, auch im Single-Player-Betrieb ohne Gruppe | Gewollt: ohne Hub gibt es keine Wettlaufsicherheit. Ein reiner Offline-Modus ist nicht implementiert. |
| Die Netzwerkbandbreite wird nicht gemessen | Behoben: Der Hub bietet einen Messstrom (`/multimine/speed/1.0.0`), der Upload, Download, Latenz und Jitter misst. |
| `session.lock` bleibt beim Import erhalten | Die Integritätsprüfung warnt davor. |
| Der Hub speichert seinen Zustand unverschlüsselt | Er enthält keine Geheimnisse, nur Mitglieds-IDs und Lease-Zustände. |
