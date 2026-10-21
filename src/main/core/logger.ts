import { appendFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Paths } from './paths'
import type { LogEntry } from '@shared/types'

type Level = LogEntry['level']

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const REDACT_KEYS = /pass|password|secret|token|key|seed|authorization|cookie/i

/** Redigiert sensible Werte aus Log-Payloads. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.test(k)) {
      out[k] = '[redacted]'
      continue
    }
    out[k] = redact(v, depth + 1)
  }
  return out
}

class Logger {
  private minLevel: Level = 'info'
  private file: string | null = null
  private readonly buffer: LogEntry[] = []
  private readonly maxBuffer = 500
  private listeners = new Set<(e: LogEntry) => void>()
  private silent = false

  init(): void {
    try {
      mkdirSync(Paths.logs(), { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      this.file = join(Paths.logs(), `multimine-${day}.log`)
    } catch {
      this.file = null
    }
  }

  setLevel(level: Level): void {
    this.minLevel = level
  }

  /** Unterdrückt die Konsolenausgabe (z. B. in Tests). */
  setSilent(silent: boolean): void {
    this.silent = silent
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  recent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit)
  }

  private write(level: Level, scope: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      scope,
      message,
      ...(data ? { data: redact(data) as Record<string, unknown> } : {})
    }
    this.buffer.push(entry)
    if (this.buffer.length > this.maxBuffer) this.buffer.shift()
    for (const fn of this.listeners) {
      try {
        fn(entry)
      } catch {
        /* Listener-Fehler duerfen das Logging nie stoppen */
      }
    }
    const line = JSON.stringify(entry)
    if (this.file) {
      try {
        appendFileSync(this.file, line + '\n')
      } catch {
        /* Logging darf nie werfen */
      }
    }
    if (this.silent) return
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(`[${entry.scope}] ${message}`, data ? (redact(data) as object) : '')
  }

  debug(scope: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', scope, message, data)
  }
  info(scope: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', scope, message, data)
  }
  warn(scope: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', scope, message, data)
  }
  error(scope: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', scope, message, data)
  }
}

export const logger = new Logger()

/** Groesse einer Logdatei in Bytes (oder 0). */
export function logFileSize(): number {
  try {
    if (existsSync(Paths.logs())) {
      const files = require('node:fs').readdirSync(Paths.logs()) as string[]
      let total = 0
      for (const f of files) total += statSync(join(Paths.logs(), f)).size
      return total
    }
  } catch {
    /* ignore */
  }
  return 0
}
