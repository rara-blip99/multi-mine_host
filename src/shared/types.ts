/**
 * Gemeinsame Domänentypen für Multi-Mine Host.
 *
 * Diese Datei wird sowohl im Electron-Main-Prozess (Node) als auch im
 * Renderer (Browser) geladen. Sie darf daher KEINE Node- oder DOM-spezifischen
 * APIs verwenden.
 */

// ---------------------------------------------------------------------------
// Identität & Gruppe
// ---------------------------------------------------------------------------

/** Ed25519-basierte Identität eines Mitglieds. */
export interface NodeIdentity {
  /** Stabile, aus dem Public Key abgeleitete ID (base32 ohne Padding). */
  nodeId: string
  /** Rohes Ed25519 Public Key, base64 kodiert. */
  publicKey: string
  /** Vom Benutzer vergeben Anzeigename. */
  displayName: string
  createdAt: number
}

export type MemberRole = 'owner' | 'admin' | 'member'

export interface GroupMember {
  nodeId: string
  publicKey: string
  displayName: string
  role: MemberRole
  /** Vom Besitzer vergeben: darf dieses Mitglied überhaupt hosten? */
  hostingAllowed: boolean
  /** Vom Benutzer gewählte Hosting-Priorität (0..100). */
  hostingPriority: number
  joinedAt: number
  lastSeenAt: number
  /** Vom Hub gemeldeter Online-Status (Live-Heartbeat). */
  online: boolean
  /** Widerrufene Mitgliedschaft -> kein Zugriff mehr, aber Audit-Eintrag bleibt. */
  revoked: boolean
}

export interface GroupInfo {
  groupId: string
  name: string
  createdAt: number
  /** Adresse des Koordinations-Hubs (Multiaddr). */
  hubAddress: string
  /** Welt-Version, die der Hub als "aktuell" führt. */
  currentWorldVersionId: string | null
}

export interface GroupSnapshot {
  group: GroupInfo
  members: GroupMember[]
  /** Leistungsdaten aller Mitglieder (fuer die Host-Auswahl). */
  capabilities: HostCapability[]
  lease: HostLease | null
  world: WorldRegistryEntry | null
  serverTime: number
}

// ---------------------------------------------------------------------------
// Host-Fähigkeit & Leistungsmessung
// ---------------------------------------------------------------------------

export interface CpuInfo {
  model: string
  logicalCores: number
  physicalCores: number
  /** Aktuelle Auslastung in Prozent (0..100). */
  usage: number
  loadAvg1: number
}

export interface MemoryInfo {
  totalBytes: number
  freeBytes: number
  availableBytes: number
  usage: number
}

export interface DiskInfo {
  path: string
  totalBytes: number
  freeBytes: number
  /** Gemessene Schreibgeschwindigkeit in MB/s (0 = unbekannt). */
  writeMbps: number
  readMbps: number
  filesystem: string
}

export interface NetworkInfo {
  /** Gemessene Upload-Bandbreite in Mbit/s (0 = unbekannt). */
  uploadMbps: number
  downloadMbps: number
  /** Roundtrip-Zeit zum Hub in ms. */
  latencyMs: number
  jitterMs: number
  /** true, wenn die Verbindung zum Hub nur über Relay möglich ist. */
  relayOnly: boolean
  /** Erreichbare Adresse(n) für Peer-Verbindungen. */
  advertisedAddresses: string[]
}

export interface JavaInfo {
  available: boolean
  version: string
  major: number
  path: string
}

export interface StabilityInfo {
  uptimeSeconds: number
  successfulHosts: number
  failedHosts: number
  /** 0..1 – Verhältnis erfolgreicher Hosting-Vorgänge. */
  availabilityRatio: number
  lastExitReason: string
}

/**
 * Vollständige Leistungsbeschreibung eines potentiellen Hosts.
 * Wird regelmäßig an den Hub gemeldet und von allen Mitgliedern zur Wahl genutzt.
 */
export interface HostCapability {
  nodeId: string
  displayName: string
  hostingAllowed: boolean
  priority: number
  cpu: CpuInfo
  memory: MemoryInfo
  disk: DiskInfo
  network: NetworkInfo
  java: JavaInfo
  stability: StabilityInfo
  /** Weltgröße in Bytes, die der Kandidat benötigt. */
  requiredWorldBytes: number
  measuredAt: number
}

// ---------------------------------------------------------------------------
// Host-Election
// ---------------------------------------------------------------------------

export interface ScoreReason {
  key: string
  label: string
  /** Gewicht dieses Kriteriums in Prozentpunkten des Gesamtscores. */
  weight: number
  /** Tatsächlich erzielter Beitrag (0..weight). */
  contribution: number
  detail: string
  satisfied: boolean
}

export interface CandidateScore {
  nodeId: string
  displayName: string
  /** Erfüllt der Kandidat alle Mindestanforderungen? */
  eligible: boolean
  /** Gewichteter Gesamtwert 0..100. */
  score: number
  reasons: ScoreReason[]
  /** Gründe, warum der Kandidat ausgeschlossen wurde. */
  disqualifiers: string[]
}

