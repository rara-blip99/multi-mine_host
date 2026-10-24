import type { AppSettings, AppState, ServerStatus, SyncProgress, FailoverState } from '@shared/types'
import { Paths } from './core/paths'
import { DEFAULT_MC_VERSION } from './minecraft/versions'

/**
 * Standardwerte der Einstellungen.
 */
export function defaultSettings(): AppSettings {
  return {
    minecraftEdition: 'java',
    mcVersion: DEFAULT_MC_VERSION,
    serverRamBytes: 4 * 1024 * 1024 * 1024,
    serverPort: 25565,
    backupIntervalMinutes: 5,
    backupRetention: 12,
    backupMaxSizeMb: 0,
    worldsDir: Paths.defaultWorldsDir(),
    backupsDir: Paths.defaultBackupsDir(),
    hostingPriority: 50,
    hostingAllowed: true,
    hubAddress: '',
    embeddedHubEnabled: true,
    embeddedHubPort: 0,
    closeBehavior: 'keep-running',
    autostart: false,
    minimizeToTray: true,
    allowRemoteConnections: true,
    embeddedHubToken: ''
  }
}

export function defaultServerStatus(): ServerStatus {
  return {
    state: 'stopped',
    playersOnline: null,
    playerMax: null,
    mcVersion: DEFAULT_MC_VERSION,
    worldName: 'world',
    startedAt: null,
    pid: null,
    ramLimitBytes: 4 * 1024 * 1024 * 1024,
    lastExitCode: null,
    lastError: null
  }
}

export function defaultSyncProgress(): SyncProgress {
  return {
    phase: 'idle',
    fileIndex: 0,
    fileCount: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    etaSeconds: null,
    currentFile: null,
    message: 'Keine Synchronisierung aktiv'
  }
}

export function defaultFailoverState(): FailoverState {
  return {
    phase: 'idle',
    fromNodeId: null,
    toNodeId: null,
    epoch: 0,
    startedAt: null,
    updatedAt: Date.now(),
    message: 'Kein Host-Wechsel aktiv',
    warnings: []
  }
}

export function defaultAppState(): AppState {
  return {
    identity: null,
    group: null,
    settings: defaultSettings(),
    members: [],
    capabilities: [],
    scores: [],
    lease: null,
    fence: 'none',
    server: defaultServerStatus(),
    world: null,
    backups: [],
    sync: defaultSyncProgress(),
    failover: defaultFailoverState(),
    hubConnected: false,
    hubError: null
  }
}

/**
 * Zustand, der ueber Neustarts hinweg erhalten bleiben muss.
 */
export interface SessionState {
  groupId?: string
  sessionToken?: string
  hubAddress?: string
  /** Name der aktiven Welt. */
  worldName?: string
  /** Verzeichnis der aktiven Welt (auf diesem Rechner). */
  worldPath?: string
  /** Installationsverzeichnis des Minecraft-Servers. */
  serverDir?: string
  /** Zuletzt bestaetigte Weltversion. */
  lastWorldVersionId?: string
  /** Epoche der zuletzt gehaltenen Lease (fuer Fencing nach Neustart). */
  lastEpoch?: number
  /** Node-ID des letzten Hosts. */
  lastHostId?: string
  /** Anzahl erfolgreicher Host-Wechsel. */
  successfulHosts?: number
  /** Anzahl fehlgeschlagener Host-Wechsel. */
  failedHosts?: number
  /** Grund des letzten Host-Endes. */
  lastExitReason?: string
  /** Zaehler fuer Stabilitaet. */
  servedSeconds?: number
}
