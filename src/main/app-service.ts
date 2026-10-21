import { existsSync, mkdirSync, renameSync, rmSync, statSync, readdirSync, symlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { cp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  AppState,
  BackupInfo,
  BackupKind,
  CandidateScore,
  GroupInfo,
  GroupMember,
  GroupSnapshot,
  HostCapability,
  HostLease,
  ServerStatus,
  SyncProgress,
  WorldRegistryEntry
} from '@shared/types'
import type { InviteInfo, PeerDiscoveryInfo } from '@shared/protocol'
import { AtomicStore, Journal } from './core/atomic-store'
import { Paths } from './core/paths'
import { logger } from './core/logger'
import { identityStore } from './security/identity'
import type { IdentityStore } from './security/identity'
import { keystore } from './security/keystore'
import { createPeerNode } from './net/transport'
import type { PeerNode } from './net/transport'
import { PeerManager } from './net/peer-manager'
import { HubClient } from './hub/hub-client'
import { HubNode } from './hub/hub-node'
import { LeaseClient } from './host/lease-client'
import { PerformanceMonitor } from './host/performance'
import { scoreCandidates, selectHost, DEFAULT_REQUIREMENTS } from './host/election'
import type { ElectionContext, HostRequirements } from './host/election'
import { MinecraftServerManager } from './minecraft/server-manager'
import { ensurePaperJar } from './minecraft/jar-manager'
import { checkWorldIntegrity, listWorldsIn, readWorldInfo } from './minecraft/world'
import { buildManifest, verifyWorld } from './sync/manifest'
import { activateWorld, hasFreeSpace } from './sync/world-sync'
import { BackupManager } from './backup/backup-manager'
import {
  defaultAppState,
  defaultFailoverState,
  defaultServerStatus,
  defaultSettings,
  defaultSyncProgress
} from './app-state'
import type { SessionState } from './app-state'

/**
 * Orchestrierung der gesamten Anwendung.
 *
 * Diese Klasse ist das "Gehirn": Sie verbindet Netzwerk, Lease/Fencing,
 * Minecraft-Server, Weltverwaltung und Backups zu einem Zustandsautomaten.
 */

export interface AppServiceOptions {
  identity?: IdentityStore
  /** Verzeichnis fuer die Zustandsdateien (Tests). */
  stateDir?: string
  /** Basisverzeichnis fuer alle App-Daten (Tests, portable Installation). */
  dataRoot?: string
}

type Listener = (state: AppState) => void

export class AppService {
  private state: AppState = defaultAppState()
  private readonly listeners = new Set<Listener>()
  private readonly settingsStore: AtomicStore<AppSettings>
  private readonly sessionStore: AtomicStore<SessionState>
  private readonly journal: Journal

  private node: PeerNode | null = null
  private hub: HubClient | null = null
  private peers: PeerManager | null = null
  private lease: LeaseClient | null = null
  private embeddedHub: HubNode | null = null
  private server: MinecraftServerManager | null = null
  private backups: BackupManager
  private perf: PerformanceMonitor

  private heartbeatTimer: NodeJS.Timeout | null = null
  private backupTimer: NodeJS.Timeout | null = null
  private perfTimer: NodeJS.Timeout | null = null
  private failoverTimer: NodeJS.Timeout | null = null
  private started = false
  private takeoverInProgress = false
  private serverLogs: Array<{ ts: number; level: string; message: string }> = []

  constructor(private readonly opts: AppServiceOptions = {}) {
    if (opts.dataRoot) Paths.setRoot(opts.dataRoot)
    const stateDir = opts.stateDir ?? Paths.state()
    mkdirSync(stateDir, { recursive: true })
    this.settingsStore = new AtomicStore<AppSettings>(join(stateDir, 'settings.json'), defaultSettings)
    this.sessionStore = new AtomicStore<SessionState>(join(stateDir, 'session.json'), () => ({}))
    this.journal = new Journal(join(stateDir, 'journal.log'))
    this.backups = new BackupManager({
      backupsDir: Paths.defaultBackupsDir(),
      retention: 12,
      quarantineDir: Paths.quarantine()
    })
    this.perf = new PerformanceMonitor({ worldPath: Paths.defaultWorldsDir() })
  }

  // -------------------------------------------------------------------------
  // Zustand
  // -------------------------------------------------------------------------

  getState(): AppState {
    return this.state
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    for (const fn of this.listeners) {
      try {
        fn(this.state)
      } catch {
        /* Listener-Fehler dürfen den Zustand nicht blockieren */
      }
    }
  }

  private get identity(): IdentityStore {
    return this.opts.identity ?? identityStore
  }

  private get session(): SessionState {
    return this.sessionStore.load()
  }

  private async saveSession(patch: Partial<SessionState>): Promise<void> {
    await this.sessionStore.save({ ...this.session, ...patch })
  }

  // -------------------------------------------------------------------------
  // Start / Stopp
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    Paths.ensureAll()

    const settings = this.settingsStore.load()
    this.backups = new BackupManager({
      backupsDir: settings.backupsDir,
      retention: settings.backupRetention,
      maxSizeBytes: settings.backupMaxSizeMb * 1024 * 1024,
      quarantineDir: Paths.quarantine()
    })
    this.perf = new PerformanceMonitor({ worldPath: settings.worldsDir })
    this.perf.warmup()

    this.patch({
      identity: this.identity.identity(),
      settings,
      server: { ...defaultServerStatus(), mcVersion: settings.mcVersion, ramLimitBytes: settings.serverRamBytes }
    })

    // Eingebetteten Hub starten (falls konfiguriert)
    if (settings.embeddedHubPort > 0) {
      await this.startEmbeddedHub(settings.embeddedHubPort)
    }

    const session = this.session
    if (session.groupId && session.hubAddress) {
      await this.connectHub(session.hubAddress, session.groupId, session.sessionToken)
    }

    this.startHeartbeat()
    this.startPerformanceLoop()
    this.startBackupTimer()
    logger.info('app', 'Multi-Mine Host gestartet', { nodeId: this.state.identity?.nodeId })
  }

  async stop(): Promise<void> {
    this.started = false
    this.stopHeartbeat()
    this.stopBackupTimer()
    this.stopPerformanceLoop()
    await this.lease?.release('Anwendung wird beendet')
    this.lease?.stop()
    await this.server?.stop(30_000)
    await this.hub?.close()
    await this.embeddedHub?.stop()
    await this.node?.stop()
    this.node = null
    this.hub = null
    this.peers = null
    this.journal.close()
    logger.info('app', 'Multi-Mine Host beendet')
  }

  // -------------------------------------------------------------------------
  // Hub
  // -------------------------------------------------------------------------

  private async startEmbeddedHub(port: number): Promise<void> {
    try {
      const token = this.state.settings.embeddedHubToken || keystore.ensureToken('embedded-hub-token')
      const hub = new HubNode({
        listen: [`/ip4/0.0.0.0/tcp/${port}`],
        token,
        dataFile: join(Paths.state(), 'hub-state.json')
      })
      await hub.start()
      this.embeddedHub = hub
      logger.info('app', 'Eingebetteter Hub gestartet', { port, peerId: hub.peerId })
    } catch (err) {
      logger.error('app', 'Eingebetteter Hub konnte nicht gestartet werden', { error: String(err) })
    }
  }

  /** Adresse des eingebetteten Hubs (fuer die Anzeige in der Oberflaeche). */
  embeddedHubAddress(): string | null {
    if (!this.embeddedHub) return null
    const addrs = this.embeddedHub.addresses
    const usable = addrs.find((a) => !a.includes('127.0.0.1') && !a.includes('/ip6/::')) ?? addrs[0]
    if (!usable) return null
    const peerId = this.embeddedHub.peerId
    return usable.includes('/p2p/') ? usable : `${usable}/p2p/${peerId}`
  }

  private async ensureNode(): Promise<PeerNode> {
    if (this.node) return this.node
    this.node = await createPeerNode({
      listen: ['/ip4/0.0.0.0/tcp/0'],
      privateKeyPem: this.identity.material.privateKeyPem,
      appName: 'multi-mine-host/0.1.0'
    })
    this.peers = new PeerManager({
      node: this.node,
      identity: this.identity,
      groupId: this.session.groupId ?? '',
      provideWorld: () => this.provideWorld(),
      publicKeys: () => this.memberPublicKeys(),
      peerIdOf: (nodeId) => this.peerIdOf(nodeId)
    })
    await this.peers.listen()
    return this.node
  }

  /** Verbindet sich mit dem Hub und tritt der Gruppe bei. */
  async connectHub(
    hubAddress: string,
    groupId?: string,
    sessionToken?: string
  ): Promise<void> {
    const node = await this.ensureNode()
    const hub = new HubClient({
      identity: this.identity,
      hubAddress,
      peer: node,
      sessionToken,
      groupId,
      onConnected: () => this.patch({ hubConnected: true, hubError: null }),
      onDisconnected: (error) => this.patch({ hubConnected: false, hubError: error.message })
    })
    await hub.connect()
    this.hub = hub
    this.patch({ hubConnected: true, hubError: null })
  }

  /** Erstellt eine neue Gruppe auf dem Hub. */
  async createGroup(
    hubAddress: string,
    groupName: string,
    hubToken?: string
  ): Promise<{ group: GroupInfo; invites: InviteInfo[] }> {
    await this.connectHub(hubAddress)
    const hub = this.hub
    if (!hub) throw new Error('Keine Verbindung zum Hub')

    const capability = await this.currentCapability()
    const result = await hub.call<{ kind: 'group'; snapshot: GroupSnapshot; sessionToken: string }>(
      'hub.create',
      {
        groupId: randomUUID(),
        name: groupName,
        displayName: this.identity.displayName,
        publicKey: this.identity.publicKeyBase64,
        peerId: hub.peerId,
        ...(hubToken ? { hubToken } : {})
      }
    )

    const snapshot = result.snapshot
    hub.setSession(result.sessionToken, snapshot.group.groupId)
    await this.saveSession({
      groupId: snapshot.group.groupId,
      hubAddress,
      sessionToken: result.sessionToken
    })
    await this.afterSnapshot(snapshot)
    const invites = await hub.call<{ kind: 'invites'; invites: InviteInfo[] }>('hub.listInvites', {
      groupId: snapshot.group.groupId
    })
    return { group: snapshot.group, invites: invites.invites }
  }

  /** Tritt einer Gruppe mit Einladungscode bei. */
  async joinGroup(
    hubAddress: string,
    groupId: string,
    inviteCode: string
  ): Promise<GroupInfo> {
    await this.connectHub(hubAddress)
    const hub = this.hub
    if (!hub) throw new Error('Keine Verbindung zum Hub')

    const capability = await this.currentCapability()
    const result = await hub.call<{ kind: 'group'; snapshot: GroupSnapshot; sessionToken: string }>(
      'hub.join',
      {
        groupId,
        inviteCode,
        displayName: this.identity.displayName,
        publicKey: this.identity.publicKeyBase64,
        peerId: hub.peerId,
        capability
      }
    )

    const snapshot = result.snapshot
    hub.setSession(result.sessionToken, groupId)
    await this.saveSession({ groupId, hubAddress, sessionToken: result.sessionToken })
    await this.afterSnapshot(snapshot)
    return snapshot.group
  }

  async leaveGroup(): Promise<void> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) return
    try {
      await hub.call('hub.leave', { groupId })
    } catch (err) {
      logger.warn('app', 'Gruppenverlust nicht bestätigt', { error: String(err) })
    }
    await this.saveSession({ groupId: undefined, sessionToken: undefined })
    this.patch({ group: null, members: [], lease: null, world: null })
  }

  // -------------------------------------------------------------------------
  // Gruppenverwaltung
  // -------------------------------------------------------------------------

  async createInvite(name: string, expiresInMs = 0, maxUses = 0): Promise<InviteInfo[]> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) throw new Error('Keine Gruppe verbunden')
    const result = await hub.call<{ kind: 'invites'; invites: InviteInfo[] }>('hub.createInvite', {
      groupId,
      name,
      expiresInMs,
      maxUses
    })
    return result.invites
  }

  async revokeInvite(inviteId: string): Promise<InviteInfo[]> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) throw new Error('Keine Gruppe verbunden')
    const result = await hub.call<{ kind: 'invites'; invites: InviteInfo[] }>('hub.revokeInvite', {
      groupId,
      inviteId
    })
    return result.invites
  }

  async listInvites(): Promise<InviteInfo[]> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) return []
    const result = await hub.call<{ kind: 'invites'; invites: InviteInfo[] }>('hub.listInvites', {
      groupId
    })
    return result.invites
  }

  async removeMember(nodeId: string): Promise<void> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) throw new Error('Keine Gruppe verbunden')
    await hub.call('hub.removeMember', { groupId, nodeId })
    await this.refreshSnapshot()
  }

  async setMemberAllowed(nodeId: string, allowed: boolean): Promise<void> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) throw new Error('Keine Gruppe verbunden')
    await hub.call('hub.setMemberAllowed', { groupId, nodeId, allowed })
    await this.refreshSnapshot()
  }

  async setOwnPriority(priority: number): Promise<void> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) return
    await hub.call('hub.setPriority', { groupId, priority })
    await this.saveSession({})
    const settings = this.state.settings
    await this.updateSettings({ hostingPriority: priority })
    await this.refreshSnapshot()
    void settings
  }

  // -------------------------------------------------------------------------
  // Heartbeat & Leistungsmessung
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat()
    }, 10_000)
    void this.heartbeat()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async heartbeat(): Promise<void> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId || !hub.connected) return

    try {
      const capability = await this.currentCapability()
      const result = await hub.call<{ kind: 'hello'; snapshot: GroupSnapshot }>('hub.heartbeat', {
        groupId,
        capability,
        addresses: capability.network.advertisedAddresses,
        peerId: hub.peerId
      })
      await this.afterSnapshot(result.snapshot)
      this.patch({ hubConnected: true, hubError: null })

      // Lease-Client initialisieren / aktualisieren
      this.ensureLeaseClient(groupId)
      if (this.lease && !this.lease.lease && result.snapshot.lease?.holderId === this.identity.nodeId) {
        // Wir waren der Host - Lease wiederherstellen
        this.lease.restore(result.snapshot.lease)
      }

      // Peer-Discovery aktualisieren
      const discovery = await hub.call<{ kind: 'discovery'; peers: PeerDiscoveryInfo[] }>(
        'hub.discovery',
        { groupId, addresses: capability.network.advertisedAddresses }
      )
      await this.peers?.updatePeers(discovery.peers)

      this.checkFailoverConditions(result.snapshot)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.debug('app', 'Heartbeat fehlgeschlagen', { error: message })
      this.patch({ hubConnected: false, hubError: message })
    }
  }

  private ensureLeaseClient(groupId: string): LeaseClient {
    if (this.lease) return this.lease
    const hub = this.hub
    if (!hub) throw new Error('Keine Verbindung zum Hub')
    this.lease = new LeaseClient({
      call: (type, payload, timeout) => hub.call(type, payload, timeout),
      groupId,
      nodeId: this.identity.nodeId,
      onFence: (reason) => this.handleFencing(reason),
      onLease: (lease) => {
        this.patch({ lease })
        void this.saveSession({ lastEpoch: lease.epoch, lastHostId: lease.holderId })
      }
    })
    this.lease.start()
    return this.lease
  }

  private startPerformanceLoop(): void {
    this.stopPerformanceLoop()
    this.perfTimer = setInterval(() => {
      void this.sampleCapability()
    }, 15_000)
  }

  private stopPerformanceLoop(): void {
    if (this.perfTimer) clearInterval(this.perfTimer)
    this.perfTimer = null
  }

  /** Aktuelle Leistungsdaten als HostCapability. */
  async currentCapability(): Promise<HostCapability> {
    const settings = this.state.settings
    const sample = await this.perf.sample({
      uploadMbps: this.state.capabilities.find((c) => c.nodeId === this.identity.nodeId)?.network.uploadMbps ?? 0,
      downloadMbps: this.state.capabilities.find((c) => c.nodeId === this.identity.nodeId)?.network.downloadMbps ?? 0,
      latencyMs: this.state.capabilities.find((c) => c.nodeId === this.identity.nodeId)?.network.latencyMs ?? 0,
      advertisedAddresses: this.advertisedAddresses()
    })
    const worldSize = this.state.world?.totalBytes ?? 0
    return {
      nodeId: this.identity.nodeId,
      displayName: this.identity.displayName,
      hostingAllowed: settings.hostingAllowed,
      priority: settings.hostingPriority,
      cpu: sample.cpu,
      memory: sample.memory,
      disk: sample.disk,
      network: sample.network,
      java: sample.java,
      stability: sample.stability,
      requiredWorldBytes: worldSize,
      measuredAt: sample.measuredAt
    }
  }

  private advertisedAddresses(): string[] {
    const addrs = this.node?.addresses() ?? []
    return addrs.filter((a) => !a.includes('127.0.0.1') && !a.includes('/ip6/::'))
  }

  private async sampleCapability(): Promise<void> {
    try {
      const capability = await this.currentCapability()
      const capabilities = [
        ...this.state.capabilities.filter((c) => c.nodeId !== capability.nodeId),
        capability
      ]
      this.patch({ capabilities })
      this.patch({ scores: this.computeScores(capabilities) })
    } catch (err) {
      logger.debug('app', 'Leistungsmessung fehlgeschlagen', { error: String(err) })
    }
  }

  private computeScores(capabilities: HostCapability[]): CandidateScore[] {
    const ctx: ElectionContext = {
      requirements: this.requirements(),
      currentHostId: this.state.lease?.holderId ?? null,
      worldReplicaIds: this.state.world?.replicaIds ?? [],
      serverRamBytes: this.state.settings.serverRamBytes
    }
    return scoreCandidates(capabilities, ctx)
  }

  private requirements(): HostRequirements {
    return {
      ...DEFAULT_REQUIREMENTS,
      minRamBytes: Math.max(DEFAULT_REQUIREMENTS.minRamBytes, this.state.settings.serverRamBytes),
      requiredWorldBytes: this.state.world?.totalBytes ?? 0,
      minJavaMajor: 17
    }
  }

  private memberPublicKeys(): Map<string, string> {
    const map = new Map<string, string>()
    for (const m of this.state.members) map.set(m.nodeId, m.publicKey)
    return map
  }

  private peerIdOf(nodeId: string): string | undefined {
    return this.peers?.peer(nodeId)?.peerId
  }

  // -------------------------------------------------------------------------
  // Snapshot verarbeiten
  // -------------------------------------------------------------------------

  private async afterSnapshot(snapshot: GroupSnapshot): Promise<void> {
    this.patch({
      group: snapshot.group,
      members: snapshot.members,
      lease: snapshot.lease,
      world: snapshot.world
    })
    const capabilities = snapshot.members.map((m) => {
      const known = this.state.capabilities.find((c) => c.nodeId === m.nodeId)
      if (known) return { ...known, hostingAllowed: m.hostingAllowed, priority: m.hostingPriority, displayName: m.displayName }
      return null
    })
    const valid = capabilities.filter((c): c is HostCapability => c !== null)
    if (valid.length > 0) {
      this.patch({ capabilities: valid })
      this.patch({ scores: this.computeScores(valid) })
    }
    await this.saveSession({})
  }

  async refreshSnapshot(): Promise<void> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) return
    const result = await hub.call<{ kind: 'hello'; snapshot: GroupSnapshot }>('hub.heartbeat', {
      groupId,
      capability: await this.currentCapability(),
      addresses: this.advertisedAddresses(),
      peerId: hub.peerId
    })
    await this.afterSnapshot(result.snapshot)
  }

  // -------------------------------------------------------------------------
  // Minecraft-Server
  // -------------------------------------------------------------------------

  private serverDir(): string {
    return this.session.serverDir ?? join(Paths.defaultServerDir(), 'default')
  }

  private worldPath(): string {
    return this.session.worldPath ?? join(this.state.settings.worldsDir, this.session.worldName ?? 'world')
  }

  /** Stellt den Minecraft-Server bereit (JAR herunterladen, Konfiguration). */
  async prepareServer(): Promise<{ ok: boolean; error?: string }> {
    try {
      const settings = this.state.settings
      const jar = await ensurePaperJar(settings.mcVersion)
      const dir = this.serverDir()
      mkdirSync(dir, { recursive: true })
      await this.saveSession({ serverDir: dir })
      this.server = new MinecraftServerManager({
        serverDir: dir,
        jarPath: jar.path,
        ramBytes: settings.serverRamBytes,
        port: settings.serverPort,
        worldPath: this.worldPath(),
        levelName: 'world',
        mcVersion: settings.mcVersion,
        javaPath: (await this.perf.detectJava()).path || undefined,
        onLog: (line) => {
          this.serverLogs.push({ ts: line.ts, level: line.level, message: line.message })
          if (this.serverLogs.length > 500) this.serverLogs.shift()
        },
        onStateChange: (state) => {
          this.patch({ server: { ...this.state.server, state } })
        }
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Server konnte nicht vorbereitet werden', { error: message })
      return { ok: false, error: message }
    }
  }

  /** Startet den Minecraft-Server (nur wenn die Lease gehalten wird). */
  async startServer(force = false): Promise<{ ok: boolean; error?: string }> {
    if (!this.server) {
      const prepared = await this.prepareServer()
      if (!prepared.ok) return prepared
    }
    const server = this.server
    if (!server) return { ok: false, error: 'Server nicht vorbereitet' }

    // Fencing-Pruefung: ohne gueltige Lease wird nicht gestartet.
    if (!force && this.state.group) {
      if (!this.lease?.lease) {
        return {
          ok: false,
          error:
            'Kein Host-Lease vorhanden - der Server wird nicht gestartet, damit nicht zwei Hosts dieselbe Welt beschreiben'
        }
      }
      if (this.lease.fenced) {
        return { ok: false, error: 'Dieser Host ist gefenced (Lease verloren) - Start nicht erlaubt' }
      }
    }

    try {
      await server.start()
      this.patch({ server: server.status() })
      await this.commitWorldVersion('start')
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.patch({ server: { ...this.state.server, state: 'crashed', lastError: message } })
      return { ok: false, error: message }
    }
  }

  /** Stoppt den Minecraft-Server kontrolliert (Welt wird gespeichert). */
  async stopServer(): Promise<void> {
    await this.server?.stop(90_000)
    if (this.server) this.patch({ server: this.server.status() })
  }

  serverLogsTail(limit = 200): Array<{ ts: number; level: string; message: string }> {
    return this.serverLogs.slice(-limit)
  }

  // -------------------------------------------------------------------------
  // Weltverwaltung
  // -------------------------------------------------------------------------

  /** Vorhandene Welten im Weltspeicher auflisten. */
  listLocalWorlds(): Array<{ path: string; name: string; dataVersion: number }> {
    return listWorldsIn(this.state.settings.worldsDir)
  }

  /**
   * Importiert eine bestehende Welt in den Weltspeicher.
   * Die Kompatibilitaet mit der konfigurierten Server-Version wird geprueft.
   */
  async importWorld(
    sourcePath: string,
    name: string,
    overwrite = false
  ): Promise<{ ok: boolean; error?: string; info?: ReturnType<typeof readWorldInfo> }> {
    try {
      if (!looksLikeWorldDir(sourcePath)) {
        return { ok: false, error: 'Der gewählte Ordner enthält keine Minecraft-Welt (level.dat fehlt)' }
      }
      const integrity = checkWorldIntegrity(sourcePath)
      if (!integrity.ok) {
        return { ok: false, error: `Welt ist nicht lesbar: ${integrity.problems.join(', ')}` }
      }
      const info = integrity.info
      if (!info) return { ok: false, error: 'Welt konnte nicht gelesen werden' }

      const target = join(this.state.settings.worldsDir, name)
      if (existsSync(target) && !overwrite) {
        return { ok: false, error: `Eine Welt mit dem Namen "${name}" existiert bereits` }
      }
      mkdirSync(this.state.settings.worldsDir, { recursive: true })
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })

      await copyDirectory(sourcePath, target)

      // Die importierte Welt muss in das Serververzeichnis verlinkt werden.
      await this.saveSession({ worldName: name, worldPath: target })
      this.journal.append('world-import', { source: sourcePath, target, dataVersion: info.dataVersion })
      logger.info('app', 'Welt importiert', { source: sourcePath, target, name })
      return { ok: true, info: readWorldInfo(target) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Welt-Import fehlgeschlagen', { error: message })
      return { ok: false, error: message }
    }
  }

  /** Prueft die Integritaet der aktiven Welt. */
  checkWorld(): { ok: boolean; problems: string[]; warnings: string[] } {
    const result = checkWorldIntegrity(this.worldPath())
    return { ok: result.ok, problems: result.problems, warnings: result.warnings }
  }

  /** Berechnet das Manifest der aktiven Welt. */
  async currentManifest(): Promise<Awaited<ReturnType<typeof buildManifest>>> {
    const info = readWorldInfo(this.worldPath())
    return buildManifest({
      worldPath: this.worldPath(),
      worldName: this.session.worldName ?? 'world',
      mcVersion: this.state.settings.mcVersion,
      dataVersion: info?.dataVersion ?? 0
    })
  }

  /** Meldet die aktuelle Weltversion beim Hub an. */
  async commitWorldVersion(reason: string): Promise<WorldRegistryEntry | null> {
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId || !this.lease?.lease) return null
    try {
      const manifest = await this.currentManifest()
      const entry = await hub.call<{ kind: 'world'; entry: WorldRegistryEntry | null }>(
        'hub.worldCommit',
        {
          groupId,
          epoch: this.lease.lease.epoch,
          versionId: manifest.versionId,
          worldName: manifest.worldName,
          mcVersion: manifest.mcVersion,
          dataVersion: manifest.dataVersion,
          totalBytes: manifest.totalBytes,
          replicaIds: this.state.world?.replicaIds ?? []
        }
      )
      this.patch({ world: entry.entry })
      await this.saveSession({ lastWorldVersionId: manifest.versionId })
      this.journal.append('world-commit', { reason, versionId: manifest.versionId, epoch: this.lease.epoch })
      return entry.entry
    } catch (err) {
      logger.warn('app', 'Welt-Commit fehlgeschlagen', { error: String(err) })
      return null
    }
  }

  /** Liefert die Welt fuer eine Anfrage eines anderen Mitglieds. */
  private async provideWorld(): Promise<{ worldPath: string; manifest: Awaited<ReturnType<typeof buildManifest>> } | null> {
    // Nur weitergeben, wenn wir selbst der Host sind und die Welt konsistent ist.
    if (!this.lease?.lease || this.lease.fenced) return null
    if (this.server && this.server.status().state === 'running') return null
    const path = this.worldPath()
    if (!existsSync(path)) return null
    try {
      const manifest = await this.currentManifest()
      return { worldPath: path, manifest }
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Backups
  // -------------------------------------------------------------------------

  private startBackupTimer(): void {
    this.stopBackupTimer()
    const minutes = Math.max(1, this.state.settings.backupIntervalMinutes)
    this.backupTimer = setInterval(() => {
      void this.createBackup('auto')
    }, minutes * 60_000)
  }

  private stopBackupTimer(): void {
    if (this.backupTimer) clearInterval(this.backupTimer)
    this.backupTimer = null
  }

  /**
   * Erstellt ein Backup. Die Welt wird zuvor kontrolliert gespeichert, damit
   * das Backup konsistent ist.
   */
  async createBackup(kind: BackupKind): Promise<{ ok: boolean; error?: string; info?: BackupInfo }> {
    try {
      const server = this.server
      if (server && server.status().state === 'running') {
        await server.save()
        await delay(800)
      }
      const manifest = await this.currentManifest()
      const result = await this.backups.createBackup(kind, {
        worldPath: this.worldPath(),
        manifest,
        worldVersionId: manifest.versionId,
        mcVersion: manifest.mcVersion,
        dataVersion: manifest.dataVersion,
        worldName: manifest.worldName
      })
      if (!result.ok) {
        return { ok: false, error: result.error }
      }
      const backups = this.backups.list()
      this.patch({ backups })
      this.journal.append('backup', { kind, id: result.info.id, size: result.info.sizeBytes })
      return { ok: true, info: result.info }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Backup fehlgeschlagen', { error: message })
      return { ok: false, error: message }
    }
  }

  async listBackups(): Promise<BackupInfo[]> {
    const list = await this.backups.verifyAll()
    this.patch({ backups: list })
    return list
  }

  async restoreBackup(id: string): Promise<{ ok: boolean; error?: string }> {
    const info = this.backups.list().find((b) => b.id === id)
    if (!info) return { ok: false, error: 'Backup nicht gefunden' }

    // Vor dem Restore ein Safety-Backup anlegen, damit nichts verloren geht.
    await this.createBackup('pre-restore')

    const serverRunning = this.server?.status().state === 'running'
    if (serverRunning) await this.server?.stop(90_000)

    const result = await this.backups.restore(info, this.worldPath())
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Wiederherstellung fehlgeschlagen' }
    }
    this.journal.append('backup-restore', { id, versionId: info.worldVersionId })
    logger.info('app', 'Backup wiederhergestellt', { id })
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Host-Wechsel / Failover
  // -------------------------------------------------------------------------

  /**
   * Prueft, ob ein Host-Wechsel noetig ist.
   *
   * Wichtig: Es wird nur dann gewechselt, wenn der Hub die Lease als
   * abgelaufen meldet. Das verhindert Split-Brain: Der Hub ist die einzige
   * Instanz, die entscheidet, ob der bisherige Host noch schreiben darf.
   */
  private checkFailoverConditions(snapshot: GroupSnapshot): void {
    if (this.takeoverInProgress) return
    if (!this.state.group) return

    const lease = snapshot.lease
    const myId = this.identity.nodeId

    // Wir sind bereits Host - nichts zu tun.
    if (lease?.holderId === myId) {
      if (this.state.failover.phase !== 'idle' && this.state.failover.phase !== 'completed') {
        this.patch({ failover: defaultFailoverState() })
      }
      return
    }

    // Kein Host oder Lease noch gueltig -> nichts tun, der Hub entscheidet.
    if (!lease) return

    // Lease abgelaufen? Dann ist eine Uebernahme moeglich.
    const expired = lease.expiresAt <= Date.now()
    if (!expired) return

    // Ist der bisherige Host ueberhaupt noch in der Gruppe / online?
    const holder = snapshot.members.find((m) => m.nodeId === lease.holderId)
    if (holder?.online) {
      // Der Hub meldet den Host noch als online - er ist vermutlich nur
      // langsamer. Wir warten, bis die Lease wirklich abgelaufen ist.
      return
    }

    void this.attemptTakeover(lease)
  }

  /**
   * Versucht, die Host-Rolle zu uebernehmen.
   */
  async attemptTakeover(previousLease: HostLease | null): Promise<{ ok: boolean; reason: string }> {
    if (this.takeoverInProgress) return { ok: false, reason: 'Übernahme läuft bereits' }
    const leaseClient = this.ensureLeaseClient(this.session.groupId ?? '')
    const groupId = this.session.groupId
    if (!groupId) return { ok: false, reason: 'Keine Gruppe' }

    this.takeoverInProgress = true
    const startedAt = Date.now()
    this.patch({
      failover: {
        phase: 'detected',
        fromNodeId: previousLease?.holderId ?? null,
        toNodeId: this.identity.nodeId,
        epoch: previousLease?.epoch ?? 0,
        startedAt,
        updatedAt: startedAt,
        message: 'Host-Ausfall erkannt - Lease wird angefordert',
        warnings: []
      }
    })

    try {
      const result = await leaseClient.acquire(this.state.settings.hostingPriority)
      if (!result.granted || !result.lease) {
        this.patch({
          failover: {
            ...this.state.failover,
            phase: 'blocked',
            updatedAt: Date.now(),
            message: `Übernahme nicht möglich: ${result.reason}`
          }
        })
        return { ok: false, reason: result.reason }
      }

      const epoch = result.lease.epoch
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'lease-acquired',
          epoch,
          updatedAt: Date.now(),
          message: `Lease mit Epoche ${epoch} übernommen`
        }
      })
      this.journal.append('lease-acquired', { epoch, from: previousLease?.holderId })

      // 1) Welt bereitstellen
      const worldReady = await this.obtainWorld(epoch)
      if (!worldReady.ok) {
        this.patch({
          failover: {
            ...this.state.failover,
            phase: 'failed',
            updatedAt: Date.now(),
            message: worldReady.reason,
            warnings: worldReady.warnings
          }
        })
        this.journal.append('takeover-failed', { reason: worldReady.reason })
        return { ok: false, reason: worldReady.reason }
      }

      // 2) Server starten
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'starting',
          updatedAt: Date.now(),
          message: 'Welt verfügbar - Server wird gestartet'
        }
      })
      const start = await this.startServer(true)
      if (!start.ok) {
        this.patch({
          failover: {
            ...this.state.failover,
            phase: 'failed',
            updatedAt: Date.now(),
            message: `Server-Start fehlgeschlagen: ${start.error}`
          }
        })
        this.journal.append('takeover-failed', { reason: start.error })
        return { ok: false, reason: start.error ?? 'Server-Start fehlgeschlagen' }
      }

      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'completed',
          updatedAt: Date.now(),
          message: 'Host-Wechsel abgeschlossen'
        }
      })
      await this.saveSession({ successfulHosts: (this.session.successfulHosts ?? 0) + 1 })
      this.journal.append('takeover-completed', { epoch })
      return { ok: true, reason: 'Host-Wechsel abgeschlossen' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'failed',
          updatedAt: Date.now(),
          message: `Fehler bei der Übernahme: ${message}`
        }
      })
      logger.error('app', 'Host-Übernahme fehlgeschlagen', { error: message })
      return { ok: false, reason: message }
    } finally {
      this.takeoverInProgress = false
    }
  }

  /**
   * Besorgt die Welt fuer den neuen Host.
   *
   * Reihenfolge:
   *  1. Die Welt liegt bereits lokal vor (gleiche versionId) -> fertig.
   *  2. Der letzte Host ist erreichbar -> Welt von ihm anfordern.
   *  3. Eine Replik ist erreichbar -> Welt von dort anfordern.
   *  4. Es existiert ein lokales Backup -> daraus wiederherstellen.
   *  5. Sonst: kein sicherer Start moeglich.
   */
  private async obtainWorld(epoch: number): Promise<{ ok: boolean; reason: string; warnings: string[] }> {
    const warnings: string[] = []
    const world = this.state.world
    const hub = this.hub
    const groupId = this.session.groupId
    if (!hub || !groupId) return { ok: false, reason: 'Keine Verbindung zum Hub', warnings }

    if (!world) {
      // Kein bekannter Weltstand - es kann eine frische Welt erzeugt werden.
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'starting',
          updatedAt: Date.now(),
          message: 'Kein bekannter Weltstand - es wird eine neue Welt angelegt'
        }
      })
      return { ok: true, reason: 'Neue Welt', warnings }
    }

    // 1) Lokal bereits vorhanden?
    const localInfo = readWorldInfo(this.worldPath())
    if (localInfo && localInfo.dataVersion > 0) {
      const localManifest = await this.currentManifest()
      if (localManifest.versionId === world.versionId) {
        return { ok: true, reason: 'Welt ist bereits lokal vorhanden', warnings }
      }
    }

    // 2) Vom letzten Host anfordern
    const candidates = [world.ownerId, ...world.replicaIds].filter(
      (id) => id && id !== this.identity.nodeId
    )
    for (const providerId of candidates) {
      const peer = this.peers?.peer(providerId)
      if (!peer) continue
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'transferring',
          updatedAt: Date.now(),
          message: `Welt wird von ${peer.displayName} übertragen`
        }
      })
      const staging = join(Paths.tmp(), `world-${epoch}-${Date.now()}`)
      mkdirSync(staging, { recursive: true })

      const expected = {
        versionId: world.versionId,
        worldName: world.worldName,
        mcVersion: world.mcVersion,
        dataVersion: world.dataVersion,
        createdAt: Date.now(),
        totalBytes: world.totalBytes,
        entryCount: 0,
        entries: []
      }
      // Das Manifest des Anbieters wird im Angebot mitgeliefert.
      const result = await this.requestWorldFrom(providerId, staging, expected)
      if (result.ok) {
        const verified = await this.verifyAndActivate(staging, result.versionId ?? world.versionId)
        if (verified.ok) {
          this.patch({
            failover: {
              ...this.state.failover,
              phase: 'verifying',
              updatedAt: Date.now(),
              message: 'Welt übertragen und verifiziert'
            }
          })
          return { ok: true, reason: 'Welt übertragen', warnings }
        }
        warnings.push(...verified.problems)
      } else {
        warnings.push(`Übertragung von ${peer.displayName} fehlgeschlagen: ${result.error}`)
      }
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }

    // 3) Aus einem lokalen Backup wiederherstellen
    const localBackups = this.backups.list()
    const matching = localBackups.find((b) => b.worldVersionId === world.versionId)
    if (matching) {
      const restored = await this.backups.restore(matching, this.worldPath())
      if (restored.ok) {
        return { ok: true, reason: 'Welt aus lokalem Backup wiederhergestellt', warnings }
      }
      warnings.push(`Wiederherstellung fehlgeschlagen: ${restored.error}`)
    } else {
      const newest = localBackups[0]
      if (newest) {
        warnings.push(
          `Es existiert kein Backup des letzten Weltstands. Es wird der älteste verfügbare Stand verwendet (${new Date(newest.createdAt).toLocaleString()}) - es kann zu Datenverlust kommen.`
        )
        const restored = await this.backups.restore(newest, this.worldPath())
        if (restored.ok) {
          return { ok: true, reason: 'Welt aus Backup wiederhergestellt (älterer Stand)', warnings }
        }
        warnings.push(`Wiederherstellung fehlgeschlagen: ${restored.error}`)
      }
    }

    return {
      ok: false,
      reason:
        'Es konnte keine verlässliche Weltquelle gefunden werden. Der Server wird NICHT gestartet, damit die Welt nicht beschädigt wird.',
      warnings
    }
  }

  private async requestWorldFrom(
    providerId: string,
    staging: string,
    expected: {
      versionId: string
      worldName: string
      mcVersion: string
      dataVersion: number
      totalBytes: number
    }
  ): Promise<{ ok: boolean; versionId?: string; error?: string }> {
    const peers = this.peers
    if (!peers) return { ok: false, error: 'Kein Peer-Manager' }
    this.patch({
      sync: { ...this.state.sync, phase: 'transferring', message: 'Übertragung läuft' }
    })
    try {
      const result = await peers.requestWorld(providerId, staging, expected as never, {
        onProgress: (progress) => this.patch({ sync: progress })
      })
      this.patch({
        sync: {
          ...this.state.sync,
          phase: result.ok ? 'done' : 'failed',
          message: result.ok ? 'Übertragung abgeschlossen' : (result.error ?? 'Fehler')
        }
      })
      if (!result.ok) return { ok: false, error: result.error ?? 'Fehler' }
      return { ok: true, versionId: result.versionId ?? undefined }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.patch({ sync: { ...this.state.sync, phase: 'failed', message } })
      return { ok: false, error: message }
    }
  }

  private async verifyAndActivate(
    staging: string,
    expectedVersionId: string
  ): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = []
    // Grundlegende Pruefung: level.dat muss vorhanden sein.
    if (!existsSync(join(staging, 'level.dat'))) {
      problems.push('Die übertragene Welt enthält keine level.dat')
      return { ok: false, problems }
    }
    const info = readWorldInfo(staging)
    if (!info) problems.push('Die übertragene Welt konnte nicht gelesen werden')

    activateWorld(staging, this.worldPath(), Paths.quarantine())
    await this.saveSession({ worldPath: this.worldPath() })
    return { ok: problems.length === 0, problems }
  }

  /**
   * Reagiert auf den Verlust der Lease (Fencing).
   * Der Server wird sofort gestoppt - es darf kein zweiter Host entstehen.
   */
  private async handleFencing(reason: string): Promise<void> {
    logger.error('app', 'Fencing aktiv - Server wird gestoppt', { reason })
    this.patch({ fence: 'lost' })
    try {
      await this.server?.quiesceAndStop(60_000)
      if (this.server) this.patch({ server: this.server.status() })
    } catch (err) {
      logger.error('app', 'Server konnte nicht gestoppt werden', { error: String(err) })
      this.server?.kill()
    }
    // Die lokale Welt wird quarantänisiert, damit sie nicht versehentlich
    // als aktuelle Welt verwendet wird.
    try {
      const worldPath = this.worldPath()
      if (existsSync(worldPath)) {
        const quarantine = Paths.quarantine()
        mkdirSync(quarantine, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        renameSync(worldPath, join(quarantine, `fenced-${stamp}`))
        logger.warn('app', 'Welt wegen Fencing in Quarantäne verschoben', { reason })
      }
    } catch (err) {
      logger.warn('app', 'Welt konnte nicht quarantänisiert werden', { error: String(err) })
    }
    await this.saveSession({ failedHosts: (this.session.failedHosts ?? 0) + 1, lastExitReason: reason })
    this.journal.append('fenced', { reason })
    this.patch({
      failover: {
        ...this.state.failover,
        phase: 'blocked',
        updatedAt: Date.now(),
        message: `Dieser Host wurde gefenced: ${reason}`
      }
    })
  }

  /** Manuell einen Host-Wechsel anfordern. */
  async requestTakeover(): Promise<{ ok: boolean; reason: string }> {
    const lease = this.state.lease
    return this.attemptTakeover(lease)
  }

  // -------------------------------------------------------------------------
  // Einstellungen
  // -------------------------------------------------------------------------

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const settings = { ...this.state.settings, ...patch }
    this.patch({ settings })
    await this.settingsStore.save(settings)
    if (patch.backupIntervalMinutes !== undefined) this.startBackupTimer()
    if (patch.backupsDir !== undefined || patch.backupRetention !== undefined) {
      this.backups = new BackupManager({
        backupsDir: settings.backupsDir,
        retention: settings.backupRetention,
        maxSizeBytes: settings.backupMaxSizeMb * 1024 * 1024,
        quarantineDir: Paths.quarantine()
      })
    }
    if (patch.serverRamBytes !== undefined && this.server) {
      this.patch({ server: { ...this.state.server, ramLimitBytes: settings.serverRamBytes } })
    }
    return settings
  }

  setDisplayName(name: string): void {
    this.identity.setDisplayName(name)
    this.patch({ identity: this.identity.identity() })
  }

  /** Journal-Einträge (Diagnose). */
  journalEntries(limit = 200): ReturnType<Journal['read']> {
    return this.journal.read(limit)
  }

  // -------------------------------------------------------------------------
  // Hilfsfunktionen
  // -------------------------------------------------------------------------

  /** Weltpfad des Servers: der Server erwartet die Welt unter <serverDir>/world. */
  async linkWorldToServer(): Promise<void> {
    const serverDir = this.serverDir()
    const target = join(serverDir, 'world')
    const source = this.worldPath()
    mkdirSync(serverDir, { recursive: true })
    if (existsSync(target)) {
      if (target === source) return
      rmSync(target, { recursive: true, force: true })
    }
    if (existsSync(source)) {
      try {
        symlinkSync(source, target, 'junction')
      } catch {
        await copyDirectory(source, target)
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function looksLikeWorldDir(path: string): boolean {
  return existsSync(join(path, 'level.dat'))
}

/** Kopiert ein Verzeichnis rekursiv. */
async function copyDirectory(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, force: true })
}

/** Formatierte Bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export { basename, readdirSync, statSync }
