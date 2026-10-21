import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { logger } from '../core/logger'
import type { ReleaseAsset, UpdateInfo } from '@shared/types'

export type { ReleaseAsset, UpdateInfo }

/**
 * Update-Manager.
 *
 * Der Manager prueft, ob eine neuere Version auf GitHub verfuegbar ist, und
 * laedt sie auf Wunsch herunter. Sicherheitsregeln:
 *
 *  - Es wird ausschliesslich die offizielle Release-API des Projekts
 *    abgefragt.
 *  - Ein Download wird nur angeboten, wenn fuer die Datei eine SHA-256
 *    Pruefsumme im Release hinterlegt ist. Ohne Pruefsumme wird nichts
 *    installiert.
 *  - Die Anwendung wird **nicht** selbststaendig neu gestartet oder
 *    ersetzt. Der Benutzer entscheidet, wann der Installer ausgefuehrt wird.
 */

export interface GitHubRelease {
  tagName: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  publishedAt: string
  htmlUrl: string
  assets: ReleaseAsset[]
}

export interface UpdateManagerOptions {
  /** Repository, z. B. "rara-blip99/multi-mine_host". */
  repository: string
  /** Aktuelle Version der Anwendung. */
  currentVersion: string
  /** Verzeichnis fuer heruntergeladene Updates. */
  downloadDir: string
  /** GitHub-API-Basis (fuer Tests ueberschreibbar). */
  apiBase?: string
}

export class UpdateManager {
  constructor(private readonly opts: UpdateManagerOptions) {
    mkdirSync(this.opts.downloadDir, { recursive: true })
  }

  private get apiBase(): string {
    return this.opts.apiBase ?? 'https://api.github.com'
  }

  /** Prueft, ob eine neuere Version verfuegbar ist. */
  async check(): Promise<UpdateInfo> {
    const base: UpdateInfo = {
      currentVersion: this.opts.currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      notes: null,
      publishedAt: null,
      assets: [],
      error: null
    }

    try {
      const release = await this.fetchLatestRelease()
      if (!release) {
        base.error = 'Kein Release gefunden'
        return base
      }
      base.latestVersion = release.tagName.replace(/^v/, '')
      base.releaseUrl = release.htmlUrl
      base.notes = release.body
      base.publishedAt = release.publishedAt
      base.assets = release.assets
      base.updateAvailable = compareVersions(base.latestVersion, this.opts.currentVersion) > 0
      return base
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('update', 'Updateprüfung fehlgeschlagen', { error: message })
      base.error = message
      return base
    }
  }

  private async fetchLatestRelease(): Promise<GitHubRelease | null> {
    const url = `${this.apiBase}/repos/${this.opts.repository}/releases/latest`
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'multi-mine-host'
      },
      signal: AbortSignal.timeout(20_000)
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GitHub-API antwortete mit HTTP ${res.status}`)
    return (await res.json()) as GitHubRelease
  }

  /**
   * Laedt eine Release-Datei herunter und prueft ihre SHA-256.
   *
   * Ohne hinterlegte Pruefsumme wird der Download abgebrochen - es wird
   * niemals eine ungeprueft Datei aus dem Internet angenommen.
   */
  async download(
    assetName: string,
    expectedSha256: string,
    onProgress?: (received: number, total: number) => void
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
      return { ok: false, error: 'Ungültige Prüfsumme - Download abgebrochen' }
    }

    const release = await this.fetchLatestRelease()
    const asset = release?.assets.find((a) => a.name === assetName)
    if (!asset) {
      return { ok: false, error: `Datei ${assetName} ist im Release nicht enthalten` }
    }

    const target = join(this.opts.downloadDir, assetName)
    const tmp = `${target}.part`
    try {
      const res = await fetch(asset.browserDownloadUrl, {
        signal: AbortSignal.timeout(10 * 60_000)
      })
      if (!res.ok || !res.body) {
        return { ok: false, error: `Download fehlgeschlagen (HTTP ${res.status})` }
      }
      const total = Number(res.headers.get('content-length') ?? asset.size)
      let received = 0
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      source.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress?.(received, total)
      })
      await pipeline(source, createWriteStream(tmp))

      const hash = createHash('sha256')
      hash.update(readFileSync(tmp))
      const digest = hash.digest('hex')
      if (digest.toLowerCase() !== expectedSha256.toLowerCase()) {
        rmSync(tmp, { force: true })
        return { ok: false, error: 'Prüfsumme der heruntergeladenen Datei stimmt nicht' }
      }

      renameSync(tmp, target)
      logger.info('update', 'Update heruntergeladen und geprüft', { asset: assetName })
      return { ok: true, path: target }
    } catch (err) {
      try {
        if (existsSync(tmp)) rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Bereits heruntergeladene Updates auflisten. */
  listDownloaded(): Array<{ name: string; sizeBytes: number; path: string }> {
    if (!existsSync(this.opts.downloadDir)) return []
    return readdirSync(this.opts.downloadDir)
      .filter((f) => !f.endsWith('.part'))
      .map((name) => {
        const path = join(this.opts.downloadDir, name)
        return { name, sizeBytes: statSync(path).size, path }
      })
  }
}

/**
 * Vergleicht zwei semantische Versionen.
 * Fehlende Teile werden als 0 behandelt ("1.2" == "1.2.0").
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va > vb ? 1 : -1
  }
  return 0
}
