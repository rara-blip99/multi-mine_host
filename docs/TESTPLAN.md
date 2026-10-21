# Testplan

Dieser Testplan beschreibt, wie Multi-Mine Host **auf mehreren echten
Windows-PCs** geprüft wird. Er ergänzt die automatisierte Testsuite
(`npm test`), die auf einem Rechner läuft.

> **Wichtig:** Es wird nur behauptet, ein Szenario sei getestet, wenn es
> tatsächlich durchgeführt und protokolliert wurde. Das Protokoll
> `docs/TESTERGEBNISSE.md` wird nach jedem Testlauf ausgefüllt.

---

## 0. Automatisierte Tests (jeder Commit)

```bash
npm ci
npm run typecheck
npm test
```

Erwartung: **alle Tests grün**, keine Warnungen im Typecheck.

| Testdatei | Prüft |
|---|---|
| `tests/election.test.ts` | Host-Auswahl nach Leistung, Harte Kriterien, Priorität |
| `tests/lease-authority.test.ts` | Lease, Epochen, Fencing, Grazienzeit |
| `tests/failover-scenario.test.ts` | Szenarien: Ausfall, Gleichzeitigkeit, Netzwerktrennung, Koordinationsausfall |
| `tests/hub-service.test.ts` | Gruppen, Einladungen, Mitglieder, Rechte |
| `tests/world-sync.test.ts` | Übertragung, Resume, Prüfsummen, Path Traversal |
| `tests/manifest.test.ts` | Manifest, Versionierung, inkrementelle Diffs |
| `tests/backup.test.ts` | Backups, Wiederherstellung, Aufbewahrung, Korruption |
| `tests/atomic-store.test.ts` | Absturz während des Schreibens, Journal |
| `tests/rpc-security.test.ts` | Signaturen, Replay, unbekannte Absender |
| `tests/minecraft-versions.test.ts` | Versionskonflikte, NBT-Leser |
| `tests/path-guard.test.ts` | Path Traversal, Symlink-Escape |
| `tests/invites.test.ts` | Einladungscodes, Ablauf, Widerruf |
| `tests/framing.test.ts` | Framing, Frame-Limits |
| `tests/integration-network.test.ts` | **Echtes libp2p-Netz**: Hub + 2 Mitglieder |
| `tests/app-service.test.ts` | **Rauchtest**: Welt importieren, Backup, Restore |

---

## 1. Vorbereitung

### Benötigte Hardware

| Rolle | Anforderung |
|---|---|
| Hub | Dauerhaft verfügbar (Raspberry Pi, Heimserver, PC oder VPS), Node.js 20+ |
| PC A | Windows 10/11 x64, 4 GB RAM, Java 17 |
| PC B | Windows 10/11 x64, 4 GB RAM, Java 17 |
| PC C (optional) | Schwächerer PC zum Testen der Bewertung |

### Netzwerk-Varianten

| Variante | Beschreibung |
|---|---|
| **V1 – LAN** | Alle PCs im selben LAN, Hub ohne Port-Weiterleitung |
| **V2 – Internet, port-forwarded Hub** | Hub mit öffentlicher Adresse |
| **V3 – Internet, Hub ohne Port-Weiterleitung** | Negativtest: es darf **kein** Host-Wechsel passieren |

### Testwelt

**Immer mit einer Wegwerf-Welt testen!** Niemals mit echten Spielständen.

1. Minecraft-Server 1.20.4 starten (Java 17).
2. Eine neue Welt in einem bekannten Verzeichnis anlegen.
3. ~5 Minuten spielen (Gebäude bauen,/items platzieren).
4. Welt mit der Welt-Version 1.20.4 exportieren/kopieren.

---

## 2. Testfälle

### T1 – Installation und erster Start

| Schritt | Erwartung |
|---|---|
| Installer auf PC A ausführen | Installation ohne Administratorrechte möglich |
| Anwendung starten | Dashboard erscheint, keine Fehlermeldung |
| Reiter *Einstellungen* öffnen | Java-Version wird angezeigt |
| Fenster schließen | Anwendung läuft weiter (Standard: `keep-running`) |
| Erneut öffnen | Zustand (Einstellungen) ist erhalten |