// ---------------------------------------------------------------------------
// Lease & Fencing
// ---------------------------------------------------------------------------

export interface HostLease {
  groupId: string
  /** Node-ID des Lease-Halters. */
  holderId: string
  /**
   * Monoton steigende Generation. Jede Lease-Erteilung erhöht die Epoche.
   * Ein Host mit veralteter Epoche ist "fenced" und darf nicht mehr schreiben.
   */
  epoch: number
  acquiredAt: number
  expiresAt: number
  ttlMs: number
  /** Welt-Version, die unter dieser Lease geschrieben werden darf. */
  worldVersionId: string | null
}

export type LeaseAcquireResult =
  | { granted: true; lease: HostLease; reason: string }
  | { granted: false; lease: HostLease | null; reason: string }

export type FenceState =
  | 'none'
  | 'held'
  | 'lost'
  | 'expired'
  | 'revoked'
  | 'superseded'

// ---------------------------------------------------------------------------
// Welt
// ---------------------------------------------------------------------------

export interface WorldManifestEntry {
  /** Relativer Pfad mit '/' als Trenner. */
  path: string
  size: number
  mtimeMs: number
  sha256: string
}

export interface WorldManifest {
  /** Inhaltliche Kennung der Welt (Hash über alle Einträge). */
  versionId: string
  worldName: string
  mcVersion: string
  /** Minecraft DataVersion aus level.dat. */
  dataVersion: number
  createdAt: number
  totalBytes: number
  entryCount: number
  entries: WorldManifestEntry[]
}

export interface WorldRegistryEntry {
  versionId: string
  worldName: string
  mcVersion: string
  dataVersion: number
  /** Node, der diese Weltversion zuletzt geschrieben hat. */
  ownerId: string
  /** Epoche, unter der geschrieben wurde. */
  epoch: number
  committedAt: number
  totalBytes: number
  /** Replikate (andere Node-IDs), auf denen diese Weltversion existiert. */
  replicaIds: string[]
}

export type WorldHealth = 'ok' | 'checking' | 'corrupt' | 'unknown'

/** Spielmodus einer neu erstellten Welt. */
export type WorldGameMode = 'survival' | 'creative'

/** Schwierigkeit einer neu erstellten Welt. */
export type WorldDifficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

export interface WorldCreateRequest {
  /** Ordnername der Welt (ein Pfadsegment, wird validiert). */
  name: string
  /** Minecraft-Version, für die die Welt generiert wird. */
  mcVersion: string
  gameMode: WorldGameMode
  difficulty: WorldDifficulty
  /** Optionaler Welt-Seed; leer/unset = Minecraft erzeugt einen Zufalls-Seed. */
  seed?: string
  /** true = Erstellt-Operator (Cheats) in der frischen Welt anlegen. */
  cheats: boolean
}

