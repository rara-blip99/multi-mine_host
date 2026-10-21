import type {
  AppSettings,
  AppState,
  BackupInfo,
  CandidateScore,
  DiagnosticsReport,
  GroupInfo,
  HostCapability,
  ServerLogLine,
  ServerStatus,
  SyncProgress,
  WorldManifest
} from './types'
import type { InviteInfo } from './protocol'

/**
 * IPC-Kanaele zwischen Renderer und Main-Prozess.
 *
 * Der Renderer darf ausschliesslich die hier definierten, typisierten
 * Aufrufe ausfuehren. Es gibt bewusst keinen generischen
 * "run command"-Kanal - so koennte der Renderer keine beliebigen
 * Systembefehle ausloesen.
 */
export const IPC = {
  stateGet: 'state:get',

  settingsUpdate: 'settings:update',
  settingsSetDisplayName: 'settings:set-display-name',

  groupCreate: 'group:create',
  groupJoin: 'group:join',
  groupLeave: 'group:leave',
  groupRefresh: 'group:refresh',
  groupCreateInvite: 'group:create-invite',
  groupRevokeInvite: 'group:revoke-invite',
  groupListInvites: 'group:list-invites',
  groupRemoveMember: 'group:remove-member',
  groupSetMemberAllowed: 'group:set-member-allowed',
  groupSetPriority: 'group:set-priority',

  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverStatus: 'server:status',
  serverLogs: 'server:logs',
  serverPrepare: 'server:prepare',

  worldList: 'world:list',
  worldImport: 'world:import',
  worldCheck: 'world:check',
  worldManifest: 'world:manifest',

  backupList: 'backup:list',
  backupCreate: 'backup:create',
  backupRestore: 'backup:restore',
  backupVerify: 'backup:verify',

  failoverTakeover: 'failover:takeover',

  diagnosticsReport: 'diagnostics:report',
  hubEmbeddedAddress: 'hub:embedded-address',

  /** Zustandsänderungen werden an den Renderer gepusht. */
  stateChanged: 'state:changed'
} as const

export interface GroupCreateRequest {
  hubAddress: string
  groupName: string
  hubToken?: string
}

export interface GroupJoinRequest {
  hubAddress: string
  groupId: string
  inviteCode: string
}

export interface WorldImportRequest {
  sourcePath: string
  name: string
  overwrite?: boolean
}

export interface OperationResult {
  ok: boolean
  error?: string
}

export interface MmhApi {
  getState(): Promise<AppState>
  onStateChanged(cb: (state: AppState) => void): () => void

  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setDisplayName(name: string): Promise<OperationResult>

  createGroup(req: GroupCreateRequest): Promise<{ ok: boolean; group?: GroupInfo; invites?: InviteInfo[]; error?: string }>
  joinGroup(req: GroupJoinRequest): Promise<{ ok: boolean; group?: GroupInfo; error?: string }>
  leaveGroup(): Promise<OperationResult>
  refreshGroup(): Promise<OperationResult>
  createInvite(name: string, expiresInMs?: number, maxUses?: number): Promise<InviteInfo[]>
  revokeInvite(inviteId: string): Promise<InviteInfo[]>
  listInvites(): Promise<InviteInfo[]>
  removeMember(nodeId: string): Promise<OperationResult>
  setMemberAllowed(nodeId: string, allowed: boolean): Promise<OperationResult>
  setPriority(priority: number): Promise<OperationResult>

  startServer(): Promise<OperationResult>
  stopServer(): Promise<OperationResult>
  prepareServer(): Promise<OperationResult>
  serverStatus(): Promise<ServerStatus>
  serverLogs(limit?: number): Promise<ServerLogLine[]>

  listWorlds(): Promise<Array<{ path: string; name: string; dataVersion: number }>>
  importWorld(req: WorldImportRequest): Promise<OperationResult>
  checkWorld(): Promise<{ ok: boolean; problems: string[]; warnings: string[] }>
  worldManifest(): Promise<WorldManifest | null>

  listBackups(): Promise<BackupInfo[]>
  createBackup(kind?: string): Promise<{ ok: boolean; info?: BackupInfo; error?: string }>
  restoreBackup(id: string): Promise<OperationResult>
  verifyBackups(): Promise<BackupInfo[]>

  requestTakeover(): Promise<{ ok: boolean; reason: string }>
  diagnostics(): Promise<DiagnosticsReport>
  embeddedHubAddress(): Promise<string | null>
}

declare global {
  interface Window {
    mmh: MmhApi
  }
}

export type { CandidateScore, HostCapability, SyncProgress }
