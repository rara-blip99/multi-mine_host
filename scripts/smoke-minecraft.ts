/**
 * Manueller End-to-End-Test: die Anwendung laedt Paper herunter, startet
 * einen echten Minecraft-Server mit einer Testwelt, fragt den Status ab und
 * beendet den Server wieder.
 *
 * Aufruf: npx tsx scripts/smoke-minecraft.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppService } from '../src/main/app-service'
import { Paths } from '../src/main/core/paths'
import { IdentityStore } from '../src/main/security/identity'

/** Echte, von einem Paper-Server erzeugte Welt. */
const FIXTURE_WORLD = join(import.meta.dirname, '..', 'tests', 'fixtures', 'mc-world')

function createWorld(path: string): void {
  mkdirSync(path, { recursive: true })
  cpSync(FIXTURE_WORLD, path, { recursive: true })
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mmh-smoke-'))
  const source = mkdtempSync(join(tmpdir(), 'mmh-smoke-src-'))
  console.log(`Datenverzeichnis: ${root}`)

  const identity = new IdentityStore(join(root, 'identity.json'))
  identity.setDisplayName('Smoke-Test')

  const service = new AppService({ identity, dataRoot: root })
  await service.start()

  let ok = false
  try {
    // 1) Welt importieren
    createWorld(source)
    const imported = await service.importWorld(source, 'smoke-welt')
    console.log(`1) Welt importiert: ${imported.ok ? 'OK' : 'FEHLER ' + imported.error}`)
    if (!imported.ok) throw new Error(imported.error)

    // 2) Server vorbereiten (lädt Paper herunter)
    console.log('2) Server wird vorbereitet (Download der Paper-JAR, ~43 MB) ...')
    const prepared = await service.prepareServer()
    console.log(`   Server vorbereitet: ${prepared.ok ? 'OK' : 'FEHLER ' + prepared.error}`)
    if (!prepared.ok) throw new Error(prepared.error)

    // 3) Server starten
    console.log('3) Server wird gestartet ...')
    const started = await service.startServer(true)
    console.log(`   Server gestartet: ${started.ok ? 'OK' : 'FEHLER ' + started.error}`)
    if (!started.ok) throw new Error(started.error)

    // 4) Status abfragen
    await new Promise((r) => setTimeout(r, 3000))
    let status = service.getState().server
    console.log(`4) Serverstatus: ${status.state} (RAM ${Math.round(status.ramLimitBytes / 1024 / 1024)} MB)`)
    if (status.state !== 'running') {
      const logs = service.serverLogsTail(30)
      console.log('   Letzte Serverausgaben:')
      for (const l of logs) console.log(`     ${l.message}`)
      throw new Error('Server lief nicht an')
    }

    // 5) Server-List-Ping (Spielerzahl)
    const { probeServerStatus } = await import('../src/main/minecraft/slp')
    const ping = await probeServerStatus('127.0.0.1', service.getState().settings.serverPort, 5000)
    console.log(
      `5) Server-List-Ping: ${ping.version.name} (Protokoll ${ping.version.protocol}), ${ping.players.online}/${ping.players.max} Spieler`
    )

    // 6) Backup aus dem laufenden Server heraus
    const backup = await service.createBackup('manual')
    console.log(`6) Backup: ${backup.ok ? 'OK' : 'FEHLER ' + backup.error}`)
    if (!backup.ok) throw new Error(backup.error)
    console.log(`   Größe: ${Math.round((backup.info?.sizeBytes ?? 0) / 1024)} KB`)

    // 7) Server stoppen (Welt wird gespeichert)
    await service.stopServer()
    await new Promise((r) => setTimeout(r, 2000))
    status = service.getState().server
    console.log(`7) Server gestoppt: ${status.state} (Exit-Code ${status.lastExitCode})`)
    if (status.state !== 'stopped') throw new Error('Server stoppte nicht')

    // 8) Welt ist intakt
    const check = service.checkWorld()
    console.log(`8) Weltintegrität: ${check.ok ? 'OK' : 'FEHLER ' + check.problems.join(', ')}`)

    ok = check.ok
  } catch (err) {
    console.error('\nFEHLER:', err instanceof Error ? err.message : String(err))
  } finally {
    await service.stop()
    try {
      rmSync(source, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    console.log(`\nTestverzeichnis bleibt zur Analyse erhalten: ${root}`)
  }

  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
