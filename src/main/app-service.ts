import { existsSync, mkdirSync, renameSync, rmSync, statSync, readdirSync, symlinkSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
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
  WorldCreateRequest,
  WorldCreateInfo,
  WorldGameMode,
  WorldDifficulty,
  WorldRegistryEntry
} from '@shared/types'
import type { InviteInfo, PeerDiscoveryInfo } from '@shared/protocol'
import { peerIdFromAddress } from '@shared/protocol'
import { AtomicStore, Journal } from './core/atomic-store'
import { Paths, localIPv4Addresses } from './core/paths'
import { appVersion } from './core/app-info'
import { logger } from './core/logger'
import { generateEd25519Pem, identityStore } from './security/identity'
import type { IdentityStore } from './security/identity'
import { Keystore } from './security/keystore'
import { createPeerNode } from './net/transport'
import type { PeerNode } from './net/transport'
import { PeerManager } from './net/peer-manager'
import { measureNetworkSpeed } from './net/speed-test'
import { HubClient } from './hub/hub-client'
import { HubNode } from './hub/hub-node'
import { LeaseClient } from './host/lease-client'
import { PerformanceMonitor } from './host/performance'
import { scoreCandidates, selectHost, DEFAULT_REQUIREMENTS } from './host/election'
import type { ElectionContext, HostRequirements } from './host/election'
import { MinecraftServerManager } from './minecraft/server-manager'
import { ensurePaperJar } from './minecraft/jar-manager'
import { DEFAULT_SERVER_CONFIG, ensureServerDir, readOps, updateServerProperties, writeOps } from './minecraft/config'
import { checkWorldIntegrity, listWorldsIn, readWorldInfo } from './minecraft/world'
import { MC_VERSIONS, checkCompatibility, findVersion } from './minecraft/versions'
import { checkFreeDiskSpace, isPortAvailable, validateSeed, validateWorldName } from './minecraft/world-create'
import { resolveWithin, directorySize, PathGuardError } from './security/path-guard'
import { buildManifest, verifyWorld } from './sync/manifest'
import { activateWorld, hasFreeSpace } from './sync/world-sync'
import { BackupManager } from './backup/backup-manager'
import { UpdateManager } from './update/update-manager'
import type { UpdateInfo } from '@shared/types'
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

const WORLD_GAME_MODES: WorldGameMode[] = ['survival', 'creative']
const WORLD_DIFFICULTIES: WorldDifficulty[] = ['peaceful', 'easy', 'normal', 'hard']
const WORLD_CREATE_TIMEOUT_MS = 7 * 60_000

/** true, wenn ein Fehler ein "verschiedene Laufwerke"-Problem ist (EXDEV). */
function isExdevError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EXDEV'
  )
}

/** Uebersetzt PathGuardError in eine verstaendliche Nutzer-Meldung. */
function pathGuardFriendly(err: PathGuardError): string {
  switch (err.code) {
    case 'RESERVED_NAME':
      return 'Dieser Weltname ist unter Windows reserviert und kann nicht verwendet werden.'
    case 'ABSOLUTE_PATH':
    case 'DRIVE_LETTER':
    case 'TRAVERSAL':
    case 'COLON':
      return 'Der Weltname darf keine Pfadangaben (Laufwerksbuchstaben, ":" oder "..") enthalten.'
    case 'WINDOWS_NAME':
      return 'Der Weltname darf nicht mit einem Punkt oder Leerzeichen enden.'
    default:
      return 'Der Weltname ist nicht zulässig.'
  }
}

/**
 * Macht typische Fehler der Welt-Erstellung fuer Nutzer verstaendlich,
 * ohne technische Details zu verlieren.
 */
