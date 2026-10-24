# Testergebnisse

Dieses Dokument wird nach jedem manuellen Testlauf ausgefüllt. Es dient als
Nachweis – es werden **nur tatsächlich durchgeführte** Tests protokolliert.

> Regel: Ein Test gilt nur als bestanden, wenn er durchgeführt und die
> Beobachtung überprüft wurde. Vermutungen werden als „nicht geprüft"
> markiert.

---

## Automatisierte Tests

| Datum | Commit | Typecheck | Tests | Build | Anmerkung |
|---|---|---|---|---|---|
| 2026-10-21 | `d683c62` | ✅ | ✅ 153 | ✅ | `npm run typecheck`, `npm test`, `npm run build` |
| 2026-10-24 | vor Commit | ✅ | ✅ 164 | ✅ | + Backup-Replikation (2 Tests, echtes libp2p), Einladungslink (5 Tests), AppService-Ein-Klick-Pruefungen (2 Tests) |
| 2026-10-24 | vor Commit | ✅ | ✅ 170 | ✅ | + Regression "Ungültiges Hub-Token"/eingebauter Hub (5 Tests in `tests/embedded-hub.test.ts`), Sitzungs-Wiederherstellung nach Hub-Neustart (1 Test in `tests/hub-service.test.ts`); dreifacher Wiederholungslauf stabil |
| 2026-10-24 | vor Commit | ✅ | ✅ 181 (21 Dateien) | ✅ | + `tests/world-create.test.ts` neu: 11 Fälle mit zwei echten Paper-Generierungen (Standard-Welt, Seed-Welt), Seed-Übernahme (level.dat, NBT-Long), Operator bei Cheats, Doppel-Erstell-Laufsperre, worldMissing, Auswahl+Start, Backup-/Failover-Integrität, Weltwechsel unter laufendem Server; Regression behoben: laufender Server einer anderen Welt wurde bei `startServer()` als "ok" verkauft, jetzt klarer Abbruch |

Automatisierte Abdeckung: siehe [TESTPLAN.md](TESTPLAN.md).

---

## Rauchtest: Minecraft-Server

| Datum | Commit | Ergebnis | Anmerkung |
|---|---|---|---|
| 2026-10-21 | `d683c62` | ✅ bestanden | siehe unten |
| 2026-10-24 | vor Commit | ✅ bestanden | Wiederholung nach dem Hub-Token-Fix |
| 2026-10-24 | vor Commit | ✅ bestanden | Wiederholung nach Einführung der direkten Welt-Erstellung (unverändert, inkl. Start mit bestätigter Bereitschaft) |

Ausführlich (`npm run smoke:minecraft`):

| Schritt | Erwartung | Ergebnis |
|---|---|---|
| Welt importieren (echte Paper-Welt) | OK | ✅ |
| Paper-JAR herunterladen + SHA-256 prüfen | OK | ✅ 43 MB, Build 499 |
| Minecraft-Server starten | OK | ✅ „Done (5.8s)!" |
| Serverstatus | running, 4 GB RAM | ✅ |
| Server-List-Ping | Paper 1.20.4, 0/20 Spieler | ✅ |
| Backup des laufenden Servers | OK | ✅ 4 KB Archiv |
| Server kontrolliert stoppen | Exit-Code 0 | ✅ |
| Weltintegrität nach dem Stopp | OK | ✅ |

---

## Failover-Test

| Datum | Commit | Ergebnis | Anmerkung |
|---|---|---|---|
| 2026-10-24 | dies vor Commit | ✅ bestanden | „ERGEBNIS: Failover erfolgreich - PC-B hostet den Server" |
| 2026-10-24 | vor Commit | ✅ bestanden | Wiederholung nach dem Hub-Token-Fix |
| 2026-10-24 | vor Commit | ✅ bestanden | Wiederholung nach Einführung der direkten Welt-Erstellung: Lease Epoche 1 → Backup repliziert (PC-B, 3875 Bytes) → PC-A hart beendet → Lease-Übernahme Epoche 2 → Welt aus repliziertem Backup → PC-B `running` |

Ausführlich (`npm run smoke:failover`, Beobachtungen aus dem Log des Laufs):

| Schritt | Erwartung | Ergebnis |
|---|---|---|
| PC-B erstellt die Gruppe | Einladungscode | ✅ `MMH-…` generiert |
| PC-A tritt bei und wird Host | Lease-Epoche 1 | ✅ „PC-A ist Host (Epoche 1)" |
| PC-A startet den Minecraft-Server | running | ✅ „Serverstart OK" |
| PC-A erstellt ein Backup | repliziert | ✅ „Backup wurde zu PC-B repliziert" (nach root-cause Fix) |
| PC-A wird hart beendet | abrupt | ✅ Absturzsimulation per Prozess-Kill |
| Lease läuft ab | ~30 s + 3 s Grace | ✅ |
| PC-B übernimmt die Lease | Epoche > 1 | ✅ „Lease vergeben … epoch: 2" |
| Kontrollierte Übergabe scheitert | erwartbar: Host tot | ✅ ECONNREFUSED → Fallback |
| PC-B stellt die Welt wieder her | aus dem replizierten Backup | ✅ „[backup] Backup wiederhergestellt" |
| PC-B startet den Server | running | ✅ „PC-B Serverstatus: running" |

