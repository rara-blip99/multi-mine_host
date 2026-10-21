import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BackupManager } from '../src/main/backup/backup-manager'
import { buildManifest } from '../src/main/sync/manifest'

function makeWorld(dir: string): void {
  mkdirSync(join(dir, 'region'), { recursive: true })
  writeFileSync(join(dir, 'level.dat'), 'LEVELDAT')
  writeFileSync(join(dir, 'region', 'r.0.0.mca'), 'CHUNK')
}

describe('Backup-Manager', () => {
  it('erstellt ein Backup mit Prüfsumme und Metadaten', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      const backups = join(root, 'backups')
      mkdirSync(world, { recursive: true })
      makeWorld(world)

      const manager = new BackupManager({ backupsDir: backups, retention: 5 })
      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      const result = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.info.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.info.sizeBytes).toBeGreaterThan(0)
      expect(result.info.worldVersionId).toBe(manifest.versionId)
      expect(existsSync(result.info.path)).toBe(true)
      expect(manager.list().length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('erkennt ein beschädigtes Backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      mkdirSync(world, { recursive: true })
      makeWorld(world)

      const manager = new BackupManager({ backupsDir: join(root, 'backups'), retention: 5 })
      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const result = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // Archiv mit Zufallsdaten überschreiben
      writeFileSync(result.info.path, 'KAPUTTES ARCHIV')

      const verification = await manager.verify(result.info)
      expect(verification.ok).toBe(false)
      expect(verification.problems.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stellt ein Backup wieder her und verschiebt die alte Welt in die Quarantäne', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      const quarantine = join(root, 'quarantine')
      mkdirSync(world, { recursive: true })
      makeWorld(world)

      const manager = new BackupManager({
        backupsDir: join(root, 'backups'),
        retention: 5,
        quarantineDir: quarantine
      })
      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const result = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // Welt verändern
      writeFileSync(join(world, 'level.dat'), 'VERAENDERT')

      const restored = await manager.restore(result.info, world)
      expect(restored.ok).toBe(true)
      expect(readFileSync(join(world, 'level.dat'), 'utf8')).toBe('LEVELDAT')
      expect(existsSync(quarantine)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('verweigert die Wiederherstellung eines beschädigten Backups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      mkdirSync(world, { recursive: true })
      makeWorld(world)

      const manager = new BackupManager({ backupsDir: join(root, 'backups'), retention: 5 })
      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const result = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })
      if (!result.ok) throw new Error('Backup-Erstellung fehlgeschlagen')

      writeFileSync(result.info.path, 'KAPUTT')

      const restored = await manager.restore(result.info, world)
      expect(restored.ok).toBe(false)
      expect(restored.error).toContain('beschädigt')
      // Die aktive Welt ist unangetastet
      expect(readFileSync(join(world, 'level.dat'), 'utf8')).toBe('LEVELDAT')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('wendet die Aufbewahrungsregel an und behält das letzte gültige Backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      mkdirSync(world, { recursive: true })
      makeWorld(world)

      const manager = new BackupManager({ backupsDir: join(root, 'backups'), retention: 2 })
      const created: string[] = []
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(world, 'counter'), `stand-${i}`)
        const manifest = await buildManifest({
          worldPath: world,
          worldName: 'test',
          mcVersion: '1.20.4',
          dataVersion: 3700
        })
        const result = await manager.createBackup('auto', {
          worldPath: world,
          manifest,
          worldVersionId: manifest.versionId,
          mcVersion: '1.20.4',
          dataVersion: 3700,
          worldName: 'test'
        })
        expect(result.ok).toBe(true)
        if (result.ok) created.push(result.info.id)
        await new Promise((r) => setTimeout(r, 5))
      }

      const list = manager.list()
      expect(list.length).toBeLessThanOrEqual(2)
      expect(list.length).toBeGreaterThanOrEqual(1)
      // Das neueste Backup ist immer noch vorhanden
      expect(list.some((b) => b.id === created[created.length - 1])).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('schützt Backups, die zur Wiederherstellung benötigt werden', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      mkdirSync(world, { recursive: true })
      makeWorld(world)
      const manager = new BackupManager({ backupsDir: join(root, 'backups'), retention: 1 })

      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const first = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return

      await manager.applyRetention()
      expect(existsSync(first.info.path)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('repliziert ein Backup in ein anderes Verzeichnis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      mkdirSync(world, { recursive: true })
      makeWorld(world)
      const manager = new BackupManager({ backupsDir: join(root, 'backups'), retention: 5 })
      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const result = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const target = join(root, 'replica')
      const replication = await manager.replicate(result.info, target)
      expect(replication.ok).toBe(true)
      expect(existsSync(join(target, `${result.info.id}.tar.gz`))).toBe(true)

      const meta = manager.readMeta(join(target, `${result.info.id}.tar.gz`))
      expect(meta?.replicated).toBe(true)
      expect(meta?.sha256).toBe(result.info.sha256)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lehnt Backups ab, die das Größenlimit überschreiten', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const world = join(root, 'world')
      mkdirSync(world, { recursive: true })
      makeWorld(world)
      const manager = new BackupManager({
        backupsDir: join(root, 'backups'),
        retention: 5,
        maxSizeBytes: 1
      })
      const manifest = await buildManifest({
        worldPath: world,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })
      const result = await manager.createBackup('manual', {
        worldPath: world,
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'test'
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('TOO_LARGE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('meldet fehlende Weltverzeichnisse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-backup-'))
    try {
      const manager = new BackupManager({ backupsDir: join(root, 'backups'), retention: 5 })
      const result = await manager.createBackup('manual', {
        worldPath: join(root, 'gibtsnicht'),
        manifest: {
          versionId: 'v',
          worldName: 'w',
          mcVersion: '1.20.4',
          dataVersion: 3700,
          createdAt: Date.now(),
          totalBytes: 0,
          entryCount: 0,
          entries: []
        },
        worldVersionId: 'v',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        worldName: 'w'
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('NO_WORLD')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
