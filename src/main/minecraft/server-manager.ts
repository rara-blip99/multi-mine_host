import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerLogLine, ServerState, ServerStatus } from '@shared/types'
import { logger } from '../core/logger'
import { DEFAULT_SERVER_CONFIG, ensureServerDir } from './config'
import type { ServerConfigOptions } from './config'
import { checkWorldIntegrity, readWorldInfo } from './world'
import { checkCompatibility } from './versions'
import { probeServerStatus } from './slp'

/**
 * Verwaltung des Minecraft-Servers als Kindprozess.
 *
 * Der Server wird ueber stdin gesteuert (Kommandos) und ueber stdout/stderr
 * beobachtet. Ein kontrolliertes Herunterfahren ("stop") laesst Minecraft die
 * Welt vollstaendig speichern - das ist die Voraussetzung fuer einen
 * sicheren Host-Wechsel.
 */

export interface ServerManagerOptions {
  /** Verzeichnis des Servers. */
  serverDir: string
  /** Pfad zur Server-JAR. */
  jarPath: string
  /** RAM-Limit des JVM (Bytes). */
  ramBytes: number
  /** Port des Servers. */
  port: number
  /** Weltverzeichnis (absolut). */
  worldPath?: string
  /** Java-Binary. */
  javaPath?: string
  /** Name der Welt innerhalb des Serververzeichnisses. */
  levelName?: string
  /** Minecraft-Version des Servers (fuer die Kompatibilitaetspruefung). */
  mcVersion?: string
  config?: Partial<ServerConfigOptions>
  ops?: string[]
  whitelist?: string[]
  onLog?: (line: ServerLogLine) => void
  onStateChange?: (state: ServerState) => void
}

const READY_PATTERN = /Done \([\d.,]+s\)!/
const JOIN_PATTERN = /:\s(\S+) joined the game/
const LEAVE_PATTERN = /:\s(\S+) left the game/

export class MinecraftServerManager {
  private child: ChildProcessWithoutNullStreams | null = null
  private state: ServerState = 'stopped'
  private startedAt: number | null = null
  private lastExitCode: number | null = null
  private lastError: string | null = null
  private readonly players = new Set<string>()
  private playersOnline: number | null = null
  private playerMax: number | null = null
  private readyResolve: ((ok: boolean) => void) | null = null
  private stopRequested = false
  private readonly logBuffer: ServerLogLine[] = []
  private readonly maxLogLines = 2000

  constructor(private readonly opts: ServerManagerOptions) {}

  get serverDir(): string {
    return this.opts.serverDir
  }

  get worldPath(): string {
    return this.opts.worldPath ?? join(this.opts.serverDir, this.opts.levelName ?? 'world')
  }

  status(): ServerStatus {
    return {
      state: this.state,
      playersOnline: this.playersOnline,
      playerMax: this.playerMax,
      mcVersion: this.opts.config?.port ? readWorldInfo(this.worldPath)?.mcVersion ?? '' : '',
      worldName: this.opts.levelName ?? DEFAULT_SERVER_CONFIG.levelName,
      startedAt: this.startedAt,
      pid: this.child?.pid ?? null,
      ramLimitBytes: this.opts.ramBytes,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError
    }
  }

  recentLogs(limit = 200): ServerLogLine[] {
    return this.logBuffer.slice(-limit)
  }

  private setState(state: ServerState): void {
    if (this.state === state) return
    this.state = state
    this.opts.onStateChange?.(state)
  }

  private log(level: ServerLogLine['level'], message: string): void {
    const entry: ServerLogLine = { ts: Date.now(), level, message }
    this.logBuffer.push(entry)
    if (this.logBuffer.length > this.maxLogLines) this.logBuffer.shift()
    this.opts.onLog?.(entry)
  }

