import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import {
  mkdtempSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { AppService } from '../src/main/app-service'
import { Paths } from '../src/main/core/paths'
import { IdentityStore } from '../src/main/security/identity'
import { parseNbt, nbtGet } from '../src/main/minecraft/nbt'

/**
 * Integrations-Tests der Welt-Erstellung in der Anwendung.
 *
 * Prinzip: echte Integrationspfade. Beide "Neue Welt erstellen"-Laufe
 * generieren wirklich mit einem Paper-Server, die Gruppen- und
 * Lease-Koordination laeuft ueber den eingebauten Hub, das Starten prueft
 * echte Serverbereitschaft ("Done (...s)!"). Gestartete Ports/Sockets sind
 * echt gebunden - es wird nichts gemockt, das Fehler kaschieren koennte.
 */

const FIXTURE_WORLD = join(import.meta.dirname, 'fixtures', 'mc-world')

let root = ''
let service: AppService | null = null

/** Welt-/Lease-Stand an markanten Punkten (Diagnose, falls spaeter etwas faelsht). */
const worldTrail: Array<{ at: string; worldName: string | null; versionId?: string; leaseEpoch?: number | null; failoverPhase?: string }> = []
function snapWorld(at: string): void {
  const st = service!.getState()
  worldTrail.push({
    at,
    worldName: st.world?.worldName ?? null,
    versionId: st.world?.versionId,
    leaseEpoch: st.lease?.epoch ?? null,
    failoverPhase: st.failover?.phase ?? null
  })
}

function startService(): AppService {
  const identity = new IdentityStore(join(root, 'identity.json'))
  service = new AppService({ identity, dataRoot: root })
  return service
}

function worldsDir(): string {
  return join(root, 'worlds')
}

function serverRootDir(): string {
  return join(root, 'servers', 'default')
}

function serverProps(): string {
  return readFileSync(join(serverRootDir(), 'server.properties'), 'utf8')
}

/** Snapshot der Weltordner-Struktur (Pfade + Groesse + mtime) fuer Integritaetsvergleiche. */
function worldSnapshot(dir: string): string {
  const out: string[] = []
  const walk = (current: string, rel: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(full, relPath)
      } else {
        const st = statSync(full)
        out.push(`${relPath}:${st.size}:${st.mtimeMs}`)
      }
    }
  }
  walk(dir, '')
  return out.sort().join('\n')
}

/** Seed aus level.dat (gzip+NBT) lesen: Data.WorldGenSettings.seed (Long). */
function levelDatSeed(worldPath: string): bigint | null {
  const raw = gunzipSync(readFileSync(join(worldPath, 'level.dat')))
  const tree = parseNbt(raw)
  const v = nbtGet(tree, ['Data', 'WorldGenSettings', 'seed'])
  return typeof v === 'bigint' ? v : null
}

/** Beliebigen Wert aus level.dat lesen (z. B. Data.Difficulty). */
function levelDatValue(worldPath: string, keys: string[]): unknown {
  const raw = gunzipSync(readFileSync(join(worldPath, 'level.dat')))
  return nbtGet(parseNbt(raw), keys)
}

const CREATE_TIMEOUT = 600_000
const START_TIMEOUT = 300_000

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mmh-world-create-'))
  Paths.setRoot(root)
  const svc = startService()
  await svc.start()
  // Ein-Klick-Gruppenerstellung am eingebauten Hub (echte Infrastruktur).
  await svc.createGroup('', 'Welt-Erstellung')
  const state = svc.getState()
  expect(state.group?.groupId).toBeTruthy()
  expect(state.hubConnected).toBe(true)
})

