import { useState } from 'react'
import { AppProvider, useApp } from './state'
import Dashboard from './pages/Dashboard'
import GroupPage from './pages/GroupPage'
import WorldPage from './pages/WorldPage'
import SettingsPage from './pages/SettingsPage'

type PageId = 'dashboard' | 'group' | 'world' | 'settings'

const PAGES: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'dashboard', label: 'Dashboard', icon: '◈' },
  { id: 'group', label: 'Gruppe', icon: '⧉' },
  { id: 'world', label: 'Welt', icon: '⛏' },
  { id: 'settings', label: 'Einstellungen', icon: '⚙' }
]

function Shell(): React.JSX.Element {
  const { state, toasts, dismiss } = useApp()
  const [page, setPage] = useState<PageId>('dashboard')

  const hostMember = state.members.find((m) => m.nodeId === state.lease?.holderId)
  const isHost = state.lease?.holderId === state.identity?.nodeId

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div className="brand-text">
            <strong>Multi-Mine Host</strong>
            <span>{state.group ? state.group.name : 'Keine Gruppe'}</span>
          </div>
        </div>

        <nav className="nav">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`nav-item ${page === p.id ? 'active' : ''}`}
              onClick={() => setPage(p.id)}
            >
              <span className="icon">{p.icon}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div>
            <span className="faint">Status:</span>{' '}
            {state.hubConnected ? 'Hub verbunden' : 'Hub offline'}
          </div>
          <div>
            <span className="faint">Host:</span>{' '}
            {state.lease ? (hostMember?.displayName ?? state.lease.holderId) : '—'}
          </div>
          {isHost && <div style={{ color: 'var(--accent)' }}>★ Sie sind der aktive Host</div>}
          <div className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
            {state.identity?.nodeId}
          </div>
        </div>
      </aside>

      <main className="main">
        {page === 'dashboard' && <Dashboard />}
        {page === 'group' && <GroupPage />}
        {page === 'world' && <WorldPage />}
        {page === 'settings' && <SettingsPage />}
      </main>

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
