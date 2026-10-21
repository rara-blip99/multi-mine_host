import { useEffect, useState } from 'react'
import { useApp, formatBytes } from '../state'
import { Card, Field, Notice, Pill, Switch } from '../components/ui'

/**
 * Einstellungen: Minecraft, Speicher, Netzwerk, Verhalten.
 */
export default function SettingsPage(): React.JSX.Element {
  const { state, api, notify } = useApp()
  const s = state.settings
  const [diagnostics, setDiagnostics] = useState<string>('')
  const [displayName, setDisplayName] = useState(state.identity?.displayName ?? '')

  useEffect(() => {
    setDisplayName(state.identity?.displayName ?? '')
  }, [state.identity?.displayName])

  const update = (patch: Partial<typeof s>): void => {
    void api.updateSettings(patch).catch(() => notify('Einstellung konnte nicht gespeichert werden', 'error'))
  }

  const loadDiagnostics = async (): Promise<void> => {
    const report = await api.diagnostics()
    setDiagnostics(JSON.stringify(report, null, 2))
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Einstellungen</h1>
          <p>
            Minecraft-Version, Speicher, Sicherungen und Verhalten beim Schließen. Änderungen werden
            sofort übernommen.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => void loadDiagnostics()}>
            Diagnosebericht
          </button>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <Card title="Minecraft">
          <Field
            label="Edition"
            help="Aktuell wird ausschließlich Minecraft Java Edition unterstützt."
          >
            <select
              value={s.minecraftEdition}
              onChange={(e) => update({ minecraftEdition: e.target.value as 'java' | 'bedrock' })}
            >
              <option value="java">Java Edition</option>
              <option value="bedrock" disabled>
                Bedrock Edition (geplant)
              </option>
            </select>
          </Field>

          <Field label="Version" help="Die Welt muss zu dieser Version passen (DataVersion-Prüfung).">
            <select value={s.mcVersion} onChange={(e) => update({ mcVersion: e.target.value })}>
              <option value="1.20.4">1.20.4 (Java 17)</option>
              <option value="1.20.6">1.20.6 (Java 21)</option>
              <option value="1.21">1.21 (Java 21)</option>
              <option value="1.21.1">1.21.1 (Java 21)</option>
              <option value="1.21.4">1.21.4 (Java 21)</option>
            </select>
          </Field>

          <Field label="Server-RAM" help="JVM-Höchstgrenze (-Xmx) für den Minecraft-Server.">
            <select
              value={s.serverRamBytes}
              onChange={(e) => update({ serverRamBytes: Number(e.target.value) })}
            >
              {[2, 3, 4, 6, 8, 12, 16].map((gb) => (
                <option key={gb} value={gb * 1024 * 1024 * 1024}>
                  {gb} GB
                </option>
              ))}
            </select>
          </Field>

          <Field label="Server-Port">
            <input
              type="number"
              value={s.serverPort}
              min={1024}
              max={65535}
              onChange={(e) => update({ serverPort: Number(e.target.value) })}
            />
          </Field>
        </Card>

        <Card title="Hosting">
          <div className="field">
            <label>Hosting-Priorität: {s.hostingPriority}</label>
            <input
              type="range"
              min={0}
              max={100}
              value={s.hostingPriority}
              onChange={(e) => update({ hostingPriority: Number(e.target.value) })}
            />
            <div className="help">
              Beeinflusst die automatische Host-Wahl mit bis zu 15 von 100 Punkten. Eine hohe Priorität
              macht Sie zum bevorzugten Kandidaten, garantiert aber keinen Host-Status.
            </div>
          </div>

          <Switch
            label="Dieses PC darf hosten"
            description="Wenn deaktiviert, wird dieser PC nie als Host gewählt."
            checked={s.hostingAllowed}
            onChange={(v) => update({ hostingAllowed: v })}
          />

          <Field label="Eigener Anzeigename" help="Wird in der Mitgliederliste angezeigt.">
            <div className="row" style={{ gap: 8 }}>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <button
                className="btn small"
                onClick={() => {
                  api.setDisplayName(displayName).then(() => notify('Name gespeichert', 'ok'))
                }}
              >
                Speichern
              </button>
            </div>
          </Field>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <Card title="Backups">
          <Field label="Intervall (Minuten)" help="Standard: alle 5 Minuten.">
            <input
              type="number"
              min={1}
              max={240}
              value={s.backupIntervalMinutes}
              onChange={(e) => update({ backupIntervalMinutes: Number(e.target.value) })}
            />
          </Field>
          <Field label="Anzahl aufzubewahrender Backups" help="Das letzte gültige Backup bleibt immer erhalten.">
            <input
              type="number"
              min={1}
              max={200}
              value={s.backupRetention}
              onChange={(e) => update({ backupRetention: Number(e.target.value) })}
            />
          </Field>
          <Field label="Speicherort für Backups">
            <input
              type="text"
              value={s.backupsDir}
              onChange={(e) => update({ backupsDir: e.target.value })}
            />
          </Field>
        </Card>

        <Card title="Speicherorte & Netzwerk">
          <Field label="Speicherort für Welten">
            <input
              type="text"
              value={s.worldsDir}
              onChange={(e) => update({ worldsDir: e.target.value })}
            />
          </Field>
          <Field
            label="Adresse des Koordinationsdienstes"
            help="Multiaddr des Hubs. Nur eine Adresse im Netzwerk benötigt Port-Weiterleitung."
          >
            <input
              type="text"
              value={s.hubAddress}
              placeholder="/ip4/192.168.1.20/tcp/4001/p2p/12D3Koo…"
              onChange={(e) => update({ hubAddress: e.target.value })}
            />
          </Field>
          <Field
            label="Eingebetteter Hub (Port)"
            help="0 = aus. Auf 0 gesetzt startet dieser PC einen eigenen Koordinationsdienst."
          >
            <input
              type="number"
              min={0}
              max={65535}
              value={s.embeddedHubPort}
              onChange={(e) => update({ embeddedHubPort: Number(e.target.value) })}
            />
          </Field>
        </Card>
      </div>

      <Card title="Verhalten der Anwendung">
        <div className="field">
          <label>Beim Schließen des Fensters</label>
          <select
            value={s.closeBehavior}
            onChange={(e) => update({ closeBehavior: e.target.value as typeof s.closeBehavior })}
          >
            <option value="keep-running">Im Hintergrund weiterlaufen (Server bleibt online)</option>
            <option value="stop-server">Server stoppen und beenden</option>
            <option value="quit">Vollständig beenden</option>
          </select>
        </div>
        <Switch
          label="In den Infobereich minimieren"
          checked={s.minimizeToTray}
          onChange={(v) => update({ minimizeToTray: v })}
        />
        <Switch
          label="Automatisch mit Windows starten"
          checked={s.autostart}
          onChange={(v) => update({ autostart: v })}
        />
        <Switch
          label="Verbindungen von anderen PCs erlauben"
          description="Direkte Verbindungen zwischen Gruppenmitgliedern (Weltübertragung)."
          checked={s.allowRemoteConnections}
          onChange={(v) => update({ allowRemoteConnections: v })}
        />
      </Card>

      {diagnostics && (
        <Card title="Diagnosebericht" hint="Zum Kopieren in einen Bug-Report">
          <div className="log" style={{ maxHeight: 420 }}>
            {diagnostics}
          </div>
        </Card>
      )}

      <div style={{ marginTop: 16 }}>
        <Notice kind="info">
          <div className="row wrap" style={{ gap: 18 }}>
            <span>
              Speicherplatz Welten:{' '}
              <strong>{formatBytes(state.capabilities.find((c) => c.nodeId === state.identity?.nodeId)?.disk.totalBytes ?? 0)}</strong>
            </span>
            <span>
              Verfügbar:{' '}
              <strong>
                {formatBytes(
                  state.capabilities.find((c) => c.nodeId === state.identity?.nodeId)?.disk.freeBytes ?? 0
                )}
              </strong>
            </span>
            <span>
              Java:{' '}
              <strong>
                {state.capabilities.find((c) => c.nodeId === state.identity?.nodeId)?.java.version || 'nicht gefunden'}
              </strong>
            </span>
            <span>
              Fencing: <Pill kind={state.fence === 'lost' ? 'danger' : 'muted'}>{state.fence}</Pill>
            </span>
          </div>
        </Notice>
      </div>
    </>
  )
}
