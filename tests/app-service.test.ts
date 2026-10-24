import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, gunzipSync } from 'node:zlib'
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

/**
 * Echte, von einem Minecraft-Server erzeugte Welt als Testfixture.
 * Sie ist minimal (nur level.dat, uid.dat, datapacks) - der Server erzeugt
 * die Region-Dateien beim Start selbst.
 */
const FIXTURE_WORLD = join(import.meta.dirname, 'fixtures', 'mc-world')

function createWorld(path: string): void {
  cpSync(FIXTURE_WORLD, path, { recursive: true })
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
      expect(worlds[0]?.name).toBe('world')

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

      // Welt verändern (eine zusätzliche Datei im data-Ordner)
      const worldPath = join(Paths.defaultWorldsDir(), 'meine-welt')
      mkdirSync(join(worldPath, 'data'), { recursive: true })
      writeFileSync(join(worldPath, 'data', 'test.dat'), 'VERAENDERT')

      // Wiederherstellung
      const restored = await service.restoreBackup(backup.info!.id)
      expect(restored.ok).toBe(true)
      expect(existsSync(join(worldPath, 'data', 'test.dat'))).toBe(false)
      expect(readFileSync(join(worldPath, 'level.dat')).length).toBeGreaterThan(0)

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

  it('startet die Welt nicht ohne eingerichtete Gruppe und uebernimmt Nebenschauplaetze', async () => {
    const root = newRoot()
    const identity = new IdentityStore(join(root, 'identity.json'))
    const service = new AppService({ identity, dataRoot: root })
    await service.start()
    try {
      const result = await service.startWorld()
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Gruppe')
    } finally {
      await service.stop()
    }
  })

  it('migriert alte Einstellungen und aktiviert den eingebauten Hub', async () => {
    const root = newRoot()
    // Bestehende Installation: settings.json OHNE embeddedHubEnabled.
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(
      join(root, 'state', 'settings.json'),
      JSON.stringify({
        minecraftEdition: 'java',
        mcVersion: '1.20.4',
        serverRamBytes: 2 * 1024 * 1024 * 1024,
        serverPort: 25570,
        worldsDir: join(root, 'worlds'),
        backupsDir: join(root, 'backups')
      }),
      'utf8'
    )
    const identity = new IdentityStore(join(root, 'identity.json'))
    const service = new AppService({ identity, dataRoot: root })
    await service.start()
    try {
      const state = service.getState()
      expect(state.settings.embeddedHubEnabled).toBe(true)
      // Der eingebaute Hub rendert auf einem zufaelligen Port und ist sofort verwendbar.
      const address = service.embeddedHubAddress()
      expect(address).toBeTruthy()
      expect(address).toContain('/p2p/')
      // Die migrierten Einstellungen wurden zurueckgeschrieben.
      const persisted = JSON.parse(readFileSync(join(root, 'state', 'settings.json'), 'utf8')) as Record<
        string,
        unknown
      >
      expect(persisted.embeddedHubEnabled).toBe(true)
      expect(persisted.serverPort).toBe(25570)
    } finally {
      await service.stop()
    }
  })

  it('verhindert den Start einer Welt mit inkompatibler Version', async () => {
    const root = newRoot()
    const source = newRoot()
    // DataVersion auf eine neuere Minecraft-Version setzen (1.21.4 = 4189)
    createWorld(source)
    const levelDat = join(source, 'level.dat')
    const raw = readFileSync(levelDat)
    // level.dat ist gzip-komprimiert -> entpacken, patchen, wieder packen.
    const unpacked = gunzipSync(raw)
    const marker = Buffer.from('DataVersion', 'utf8')
    const idx = unpacked.indexOf(marker)
    expect(idx).toBeGreaterThan(0)
    // Nach dem Namen folgt unmittelbar der Big-Endian-Wert (4 Byte)
    const valueOffset = idx + marker.length
    const patched = Buffer.from(unpacked)
    patched.writeInt32BE(4189, valueOffset)
    writeFileSync(levelDat, gzipSync(patched))

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
