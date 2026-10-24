# Sicherheitsmodell

Dieses Dokument beschreibt, welche Angriffe Multi-Mine Host abwehrt, wie, und
wo die Grenzen liegen.

## 1. Schutzziele

| Ziel | Bedeutung |
|---|---|
| **Integrität der Welt** | Die Minecraft-Welt darf nie durch zwei Hosts gleichzeitig verändert werden. |
| **Vertraulichkeit** | Ein Gruppenmitglied kann keine fremden Dateien lesen. |
| **Authentizität** | Jede Nachricht ist nachweisbar von dem behaupteten Absender. |
| **Verfügbarkeit (bedingt)** | Der Server bleibt erreichbar, solange ein Mitglied hostingfähig ist. |

## 2. Bedrohungsmodell

### Angriffe im Modell (werden abgewehrt)

| # | Angriff | Abwehr |
|---|---|---|
| A1 | Ein Mitglied sendet manipulierte Welt-Dateien | SHA-256 je Datei + Manifest-Abgleich vor der Aktivierung |
| A2 | Zwei Mitglieder starten gleichzeitig den Server | Lease mit monotoner Epoche; der Hub vergibt nur eine |
| A3 | Ein alter Host kehrt zurück und schreibt weiter | Fencing: veraltete Epoche → Server wird gestoppt, Welt quarantänisiert |
| A4 | Aufnahme einer alten Anfrage wird erneut gesendet | Zeitstempelfenster (60 s) + Nonce-Speicher je Absender |
| A5 | Einladungscode wird geraten | 60 Bit Entropie, nur der Hash wird gespeichert, optionale Ablauf-/Nutzungsbeschränkung |
| A6 | Pfad Traversal über eine Weltdatei (`../../`) | `path-guard` + Symlink-Prüfung |
| A7 | Manipulation an einem Backup-Archiv | SHA-256 des Archivs + Pfadfilter beim Entpacken |
| A8 | Ein Mitglied will beliebige Dateien auf einem fremden PC lesen | Es wird ausschließlich die Welt des aktiven Hosts angeboten, nur mit gültigem Lease |
| A9 | Ein Mitglied will einen Systembefehl auslösen | Kein Remote-Kommando-Kanal; IPC ist typisiert und kanalgebunden |
| A10 | Manipulation am Spielstand durch einen Dritten | Ende-zu-Ende-Verschlüsselung (Noise) + Signaturen |
| A11 | Ein gestohlener Einladungscode wird weiterverwendet | Ablaufzeit, maximale Nutzungszahl, Widerruf, Sitzungswiderruf |
| A12 | Ein Downgrade der Welt zerstört Daten | DataVersion-Prüfung verhindert den Start |
| A13 | Ein defekter Backup überschreibt die letzte gute Welt | Vorherige Welt landet in der Quarantäne; beschädigte Backups werden abgelehnt |

### Angriffe außerhalb des Modells (nicht abgewehrt)

| # | Angriff | Begründung / Mitigation |
|---|---|---|
| B1 | Ein Mitglied kompromittiert den Rechner des Hosts | Nicht in der Anwendungs-Macht. Empfehlung: getrennte Windows-Konten, kein Adminrechte. |
| B2 | Ein Angreifer übernimmt den Hub | Der Hub sollte auf einem eigenen, geschützten System laufen. Optional `MMH_HUB_TOKEN`. |
| B3 | Ein Angreifer hört den Netzwerkverkehr mit | Nicht möglich: Noise mit Forward Secrecy. |
| B4 | Ein Angreifer blockiert die Verbindung (DoS) | Führt zu Ausfallverfügbarkeit, aber **nicht** zu Datenverlust (Fail-Closed). |
| B5 | Ein Mitglied entfernt andere Mitglieder (wenn Admin) | Rollenmodell: nur `owner`/`admin` dürfen. Der Besitzer kann widerrufen. |
| B6 | Ein Angreifer spielt einen veralteten Backup-Stand als aktuellen aus | Die `versionId` und der Hub-Registry-Stand verhindern das; ein älterer Stand wird mit einer Warnung und Datenverlust-Hinweis verwendet. |

## 3. Kryptographie

### Identität