Davor entdeckter und gelöster Fehler: Der Backup-Transfer hing im
`handleIncoming`→`receiveBackup`-Handshake (Empfänger liest das bereits
konsumierte Angebot erneut; zusätzlich Anspruch umgekehrtes Timing: der
Sender wartete auf eine Bestaetigung, die der Empfaenger erst nach dem
Dateiempfang schickte). Der Regressionstest
`tests/integration-backup-replication.test.ts` deckt genau diesen Pfad ab.

---

## Mehr-PC-Test (physisch)

> Diese Tests benötigen mehrere echte PCs und sind **noch nicht
> durchgeführt**. Siehe [TESTPLAN.md](TESTPLAN.md) für die Anleitung.

| Testfall | Datum | Ergebnis | Anmerkung |
|---|---|---|---|
| T1 Installation und erster Start | | nicht geprüft | |
| T2 Gruppe erstellen und beitreten | | nicht geprüft | |
| T3 Welt importieren und Server starten | | nicht geprüft | |
| T4 Kontrollierter Host-Wechsel | | nicht geprüft | |
| T5 Host-Ausfall (abrupt) | | nicht geprüft | |
| T6 Netzwerktrennung und Wiederverbindung | | nicht geprüft | |
| T7 Gleichzeitige Host-Wahl | | nicht geprüft | |
| T8 Unterbrochene Weltübertragung | | nicht geprüft | |
| T9 Zu wenig Speicherplatz | | nicht geprüft | |
| T10 Backups und Wiederherstellung | | nicht geprüft | |
| T11 Versionskonflikt | | nicht geprüft | |
| T12 Koordinationsdienst nicht erreichbar | | nicht geprüft | |
| T13 Netzwerk-Szenarien (LAN/Internet) | | nicht geprüft | |
| T14 Spielerverbindung nach Host-Wechsel | | nicht geprüft | |
| T15 Anwendung neu starten | | nicht geprüft | |

---

## Bekannte Fehler

| Datum | Beschreibung | Schwere | Status |
|---|---|---|---|
| 2026-10-24 | Backup-Replikation: Empfaenger las das Angebot doppelt und antwortete erst nach dem Dateiempfang - Sender und Empfaenger warteten gegenseitig (Deadlock). | hoch | ✅ gelöst (Regressionstest vorhanden) |
| 2026-10-24 | „Ungültiges Hub-Token" beim Erstellen einer Gruppe auf dem eingebauten Hub: der eingebaute Hub hat immer ein Token (Keystore), das Dialogformular schickte aber keins mit. | mittel | ✅ gelöst (Token wird am eigenen Hub automatisch verwendet; falsche Eingabe schlägt fehl - `tests/embedded-hub.test.ts`) |
| 2026-10-24 | Peer-ID des eingebauten Hubs war pro App-Start neu: gespeicherte Sitzungs- und Einladungsadressen verwiesen danach auf einen anderen Hub. | hoch | ✅ gelöst (persistenter Ed25519-Schlüssel für den Hub, Port-Persistenz, Adress-Kanonisierung nach Peer-ID) |
| 2026-10-24 | Nach einem Hub-Neustart gingen Sitzungstokens und Public Keys verloren (BAD_SESSION/UNKNOWN_SENDER) und der App-Start brach an einem fehlgeschlagenen Hub-Kontakt ab. | hoch | ✅ gelöst (HubService.restore baut Sitzungen + Public Keys wieder auf; der Start toleriert Verbindungsfehler und reconnectet) |
| 2026-10-24 | Nach einem Hub-Neustart verband sich die App vorher nie wieder automatisch. | mittel | ✅ gelöst (automatischer Neuverbindungsversuch alle 15 s) |
| 2026-10-24 | Beim allerersten Start in einer neuen Gruppe liess sich der Server nicht starten, weil die automatische Lease-Anforderung einen vorhandenen Welt-Eintrag im Hub verlangte - der aber erst nach dem Start entstehen kann. | hoch | ✅ gelöst (Lease erlaubt auch ohne Hub-Welt-Eintrag; lokale Welt wird bevorzugt) |

## Noch offene Einschränkungen (ehrlich)

- Der eingebaute Hub und der Minecraft-Server sind ohne manuelle
  Netzwerkkonfiguration nur im Heimnetzwerk/LAN erreichbar. Für Freunde aus
  einem anderen Heimnetzwerk braucht es weiterhin eine Port-Weiterleitung
  am Router oder einen eigenen Tunnel/VPN. Ohne diese Voraussetzung kann
  kein Beitritt aus dem Internet funktionieren - dafuer gibt es keine
  automatische Loesung an dieser Stelle.
- Ein Internet-Relay (Circuit-Relay v2) liegt als Abhaengigkeit vor, aber
  es fehlt der End-zu-End-Nachweis aus einer echten NAT-Umgebung und es
  existiert noch kein konfigurierbarer oeffentlicher Relay-Dienst.
