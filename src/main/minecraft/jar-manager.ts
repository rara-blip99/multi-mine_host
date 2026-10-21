import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Paths } from '../core/paths'
import { logger } from '../core/logger'

/**
 * Verwaltung der Minecraft-Server-JAR.
 *
 * Standard ist Paper (Fork von Spigot/CraftBukkit) wegen Performance,
 * Plugin-Unterstuetzung und der Faehigkeit, die Welt kontrolliert zu
 * speichern (`save-all flush`).
 *
 * Der Download wird immer gegen die vom Anbieter veroeffentlichte SHA-256
 * -Pruefsumme verifiziert.
 */

const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'

export interface PaperBuild {
  id: number
  time: string
  channel: string
  downloads: {
    'server:default': { name: string; checksums: { sha256: string }; size: number; url: string }
  }
}

export interface JarInfo {
  path: string
  version: string
  build: number
  sha256: string
  sizeBytes: number
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} bei ${url}`)
  }
  return (await res.json()) as T
}

/** Ermittelt den neuesten verfuegbaren Paper-Build fuer eine Version. */
export async function resolvePaperBuild(version: string): Promise<PaperBuild> {
  const url = `${PAPER_API}/versions/${encodeURIComponent(version)}/builds/latest`
  const build = await fetchJson<PaperBuild>(url)
  if (!build?.downloads?.['server:default']?.url) {
    throw new Error(`Kein Server-Build für Minecraft ${version} verfügbar`)
  }
  return build
}

/** Prueft, welche Minecraft-Versionen ueber Paper verfuegbar sind. */
export async function listPaperVersions(): Promise<string[]> {
  try {
    const data = await fetchJson<{ versions: string[] }>(`${PAPER_API}/versions`)
    return data.versions ?? []
  } catch (err) {
    logger.warn('jar-manager', 'Paper-Versionen konnten nicht geladen werden', { error: String(err) })
    return []
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

/**
 * Stellt sicher, dass die passende Server-JAR lokal vorhanden ist.
 * Heruntergeladen wird nur, wenn die Datei fehlt oder die Pruefsumme
 * abweicht.
 */
export async function ensurePaperJar(
  version: string,
  onProgress?: (received: number, total: number) => void
): Promise<JarInfo> {
  const build = await resolvePaperBuild(version)
  const download = build.downloads['server:default']
  const target = join(Paths.serverJars(), `paper-${version}-${build.id}.jar`)

  if (existsSync(target)) {
    try {
      const actual = sha256File(target)
      if (actual === download.checksums.sha256) {
        logger.info('jar-manager', 'Server-JAR bereits vorhanden', { version, build: build.id })
        return {
          path: target,
          version,
          build: build.id,
          sha256: actual,
          sizeBytes: statSync(target).size
        }
      }
      logger.warn('jar-manager', 'Prüfsumme der vorhandenen JAR weicht ab - erneuter Download', {
        version,
        build: build.id
      })
    } catch (err) {
      logger.warn('jar-manager', 'Vorhandene JAR nicht lesbar - erneuter Download', {
        error: String(err)
      })
    }
  }

  mkdirSync(Paths.serverJars(), { recursive: true })
  logger.info('jar-manager', 'Lade Server-JAR herunter', { version, build: build.id })

  const res = await fetch(download.url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok || !res.body) {
    throw new Error(`Download der Server-JAR fehlgeschlagen (HTTP ${res.status})`)
  }
  const tmp = `${target}.part`
  const contentLength = Number(res.headers.get('content-length') ?? download.size ?? 0)
  let received = 0

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.(received, contentLength)
  })
  await pipeline(source, createWriteStream(tmp))

  const actual = sha256File(tmp)
  if (actual !== download.checksums.sha256) {
    const { unlinkSync } = require('node:fs') as typeof import('node:fs')
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw new Error(
      `Prüfsumme der heruntergeladenen JAR stimmt nicht (erwartet ${download.checksums.sha256}, erhalten ${actual})`
    )
  }

  const { renameSync } = require('node:fs') as typeof import('node:fs')
  renameSync(tmp, target)
  logger.info('jar-manager', 'Server-JAR erfolgreich heruntergeladen', { version, build: build.id })
  return {
    path: target,
    version,
    build: build.id,
    sha256: actual,
    sizeBytes: statSync(target).size
  }
}

/** Listet lokal vorhandene Server-JARs. */
export function listLocalJars(): JarInfo[] {
  const dir = Paths.serverJars()
  if (!existsSync(dir)) return []
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  const out: JarInfo[] = []
  for (const file of readdirSync(dir)) {
    const match = /^paper-(.+)-(\d+)\.jar$/.exec(file)
    if (!match) continue
    const full = join(dir, file)
    out.push({
      path: full,
      version: match[1] ?? '',
      build: Number(match[2] ?? 0),
      sha256: '',
      sizeBytes: statSync(full).size
    })
  }
  return out
}
