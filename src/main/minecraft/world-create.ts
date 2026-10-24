import { createServer } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeRelative, PathGuardError } from '../security/path-guard'
import { cjsRequire } from '../core/cjs'
import { Paths } from '../core/paths'

/**
 * Eingangspruefungen fuer das direkte Erstellen neuer Minecraft-Welten.
 *
 * Bevor die eigentliche Generierung durch einen echten Server-Start
 * (Bootstrap-Run, siehe AppService.createWorld) passiert, wird hier bis zu dem
 * Punkt geprueft, der offline feststellbar ist:
 *  - Weltname gegen Pfad-Traversal und Windows-Eigenheiten
 *  - Seed-Format
 *  - Port-Verfuegbarkeit
 *  - Freier Speicherplatz
 *
 * Alle Pruefungen laufen VOR dem Server-JAR-Download, damit offensichtliche
 * Fehler nicht mit einer grossen Netzwerkaktion beantwortet werden.
 */

const MAX_NAME_LENGTH = 64
const MAX_SEED_LENGTH = 64

/** Mindestens 1 GiB freier Platz nach Generierungsbeginn. */
const MIN_FREE_BYTES = 1024 * 1024 * 1024

/**
 * Validiert einen Weltordnernamen und liefert ihn bereinigt zurueck.
 * Wirft Error mit verstaendlicher deutscher Meldung, wenn abgelehnt.
 */
export function validateWorldName(rawName: string): string {
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!name) {
    throw new Error('Der Weltpfad-Name fehlt. Bitte einen Namen für die Welt eintragen.')
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Der Weltname ist zu lang (maximal ${MAX_NAME_LENGTH} Zeichen).`)
  }
  if (/[\0\u0001-\u001f]/.test(name)) {
    throw new Error('Der Weltname enthält unzulässige Steuerzeichen.')
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Der Weltname darf keine Pfad- oder Trennzeichen ("/", "\\") enthalten. Bitte nur einen einzelnen Namen verwenden.')
  }
  if (name === '.' || name === '..') {
    throw new Error('Dieser Weltname ist nicht zulässig.')
  }
  // Erneute Systempruefung gegen reservierte Windows-Namen, Traversal,
  // Laufwerksbuchstaben usw. (defense in depth).
  try {
    normalizeRelative(name)
  } catch (err) {
    if (err instanceof PathGuardError) {
      throw new Error(pathGuardHint(err, name))
    }
    throw err
  }
  // Zulassungsliste: Buchstaben (alle Sprachen), Ziffern, Leerzeichen,
  // Unterstrich, Bindestrich und Punkt. Alles andere (z.B. `:` `*` `?` `"`,
  // `<` `>` `|`, Emojis mit Sonder-/Steuerzeichen) wird abgewiesen.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)) {
    throw new Error('Der Weltname darf nur Buchstaben, Zahlen, Leerzeichen sowie "_", "-" und "." enthalten und muss mit einem Buchstaben oder einer Zahl beginnen.')
  }
  return name
}

function pathGuardHint(err: PathGuardError, name: string): string {
  switch (err.code) {
    case 'RESERVED_NAME':
      return `Der Weltname "${name}" ist unter Windows reserviert und kann nicht verwendet werden.`
    case 'ABSOLUTE_PATH':
    case 'DRIVE_LETTER':
    case 'TRAVERSAL':
    case 'COLON':
      return 'Der Weltname darf keine Pfadangaben (Laufwerksbuchstaben, ":" oder "..") enthalten.'
    case 'WINDOWS_NAME':
      return 'Der Weltname darf nicht mit einem Punkt oder Leerzeichen enden.'
    case 'NULL_BYTE':
    case 'PATH_TOO_LONG':
      return 'Der Weltname enthält unzulässige Zeichen oder ist zu lang.'
    default:
      return `Der Weltname "${name}" ist nicht zulässig.`
  }
}

/**
 * Validiert einen optionalen Seed.
 * - leer (oder nur Leerraum): null -> Minecraft wuerfelt einen Zufalls-Seed
 * - sonst: bereinigt, nur druckbare ASCII-Zeichen, maximal 64 Zeichen
 * Wirft Error mit deutscher Meldung, wenn abgelehnt.
 */
export function validateSeed(rawSeed?: string): string | null {
  if (rawSeed === undefined || rawSeed === null) return null
  const seed = String(rawSeed).trim()
  if (!seed) return null
  if (seed.length > MAX_SEED_LENGTH) {
    throw new Error(`Der Seed ist zu lang (maximal ${MAX_SEED_LENGTH} Zeichen).`)
  }
  if (!/^[\x20-\x7e]+$/.test(seed)) {
    throw new Error('Der Seed darf nur sichtbare Zeichen (Buchstaben, Zahlen, Satzzeichen) enthalten.')
  }
  return seed
}

/**
 * Probe, ob ein TCP-Port frei angelegt werden kann. So schlaegt ein
 * Portkonflikt klar vor dem Start fehl, statt als dunkler Java-Fehler.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false)
      return
    }
    const probe = createServer()
    probe.once('error', () => {
      resolve(false)
    })
    probe.once('listening', () => {
      probe.close(() => resolve(true))
    })
    try {
      probe.listen({ port, host: '0.0.0.0', exclusive: true })
    } catch {
      resolve(false)
    }
  })
}

type StatfsResult = { bsize: number; bavail: number }

export interface DiskSpaceCheck {
  ok: boolean
  /** Freie Bytes, falls ermittelbar. */
  freeBytes: number | null
  error?: string
}

/**
 * Prueft den freien Speicherplatz auf dem Laufwerk von `dir`.
 * Falls das Betriebssystem keinen "statfs"-Zugriff erlaubt, liefert der
 * Check ok:true mit freeBytes:null (unbekannt statt blockierend).
 */
export function checkFreeDiskSpace(dir: string, minimumBytes = MIN_FREE_BYTES): DiskSpaceCheck {
  try {
    const fsMod = cjsRequire('node:fs') as typeof import('node:fs') & {
      statfsSync?: (path: string) => StatfsResult
    }
    if (typeof fsMod.statfsSync !== 'function') {
      return { ok: true, freeBytes: null }
    }
    mkdirSync(dir, { recursive: true })
    const st = fsMod.statfsSync(resolve(dir))
    const freeBytes = Number(st.bsize) * Number(st.bavail)
    if (!Number.isFinite(freeBytes) || freeBytes < 0) {
      return { ok: true, freeBytes: null }
    }
    if (freeBytes < minimumBytes) {
      return {
        ok: false,
        freeBytes,
        error:
          `Nicht genug Speicherplatz in "${dir}". Es sind ${(freeBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB frei, ` +
          `benötigt werden mindestens ${(minimumBytes / (1024 * 1024 * 1024)).toFixed(0)} GiB für die Weltgenerierung.`
      }
    }
    return { ok: true, freeBytes }
  } catch {
    /* statfs je nach Betriebssystem oder Einsatzkontext nicht moeglich -> unbekannt */
    return { ok: true, freeBytes: null }
  }
}

/** true, wenn der Ordner bereits existiert (Weltordner-Kollision). */
export function pathExists(target: string): boolean {
  return existsSync(target)
}
