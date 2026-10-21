import { useEffect, useState } from 'react'
import { useApp, formatBytes, formatRelative, formatTime } from '../state'
import { Bar, Card, Notice, Pill, StatTile } from '../components/ui'
import type { ServerLogLine } from '@shared/types'

/**
 * Dashboard: der zentrale Lagebild-Schirm.
 */
export default function Dashboard(): React.JSX.Element {
  const { state, api, notify } = useApp()
  const [logs, setLogs] = useState<ServerLogLine[]>([])
  const [busy, setBusy] = useState(false)

  const lease = state.lease
  const hostMember = state.members.find((m) => m.nodeId === lease?.holderId)
  const isHost = lease?.holderId === state.identity?.nodeId
  const onlineCount = state.members.filter((m) => m.online).length
  const nextCandidate = state.scores.find((s) => s.eligible && s.nodeId !== lease?.holderId)
  const lastBackup = state.backups[0]

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api
        .serverLogs(120)
        .then((l) => {
          if (alive) setLogs(l)
        })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, state.server.state])

  const serverRunning = state.server.state === 'running'
  const leaseValid = lease ? lease.expiresAt > Date.now() : false

  const toggleServer = async (): Promise<void> => {
    setBusy(true)
    try {
      if (serverRunning) {
        await api.stopServer()
        notify('Minecraft-Server wird gestoppt', 'info')
      } else {
        const result = await api.startServer()
        if (result.ok) notify('Minecraft-Server gestartet', 'ok')
        else notify(result.error ?? 'Start fehlgeschlagen', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>
            Aktueller Host, Serverstatus, Gruppenlage und Sicherung in einer Übersicht. Der Server
            startet nur, wenn dieser PC gültig als Host beansprucht ist.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => void api.refreshGroup()} disabled={!state.group}>
            ↻ Aktualisieren
          </button>
          {state.lease && state.lease.holderId !== state.identity?.nodeId && (
            <button
              className="btn"
              onClick={() => {
                void api.requestTakeover().then((r) => {
                  if (r.ok) notify('Host-Übernahme eingeleitet', 'ok')
                  else notify(r.reason, 'warn')
                })
              }}
            >
              ⇄ Host übernehmen
            </button>
          )}
          <button className="btn primary" onClick={() => void toggleServer()} disabled={busy}>
            {serverRunning ? '⏹ Server stoppen' : '▶ Server starten'}
          </button>
        </div>
      </div>

      {!state.group && (
        <Notice kind="info">
          Sie sind noch keiner Gruppe beigetreten. Öffnen Sie <strong>Gruppe</strong>, um eine
          Gruppe zu erstellen oder mit einem Einladungscode beizutreten. Ohne Gruppe kann der
          Server nur lokal betrieben werden.
        </Notice>
      )}

      {state.fence === 'lost' && (
        <Notice kind="danger">
          <strong>Dieser PC wurde vom Koordinationsdienst abgelöst (Fencing).</strong> Der
          Minecraft-Server wurde gestoppt, damit nicht zwei Hosts dieselbe Welt beschreiben. Die
          lokale Welt wurde in die Quarantäne verschoben und wird nicht mehr verwendet.
        </Notice>
      )}

      {state.failover.phase !== 'idle' && state.failover.phase !== 'completed' && (
        <Notice kind={state.failover.phase === 'failed' ? 'danger' : 'info'}>
          <strong>Host-Wechsel: {state.failover.phase}</strong>
          <div style={{ marginTop: 4 }}>{state.failover.message}</div>
          {state.failover.warnings.map((w, i) => (
            <div key={i} className="small" style={{ marginTop: 4 }}>
              ⚠ {w}
            </div>
          ))}
        </Notice>
      )}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <StatTile
          label="Aktueller Host"
          icon="🖥"
          value={hostMember?.displayName ?? (lease ? lease.holderId.slice(0, 10) : '—')}
          tone={isHost ? 'accent' : undefined}
          sub={
            lease ? (
              <>
                Epoche {lease.epoch} · {leaseValid ? 'gültig' : 'abgelaufen'}
                {leaseValid && (
                  <>
                    {' '}
                    bis {formatTime(lease.expiresAt)}
                  </>
                )}
              </>
            ) : (
              'Kein Host bestimmt'
            )
          }
        />
        <StatTile
          label="Minecraft-Server"
          icon="⛏"
          value={
            state.server.state === 'running'
              ? `${state.server.playersOnline ?? '?'} / ${state.server.playerMax ?? '?'}`
              : state.server.state
          }
          tone={state.server.state === 'running' ? 'accent' : state.server.state === 'crashed' ? 'danger' : undefined}
          sub={
            state.server.state === 'running'
              ? `Version ${state.server.mcVersion} · ${formatBytes(state.server.ramLimitBytes)} RAM`
              : (state.server.lastError ?? `RAM-Limit ${formatBytes(state.server.ramLimitBytes)}`)
          }
        />
        <StatTile
          label="Gruppenmitglieder"
          icon="⧉"
          value={`${onlineCount} / ${state.members.length}`}
          tone={onlineCount > 1 ? 'accent' : undefined}
          sub={
            state.members.length > 0
              ? `${state.members.filter((m) => m.online).length} online, ${state.members.filter((m) => !m.online).length} offline`
              : 'Niemand beigetreten'
          }
        />
        <StatTile
          label="Letztes Backup"
          icon="🗄"
          value={lastBackup ? formatRelative(lastBackup.createdAt) : '—'}
          tone={lastBackup ? undefined : 'warn'}
          sub={
            lastBackup
              ? `${formatBytes(lastBackup.sizeBytes)} · ${lastBackup.verified ? 'geprüft' : 'unbestätigt'}`
              : 'Noch kein Backup erstellt'
          }
        />
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <Card title="Welt" hint="Aktiver Weltstand und Synchronisierung">
          <dl className="kv">
            <dt>Weltname</dt>
            <dd>{state.world?.worldName ?? '—'}</dd>
            <dt>Minecraft-Version</dt>
            <dd>{state.world?.mcVersion ?? state.settings.mcVersion}</dd>
            <dt>DataVersion</dt>
            <dd className="mono">{state.world?.dataVersion ?? '—'}</dd>
            <dt>Weltversion</dt>
            <dd className="mono">{state.world?.versionId?.slice(0, 16) ?? '—'}</dd>
            <dt>Größe</dt>
            <dd>{formatBytes(state.world?.totalBytes ?? 0)}</dd>
            <dt>Replikate</dt>
            <dd>{state.world?.replicaIds.length ?? 0}</dd>
          </dl>

          <div style={{ marginTop: 14 }}>
            <div className="stat-label" style={{ marginBottom: 6 }}>
              Synchronisierung
            </div>
            {state.sync.phase === 'idle' ? (
              <div className="small dim">
                {state.sync.message}
              </div>
            ) : (
              <>
                <div className="row between small dim" style={{ marginBottom: 5 }}>
                  <span>
                    {state.sync.phase} · {state.sync.currentFile ?? state.sync.message}
                  </span>
                  <span className="nowrap">
                    {formatBytes(state.sync.bytesTransferred)} / {formatBytes(state.sync.totalBytes)}
                  </span>
                </div>
                <Bar
                  value={state.sync.bytesTransferred}
                  max={Math.max(state.sync.totalBytes, 1)}
                  tone={state.sync.phase === 'failed' ? 'danger' : undefined}
                />
                {state.sync.bytesPerSecond > 0 && (
                  <div className="small faint" style={{ marginTop: 5 }}>
                    {(state.sync.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s
                    {state.sync.etaSeconds !== null && ` · noch ca. ${state.sync.etaSeconds}s`}
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        <Card title="Nächster geeigneter Host" hint="Nachvollziehbare Bewertung aller Kandidaten">
          {!state.group ? (
            <div className="small dim">Ohne Gruppe gibt es keine Kandidaten.</div>
          ) : state.scores.length === 0 ? (
            <div className="small dim">Es liegen noch keine Leistungsdaten vor.</div>
          ) : (
            <>
              {nextCandidate && (
                <div className="row between" style={{ marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{nextCandidate.displayName}</div>
                    <div className="small faint">Wechselkandidat</div>
                  </div>
                  <div style={{ fontSize: 21, fontWeight: 700 }} className="mono">
                    {nextCandidate.score.toFixed(1)}
                  </div>
                </div>
              )}
              {state.scores.slice(0, 5).map((s) => (
                <div className="score-row" key={s.nodeId}>
                  <div className="score-head">
                    <span className="name">
                      {s.displayName}
                      {s.nodeId === state.identity?.nodeId && (
                        <span className="faint small"> (Sie)</span>
                      )}
                    </span>
                    <span className="row" style={{ gap: 8 }}>
                      {s.eligible ? (
                        <Pill kind="ok">geeignet</Pill>
                      ) : (
                        <Pill kind="danger">ausgeschlossen</Pill>
                      )}
                      <span className="mono">{s.score.toFixed(1)}</span>
                    </span>
                  </div>
                  <Bar
                    value={s.score}
                    tone={!s.eligible ? 'danger' : s.nodeId === lease?.holderId ? 'violet' : undefined}
                  />
                  {!s.eligible && (
                    <div className="score-reasons">
                      {s.disqualifiers.map((d, i) => (
                        <span className="reason-chip bad" key={i}>
                          {d}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Mitglieder" hint="Verbindungsstatus und Hosting-Fähigkeit">
          {state.members.length === 0 ? (
            <div className="small dim">Noch keine Mitglieder.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Mitglied</th>
                  <th>Status</th>
                  <th>Hosting</th>
                  <th className="right">Prio</th>
                </tr>
              </thead>
              <tbody>
                {state.members.map((m) => (
                  <tr key={m.nodeId}>
                    <td>
                      <div>{m.displayName}</div>
                      <div className="faint small mono">{m.nodeId}</div>
                    </td>
                    <td>
                      {m.online ? (
                        <Pill kind="ok">online</Pill>
                      ) : (
                        <Pill kind="muted">offline</Pill>
                      )}
                    </td>
                    <td>
                      {m.hostingAllowed ? (
                        <Pill kind="info">bereit</Pill>
                      ) : (
                        <Pill kind="warn">gesperrt</Pill>
                      )}
                    </td>
                    <td className="right mono">{m.hostingPriority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Server-Konsole" hint="Letzte Ausgaben von Minecraft">
          {logs.length === 0 ? (
            <div className="small dim">Noch keine Ausgaben.</div>
          ) : (
            <div className="log">
              {logs
                .slice()
                .reverse()
                .map((l, i) => (
                  <div key={i} className={`l-${l.level}`}>
                    {l.message}
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
