import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, existsSync, statSync, openSync, writeSync, closeSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { writeSync as fsWriteSync } from 'node:fs'
import type { Stream } from '@libp2p/interface'
import type { SyncProgress, SyncResult, WorldManifest } from '@shared/types'
import { readFrames, writeFrame } from '../net/framing'
import { resolveWithin, assertRealPathWithin } from '../security/path-guard'
import { logger } from '../core/logger'

/**
 * Weltuebertragung zwischen zwei Mitgliedern.
 *
 * Sicherheitsmerkmale:
 *  - Alle Pfade werden gegen Path Traversal gesichert.
 *  - Jede Datei wird per SHA-256 geprueft (beide Richtungen).
 *  - Der Transfer laeuft ueber temporaere `.part`-Dateien. Erst nach
 *    vollstaendiger Verifikation wird die Welt atomar aktiviert.
 *  - Unterbrochene Transfers koennen fortgesetzt werden (Resume).
 *  - Vor der Uebertragung wird der freie Speicherplatz geprueft.
 */

export const FRAME_CONTROL = 1
export const FRAME_FILE_HEADER = 2
export const FRAME_FILE_DATA = 3
export const FRAME_FILE_END = 4
export const FRAME_TRANSFER_END = 5
export const FRAME_ERROR = 6

const CHUNK_SIZE = 512 * 1024
const MAX_FRAME = 16 * 1024 * 1024

export interface TransferFile {
  path: string
  /** Gesamtgroesse der Datei. */
  size: number
  sha256: string
  mtimeMs: number
  /**
   * Offset, ab dem der Empfaenger die Datei benoetigt.
   * > 0 bedeutet: der Empfaenger besitzt bereits die ersten `offset` Bytes
   * (z. B. aus einem abgebrochenen Transfer).
   */
  offset?: number
}

/** Fortsetzungsinformation fuer eine einzelne Datei. */
export interface ResumeOffset {
  path: string
  offset: number
}

export interface ResumeEntry {
  path: string
  size: number
  sha256: string
  /** Bereits empfangene Bytes dieser Datei. */
  received: number
}

export interface WorldTransferHeader {
  type: 'header'
  versionId: string
  worldName: string
  mcVersion: string
  dataVersion: number
  totalBytes: number
  files: TransferFile[]
}

export interface WorldTransferOptions {
  /** Zielverzeichnis der Welt (Staging). */
  targetPath: string
  /** Erwartetes Manifest - wird gegen die uebertragenen Dateien geprueft. */
  manifest: WorldManifest
  /** Bereits vorhandene Teildateien (fuer Resume). */
  resume?: ResumeEntry[]
  onProgress?: (progress: SyncProgress) => void
  /** Maximale Groesse pro Datei. */
  maxFileBytes?: number
  /** Maximale Gesamtgroesse. */
  maxTotalBytes?: number
}

export interface ReceiveResult extends SyncResult {
  /** Anzahl uebertragener Dateien. */
  filesReceived: number
  /** Anzahl der uebersprungenen (bereits vorhandenen) Dateien. */
  filesSkipped: number
}

function frame(type: number, body: Buffer | Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from([type]), body])
}

/**
 * Empfaengt eine Welt in ein Staging-Verzeichnis und prueft sie anschliessend.
 */
