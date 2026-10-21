import { useEffect, useState } from 'react'
import { useApp, formatRelative } from '../state'
import { Card, CopyField, Empty, Field, Modal, Notice, Pill } from '../components/ui'
import type { InviteInfo } from '@shared/protocol'

/**
 * Gruppenverwaltung: beitreten, Mitglieder, Einladungen.
 */
export default function GroupPage(): React.JSX.Element {
  const { state, api, notify } = useApp()
  const [mode, setMode] = useState<'none' | 'create' | 'join'>('none')
  const [hubAddress, setHubAddress] = useState(state.settings.hubAddress)
  const [groupName, setGroupName] = useState('')
  const [groupId, setGroupId] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [hubToken, setHubToken] = useState('')
  const [invites, setInvites] = useState<InviteInfo[]>([])
  const [embedded, setEmbedded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isOwner = state.members.find((m) => m.nodeId === state.identity?.nodeId)?.role === 'owner'
  const isAdmin = isOwner || state.members.find((m) => m.nodeId === state.identity?.nodeId)?.role === 'admin'

  useEffect(() => {
    if (state.group) {
      void api.listInvites().then(setInvites).catch(() => undefined)
    }
    void api.embeddedHubAddress().then(setEmbedded).catch(() => undefined)
  }, [api, state.group?.groupId])

  const createGroup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.createGroup({
        hubAddress: hubAddress.trim(),
        groupName: groupName.trim() || 'Meine Gruppe',
        ...(hubToken.trim() ? { hubToken: hubToken.trim() } : {})
      })
      if (result.ok) {
        notify('Gruppe erstellt', 'ok')
        setMode('none')
        await api.updateSettings({ hubAddress: hubAddress.trim() })
      } else {
        notify(result.error ?? 'Erstellen fehlgeschlagen', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const joinGroup = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.joinGroup({
        hubAddress: hubAddress.trim(),
        groupId: groupId.trim(),
        inviteCode: inviteCode.trim()
      })
      if (result.ok) {
        notify('Gruppe beigetreten', 'ok')
        setMode('none')
        await api.updateSettings({ hubAddress: hubAddress.trim() })
      } else {
        notify(result.error ?? 'Beitritt fehlgeschlagen', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gruppe</h1>
          <p>
            Mitglieder, Einladungen und Hosting-Freigaben. Der Koordinationsdienst (Hub) entscheidet
            alle Host-Leases – er muss für alle Mitglieder erreichbar sein.
          </p>
        </div>
        <div className="page-actions">
          {state.group ? (
            <button
              className="btn danger"
              onClick={() => {
                void api.leaveGroup().then(() => notify('Gruppe verlassen', 'info'))
              }}
            >
              Gruppe verlassen
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => setMode('create')}>
                + Gruppe erstellen
              </button>
              <button className="btn" onClick={() => setMode('join')}>
                Gruppe beitreten
              </button>
            </>
          )}
        </div>
      </div>

      {!state.hubConnected && state.group && (
        <Notice kind="danger">
          Der Koordinationsdienst ist nicht erreichbar. Solange das so bleibt, kann kein neuer Host
          bestimmt werden – der bestehende Server läuft weiter, aber ein Ausfall des Hosts kann
          nicht aufgefangen werden.
        </Notice>
      )}

      {state.hubError && state.group && (
        <Notice kind="warn">
          Letzter Verbindungsfehler: {state.hubError}
        </Notice>
      )}

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <Card title="Gruppeninfo">
          {state.group ? (
            <dl className="kv">
              <dt>Name</dt>
              <dd>{state.group.name}</dd>
              <dt>Gruppen-ID</dt>
              <dd className="mono">{state.group.groupId}</dd>
              <dt>Hub-Adresse</dt>
              <dd className="mono" style={{ overflowWrap: 'anywhere' }}>
                {state.group.hubAddress || state.settings.hubAddress || '—'}
              </dd>
              <dt>Erstellt</dt>
              <dd>{new Date(state.group.createdAt).toLocaleString('de-DE')}</dd>
              <dt>Weltversion</dt>
              <dd className="mono">{state.group.currentWorldVersionId?.slice(0, 16) ?? '—'}</dd>
            </dl>
          ) : (
            <Empty>
              Sie sind keiner Gruppe beigetreten. Erstellen Sie eine Gruppe oder treten Sie mit
              einem Einladungscode bei.
            </Empty>
          )}
        </Card>

        <Card title="Einladungen" hint={isAdmin ? 'Als Besitzer verwalten' : 'Nur lesbar'}>
          {state.group ? (
            <>
              {isAdmin && (
                <div className="inline-form" style={{ marginBottom: 12 }}>
                  <button
                    className="btn small"
                    onClick={() => {
                      void api
                        .createInvite('Einladung', 0, 0)
                        .then((list) => {
                          setInvites(list)
                          notify('Einladung erstellt', 'ok')
                        })
                        .catch(() => notify('Einladung konnte nicht erstellt werden', 'error'))
                    }}
                  >
                    + Neue Einladung
                  </button>
                </div>
              )}
              {invites.length === 0 ? (
                <Empty>Keine Einladungen vorhanden.</Empty>
              ) : (
                <div className="col">
                  {invites.map((inv) => (
                    <div key={inv.inviteId} className="col" style={{ gap: 6 }}>
                      <div className="row between">
                        <div>
                          <div style={{ fontWeight: 600 }}>{inv.name}</div>
                          <div className="small faint">
                            {inv.uses}× verwendet
                            {inv.expiresAt ? ` · gültig bis ${new Date(inv.expiresAt).toLocaleString('de-DE')}` : ' · kein Ablauf'}
                          </div>
                        </div>
                        <div className="row" style={{ gap: 6 }}>
                          {inv.revoked ? (
                            <Pill kind="danger">widerrufen</Pill>
                          ) : (
                            <Pill kind="ok">gültig</Pill>
                          )}
                          {isAdmin && !inv.revoked && (
                            <button
                              className="btn small ghost"
                              onClick={() => {
                                void api.revokeInvite(inv.inviteId).then(setInvites)
                              }}
                            >
                              Widerrufen
                            </button>
                          )}
                        </div>
                      </div>
                      {!inv.revoked && <div className="code-block">{inv.code}</div>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <Empty>Erst nach dem Beitritt verfügbar.</Empty>
          )}
        </Card>
      </div>

      <Card title="Mitglieder" hint="Hosting-Fähigkeit, Priorität und Verbindungsstatus">
        {state.members.length === 0 ? (
          <Empty>Keine Mitglieder.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Mitglied</th>
                <th>Rolle</th>
                <th>Status</th>
                <th>Hosting</th>
                <th className="right">Priorität</th>
                <th>Zuletzt gesehen</th>
                {isOwner && <th />}
              </tr>
            </thead>
            <tbody>
              {state.members.map((m) => {
                const self = m.nodeId === state.identity?.nodeId
                return (
                  <tr key={m.nodeId}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {m.displayName}
                        {self && <span className="faint small"> (Sie)</span>}
                      </div>
                      <div className="faint small mono">{m.nodeId}</div>
                    </td>
                    <td>
                      <Pill kind={m.role === 'owner' ? 'info' : 'muted'}>{m.role}</Pill>
                    </td>
                    <td>
                      {m.online ? <Pill kind="ok">online</Pill> : <Pill kind="muted">offline</Pill>}
                    </td>
                    <td>
                      {m.hostingAllowed ? (
                        <Pill kind="ok">freigegeben</Pill>
                      ) : (
                        <Pill kind="warn">gesperrt</Pill>
                      )}
                    </td>
                    <td className="right mono">{m.hostingPriority}</td>
                    <td className="small dim">{formatRelative(m.lastSeenAt)}</td>
                    {isOwner && (
                      <td className="right">
                        {!self && (
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn small ghost"
                              onClick={() => {
                                void api.setMemberAllowed(m.nodeId, !m.hostingAllowed)
                              }}
                            >
                              {m.hostingAllowed ? 'Sperren' : 'Freigeben'}
                            </button>
                            <button
                              className="btn small ghost"
                              onClick={() => {
                                void api
                                  .removeMember(m.nodeId)
                                  .then(() => notify(`${m.displayName} wurde entfernt`, 'info'))
                              }}
                            >
                              Entfernen
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {mode !== 'none' && (
        <Modal
          title={mode === 'create' ? 'Gruppe erstellen' : 'Gruppe beitreten'}
          description={
            mode === 'create'
              ? 'Sie werden Besitzer der Gruppe und erhalten automatisch einen Einladungscode.'
              : 'Sie benötigen den Einladungscode und die Gruppen-ID des Besitzers.'
          }
          onClose={() => setMode('none')}
        >
          <Field
            label="Adresse des Koordinationsdienstes"
            help="Multiaddr des Hubs, z. B. /ip4/192.168.1.20/tcp/4001/p2p/12D3Koo…"
          >
            <input
              type="text"
              value={hubAddress}
              placeholder={embedded ?? '/ip4/127.0.0.1/tcp/4001/p2p/…'}
              onChange={(e) => setHubAddress(e.target.value)}
            />
          </Field>

          {embedded && (
            <CopyField label="Adresse des eingebetteten Hubs" value={embedded} />
          )}

          {mode === 'create' ? (
            <>
              <Field label="Gruppenname">
                <input
                  type="text"
                  value={groupName}
                  placeholder="Meine Gruppe"
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </Field>
              <Field
                label="Hub-Token (optional)"
                help="Nur nötig, wenn der Hub ein Token verlangt."
              >
                <input type="text" value={hubToken} onChange={(e) => setHubToken(e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Gruppen-ID">
                <input
                  type="text"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  placeholder="UUID der Gruppe"
                />
              </Field>
              <Field label="Einladungscode">
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="MMH-XXXX-XXXX-XXXX"
                />
              </Field>
            </>
          )}

          <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setMode('none')}>
              Abbrechen
            </button>
            <button
              className="btn primary"
              disabled={busy || !hubAddress.trim()}
              onClick={() => void (mode === 'create' ? createGroup() : joinGroup())}
            >
              {busy ? 'Wird ausgeführt…' : mode === 'create' ? 'Gruppe erstellen' : 'Beitreten'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