afterAll(async () => {
  try {
    await service?.stop()
  } catch {
    /* Aufräumen darf nicht blockieren */
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('Welt-Erstellung in der Anwendung', () => {
  it('weist ungültige Welt- und Pfadnamen ab (Traversal, Windows reservierte Namen, Trennzeichen)', async () => {
    const invalidNames = ['', '   ', '../etc', 'a/b', 'a\\b', 'C:evil', ':colon', 'con', 'nul', 'punkt.', 'x'.repeat(65)]
    for (const name of invalidNames) {
      const result = await service!.createWorld({
        name,
        mcVersion: '1.20.4',
        gameMode: 'survival',
        difficulty: 'normal',
        cheats: false
      })
      expect(result.ok, `Name "${name}" sollte abgewiesen werden`).toBe(false)
      expect(result.error, `Fehlertext für "${name}" fehlt`).toBeTruthy()
    }
    // Kein Abfall im Weltspeicher entstanden (der Ordner selbst wird von
    // Paths.ensureAll() beim App-Start bereits angelegt - links leer).
    if (existsSync(worldsDir())) {
      expect(readdirSync(worldsDir())).toEqual([])
    }
  }, 120_000)

  it('behandelt ungueltige Versionsangaben ohne Download', async () => {
    const result = await service!.createWorld({
      name: 'Version Falsch',
      mcVersion: '999.999.999',
      gameMode: 'survival',
      difficulty: 'normal',
      cheats: false
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('wird nicht unterstützt')
  }, 120_000)

  it('behandelt ungültige Spielmodi und Schwierigkeitsgrade', async () => {
    const badMode = await service!.createWorld({
      name: 'Modus Falsch',
      mcVersion: '1.20.4',
      gameMode: 'spectator' as never,
      difficulty: 'normal',
      cheats: false
    })
    expect(badMode.ok).toBe(false)
    expect(badMode.error).toContain('Spielmodus')

    const badDifficulty = await service!.createWorld({
      name: 'Schwere Falsch',
      mcVersion: '1.20.4',
      gameMode: 'survival',
      difficulty: 'ultra' as never,
      cheats: false
    })
    expect(badDifficulty.ok).toBe(false)
    expect(badDifficulty.error).toContain('Schwierigkeitsgrad')
  }, 120_000)

  it('weist einen belegten Port klar ab (echter, gebundener Socket)', async () => {
    // Echter, OS-zugewiesener Listener als Portblockierer.
    const blocker: TcpServer = createTcpServer()
    const port: number = await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen({ port: 0, host: '0.0.0.0', exclusive: true }, () => {
        const addr = blocker.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('keine Adresse'))
      })
    })
    try {
      await service!.updateSettings({ serverPort: port })
      const result = await service!.createWorld({
        name: 'Port Konflikt',
        mcVersion: '1.20.4',
        gameMode: 'survival',
        difficulty: 'normal',
        cheats: false
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain(String(port))
      expect(result.error).toContain('verwendet')
    } finally {
      await service!.updateSettings({ serverPort: 25565 })
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 120_000)

  it('die bestehende Welt bleibt bei Fehlern unangetastet (Namenskollision)', async () => {
    mkdirSync(worldsDir(), { recursive: true })
    cpSync(FIXTURE_WORLD, join(worldsDir(), 'Bestehende Welt'), { recursive: true })
    const beforeSnapshot = worldSnapshot(join(worldsDir(), 'Bestehende Welt'))

    const result = await service!.createWorld({
      name: 'Bestehende Welt',
      mcVersion: '1.20.4',
      gameMode: 'survival',
      difficulty: 'normal',
      cheats: false
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('existiert bereits')
    expect(worldSnapshot(join(worldsDir(), 'Bestehende Welt'))).toBe(beforeSnapshot)
  }, 120_000)

  it('ohne vorhandene Welt verweist der Start auf die Auswahl (worldMissing)', async () => {
    const result = await service!.startWorld()
    expect(result.ok).toBe(false)
    expect(result.worldMissing).toBe(true)
    expect(result.error).toContain('Welt')
  }, 240_000)

  it(
    'erstellt die Standard-Welt (Defaults: konfigurierte Version, Überleben, Normal) und startet mit bestätigter Bereitschaft',
    async () => {
      const result = await service!.createWorld({
        name: 'Smaragd-Tal',
        mcVersion: '1.20.4',
        gameMode: 'survival',
        difficulty: 'normal',
        cheats: false
      })
      expect(result.ok).toBe(true)
      expect(result.startError).toBeUndefined()
      const info = result.info!
      expect(info.worldName).toBe('Smaragd-Tal')
      expect(existsSync(join(info.worldPath, 'level.dat'))).toBe(true)
      expect(levelDatValue(info.worldPath, ['Data', 'WorldGenSettings'])).toBeTruthy()

      // Der Produktionsserver uebernimmt die gewaehlte Server-Konfiguration.
      const props = serverProps()
      expect(props).toContain('gamemode=survival')
      expect(props).toContain('difficulty=normal')
      expect(props).toContain('level-seed=')
      expect(props).not.toMatch(/^level-seed=.+$/m)

      // Der bewaehrte Startpfad: Lease, Welt-Registrierung am Hub,
      // echter Serverstart, bestätigte Bereitschaft.
      await vi.waitFor(
        () => {
          expect(service!.getState().server.state).toBe('running')
        },
        { timeout: 180_000, interval: 1_000 }
      )
      const state = service!.getState()
      expect(state.world?.worldName).toBe('Smaragd-Tal')
      expect(state.server.playersOnline).toBeGreaterThanOrEqual(0)

      snapWorld('Standard-Welt gestartet')
      await service!.stopServer()
      snapWorld('Standard-Welt gestoppt')
    },
    CREATE_TIMEOUT
  )

  it(
    'erstellt eine Welt mit Seed, uebernimmt den Seed wirklich und verhindert parallele Doppelarbeit',
    async () => {
      // Zwei parallele Aufrufe: der zweite muss wegen der Laufsperre abgelehnt werden.
      const request = {
        name: 'Seed-Tal',
        mcVersion: '1.20.4',
        gameMode: 'survival' as const,
        difficulty: 'hard' as const,
        seed: '123456789',
        cheats: true
      }
      const parallel = service!.createWorld({ ...request })
      const duplicate = await service!.createWorld({ ...request })
      expect(duplicate.ok, duplicate.error).toBe(false)
      expect(duplicate.error).toContain('läuft bereits')
      const result = await parallel
      expect(result.ok, `Welt-Erstellung fehlgeschlagen: ${result.error}`).toBe(true)
      if (result.startError) {
        // Diagnose: Server-Logs und Minecraft-Log ausgeben, bevor der
        // Temp-Root im afterAll entfernt wird.
        console.error('startError:', result.startError)
        console.error('letzte Server-Logs:', service!.serverLogsTail(60))
        const logFile = join(serverRootDir(), 'logs', 'latest.log')
        if (existsSync(logFile)) {
          const lines = readFileSync(logFile, 'utf8').split(/\r?\n/)
          console.error('latest.log tail:', lines.slice(-80).join('\n'))
        }
      }
      expect(result.startError, 'Serverstart nach Welt-Erstellung: ' + (result.startError ?? '')).toBeUndefined()

      const info = result.info!
      expect(info.seed).toBe('123456789')

      // Der Seed wurde wirklich uebernommen (level.dat, exakt als Long).
      expect(levelDatSeed(info.worldPath)).toBe(123456789n)
      // Paper speichert den Schwierigkeitsgrad in level.dat als Byte
      // (0 = peaceful, 1 = easy, 2 = normal, 3 = hard). Verifiziert an einer
      // echten 1.20.4-Welt: die Fixture (tests/fixtures/mc-world) enthaelt
      // fuer "normal" den Wert 1.
      expect(levelDatValue(info.worldPath, ['Data', 'Difficulty'])).toBe(3)
      // Die von der App gewaehlte Einstellung steht zusaetzlich menschenlesbar
      // in der Serverkonfiguration des Produktionsserver-Verzeichnisses.
      expect(serverProps()).toContain('difficulty=hard')

      await vi.waitFor(
        () => {
          expect(service!.getState().server.state).toBe('running')
        },
        { timeout: 180_000, interval: 1_000 }
      )
      // Cheats: der Ersteller ist Operator.
      const ops = JSON.parse(readFileSync(join(serverRootDir(), 'ops.json'), 'utf8')) as Array<{ name: string }>
      expect(ops.map((o) => o.name)).toContain(service!.getState().identity?.displayName)

      snapWorld('Seed-Welt gestartet')
      await service!.stopServer()
      snapWorld('Seed-Welt gestoppt')
    },
    CREATE_TIMEOUT
  )

  it(
    'waehlt eine vorhandene Welt aus und startet sie mit bestätigter Bereitschaft',
    async () => {
      // Fixture-Welt in den Weltspeicher kopieren (dataVersion 3700 = 1.20.4).
      cpSync(FIXTURE_WORLD, join(worldsDir(), 'Ausgewählte Welt'), { recursive: true })
      const select = await service!.selectWorld('Ausgewählte Welt')
      expect(select.ok).toBe(true)

      const start = await service!.startWorld()
      expect(start.ok).toBe(true)
      expect(start.worldMissing).toBeUndefined()
      await vi.waitFor(
        () => {
          expect(service!.getState().server.state).toBe('running')
        },
        { timeout: 180_000, interval: 1_000 }
      )
      snapWorld('Ausgewählte Welt gestartet')
      await service!.stopServer()
      snapWorld('Ausgewählte Welt gestoppt')
    },
    START_TIMEOUT
  )

  it('erhaelt Gruppe, Weltregistrierung, Backup- und Failover-Zustand intakt', async () => {
    try {
      const state = service!.getState()
      expect(state.group?.groupId).toBeTruthy()
      expect(state.hubConnected).toBe(true)
      // Die zuletzt gestartete Welt ist am Hub registriert (start-Commit).
      expect(state.world?.worldName).toBe('Ausgewählte Welt')
      expect(state.failover.phase === 'idle' || state.failover.phase === 'completed').toBe(true)

      const backup = await service!.createBackup('manual')
      expect(backup.ok, `Backup fehlgeschlagen: ${backup.error}`).toBe(true)
      const backups = await service!.listBackups()
      expect(backups.length).toBeGreaterThan(0)
      expect(backups.some((b) => b.worldName === 'Ausgewählte Welt')).toBe(true)
    } catch (err) {
      // Diagnose: Welt- und Lease-Proben (Punkte aller Laufe), das Journal
      // (world-select / lease-acquired / world-commit) und aktuelle Server-Logs
      // ausgeben, bevor der Temp-Root im afterAll entfernt wird.
      console.error('Diagnose bei Fehlschlag:', String(err))
      console.error('worldTrail:', JSON.stringify(worldTrail, null, 2))
      const st = service!.getState()
      console.error('world:', JSON.stringify(st.world))
      console.error('lease:', JSON.stringify(st.lease))
      console.error('failover:', JSON.stringify(st.failover))
      console.error('journalEntries:', JSON.stringify(service!.journalEntries(40)))
      console.error('letzte Server-Logs:', JSON.stringify(service!.serverLogsTail(25)))
      throw err
    }
  }, 240_000)

  it(
    'bricht klar ab, wenn waehrend eines laufenden Servers auf eine andere Welt gewechselt wird',
    async () => {
      // 'Smaragd-Tal' aus dem ersten Erstell-Test muss vorliegen.
      expect(existsSync(join(worldsDir(), 'Smaragd-Tal')), "'Smaragd-Tal' (Standard-Welt) fehlt im Weltspeicher").toBe(true)
      const first = await service!.selectWorld('Smaragd-Tal')
      expect(first.ok).toBe(true)
      const started = await service!.startWorld()
      expect(started.ok, `Start fehlgeschlagen: ${started.error}`).toBe(true)
      await vi.waitFor(
        () => {
          expect(service!.getState().server.state).toBe('running')
        },
        { timeout: 180_000, interval: 1_000 }
      )

      // Weltwechsel unter laufendem Server: selectWorld allein ist erlaubt
      // (reine Sitzungsauswahl), aber der Start des jetzt gewaehlten Weltstandes
      // darf NICHT den laufenden alten Server verkaufen.
      const switched = await service!.selectWorld('Ausgewählte Welt')
      expect(switched.ok, `Auswahl fehlgeschlagen: ${switched.error}`).toBe(true)
      const nextStart = await service!.startWorld()
      expect(nextStart.ok).toBe(false)
      expect(nextStart.error).toContain('Smaragd-Tal')
      expect(nextStart.error).toContain('Ausgewählte Welt')

      // Der laufende Server wurde NICHT angetastet: Er bedient weiterhin die
      // Welt, fuer die er gestartet wurde. Erst ein expliziter Stopp beendet ihn.
      expect(service!.getState().server.state).toBe('running')

      await service!.stopServer()
    },
    START_TIMEOUT
  )
})