  /**
   * Prueft VOR dem Start, ob die Welt zum Server passt.
   * Verhindert, dass eine inkompatible Welt stillschweigend veraendert wird.
   */
  preflight(): { ok: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = []
    const warnings: string[] = []

    if (!existsSync(this.opts.jarPath)) {
      errors.push(`Server-JAR nicht gefunden: ${this.opts.jarPath}`)
    }
    if (!existsSync(this.worldPath)) {
      errors.push(`Weltverzeichnis nicht gefunden: ${this.worldPath}`)
    } else {
      const integrity = checkWorldIntegrity(this.worldPath)
      errors.push(...integrity.problems)
      warnings.push(...integrity.warnings)
      const info = integrity.info
      if (info && info.dataVersion > 0) {
        const serverVersion = this.opts.mcVersion ?? '1.20.4'
        const compat = checkCompatibility(info.dataVersion, serverVersion)
        if (!compat.compatible) {
          errors.push(compat.reason)
        } else if (compat.requiresUpgrade) {
          warnings.push(compat.reason)
        }
      }
    }
    return { ok: errors.length === 0, errors, warnings }
  }

  /** Startet den Server. */
  async start(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.child) throw new Error('Server läuft bereits')

    const config: ServerConfigOptions = {
      ...DEFAULT_SERVER_CONFIG,
      port: this.opts.port,
      ...this.opts.config
    }
    ensureServerDir(this.opts.serverDir, {
      config,
      ops: this.opts.ops ?? [],
      whitelist: this.opts.whitelist ?? []
    })

    const pre = this.preflight()
    if (!pre.ok) {
      this.lastError = pre.errors.join('; ')
      this.log('error', `Start abgebrochen: ${pre.errors.join('; ')}`)
      throw new Error(`Server-Start abgebrochen: ${pre.errors.join('; ')}`)
    }
    for (const w of pre.warnings) this.log('warn', w)

    const java = this.opts.javaPath ?? 'java'
    const heapMb = Math.max(512, Math.floor(this.opts.ramBytes / 1024 / 1024))
    const args = [
      `-Xms${Math.max(512, Math.floor(heapMb / 2))}M`,
      `-Xmx${heapMb}M`,
      '-XX:+UseG1GC',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UseStringDeduplication',
      '-Dcom.mojang.eula.agree=true',
      '-Dfile.encoding=UTF-8',
      '-jar',
      this.opts.jarPath,
      'nogui'
    ]

    this.setState('starting')
    this.lastError = null
    this.players.clear()
    this.playersOnline = 0

    logger.info('minecraft', 'Starte Minecraft-Server', {
      serverDir: this.opts.serverDir,
      ram: `${heapMb} MB`,
      port: this.opts.port
    })

