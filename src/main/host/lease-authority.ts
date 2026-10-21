import type { HostLease, LeaseAcquireResult, WorldRegistryEntry } from '@shared/types'

/**
 * Host-Lease-Autoritaet ("Fencing Token" - Quelle der Wahrheit).
 *
 * Grundregeln:
 *  - Pro Gruppe existiert zu jedem Zeitpunkt hoechstens EINE gueltige Lease.
 *  - Jede Lease-Erteilung erhoeht die Epoche (monoton steigend, nie
 *    zuruecksetzbar, nie wiederverwendbar).
 *  - Ein Host mit veralteter Epoche ist "fenced": er darf die Welt nicht
 *    mehr beschreiben und muss den Minecraft-Server stoppen.
 *  - Die Welt wird nur unter einer aktuell gültigen Lease committed.
 *
 * Diese Klasse ist bewusst frei von Netzwerk- und Zeit-Abhaengigkeiten
 * (Clock wird injiziert), damit sie vollstaendig testbar ist.
 */

export const DEFAULT_LEASE_TTL_MS = 30_000
/** Zeit, die ein Kandidat warten muss, bevor er eine abgelaufene Lease uebernimmt. */
export const LEASE_GRACE_MS = 3_000

export interface LeaseAuthorityOptions {
  ttlMs?: number
  graceMs?: number
}

export interface RenewResult {
  ok: boolean
  lease: HostLease | null
  reason: string
  /** true, wenn die eigene Epoche veraltet ist -> sofortiges Stoppen noetig. */
  fenced: boolean
}

interface GroupLeaseState {
  groupId: string
  epoch: number
  lease: HostLease | null
  /** Epoche der zuletzt freigegebenen Lease (fuer Diagnose). */
  lastReleasedEpoch: number
  lastHolderId: string | null
  lastReason: string | null
  world: WorldRegistryEntry | null
}

export class LeaseAuthority {
  private readonly groups = new Map<string, GroupLeaseState>()
  private readonly ttlMs: number
  private readonly graceMs: number

  constructor(opts: LeaseAuthorityOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS
    this.graceMs = opts.graceMs ?? LEASE_GRACE_MS
  }

  private state(groupId: string): GroupLeaseState {
    let s = this.groups.get(groupId)
    if (!s) {
      s = {
        groupId,
        epoch: 0,
        lease: null,
        lastReleasedEpoch: 0,
        lastHolderId: null,
        lastReason: null,
        world: null
      }
      this.groups.set(groupId, s)
    }
    return s
  }

  /** Ist die Lease zum Zeitpunkt `now` noch gueltig? */
  private isValid(lease: HostLease | null, now: number): boolean {
    return !!lease && lease.expiresAt > now
  }

  /**
   * Versucht, die Lease fuer eine Gruppe zu erwerben.
   *
   * - Aktive Lease eines anderen Mitglieds -> abgelehnt (kein Split-Brain).
   * - Abgelaufene Lease -> neue Epoche (epoch + 1), Grazienzeit beachten.
   * - Eigene Lease -> erneuert mit neuer Epoche (Re-Election).
   */
  acquire(
    groupId: string,
    candidateId: string,
    now = Date.now(),
    priority = 0
  ): LeaseAcquireResult {
    const s = this.state(groupId)
    const current = s.lease

    if (this.isValid(current, now) && current && current.holderId !== candidateId) {
      return {
        granted: false,
        lease: current,
        reason: `Lease wird aktuell von ${current.holderId} gehalten (gueltig bis ${new Date(current.expiresAt).toISOString()})`
      }
    }

    if (current && current.holderId === candidateId && this.isValid(current, now)) {
      // Eigene Lease erneuern, aber mit neuer Epoche -> alte Tokens werden invalid.
      const epoch = s.epoch + 1
      s.epoch = epoch
      const lease: HostLease = {
        groupId,
        holderId: candidateId,
        epoch,
        acquiredAt: now,
        expiresAt: now + this.ttlMs,
        ttlMs: this.ttlMs,
        worldVersionId: s.world?.versionId ?? null
      }
      s.lease = lease
      s.lastHolderId = candidateId
      s.lastReason = `erneuert (Prioritaet ${priority})`
      return { granted: true, lease, reason: 'Eigene Lease wurde mit neuer Epoche erneuert' }
    }

    // Abgelaufene Lease: Grazienzeit abwarten, damit der alte Host seine
    // Verlängerung noch absetzen kann, bevor eine neue Epoche vergeben wird.
    if (current && !this.isValid(current, now)) {
      const sinceExpiry = now - current.expiresAt
      if (sinceExpiry < this.graceMs) {
        return {
          granted: false,
          lease: current,
          reason: `Lease vor ${this.graceMs - sinceExpiry} ms abgelaufen - Grazienzeit fuer den bisherigen Host`
        }
      }
    }

    const epoch = s.epoch + 1
    s.epoch = epoch
    const lease: HostLease = {
      groupId,
      holderId: candidateId,
      epoch,
      acquiredAt: now,
      expiresAt: now + this.ttlMs,
      ttlMs: this.ttlMs,
      worldVersionId: s.world?.versionId ?? null
    }
    s.lease = lease
    s.lastHolderId = candidateId
    s.lastReason = `neu vergeben (Prioritaet ${priority})`
    return {
      granted: true,
      lease,
      reason: current
        ? `Lease von ${current.holderId} war abgelaufen - neue Epoche ${epoch}`
        : `Neue Lease mit Epoche ${epoch}`
    }
  }