export interface WorldCreateInfo {
  worldName: string
  worldPath: string
  mcVersion: string
  gameMode: WorldGameMode
  difficulty: WorldDifficulty
  /** Gewählter Seed oder null, wenn Minecraft zufällig gewürfelt hat. */
  seed: string | null
  cheats: boolean
  sizeBytes: number
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export type BackupKind = 'auto' | 'manual' | 'pre-switch' | 'pre-restore'

export interface BackupInfo {
  id: string
  kind: BackupKind
  createdAt: number
  worldName: string
  worldVersionId: string
  /** Groesse des komprimierten Archivs in Bytes. */
  sizeBytes: number
  /** Groesse der entpackten Welt in Bytes. */
  uncompressedBytes: number
  mcVersion: string
  dataVersion: number
  /** SHA-256 über das Archiv. */
  sha256: string
  /** true, wenn das Archiv erfolgreich verifiziert wurde. */
  verified: boolean
  /** true, wenn mindestens ein weiteres Mitglied eine Kopie hält. */
  replicated: boolean
  path: string
}

export type BackupResult =
  | { ok: true; info: BackupInfo }
  | { ok: false; error: string; code: string }

// ---------------------------------------------------------------------------
// Minecraft Server
// ---------------------------------------------------------------------------

export type ServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'unknown'

export interface ServerStatus {
  state: ServerState
  /** Spielerzahl, soweit zuverlaengig ermittelbar. */
  playersOnline: number | null
  playerMax: number | null
  mcVersion: string
  worldName: string
  startedAt: number | null
  pid: number | null
  /** RAM-Limit in Bytes (JVM -Xmx). */
  ramLimitBytes: number
  lastExitCode: number | null
  lastError: string | null
}

export interface ServerLogLine {
  ts: number
  level: 'info' | 'warn' | 'error' | 'raw'
  message: string
}

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

export type SyncPhase =
  | 'idle'
  | 'preparing'
  | 'transferring'
  | 'verifying'
  | 'committing'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface SyncProgress {
  phase: SyncPhase
  fileIndex: number
  fileCount: number
  bytesTransferred: number
  totalBytes: number
  bytesPerSecond: number
  etaSeconds: number | null
  currentFile: string | null
  message: string
}

export interface SyncResult {
  ok: boolean
  versionId: string | null
  bytesTransferred: number
  error: string | null
  resumed: boolean
}

// ---------------------------------------------------------------------------
// Host-Übergabe (State Machine)
// ---------------------------------------------------------------------------

export type FailoverPhase =
  | 'idle'
  | 'detected'
  | 'creating'
  | 'lease-acquired'
  | 'draining'
  | 'quiescing'
  | 'transferring'
  | 'verifying'
  | 'starting'
  | 'completed'
  | 'failed'
  | 'blocked'

export interface FailoverState {
  phase: FailoverPhase
  fromNodeId: string | null
  toNodeId: string | null
  epoch: number
  startedAt: number | null
  updatedAt: number
  message: string
  /** Hinweise auf moeglichen Datenverlust. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Wiederherstellung
// ---------------------------------------------------------------------------

export type RecoveryReason =
  | 'host-crash'
  | 'host-unreachable'
  | 'manual'
  | 'host-left-group'
  | 'world-corrupt'

export interface RecoveryPlan {
  possible: boolean
  reason: string
  /** Node-ID des vorgesehenen neuen Hosts. */
  targetNodeId: string | null
  /** Backup, aus dem wiederhergestellt wird. */
  sourceBackupId: string | null
  sourceVersionId: string | null
  /** true, wenn ein älterer Weltstand verwendet wird -> Datenverlust moeglich. */
  potentialDataLoss: boolean
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type MinecraftEdition = 'java' | 'bedrock'

export interface AppSettings {
  minecraftEdition: MinecraftEdition
  mcVersion: string
  /** JVM -Xmx in Bytes. */
  serverRamBytes: number
  /** Port, auf dem der Minecraft-Server lauscht. */
  serverPort: number
  /** Intervall zwischen automatischen Backups in Minuten. */
  backupIntervalMinutes: number
  /** Anzahl aufzubewahrender Backups (pro Typ). */
  backupRetention: number
  /** Maximale Groesse eines Backups in MB, 0 = unbegrenzt. */
  backupMaxSizeMb: number
  worldsDir: string
  backupsDir: string
  /** Eigene Hosting-Prioritaet 0..100. */
  hostingPriority: number
  /** Eigenes Hosting erlaubt? */
  hostingAllowed: boolean
  /** Multiaddr des Koordinations-Hubs. */
  hubAddress: string
  /** Interne Koordination auf diesem PC aktiv (eingebauter Hub)? */
  embeddedHubEnabled: boolean
  /**
   * Port, auf dem der eingebaute Hub lauscht.
   * 0 = kein fester Port (Zufallsport) - kein eingebauter Hub nur,
   * wenn embeddedHubEnabled false ist.
   */
  embeddedHubPort: number
  /**
   * Port, den der eingebaute Hub beim letzten Start konkret gebunden hat
   * (automatisch vermerkt). Mit 0 wird er erneut vom Betriebssystem
   * vergeben. So bleibt die Adresse des eingebauten Hubs über Neustarts
   * gleich, ohne dass der Benutzer einen Port festlegen muss.
   */
  embeddedHubLastPort: number
  /** Verhalten beim Schliessen der App. */
  closeBehavior: 'keep-running' | 'stop-server' | 'quit'
  autostart: boolean
  /** Minimieren in den Tray statt Beenden. */
  minimizeToTray: boolean
  /** Allow connections from other peers. */
  allowRemoteConnections: boolean
  /** Zugangs-Token des eingebauten Hubs. */
  embeddedHubToken: string
}

export interface AppState {
  identity: NodeIdentity | null
  group: GroupInfo | null
  settings: AppSettings
  members: GroupMember[]
  capabilities: HostCapability[]
  scores: CandidateScore[]
  lease: HostLease | null
  fence: FenceState
  server: ServerStatus
  world: WorldRegistryEntry | null
  backups: BackupInfo[]
  sync: SyncProgress
  failover: FailoverState
  hubConnected: boolean
  hubError: string | null
}

// ---------------------------------------------------------------------------
// Logging / Diagnose
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  data?: Record<string, unknown>
}

export interface DiagnosticsReport {
  generatedAt: number
  appVersion: string
  nodeVersion: string
  platform: string
  arch: string
  identity: NodeIdentity | null
  group: GroupInfo | null
  hubConnected: boolean
  members: GroupMember[]
  lease: HostLease | null
  fence: FenceState
  server: ServerStatus
  recentLogs: LogEntry[]
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string
  size: number
  browserDownloadUrl: string
  contentType: string
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  notes: string | null
  publishedAt: string | null
  assets: ReleaseAsset[]
  error: string | null
}
