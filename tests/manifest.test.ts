import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildManifest, computeVersionId, diffManifests, hashFile, verifyWorld } from '../src/main/sync/manifest'

/**
 * Tests fuer das Welt-Manifest (Pruefsummen, Versionierung, Diffs).
 */
describe('Welt-Manifest', () => {
  it('erzeugt ein Manifest mit Prüfsummen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    try {
      mkdirSync(join(dir, 'region'), { recursive: true })
      writeFileSync(join(dir, 'level.dat'), 'LEVEL')
      writeFileSync(join(dir, 'region', 'r.0.0.mca'), 'CHUNK')

      const manifest = await buildManifest({
        worldPath: dir,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      expect(manifest.entries.length).toBe(2)
      expect(manifest.entryCount).toBe(2)
      expect(manifest.totalBytes).toBe(5 + 5)
      for (const e of manifest.entries) {
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(manifest.versionId).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('schließt session.lock aus', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    try {
      writeFileSync(join(dir, 'level.dat'), 'LEVEL')
      writeFileSync(join(dir, 'session.lock'), 'LOCK')
      const manifest = await buildManifest({
        worldPath: dir,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      expect(manifest.entries.map((e) => e.path)).not.toContain('session.lock')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('erzeugt bei identischem Inhalt dieselbe versionId', async () => {
    const a = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    const b = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    try {
      writeFileSync(join(a, 'level.dat'), 'LEVEL')
      writeFileSync(join(b, 'level.dat'), 'LEVEL')
      const ma = await buildManifest({
        worldPath: a,
        worldName: 'w',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const mb = await buildManifest({
        worldPath: b,
        worldName: 'w',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      expect(ma.versionId).toBe(mb.versionId)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('erkennt beschädigte Dateien bei der Verifikation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    try {
      writeFileSync(join(dir, 'level.dat'), 'LEVEL')
      writeFileSync(join(dir, 'data.bin'), 'INHALT')
      const manifest = await buildManifest({
        worldPath: dir,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      // Datei nachtraeglich veraendern
      writeFileSync(join(dir, 'data.bin'), 'KAPUTT')

      const result = await verifyWorld(dir, manifest)
      expect(result.ok).toBe(false)
      expect(result.problems.some((p) => p.includes('data.bin'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('meldet fehlende Dateien', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    try {
      writeFileSync(join(dir, 'level.dat'), 'LEVEL')
      const manifest = await buildManifest({
        worldPath: dir,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      rmSync(join(dir, 'level.dat'))
      const result = await verifyWorld(dir, manifest)
      expect(result.ok).toBe(false)
      expect(result.problems.some((p) => p.includes('fehlt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('erklaert eine korrekte Welt als fehlerfrei', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-manifest-'))
    try {
      writeFileSync(join(dir, 'level.dat'), 'LEVEL')
      const manifest = await buildManifest({
        worldPath: dir,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const result = await verifyWorld(dir, manifest)
      expect(result.ok).toBe(true)
      expect(result.problems).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('berechnet inkrementelle Unterschiede', () => {
    const a = {
      versionId: 'v1',
      worldName: 'w',
      mcVersion: '1.20.4',
      dataVersion: 3700,
      createdAt: 0,
      totalBytes: 30,
      entryCount: 3,
      entries: [
        { path: 'a', size: 10, mtimeMs: 0, sha256: 'h1' },
        { path: 'b', size: 10, mtimeMs: 0, sha256: 'h2' },
        { path: 'c', size: 10, mtimeMs: 0, sha256: 'h3' }
      ]
    }
    const b = {
      ...a,
      entries: [
        { path: 'a', size: 10, mtimeMs: 0, sha256: 'h1' },
        { path: 'b', size: 12, mtimeMs: 0, sha256: 'anders' },
        { path: 'd', size: 10, mtimeMs: 0, sha256: 'h4' }
      ]
    }
    const diff = diffManifests(a, b)
    expect(diff.identical.map((e) => e.path)).toEqual(['a'])
    expect(diff.missing.map((e) => e.path).sort()).toEqual(['b', 'c'])
    expect(diff.extra).toEqual(['d'])
  })

  it('berechnet die versionId deterministisch', () => {
    const v1 = computeVersionId([
      { path: 'a', size: 1, sha256: 'x' },
      { path: 'b', size: 2, sha256: 'y' }
    ])
    const v2 = computeVersionId([
      { path: 'b', size: 2, sha256: 'y' },
      { path: 'a', size: 1, sha256: 'x' }
    ])
    expect(v1).toBe(v2)
  })

  it('hashet Dateien korrekt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-hash-'))
    try {
      const file = join(dir, 'x.bin')
      writeFileSync(file, 'Hallo Welt')
      const hash = await hashFile(file)
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      expect(hash).toBe(
        require('node:crypto').createHash('sha256').update('Hallo Welt').digest('hex')
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
