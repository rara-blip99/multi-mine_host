import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  GroupCreateRequest,
  GroupJoinRequest,
  WorldImportRequest
} from '@shared/ipc'
import type { AppSettings, AppState } from '@shared/types'

/**
 * Sichere Bruecke zwischen Renderer und Main-Prozess.
 *
 * Der Renderer bekommt ausschliesslich die hier explizit definierten
 * Funktionen. `ipcRenderer` selbst wird nicht freigegeben.
 */
const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.stateGet),

  onStateChanged: (cb: (state: AppState) => void): (() => void) => {
    const listener = (_event: unknown, state: AppState): void => cb(state)
    ipcRenderer.on(IPC.stateChanged, listener)
    return () => ipcRenderer.removeListener(IPC.stateChanged, listener)
  },

  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch),

  setDisplayName: (name: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.settingsSetDisplayName, name),

  createGroup: (req: GroupCreateRequest) => ipcRenderer.invoke(IPC.groupCreate, req),
  joinGroup: (req: GroupJoinRequest) => ipcRenderer.invoke(IPC.groupJoin, req),
  leaveGroup: () => ipcRenderer.invoke(IPC.groupLeave),
  refreshGroup: () => ipcRenderer.invoke(IPC.groupRefresh),
  createInvite: (name: string, expiresInMs = 0, maxUses = 0) =>
    ipcRenderer.invoke(IPC.groupCreateInvite, name, expiresInMs, maxUses),
  revokeInvite: (inviteId: string) => ipcRenderer.invoke(IPC.groupRevokeInvite, inviteId),
  listInvites: () => ipcRenderer.invoke(IPC.groupListInvites),
  removeMember: (nodeId: string) => ipcRenderer.invoke(IPC.groupRemoveMember, nodeId),
  setMemberAllowed: (nodeId: string, allowed: boolean) =>
    ipcRenderer.invoke(IPC.groupSetMemberAllowed, nodeId, allowed),
  setPriority: (priority: number) => ipcRenderer.invoke(IPC.groupSetPriority, priority),

  startServer: () => ipcRenderer.invoke(IPC.serverStart),
  stopServer: () => ipcRenderer.invoke(IPC.serverStop),
  prepareServer: () => ipcRenderer.invoke(IPC.serverPrepare),
  serverStatus: () => ipcRenderer.invoke(IPC.serverStatus),
  serverLogs: (limit = 200) => ipcRenderer.invoke(IPC.serverLogs, limit),

  listWorlds: () => ipcRenderer.invoke(IPC.worldList),
  importWorld: (req: WorldImportRequest) => ipcRenderer.invoke(IPC.worldImport, req),
  checkWorld: () => ipcRenderer.invoke(IPC.worldCheck),
  worldManifest: () => ipcRenderer.invoke(IPC.worldManifest),

  listBackups: () => ipcRenderer.invoke(IPC.backupList),
  createBackup: (kind = 'manual') => ipcRenderer.invoke(IPC.backupCreate, kind),
  restoreBackup: (id: string) => ipcRenderer.invoke(IPC.backupRestore, id),
  verifyBackups: () => ipcRenderer.invoke(IPC.backupVerify),

  requestTakeover: () => ipcRenderer.invoke(IPC.failoverTakeover),
  diagnostics: () => ipcRenderer.invoke(IPC.diagnosticsReport),
  embeddedHubAddress: () => ipcRenderer.invoke(IPC.hubEmbeddedAddress)
}

contextBridge.exposeInMainWorld('mmh', api)

export type MmhBridge = typeof api
