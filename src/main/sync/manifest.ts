import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, lstat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { WorldManifest, WorldManifestEntry } from '@shared/types'
import { canonicalize } from '@shared/protocol'

/**
 * Manifest einer Welt.
 *
 * Das Manifest ist die "Buchfuehrung" der Welt: fuer jede Datei werden
 * Groesse, Zeitstempel und SHA-256-Pruefsumme festgehalten. Die
 * versionId ergibt sich deterministisch aus dem Inhalt - zwei Nodes, die
 * dieselbe versionId melden, haben (bis auf Hash-Kollision) dieselbe Welt.
 */

/** Dateien, die nicht uebertragen werden (Locks, temporaere Dateien). */
const EXCLUDED_FILES = new Set(['session.lock'])
const EXCLUDED_DIRS = new Set(['cache', '.cache', 'tmp'])

/** Berechnet die SHA-256-Pruefsumme einer Datei. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/** Berechnet die SHA-256-Pruefsumme eines Buffers. */
export function hashBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface BuildManifestOptions {
  /** Weltverzeichnis. */
  worldPath: string
  /** Anzeigename der Welt. */
  worldName: string
  /** Minecraft-Version des Servers. */
  mcVersion: string
  /** DataVersion aus level.dat. */
  dataVersion: number
  /** Fortschritts-Callback. */
  onProgress?: (files: number, bytes: number) => void
}

/** Erzeugt das Manifest einer Welt. */
export async function buildManifest(opts: BuildManifestOptions): Promise<WorldManifest> {
  const entries: WorldManifestEntry[] = []
  let totalBytes = 0

  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const full = join(dir, item.name)
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) {
        if (EXCLUDED_DIRS.has(item.name)) continue
        await walk(full)
        continue
      }
      if (!item.isFile()) continue
      if (EXCLUDED_FILES.has(item.name)) continue
      const st = await stat(full)
      const rel = relative(opts.worldPath, full).split(sep).join('/')
      entries.push({
        path: rel,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        sha256: await hashFile(full)
      })
      totalBytes += st.size
    }
  }

  await walk(opts.worldPath)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    versionId: computeVersionId(entries),
    worldName: opts.worldName,
    mcVersion: opts.mcVersion,
    dataVersion: opts.dataVersion,
    createdAt: Date.now(),
    totalBytes,
    entryCount: entries.length,
    entries
  }
}

/** Berechnet die versionId aus den Manifest-Eintraegen (reihenfolgeunabhaengig). */
export function computeVersionId(entries: Array<{ path: string; size: number; sha256: string }>): string {
  const normalized = entries
    .map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return createHash('sha256').update(canonicalize(normalized)).digest('hex')
}

/** Prueft, ob eine Welt einem Manifest entspricht. */
export interface VerifyResult {
  ok: boolean
  problems: string[]
  /** Anteil der geprueften Dateien in Prozent. */
  checked: number
  total: number
}

export async function verifyWorld(
  worldPath: string,
  manifest: WorldManifest,
  onProgress?: (done: number, total: number) => void
): Promise<VerifyResult> {
  const problems: string[] = []
  let done = 0

  for (const entry of manifest.entries) {
    const full = join(worldPath, entry.path.split('/').join(sep))
    let st
    try {
      st = await lstat(full)
    } catch {
      problems.push(`Datei fehlt: ${entry.path}`)
      done++
      onProgress?.(done, manifest.entries.length)
      continue
    }
    if (!st.isFile()) {
      problems.push(`Kein regulärer Dateieintrag: ${entry.path}`)
      done++
      onProgress?.(done, manifest.entries.length)
      continue
    }
    if (st.size !== entry.size) {
      problems.push(
        `Größe weicht ab: ${entry.path} (erwartet ${entry.size}, gefunden ${st.size})`
      )
      done++
      onProgress?.(done, manifest.entries.length)
      continue
    }
    const hash = await hashFile(full)
    if (hash !== entry.sha256) {
      problems.push(`Prüfsumme weicht ab: ${entry.path}`)
    }
    done++
    onProgress?.(done, manifest.entries.length)
  }

  return { ok: problems.length === 0, problems, checked: done, total: manifest.entries.length }
}

/**
 * Vergleicht zwei Manifeste und liefert die Differenz.
 * Wird fuer inkrementelle Uebertragungen genutzt.
 */
export interface ManifestDiff {
  /** Dateien, die fehlen oder abweichen. */
  missing: WorldManifestEntry[]
  /** Dateien, die identisch sind. */
  identical: WorldManifestEntry[]
  /** Dateien, die nur in der Zielmenge vorhanden sind. */
  extra: string[]
}

export function diffManifests(
  source: WorldManifest,
  target: WorldManifest | null
): ManifestDiff {
  if (!target) {
    return { missing: source.entries, identical: [], extra: [] }
  }
  const targetMap = new Map(target.entries.map((e) => [e.path, e]))
  const missing: WorldManifestEntry[] = []
  const identical: WorldManifestEntry[] = []
  for (const entry of source.entries) {
    const other = targetMap.get(entry.path)
    if (other && other.sha256 === entry.sha256 && other.size === entry.size) {
      identical.push(entry)
    } else {
      missing.push(entry)
    }
  }
  const sourcePaths = new Set(source.entries.map((e) => e.path))
  const extra = target.entries.filter((e) => !sourcePaths.has(e.path)).map((e) => e.path)
  return { missing, identical, extra }
}

/** Erzeugt ein Manifest aus einer Liste von Dateigroessen (fuer Tests). */
export function manifestFromEntries(
  entries: Array<{ path: string; size: number; sha256: string }>,
  worldName = 'world',
  mcVersion = '1.20.4',
  dataVersion = 3700
): WorldManifest {
  return {
    versionId: computeVersionId(entries),
    worldName,
    mcVersion,
    dataVersion,
    createdAt: Date.now(),
    totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
    entryCount: entries.length,
    entries: entries.map((e) => ({ ...e, mtimeMs: 0 }))
  }
}
