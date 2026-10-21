import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

/** Wiederverwendbare Bausteine der Oberflaeche. */

export function Card({
  title,
  hint,
  actions,
  children,
  className
}: {
  title?: string
  hint?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-title">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  icon
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'accent' | 'info' | 'warn' | 'danger'
  icon?: string
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="stat">
        <div className="stat-label">
          {icon && <span>{icon}</span>}
          {label}
        </div>
        <div className={`stat-value ${tone ?? ''}`}>{value}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  )
}

export function Pill({
  kind = 'muted',
  children,
  dot = true
}: {
  kind?: 'ok' | 'warn' | 'danger' | 'info' | 'muted'
  children: ReactNode
  dot?: boolean
}): React.JSX.Element {
  return (
    <span className={`pill ${kind}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  )
}

export function Bar({
  value,
  max = 100,
  tone
}: {
  value: number
  max?: number
  tone?: 'warn' | 'danger' | 'violet'
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))
  return (
    <div className={`bar ${tone ?? ''}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Notice({
  kind = 'info',
  children
}: {
  kind?: 'info' | 'ok' | 'warn' | 'danger'
  children: ReactNode
}): React.JSX.Element {
  const icon = kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : kind === 'danger' ? '✕' : 'ℹ'
  return (
    <div className={`notice ${kind}`}>
      <span className="icon">{icon}</span>
      <div>{children}</div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="empty">{children}</div>
}

export function Field({
  label,
  help,
  children
}: {
  label: string
  help?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  description
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="switch-row">
      <div>
        <div>{label}</div>
        {description && <div className="help">{description}</div>}
      </div>
      <div
        className={`switch ${checked ? 'on' : ''}`}
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onChange(!checked)
        }}
      />
    </div>
  )
}

export function Modal({
  title,
  description,
  onClose,
  children
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {description && <p className="dim small" style={{ marginTop: 0 }}>{description}</p>}
        <div style={{ marginTop: 16 }}>{children}</div>
      </div>
    </div>
  )
}

/** Kleiner Dialog zum Kopieren eines Textes. */
export function CopyField({ value, label }: { value: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <div className="row" style={{ gap: 8 }}>
        <div className="code-block" style={{ flex: 1, textAlign: 'left' }}>
          {value}
        </div>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }}
        >
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
    </div>
  )
}