    const child = spawn(java, args, {
      cwd: this.opts.serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // Paper/Paperclip braucht eine stabile Encoding-Variable
        JAVA_TOOL_OPTIONS: '',
        // Begrenzt die JVM-Speichernutzung auf 1/4 des RAM
        MALLOC_ARENA_MAX: '2'
      }
    })
    this.child = child
    this.startedAt = Date.now()
    this.stopRequested = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data: string) => this.onOutput(data))
    child.stderr.on('data', (data: string) => this.onOutput(data))

    child.on('error', (err) => {
      this.lastError = String(err)
      this.log('error', `Serverprozess-Fehler: ${err.message}`)
      this.setState('crashed')
      this.resolveReady(false)
    })

    child.on('exit', (code, signal) => {
      const wasStopping = this.stopRequested
      this.child = null
      this.lastExitCode = code
      this.startedAt = null
      this.playersOnline = null
      if (wasStopping || code === 0) {
        this.setState('stopped')
        this.log('info', `Server beendet (Code ${code ?? 'null'}${signal ? `, Signal ${signal}` : ''})`)
      } else {
        this.setState('crashed')
        this.log('error', `Server unerwartet beendet (Code ${code ?? 'null'}${signal ? `, Signal ${signal}` : ''})`)
      }
      this.resolveReady(false)
      this.opts.onStateChange?.(this.state)
    })

    // Auf "bereit" warten
    const timeoutMs = options.timeoutMs ?? 180_000
    const ready = await this.waitUntilReady(timeoutMs)
    if (!ready) {
      throw new Error(this.lastError ?? 'Server wurde nicht rechtzeitig bereit')
    }
  }

  /** Sendet ein Kommando an die Serverkonsole. */
  sendCommand(command: string): boolean {
    if (!this.child || !this.child.stdin.writable) return false
    try {
      this.child.stdin.write(`${command}\n`)
      return true
    } catch (err) {
      logger.warn('minecraft', 'Kommando konnte nicht gesendet werden', { error: String(err) })
      return false
    }
  }

  private onOutput(text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (line.length === 0) continue
      const level: ServerLogLine['level'] = line.includes('/ERROR]') || line.includes('Exception')
        ? 'error'
        : line.includes('/WARN]')
          ? 'warn'
          : 'info'
      this.log(level, line)

      if (READY_PATTERN.test(line)) {
        this.setState('running')
        this.resolveReady(true)
      }
      const join = JOIN_PATTERN.exec(line)
      if (join?.[1]) {
        this.players.add(join[1])
        this.playersOnline = this.players.size
      }
      const leave = LEAVE_PATTERN.exec(line)
      if (leave?.[1]) {
        this.players.delete(leave[1])
        this.playersOnline = this.players.size
      }
      const listMatch = /There are (\d+) of a max of (\d+) players online/.exec(line)
      if (listMatch) {
        this.playersOnline = Number(listMatch[1])
        this.playerMax = Number(listMatch[2])
      }
      if (line.includes('Stopping server')) {
        this.setState('stopping')
      }
      if (line.includes('Encountered an unexpected exception') || line.includes('Preparing crash')) {
        this.lastError = line
      }
    }
  }

  private resolveReady(ok: boolean): void {
    if (this.readyResolve) {
      const r = this.readyResolve
      this.readyResolve = null
      r(ok)
    }
  }

  /** Wartet darauf, dass der Server betriebsbereit ist. */
  waitUntilReady(timeoutMs = 180_000): Promise<boolean> {
    if (this.state === 'running') return Promise.resolve(true)
    if (!this.child) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyResolve = null
        this.lastError = this.lastError ?? 'Zeitüberschreitung beim Serverstart'
        resolve(false)
      }, timeoutMs)
      this.readyResolve = (ok) => {
        clearTimeout(timer)
        resolve(ok)
      }
    })
  }

  /**
   * Speichert die Welt explizit.
   * `save-off` verhindert parallele Auto-Saves, `save-all flush` erzwingt
   * einen sofortigen Schreibvorgang, `save-on` stellt den Normalbetrieb her.
   */
  async save(): Promise<boolean> {
    if (!this.child) return false
    this.sendCommand('save-off')
    await delay(150)
    this.sendCommand('save-all flush')
    await delay(600)
    this.sendCommand('save-on')
    return true
  }

  /**
   * Beruhigt den Server fuer eine Weltuebergabe:
   * Auto-Save aus, Welt zwangsweise speichern, Server stoppen.
   */
  async quiesceAndStop(timeoutMs = 120_000): Promise<void> {
    if (!this.child) return
    this.stopRequested = true
    this.setState('stopping')
    this.sendCommand('save-off')
    await delay(200)
    this.sendCommand('save-all flush')
    await delay(800)
    this.sendCommand('stop')
    await this.waitForExit(timeoutMs)
  }

  /** Stoppt den Server kontrolliert. */
  async stop(timeoutMs = 90_000): Promise<void> {
    if (!this.child) {
      this.setState('stopped')
      return
    }
    this.stopRequested = true
    this.setState('stopping')
    this.sendCommand('stop')
    await this.waitForExit(timeoutMs)
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn('minecraft', 'Server reagiert nicht auf Stop-Befehl - erzwinge Beendigung', {
          pid: child.pid
        })
        this.kill()
        resolve()
      }, timeoutMs)

      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    // Falls der Prozess noch laeuft (Timeout-Fall), sicher beenden.
    if (this.child) this.kill()
  }

  /** Beendet den Serverprozess hart (letztes Mittel). */
  kill(): void {
    const child = this.child
    if (!child?.pid) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    } catch (err) {
      logger.warn('minecraft', 'Prozess konnte nicht beendet werden', { error: String(err) })
    }
  }

  /** Fragt den Server per Server-List-Ping ab (genaue Spielerzahl). */
  async refreshPlayers(timeoutMs = 3_000): Promise<void> {
    try {
      const status = await probeServerStatus('127.0.0.1', this.opts.port, timeoutMs)
      this.playersOnline = status.players.online
      this.playerMax = status.players.max
    } catch {
      // Ping fehlgeschlagen - Log-basierte Zahl behalten
    }
  }

  get isRunning(): boolean {
    return this.state === 'running' || this.state === 'starting'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
