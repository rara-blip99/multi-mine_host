/**
 * Failover-Rauchtest mit zwei echten Mitgliedern.
 *
 * Aufruf: npx tsx scripts/smoke-failover.ts
 *
 * Der Elternprozess ist PC B und erstellt die Gruppe. PC A läuft als
 * eigener Prozess:
 *   1. PC A tritt bei und übernimmt die Host-Rolle.
 *   2. PC A startet den Minecraft-Server und erstellt ein Backup, das zu
 *      PC B repliziert wird.
 *   3. PC A wird hart beendet (Absturz-Simulation).
 *   4. Nach Ablauf der Lease übernimmt PC B, stellt die Welt aus dem
 *      replizierten Backup wieder her und startet den Server.
 *
 * Geprüfte Kette: Lease -> Ablauf -> Übernahme -> Weltbeschaffung ->
 * Serverstart.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = join(here, '..')
const isChild = process.argv[2] === 'peer'

interface PeerConfig {
  name: string
  dataRoot: string
  hubAddress: string
  groupId: string
  inviteCode: string
  port: number
}

function log(message: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Kindprozess: PC A
// ---------------------------------------------------------------------------

async function runPeer(): Promise<void> {
  const { AppService } = await import('../src/main/app-service')
  const { IdentityStore } = await import('../src/main/security/identity')
  const { Paths } = await import('../src/main/core/paths')
  const { cp } = await import('node:fs/promises')

  const cfg = JSON.parse(process.argv[3] as string) as PeerConfig
  Paths.setRoot(cfg.dataRoot)

  const identity = new IdentityStore(join(cfg.dataRoot, 'identity.json'))
  identity.setDisplayName(cfg.name)

  const service = new AppService({ identity, dataRoot: cfg.dataRoot })
  await service.start()
  await service.updateSettings({ serverPort: cfg.port, backupIntervalMinutes: 60 })

  // Seed-Welt importieren
  const seed = join(cfg.dataRoot, 'seed-world')
  if (existsSync(seed)) {
    const imported = await service.importWorld(seed, 'welt')
    log(`${cfg.name}: Seed-Welt importiert: ${imported.ok ? 'OK' : 'FEHLER ' + imported.error}`)
    if (!imported.ok) {
      process.exit(3)
    }
  } else {
    log(`${cfg.name}: KEINE Seed-Welt unter ${seed} gefunden`)
    process.exit(3)
  }

  log(`${cfg.name} tritt der Gruppe bei ...`)
  const joined = await service.joinGroup(cfg.hubAddress, cfg.groupId, cfg.inviteCode)
  log(`${cfg.name}: Beitritt ${joined ? 'OK' : 'FEHLER'}`)

  // Host-Rolle anfordern
  const takeover = await service.requestTakeover()
  log(`${cfg.name}: Host-Anfrage ${takeover.ok ? 'OK' : 'FEHLER: ' + takeover.reason}`)

  // Auf die Lease warten
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (service.getState().lease?.holderId === identity.nodeId) break
    await sleep(1000)
  }
  if (service.getState().lease?.holderId !== identity.nodeId) {
    log(`${cfg.name}: KEINE Lease erhalten - Abbruch (Failover: ${service.getState().failover.phase} - ${service.getState().failover.message})`)
    process.exit(2)
  }
  log(`${cfg.name} ist Host (Epoche ${service.getState().lease?.epoch})`)

  // Server starten
  const started = await service.startServer(true)
  log(`${cfg.name}: Serverstart ${started.ok ? 'OK' : 'FEHLER: ' + started.error}`)
  await sleep(4000)

  // Backup erstellen -> wird zu PC B repliziert
  const backup = await service.createBackup('manual')
  log(`${cfg.name}: Backup ${backup.ok ? 'OK' : 'FEHLER: ' + backup.error}`)

  for (let i = 0; i < 40; i++) {
    if (service.getState().backups.some((b) => b.replicated)) {
      log(`${cfg.name}: Backup wurde zu PC-B repliziert`)
      break
    }
    await sleep(2000)
  }
  log(`${cfg.name}: WARTE AUF ABSTURZ-SIMULATION`)

  setInterval(() => undefined, 1 << 30)
}

// ---------------------------------------------------------------------------
// Elternprozess: PC B
// ---------------------------------------------------------------------------

async function runOrchestrator(): Promise<void> {
  const { HubNode } = await import('../src/main/hub/hub-node')
  const { AppService } = await import('../src/main/app-service')
  const { IdentityStore } = await import('../src/main/security/identity')
  const { Paths } = await import('../src/main/core/paths')
  const { cp } = await import('node:fs/promises')

  const root = mkdtempSync(join(tmpdir(), 'mmh-failover-'))
  log(`Testverzeichnis: ${root}`)

  // --- Hub starten ---
  const hub = new HubNode({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    token: null,
    dataFile: join(root, 'hub.json')
  })
  await hub.start()
  const hubRaw = hub.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/')) as string
  const hubAddress = hubRaw.includes('/p2p/') ? hubRaw : `${hubRaw}/p2p/${hub.peerId}`
  log(`Hub laeuft: ${hubAddress}`)

  // --- PC B (dieser Prozess) ---
  const dataB = join(root, 'pc-b')
  Paths.setRoot(dataB)
  const identityB = new IdentityStore(join(dataB, 'identity.json'))
  identityB.setDisplayName('PC-B')
  const serviceB = new AppService({ identity: identityB, dataRoot: dataB })
  await serviceB.start()
  await serviceB.updateSettings({
    serverPort: 25576,
    backupIntervalMinutes: 60,
    // PC B soll zunächst NICHT als Host zur Verfuegung stehen,
    // damit PC A die Lease bekommt.
    hostingAllowed: false
  })

  log('PC-B erstellt die Gruppe ...')
  const created = await serviceB.createGroup(hubAddress, 'Failover-Test')
  const inviteCode = created.invites?.[0]?.code as string
  const groupId = created.group.groupId
  log(`PC-B: Gruppe ${groupId}, Einladungscode ${inviteCode}`)

  // --- PC A als Kindprozess ---
  const dataA = join(root, 'pc-a')
  await cp(join(projectRoot, 'tests', 'fixtures', 'mc-world'), join(dataA, 'seed-world'), {
    recursive: true
  })

  const cfgA: PeerConfig = {
    name: 'PC-A',
    dataRoot: dataA,
    hubAddress,
    groupId,
    inviteCode,
    port: 25575
  }

  log('PC-A wird gestartet ...')
  const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const childA = spawn(
    process.execPath,
    [tsxCli, join(here, 'smoke-failover.ts'), 'peer', JSON.stringify(cfgA)],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.node.json') }
    }
  )
  childA.stdout?.on('data', (d: Buffer) =>
    process.stdout.write(`  A| ${d.toString().trimEnd()}\n`)
  )
  childA.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trimEnd()
    if (text && !text.includes('ExperimentalWarning')) process.stderr.write(`  A! ${text}\n`)
  })

  // Warten, bis PC A Host ist und das Backup repliziert wurde
  log('Warte darauf, dass PC-A hostet und das Backup repliziert ist ...')
  const setupDeadline = Date.now() + 240_000
  let replicated = false
  while (Date.now() < setupDeadline) {
    await sleep(3000)
    if (childA.exitCode !== null) {
      log(`FEHLER: PC-A wurde mit Code ${childA.exitCode} beendet`)
      break
    }
    // Pruefen, ob PC B das replizierte Backup hat
    const backupsB = await serviceB.listBackups()
    if (backupsB.some((b) => b.replicated || b.path.includes('tar.gz'))) {
      replicated = true
      log(`PC-B hat ${backupsB.length} Backup(s) erhalten`)
      break
    }
  }
  if (!replicated) {
    log('WARNUNG: Kein repliziertes Backup bei PC-B erkannt')
  }

  // --- Absturz simulieren ---
  log('PC-A wird hart beendet (Absturz-Simulation) ...')
  childA.kill('SIGKILL')
  await sleep(2000)

  // --- PC B übernimmt ---
  log('PC-B aktiviert das Hosting und wartet auf die Uebernahme ...')
  await serviceB.updateSettings({ hostingAllowed: true })

  const takeoverDeadline = Date.now() + 180_000
  let takeoverOk = false
  while (Date.now() < takeoverDeadline) {
    const state = serviceB.getState()
    if (state.lease?.holderId === identityB.nodeId) {
      takeoverOk = true
      log(`PC-B hat die Lease uebernommen (Epoche ${state.lease.epoch})`)
      break
    }
    await sleep(2000)
  }

  if (!takeoverOk) {
    log('FEHLER: PC-B hat die Host-Rolle nicht uebernommen')
    log(`  Failover-Status: ${serviceB.getState().failover.phase} - ${serviceB.getState().failover.message}`)
    await serviceB.stop()
    await hub.stop()
    process.exit(1)
  }

  // Auf den Serverstart warten
  const serverDeadline = Date.now() + 150_000
  let serverRunning = false
  while (Date.now() < serverDeadline) {
    const state = serviceB.getState()
    if (state.server.state === 'running') {
      serverRunning = true
      break
    }
    if (state.failover.phase === 'failed' || state.failover.phase === 'blocked') {
      log(`FEHLER im Failover: ${state.failover.message}`)
      break
    }
    await sleep(2000)
  }

  const finalState = serviceB.getState()
  log(`PC-B Serverstatus: ${finalState.server.state}`)
  log(`PC-B Failover: ${finalState.failover.phase} - ${finalState.failover.message}`)
  for (const w of finalState.failover.warnings) log(`  Warnung: ${w}`)

  const ok = serverRunning
  log(ok ? 'ERGEBNIS: Failover erfolgreich - PC-B hostet den Server' : 'ERGEBNIS: Failover nicht erfolgreich')

  await serviceB.stop()
  await hub.stop()
  log(`Testverzeichnis bleibt zur Analyse erhalten: ${root}`)
  process.exit(ok ? 0 : 1)
}

if (isChild) {
  runPeer().catch((err) => {
    console.error('Mitglied abgestuerzt:', err)
    process.exit(1)
  })
} else {
  runOrchestrator().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
