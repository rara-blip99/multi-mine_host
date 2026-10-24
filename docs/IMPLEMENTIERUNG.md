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

## 2. Gruppe

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
| Paper-JAR herunterladen + SHA-256 prüfen | ✅ | `scripts/smoke-minecraft.ts` (manueller Test) |
| Server starten, Status, Log-Ausgabe | ✅ | `scripts/smoke-minecraft.ts` (manueller Test) |
| `save-off` / `save-all flush` / `save-on` | ✅ | im Rauchtest geprüft |
| Kontrolliertes Herunterfahren mit Welt-Speicherung | ✅ | im Rauchtest geprüft (Exit-Code 0) |
| Spielerzahl per Server-List-Ping | ✅ | im Rauchtest geprüft (0/20) |
| `server.properties`, `eula.txt`, `ops.json`, `whitelist.json` | ✅ | im Rauchtest geprüft |
| DataVersion aus `level.dat` lesen (eigener NBT-Leser) | ✅ | `minecraft-versions.test.ts` (echte Welt-Fixture) |
| Kompatibilitätsprüfung (Downgrade verhindern) | ✅ | `minecraft-versions.test.ts`, `app-service.test.ts` |
| Import einer bestehenden Welt | ✅ | `app-service.test.ts` (echte Welt-Fixture) |
| Direkte Welt-Erstellung in der App (echter Paper-Generierungslauf) | ✅ | `world-create.test.ts` — zwei echte Generierungen (Standard-Welt + Seed-Welt), danach Start über den üblichen Pfad |
| Welt-Erstellungs-Eingangsprüfung (Name, Seed, Port, Speicherplatz) vor jedem Download | ✅ | `world-create.test.ts` (ungültige Namen/Versionen/Modi, echter belegter Port, Namenskollision) |
| Seed-Übernahme in die Welt (`level.dat` als NBT-Long) | ✅ | `world-create.test.ts` — Seed `123456789` als Long aus `level.dat` gelesen |
| Operator-Eintrag bei Cheats (`ops.json`) | ✅ | `world-create.test.ts` |
| Weltwechsel unter laufendem Server: klarer Abbruch statt falscher „Start" | ✅ | `world-create.test.ts` (Regressionstest) |
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
| Auswahl einer vorhandenen Welt als aktive Welt (Existenz, Integrität, Kompatibilität vor der Auswahl geprüft) | ✅ | `world-create.test.ts` |
| Start ohne eingerichtete Welt verweist auf „Neue Welt erstellen / Vorhandene Welt auswählen" | ✅ | `world-create.test.ts` (worldMissing) |
| Parallele Doppel-Erstellung verhindert (Laufsperre) | ✅ | `world-create.test.ts` (zweiter Aufruf wird abgewiesen) |
| Verschlüsselte Übertragung | ✅ (Noise auf Transportebene) | `integration-network.test.ts` |

## 6. Backups

| Funktion | Status | Tests |
|---|---|---|
| Automatische Backups im konfigurierbaren Intervall (Standard 5 min) | ✅ | im Rauchtest geprüft |
| Welt vor dem Backup kontrolliert speichern | ✅ | im Rauchtest geprüft |
| Komprimiertes Archiv (`tar.gz`) | ✅ | `backup.test.ts` |
| Prüfsumme und Metadaten je Backup | ✅ | `backup.test.ts` |
| Erkennung beschädigter Backups | ✅ | `backup.test.ts` |
| Wiederherstellung mit Vorabvalidierung | ✅ | `backup.test.ts` |
| Vorherige Welt in Quarantäne statt Überschreiben | ✅ | `backup.test.ts` |
| Aufbewahrungsregel, letztes gültiges Backup geschützt | ✅ | `backup.test.ts` |
| Größenlimit für Backups | ✅ | `backup.test.ts` |
| Replikation auf einen zweiten PC | ✅ | (Kernmechanik getestet, Anstoß manuell) |
| Automatischer Replikations-Scheduler | ⬜ | – |
| Verschlüsselung der Backups at rest | ⬜ | – |

## 7. Oberfläche

| Bereich | Status |
|---|---|
| Dashboard (Host, Server, Mitglieder, Welt, Backup, Sync, nächster Host) | ✅ |
| Dashboard: Auswahl-Dialog ohne Welt („Neue Welt erstellen / Vorhandene Welt auswählen“) und Erstell-Fortschritt | ✅ |
| Gruppenverwaltung (erstellen, beitreten, Einladungen, Mitglieder) | ✅ |
| Weltverwaltung (Import, Neuwelt-Dialog, Auswahl einer gespeicherten Welt, Integrität, Backups, Wiederherstellung) | ✅ |
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
| Update-Manager (GitHub Releases) | ✅ | `update-manager.test.ts` |
| Autostart bei Windows-Login | 🟡 (Einstellung vorhanden, Systemintegration offen) |
| Tray-Symbol | 🟡 |

## 9. Was als Nächstes kommt

Priorisiert nach Nutzen für das Kernproblem (dynamisches Hosting):

