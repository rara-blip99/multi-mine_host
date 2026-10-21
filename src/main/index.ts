import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppService } from './app-service'
import { logger } from './core/logger'
import { Paths } from './core/paths'
import { IPC } from '@shared/ipc'
import type {
  GroupCreateRequest,
  GroupJoinRequest,
  WorldImportRequest
} from '@shared/ipc'
import type { AppState, DiagnosticsReport, ServerLogLine } from '@shared/types'
import { formatBytes } from './app-service'

const dirname = join(fileURLToPath(import.meta.url), '..')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let appService: AppService | null = null
let quitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b1020',
    title: 'Multi-Mine Host',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void mainWindow.loadURL(devServer)
  } else {
    void mainWindow.loadFile(join(dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  try {
    tray = new Tray(join(dirname, '../resources/icon.png'))
    const menu = Menu.buildFromTemplate([
      {
        label: 'Multi-Mine Host öffnen',
        click: () => {
          mainWindow?.show()
        }
      },
      {
        label: 'Beenden',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
    tray.setToolTip('Multi-Mine Host')
    tray.setContextMenu(menu)
  } catch {
    // Tray ist optional - die App funktioniert auch ohne.
  }
}

function registerIpc(service: AppService): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as never[]))
      } catch (err) {
        logger.error('ipc', `Fehler in ${channel}`, { error: String(err) })
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  handle(IPC.stateGet, () => service.getState())

  handle(IPC.settingsUpdate, (patch: never) => service.updateSettings(patch))
  handle(IPC.settingsSetDisplayName, (name: never) => {
    service.setDisplayName(name as unknown as string)
    return { ok: true }
  })

  handle(IPC.groupCreate, async (req: never) => {
    const r = req as unknown as GroupCreateRequest
    try {
      const result = await service.createGroup(r.hubAddress, r.groupName, r.hubToken)
      return { ok: true, group: result.group, invites: result.invites }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle(IPC.groupJoin, async (req: never) => {
    const r = req as unknown as GroupJoinRequest
    try {
      const group = await service.joinGroup(r.hubAddress, r.groupId, r.inviteCode)
      return { ok: true, group }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle(IPC.groupLeave, () => service.leaveGroup())
  handle(IPC.groupRefresh, () => service.refreshSnapshot().then(() => ({ ok: true })))
  handle(IPC.groupCreateInvite, (name: never, expires: never, uses: never) =>
    service.createInvite(name as unknown as string, (expires as number) ?? 0, (uses as number) ?? 0)
  )
  handle(IPC.groupRevokeInvite, (id: never) => service.revokeInvite(id as unknown as string))
  handle(IPC.groupListInvites, () => service.listInvites())
  handle(IPC.groupRemoveMember, (id: never) => service.removeMember(id as unknown as string))
  handle(IPC.groupSetMemberAllowed, (id: never, allowed: never) =>
    service.setMemberAllowed(id as unknown as string, allowed as unknown as boolean)
  )
  handle(IPC.groupSetPriority, (p: never) => service.setOwnPriority(p as unknown as number))

  handle(IPC.serverStart, () => service.startServer())
  handle(IPC.serverStop, () => service.stopServer().then(() => ({ ok: true })))
  handle(IPC.serverPrepare, () => service.prepareServer())
  handle(IPC.serverStatus, () => service.getState().server)
  handle(IPC.serverLogs, (limit: never) => service.serverLogsTail((limit as number) ?? 200))

  handle(IPC.worldList, () => service.listLocalWorlds())
  handle(IPC.worldImport, async (req: never) => {
    const r = req as unknown as WorldImportRequest
    const result = await service.importWorld(r.sourcePath, r.name, r.overwrite)
    return { ok: result.ok, error: result.error }
  })
  handle(IPC.worldCheck, () => service.checkWorld())
  handle(IPC.worldManifest, () => service.currentManifest())

  handle(IPC.backupList, () => service.listBackups())
  handle(IPC.backupCreate, (kind: never) => service.createBackup(((kind as string) ?? 'manual') as never))
  handle(IPC.backupRestore, (id: never) => service.restoreBackup(id as unknown as string))
  handle(IPC.backupVerify, () => service.listBackups())

  handle(IPC.failoverTakeover, () => service.requestTakeover())

  handle(IPC.diagnosticsReport, (): DiagnosticsReport => {
    const state: AppState = service.getState()
    return {
      generatedAt: Date.now(),
      appVersion: app.getVersion(),
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      identity: state.identity,
      group: state.group,
      hubConnected: state.hubConnected,
      members: state.members,
      lease: state.lease,
      fence: state.fence,
      server: state.server,
      recentLogs: logger.recent(300)
    }
  })
  handle(IPC.hubEmbeddedAddress, () => service.embeddedHubAddress())
}

app.whenReady().then(async () => {
  logger.init()
  Paths.ensureAll()

  appService = new AppService()
  registerIpc(appService)

  appService.onChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.stateChanged, state)
    }
  })

  try {
    await appService.start()
  } catch (err) {
    logger.error('main', 'Start fehlgeschlagen', { error: String(err) })
  }

  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Bei 'keep-running' bleibt die App im Tray aktiv.
  if (process.platform !== 'darwin' && !appService?.getState().settings.minimizeToTray) {
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (quitting) return
  const behavior = appService?.getState().settings.closeBehavior
  if (behavior === 'keep-running') {
    event.preventDefault()
    quitting = true
    await appService?.stop()
    app.exit(0)
    return
  }
  quitting = true
  await appService?.stop()
})

app.on('before-quit', () => {
  if (tray) {
    tray.destroy()
    tray = null
  }
})

process.on('uncaughtException', (err) => {
  logger.error('main', 'Unbehandelte Ausnahme', { error: String(err), stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  logger.error('main', 'Unbehandelte Promise-Ablehnung', { error: String(reason) })
})

export { formatBytes }