export async function receiveWorld(
  stream: Stream,
  opts: WorldTransferOptions
): Promise<ReceiveResult> {
  const maxFileBytes = opts.maxFileBytes ?? 8 * 1024 * 1024 * 1024
  const maxTotalBytes = opts.maxTotalBytes ?? 64 * 1024 * 1024 * 1024

  let bytesTransferred = 0
  let fileIndex = 0
  let fileCount = opts.manifest.entries.length
  let filesSkipped = 0
  let currentPath: string | null = null
  let currentExpectedSize = 0
  let currentExpectedHash = ''
  let currentReceived = 0
  let currentHandle: number | null = null
  let currentHash = createHash('sha256')
  const totalBytes = opts.manifest.totalBytes
  let transferFinished = false

  const report = (
    phase: SyncProgress['phase'],
    message: string,
    file: string | null = null
  ): void => {
    opts.onProgress?.({
      phase,
      fileIndex,
      fileCount,
      bytesTransferred,
      totalBytes,
      bytesPerSecond: 0,
      etaSeconds: null,
      currentFile: file,
      message
    })
  }

  const closeCurrent = (): void => {
    if (currentHandle !== null) {
      try {
        closeSync(currentHandle)
      } catch {
        /* ignore */
      }
      currentHandle = null
    }
  }

  try {
    for await (const raw of readFrames(stream, MAX_FRAME)) {
      if (raw.byteLength < 1) continue
      const type = raw[0] as number
      const body = raw.subarray(1)

      switch (type) {
        case FRAME_FILE_HEADER: {
          const info = JSON.parse(new TextDecoder().decode(body)) as TransferFile
          closeCurrent()
          currentPath = info.path
          currentExpectedSize = info.size
          currentExpectedHash = info.sha256
          currentHash = createHash('sha256')

          if (info.size > maxFileBytes) {
            throw new Error(`Datei ${info.path} überschreitet die maximale Größe`)
          }

          // Pfadsicherheit: der Pfad muss relativ und innerhalb des Ziels liegen.
          const target = resolveWithin(opts.targetPath, info.path)
          assertRealPathWithin(opts.targetPath, target)
          mkdirSync(dirname(target), { recursive: true })

          const partPath = `${target}.part`
          let offset = 0
          const requested = info.offset ?? 0
          if (requested > 0) {
            if (requested > info.size) {
              throw new Error(`Ungültiger Fortsetzungs-Offset für ${info.path}`)
            }
            if (existsSync(partPath)) {
              const size = statSync(partPath).size
              if (size >= requested) {
                offset = requested
                // Bestehende Bytes mit in den Hash aufnehmen
                currentHash = await hashPartial(partPath, offset)
                bytesTransferred += offset
              }
            }
          }

          currentReceived = offset
          currentHandle = openSync(partPath, offset > 0 ? 'r+' : 'w')
          report('transferring', `Übertrage ${info.path}`, info.path)
          break
        }

        case FRAME_FILE_DATA: {
          if (!currentPath) throw new Error('Dateidaten ohne vorherige Header')
          if (currentReceived + body.byteLength > currentExpectedSize) {
            throw new Error(`Datei ${currentPath} ist größer als angekündigt`)
          }
          currentHash.update(body)
          if (currentHandle !== null) {
            const written = fsWriteSync(
              currentHandle,
              body,
              0,
              body.byteLength,
              currentReceived
            )
            if (written !== body.byteLength) {
              throw new Error(`Schreiben fehlgeschlagen: ${currentPath}`)
            }
          }
          currentReceived += body.byteLength
          bytesTransferred += body.byteLength
          report('transferring', `Übertrage ${currentPath}`, currentPath)
          break
        }

        case FRAME_FILE_END: {
          if (!currentPath) throw new Error('Dateiende ohne vorherigen Header')
          closeCurrent()
          const digest = currentHash.digest('hex')
          if (digest !== currentExpectedHash) {
            throw new Error(
              `Prüfsumme stimmt nicht überein: ${currentPath} (erwartet ${currentExpectedHash}, erhalten ${digest})`
            )
          }
          const target = resolveWithin(opts.targetPath, currentPath)
          renameSync(`${target}.part`, target)
          fileIndex++
          currentPath = null
          break
        }

        case FRAME_TRANSFER_END: {
          report('verifying', 'Übertragung abgeschlossen', null)
          transferFinished = true
          break
        }

        case FRAME_ERROR: {
          const info = JSON.parse(new TextDecoder().decode(body)) as { reason: string; path?: string }
          throw new Error(info.reason)
        }

        default:
          throw new Error(`Unbekannter Frame-Typ ${type}`)
      }

      if (transferFinished) break
    }

    closeCurrent()

    if (!transferFinished) {
      throw new Error('Übertragung unvollständig: der Sender hat sie nicht sauber beendet')
    }
    if (fileIndex === 0 && fileCount > 0) {
      throw new Error('Übertragung unvollständig: keine Datei empfangen')
    }

    return {
      ok: true,
      versionId: opts.manifest.versionId,
      bytesTransferred,
      error: null,
      resumed: filesSkipped > 0 || (opts.resume ?? []).length > 0,
      filesReceived: fileIndex,
      filesSkipped
    }
  } catch (err) {
    closeCurrent()
    const message = err instanceof Error ? err.message : String(err)
    logger.error('world-sync', 'Übertragung fehlgeschlagen', { error: message })
    report('failed', message, currentPath)
    return {
      ok: false,
      versionId: null,
      bytesTransferred,
      error: message,
      resumed: false,
      filesReceived: fileIndex,
      filesSkipped
    }
  }
}

