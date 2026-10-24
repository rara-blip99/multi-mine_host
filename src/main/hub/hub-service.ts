import { randomBytes, randomUUID } from 'node:crypto'
import type {
  GroupInfo,
  GroupMember,
  GroupSnapshot,
  HostCapability,
  HostLease,
  LeaseAcquireResult,
  WorldRegistryEntry
} from '@shared/types'
import type {
  InviteCreatePayload,
  InviteInfo,
  LeaseAcquireRequest,
  LeaseReleaseRequest,
  PeerDiscoveryInfo,
  WorldCommitPayload
} from '@shared/protocol'
import { LeaseAuthority } from '../host/lease-authority'
import {
  checkInvite,
  formatInviteCode,
  generateInviteSecret,
  hashInviteCode
} from '../security/invites'
import { logger } from '../core/logger'

/**
 * Koordinationslogik des Hubs.
 *
 * Bewusst frei von Netzwerkcode: der Hub-Node (libp2p) ruft `handle()` auf,
 * Tests koennen den Hub aber direkt mit Requests fuettern.
 *
 * Der Hub ist die einzige Stelle, die
 *   - Gruppenmitgliedschaft und Rollen verwaltet,
 *   - Einladungen ausstellt und widerruft,
 *   - die Host-Lease mit monoton steigenden Epochen vergibt (Fencing),
 *   - den aktuellen Weltstand registriert.
 */

export interface HubMemberRecord extends GroupMember {
  /** Sitzungstoken des Mitglieds (widerrufbar). */
  sessionToken: string
  /** Bekannte Multiaddrs des Mitglieds. */
  addresses: string[]
  /** Peer-ID (libp2p) des Mitglieds. */
  peerId: string | null
  /** Zuletzt gemeldete Leistungsdaten. */
  capability: HostCapability | null
}

export interface HubGroupRecord {
  group: GroupInfo
  members: Map<string, HubMemberRecord>
  invites: Map<string, InviteInfo & { hash: string }>
  /** Node-ID -> Peer-ID */
  peerIds: Map<string, string>
}

export interface HubOptions {
  /** Optionales Hub-Token (PSK). Ohne Token kann jeder eine Gruppe eroeffnen. */
  token?: string | null
  /** Lease-Autoritaet (kann injiziert werden fuer Tests). */
  authority?: LeaseAuthority
  /** Ablaufzeit fuer Sitzungstokens (ms). */
  sessionTtlMs?: number
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'HubError'
  }
}

/** Eingabe zum Anlegen einer Gruppe (ohne Netzwerk-spezifische Felder). */
export interface CreateGroupInput {
  groupId: string
  name: string
  displayName: string
  /** libp2p-Peer-ID des Erstellers. */
  peerId?: string
  /** Optionales Hub-Token (PSK). */
  hubToken?: string
  /** Adresse des Hubs (wird vom Hub selbst gesetzt). */
  hubAddress?: string
}

/** Eingabe zum Beitreten einer Gruppe. */
export interface JoinGroupInput {
  groupId: string
  inviteCode: string
  displayName: string
  peerId?: string
  capability?: HostCapability
}

const OFFLINE_AFTER_MS = 45_000

export class HubService {
  private readonly groups = new Map<string, HubGroupRecord>()
  private readonly authority: LeaseAuthority
  private readonly token: string | null
  private readonly sessionTtlMs: number
  /** nodeId -> {token, expiresAt} */
  private readonly sessions = new Map<string, { token: string; expiresAt: number; groupId: string }>()
  /** nodeId -> publicKey (global, ueber alle Gruppen hinweg) */
  private readonly publicKeys = new Map<string, string>()

  constructor(opts: HubOptions = {}) {
    this.authority = opts.authority ?? new LeaseAuthority()
    this.token = opts.token ?? null
    this.sessionTtlMs = opts.sessionTtlMs ?? 7 * 24 * 3600 * 1000
  }

  // -------------------------------------------------------------------------
  // Gruppen
  // -------------------------------------------------------------------------