### T2 – Gruppe erstellen und beitreten

| Schritt | Erwartung |
|---|---|
| PC A: Hub-Adresse eintragen, Gruppe erstellen | Gruppen-ID und Einladungscode werden angezeigt |
| PC B: mit Adresse, ID und Code beitreten | PC B erscheint in der Mitgliederliste von A |
| PC A: Mitgliederliste prüfen | Beide PCs online, Rollen korrekt |
| PC B: versucht mit falschem Code beizutreten | Fehlermeldung, kein Beitritt |
| PC A: Einladung widerrufen | Code funktioniert nicht mehr |
| PC A: PC B entfernen | PC B ist kein Mitglied mehr |
| PC B: versucht einen Request zu senden | Wird abgelehnt |

### T3 – Welt importieren und Server starten

| Schritt | Erwartung |
|---|---|
| PC A: Wegwerf-Welt importieren | Erfolgreich, Integrität „in Ordnung" |
| PC A: Server starten | Server startet, Konsole zeigt „Done (...s)!" |
| Spieler verbinden | Spielerzahl in der Oberfläche stimmt |
| PC A: Welt im Editor ändern, PC A neu starten | Änderung ist vorhanden |

### T4 – Kontrollierter Host-Wechsel (der Kerntest)

| Schritt | Erwartung |
|---|---|
| PC A ist Host, Server läuft | Dashboard zeigt PC A als Host |
| PC A: *Server stoppen* | Welt wird gespeichert, Server beendet |
| PC B: Lease-Übernahme anstoßen | Welt wird von A nach B übertragen |
| PC B | Server startet mit der **identischen** Welt |
| Vergleich: Block in der Welt vor und nach dem Wechsel | **Block ist noch da** |
| PC A: Prüfen, ob der Server weiterläuft | PC A ist **kein** Host mehr |

> **Prüfpunkt:** Der Blocktest ist das eigentliche Kriterium. Ein Bildschirmfoto
> oder ein Hash der Welt vor/nach dem Wechsel ist der beste Nachweis.

### T5 – Host-Ausfall (abrupt)

| Schritt | Erwartung |
|---|---|
| PC A ist Host, Server läuft | – |
| PC A: Netzwerkstecker ziehen **oder** PC hart ausschalten | – |
| Warten (Lease-TTL + Grazienzeit ≈ 35 s) | PC B übernimmt automatisch |
| PC B | Welt wurde vom letzten Backup wiederhergestellt |
| Oberfläche auf PC B | Warnung: „Es kann zu Datenverlust kommen" |
| PC A: Netzwerk wiederherstellen | PC A wird **fenced**, Server bleibt gestoppt |
| PC A: Welt prüfen | Welt wurde in die Quarantäne verschoben, nicht überschrieben |

### T6 – Netzwerktrennung und Wiederverbindung

| Schritt | Erwartung |
|---|---|
| PC B: WLAN ausschalten | PC B wird als offline angezeigt |
| PC A bleibt Host | Server läuft normal weiter |
| PC B: WLAN wieder einschalten | PC B ist wieder online, Lease wird erneuert |

### T7 – Gleichzeitige Host-Wahl

| Schritt | Erwartung |
|---|---|
| PC A und PC B starten gleichzeitig mit *Host übernehmen* | **Nur einer** wird Host |
| Auf dem Verlierer | Meldung „Übernahme nicht möglich" mit Begründung |

### T8 – Unterbrochene Weltübertragung

| Schritt | Erwartung |
|---|---|
| PC A ist Host, große Welt (> 1 GB) | – |
| PC B: Übernahme starten | Fortschritt sichtbar |
| PC B: WLAN ausschalten | Übertragung bricht ab, kein Absturz |
| PC B: WLAN wieder einschalten, Übernahme erneut | Transfer wird **fortgesetzt** (nicht neu gestartet) |
| PC B | Server startet, Welt vollständig |

### T9 – Zu wenig Speicherplatz

| Schritt | Erwartung |
|---|---|
| PC B: Festplatte fast voll (weniger als Weltgröße × 1,35) | Übernahme schlägt fehl mit klarer Meldung |
| PC A | bleibt unberührt, Server läuft weiter |

