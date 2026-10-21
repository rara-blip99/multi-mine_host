import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep, win32 } from 'node:path'

/**
 * Pfadschutz gegen Path Traversal und manipulierte Archivdateien.
 *
 * Grundregel: Jeder aus dem Netzwerk kommende Pfad ist ein *relativer*
 * POSIX-Pfad innerhalb eines explizit freigegebenen Basisverzeichnis.
 * Absolute Pfade, Laufwerksbuchstaben, UNC-Pfade, `..`-Segmente, Nullbytes
 * und reservierte Windows-Geraetennamen werden abgewiesen.
 */

export class PathGuardError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'PathGuardError'
  }
}

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/** Normalisiert einen Netzwerkpfad: '/' -> '\', keine fuehrenden/trailing Slashes. */
export function normalizeRelative(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PathGuardError('Pfad darf nicht leer sein', 'EMPTY_PATH')
  }
  if (input.includes('\0')) {
    throw new PathGuardError('Pfad enthaelt Nullbyte', 'NULL_BYTE')
  }
  if (input.length > 1024) {
    throw new PathGuardError('Pfad ist zu lang', 'PATH_TOO_LONG')
  }
  const unified = input.replace(/\//g, '\\')
  // Ein fuehrendes ".\" ist harmlos und wird entfernt.
  const withoutLeadingDot = unified.replace(/^\.\\/, '')
  if (isAbsolute(unified) || win32.isAbsolute(unified)) {
    throw new PathGuardError('Absolute Pfade sind nicht erlaubt', 'ABSOLUTE_PATH')
  }
  if (/^[a-zA-Z]:/.test(unified)) {
    throw new PathGuardError('Laufwerksbuchstaben sind nicht erlaubt', 'DRIVE_LETTER')
  }
  const segments = withoutLeadingDot.split('\\').filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new PathGuardError('Pfad enthaelt keine Segmente', 'EMPTY_PATH')
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new PathGuardError(`Verbotenes Pfadsegment: ${seg}`, 'TRAVERSAL')
    }
    if (seg.includes(':')) {
      throw new PathGuardError('Doppelpunkt in Pfadsegmenten ist nicht erlaubt', 'COLON')
    }
    if (WINDOWS_RESERVED.has(seg.toLowerCase().split('.')[0] ?? '')) {
      throw new PathGuardError(`Reservierter Windows-Name: ${seg}`, 'RESERVED_NAME')
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      throw new PathGuardError('Pfadsegmente duerfen nicht mit Punkt oder Leerzeichen enden', 'WINDOWS_NAME')
    }
  }
  return segments.join('/')
}

/**
 * Loest einen Netzwerkpfad innerhalb eines Basisverzeichnis auf.
 * Wirft PathGuardError, falls der Pfad das Basisverzeichnis verlassen wuerde.
 */
export function resolveWithin(baseDir: string, relativePath: string): string {
  const safe = normalizeRelative(relativePath)
  const base = resolve(baseDir)
  const target = resolve(base, safe.replace(/\//g, sep))
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathGuardError('Zielpfad liegt ausserhalb des freigegebenen Verzeichnisses', 'OUTSIDE_BASE')
  }
  return target
}

/**
 * Prueft zusaetzlich, dass der Pfad (inkl. Symlinks) nicht aus dem
 * Basisverzeichnis herausfuehrt. Wird nach dem Anlegen von Verzeichnissen
 * und vor dem Schreiben aufgerufen.
 */
export function assertRealPathWithin(baseDir: string, target: string): void {
  const base = resolve(baseDir)
  const realBase = existsSync(base) ? realpathSync(base) : base
  let realTarget = target
  try {
    if (existsSync(target)) realTarget = realpathSync(target)
  } catch {
    /* Ziel existiert noch nicht -> Elternverzeichnis pruefen */
    const parent = resolve(target, '..')
    if (existsSync(parent)) {
      try {
        realTarget = resolve(realpathSync(parent), target.split(sep).pop() ?? '')
      } catch {
        /* ignore */
      }
    }
  }
  const rel = relative(realBase, realTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathGuardError('Symlink-Ziel liegt ausserhalb des freigegebenen Verzeichnisses', 'SYMLINK_ESCAPE')
  }
}

/** Prueft, ob ein Pfad innerhalb von `baseDir` liegt. */
export function isWithin(baseDir: string, target: string): boolean {
  const base = resolve(baseDir)
  const rel = relative(base, resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Prueft ein aus einem Archiv extrahiertes Dateisystem auf "Zip-Bomben":
 * - Gesamtgroesse begrenzen
 * - Anzahl der Eintraege begrenzen
 */
export interface ArchiveLimits {
  maxEntries: number
  maxTotalBytes: number
  maxEntryBytes: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 200_000,
  maxTotalBytes: 64 * 1024 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024 * 1024
}

/**
 * Berechnet die Summe der regulaeren Dateigroessen eines Verzeichnisses.
 * Symlinks werden uebersprungen (kein Following), um Zyklen zu vermeiden.
 */
export async function directorySize(dir: string): Promise<number> {
  const { readdir, stat, lstat } = await import('node:fs/promises')
  let total = 0
  const walk = async (current: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          const s = await stat(full)
          total += s.size
        } catch {
          /* Datei vanished */
        }
      }
    }
  }
  await walk(dir)
  return total
}

/** Normalisiert einen Pfad fuer Vergleiche (Windows: case-insensitive). */
export function pathKey(p: string): string {
  const n = normalize(p).toLowerCase()
  return n.endsWith(sep) ? n.slice(0, -1) : n
}