  createGroup(
    requesterNodeId: string,
    publicKey: string,
    payload: CreateGroupInput,
    now = Date.now()
  ): { snapshot: GroupSnapshot; sessionToken: string } {
    if (this.token && payload.hubToken !== this.token) {
      throw new HubError('Ungültiges Hub-Token', 'BAD_HUB_TOKEN')
    }
    const groupId = payload.groupId || randomUUID()
    if (this.groups.has(groupId)) {
      throw new HubError('Gruppe existiert bereits', 'GROUP_EXISTS')
    }
    this.registerPublicKey(requesterNodeId, publicKey)
    const inviteSecret = generateInviteSecret()
    const inviteId = randomUUID()
    const group: GroupInfo = {
      groupId,
      name: payload.name || 'Meine Gruppe',
      createdAt: now,
      hubAddress: payload.hubAddress ?? '',
      currentWorldVersionId: null
    }
    const record: HubGroupRecord = {
      group,
      members: new Map(),
      invites: new Map(),
      peerIds: new Map()
    }
    record.invites.set(inviteId, {
      inviteId,
      name: 'Erste Einladung',
      code: formatInviteCode(inviteSecret),
      hash: hashInviteCode(inviteSecret),
      createdAt: now,
      expiresAt: null,
      maxUses: 0,
      uses: 0,
      revoked: false,
      createdBy: requesterNodeId
    })
    const sessionToken = this.createSession(requesterNodeId, groupId, now)
    const member: HubMemberRecord = {
      nodeId: requesterNodeId,
      publicKey,
      displayName: payload.displayName || 'Owner',
      role: 'owner',
      hostingAllowed: true,
      hostingPriority: 50,
      joinedAt: now,
      lastSeenAt: now,
      online: true,
      revoked: false,
      sessionToken,
      addresses: [],
      peerId: null,
      capability: null
    }
    record.members.set(requesterNodeId, member)
    this.groups.set(groupId, record)
    logger.info('hub', `Gruppe "${group.name}" erstellt`, { groupId, owner: requesterNodeId })
    return { snapshot: this.snapshot(groupId, now), sessionToken }
  }

  private isInternalCreate(_payload: CreateGroupInput): boolean {
    return false
  }

  joinGroup(
    requesterNodeId: string,
    publicKey: string,
    payload: JoinGroupInput,
    now = Date.now()
  ): { snapshot: GroupSnapshot; sessionToken: string } {
    const record = this.groups.get(payload.groupId)
    if (!record) throw new HubError('Gruppe nicht gefunden', 'GROUP_NOT_FOUND')
    this.registerPublicKey(requesterNodeId, publicKey)

    // Einladung suchen und pruefen
    let matched: { id: string; invite: InviteInfo & { hash: string } } | null = null
    for (const [id, invite] of record.invites) {
      const check = checkInvite(payload.inviteCode, invite.hash, invite, now)
      if (check.valid) {
        matched = { id, invite }
        break
      }
    }
    if (!matched) {
      throw new HubError('Einladungscode ist ungültig, abgelaufen oder widerrufen', 'BAD_INVITE')
    }

    const existing = record.members.get(requesterNodeId)
    if (existing && !existing.revoked) {
      // Wiederkehrendes Mitglied: Sitzung erneuern, Einladung nicht verbrauchen.
      const sessionToken = this.createSession(requesterNodeId, payload.groupId, now)
      existing.sessionToken = sessionToken
      existing.lastSeenAt = now
      existing.online = true
      existing.displayName = payload.displayName ?? existing.displayName
      existing.peerId = payload.peerId ?? existing.peerId
      if (payload.capability) {
        existing.addresses = payload.capability.network.advertisedAddresses
      }
      return { snapshot: this.snapshot(payload.groupId, now), sessionToken }
    }
    if (existing && existing.revoked) {
      throw new HubError('Mitgliedschaft wurde widerrufen', 'MEMBER_REVOKED')
    }

    matched.invite.uses += 1
    const sessionToken = this.createSession(requesterNodeId, payload.groupId, now)
    const member: HubMemberRecord = {
      nodeId: requesterNodeId,
      publicKey,
      displayName: payload.displayName || 'Neues Mitglied',
      role: 'member',
      hostingAllowed: true,
      hostingPriority: 50,
      joinedAt: now,
      lastSeenAt: now,
      online: true,
      revoked: false,
      sessionToken,
      addresses: payload.capability?.network.advertisedAddresses ?? [],
      peerId: payload.peerId || null,
      capability: payload.capability ?? null
    }
    record.members.set(requesterNodeId, member)
    logger.info('hub', `Mitglied beigetreten`, {
      groupId: payload.groupId,
      nodeId: requesterNodeId,
      name: member.displayName
    })
    return { snapshot: this.snapshot(payload.groupId, now), sessionToken }
  }

