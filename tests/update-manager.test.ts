import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { UpdateManager, compareVersions } from '../src/main/update/update-manager'

/**
 * Tests fuer den Update-Manager.
 *
 * Geprueft wird gegen einen lokalen HTTP-Server, der die GitHub-API
 * nachbildet - so wird kein echter Internetzugriff benoetigt.
 */

describe('Versionsvergleich', () => {
  it('erkennt neuere Versionen', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
  })

  it('erkennt ältere und gleiche Versionen', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })
})

interface FakeRelease {
  tagName: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  publishedAt: string
  htmlUrl: string
  assets: Array<{
    name: string
    size: number
    browserDownloadUrl: string
    contentType: string
  }>
}

async function startFakeGitHub(
  releaseFactory: (base: string) => FakeRelease,
  assets: Record<string, { body: Buffer; type: string }> = {}
): Promise<{ server: Server; base: string }> {
  let release: FakeRelease | null = null
  const server = createServer((req, res) => {
    if (req.url?.includes('/releases/latest')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(release))
      return
    }
    for (const [name, asset] of Object.entries(assets)) {
      if (req.url?.endsWith(name)) {
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Content-Length': String(asset.body.length)
        })
        res.end(asset.body)
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  release = releaseFactory(base)
  return { server, base }
}

function makeRelease(
  base: string,
  tag: string,
  assets: FakeRelease['assets'] = [],
  body = ''
): FakeRelease {
  return {
    tagName: tag,
    name: `Version ${tag}`,
    body,
    draft: false,
    prerelease: false,
    publishedAt: '2026-01-01T00:00:00Z',
    htmlUrl: `${base}/releases/${tag}`,
    assets
  }
}

describe('Update-Manager', () => {
  it('meldet ein verfügbares Update', async () => {
    const { server, base } = await startFakeGitHub((b) =>
      makeRelease(
        b,
        'v2.0.0',
        [
          {
            name: 'Multi-Mine-Setup-2.0.0.exe',
            size: 3,
            browserDownloadUrl: `${b}/Multi-Mine-Setup-2.0.0.exe`,
            contentType: 'application/octet-stream'
          }
        ],
        'Große Neuigkeiten'
      )
    )
    const dir = mkdtempSync(join(tmpdir(), 'mmh-update-'))
    try {
      const manager = new UpdateManager({
        repository: 'test/test',
        currentVersion: '1.0.0',
        downloadDir: dir,
        apiBase: base
      })
      const info = await manager.check()
      expect(info.updateAvailable).toBe(true)
      expect(info.latestVersion).toBe('2.0.0')
      expect(info.currentVersion).toBe('1.0.0')
      expect(info.notes).toBe('Große Neuigkeiten')
      expect(info.assets.length).toBe(1)
      expect(info.error).toBeNull()
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('meldet kein Update bei gleicher Version', async () => {
    const { server, base } = await startFakeGitHub((b) => makeRelease(b, 'v1.0.0'))
    const dir = mkdtempSync(join(tmpdir(), 'mmh-update-'))
    try {
      const manager = new UpdateManager({
        repository: 'test/test',
        currentVersion: '1.0.0',
        downloadDir: dir,
        apiBase: base
      })
      const info = await manager.check()
      expect(info.updateAvailable).toBe(false)
      expect(info.latestVersion).toBe('1.0.0')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lädt ein Update herunter und prüft die Prüfsumme', async () => {
    const content = Buffer.from('Installer-Inhalt')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const { server, base } = await startFakeGitHub(
      (b) =>
        makeRelease(b, 'v2.0.0', [
          {
            name: 'setup.exe',
            size: content.length,
            browserDownloadUrl: `${b}/setup.exe`,
            contentType: 'application/octet-stream'
          }
        ]),
      { 'setup.exe': { body: content, type: 'application/octet-stream' } }
    )
    const dir = mkdtempSync(join(tmpdir(), 'mmh-update-'))
    try {
      const manager = new UpdateManager({
        repository: 'test/test',
        currentVersion: '1.0.0',
        downloadDir: dir,
        apiBase: base
      })
      const result = await manager.download('setup.exe', sha256)
      expect(result.ok).toBe(true)
      expect(result.path).toBeDefined()
      expect(existsSync(result.path as string)).toBe(true)

      const downloaded = manager.listDownloaded()
      expect(downloaded.length).toBe(1)
      expect(downloaded[0]?.name).toBe('setup.exe')
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verweigert den Download bei falscher Prüfsumme', async () => {
    const content = Buffer.from('Installer-Inhalt')
    const { server, base } = await startFakeGitHub(
      (b) =>
        makeRelease(b, 'v2.0.0', [
          {
            name: 'setup.exe',
            size: content.length,
            browserDownloadUrl: `${b}/setup.exe`,
            contentType: 'application/octet-stream'
          }
        ]),
      { 'setup.exe': { body: content, type: 'application/octet-stream' } }
    )
    const dir = mkdtempSync(join(tmpdir(), 'mmh-update-'))
    try {
      const manager = new UpdateManager({
        repository: 'test/test',
        currentVersion: '1.0.0',
        downloadDir: dir,
        apiBase: base
      })
      const result = await manager.download('setup.exe', 'a'.repeat(64))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Prüfsumme')
      // Die fehlerhafte Datei darf nicht liegen bleiben
      expect(manager.listDownloaded().length).toBe(0)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verweigert den Download ohne gültige Prüfsumme', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-update-'))
    try {
      const manager = new UpdateManager({
        repository: 'test/test',
        currentVersion: '1.0.0',
        downloadDir: dir,
        apiBase: 'http://127.0.0.1:1'
      })
      const result = await manager.download('setup.exe', 'keine-pruefsumme')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Prüfsumme')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('meldet Fehler bei nicht erreichbarer API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-update-'))
    try {
      const manager = new UpdateManager({
        repository: 'test/test',
        currentVersion: '1.0.0',
        downloadDir: dir,
        apiBase: 'http://127.0.0.1:1'
      })
      const info = await manager.check()
      expect(info.error).not.toBeNull()
      expect(info.updateAvailable).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