1. **Welt-Replikation auf einen zweiten PC** – für echte Ausfallsicherheit
   ohne Datenverlust ist eine Weltkopie auf einem zweiten Mitglied nötig.
   Die Replikation von *Backups* ist umgesetzt (inkl. Ende-zu-Ende-Test);
   die der *Welt* (Datei-Spiegelung) fehlt noch.
2. **Stabile Spieleradresse** – DNS-/VPN-Anleitung und ggf. ein
   UDP-Hole-Punching.
3. **Automatische Update-Installation** – der Update-Manager lädt geprüfte
   Installer herunter, startet sie aber nicht selbst.
4. **Internet-Relay mit echtem NAT-Nachweis** – ein Circuit-Relay-v2 und
   autonat vorhanden, aber ohne End-zu-End-Prüfung hinter NAT/CGNAT.

## 9b. Ein-Klick-Start (Stand 2026-10-24)

Die Hauptaktion im Dashboard ist **„▶ Welt starten"**. Ein Klick orchestriert
folgende Schritte über genau einen Codepfad (`AppService.startWorld()`):

| Schritt | Zustand | Ergebnis |
|---|---|---|
| Gruppe eingerichtet? | ✓ verpflichtend | Verständliche Fehlermeldung, wenn nicht |
| Verbindet zum Koordinationsdienst (Hub) | ✓ | Automatische Neuverbindung alle 15 s im Hintergrund |
| Host-Lease erwerben | ✓ | über den echten Übernahme-Pfad (Failover-Mechanik) |
| Welt bereitstellen | ✓ | lokal, vom Host, aus Backup; ohne Welt: klare Rückmeldung an die Oberfläche (Wahl-Dialog „Neue Welt erstellen / Vorhandene Welt auswählen") |
| Minecraft-Server starten | ✓ | Bereitschaftscheck („Done (…)!") |
| Eingebauter Koordinationsdienst | ✓ standardmäßig aktiv | Zufallsport, keine Portkonflikte, Stable Peer-ID |
| Koordinationsstatus sichtbar | ✓ | Kachel „Koordination: verbunden/getrennt" |

Zusätzlich realisiert (Stand 2026-10-24):

| Funktion | Stand |
|---|---|
| Eingebauter Koordinationsdienst standardmäßig an | ✓ (Migration für bestehende Installationen honored) |
| Einladungslink `MMH-INV:<b64url(Hub)>.<b64url(Gruppe)>.<b64url(Code)>` | ✓ encode/parse-Tests in `tests/invite-link.test.ts` |
| Einladungslink vom Besitzer auf der Gruppe-Seite | ✓ mit Copy-Knopf |
| Bei Beitritt: Einladungslink einfügen füllt Hub + Gruppe + Code | ✓ Auto-Erkennung im Create-/Join-Modal |
| Spielerzahl per Server-List-Ping statt Log-Schätzung | ✓ im Heartbeat verbunden |
| Automatischer Firewall-Hinweis | ✓ Dashboard-Hinweis, wenn nur Privat-Adressen sichtbar sind |
| Gruppenerstellung am eigenen Hub ohne Token-Eingabe | ✓ Das Token des eingebauten Hubs wird automatisch verwendet (`tests/embedded-hub.test.ts`); ein Benutzereintrag gewinnt weiterhin, ein falsches Token schlägt fehl (fail-closed) |
| Stabile Identität des eingebauten Hubs | ✓ Ed25519-Schlüssel im Keystore - Peer-ID bleibt über Neustarts gleich |
| Stabiler Port des eingebauten Hubs | ✓ Der konkret gebundene Port wird persistiert (`embeddedHubLastPort`); bei Portkonflikt Rückfall auf einen freien Port |
| Adress-Kanonisierung | ✓ Alte Multiaddrs des eigenen Hubs (Peer-ID-Gleichheit) werden beim Verbinden auf die laufende Adresse reguliert; Einladungslink/Sitzung bleiben dadurch nutzbar |
| Hub-Neustart baut Sitzungen + Public Keys wieder auf | ✓ Nach Neustart gelten gespeicherte Sitzungstokens weiter und die Signaturprüfung funktioniert (Regressionstest in `tests/hub-service.test.ts`) |
| Hub-Verbindungsfehler blockieren den Start nicht | ✓ Beim Start missglückte Verbindungen werden im Hintergrund (alle 15 s) wiederaufgenommen |

## 9c. Direkte Welt-Erstellung in der Anwendung (Stand 2026-10-24)

Ohne existierende Welt führt „▶ Welt starten" jetzt den Nutzer durch die
Auswahl (Modal „Keine Welt vorhanden"): **Neue Welt erstellen**,
**Vorhandene Welt auswählen** oder Abbrechen. Der Erstelle-Dialog fragt
Name, Minecraft-Version, Spielmodus, Schwierigkeit, optionalen Seed und
Cheats ab. Die Umsetzung läuft über genau einen Codepfad
(`AppService.createWorld()`):

| Schritt | Verhalten |
|---|---|
| Eingangsprüfung | Gruppen/Hub aktiv, Weltname (Pfad-Traversal-, Windows-reserviert, erlaubte Zeichen), Ziel-Kollision, unterstützte Version, Spielmodus/Schwierigkeit Whitelist, Seed-Format, Port-Freiheit (echter Socket-Probe), freier Speicherplatz (≥ 1 GiB) |
| Generierung | Echter Paper-Server im temporären Bootstrap-Verzeichnis (`allowFreshWorld`), `server.properties` mit den gewählten Einstellungen (`level-seed` inkl.), Bereitschaft „Done (…s)!" |
| Übernahme | Kontrolliertes Stoppen (`save-off → save-all flush`), Integritätsprüfung des Ergebnisses, Verschieben in den Weltspeicher (Kollisionen unmöglich, Bootstrap-Rest aufräumen) |
| Produktion | Serververzeichnis mit derselben Konfiguration, bei Cheats Ersteller in `ops.json` ergänzt, Session + Journaleintrag, Start über den üblichen Ein-Klick-Pfad (Lease → Hub-Registrierung → echte Bereitschaft) |

Die Wahl einer bereits vorhandenen Welt aus dem Weltspeicher geht ebenso über
den Dialog; sie wird vor der Auswahl auf Integrität und Versionskompatibilität
geprüft. Der Start des Servers bleibt im bewährten Pfad.

Gewährleistet per Regressionstest: `tests/world-create.test.ts` (11 Fälle, zwei
echte Paper-Generierungen, echte Serverstarts, Seed 123456789n als NBT-Long
in `level.dat`, Schwierigkeitsgrad als Byte 3 „hard", Operator-Eintrag bei
Cheats, Doppel-Erstellungs-Laufsperre, Backup- und Failover-Zustand intakt,
klarer Abbruch beim Weltwechsel unter laufendem Server). Beim Weltwechsel
unterm laufenden Server verkauft `startServer()` keinen fremden Weltstand
mehr als „Start ok" - Regression durch den Welt-Erstellungstest aufgedeckt
und behoben.

## 9a. Manuell verifiziert (nicht automatisiert)

Der Rauchtest `npm run smoke:minecraft` wurde vollständig ausgeführt und
erfolgreich durchlaufen:

| Schritt | Ergebnis |
|---|---|
| Welt importieren (echte Paper-Welt) | OK |
| Paper-JAR herunterladen + SHA-256 prüfen | OK (43 MB, Build 499) |
| Minecraft-Server starten | OK (`Done (5.8s)!`) |
| Serverstatus | `running`, 4 GB RAM-Limit |
| Server-List-Ping | `Paper 1.20.4 (Protokoll 765), 0/20 Spieler` |
| Backup des laufenden Servers | OK (4 KB Archiv) |
| Server kontrolliert stoppen | OK (Exit-Code 0) |
| Weltintegrität nach dem Stopp | OK |

Der Test ist reproduzierbar: `npm run smoke:minecraft`.

Zuletzt wiederholt am 2026-10-24 nach Einführung der direkten Welt-Erstellung:
erneut vollständig bestanden (identische Schritte, Paper 1.20.4-499,
„Done!“-Bereitschaft, Server-List-Ping 0/20, Backup, Stopp, Integrität OK).

## 10. Bekannte Fehler und Lücken

| Punkt | Auswirkung |
|---|---|
| Der eingesetzte Failover wurde vollständig mit ‚smoke:failover' verifiziert (PC-A-Absturz → Lease-Übernahme → Welt aus repliziertem Backup → Serverstart) | Der weitere Test „PC-Absturz bei laufender Internet-Relay-Verbindung" fehlt nach wie vor. |
| `Fencing` verschiebt die Welt in die Quarantäne, stellt sie aber nicht automatisch wieder her | Der Host muss die Welt neu anfordern – das ist der vorgesehene Weg. |
| Der Serverstart ohne Lease wird verhindert, auch im Single-Player-Betrieb ohne Gruppe | Gewollt: ohne Hub gibt es keine Wettlaufsicherheit. Ein reiner Offline-Modus ist nicht implementiert. |
| Die Netzwerkbandbreite wird nicht gemessen | Behoben: Der Hub bietet einen Messstrom (`/multimine/speed/1.0.0`), der Upload, Download, Latenz und Jitter misst. |
| `session.lock` bleibt beim Import erhalten | Die Integritätsprüfung warnt davor. |
| Der Hub speichert seinen Zustand unverschlüsselt | `state/hub-state.json` enthält **kein Hub-Token** (dieses liegt im verschlüsselten Keystore), aber Klartext-**Einladungscodes** und **Sitzungstokens** der Mitglieder (Bearer-Credentials, gültig nur gegenüber diesem Hub). Die Datei liegt im Anwendungsdaten-Verzeichnis des Benutzerprofils; ihr Schutz entspricht dem aller Anwendungsdaten dieses Benutzers. Ein verschlüsselter Hub-Zustand ist eine mögliche künftige Verbesserung. |