  leaveGroup(nodeId: string, groupId: string, now = Date.now()): void {
    const record = this.groups.get(groupId)
    if (!record) return
    const member = record.members.get(nodeId)
    if (!member) return
    if (member.role === 'owner') {
      throw new HubError(
        'Der Gruppenbesitzer muss die Gruppe nicht verlassen - stattdessen Mitgliedschaften entziehen',
        'OWNER_CANNOT_LEAVE'
      )
    }
    record.members.delete(nodeId)
    this.sessions.delete(nodeId)
    // Hat das Mitglied die Lease gehalten? Dann freigeben.
    const lease = this.authority.status(groupId, now)
    if (lease && lease.holderId === nodeId) {
      this.authority.release(groupId, nodeId, lease.epoch, 'Mitglied hat die Gruppe verlassen')
    }
    logger.info('hub', 'Mitglied hat die Gruppe verlassen', { groupId, nodeId })
  }

  removeMember(actorId: string, groupId: string, targetId: string, now = Date.now()): GroupSnapshot {
    const record = this.requireGroup(groupId)
    this.requireAdmin(record, actorId)
    const target = record.members.get(targetId)
    if (!target) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    if (target.role === 'owner') throw new HubError('Der Besitzer kann nicht entfernt werden', 'CANNOT_REMOVE_OWNER')
    record.members.delete(targetId)
    this.sessions.delete(targetId)
    const lease = this.authority.status(groupId, now)
    if (lease && lease.holderId === targetId) {
      this.authority.release(groupId, targetId, lease.epoch, 'Mitglied entfernt')
    }
    logger.info('hub', 'Mitglied entfernt', { groupId, targetId, by: actorId })
    return this.snapshot(groupId, now)
  }

  setMemberAllowed(
    actorId: string,
    groupId: string,
    targetId: string,
    allowed: boolean,
    now = Date.now()
  ): GroupSnapshot {
    const record = this.requireGroup(groupId)
    this.requireAdmin(record, actorId)
    const target = record.members.get(targetId)
    if (!target) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    if (target.role === 'owner') {
      throw new HubError('Die Hosting-Freigabe des Besitzers kann nicht deaktiviert werden', 'CANNOT_DISABLE_OWNER')
    }
    target.hostingAllowed = allowed
    return this.snapshot(groupId, now)
  }

  setOwnPriority(nodeId: string, groupId: string, priority: number, now = Date.now()): GroupSnapshot {
    const record = this.requireGroup(groupId)
    const member = record.members.get(nodeId)
    if (!member) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    member.hostingPriority = Math.max(0, Math.min(100, Math.round(priority)))
    return this.snapshot(groupId, now)
  }

  // -------------------------------------------------------------------------
  // Einladungen
  // -------------------------------------------------------------------------