### T10 – Backups und Wiederherstellung

| Schritt | Erwartung |
|---|---|
| Backup-Intervall auf 1 Minute | Automatische Backups erscheinen in der Liste |
| PC A: Welt verändern | – |
| PC A: Backup wiederherstellen | Welt entspricht dem Backup-Stand |
| Backup-Datei nachträglich beschädigen | Backup wird als „unbestätigt" markiert |
| PC A: beschädigtes Backup wiederherstellen | Wiederherstellung wird **verweigert**, aktive Welt bleibt |
| Aufbewahrungsgrenze auf 2 stellen | Alte Backups werden entfernt, das letzte gültige bleibt |

### T11 – Versionskonflikt

| Schritt | Erwartung |
|---|---|
| Welt aus Minecraft 1.21 importieren, Server-Version auf 1.20.4 | Import möglich, aber Serverstart wird mit klarer Begründung **verhindert** |

### T12 – Koordinationsdienst nicht erreichbar

| Schritt | Erwartung |
|---|---|
| Hub herunterfahren | Dashboard zeigt „Hub offline" (rote Warnung) |
| PC A: Server läuft | Server läuft weiter |
| PC A: Server stoppen und neu starten wollen | Start wird verhindert (keine gültige Lease) |
| PC B: versucht zu übernehmen | Kein Host-Wechsel, erklärende Meldung |
| Hub wieder starten | Verbindung kehrt zurück, Lease wird erneuert |

### T13 – Netzwerk-Szenarien

| Variante | Erwartung |
|---|---|
| **V1 (LAN)** | Weltübertragung zwischen PCs ist schnell |
| **V2 (Internet, forwarded)** | Weltübertragung funktioniert, ggf. langsamer |
| **V3 (Internet, nicht forwarded)** | Mitglieder sehen den Hub nicht. Kein Host-Wechsel möglich → **klar kommuniziert** |

### T14 – Spielerverbindung nach Host-Wechsel

| Schritt | Erwartung |
|---|---|
| Spieler ist auf PC A verbunden | – |
| Host-Wechsel auf PC B | Spieler wird getrennt |
| Spieler verbindet sich mit der Adresse von PC B neu | Verbindung klappt |
| (Optional) DNS/VPN eingerichtet | Spieler verbindet sich immer mit derselben Adresse |

### T15 – Anwendung neu starten

| Schritt | Erwartung |
|---|---|
| PC A ist Host, Anwendung schließen | Server läuft weiter (Standard) |
| PC A: Anwendung neu starten | Zustand wird rekonstruiert, Lease wird erneuert |
| PC A: Anwendung schließen **während** einer Übertragung | Kein Datenverlust, Übertragung wird beim nächsten Versuch fortgesetzt |

---

## 3. Protokoll

Für jeden Testfall wird protokolliert:

| Feld | Inhalt |
|---|---|
| Datum / Testleiter | |
| Build-Version | `git rev-parse --short HEAD` |
| Betriebssystem / Java | |
| Netzwerkvariante | V1 / V2 / V3 |
| Ergebnis | bestanden / fehlgeschlagen / blockiert |
| Beobachtung | Was ist konkret passiert? |
| Nachweis | Screenshot, Logauszug (`logs/multimine-*.log`), Journal (`state/journal.log`) |

Die Ergebnisse stehen in `docs/TESTERGEBNISSE.md`.

---

## 4. Abbruchkriterien

Der Testlauf gilt als **fehlgeschlagen**, wenn einer dieser Punkte eintritt:

- Die Welt ist nach einem Host-Wechsel verändert oder beschädigt.
- Zwei Hosts haben gleichzeitig geschrieben.
- Ein beschädigtes Backup wurde ohne Warnung wiederhergestellt.
- Eine inkompatible Welt wurde gestartet.
- Ein Pfad Traversal hat eine Datei außerhalb des Zielverzeichnisses verändert.
- Ein Mitglied konnte ohne Berechtigung fremde Dateien lesen.
- Die Anwendung ist nach einem Fehler nicht mehr bedienbar.
