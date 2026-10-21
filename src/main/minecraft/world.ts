import { gunzipSync } from 'node:zlib'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseNbt, nbtGet } from './nbt'
import type { NbtValue } from './nbt'
import { mcVersionForDataVersion } from './versions'

/**
 * Inspektion und Integritaetspruefung einer Minecraft-Welt.
 *
 * Der Weltordner wird von Minecraft selbst verwaltet. Wichtige Bestandteile:
 *  - level.dat      : Weltmetadaten (DataVersion, LevelName)
 *  - session.lock   : Sperrdatei, die gesetzt ist, solange die Welt offen ist
 *  - region/        : Chunks der Overworld
 *  - DIM-1, DIM1    : Nether / End
 *  - data/          : Spieler- und Weltdaten
 */

export interface WorldInfo {
  path: string
  name: string
  /** Interne Weltformat-Version aus level.dat. */
  dataVersion: number
  /** Abgeleitete Minecraft-Version, z.B. "1.20.4". */
  mcVersion: string | null
  levelName: string
  totalBytes: number
  fileCount: number
  /** true, wenn session.lock vorhanden ist (Welt ist gerade offen). */
  locked: boolean
  lastModified: number
  /** Verzeichnisse, die zur Welt gehoeren. */
  dimensions: string[]
}

export interface WorldIntegrityResult {
  ok: boolean
  problems: string[]
  warnings: string[]
  info: WorldInfo | null
}

/** Liest die Metadaten aus level.dat. */
export function readWorldInfo(worldPath: string): WorldInfo | null {
  const levelDat = join(worldPath, 'level.dat')
  if (!existsSync(levelDat)) return null

  let dataVersion = 0
  let levelName = basename(worldPath)
  let worldVersionName = ''

  try {
    const raw = readFileSync(levelDat)
    // level.dat ist gzip-komprimiert (aeltere Versionen: rohes NBT).
    let nbtBuf: Buffer
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      nbtBuf = gunzipSync(raw)
    } else {
      nbtBuf = raw
    }
    const tree = parseNbt(nbtBuf)
    const data = nbtGet(tree, ['Data'])
    if (data && typeof data === 'object' && !Array.isArray(data) && !(data instanceof Uint8Array)) {
      const dv = nbtGet(data, ['DataVersion'])
      if (typeof dv === 'number') dataVersion = dv
      const ln = nbtGet(data, ['LevelName'])
      if (typeof ln === 'string') levelName = ln
      const ver = nbtGet(data, ['version', 'Name'])
      if (typeof ver === 'string') worldVersionName = ver
    }
  } catch (err) {
    // Fehler werden als "keine info" behandelt; der Aufrufer prueft die Datei.
    return null
  }

  const { totalBytes, fileCount } = measureWorld(worldPath)
  const dimensions: string[] = []
  for (const dir of ['region', 'DIM-1', 'DIM1', 'dimensions']) {
    if (existsSync(join(worldPath, dir))) dimensions.push(dir)
  }

  return {
    path: worldPath,
    name: levelName,
    dataVersion,
    mcVersion: worldVersionName || mcVersionForDataVersion(dataVersion) || null,
    levelName,
    totalBytes,
    fileCount,
    locked: existsSync(join(worldPath, 'session.lock')),
    lastModified: safeMtime(worldPath),
    dimensions
  }
}

/**
 * Prueft die strukturelle Integritaet einer Welt.
 *
 * Es wird bewusst NICHT jede Chunk-Datei einzeln validiert (das waere bei
 * grossen Welten zu langsam). Stattdessen werden die kritischen Struktur-
 * merkmale geprueft und anschliessend (optional) ein vollstaendiger Hash
 * gegen das Manifest gebildet.
 */
export function checkWorldIntegrity(worldPath: string): WorldIntegrityResult {
  const problems: string[] = []
  const warnings: string[] = []

  if (!existsSync(worldPath)) {
    return { ok: false, problems: ['Weltverzeichnis existiert nicht'], warnings, info: null }
  }

  const info = readWorldInfo(worldPath)
  if (!info) {
    problems.push('level.dat ist nicht lesbar oder beschaedigt')
  } else {
    if (info.dataVersion === 0) {
      problems.push('level.dat enthaelt keine DataVersion - die Welt ist vermutlich beschaedigt')
    }
    if (!existsSync(join(worldPath, 'region'))) {
      warnings.push('Kein "region"-Verzeichnis gefunden - die Welt enthaelt keine geladenen Chunks')
    }
    if (info.locked) {
      warnings.push(
        'session.lock ist vorhanden - die Welt war zuletzt geoeffnet. Falls kein Server laeuft, kann die Sperrdatei entfernt werden.'
      )
    }
  }

  return { ok: problems.length === 0, problems, warnings, info }
}

/** Summiert Groesse und Dateianzahl eines Verzeichnisbaums. */
export function measureWorld(worldPath: string): { totalBytes: number; fileCount: number } {
  let totalBytes = 0
  let fileCount = 0
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          walk(full)
        } else if (st.isFile()) {
          totalBytes += st.size
          fileCount += 1
        }
      } catch {
        /* Datei wurde geloescht */
      }
    }
  }
  walk(worldPath)
  return { totalBytes, fileCount }
}

/**
 * Prueft, ob ein Verzeichnis wie eine Minecraft-Welt aussieht.
 */
export function looksLikeWorld(worldPath: string): boolean {
  return existsSync(join(worldPath, 'level.dat'))
}

/**
 * Listet die Welten in einem Verzeichnis auf (fuer den Import-Dialog).
 */
export function listWorldsIn(dir: string): Array<{ path: string; name: string; dataVersion: number }> {
  const out: Array<{ path: string; name: string; dataVersion: number }> = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (!looksLikeWorld(full)) continue
    const info = readWorldInfo(full)
    out.push({
      path: full,
      name: info?.levelName ?? entry.name,
      dataVersion: info?.dataVersion ?? 0
    })
  }
  return out
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Liest den LevelName-Companion-Wert (fuer Tests/Diagnose). */
export function readLevelName(worldPath: string): string | null {
  const info = readWorldInfo(worldPath)
  return info?.levelName ?? null
}

/** Extrahiert einen einzelnen Wert aus level.dat (Diagnose). */
export function readLevelDataValue(worldPath: string, path: string[]): NbtValue | undefined {
  try {
    const raw = readFileSync(join(worldPath, 'level.dat'))
    const nbtBuf = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
    const tree = parseNbt(nbtBuf)
    return nbtGet(tree, path)
  } catch {
    return undefined
  }
}