  createInvite(
    actorId: string,
    groupId: string,
    payload: InviteCreatePayload,
    now = Date.now()
  ): InviteInfo[] {
    const record = this.requireGroup(groupId)
    this.requireAdmin(record, actorId)
    const secret = generateInviteSecret()
    const inviteId = randomUUID()
    const invite: InviteInfo & { hash: string } = {
      inviteId,
      name: payload.name || 'Einladung',
      code: formatInviteCode(secret),
      hash: hashInviteCode(secret),
      createdAt: now,
      expiresAt: payload.expiresInMs > 0 ? now + payload.expiresInMs : null,
      maxUses: Math.max(0, payload.maxUses | 0),
      uses: 0,
      revoked: false,
      createdBy: actorId
    }
    record.invites.set(inviteId, invite)
    return this.listInvites(actorId, groupId)
  }

  revokeInvite(actorId: string, groupId: string, inviteId: string, now = Date.now()): InviteInfo[] {
    const record = this.requireGroup(groupId)
    this.requireAdmin(record, actorId)
    const invite = record.invites.get(inviteId)
    if (!invite) throw new HubError('Einladung nicht gefunden', 'INVITE_NOT_FOUND')
    invite.revoked = true
    return this.listInvites(actorId, groupId)
  }

  listInvites(actorId: string, groupId: string): InviteInfo[] {
    const record = this.requireGroup(groupId)
    this.requireMember(record, actorId)
    return [...record.invites.values()].map((i) => ({
      inviteId: i.inviteId,
      name: i.name,
      code: i.code,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      maxUses: i.maxUses,
      uses: i.uses,
      revoked: i.revoked,
      createdBy: i.createdBy
    }))
  }

  // -------------------------------------------------------------------------
  // Sitzungen / Heartbeat
  // -------------------------------------------------------------------------

  private createSession(nodeId: string, groupId: string, now: number): string {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(nodeId, { token, expiresAt: now + this.sessionTtlMs, groupId })
    return token
  }

