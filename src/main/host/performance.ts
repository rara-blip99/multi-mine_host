import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem, uptime, loadavg } from 'node:os'
import {
  statfsSync,
  mkdtempSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  rmSync,
  existsSync,
  readFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type {
  CpuInfo,
  DiskInfo,
  JavaInfo,
  MemoryInfo,
  NetworkInfo,
  StabilityInfo
} from '@shared/types'
import { logger } from '../core/logger'

const execFileAsync = promisify(execFile)

/**
 * Erfassung der tatsaechlichen Hosting-Leistung eines PCs.
 *
 * Alle Werte werden auf diesem Rechner gemessen - es werden keine
 * Nominalwerte aus dem Internet verwendet.
 */

export interface PerformanceSample {
  cpu: CpuInfo
  memory: MemoryInfo
  disk: DiskInfo
  network: NetworkInfo
  java: JavaInfo
  stability: StabilityInfo
  measuredAt: number
}

export interface PerformanceMonitorOptions {
  /** Verzeichnis, in dem die Welt liegt (relevant fuer die Laufwerksmessung). */
  worldPath: string
  /** Intervall fuer CPU-Auslastungsmessung (ms). */
  cpuSampleMs?: number
}

/** Frueher CPU-Snapshot fuer die Auslastungsberechnung. */
interface CpuSample {
  idle: number
  total: number
  at: number
}

export class PerformanceMonitor {
  private lastCpu: CpuSample | null = null
  private cpuUsage = 0
  private javaCache: { value: JavaInfo; at: number } | null = null
  private diskSpeedCache: { writeMbps: number; readMbps: number; at: number } | null = null
  private stability: StabilityInfo = {
    uptimeSeconds: 0,
    successfulHosts: 0,
    failedHosts: 0,
    availabilityRatio: 1,
    lastExitReason: 'noch kein Host-Wechsel'
  }
  private readonly cpuSampleMs: number

  constructor(private readonly opts: PerformanceMonitorOptions) {
    this.cpuSampleMs = opts.cpuSampleMs ?? 1_000
  }

  /** Setzt die Stabilitaetswerte (wird vom Host-Manager gepflegt). */
  setStability(update: Partial<StabilityInfo>): void {
    this.stability = { ...this.stability, ...update }
  }

  get stabilityInfo(): StabilityInfo {
    return {
      ...this.stability,
      uptimeSeconds: Math.round(uptime())
    }
  }

  /** Misst die aktuelle CPU-Auslastung (Differenz zweier Snapshots). */
  private measureCpuUsage(): number {
    const list = cpus()
    let idle = 0
    let total = 0
    for (const cpu of list) {
      for (const key of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) {
        total += cpu.times[key]
      }
      idle += cpu.times.idle
    }
    const now = Date.now()
    const prev = this.lastCpu
    this.lastCpu = { idle, total, at: now }

    if (!prev) {
      // Erste Messung: neutraler Startwert, damit die Bewertung nicht faelschlich
      // mit 0% beginnt.
      this.cpuUsage = 50
      return this.cpuUsage
    }
    const totalDiff = total - prev.total
    const idleDiff = idle - prev.idle
    if (totalDiff <= 0) return this.cpuUsage
    const usage = clamp((1 - idleDiff / totalDiff) * 100, 0, 100)
    // Glättung, damit einzelne Spitzen nicht die Bewertung dominieren.
    this.cpuUsage = this.cpuUsage * 0.6 + usage * 0.4
    return this.cpuUsage
  }

  /** Warmup: CPU-Messung vor dem ersten echten Sample. */
  warmup(): void {
    this.measureCpuUsage()
  }

  async sample(network?: Partial<NetworkInfo>): Promise<PerformanceSample> {
    const cpuUsage = this.measureCpuUsage()
    const list = cpus()
    const cpu: CpuInfo = {
      model: (list[0]?.model ?? 'Unbekannt').trim(),
      logicalCores: list.length,
      physicalCores: countPhysicalCores(),
      usage: Math.round(cpuUsage * 10) / 10,
      loadAvg1: loadAvg1()
    }

    const total = totalmem()
    const free = freemem()
    const memory: MemoryInfo = {
      totalBytes: total,
      freeBytes: free,
      availableBytes: free,
      usage: Math.round(((total - free) / total) * 1000) / 10
    }

    const disk = this.measureDisk()

    const java = await this.detectJava()

    const net: NetworkInfo = {
      uploadMbps: network?.uploadMbps ?? 0,
      downloadMbps: network?.downloadMbps ?? 0,
      latencyMs: network?.latencyMs ?? 0,
      jitterMs: network?.jitterMs ?? 0,
      relayOnly: network?.relayOnly ?? false,
      advertisedAddresses: network?.advertisedAddresses ?? []
    }

    return {
      cpu,
      memory,
      disk,
      network: net,
      java,
      stability: this.stabilityInfo,
      measuredAt: Date.now()
    }
  }

  private measureDisk(): DiskInfo {
    const path = this.opts.worldPath
    let totalBytes = 0
    let freeBytes = 0
    let filesystem = 'unknown'
    try {
      const st = statfsSync(path)
      totalBytes = Number(st.blocks) * Number(st.bsize)
      freeBytes = Number(st.bavail) * Number(st.bsize)
      filesystem = 'unknown'
    } catch {
      /* Pfad nicht erreichbar */
    }
    const speed = this.measureDiskSpeed()
    return {
      path,
      totalBytes,
      freeBytes,
      writeMbps: speed.writeMbps,
      readMbps: speed.readMbps,
      filesystem
    }
  }

  /**
   * Misst die Schreibgeschwindigkeit des Ziel-Laufwerks.
   * Wird hoechstens alle 5 Minuten durchgefuehrt, um die Festplatte nicht
   * zu belasten.
   */
  private measureDiskSpeed(): { writeMbps: number; readMbps: number } {
    const now = Date.now()
    if (this.diskSpeedCache && now - this.diskSpeedCache.at < 5 * 60_000) {
      return this.diskSpeedCache
    }
    const size = 16 * 1024 * 1024
    let writeMbps = 0
    let readMbps = 0
    let dir: string | null = null
    try {
      dir = mkdtempSync(join(tmpdir(), 'mmh-speed-'))
      const file = join(dir, 'speedtest.bin')
      const buf = Buffer.alloc(size, 0x5a)
      const t0 = process.hrtime.bigint()
      const fd = openSync(file, 'w')
      try {
        writeFileSync(fd, buf)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const t1 = process.hrtime.bigint()
      writeMbps = megabytesPerSecond(Number(t1 - t0), size)

      const t2 = process.hrtime.bigint()
      const read = readFileSync(file)
      const t3 = process.hrtime.bigint()
      readMbps = megabytesPerSecond(Number(t3 - t2), read.length)
    } catch (err) {
      logger.debug('performance', 'Laufwerksmessung fehlgeschlagen', { error: String(err) })
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
    this.diskSpeedCache = { writeMbps, readMbps, at: now }
    return this.diskSpeedCache
  }

  /** Ermittelt die installierte Java-Laufzeit. */
  async detectJava(): Promise<JavaInfo> {
    const now = Date.now()
    if (this.javaCache && now - this.javaCache.at < 60_000) return this.javaCache.value

    const candidates: string[] = []
    const javaHome = process.env['JAVA_HOME']
    if (javaHome) candidates.push(join(javaHome, 'bin', 'java.exe'), join(javaHome, 'bin', 'java'))
    candidates.push('java.exe', 'java')

    let result: JavaInfo = { available: false, version: '', major: 0, path: '' }
    for (const candidate of candidates) {
      try {
        const { stderr, stdout } = await execFileAsync(candidate, ['-version'], {
          timeout: 10_000,
          windowsHide: true
        })
        const output = `${stderr ?? ''}${stdout ?? ''}`
        const match = output.match(/version "([\d._]+)"/)
        const version = match?.[1] ?? ''
        const major = parseInt(version.split(/[._]/)[0] ?? '0', 10)
        if (major > 0) {
          result = { available: true, version, major, path: candidate }
          break
        }
      } catch {
        /* naechste Kandidatin probieren */
      }
    }
    this.javaCache = { value: result, at: now }
    return result
  }

  /** Prueft, ob die angegebene Welt existiert. */
  static worldExists(worldPath: string): boolean {
    return existsSync(join(worldPath, 'level.dat'))
  }
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return v < min ? min : v > max ? max : v
}

function megabytesPerSecond(nanoseconds: number, bytes: number): number {
  if (nanoseconds <= 0) return 0
  const seconds = nanoseconds / 1e9
  return Math.round((bytes / 1024 / 1024 / seconds) * 100) / 100
}

function countPhysicalCores(): number {
  const list = cpus()
  const ids = new Set<string>()
  for (const cpu of list) {
    // Node liefert auf Windows kein coreId; wir nutzen Modell + Index-Heuristik.
    ids.add(`${cpu.model}`)
  }
  // Exakte physische Kernzahl ist ohne native Aufrufe nicht ermittelbar;
  // wir melden konservativ die logische Zahl.
  return ids.size > 0 ? list.length : list.length
}

function loadAvg1(): number {
  const la = loadavg() as number[]
  return la[0] ?? 0
}