  /**
   * Verlaengert eine bestehende Lease.
   *
   * Wird die Lease mit falscher Epoche oder falschem Holder verlaengert, ist
   * der Aufrufer "fenced" und muss sofort den Server stoppen.
   */
  renew(groupId: string, holderId: string, epoch: number, now = Date.now()): RenewResult {
    const s = this.state(groupId)
    const current = s.lease

    if (!current) {
      return { ok: false, lease: null, reason: 'Keine Lease vorhanden', fenced: true }
    }
    if (current.holderId !== holderId) {
      return {
        ok: false,
        lease: current,
        reason: `Lease gehört jetzt ${current.holderId} (Epoche ${current.epoch}) - Aufrufer ist gefenced`,
        fenced: true
      }
    }
    if (current.epoch !== epoch) {
      return {
        ok: false,
        lease: current,
        reason: `Epoche veraltet: eigene ${epoch}, aktuell ${current.epoch} - Aufrufer ist gefenced`,
        fenced: true
      }
    }
    if (!this.isValid(current, now)) {
      return {
        ok: false,
        lease: current,
        reason: 'Lease war bereits abgelaufen - Aufrufer ist gefenced',
        fenced: true
      }
    }
    const renewed: HostLease = {
      ...current,
      expiresAt: now + this.ttlMs,
      ttlMs: this.ttlMs
    }
    s.lease = renewed
    return { ok: true, lease: renewed, reason: 'Lease verlaengert', fenced: false }
  }

  /**
   * Gibt die Lease kontrolliert frei (z.B. geordneter Host-Wechsel).
   * Die Epoche bleibt erhalten - die naechste Vergabe erhoeht sie weiter.
   */
  release(groupId: string, holderId: string, epoch: number, reason: string): boolean {
    const s = this.state(groupId)
    const current = s.lease
    if (!current) return false
    if (current.holderId !== holderId || current.epoch !== epoch) return false
    s.lastReleasedEpoch = current.epoch
    s.lastHolderId = holderId
    s.lastReason = reason
    s.lease = null
    return true
  }

  /** Admin-Aktion: Lease entziehen (z.B. bei Missbrauch). */
  revoke(groupId: string, reason: string): boolean {
    const s = this.state(groupId)
    if (!s.lease) return false
    s.lastReleasedEpoch = s.lease.epoch
    s.lastReason = `widerrufen: ${reason}`
    s.lease = null
    return true
  }

  /** Aktueller Zustand der Lease (inkl. abgelaufener Leases). */
  status(groupId: string, now = Date.now()): HostLease | null {
    const s = this.groups.get(groupId)
    if (!s) return null
    if (!s.lease) return null
    if (!this.isValid(s.lease, now)) {
      // Abgelaufene Leases werden nicht mehr als "gueltig" gemeldet.
      return { ...s.lease, expiresAt: s.lease.expiresAt }
    }
    return s.lease
  }

  /** Aktuelle (autoritative) Epoche der Gruppe. */
  currentEpoch(groupId: string): number {
    return this.state(groupId).epoch
  }

  /** Letzter bekannter Weltstand der Gruppe. */
  world(groupId: string): WorldRegistryEntry | null {
    return this.state(groupId).world
  }

  /**
   * Commit eines Weltstandes. Nur akzeptiert, wenn:
   *  - der Aufrufer eine aktuell gueltige Lease mit exakt dieser Epoche haelt
   *  - die Epoche nicht kleiner ist als die Epoche des letzten Commits
   */
  commitWorld(
    groupId: string,
    nodeId: string,
    epoch: number,
    entry: Omit<WorldRegistryEntry, 'ownerId' | 'epoch'>,
    now = Date.now()
  ): { ok: boolean; entry: WorldRegistryEntry | null; reason: string } {
    const s = this.state(groupId)
    const lease = s.lease
    if (!lease || !this.isValid(lease, now)) {
      return { ok: false, entry: null, reason: 'Keine gueltige Lease - Commit abgelehnt' }
    }
    if (lease.holderId !== nodeId || lease.epoch !== epoch) {
      return {
        ok: false,
        entry: null,
        reason: `Fencing: Lease gehört ${lease.holderId} mit Epoche ${lease.epoch}`
      }
    }
    const full: WorldRegistryEntry = {
      ...entry,
      ownerId: nodeId,
      epoch,
      // Replikate desgleichen Weltstandes bleiben erhalten.
      replicaIds: unique([
        ...(s.world && s.world.versionId === entry.versionId ? s.world.replicaIds : []),
        ...entry.replicaIds
      ])
    }
    s.world = full
    // Die Lease merkt sich, welche Weltversion sie beschreiben darf.
    s.lease = { ...lease, worldVersionId: full.versionId }
    return { ok: true, entry: full, reason: 'Weltversion committed' }
  }

  /** Vermerkt, dass ein Node eine Replik der Weltversion besitzt. */
  addReplica(groupId: string, versionId: string, nodeId: string): void {
    const s = this.state(groupId)
    if (!s.world || s.world.versionId !== versionId) return
    s.world = { ...s.world, replicaIds: unique([...s.world.replicaIds, nodeId]) }
  }

  /** Vollstaendiger Zustand (fuer Persistenz / Hub). */
  snapshot(): Record<string, GroupLeaseState> {
    return Object.fromEntries([...this.groups.entries()].map(([k, v]) => [k, { ...v }]))
  }

  /** Zustand aus einer Persistenz wiederherstellen. */
  restore(data: Record<string, GroupLeaseState>): void {
    this.groups.clear()
    for (const [k, v] of Object.entries(data)) {
      this.groups.set(k, { ...v })
    }
  }
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}