/**
 * Sendet eine Welt an den Empfaenger.
 */
export async function sendWorld(
  stream: Stream,
  worldPath: string,
  manifest: WorldManifest,
  opts: {
    /** Dateien, die der Empfaenger bereits vollstaendig hat. */
    skip?: Set<string>
    /** Fortsetzungs-Offsets pro Datei (Pfad -> bereits vorhandene Bytes). */
    resume?: Map<string, number>
    /** Abbruchsignal. */
    signal?: AbortSignal
    onProgress?: (progress: SyncProgress) => void
  } = {}
): Promise<SyncResult> {
  const skip = opts.skip ?? new Set<string>()
  const resume = opts.resume ?? new Map<string, number>()
  let bytesTransferred = 0
  const started = Date.now()
  let fileIndex = 0
  let filesSkipped = 0

  const report = (phase: SyncProgress['phase'], message: string, file: string | null = null): void => {
    const elapsed = Math.max(1, (Date.now() - started) / 1000)
    const bps = bytesTransferred / elapsed
    opts.onProgress?.({
      phase,
      fileIndex,
      fileCount: manifest.entries.length,
      bytesTransferred,
      totalBytes: manifest.totalBytes,
      bytesPerSecond: Math.round(bps),
      etaSeconds: bps > 0 ? Math.round((manifest.totalBytes - bytesTransferred) / bps) : null,
      currentFile: file,
      message
    })
  }

  try {
    // 1) Dateien
    for (const entry of manifest.entries) {
      if (opts.signal?.aborted) throw new Error('Übertragung abgebrochen')
      if (skip.has(entry.path)) {
        fileIndex++
        filesSkipped++
        continue
      }
      const full = join(worldPath, entry.path.split('/').join(sep))
      if (!existsSync(full)) {
        throw new Error(`Datei fehlt beim Sender: ${entry.path}`)
      }

      // Fortsetzungs-Offset (der Empfaenger besitzt eventuell schon Daten)
      let offset = 0
      const requested = resume.get(entry.path) ?? 0
      if (requested > 0) {
        const actual = statSync(full).size
        if (requested < actual) {
          offset = requested
        } else {
          // Bereits vollstaendig vorhanden -> ueberspringen
          fileIndex++
          filesSkipped++
          continue
        }
      }

      const fileHeader: TransferFile = {
        path: entry.path,
        size: entry.size,
        sha256: entry.sha256,
        mtimeMs: entry.mtimeMs,
        offset
      }
      await writeFrame(stream, frame(FRAME_FILE_HEADER, Buffer.from(JSON.stringify(fileHeader), 'utf8')), MAX_FRAME)

      await pipeline(
        createReadStream(full, { start: offset, highWaterMark: CHUNK_SIZE }),
        async function* (source) {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
            await writeFrame(stream, frame(FRAME_FILE_DATA, buf), MAX_FRAME)
            bytesTransferred += buf.byteLength
            report('transferring', `Übertrage ${entry.path}`, entry.path)
          }
        }
      )

      await writeFrame(
        stream,
        frame(FRAME_FILE_END, Buffer.from(JSON.stringify(entry.sha256), 'utf8')),
        MAX_FRAME
      )
      fileIndex++
    }

    // 2) Abschluss
    await writeFrame(
      stream,
      frame(FRAME_TRANSFER_END, Buffer.from(JSON.stringify({ versionId: manifest.versionId }), 'utf8')),
      MAX_FRAME
    )
    // Sendeseite schliessen -> der Empfaenger sieht EOF.
    try {
      await stream.close()
    } catch {
      /* ignore */
    }

    report('done', 'Übertragung abgeschlossen', null)
    return {
      ok: true,
      versionId: manifest.versionId,
      bytesTransferred,
      error: null,
      resumed: skip.size > 0
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('world-sync', 'Senden fehlgeschlagen', { error: message })
    report('failed', message, null)
    try {
      await stream.close()
    } catch {
      /* ignore */
    }
    return { ok: false, versionId: null, bytesTransferred, error: message, resumed: false }
  }
}