- **Algorithmus:** Ed25519 (signieren/prüfen), X25519 (Schlüsselaustausch in Noise).
- **Schlüsselspeicher:** `keys/identity.json` (PKCS#8-PEM), Dateirechte `0600`.
- **nodeId:** `base32(sha256(publicKey))[0..26]` – 130 Bit, stabil und nicht erratbar.
- **Bindung:** Bei `create`/`join` prüft der Hub, dass die behauptete nodeId zum
  übermittelten Public Key passt. Sonst könnte ein Angreifer mit einem gültigen
  Einladungscode eine fremde nodeId beanspruchen.

### Signierte Nachrichten

Jede steuernde Anfrage trägt:

```ts
{
  v: '1.0.0',        // Protokollversion
  id: '<random>',    // Anfrage-ID
  type: 'hub.xxx',   // Nachrichtentyp
  ts: 1699999999999, // Zeitstempel
  nonce: '<random>', // einmalig je Absender
  from: '<nodeId>',
  auth: '<Sitzungstoken>',  // optional, wird mit signiert
  payload: { ... },
  sig: '<base64 Ed25519 Signatur>'
}
```

Die Signatur deckt **alle** Felder einschließlich `auth` und `payload` ab. Die
kanonische Normalisierung (`canonicalize`) sortiert die Schlüssel, damit die
Signatur unabhängig von der JSON-Reihenfolge ist.

Der Hub prüft in dieser Reihenfolge:

1. Protokollversion
2. Zeitstempel (max. 60 s alt)
3. Bekannter Absender? (Public Key vorhanden)
4. Signatur gültig?
5. Nonce bereits gesehen? → Replay

### Sitzungstoken

- 32 Byte Zufall, base64url-kodiert.
- Wird nach `create`/`join` einmalig über den authentifizierten Kanal
  übertragen und im `Keystore` gespeichert.
- Widerrufbar, ohne den Schlüssel zu wechseln.

### Geheimnisse

Electron `safeStorage` (Windows: DPAPI, an den Benutzerkontext des OS
gebunden). Ohne Electron (Hub-Standalone) wird auf AES-256-GCM mit einer
lokalen Schlüsseldatei zurückgefallen. In keinem Fall wird ein Geheimnis im
Klartext abgelegt.

**Hub-Token vs. Hub-Zustand.** Das Hub-Token liegt ausschließlich im
verschlüsselten Keystore (`keys/secrets.json`). Der Hub-Zustand
(`state/hub-state.json`) enthält dagegen im Klartext die Einladungscodes
und Sitzungstokens der Mitglieder - beides Bearer-Credentials, die nur
gegenüber diesem Hub gültig sind (das eigene Sitzungstoken der Anwendung
liegt ebenfalls im Keystore). Der Hub-Zustand wird deshalb im
Anwendungsdaten-Verzeichnis des Benutzerprofils geführt; ein
verschlüsselter Hub-Zustand ist eine mögliche künftige Verbesserung.
Keine der beiden Dateien enthält private Schlüssel.

## 4. Zugriffskontrolle

### Wer darf was?

| Aktion | owner | admin | member |
|---|---|---|---|
| Gruppe erstellen | ✓ | – | – |
| Einladung erstellen/widerrufen | ✓ | ✓ | – |
| Mitglieder entfernen | ✓ | – | – |
| Hosting-Freigabe entziehen | ✓ | – | – |
| Eigene Priorität setzen | ✓ | ✓ | ✓ |
| Lease anfordern | ✓ | ✓ | ✓ |
| Welt committen | ✓ (mit gültiger Lease) | ✓ | ✓ |
| Gruppe verlassen | – | ✓ | ✓ |

### Dateizugriff

Die Anwendung greift ausschließlich auf diese Verzeichnisse zu:

- `<Datenverzeichnis>/worlds` – importierte Welten
- `<Datenverzeichnis>/backups` – Backups
- `<Datenverzeichnis>/servers` – Minecraft-Server
- `<Datenverzeichnis>/quarantine` – quarantineierte Welten
- `<Datenverzeichnis>/tmp` – Zwischenablage für Transfers

Ein Mitglied kann nur auf den **Weltordner** des aktiven Hosts zugreifen –
und nur solange dieser die Lease hält. Es gibt keinen Mechanismus, mit dem
ein Mitglied beliebige Pfade auf einem fremden Rechner anfordern kann.

## 5. Pfadschutz

`src/main/security/path-guard.ts` ist die einzige Stelle, die Netzwerkpfade
auflöst. Abgewiesen werden:

- absolute Pfade (`/etc/passwd`, `C:\Windows`)
- Laufwerksbuchstaben
- UNC-Pfade (`\\server\share`)
- `..`- und `.`-Segmente
- Nullbytes
- reservierte Windows-Namen (`CON`, `PRN`, `NUL`, `COM1`…`LPT9`)
- Segmente mit Doppelpunkt (Alternate Data Streams)
- Segmente, die mit Leerzeichen oder Punkt enden
- Symlinks, deren Ziel außerhalb des freigegebenen Verzeichnisses liegt

Zusätzlich werden Frame-Längen begrenzt, damit eine manipulierte Längenangabe
keinen Speicher erschöpft.

## 6. Protokollierung

Sicherheitsrelevante Ereignisse werden protokolliert:

| Ereignis | Journal | Log |
|---|---|---|
| Lease erworben | ✓ | ✓ |
| Lease freigegeben / widerrufen | ✓ | ✓ |
| Fencing ausgelöst | ✓ | ✓ |
| Welt committed | ✓ | ✓ |
| Welt importiert | ✓ | ✓ |
| Backup erstellt | ✓ | ✓ |
| Backup wiederhergestellt | ✓ | ✓ |
| Übernahme fehlgeschlagen | ✓ | ✓ |
| Anfrage abgewiesen (Sicherheit) | – | ✓ |

Der Logger redigiert Felder, deren Name auf `pass`, `secret`, `token`, `key`,
`seed`, `authorization` oder `cookie` passt.

## 7. Bekannte Schwachstellen und offene Punkte

| Punkt | Bewertung |
|---|---|
| Der Hub ist ein Single Point of Failure | Bewusst akzeptiert (Begründung in `ARCHITEKTUR.md`). |
| Ein kompromittiertes Mitglied kann die Gruppe "besitzen" | Der Besitzer kann Mitglieder entfernen und Einladungen widerrufen. |
| Ein Relay über den Hub sieht Metadaten (Größe, Timing) | Nicht die Inhalte (Ende-zu-Ende-verschlüsselt). |
| `session.lock` wird beim Import nicht entfernt | Warnung in der Integritätsprüfung. |
| Kein Replay-Schutz auf Transportebene | Wird durch die Nonce-Anwendungsprüfung abgedeckt. |
| Backups werden nicht verschlüsselt at rest | Sie liegen im Benutzerprofil. Optionale Verschlüsselung ist eine offene Aufgabe. |
