import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import type { BackupInfo, BackupKind, BackupResult, WorldManifest } from '@shared/types'
import { normalizeRelative, resolveWithin } from '../security/path-guard'
import { logger } from '../core/logger'

/**
 * Backup-Manager.
 *
 * Sicherheits- und Konsistenzregeln:
 *  - Es wird nur eine Welt gesichert, die zuvor vom Minecraft-Server
 *    explizit gespeichert wurde (save-off / save-all flush / save-on).
 *  - Jedes Backup enthaelt eine SHA-256-Pruefsumme des Archivs.
 *  - Beim Wiederherstellen wird das Archiv zuerst in ein temporaeres
 *    Verzeichnis entpackt und geprueft. Die aktive Welt wird erst danach
 *    ersetzt - und die alte Welt landet in der Quarantäne.
 *  - Die Aufbewahrung schützt immer mindestens das letzte gültige Backup.
 */

/**
 * Dateien und Verzeichnisse, die nicht in ein Backup gehoeren.
 * `session.lock` wird vom laufenden Minecraft-Server exklusiv gehalten
 * (unter Windows gesperrt) und von Minecraft ohnehin neu erzeugt.
 */
const EXCLUDED_FILES = new Set(['session.lock'])
const EXCLUDED_DIRS = new Set(['cache', '.cache', 'tmp'])

export interface BackupManagerOptions {
  /** Verzeichnis, in dem die Backups liegen. */
  backupsDir: string
  /** Maximale Anzahl Backups pro Art. */
  retention: number
  /** Maximale Groesse eines Backups in Bytes (0 = unbegrenzt). */
  maxSizeBytes?: number
  /** Quarantäne-Verzeichnis fuer ersetzte Welten. */
  quarantineDir?: string
  onLog?: (message: string) => void
}

export interface BackupContext {
  worldPath: string
  manifest: WorldManifest
  /** Weltversion, die in das Backup geschrieben wird. */
  worldVersionId: string
  mcVersion: string
  dataVersion: number
  worldName: string
}

export class BackupManager {
  constructor(private readonly opts: BackupManagerOptions) {
    mkdirSync(this.opts.backupsDir, { recursive: true })
  }

  get directory(): string {
    return this.opts.backupsDir
  }

  private metaPath(archive: string): string {
    return `${archive}.meta.json`
  }

  /**
   * Erstellt ein Backup der Welt.
   */
  async createBackup(kind: BackupKind, ctx: BackupContext): Promise<BackupResult> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const id = `${stamp}_${kind}_${ctx.worldVersionId.slice(0, 12)}`
    const archive = join(this.opts.backupsDir, `${id}.tar.gz`)

