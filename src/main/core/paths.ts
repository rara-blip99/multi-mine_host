import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Zentrale Pfadaufloesung.
 *
 * Grundsatz: Jeder Zugriff der Anwendung auf die Dateisystemstruktur
 * passiert ueber diese Funktionen. Netzwerkdaten koennen niemals Pfade
 * vorgeben - sie werden immer relativ zu einem erlaubten Basisverzeichnis
 * aufgeloest (siehe security/path-guard.ts).
 */

function baseDir(): string {
  try {
    if (app && app.getPath) return app.getPath('userData')
  } catch {
    /* nicht im Electron-Kontext (Tests, Hub-Standalone) */
  }
  return join(homedir(), '.multi-mine-host')
}

/** Optionales Überschreiben des Basisverzeichnisses (Tests, portable Installation). */
let rootOverride: string | null = null

export const Paths = {
  /** Basisverzeichnis fuer alle App-Daten. */
  root(): string {
    return rootOverride ? resolve(rootOverride) : resolve(baseDir())
  },
  /** Überschreibt das Basisverzeichnis. */
  setRoot(dir: string | null): void {
    rootOverride = dir ? resolve(dir) : null
  },
  /** Persistente Einstellungen und Zustand. */
  state(): string {
    return join(Paths.root(), 'state')
  },
  /** Logs. */
  logs(): string {
    return join(Paths.root(), 'logs')
  },
  /** Kryptographische Schluessel. */
  keys(): string {
    return join(Paths.root(), 'keys')
  },
  /** Heruntergeladene Server-JARs. */
  serverJars(): string {
    return join(Paths.root(), 'server')
  },
  /** Temporaere Dateien (Transfer, entpackte Archive). */
  tmp(): string {
    return join(Paths.root(), 'tmp')
  },
  /** Standard-Installationsverzeichnis der Minecraft-Server. */
  defaultServerDir(): string {
    return join(Paths.root(), 'servers')
  },
  /** Standard-Weltspeicher. */
  defaultWorldsDir(): string {
    return join(Paths.root(), 'worlds')
  },
  /** Standard-Backup-Speicher. */
  defaultBackupsDir(): string {
    return join(Paths.root(), 'backups')
  },
  /** Quarantäne fuer Welten, die von einem veralteten Host stammen. */
  quarantine(): string {
    return join(Paths.root(), 'quarantine')
  },
  ensureAll(): void {
    for (const p of [
      Paths.root(),
      Paths.state(),
      Paths.logs(),
      Paths.keys(),
      Paths.serverJars(),
      Paths.tmp(),
      Paths.defaultServerDir(),
      Paths.defaultWorldsDir(),
      Paths.defaultBackupsDir(),
      Paths.quarantine()
    ]) {
      mkdirSync(p, { recursive: true })
    }
  }
}
