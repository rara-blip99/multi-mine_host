import { useEffect, useState } from 'react'
import { useApp, formatBytes, formatTime } from '../state'
import { Card, Empty, Field, Modal, Notice, Pill } from '../components/ui'
import { CreateWorldModal, SelectWorldModal, worldCreatedNotice } from './CreateWorldModal'
import type { BackupInfo } from '@shared/types'

/**
 * Weltverwaltung: Import, Integritaet, Backups und Wiederherstellung.
 */
export default function WorldPage(): React.JSX.Element {
  const { state, api, notify } = useApp()
  const [worlds, setWorlds] = useState<Array<{ path: string; name: string; dataVersion: number }>>([])
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [check, setCheck] = useState<{ ok: boolean; problems: string[]; warnings: string[] } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [sourcePath, setSourcePath] = useState('')
  const [worldName, setWorldName] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectOpen, setSelectOpen] = useState(false)

  const reload = (): void => {
    void api.listWorlds().then(setWorlds).catch(() => undefined)
    void api.listBackups().then(setBackups).catch(() => undefined)
    void api.checkWorld().then(setCheck).catch(() => undefined)
  }

  useEffect(() => {
    reload()
    const timer = setInterval(reload, 15_000)
    return () => clearInterval(timer)
  }, [])

  const doImport = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.importWorld({
        sourcePath: sourcePath.trim(),
        name: worldName.trim()
      })
      if (result.ok) {
        notify('Welt importiert', 'ok')
        setImportOpen(false)
        setSourcePath('')
        setWorldName('')
        reload()
      } else {
        notify(result.error ?? 'Import fehlgeschlagen', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const doBackup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.createBackup('manual')
      if (result.ok) notify('Backup erstellt', 'ok')
      else notify(result.error ?? 'Backup fehlgeschlagen', 'error')
      reload()
    } finally {
      setBusy(false)
    }
  }

  const doRestore = async (id: string): Promise<void> => {
    if (!window.confirm('Backup wirklich wiederherstellen? Die aktuelle Welt wird ersetzt.')) return
    setBusy(true)
    try {
      const result = await api.restoreBackup(id)
      if (result.ok) {
        notify('Backup wiederhergestellt', 'ok')
        reload()
      } else {
        notify(result.error ?? 'Wiederherstellung fehlgeschlagen', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Welt</h1>
          <p>
            Welten importieren, Integrität prüfen und Backups verwalten. Backups werden nur aus
            einem ausdrücklich gespeicherten Weltzustand erstellt.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setImportOpen(true)}>
            + Welt importieren
          </button>
          <button className="btn" onClick={() => setCreateOpen(true)}>
            ✨ Neue Welt erstellen
          </button>
          <button className="btn primary" onClick={() => void doBackup()} disabled={busy}>
            🗄 Backup jetzt
          </button>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <Card title="Aktive Welt">
          {state.world ? (
            <dl className="kv">
              <dt>Name</dt>
              <dd>{state.world.worldName}</dd>
              <dt>Version</dt>
              <dd>{state.world.mcVersion}</dd>
              <dt>DataVersion</dt>
              <dd className="mono">{state.world.dataVersion}</dd>
              <dt>Größe</dt>
              <dd>{formatBytes(state.world.totalBytes)}</dd>
              <dt>Commit</dt>
              <dd>{formatTime(state.world.committedAt)}</dd>
            </dl>
          ) : (
            <Empty>Noch keine Welt aktiv.</Empty>
          )}
        </Card>

        <Card title="Integrität">
          {!check ? (
            <div className="small dim">Wird geprüft…</div>
          ) : check.ok && check.problems.length === 0 ? (
            <>
              <Pill kind="ok">Weltstruktur ist in Ordnung</Pill>
              {check.warnings.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {check.warnings.map((w, i) => (
                    <div key={i} className="small" style={{ color: 'var(--warn)' }}>
                      ⚠ {w}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {check.problems.map((p, i) => (
                <div key={i} className="small" style={{ color: 'var(--danger)' }}>
                  ✕ {p}
                </div>
              ))}
              {check.warnings.map((w, i) => (
                <div key={i} className="small" style={{ color: 'var(--warn)' }}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Lokale Welten" hint={`${worlds.length} gefunden`}>
          {worlds.length === 0 ? (
            <Empty>Keine Welten im Speicher.</Empty>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {worlds.map((w) => (
                <div key={w.path} className="row between">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {w.name}
                    </div>
                    <div className="small faint mono">DataVersion {w.dataVersion}</div>
                  </div>
                  <Pill kind="muted">lokal</Pill>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Backups" hint={`Intervall ${state.settings.backupIntervalMinutes} Min. · Aufbewahrung ${state.settings.backupRetention}`}>
        {backups.length === 0 ? (
          <Empty>Noch keine Backups vorhanden.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Zeitpunkt</th>
                <th>Art</th>
                <th>Weltversion</th>
                <th className="right">Größe</th>
                <th>Status</th>
                <th className="right">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td className="nowrap">{formatTime(b.createdAt)}</td>
                  <td>
                    <Pill kind="muted">{b.kind}</Pill>
                  </td>
                  <td className="mono small">{b.worldVersionId.slice(0, 12)}</td>
                  <td className="right nowrap">
                    {formatBytes(b.sizeBytes)}
                    <div className="faint small">{formatBytes(b.uncompressedBytes)} roh</div>
                  </td>
                  <td>
                    {b.verified ? <Pill kind="ok">geprüft</Pill> : <Pill kind="danger">unbestätigt</Pill>}
                    {b.replicated && (
                      <div style={{ marginTop: 3 }}>
                        <Pill kind="info">repliziert</Pill>
                      </div>
                    )}
                  </td>
                  <td className="right">
                    <button className="btn small" onClick={() => void doRestore(b.id)} disabled={busy}>
                      Wiederherstellen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {importOpen && (
        <Modal
          title="Welt importieren"
          description="Geben Sie den Pfad zu einem vorhandenen Minecraft-Weltordner an (der Ordner mit level.dat)."
          onClose={() => setImportOpen(false)}
        >
          <Notice kind="info">
            Die Welt wird kopiert und im Weltspeicher abgelegt. Vor dem ersten Serverstart prüft
            Multi-Mine Host, ob die Welt zur konfigurierten Minecraft-Version passt.
          </Notice>
          <Field label="Pfad zum Weltordner" help="Der Ordner, der level.dat enthält.">
            <div className="row" style={{ gap: 8 }}>
              <input
                type="text"
                value={sourcePath}
                placeholder="C:\Minecraft\server\world"
                onChange={(e) => setSourcePath(e.target.value)}
              />
              <button
                className="btn small"
                onClick={() => {
                  void api.pickWorldFolder().then((folder) => {
                    if (folder) setSourcePath(folder)
                  })
                }}
              >
                Durchsuchen
              </button>
            </div>
          </Field>
          <Field label="Name in der App" help="Ordner, unter dem die Welt abgelegt wird.">
            <input
              type="text"
              value={worldName}
              placeholder="meine-welt"
              onChange={(e) => setWorldName(e.target.value)}
            />
          </Field>
          <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setImportOpen(false)}>
              Abbrechen
            </button>
            <button
              className="btn primary"
              disabled={busy || !sourcePath.trim() || !worldName.trim()}
              onClick={() => void doImport()}
            >
              Importieren
            </button>
          </div>
        </Modal>
      )}

      {createOpen && (
        <CreateWorldModal
          onClose={() => setCreateOpen(false)}
          onCreated={(info, startError) => {
            setCreateOpen(false)
            const n = worldCreatedNotice(info, startError)
            notify(n.message, n.kind)
            reload()
          }}
        />
      )}

      {selectOpen && (
        <SelectWorldModal
          onClose={() => setSelectOpen(false)}
          onSelected={(name) => {
            setSelectOpen(false)
            notify(`Welt "${name}" als aktive Welt eingerichtet`, 'ok')
            reload()
          }}
        />
      )}
    </>
  )
}