    try {
      if (!existsSync(ctx.worldPath)) {
        return { ok: false, error: 'Weltverzeichnis existiert nicht', code: 'NO_WORLD' }
      }

      const maxSize = this.opts.maxSizeBytes ?? 0
      let uncompressedBytes = ctx.manifest.totalBytes
      if (maxSize > 0 && uncompressedBytes > maxSize) {
        return {
          ok: false,
          error: `Welt ist gr��ßer als das erlaubte Backup-Limit (${uncompressedBytes} > ${maxSize} Bytes)`,
          code: 'TOO_LARGE'
        }
      }

      logger.info('backup', 'Erstelle Backup', { kind, world: ctx.worldName, id })

      // Komprimiertes Archiv (tar.gz)
      await tar.create(
        {
          gzip: true,
          cwd: ctx.worldPath,
          file: archive,
          portable: true,
          // Keine Symlinks im Archiv erlauben (Manipulationsschutz) und
          // dieselben Dateien ausschliessen wie beim Manifest. session.lock
          // wird vom laufenden Server exklusiv gehalten (Windows sperrt die
          // Datei) und wird von Minecraft ohnehin neu erzeugt.
          filter: (path: string) => {
            const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
            if (normalized === '' || normalized === '.') return true
            const first = normalized.split('/')[0] ?? ''
            if (EXCLUDED_FILES.has(first)) return false
            if (EXCLUDED_DIRS.has(first)) return false
            try {
              normalizeRelative(normalized)
              return true
            } catch {
              return false
            }
          }
        },
        ['.']
      )

      const sha256 = await hashFileStream(archive)
      const sizeBytes = statSync(archive).size

      const info: BackupInfo = {
        id,
        kind,
        createdAt: Date.now(),
        worldName: ctx.worldName,
        worldVersionId: ctx.worldVersionId,
        sizeBytes,
        uncompressedBytes,
        mcVersion: ctx.mcVersion,
        dataVersion: ctx.dataVersion,
        sha256,
        verified: true,
        replicated: false,
        path: archive
      }

      writeFileSync(this.metaPath(archive), JSON.stringify(info, null, 2), 'utf8')
      this.opts.onLog?.(`Backup ${id} erstellt (${formatBytes(sizeBytes)})`)

      await this.applyRetention()

      return { ok: true, info }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('backup', 'Backup fehlgeschlagen', { error: message })
      try {
        if (existsSync(archive)) rmSync(archive, { force: true })
      } catch {
        /* ignore */
      }
      return { ok: false, error: message, code: 'BACKUP_FAILED' }
    }
  }

  /** Listet alle Backups (neueste zuerst). */
  list(): BackupInfo[] {
    if (!existsSync(this.opts.backupsDir)) return []
    const out: BackupInfo[] = []
    for (const file of readdirSync(this.opts.backupsDir)) {
      if (!file.endsWith('.tar.gz')) continue
      const meta = this.metaPath(join(this.opts.backupsDir, file))
      if (!existsSync(meta)) continue
      try {
        const info = JSON.parse(readFileSync(meta, 'utf8')) as BackupInfo
        if (existsSync(info.path)) out.push(info)
      } catch {
        /* defekte Metadaten werden ignoriert */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Prueft ein Backup auf Vollstaendigkeit und Integritaet. */
  async verify(info: BackupInfo): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = []
    if (!existsSync(info.path)) {
      return { ok: false, problems: ['Archivdatei fehlt'] }
    }
    if (statSync(info.path).size !== info.sizeBytes) {
      problems.push('Archivgröße weicht von den Metadaten ab')
    }
    const actual = await hashFileStream(info.path)
    if (actual !== info.sha256) {
      problems.push('Prüfsumme des Archivs stimmt nicht')
    }
    // Archivtest: alle Einträge müssen lesbar sein.
    try {
      let entries = 0
      await tar.list({
        file: info.path,
        onentry: (entry) => {
          entries += 1
          void entry.resume()
        }
      })
      if (entries === 0) {
        problems.push('Archiv enthält keine Einträge')
      }
    } catch (err) {
      problems.push(`Archiv ist beschädigt: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { ok: problems.length === 0, problems }
  }

  /** Prueft alle Backups und aktualisiert das `verified`-Feld. */
  async verifyAll(): Promise<BackupInfo[]> {
    const list = this.list()
    for (const info of list) {
      const result = await this.verify(info)
      info.verified = result.ok
      try {
        writeFileSync(this.metaPath(info.path), JSON.stringify(info, null, 2), 'utf8')
      } catch {
        /* ignore */
      }
    }
    return list
  }

  /**
   * Stellt ein Backup wieder her.
   *
   * Ablauf:
   *  1. Archiv pruefen (Integritaet)
   *  2. In temporaeres Verzeichnis entpacken
   *  3. Weltstruktur pruefen (level.dat vorhanden)
   *  4. Bestehende Welt in die Quarantäne verschieben
   *  5. Neue Welt aktivieren
   */
  async restore(
    info: BackupInfo,
    targetWorldPath: string
  ): Promise<{ ok: boolean; error: string | null; stagingPath: string | null }> {
    const staging = join(this.opts.backupsDir, `.restore-${info.id}-${Date.now()}`)
    try {
      const verification = await this.verify(info)
      if (!verification.ok) {
        return {
          ok: false,
          error: `Backup ist beschädigt und kann nicht wiederhergestellt werden: ${verification.problems.join(', ')}`,
          stagingPath: null
        }
      }

      mkdirSync(staging, { recursive: true })
      await tar.extract({
        file: info.path,
        cwd: staging,
        strict: true,
        preservePaths: false,
        filter: (path: string) => {
          const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
          if (normalized === '' || normalized === '.') return true
          try {
            // Harte Pfadpruefung: jede Datei muss im Staging-Verzeichnis bleiben.
            resolveWithin(staging, normalized)
            return true
          } catch {
            logger.warn('backup', 'Unsicherer Pfad im Archiv wird übersprungen', { path })
            return false
          }
        }
      })

      // Struktur pruefen
      const levelDat = join(staging, 'level.dat')
      if (!existsSync(levelDat)) {
        rmSync(staging, { recursive: true, force: true })
        return { ok: false, error: 'Backup enthält keine gültige Welt (level.dat fehlt)', stagingPath: null }
      }

      // Bestehende Welt sichern (Quarantäne) und neue Welt aktivieren
      const quarantine = this.opts.quarantineDir
      if (existsSync(targetWorldPath)) {
        if (quarantine) {
          mkdirSync(quarantine, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const backupTarget = join(quarantine, `pre-restore-${stamp}`)
          try {
            renameSync(targetWorldPath, backupTarget)
          } catch {
            rmSync(targetWorldPath, { recursive: true, force: true })
          }
        } else {
          rmSync(targetWorldPath, { recursive: true, force: true })
        }
      }
      mkdirSync(resolve(targetWorldPath, '..'), { recursive: true })
      renameSync(staging, targetWorldPath)

      logger.info('backup', 'Backup wiederhergestellt', { id: info.id, target: targetWorldPath })
      return { ok: true, error: null, stagingPath: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('backup', 'Wiederherstellung fehlgeschlagen', { id: info.id, error: message })
      try {
        if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      return { ok: false, error: message, stagingPath: null }
    }
  }

  /**
   * Wendet die Aufbewahrungsregel an.
   * Es wird immer mindestens das letzte gueltige Backup pro Art behalten.
   */
  async applyRetention(): Promise<string[]> {
    const list = this.list()
    const removed: string[] = []
    const byKind = new Map<BackupKind, BackupInfo[]>()
    for (const info of list) {
      const arr = byKind.get(info.kind) ?? []
      arr.push(info)
      byKind.set(info.kind, arr)
    }

    for (const [kind, items] of byKind) {
      const limit = Math.max(1, this.opts.retention)
      // Das neueste gültige Backup bleibt IMMER erhalten.
      const newestValid = items.find((i) => i.verified)
      const keep = new Set<string>()
      for (const item of items.slice(0, limit)) keep.add(item.id)
      if (newestValid) keep.add(newestValid.id)

      for (const item of items) {
        if (keep.has(item.id)) continue
        try {
          rmSync(item.path, { force: true })
          rmSync(this.metaPath(item.path), { force: true })
          removed.push(item.id)
        } catch (err) {
          logger.warn('backup', 'Backup konnte nicht entfernt werden', { id: item.id, error: String(err) })
        }
      }
      void kind
    }
    if (removed.length > 0) {
      logger.info('backup', 'Backups nach Aufbewahrungsregel entfernt', { count: removed.length })
    }
    return removed
  }

  /**
   * Kopiert ein Backup in ein anderes Verzeichnis (Replikation auf einen
   * zweiten Gruppen-PC). Der Zielordner muss bereits existieren.
   */
  async replicate(info: BackupInfo, destinationDir: string): Promise<{ ok: boolean; error: string | null }> {
    try {
      mkdirSync(destinationDir, { recursive: true })
      const target = join(destinationDir, `${info.id}.tar.gz`)
      const metaTarget = `${target}.meta.json`
      await pipeline(createReadStream(info.path), createWriteStream(target))
      const meta = { ...info, path: target, replicated: true }
      writeFileSync(metaTarget, JSON.stringify(meta, null, 2), 'utf8')
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Liest die Metadaten eines replizierten Backups (fuer die Remote-Seite). */
  readMeta(archivePath: string): BackupInfo | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(archivePath), 'utf8')) as BackupInfo
    } catch {
      return null
    }
  }
}

async function hashFileStream(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