function worldCreateErrorHint(message: string): string {
  if (/Server-Start abgebrochen/.test(message)) {
    return 'Die Weltgenerierung wurde vom Bootstrap-Server abgebrochen. Die Detailursache steht in den Server-Logs.'
  }
  if (/Download/i.test(message) || /Pruefsumme|checksum/i.test(message)) {
    return `Der Server-Download ist fehlgeschlagen: ${message}`
  }
  if (/timeout|Zeit/i.test(message)) {
    return `Die Weltgenerierung hat zu lange gedauert (Zeitlimit): ${message}`
  }
  if (/ENOSPC|Speicherplatz/i.test(message)) {
    return `Nicht genug Speicherplatz: ${message}`
  }
  return message
}

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
  /**
   * Token des eingebauten Hubs. Wird beim Hub-Start einmalig aufgeloest
   * (Keystore; Migrationspfad: frueher gesetzte Einstellung gewinnt) und
   * anschliessend konsequent verwendet - nie geloggt, nie an fremde
   * Hubs gesendet.
   */
  private embeddedHubToken: string | null = null
  private readonly keystore: Keystore
  private server: MinecraftServerManager | null = null
  private backups: BackupManager
  private perf: PerformanceMonitor

  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private migratedFromDefaults = false
  private backupTimer: NodeJS.Timeout | null = null
  private perfTimer: NodeJS.Timeout | null = null
  private networkTimer: NodeJS.Timeout | null = null
  private failoverTimer: NodeJS.Timeout | null = null
  private started = false
  private takeoverInProgress = false
  /** true, waehrend eine neue Welt generiert wird (Doppel-/Parallelschutz). */
  private worldCreationInProgress = false
  private serverLogs: Array<{ ts: number; level: string; message: string }> = []

  constructor(private readonly opts: AppServiceOptions = {}) {
    if (opts.dataRoot) Paths.setRoot(opts.dataRoot)
    // Eigene Keystore-Instanz: das Modul-Singleton wuerde die Verzeichnisse
    // bereits beim ersten Import einfrieren - vor setRoot von Tests bzw.
    // portablen Installationen.
    this.keystore = new Keystore()
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

  async start(): Promise<void> {    if (this.started) return
    this.started = true
    Paths.ensureAll()

    const settings = this.migrateSettings(this.settingsStore.load())
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

    // Falls die Migration tatbestaendlich war: einmalig persistieren -
    // vor dem Hub-Start, damit der dort persistierte Hub-Port nicht
    // durch die migrierten Defaults wieder ueberschrieben wird.
    if (this.migratedFromDefaults) {
      this.migratedFromDefaults = false
      try {
        await this.settingsStore.save(settings)
        logger.info('app', 'Einstellungen auf aktuelles Schema migriert')
      } catch (err) {
        logger.warn('app', 'Migrierte Einstellungen konnten nicht gespeichert werden', { error: String(err) })
      }
    }

    // Eingebetteten Hub starten (falls aktiv; Port 0 = Zufallsport)
    if (settings.embeddedHubEnabled) {
      await this.startEmbeddedHub()
    }

    const session = this.session
    if (session.groupId && session.hubAddress) {
      // Ein fehlgeschlagener Hub-Kontakt darf die Initialisierung nicht
      // abbrechen (z. B. alter Port nach Wechsel des Hubs). Die
      // Wiederverbindung uebernimmt scheduleReconnect.
      try {
        await this.connectHub(session.hubAddress, session.groupId, session.sessionToken)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('app', 'Hub-Verbindung beim Start fehlgeschlagen', { error: message })
        this.patch({ hubConnected: false, hubError: message })
        this.scheduleReconnect()
      }
    }

    this.startHeartbeat()
    this.startPerformanceLoop()
    this.startBackupTimer()
    this.startNetworkTimer()
    logger.info('app', 'Multi-Mine Host gestartet', { nodeId: this.state.identity?.nodeId })
  }

  async stop(): Promise<void> {
    this.started = false
    this.stopHeartbeat()
    this.stopBackupTimer()
    this.stopPerformanceLoop()
    this.stopNetworkTimer()
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

  /**
   * Ergaenzt fehlende Einstellungsfelder mit Defaults (Migration bei
   * Installationen aus frueheren Versionen).
   */
  private migrateSettings(raw: AppSettings): AppSettings {
    const defaults = defaultSettings()
    const merged: AppSettings = { ...defaults, ...raw }
    this.migratedFromDefaults = JSON.stringify(raw) !== JSON.stringify(merged)
    return merged
  }

  private async startEmbeddedHub(): Promise<void> {
    try {
      const settings = this.state.settings
      // Genau eine Token-Quelle. Rueckwaertskompatible Migration: falls in
      // der Einstellungsdatei noch ein Token liegt (aeltere Versionen),
      // gewinnt es einmalig und wird in den Keystore uebernommen - danach
      // liefert der Keystore dasselbe Token fuer jeden weiteren Start.
      const legacy = (settings.embeddedHubToken ?? '').trim()
      const token = legacy || this.keystore.ensureToken('embedded-hub-token')
      this.embeddedHubToken = token
      if (legacy) this.keystore.set('embedded-hub-token', token)

      // Eigenes Verzeichnis fuer die Hub-Datei.
      const hubDataFile = join(Paths.state(), 'hub-state.json')

      // Persistenter Ed25519-Schluessel: ohne ihn waere die Peer-ID des
      // Hubs bei jedem Start neu und gespeicherte Gruppen-/Sitzungs-
      // adressen waeren wertlos.
      let pem = this.keystore.get('embedded-hub-identity-pem')
      if (!pem) {
        pem = generateEd25519Pem()
        this.keystore.set('embedded-hub-identity-pem', pem)
      }

      // Port-Strategie: fester Port (Einstellung) oder der beim letzten
      // Start konkret gebundene Port. Ist der belegt (EADDRINUSE),
      // faellt der Start auf einen freien Port zurueck und persistiert
      // diesen - so wiederholt sich die Auswahl naechstes Mal korrekt.
      const wanted = settings.embeddedHubPort > 0 ? settings.embeddedHubPort : settings.embeddedHubLastPort
      const attempts = wanted > 0 ? [wanted, 0] : [0]

      let hub: HubNode | null = null
      let lastError: unknown = null
      for (const port of attempts) {
        const candidate = new HubNode({
          listen: [`/ip4/0.0.0.0/tcp/${port}`],
          token,
          dataFile: hubDataFile,
          privateKeyPem: pem
        })
        try {
          await candidate.start()
          hub = candidate
          break
        } catch (err) {
          lastError = err
          try {
            await candidate.stop()
          } catch {
            /* Nicht erfolgreich gestartet - nichts weiter zu raeumen. */
          }
          const busy = /EADDRINUSE|port (?:is )?(?:already )?in use/i.test(String(err))
          if (busy) {
            logger.warn('app', 'Eingebetteter Hub: Port belegt, es wird ein anderer Port benutzt', { port })
            continue
          }
          throw err
        }
      }
      if (!hub) throw lastError ?? new Error('Eingebetteter Hub konnte nicht gestartet werden')

      this.embeddedHub = hub
      const address = this.embeddedHubAddress()
      const bound = Number(/\/tcp\/(\d+)\//.exec(address ?? '')?.[1] ?? 0)
      if (bound > 0 && bound !== settings.embeddedHubLastPort) {
        await this.updateSettings({ embeddedHubLastPort: bound })
      }
      logger.info('app', 'Eingebetteter Hub gestartet', { port: bound > 0 ? bound : 'auto', peerId: hub.peerId })
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

  /** Peer-ID des eingebetteten Hubs (oder null, wenn er nicht laeuft). */
  embeddedHubPeerId(): string | null {
    return this.embeddedHub?.peerId ?? null
  }

  /**
   * Prueft, ob die angegebene Multiaddr auf den eigenen eingebauten Hub
   * zielt. Gemessen wird ueber die Peer-ID (eine oeffentliche Kennung,
   * kein Geheimnis) - der Rest der Adresse (IP/Port) darf vom letzten
   * Start abweichen.
   */
  private isEmbeddedHubAddress(address: string): boolean {
    const hub = this.embeddedHub
    if (!hub) return false
    return peerIdFromAddress(address) === hub.peerId
  }

  /**
   * Reguliert Hub-Adressen auf die aktuell laufende Instanz des
   * eingebauten Hubs, wenn die Peer-ID passt (z. B. alter Port nach
   * Neustart in Einladungslinks oder gespeicherten Sitzungen). Andere
   * Adressen werden unverändert (nur getrimmt) durchgereicht.
   */
  private canonicalHubAddress(address: string): string {
    const trimmed = (address ?? '').trim()
    if (!trimmed) return ''
    if (this.isEmbeddedHubAddress(trimmed)) {
      const current = this.embeddedHubAddress()
      if (current) return current
    }
    return trimmed
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
      quiesceWorld: (requesterId, epoch) => this.quiesceForHandover(requesterId, epoch),
      publicKeys: () => this.memberPublicKeys(),
      peerIdOf: (nodeId) => this.peerIdOf(nodeId),
      backupDir: () => this.state.settings.backupsDir
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
    // Adressen, die auf den eigenen eingebauten Hub zielen (alte Ports
    // nach Neustart), werden auf die laufende Adresse reguliert.
    const target = this.canonicalHubAddress(hubAddress)
    const node = await this.ensureNode()
    const hub = new HubClient({
      identity: this.identity,
      hubAddress: target,
      peer: node,
      sessionToken,
      groupId,
      onConnected: () => this.patch({ hubConnected: true, hubError: null }),
      onDisconnected: (error) => this.patch({ hubConnected: false, hubError: error.message })
    })
    await hub.connect()
    this.hub = hub
    this.patch({ hubConnected: true, hubError: null })
    // Auch die gespeicherte Sitzung auf die laufende Adresse nachziehen,
    // damit der naechste Verbindungsversuch die korrekte Adresse nutzt.
    if (target !== hubAddress.trim()) {
      await this.saveSession({ hubAddress: target })
    }
    // Netzwerkqualitaet zum Hub messen (fliesst in die Host-Bewertung ein)
    void this.measureNetwork()
  }

  /** Erstellt eine neue Gruppe auf dem Hub. */
  async createGroup(
    hubAddress: string,
    groupName: string,
    hubToken?: string
  ): Promise<{ group: GroupInfo; invites: InviteInfo[] }> {
    // Ohne ausdrueckliche Adresse wird der eingebaute Hub genutzt - so
    // funktioniert "Gruppe erstellen" mit einem Klick.
    const requested = (hubAddress ?? '').trim() || this.embeddedHubAddress() || this.state.settings.hubAddress || ''
    const address = this.canonicalHubAddress(requested)
    if (!address) {
      throw new Error(
        'Keine Hub-Adresse verfuegbar. Aktiviere den eingebauten Hub oder gib die Adresse eines externen Hubs an.'
      )
    }
    await this.connectHub(address)
    const hub = this.hub
    if (!hub) throw new Error('Keine Verbindung zum Hub')

    // Genau eine Token-Quelle:
    //  1. Eingabe des Benutzers gewinnt immer (auch am eigenen Hub - ein
    //     falsches Token schlaegt bewusst fehl statt still umgelenkt zu
    //     werden, fail-closed).
    //  2. Am eigenen eingebauten Hub ( gleiche Peer-ID ) wird das Token
    //     dieses Hubs automatisch verwendet, damit "Gruppe erstellen"
    //     ohne manuelle Token-Eingabe funktioniert.
    //  3. An fremden Hubs wird nie das Token des eigenen Hubs gesendet.
    const userToken = hubToken?.trim()
    const token =
      userToken || (this.isEmbeddedHubAddress(address) ? this.embeddedHubToken || undefined : undefined)

    const capability = await this.currentCapability()
    const result = await hub.call<{ kind: 'group'; snapshot: GroupSnapshot; sessionToken: string }>(
      'hub.create',
      {
        groupId: randomUUID(),
        name: groupName,
        displayName: this.identity.displayName,
        publicKey: this.identity.publicKeyBase64,
        peerId: hub.peerId,
        hubAddress: address,
        ...(token ? { hubToken: token } : {})
      }
    )

    const snapshot = result.snapshot
    hub.setSession(result.sessionToken, snapshot.group.groupId)
    await this.saveSession({
      groupId: snapshot.group.groupId,
      hubAddress: address,
      sessionToken: result.sessionToken
    })
    await this.afterSnapshot(snapshot)
    // Die Hub-Adresse bleibt im Einstellungsspeicher erhalten, damit
    // Freunde beim naechsten Start wieder eine funktionierende
    // Koordination haben und der Einladungslink aufgebaut werden kann.
    await this.updateSettings({ hubAddress: address })
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
    // Alte Adressen des eigenen eingebauten Hubs (z. B. aus Einladungslink)
    // auf die laufende Adresse regulieren; Beitritt benoetigt kein Hub-Token.
    const address = this.canonicalHubAddress(hubAddress)
    if (!address) {
      throw new Error('Keine Hub-Adresse angegeben.')
    }
    await this.connectHub(address)
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
    await this.saveSession({ groupId, hubAddress: address, sessionToken: result.sessionToken })
    await this.afterSnapshot(snapshot)
    await this.updateSettings({ hubAddress: address })
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

      // Echtzeit-Spielerzahl per Server-List-Ping (wird sonst nur aus
      // den Server-Logs geschaetzt - der SLP-Ping ist die verlaessliche
      // Quelle und aktualisiert das Dashboard mit echten Zahlen).
      if (this.server?.isRunning) {
        try {
          await this.server.refreshPlayers()
          const status = this.server.status()
          this.patch({ server: { ...this.state.server, ...status } })
        } catch (err) {
          logger.debug('app', 'SLP-Abfrage fehlgeschlagen', { error: String(err) })
        }
      }

      this.checkFailoverConditions(result.snapshot)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.debug('app', 'Heartbeat fehlgeschlagen', { error: message })
      this.patch({ hubConnected: false, hubError: message })
      this.scheduleReconnect()
    }
  }

  /**
   * Plant einen Neuverbindungsversuch, wenn der Hub nicht erreichbar ist.
   * So kommt die Anwendung nach einem Hub-Restart oder Router-Reset
   * von selbst zurueck, ohne dass der Benutzer etwas tun muss.
   */
  private scheduleReconnect(delayMs = 10_000): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnectHub()
    }, delayMs)
  }

  private async reconnectHub(): Promise<void> {
    const groupId = this.session.groupId
    const hubAddress = this.session.hubAddress
    if (!hubAddress || !groupId || !this.started) return
    if (this.hub?.connected) return
    try {
      try {
        await this.hub?.close()
      } catch {
        /* ignore */
      }
      this.hub = null
      await this.connectHub(hubAddress, groupId, this.session.sessionToken)
      this.patch({ hubConnected: true, hubError: null })
      logger.info('app', 'Verbindung zum Hub wiederhergestellt')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.patch({ hubConnected: false, hubError: message })
      // Solidarisch: weiter versuchen (max. alle 15 s).
      this.scheduleReconnect(15_000)
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

  /** Regelmäßige Messung der Netzwerkqualität (alle 5 Minuten). */
  private startNetworkTimer(): void {
    this.stopNetworkTimer()
    this.networkTimer = setInterval(() => {
      void this.measureNetwork()
    }, 5 * 60_000)
  }

  private stopNetworkTimer(): void {
    if (this.networkTimer) clearInterval(this.networkTimer)
    this.networkTimer = null
  }

  /**
   * Misst die Netzwerkqualitaet zum Hub (Bandbreite, Latenz, Jitter).
   * Das Ergebnis fliesst in die Host-Bewertung ein.
   */
  async measureNetwork(): Promise<void> {
    const node = this.node
    const hubAddress = this.session.hubAddress ?? this.state.settings.hubAddress
    if (!node || !hubAddress) return
    try {
      const result = await measureNetworkSpeed(node, hubAddress)
      if (result.downloadMbps <= 0 && result.uploadMbps <= 0) return
      const capabilities = this.state.capabilities.filter(
        (c) => c.nodeId !== this.identity.nodeId
      )
      const own = this.state.capabilities.find((c) => c.nodeId === this.identity.nodeId)
      const updated: HostCapability = {
        nodeId: this.identity.nodeId,
        displayName: this.identity.displayName,
        hostingAllowed: this.state.settings.hostingAllowed,
        priority: this.state.settings.hostingPriority,
        cpu: own?.cpu ?? (await this.perf.sample()).cpu,
        memory: own?.memory ?? (await this.perf.sample()).memory,
        disk: own?.disk ?? (await this.perf.sample()).disk,
        network: {
          uploadMbps: result.uploadMbps,
          downloadMbps: result.downloadMbps,
          latencyMs: result.latencyMs,
          jitterMs: result.jitterMs,
          relayOnly: own?.network.relayOnly ?? false,
          advertisedAddresses: this.advertisedAddresses()
        },
        java: own?.java ?? (await this.perf.sample()).java,
        stability: own?.stability ?? (await this.perf.sample()).stability,
        requiredWorldBytes: this.state.world?.totalBytes ?? 0,
        measuredAt: Date.now()
      }
      const all = [...capabilities, updated]
      this.patch({ capabilities: all })
      this.patch({ scores: this.computeScores(all) })
      logger.info('app', 'Netzwerkqualität gemessen', {
        download: result.downloadMbps,
        upload: result.uploadMbps,
        latency: result.latencyMs
      })
    } catch (err) {
      logger.debug('app', 'Netzwerkmessung fehlgeschlagen', { error: String(err) })
    }
  }

  /** Aktuelle Leistungsdaten als HostCapability. */
  async currentCapability(): Promise<HostCapability> {
    const settings = this.state.settings
    const own = this.state.capabilities.find((c) => c.nodeId === this.identity.nodeId)
    const sample = await this.perf.sample({
      uploadMbps: own?.network.uploadMbps ?? 0,
      downloadMbps: own?.network.downloadMbps ?? 0,
      latencyMs: own?.network.latencyMs ?? 0,
      jitterMs: own?.network.jitterMs ?? 0,
      relayOnly: own?.network.relayOnly ?? false,
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
    // Der Hub verteilt die Leistungsdaten aller Mitglieder - damit kann jeder
    // dieselbe Bewertung berechnen.
    if (snapshot.capabilities.length > 0) {
      const capabilities = snapshot.capabilities.map((c) => {
        const member = snapshot.members.find((m) => m.nodeId === c.nodeId)
        return {
          ...c,
          hostingAllowed: member?.hostingAllowed ?? c.hostingAllowed,
          priority: member?.hostingPriority ?? c.priority,
          displayName: member?.displayName ?? c.displayName
        }
      })
      this.patch({ capabilities })
      this.patch({ scores: this.computeScores(capabilities) })
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
    // Welt gewechselt? Der Server-Manager bindet seine Welt beim Aufbau
    // (Konstruktor-Option). Nach createWorld/selectWorld existiert der alte
    // Manager weiter, waere aber an die vorige Welt gebunden - Status,
    // Preflight und Bereitschaftsbeobachtung bezoege sich auf den falschen
    // Pfad. Solange er nicht laeuft, wird er verworfen und frisch aufgebaut.
    const wantedWorld = this.worldPath()
    if (
      this.server &&
      this.server.worldPath !== wantedWorld &&
      this.server.status().state !== 'running' &&
      this.server.status().state !== 'starting'
    ) {
      logger.info('app', 'Welt gewechselt - Serververwaltung wird neu aufgebaut', {
        oldWorld: this.server.worldPath,
        newWorld: wantedWorld
      })
      this.server = null
    }

    // Der Server läuft bereits -> ok. ABER: Ein laufender Server für eine
    // ANDERE Welt darf nicht als Start der gerade gewählten Welt durchgehen -
    // das Startergebnis würde sonst einen fremden Weltstand als
    // "gewünschter Start" verkaufen und die Oberfläche würde eine andere
    // Welt anzeigen, als tatsächlich läuft (Regression, die im
    // Welt-Erstellungstest aufgedeckt wurde). Klare Absage statt stiller
    // Fortführung.
    if (this.server) {
      const runningState = this.server.status().state
      if (runningState === 'running' || runningState === 'starting') {
        if (this.server.worldPath !== wantedWorld) {
          const oldName = basename(this.server.worldPath)
          const wantedName = basename(wantedWorld)
          return {
            ok: false,
            error:
              `Es läuft bereits ein Server für die Welt "${oldName}". ` +
              `Zum Starten von "${wantedName}" den laufenden Server zuerst stoppen.`
          }
        }
        return { ok: true }
      }
    }
    if (!this.server) {
      const prepared = await this.prepareServer()
      if (!prepared.ok) return prepared
    }
    const server = this.server
    if (!server) return { ok: false, error: 'Server nicht vorbereitet' }

    // Die Welt muss fuer den Server erreichbar sein (<serverDir>/world).
    await this.linkWorldToServer()

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
   * Erstellt eine neue Minecraft-Welt mit den vom Nutzer gewaehlten
   * Einstellungen.
   *
   * Die Welt wird NICHT kuenstlich zusammengebaut: Es wird ein echter
   * Paper-Server in einem temporaeren Verzeichnis gestartet (der gleiche
   * Manager wie im Betrieb, mit allowFreshWorld), Minecraft generiert die
   * Welt selbst, der Server wird kontrolliert gestoppt (save-off ->
   * save-all flush),
   * das Ergebnis gegen die Weltkriterien geprueft und erst dann in den
   * Weltspeicher verschoben. Danach wird die Welt ueber den ueblichen
   * Startpfad (Lease, Hub-Registrierung, Bereitschaftspruefung) gestartet.
   *
   * Ueberschrieben wird nichts: Wenn im Weltspeicher bereits ein Ordner
   * mit gleichem Namen liegt, wird abgelehnt.
   */
  async createWorld(req: WorldCreateRequest): Promise<{
    ok: boolean
    error?: string
    info?: WorldCreateInfo
    startError?: string
  }> {
    if (this.worldCreationInProgress) {
      return { ok: false, error: 'Es läuft bereits eine Welt-Erstellung. Bitte warte, bis der aktuelle Vorgang abgeschlossen ist.' }
    }
    this.worldCreationInProgress = true
    try {
      return await this.createWorldInner(req)
    } finally {
      this.worldCreationInProgress = false
      this.patch({ sync: defaultSyncProgress() })
    }
  }

  private async createWorldInner(req: WorldCreateRequest): Promise<{
    ok: boolean
    error?: string
    info?: WorldCreateInfo
    startError?: string
  }> {
    let bootstrap: MinecraftServerManager | null = null
    /** true = der Bootstrap-Ordner bleibt nach Fehlern fuer Analyse liegen. */
    let keepBootstrapForAnalysis = true
    const bootstrapDir = join(Paths.tmp(), `world-create-${Date.now()}-${randomUUID().slice(0, 8)}`)
    this.patchWorldCreateProgress('Neue Welt vorbereiten - Einstellungen werden geprüft')
    try {
      // 0) Gruppe und Hub: Eine Welt gehoert immer zu einer Gruppe; ohne
      //    Hub gibt es keine Lease und keine Registrierung der Welt.
      if (!this.session.groupId || !this.state.group) {
        return {
          ok: false,
          error:
            'Es ist noch keine Gruppe eingerichtet. Erstelle auf der Seite "Gruppe" eine neue Gruppe, bevor eine Welt angelegt wird.'
        }
      }
      if (!this.hub?.connected) {
        try {
          await this.reconnectHub()
        } catch {
          /* unten deutlich gemeldet */
        }
        if (!this.hub?.connected) {
          return {
            ok: false,
            error:
              'Der Koordinations-Hub ist nicht erreichbar. Eine neue Welt kann nur angelegt werden, solange die Gruppe über den Hub koordiniert wird (Lease, Registrierung).'
          }
        }
      }

      // 1) Weltname (Pfadsicherheit, Ein-Segment, reservierte Namen)
      const name = validateWorldName(req.name)

      // 2) Zielordner: Kollisionen werden abgelehnt, nichts wird ueberschrieben.
      const worldsDir = this.state.settings.worldsDir
      let target: string
      try {
        target = resolveWithin(worldsDir, name)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof PathGuardError ? pathGuardFriendly(err) : 'Der Weltname ist nicht zulässig.'
        }
      }
      if (existsSync(target)) {
        return {
          ok: false,
          error: `Im Weltspeicher existiert bereits ein Ordner "${name}". Wähle eine vorhandene Welt aus (Weltverwaltung) oder wähle einen anderen Namen.`
        }
      }

      // 3) Version: Es werden nur Versionen akzeptiert, die als Paper-Build
      //    verfuegbar sind und von der Anwendung unterstuetzt werden.
      const version = findVersion(req.mcVersion)
      if (!version || !version.paperAvailable) {
        return {
          ok: false,
          error: `Die Minecraft-Version "${req.mcVersion}" wird nicht unterstützt. Verfügbare Versionen: ${MC_VERSIONS.filter((v) => v.paperAvailable).map((v) => v.version).join(', ')}.`
        }
      }

      // 4) Spielmodus und Schwierigkeit (feste Auswahl, nichts Freitextliches)
      if (!WORLD_GAME_MODES.includes(req.gameMode)) {
        return { ok: false, error: 'Ungültiger Spielmodus. Erlaubt sind "Überleben" und "Kreativ".' }
      }
      if (!WORLD_DIFFICULTIES.includes(req.difficulty)) {
        return { ok: false, error: 'Ungültiger Schwierigkeitsgrad. Erlaubt sind Friedlich, Einfach, Normal und Schwer.' }
      }

      // 5) Seed: leer lassen = Minecraft wuerfelt einen Zufalls-Seed
      const seed = validateSeed(req.seed)

      // 6) Port-Verfuegbarkeit: Der Bootstrap-Server und spaeter der
      //    Produktions-Server lauschen auf dem konfigurierten Port. Ist er
      //    belegt (z. B. laufender Server), bricht die Erstellung klar ab.
      this.patchWorldCreateProgress('Neue Welt vorbereiten - Serverport prüfen')
      const portOk = await isPortAvailable(this.state.settings.serverPort)
      if (!portOk) {
        return {
          ok: false,
          error:
            `Der Minecraft-Port ${this.state.settings.serverPort} wird bereits verwendet. Sehr wahrscheinlich läuft gerade ein Server - stoppe ihn bitte oder wähle in den Einstellungen einen freien Port.`
        }
      }

      // 7) Speicherplatz: Pruefen am Ziel- und am Bootstrap-Verzeichnis.
      const spaceTarget = checkFreeDiskSpace(worldsDir)
      if (!spaceTarget.ok) return { ok: false, error: spaceTarget.error ?? 'Nicht genug Speicherplatz.' }
      const spaceTmp = checkFreeDiskSpace(Paths.tmp())
      if (!spaceTmp.ok) return { ok: false, error: spaceTmp.error ?? 'Nicht genug Speicherplatz.' }

      // 8) Server-JAR herunterladen (bestehende Infrastruktur, mit Pruefsumme
      //    und Cache); Fortschritt ist sichtbar.
      const jar = await ensurePaperJar(req.mcVersion, (received, total) => {
        this.patch({
          sync: {
            ...defaultSyncProgress(),
            phase: 'preparing',
            message: `Server-JAR für die neue Welt wird heruntergeladen (${Math.round(received / 1024 / 1024)} MB)`,
            fileIndex: 1,
            fileCount: 1,
            bytesTransferred: received,
            totalBytes: total
          }
        })
      })

      // 9) Bootstrap-Serververzeichnis: EULA, server.properties mit den
      //    gewaehlten Einstellungen. Die Übernahme erfolgt deterministisch
      //    ueber renderServerProperties.
      this.patchWorldCreateProgress('Neue Welt vorbereiten - Serververzeichnis anlegen')
      const bootstrapConfig = {
        ...DEFAULT_SERVER_CONFIG,
        port: this.state.settings.serverPort,
        levelName: 'world',
        gamemode: req.gameMode,
        difficulty: req.difficulty,
        seed: seed ?? undefined
      }
      ensureServerDir(bootstrapDir, { config: bootstrapConfig, ops: [], whitelist: [] })

      // 10) Echter Generierungslauf: Der Server faehrt hoch, generiert die
      //     Startregionen, rendert "Done (...s)!" (Bereitschaft) und wird
      //     danach kontrolliert gestoppt (save-off -> save-all flush -> stop).
      this.patchWorldCreateProgress(
        `Neue Welt "${name}" wird von Minecraft generiert - der erste Serverstart kann einige Minuten dauern`
      )
      bootstrap = new MinecraftServerManager({
        serverDir: bootstrapDir,
        jarPath: jar.path,
        ramBytes: this.state.settings.serverRamBytes,
        port: this.state.settings.serverPort,
        worldPath: join(bootstrapDir, 'world'),
        levelName: 'world',
        mcVersion: req.mcVersion,
        allowFreshWorld: true,
        config: bootstrapConfig,
        javaPath: (await this.perf.detectJava()).path || undefined,
        onLog: (line) => {
          this.serverLogs.push({ ts: line.ts, level: line.level, message: line.message })
          if (this.serverLogs.length > 500) this.serverLogs.shift()
        },
        onStateChange: (state) => {
          this.patch({ server: { ...this.state.server, state } })
        }
      })
      await bootstrap.start({ timeoutMs: WORLD_CREATE_TIMEOUT_MS })
      await bootstrap.quiesceAndStop(90_000)

      // 11) Verifizieren: Es wird nur eine echte, vollstaendig gespeicherte
      //     Welt weiterverwendet - niemals ein angelegter Ordner ohne Inhalt.
      const generatedPath = join(bootstrapDir, 'world')
      const integrity = checkWorldIntegrity(generatedPath)
      if (!integrity.ok || !integrity.info) {
        throw new Error(
          `Die generierte Welt ist unvollständig (${integrity.problems.join(', ') || 'keine level.dat'}). Das Verzeichnis ${bootstrapDir} wurde zur Analyse beibehalten.`
        )
      }

      // 12) In den Weltspeicher verschieben. Der Zielordner existiert nicht
      //     (oben geprueft). Querverweise auf alte Stände gibt es nicht: Die
      //     Welt ist neu und wird erst beim naechsten Start beim Hub
      //     registriert.
      mkdirSync(worldsDir, { recursive: true })
      try {
        renameSync(generatedPath, target)
      } catch (err) {
        if (isExdevError(err)) {
          await copyDirectory(generatedPath, target)
          rmSync(generatedPath, { recursive: true, force: true })
        } else {
          throw err
        }
      }
      // Ab hier ist die Welt gesichert - der Bootstrap-Ordner enthaelt nur
      // noch Konfigurationsreste und wird im finally aufgeraeumt.
      keepBootstrapForAnalysis = false

      // 13) Produktionsserververzeichnis mit denselben Server-Grundeinstellungen
      //     ausstatten (Konfiguration der neuen Welt) und bei "Cheats" den
      //     Ersteller als Operator eintragen.
      const serverDir = this.serverDir()
      ensureServerDir(serverDir, { config: bootstrapConfig, ops: [], whitelist: [] })
      const propsPath = join(serverDir, 'server.properties')
      const currentProps = readFileSync(propsPath, 'utf8')
      writeFileSync(
        propsPath,
        updateServerProperties(currentProps, {
          difficulty: req.difficulty,
          gamemode: req.gameMode
        }),
        'utf8'
      )
      if (req.cheats) {
        const operator = this.identity.displayName
        const operators = readOps(serverDir)
        if (!operators.includes(operator)) writeOps(serverDir, [...operators, operator])
      }

      // 14) Session: Die neue Welt gehoert zu dieser Gruppe/Session. Sie ist
      //     bewusst noch NICHT als synchronisiert/failoverbereit markiert -
      //     das geschieht erst mit dem Hub-Commit beim Serverstart.
      await this.saveSession({ worldName: name, worldPath: target })
      this.journal.append('world-create', {
        worldName: name,
        mcVersion: req.mcVersion,
        dataVersion: integrity.info.dataVersion,
        seed: seed ? 'provided' : 'random',
        cheats: req.cheats
      })
      logger.info('app', 'Neue Welt erstellt', { worldName: name, target, mcVersion: req.mcVersion })

      const info: WorldCreateInfo = {
        worldName: name,
        worldPath: target,
        mcVersion: req.mcVersion,
        gameMode: req.gameMode,
        difficulty: req.difficulty,
        seed: seed ? seed : null,
        cheats: req.cheats,
        sizeBytes: await directorySize(target)
      }

      // 15) Welt starten (ueber den ueblichen Pfad: Lease, Registrierung,
      //     Serverstart mit bestaetigtem Bereitschafts-Check).
      const startResult = await this.startWorld()
      if (!startResult.ok) {
        return {
          ok: true,
          info,
          startError: startResult.error ?? 'Der Start der neu erstellten Welt ist fehlgeschlagen.'
        }
      }
      return { ok: true, info }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Welt-Erstellung fehlgeschlagen', { error: message, bootstrapDir })
      return {
        ok: false,
        error: worldCreateErrorHint(message)
      }
    } finally {
      if (bootstrap) {
        try {
          const st = bootstrap.status()
          if (st.state === 'running' || st.state === 'starting') await bootstrap.stop(30_000)
        } catch {
          /* Bootstrap laeuft nicht mehr - ok */
        }
        bootstrap = null
      }
      if (keepBootstrapForAnalysis && existsSync(bootstrapDir)) {
        // Fehlerfall: Bootstrap-Verzeichnis fuer die Analyse behalten; auf
        // den Ablageort wird in der Fehlermeldung bzw. im Log hingewiesen.
        logger.warn('app', 'Bootstrap-Verzeichnis wurde zur Analyse beibehalten', { bootstrapDir })
      } else if (existsSync(bootstrapDir)) {
        // Erfolg: nur Konfigurationsreste - aufraeumen.
        try {
          rmSync(bootstrapDir, { recursive: true, force: true })
        } catch {
          logger.warn('app', 'Bootstrap-Verzeichnis konnte nicht entfernt werden', { bootstrapDir })
        }
      }
    }
  }

  /** Fortschritt der Welt-Erstellung sichtbar machen (bestehende Sync-Anzeige). */
  private patchWorldCreateProgress(message: string): void {
    this.patch({
      sync: {
        ...defaultSyncProgress(),
        phase: 'preparing',
        message
      }
    })
  }

  /**
   * Waehlt eine bereits im Weltspeicher vorhandene Welt als aktive Welt
   * dieser Session aus (alternative zum Neuerstellen, z. B. nach einem
   * Umzug oder wenn eine Welt woanders generiert wurde). Die Welt wird auf
   * Lesbarkeit und Kompatibilitaet mit der konfigurierten Server-Version
   * geprueft; sie wird nicht veraendert.
   */
  async selectWorld(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const safe = validateWorldName(name)
      let target: string
      try {
        target = resolveWithin(this.state.settings.worldsDir, safe)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof PathGuardError ? pathGuardFriendly(err) : 'Der Weltname ist nicht zulässig.'
        }
      }
      if (!existsSync(target)) {
        return {
          ok: false,
          error: `Unter dem Namen "${safe}" existiert im Weltspeicher keine Welt.`
        }
      }
      const integrity = checkWorldIntegrity(target)
      if (!integrity.ok || !integrity.info) {
        return {
          ok: false,
          error: `Die Welt "${safe}" ist nicht lesbar: ${integrity.problems.join(', ') || 'keine level.dat'}`
        }
      }
      const compat = checkCompatibility(integrity.info.dataVersion, this.state.settings.mcVersion)
      if (!compat.compatible) {
        return {
          ok: false,
          error: `Die Welt "${safe}" (${integrity.info.mcVersion ?? 'unbekannte Version'}) passt nicht zur konfigurierten Server-Version ${this.state.settings.mcVersion}: ${compat.reason}`
        }
      }
      await this.saveSession({ worldName: safe, worldPath: target })
      this.journal.append('world-select', { worldName: safe, target, dataVersion: integrity.info.dataVersion })
      logger.info('app', 'Vorhandene Welt als aktive Welt ausgewählt', { worldName: safe, target })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Auswahl der Welt fehlgeschlagen', { error: message, name })
      return { ok: false, error: message }
    }
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
      // Auf einen zweiten Gruppen-PC replizieren (best effort).
      void this.replicateBackup(result.info)
      return { ok: true, info: result.info }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Backup fehlgeschlagen', { error: message })
      return { ok: false, error: message }
    }
  }

  /**
   * Repliziert ein Backup auf ein anderes Mitglied der Gruppe.
   *
   * Ziel ist ein Mitglied, das online ist, genügend freien Speicher hat und
   * selbst nicht der aktuelle Host ist. Scheitert die Replikation, bleibt das
   * lokale Backup erhalten - es wird nichts gelöscht.
   */
  async replicateBackup(info: BackupInfo): Promise<{ ok: boolean; targetId?: string; error?: string }> {
    const peers = this.peers
    if (!peers) return { ok: false, error: 'Keine Peer-Verbindungen' }

    const needed = info.sizeBytes * 1.2
    const target = this.state.members.find((m) => {
      if (m.nodeId === this.identity.nodeId) return false
      if (!m.online) return false
      const cap = this.state.capabilities.find((c) => c.nodeId === m.nodeId)
      if (!cap) return false
      if (cap.disk.freeBytes < needed) return false
      return peers.peer(m.nodeId) !== undefined
    })

    if (!target) {
      const reasons = this.state.members
        .filter((m) => m.nodeId !== this.identity.nodeId)
        .map(
          (m) =>
            `${m.nodeId}(${m.displayName}): online=${m.online}, capability=${this.state.capabilities.find((c) => c.nodeId === m.nodeId) ? 'ja' : 'nein'}, peer=${peers.peer(m.nodeId) ? 'ja' : 'nein'}`
        )
      logger.warn('app', 'Kein Mitglied für Backup-Replikation geeignet', {
        neededBytes: needed,
        candidates: reasons.join('; ') || 'keine anderen Mitglieder'
      })
      return {
        ok: false,
        error: 'Kein passendes Mitglied für die Replikation gefunden (offline oder zu wenig Speicherplatz)'
      }
    }

    try {
      const result = await peers.sendBackup(target.nodeId, info.path, {
        id: info.id,
        kind: info.kind,
        worldName: info.worldName,
        worldVersionId: info.worldVersionId,
        mcVersion: info.mcVersion,
        dataVersion: info.dataVersion,
        sizeBytes: info.sizeBytes,
        uncompressedBytes: info.uncompressedBytes,
        sha256: info.sha256,
        createdAt: info.createdAt
      })
      if (!result.ok) {
        logger.warn('app', 'Backup-Replikation fehlgeschlagen', {
          target: target.nodeId,
          error: result.error
        })
        return { ok: false, targetId: target.nodeId, error: result.error }
      }
      info.replicated = true
      const list = this.backups.list().map((b) => (b.id === info.id ? { ...b, replicated: true } : b))
      this.patch({ backups: list })
      this.journal.append('backup-replicated', { id: info.id, target: target.nodeId })
      logger.info('app', 'Backup repliziert', { id: info.id, target: target.displayName })
      return { ok: true, targetId: target.nodeId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('app', 'Backup-Replikation fehlgeschlagen', { error: message })
      return { ok: false, targetId: target.nodeId, error: message }
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

    // Es ist ueberhaupt kein Host bestimmt. Dann uebernimmt ein Mitglied,
    // sofern es hostingfaehig ist. Es ist auch ok, wenn noch keine Welt
    // registriert ist: Der erste Host beginnt mit seiner (möglicherweise
    // neu angelegten oder lokal importierten) Welt.
    if (!lease) {
      if (!this.state.settings.hostingAllowed) return
      void this.attemptTakeover(null)
      return
    }

    // Die Lease laeuft noch - der Host ist berechtigt.
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
   * Führt den kontrollierten Herunterfahren aus, wenn ein anderes Mitglied
   * die Host-Rolle übernommen hat.
   *
   * Ablauf: save-off -> save-all flush -> Server stoppen -> Weltversion
   * ermitteln. Erst danach darf der neue Host die Welt übernehmen.
   */
  async quiesceForHandover(
    requesterNodeId: string,
    newEpoch: number
  ): Promise<{ ok: boolean; versionId: string; error?: string }> {
    const myEpoch = this.lease?.epoch ?? 0
    if (newEpoch <= myEpoch) {
      return {
        ok: false,
        versionId: '',
        error: `Die angeforderte Epoche ${newEpoch} ist nicht neuer als die eigene (${myEpoch})`
      }
    }

    // Wenn der Hub erreichbar ist, verifizieren wir dort, wer die Lease hält.
    const hub = this.hub
    const groupId = this.session.groupId
    if (hub && groupId) {
      try {
        const status = await hub.call<{ kind: 'leaseStatus'; lease: HostLease | null }>(
          'hub.leaseStatus',
          { groupId },
          5_000
        )
        if (status.lease && status.lease.holderId !== requesterNodeId) {
          return {
            ok: false,
            versionId: '',
            error: `Der Hub führt weiterhin ${status.lease.holderId} als Host`
          }
        }
      } catch (err) {
        // Hub nicht erreichbar -> wir vertrauen der signierten Anfrage.
        logger.warn('app', 'Hub bei der Übergabe nicht erreichbar - signierte Anfrage wird akzeptiert', {
          error: String(err)
        })
      }
    }

    logger.info('app', 'Kontrollierte Übergabe an neues Mitglied', {
      requester: requesterNodeId,
      newEpoch
    })

    try {
      if (this.server) {
        const status = this.server.status()
        if (status.state === 'running' || status.state === 'starting') {
          await this.server.quiesceAndStop(90_000)
          this.patch({ server: this.server.status() })
        }
      }
      const manifest = await this.currentManifest()
      this.journal.append('quiesce', { requester: requesterNodeId, newEpoch, versionId: manifest.versionId })
      logger.info('app', 'Server kontrolliert gestoppt - Welt ist konsistent', {
        versionId: manifest.versionId
      })
      return { ok: true, versionId: manifest.versionId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('app', 'Kontrollierte Übergabe fehlgeschlagen', { error: message })
      this.journal.append('quiesce-failed', { requester: requesterNodeId, error: message })
      return { ok: false, versionId: '', error: message }
    }
  }

  /**
   * Besorgt die Welt fuer den neuen Host.
   *
   * Reihenfolge:
   *  1. Die Welt liegt bereits lokal vor (gleiche versionId) -> fertig.
   *  2. Der letzte Host ist erreichbar -> kontrolliert herunterfahren und
   *     die Welt von ihm anfordern.
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
      // Kein bekannter Weltstand im Hub. Wenn lokal bereits eine Welt
      // vorliegt (z. B. gerade importiert), wird sie verwendet - sonst
      // bricht die Uebernahme klar ab: Eine Welt darf nicht stillschweigend
      // vom Server generiert werden, weil sonst zwei Hosts unabhaengig
      // dieselbe Welt initialisieren koennten. Die Oberflaeche fuehrt den
      // Host stattdessen durch "Neue Welt erstellen" bzw. "Vorhandene Welt
      // auswaehlen" (createWorld/selectWorld).
      const localInfo = readWorldInfo(this.worldPath())
      if (localInfo && localInfo.dataVersion > 0) {
        this.patch({
          failover: {
            ...this.state.failover,
            phase: 'starting',
            updatedAt: Date.now(),
            message: 'Welt wird lokal bereitgestellt (noch ohne Eintrag im Hub)'
          }
        })
        return { ok: true, reason: 'Lokale Welt ohne Hub-Eintrag', warnings }
      }
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'blocked',
          updatedAt: Date.now(),
          message: 'Keine Welt vorhanden - bitte zuerst eine Welt erstellen oder auswählen'
        }
      })
      return {
        ok: false,
        reason:
          'Keine Welt vorhanden: Erstelle eine neue Welt oder wähle eine bereits vorhandene Welt aus, bevor der Server gestartet wird.',
        warnings
      }
    }

    // 1) Lokal bereits vorhanden?
    const localInfo = readWorldInfo(this.worldPath())
    if (localInfo && localInfo.dataVersion > 0) {
      const localManifest = await this.currentManifest()
      if (localManifest.versionId === world.versionId) {
        return { ok: true, reason: 'Welt ist bereits lokal vorhanden', warnings }
      }
    }

    // 2) Vom letzten Host anfordern (mit kontrolliertem Herunterfahren)
    const candidates = [world.ownerId, ...world.replicaIds].filter(
      (id) => id && id !== this.identity.nodeId
    )
    for (const providerId of candidates) {
      const peer = this.peers?.peer(providerId)
      if (!peer) continue

      // 2a) Den bisherigen Host bitten, den Server kontrolliert zu stoppen.
      //     Ohne diese Bestaetigung koennte er noch in die Welt schreiben.
      this.patch({
        failover: {
          ...this.state.failover,
          phase: 'draining',
          updatedAt: Date.now(),
          message: `${peer.displayName} wird aufgefordert, den Server kontrolliert zu stoppen`
        }
      })
      const quiesce = await this.peers?.requestQuiesce(providerId, epoch)
      if (quiesce && !quiesce.ok) {
        // Der Host ist vermutlich nicht erreichbar (Absturz) - das ist ok,
        // dann wird die letzte bekannte Weltversion verwendet.
        logger.info('app', 'Kontrollierte Übergabe nicht möglich - Host vermutlich ausgefallen', {
          provider: providerId,
          reason: quiesce.error
        })
      }

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

  /**
   * Ein-Klick-Start: Alles, was benoetigt wird, um eine Welt zu hosten.
   *
   * 1. Konfiguration und Gruppe pruefen (klare Fehlermeldung, wenn nichts
   *    eingerichtet ist)
   * 2. Verbindung zum Hub sicherstellen (automatischer Neuverbindungsversuch)
   * 3. Host-Lease erwerben, falls wir sie noch nicht halten (Winners
   *    koennen die Welt beschreiben, Verlierer blockiert)
   * 4. Welt bereitstellen (lokal, vom Host, aus Backup oder neu)
   * 5. Minecraft-Server starten (idempotent, mit Bereitschaftscheck)
   *
   * Der Ablauf nutzt dieselben Mechanismen wie das Failover - es entsteht
   * kein zweiter Synchronisationspfad.
   */
  async startWorld(): Promise<{ ok: boolean; error?: string; worldMissing?: boolean }> {
    const myId = this.identity.nodeId

    // 1) Konfiguration und Gruppe
    if (!this.session.groupId || !this.state.group) {
      return {
        ok: false,
        error:
          'Es ist noch keine Gruppe eingerichtet. Erstelle auf der Seite "Gruppe" eine neue Gruppe oder trete mit einem Einladungscode bei.'
      }
    }
    if (!this.session.hubAddress && !this.state.settings.hubAddress) {
      return {
        ok: false,
        error:
          'Es ist keine Hub-Adresse bekannt. Auf dem eigenen PC muss der eingebaute Hub aktiv sein (Einstellungen), oder es ist die Adresse eines externen Hubs einzutragen.'
      }
    }

    // 2) Hub-Verbindung
    if (!this.hub?.connected) {
      try {
        await this.reconnectHub()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          error: `Der Koordinations-Hub ist nicht erreichbar (${message}). Ohne Hub kann keine Host-Lease veroeffentlicht werden - ein gleichzeitiges Schreiben mehrerer Hosts waere nicht auszuschliessen.`
        }
      }
    }
    if (!this.hub?.connected) {
      return {
        ok: false,
        error: 'Der Koordinations-Hub ist nicht erreichbar - die Anwendung versucht es automatisch weiter. Bitte spaeter erneut versuchen.'
      }
    }

    // 2b) Gibt es ueberhaupt eine Welt? Nur wenn der Hub keinen Weltstand
    //     kennt UND lokal keine Welt liegt, fuehrt der Start nicht durch
    //     Trotziges Weitermachen ins Leere, sondern verweist die Oberflaeche
    //     auf die Auswahl "Neue Welt erstellen" / "Vorhandene Welt auswaehlen".
    const hasHubWorld = this.state.world != null
    const hasLocalWorld = readWorldInfo(this.worldPath()) != null
    if (!hasHubWorld && !hasLocalWorld) {
      return {
        worldMissing: true,
        ok: false,
        error:
          'Auf diesem Host ist noch keine Welt eingerichtet. Erstelle eine neue Welt oder wähle eine vorhandene Welt aus.'
      }
    }

    // 3) + 4) + 5) Lease, Welt und Server (ueber den bewaehrten Uebernahme-Pfad)
    const holdingLease = this.state.lease?.holderId === myId
    if (holdingLease) {
      const start = await this.startServer(false)
      if (!start.ok) return { ok: false, error: start.error }
      return { ok: true }
    }
    const takeover = await this.attemptTakeover(this.state.lease)
    if (!takeover.ok) return { ok: false, error: takeover.reason }
    return { ok: true }
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

  /**
   * Adresse, unter der der Minecraft-Server erreichbar ist.
   *
   * Wird in der Oberfläche angezeigt, damit Spieler wissen, wohin sie sich
   * verbinden müssen. Nach einem Host-Wechsel ändert sich die Adresse.
   */
  serverAddresses(): string[] {
    const port = this.state.settings.serverPort
    const local = localIPv4Addresses()
    const nodeAddrs = this.advertisedAddresses()
    const hostPart = nodeAddrs
      .map((a) => {
        const match = /\/ip4\/([^/]+)/.exec(a)
        return match?.[1]
      })
      .filter((a): a is string => !!a)
    const unique = [...new Set([...local, ...hostPart])]
    return unique.map((ip) => `${ip}:${port}`)
  }

  /** Journal-Einträge (Diagnose). */
  journalEntries(limit = 200): ReturnType<Journal['read']> {
    return this.journal.read(limit)
  }

  /**
   * Prüft, ob eine neuere Version verfügbar ist.
   */
  async checkForUpdates(): Promise<UpdateInfo> {
    const manager = new UpdateManager({
      repository: 'rara-blip99/multi-mine_host',
      currentVersion: this.appVersion,
      downloadDir: join(Paths.root(), 'updates')
    })
    return manager.check()
  }

  /** Version der laufenden Anwendung. */
  get appVersion(): string {
    return appVersion()
  }

  // -------------------------------------------------------------------------
  // Hilfsfunktionen
  // -------------------------------------------------------------------------

  /**
   * Weltpfad des Servers: der Server erwartet die Welt unter <serverDir>/world.
   *
   * Die Welt wird nicht kopiert, sondern per Junction (Windows) bzw. Symlink
   * verknuepft. Die Daten bleiben dadurch an genau einer Stelle.
   */
  async linkWorldToServer(): Promise<void> {
    const serverDir = this.serverDir()
    const target = join(serverDir, 'world')
    const source = this.worldPath()
    mkdirSync(serverDir, { recursive: true })
    if (existsSync(target)) {
      if (target === source) return
      // Bestehende Verknuepfung entfernen, echtes Verzeichnis in die
      // Quarantäne verschieben (nicht einfach löschen!).
      try {
        const st = lstatSync(target)
        if (st.isSymbolicLink()) {
          rmSync(target, { force: true })
        } else {
          const quarantine = Paths.quarantine()
          mkdirSync(quarantine, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          renameSync(target, join(quarantine, `server-world-${stamp}`))
        }
      } catch {
        rmSync(target, { recursive: true, force: true })
      }
    }
    if (!existsSync(source)) return
    try {
      symlinkSync(source, target, 'junction')
      logger.info('app', 'Welt mit dem Serververzeichnis verknüpft', { source, target })
    } catch (err) {
      // Ohne Symlink-Berechtigung wird kopiert.
      logger.warn('app', 'Verknüpfung nicht möglich - Welt wird kopiert', { error: String(err) })
      await copyDirectory(source, target)
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