  /** Prueft die Authentizierung eines Mitglieds. */
  authenticate(nodeId: string, auth: string | undefined, groupId: string): HubMemberRecord {
    if (!auth) throw new HubError('Fehlendes Sitzungstoken', 'NO_AUTH')
    const session = this.sessions.get(nodeId)
    if (!session || session.groupId !== groupId) {
      throw new HubError('Unbekannte oder abgelaufene Sitzung', 'BAD_SESSION')
    }
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(nodeId)
      throw new HubError('Sitzung abgelaufen', 'SESSION_EXPIRED')
    }
    if (session.token !== auth) {
      throw new HubError('Ungültiges Sitzungstoken', 'BAD_SESSION')
    }
    const record = this.requireGroup(groupId)
    const member = record.members.get(nodeId)
    if (!member) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    if (member.revoked) throw new HubError('Mitgliedschaft wurde widerrufen', 'MEMBER_REVOKED')
    return member
  }

  heartbeat(
    nodeId: string,
    groupId: string,
    capability: HostCapability,
    addresses: string[],
    now = Date.now()
  ): GroupSnapshot {
    const record = this.requireGroup(groupId)
    const member = record.members.get(nodeId)
    if (!member) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    member.lastSeenAt = now
    member.online = true
    if (capability) {
      member.capability = capability
      member.addresses = capability.network.advertisedAddresses ?? addresses
    } else if (addresses.length) {
      member.addresses = addresses
    }
    return this.snapshot(groupId, now)
  }

  /** Liefert die Peer-Informationen aller Mitglieder (fuer Direktverbindungen). */
  discovery(nodeId: string, groupId: string, addresses: string[], now = Date.now()): PeerDiscoveryInfo[] {
    const record = this.requireGroup(groupId)
    const member = record.members.get(nodeId)
    if (!member) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    member.addresses = addresses
    member.lastSeenAt = now
    const out: PeerDiscoveryInfo[] = []
    for (const m of record.members.values()) {
      if (m.revoked) continue
      out.push({
        nodeId: m.nodeId,
        displayName: m.displayName,
        peerId: m.peerId ?? '',
        addresses: m.addresses,
        lastSeenAt: m.lastSeenAt,
        online: now - m.lastSeenAt < OFFLINE_AFTER_MS
      })
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Lease (Fencing)
  // -------------------------------------------------------------------------

  leaseAcquire(
    nodeId: string,
    groupId: string,
    payload: LeaseAcquireRequest,
    now = Date.now()
  ): LeaseAcquireResult {
    this.requireGroup(groupId)
    const result = this.authority.acquire(groupId, nodeId, now, payload.priority)
    if (result.granted) {
      logger.info('hub', `Lease vergeben`, {
        groupId,
        holder: nodeId,
        epoch: result.lease.epoch
      })
    } else {
      logger.debug('hub', 'Lease-Anfrage abgelehnt', { groupId, nodeId, reason: result.reason })
    }
    return result
  }

  leaseRenew(nodeId: string, groupId: string, epoch: number, now = Date.now()): {
    ok: boolean
    lease: HostLease | null
    reason: string
    fenced: boolean
  } {
    return this.authority.renew(groupId, nodeId, epoch, now)
  }

  leaseRelease(nodeId: string, groupId: string, payload: LeaseReleaseRequest): boolean {
    return this.authority.release(groupId, nodeId, payload.epoch, payload.reason)
  }

  leaseStatus(groupId: string, now = Date.now()): HostLease | null {
    return this.authority.status(groupId, now)
  }

  leaseRevoke(actorId: string, groupId: string, reason: string): boolean {
    const record = this.requireGroup(groupId)
    this.requireAdmin(record, actorId)
    return this.authority.revoke(groupId, reason)
  }

  // -------------------------------------------------------------------------
  // Welt
  // -------------------------------------------------------------------------

  worldCommit(
    nodeId: string,
    groupId: string,
    payload: WorldCommitPayload,
    now = Date.now()
  ): WorldRegistryEntry | null {
    const result = this.authority.commitWorld(
      groupId,
      nodeId,
      payload.epoch,
      {
        versionId: payload.versionId,
        worldName: payload.worldName,
        mcVersion: payload.mcVersion,
        dataVersion: payload.dataVersion,
        committedAt: now,
        totalBytes: payload.totalBytes,
        replicaIds: payload.replicaIds
      },
      now
    )
    if (!result.ok) {
      logger.warn('hub', 'Welt-Commit abgelehnt', { groupId, nodeId, reason: result.reason })
      throw new HubError(result.reason, 'FENCED')
    }
    return result.entry
  }

  worldState(groupId: string): WorldRegistryEntry | null {
    return this.authority.world(groupId)
  }

  addReplica(nodeId: string, groupId: string, versionId: string): void {
    this.authority.addReplica(groupId, versionId, nodeId)
  }

  // -------------------------------------------------------------------------
  // Snapshot & Persistenz
  // -------------------------------------------------------------------------

  snapshot(groupId: string, now = Date.now()): GroupSnapshot {
    const record = this.requireGroup(groupId)
    const members: GroupMember[] = [...record.members.values()]
      .filter((m) => !m.revoked)
      .map((m) => ({
        nodeId: m.nodeId,
        publicKey: m.publicKey,
        displayName: m.displayName,
        role: m.role,
        hostingAllowed: m.hostingAllowed,
        hostingPriority: m.hostingPriority,
        joinedAt: m.joinedAt,
        lastSeenAt: m.lastSeenAt,
        online: now - m.lastSeenAt < OFFLINE_AFTER_MS,
        revoked: m.revoked
      }))
    const world = this.authority.world(groupId)
    const capabilities: HostCapability[] = [...record.members.values()]
      .filter((m) => !m.revoked && m.capability)
      .map((m) => ({
        ...(m.capability as HostCapability),
        // Der Hub ist die Wahrheit ueber Freigabe und Prioritaet.
        hostingAllowed: m.hostingAllowed,
        priority: m.hostingPriority,
        displayName: m.displayName
      }))
    return {
      group: { ...record.group, currentWorldVersionId: world?.versionId ?? null },
      members,
      capabilities,
      lease: this.authority.status(groupId, now),
      world,
      serverTime: now
    }
  }

  /** Alle Gruppen (fuer Diagnose). */
  listGroups(): GroupInfo[] {
    return [...this.groups.values()].map((r) => r.group)
  }

  getGroup(groupId: string): HubGroupRecord | undefined {
    return this.groups.get(groupId)
  }

  /** Serialisierbarer Zustand fuer die Persistenz des Hubs. */
  serialize(): string {
    const data = {
      version: 1,
      groups: [...this.groups.values()].map((r) => ({
        group: r.group,
        members: [...r.members.values()],
        invites: [...r.invites.values()],
        peerIds: [...r.peerIds.entries()]
      })),
      leases: this.authority.snapshot()
    }
    return JSON.stringify(data)
  }

  restore(json: string): void {
    try {
      const data = JSON.parse(json) as {
        groups: Array<{
          group: GroupInfo
          members: HubMemberRecord[]
          invites: Array<InviteInfo & { hash: string }>
          peerIds: Array<[string, string]>
        }>
        leases: Record<string, unknown>
      }
      this.groups.clear()
      for (const g of data.groups ?? []) {
        const record: HubGroupRecord = {
          group: g.group,
          members: new Map(g.members.map((m) => [m.nodeId, m])),
          invites: new Map(g.invites.map((i) => [i.inviteId, i])),
          peerIds: new Map(g.peerIds)
        }
        this.groups.set(record.group.groupId, record)
      }
      if (data.leases) {
        this.authority.restore(data.leases as never)
      }
      logger.info('hub', 'Zustand wiederhergestellt', { groups: this.groups.size })
    } catch (err) {
      logger.error('hub', 'Zustand konnte nicht wiederhergestellt werden', { error: String(err) })
    }
  }

  // -------------------------------------------------------------------------
  // interne Helfer
  // -------------------------------------------------------------------------

  private requireGroup(groupId: string): HubGroupRecord {
    const record = this.groups.get(groupId)
    if (!record) throw new HubError('Gruppe nicht gefunden', 'GROUP_NOT_FOUND')
    return record
  }

  private requireMember(record: HubGroupRecord, nodeId: string): HubMemberRecord {
    const member = record.members.get(nodeId)
    if (!member) throw new HubError('Mitglied nicht gefunden', 'MEMBER_NOT_FOUND')
    if (member.revoked) throw new HubError('Mitgliedschaft wurde widerrufen', 'MEMBER_REVOKED')
    return member
  }

  private requireAdmin(record: HubGroupRecord, nodeId: string): HubMemberRecord {
    const member = this.requireMember(record, nodeId)
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new HubError('Nur Besitzer und Administratoren dürfen das', 'NOT_ADMIN')
    }
    return member
  }

  /** Registriert die libp2p-Peer-ID eines Mitglieds. */
  setPeerId(groupId: string, nodeId: string, peerId: string): void {
    const record = this.groups.get(groupId)
    if (!record) return
    const member = record.members.get(nodeId)
    if (!member) return
    member.peerId = peerId
    record.peerIds.set(nodeId, peerId)
  }

  /** Bekannte Public Keys (fuer Signaturpruefung der Clients). */
  publicKeyMap(groupId: string): Map<string, string> {
    const record = this.groups.get(groupId)
    const map = new Map<string, string>()
    if (!record) return map
    for (const m of record.members.values()) map.set(m.nodeId, m.publicKey)
    return map
  }

  /** Registriert einen Public Key global (alle Gruppen). */
  registerPublicKey(nodeId: string, publicKey: string): void {
    this.publicKeys.set(nodeId, publicKey)
  }

  /** Globaler Public Key eines Knotens. */
  getPublicKey(nodeId: string): string | undefined {
    return this.publicKeys.get(nodeId)
  }

  /** Gruppen-ID zu Node-ID -> Peer-ID. */
  peerIds(groupId: string): Map<string, string> {
    return new Map(this.groups.get(groupId)?.peerIds ?? [])
  }
}
