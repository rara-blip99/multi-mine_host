import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from './logger'

/**
 * Dauerhafter, atomarer Zustandsspeicher.
 *
 * Schreibvorgang:
 *   1. In temporaere Datei schreiben
 *   2. fsync auf der Datei (Inhalt liegt auf der Platte)
 *   3. atomares rename ueber das Ziel (POSIX/Windows ersetzenatomar)
 *   4. fsync auf dem Verzeichnis (Rename-Metadaten liegen auf der Platte)
 *
 * Vor dem Ueberschreiben wird die vorherige Version als `.bak` gesichert,
 * damit ein Absturz waehrend des Schreibens nicht zu Datenverlust fuehrt.
 */
export class AtomicStore<T> {
  private readonly file: string
  private readonly backup: string
  private cached: T | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(
    file: string,
    private readonly fallback: () => T
  ) {
    this.file = file
    this.backup = file + '.bak'
  }

  get path(): string {
    return this.file
  }

  /** Laedt den Zustand. Nutzt bei Bedarf die .bak-Datei. */
  load(): T {
    if (this.cached) return this.cached
    for (const candidate of [this.file, this.backup]) {
      if (!existsSync(candidate)) continue
      try {
        const raw = readFileSync(candidate, 'utf8')
        const parsed = JSON.parse(raw) as T
        this.cached = parsed
        return parsed
      } catch (err) {
        logger.warn('atomic-store', `Zustandsdatei unlesbar, nutze Backup`, {
          file: candidate,
          error: String(err)
        })
      }
    }
    const fresh = this.fallback()
    this.cached = fresh
    return fresh
  }

  /** Markiert den Zustand als geaendert (z.B. durch Mutation). */
  touch(): void {
    this.dirty = true
  }

  /** Persistiert den Zustand. Mehrfache parallele Aufrufe werden serialisiert. */
  async save(value: T): Promise<void> {
    this.cached = value
    this.dirty = false
    this.writing = this.writing.then(() => this.persist(value)).catch((err) => {
      logger.error('atomic-store', 'Zustand konnte nicht gespeichert werden', { error: String(err) })
    })
    return this.writing
  }

  /** Blockiert, bis alle ausstehenden Schreibvorgaenge abgeschlossen sind. */
  async flush(): Promise<void> {
    await this.writing
  }

  private persist(value: T): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const data = JSON.stringify(value, null, 2)

    // 1) temporaer schreiben + fsync
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    // 2) vorherige gute Version sichern
    if (existsSync(this.file)) {
      try {
        const prev = readFileSync(this.file)
        const bfd = openSync(this.backup, 'w')
        try {
          writeSync(bfd, prev)
          fsyncSync(bfd)
        } finally {
          closeSync(bfd)
        }
      } catch (err) {
        logger.warn('atomic-store', 'Backup der Zustandsdatei fehlgeschlagen', { error: String(err) })
      }
    }

    // 3) atomares Ersetzen
    try {
      renameSync(tmp, this.file)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw err
    }

    // 4) Verzeichnis-Metadaten fsyncen (bestaetigt den Rename)
    try {
      const dfd = openSync(dir, 'r')
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch {
      // Unter Windows ist ein fsync auf Verzeichnisse nicht unterstuetzt.
    }
  }
}

/**
 * Append-only Journal fuer sicherheitskritische Zustandsuebergaenge.
 *
 * Der Journal wird bei jedem Host-Wechsel, Lease-Wechsel und Welt-Commit
 * geschrieben. So laesst sich nach einem Absturz exakt nachvollziehen, welche
 * Operationen in-flight waren.
 */
export interface JournalRecord {
  ts: number
  kind: string
  data: Record<string, unknown>
}

export class Journal {
  private readonly file: string
  private handle: number | null = null

  constructor(file: string) {
    this.file = file
  }

  private open(): number {
    if (this.handle === null) {
      mkdirSync(dirname(this.file), { recursive: true })
      this.handle = openSync(this.file, 'a')
    }
    return this.handle
  }

  append(kind: string, data: Record<string, unknown>): void {
    try {
      const rec: JournalRecord = { ts: Date.now(), kind, data }
      writeSync(this.open(), JSON.stringify(rec) + '\n')
    } catch (err) {
      logger.error('journal', 'Journal-Eintrag fehlgeschlagen', { error: String(err) })
    }
  }

  read(limit = 500): JournalRecord[] {
    if (!existsSync(this.file)) return []
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
      const out: JournalRecord[] = []
      for (const line of lines.slice(-limit)) {
        try {
          out.push(JSON.parse(line) as JournalRecord)
        } catch {
          /* teilweise geschriebene letzte Zeile ignorieren */
        }
      }
      return out
    } catch {
      return []
    }
  }

  close(): void {
    if (this.handle !== null) {
      try {
        closeSync(this.handle)
      } catch {
        /* ignore */
      }
      this.handle = null
    }
  }
}

/** Loescht eine Datei tolerant (trotz Fehler kein Abbruch). */
export function safeUnlink(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* ignore */
  }
}

/** Loescht ein Verzeichnis rekursiv und tolerant. */
export function safeRmDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      const { rmSync } = require('node:fs')
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    /* ignore */
  }
}

/** Schreibt eine Datei atomar (fuer nicht-JSON Dateien). */
export function writeFileAtomic(file: string, data: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}
