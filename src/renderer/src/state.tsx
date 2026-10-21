import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppState } from '@shared/types'
import type { MmhApi } from '@shared/ipc'

/**
 * Gemeinsamer Zustand fuer den Renderer.
 *
 * Der Main-Prozess ist die einzige Quelle der Wahrheit. Der Renderer
 * empfaengt Zustandsaenderungen ueber den IPC-Kanal und speichert lokal nur
 * Benutzereingaben.
 */

interface Toast {
  id: number
  kind: 'info' | 'ok' | 'warn' | 'error'
  message: string
}

interface AppContextValue {
  state: AppState
  api: MmhApi
  toasts: Toast[]
  notify: (message: string, kind?: Toast['kind']) => void
  dismiss: (id: number) => void
}

const AppContext = createContext<AppContextValue | null>(null)

let toastCounter = 0

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const notify = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastCounter
    setToasts((prev) => [...prev, { id, kind, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, kind === 'error' ? 9000 : 5000)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  useEffect(() => {
    let cancelled = false
    const api = window.mmh
    if (!api) return
    void api.getState().then((s) => {
      if (!cancelled) setState(s)
    })
    const unsubscribe = api.onStateChanged((next) => setState(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo<AppContextValue | null>(() => {
    if (!state) return null
    return { state, api: window.mmh, toasts, notify, dismiss }
  }, [state, toasts, notify, dismiss])

  if (!value) {
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        <div className="spinner" style={{ margin: '0 auto 14px' }} />
        Multi-Mine Host wird geladen…
      </div>
    )
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp muss innerhalb von AppProvider verwendet werden')
  return ctx
}

/** Hilfsfunktionen fuer die Anzeige. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('de-DE')
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return 'gerade eben'
  if (diff < 3_600_000) return `vor ${Math.floor(diff / 60_000)} Min.`
  if (diff < 86_400_000) return `vor ${Math.floor(diff / 3_600_000)} Std.`
  return `vor ${Math.floor(diff / 86_400_000)} Tg.`
}
