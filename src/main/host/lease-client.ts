import type { HostLease, LeaseAcquireResult } from '@shared/types'
import { logger } from '../core/logger'

/**
 * Client-Seite der Host-Lease.
 *
 * Der Lease-Client ist das Sicherheits Herzstueck gegen Split-Brain:
 *  - Waehrend der Lease darf die Welt beschrieben werden.
 *  - Schlaegt die Verlaengerung fehl, gilt der Host als "fenced".
 *  - Ein fenced Host stoppt den Minecraft-Server SOFORT und committet
 *    keine Welt mehr.
 */

export interface LeaseClientOptions {
  /** Funktion zum Senden einer Hub-Anfrage. */
  call: <T = unknown>(type: string, payload: unknown, timeoutMs?: number) => Promise<T>
  groupId: string
  nodeId: string
  /** Wird aufgerufen, wenn die Lease verloren geht (Fencing!). */
  onFence: (reason: string) => void | Promise<void>
  /** Wird aufgerufen, wenn eine neue Lease gewaehrigt wurde. */
  onLease?: (lease: HostLease) => void
  /** Intervall der Verlaengerung (ms). */
  renewIntervalMs?: number
}

export interface RenewOutcome {
  ok: boolean
  fenced: boolean
  reason: string
  lease: HostLease | null
}

export class LeaseClient {
  private _lease: HostLease | null = null
  private _fenced = false
  private timer: NodeJS.Timeout | null = null
  private renewing = false
  private readonly renewIntervalMs: number

  constructor(private readonly opts: LeaseClientOptions) {
    this.renewIntervalMs = opts.renewIntervalMs ?? 10_000
  }

  get lease(): HostLease | null {
    return this._lease
  }

  get fenced(): boolean {
    return this._fenced
  }

  get epoch(): number {
    return this._lease?.epoch ?? 0
  }

  /** Versucht, die Lease zu erwerben. */
  async acquire(priority = 0): Promise<LeaseAcquireResult> {
    const result = await this.opts.call<LeaseAcquireResult>('hub.leaseAcquire', {
      groupId: this.opts.groupId,
      knownEpoch: this._lease?.epoch ?? 0,
      priority
    })
    if (result.granted && result.lease) {
      this._lease = result.lease
      this._fenced = false
      this.opts.onLease?.(result.lease)
    }
    return result
  }

  /** Verlaengert die Lease. Bei Fehlschlag wird der Host gefenced. */
  async renew(): Promise<RenewOutcome> {
    if (!this._lease) {
      return { ok: false, fenced: false, reason: 'Keine Lease gehalten', lease: null }
    }
    try {
      const lease = await this.opts.call<HostLease | null>('hub.leaseRenew', {
        groupId: this.opts.groupId,
        epoch: this._lease.epoch
      })
      if (!lease) {
        return this.fence('Lease wurde vom Hub nicht mehr bestätigt')
      }
      if (lease.epoch !== this._lease.epoch) {
        return this.fence(
          `Epoche veraltet: eigene ${this._lease.epoch}, aktuell ${lease.epoch}`
        )
      }
      this._lease = lease
      return { ok: true, fenced: false, reason: 'Lease verlängert', lease }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Ein Netzwerkfehler ist noch KEIN Fencing - der Host darf weiterlaufen,
      // solange die Lease auf Hub-Seite noch laeuft. Erst nach mehreren
      // fehlgeschlagenen Versuchen wird gefenced.
      this.failedRenews++
      if (this.failedRenews >= this.maxFailedRenews) {
        return this.fence(`Hub seit ${this.failedRenews} Versuchen nicht erreichbar: ${message}`)
      }
      logger.warn('lease', 'Lease-Verlängerung fehlgeschlagen', {
        attempt: this.failedRenews,
        error: message
      })
      return { ok: false, fenced: false, reason: message, lease: this._lease }
    }
  }

  private failedRenews = 0
  private readonly maxFailedRenews = 3

  private fence(reason: string): RenewOutcome {
    if (!this._fenced) {
      this._fenced = true
      logger.error('lease', 'FENCING: Lease verloren - der Server wird gestoppt', { reason })
      void this.opts.onFence(reason)
    }
    return { ok: false, fenced: true, reason, lease: this._lease }
  }

  /** Gibt die Lease frei (z.B. bei einem geordneten Host-Wechsel). */
  async release(reason: string): Promise<boolean> {
    if (!this._lease) return false
    try {
      await this.opts.call('hub.leaseRelease', {
        groupId: this.opts.groupId,
        epoch: this._lease.epoch,
        reason
      })
      logger.info('lease', 'Lease freigegeben', { reason })
      this._lease = null
      this.failedRenews = 0
      return true
    } catch (err) {
      logger.warn('lease', 'Lease konnte nicht freigegeben werden', { error: String(err) })
      return false
    }
  }

  /** Startet die automatische Verlaengerung. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (!this._lease || this._fenced) return
      void this.renew()
    }, this.renewIntervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Setzt den Zustand nach einem Neustart der Anwendung wieder her. */
  restore(lease: HostLease | null): void {
    this._lease = lease
    this._fenced = false
    this.failedRenews = 0
  }
}
