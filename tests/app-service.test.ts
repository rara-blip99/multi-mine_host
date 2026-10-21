import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { AppService } from '../src/main/app-service'
import { Paths } from '../src/main/core/paths'
import { IdentityStore } from '../src/main/security/identity'
import { MinecraftServerManager } from '../src/main/minecraft/server-manager'

/**
 * Rauchtest der Anwendungsschicht (ohne Electron-Fenster).
 *
 * Geprueft wird der reale Ablauf: Anwendung starten, Welt importieren,
 * Integritaet pruefen, Backup erstellen, Backup wiederherstellen.
 */

const roots: string[] = []

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mmh-app-'))
  roots.push(dir)
  return dir
}

/** Erzeugt eine minimal gueltige Minecraft-Welt (level.dat + region). */
function createWorld(path: string, dataVersion = 3700): void {
  mkdirSync(join(path, 'region'), { recursive: true })
  // level.dat als gzip-komprimiertes NBT mit der gewuenschten DataVersion
  const parts: Buffer[] = []
  const str = (s: string): Buffer => {
    const data = Buffer.from(s, 'utf8')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(data.length)
    return Buffer.concat([len, data])
  }
  parts.push(Buffer.from([0x0a]), str(''))
  parts.push(Buffer.from([0x0a]), str('Data'))
  parts.push(Buffer.from([0x03]), str('DataVersion'))
  const dv = Buffer.alloc(4)
  dv.writeInt32BE(dataVersion)
  parts.push(dv)
  parts.push(Buffer.from([0x08]), str('LevelName'), str('Testwelt'))
  parts.push(Buffer.from([0x00]), Buffer.from([0x00]))
  writeFileSync(join(path, 'level.dat'), gzipSync(Buffer.concat(parts)))
  writeFileSync(join(path, 'region', 'r.0.0.mca'), 'CHUNK')
}

afterEach(() => {
  Paths.setRoot(null)
  while (roots.length > 0) {
    const dir = roots.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('AppService (Rauchtest)', () => {
  it('startet, importiert eine Welt, sichert sie und stellt sie wieder her', async () => {
    const root = newRoot()
    const source = newRoot()
    createWorld(source)

    const identity = new IdentityStore(join(root, 'identity.json'))
    identity.setDisplayName('Test-PC')

    const service = new AppService({ identity, dataRoot: root })
    await service.start()

    try {
      const state = service.getState()
      expect(state.identity?.displayName).toBe('Test-PC')
      expect(state.server.state).toBe('stopped')

      // Welt importieren
      const imported = await service.importWorld(source, 'meine-welt')
      expect(imported.ok).toBe(true)
      if (!imported.ok) return
      expect(imported.info?.dataVersion).toBe(3700)
      expect(imported.info?.mcVersion).toBe('1.20.4')

      // Die importierte Welt ist jetzt im Weltspeicher
      const worlds = service.listLocalWorlds()
      expect(worlds.length).toBe(1)
      expect(worlds[0]?.name).toBe('Testwelt')

      // Integritaet ist ok
      const check = service.checkWorld()
      expect(check.ok).toBe(true)
      expect(check.problems).toHaveLength(0)

      // Backup erstellen
      const backup = await service.createBackup('manual')
      expect(backup.ok).toBe(true)
      if (!backup.ok) return
      expect(backup.info?.verified).toBe(true)
      expect(backup.info?.worldVersionId).toMatch(/^[0-9a-f]{64}$/)

      // Welt verändern
      const worldPath = join(Paths.defaultWorldsDir(), 'meine-welt')
      writeFileSync(join(worldPath, 'region', 'r.0.0.mca'), 'VERAENDERT')

      // Wiederherstellung
      const restored = await service.restoreBackup(backup.info!.id)
      expect(restored.ok).toBe(true)
      expect(readFileSync(join(worldPath, 'region', 'r.0.0.mca'), 'utf8')).toBe('CHUNK')

      // Backups sind auflistbar
      const list = await service.listBackups()
      expect(list.length).toBeGreaterThan(0)
      expect(list.every((b) => b.verified)).toBe(true)
    } finally {
      await service.stop()
    }
  })

  it('lehnt den Import eines Ordners ohne level.dat ab', async () => {
    const root = newRoot()
    const source = newRoot()
    writeFileSync(join(source, 'irgendwas.txt'), 'keine Welt')

    const identity = new IdentityStore(join(root, 'identity.json'))
    const service = new AppService({ identity, dataRoot: root })
    await service.start()
    try {
      const result = await service.importWorld(source, 'ungueltig')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('level.dat')
    } finally {
      await service.stop()
    }
  })

  it('verhindert den Start einer Welt mit inkompatibler Version', async () => {
    const root = newRoot()
    const source = newRoot()
    // DataVersion 4189 entspricht Minecraft 1.21.4 - neuer als 1.20.4
    createWorld(source, 4189)

    const identity = new IdentityStore(join(root, 'identity.json'))
    const service = new AppService({ identity, dataRoot: root })
    await service.start()
    try {
      // Der Import ist erlaubt - der Start wird spaeter verhindert.
      const result = await service.importWorld(source, 'zu-neu')
      expect(result.ok).toBe(true)

      // Der Preflight des Servers muss den Start verhindern.
      const jar = join(root, 'dummy.jar')
      writeFileSync(jar, 'kein echter server')
      const manager = new MinecraftServerManager({
        serverDir: join(root, 'server'),
        jarPath: jar,
        ramBytes: 2 * 1024 ** 3,
        port: 25565,
        worldPath: join(Paths.defaultWorldsDir(), 'zu-neu'),
        levelName: 'world',
        mcVersion: '1.20.4'
      })
      const preflight = manager.preflight()
      expect(preflight.ok).toBe(false)
      expect(preflight.errors.join(' ')).toContain('neueren Minecraft-Version')
    } finally {
      await service.stop()
    }
  })

  it('überlebt einen Neustart der Anwendung und behält die Einstellungen', async () => {
    const root = newRoot()
    const identity = new IdentityStore(join(root, 'identity.json'))

    const service1 = new AppService({ identity, dataRoot: root })
    await service1.start()
    await service1.updateSettings({ backupIntervalMinutes: 17, serverPort: 25570 })
    await service1.stop()

    const service2 = new AppService({ identity, dataRoot: root })
    await service2.start()
    try {
      const settings = service2.getState().settings
      expect(settings.backupIntervalMinutes).toBe(17)
      expect(settings.serverPort).toBe(25570)
      // Die Identität ist stabil
      expect(service2.getState().identity?.nodeId).toBe(identity.nodeId)
    } finally {
      await service2.stop()
    }
  })

  it('schreibt seine kritischen Zustände atomar auf die Platte', async () => {
    const root = newRoot()
    const identity = new IdentityStore(join(root, 'identity.json'))
    const service = new AppService({ identity, dataRoot: root })
    await service.start()
    try {
      await service.updateSettings({ hostingPriority: 77 })
      await service.stop()

      const settingsFile = join(Paths.state(), 'settings.json')
      expect(existsSync(settingsFile)).toBe(true)
      const content = JSON.parse(readFileSync(settingsFile, 'utf8')) as { hostingPriority: number }
      expect(content.hostingPriority).toBe(77)
    } finally {
      await service.stop()
    }
  })
})