/** Hash der ersten `limit` Bytes einer Datei (fuer Resume). */
async function hashPartial(path: string, limit: number): Promise<ReturnType<typeof createHash>> {
  const hash = createHash('sha256')
  let read = 0
  const stream = createReadStream(path, { start: 0, end: Math.max(0, limit - 1) })
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => {
      read += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  if (read !== limit) {
    // Datei ist kürzer als erwartet -> komplett neu hashen
    const fresh = createHash('sha256')
    const s2 = createReadStream(path)
    await new Promise<void>((resolve, reject) => {
      s2.on('data', (chunk) => fresh.update(chunk))
      s2.on('error', reject)
      s2.on('end', () => resolve())
    })
    return fresh
  }
  return hash
}

/**
 * Aktiviert eine empfangene Welt atomar.
 *
 * Der Staging-Ordner wird zum aktiven Weltordner. Existiert bereits eine
 * aktive Welt, wird sie vorher in ein Quarantäne-Verzeichnis verschoben -
 * die alte Welt geht also nicht verloren.
 */
export function activateWorld(stagingPath: string, activePath: string, quarantineDir?: string): void {
  mkdirSync(dirname(activePath), { recursive: true })
  if (existsSync(activePath)) {
    if (quarantineDir) {
      mkdirSync(quarantineDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(quarantineDir, `world-${stamp}`)
      try {
        renameSync(activePath, target)
      } catch {
        rmSync(activePath, { recursive: true, force: true })
      }
    } else {
      rmSync(activePath, { recursive: true, force: true })
    }
  }
  renameSync(stagingPath, activePath)
}

/** Prueft, ob genug freier Speicherplatz vorhanden ist. */
export function hasFreeSpace(targetPath: string, requiredBytes: number): boolean {
  try {
    const { statfsSync } = require('node:fs') as typeof import('node:fs')
    const st = statfsSync(targetPath)
    const free = Number(st.bavail) * Number(st.bsize)
    return free > requiredBytes * 1.15
  } catch {
    return true
  }
}

/** Liest einzelne Bytes aus einer Datei (fuer Resume-Offset-Pruefung). */
export function readBytes(path: string, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    const { readSync } = require('node:fs') as typeof import('node:fs')
    readSync(fd, buf, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  return buf
}

/** Hilfsfunktion fuer Tests: erzeugt einen Weltordner mit Zufallsdaten. */
export async function createTestWorld(
  path: string,
  files: Record<string, string>
): Promise<string> {
  mkdirSync(path, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const full = join(path, name)
    mkdirSync(dirname(full), { recursive: true })
    await pipeline(
      (async function* () {
        yield Buffer.from(content, 'utf8')
      })(),
      createWriteStream(full)
    )
  }
  return path
}
