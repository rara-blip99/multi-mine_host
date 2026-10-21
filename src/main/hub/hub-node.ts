import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Stream } from '@libp2p/interface'
import { PROTOCOLS, signatureBody } from '@shared/protocol'
import type {
  GroupCreatePayload,
  GroupJoinPayload,
  HeartbeatPayload,
  InviteCreatePayload,
  LeaseAcquireRequest,
  LeaseReleaseRequest,
  PeerDiscoveryRequest,
  RpcRequest,
  RpcResponse,
  WorldCommitPayload
} from '@shared/protocol'
import { createPeerNode } from '../net/transport'
import type { PeerNode } from '../net/transport'
import { readFrames, writeFrame } from '../net/framing'
import { HubError, HubService } from './hub-service'
import type { HubOptions } from './hub-service'
import { IdentityStore, deriveNodeId } from '../security/identity'
import { logger } from '../core/logger'

/**
 * Netzwerk-Frontend des Koordinations-Hubs.
 *
 * Der Hub ist ein normaler libp2p-Knoten mit Relay-Server-Funktion. Ueber
 * `/multimine/hub/1.0.0` nimmt er Koordinationsanfragen entgegen.
 */

export interface HubNodeOptions extends HubOptions {
  /** Multiaddrs, auf denen der Hub lauscht. */
  listen: string[]
  /** Datei fuer die persistente Zustandssicherung. */
  dataFile?: string
}

export class HubNode {
  readonly service: HubService
  private peer: PeerNode | null = null
  private readonly dataFile: string | null
  private persistTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: HubNodeOptions) {
    this.service = new HubService({ token: opts.token, authority: opts.authority })
    this.dataFile = opts.dataFile ?? null
    if (this.dataFile && existsSync(this.dataFile)) {
      try {
        this.service.restore(readFileSync(this.dataFile, 'utf8'))
      } catch (err) {
        logger.error('hub', 'Hub-Zustand konnte nicht geladen werden', { error: String(err) })
      }
    }
  }

  async start(): Promise<void> {
    this.peer = await createPeerNode({
      listen: this.opts.listen,
      isHub: true,
      appName: 'multi-mine-hub/0.1.0'
    })
    await this.peer.handle(PROTOCOLS.hub, (stream) => this.handleStream(stream))
    this.persistTimer = setInterval(() => this.persist(), 10_000)
    logger.info('hub', 'Hub gestartet', {
      peerId: this.peer.node.peerId.toString(),
      addresses: this.peer.addresses()
    })
  }

  async stop(): Promise<void> {
    if (this.persistTimer) clearInterval(this.persistTimer)
    this.persist()
    await this.peer?.stop()
    this.peer = null
  }

  get peerId(): string {
    return this.peer?.node.peerId.toString() ?? ''
  }

  get addresses(): string[] {
    return this.peer?.addresses() ?? []
  }

  private persist(): void {
    if (!this.dataFile) return
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true })
      writeFileSync(this.dataFile, this.service.serialize(), 'utf8')
    } catch (err) {
      logger.error('hub', 'Hub-Zustand konnte nicht gespeichert werden', { error: String(err) })
    }
  }

  private async handleStream(stream: Stream): Promise<void> {
    try {
      for await (const frame of readFrames(stream)) {
        let req: RpcRequest
        try {
          req = JSON.parse(new TextDecoder().decode(frame)) as RpcRequest
        } catch {
          continue
        }
        const res = await this.dispatch(req)
        await writeFrame(stream, new TextEncoder().encode(JSON.stringify(res)))
      }
    } catch (err) {
      logger.debug('hub', 'Hub-Stream beendet', { error: String(err) })
    }
  }

  private async dispatch(req: RpcRequest): Promise<RpcResponse> {
    const respond = (payload: unknown): RpcResponse => ({
      v: req.v,
      id: req.id,
      type: req.type,
      ok: true,
      payload,
      ts: Date.now()
    })
    const fail = (error: string, errorCode = 'ERROR'): RpcResponse => ({
      v: req.v,
      id: req.id,
      type: req.type,
      ok: false,
      error,
      errorCode,
      ts: Date.now()
    })

    try {
      // 1) Signaturpruefung (ausser bei create/join - dort wird der Key erst registriert)
      const needsKey = req.type !== 'hub.create' && req.type !== 'hub.join'
      if (needsKey) {
        const publicKey = this.service.getPublicKey(req.from)
        if (!publicKey) return fail('Unbekannter Absender', 'UNKNOWN_SENDER')
        if (!req.sig) return fail('Anfrage ist nicht signiert', 'UNSIGNED')
        const valid = IdentityStore.verifyWith(publicKey, signatureBody(req), req.sig)
        if (!valid) return fail('Ungültige Signatur', 'BAD_SIGNATURE')
      }

      switch (req.type) {
        case 'hub.create': {
          const payload = req.payload as GroupCreatePayload
          assertKeyMatchesNode(req, payload.publicKey)
          const result = this.service.createGroup(req.from, publicKeyOf(req), {
            groupId: payload.groupId,
            name: payload.name,
            displayName: payload.displayName,
            peerId: payload.peerId,
            hubToken: payload.hubToken,
            hubAddress: payload.hubAddress
          })
          return respond({ kind: 'group', snapshot: result.snapshot, sessionToken: result.sessionToken })
        }
        case 'hub.join': {
          const payload = req.payload as GroupJoinPayload
          assertKeyMatchesNode(req, payload.publicKey)
          const result = this.service.joinGroup(req.from, publicKeyOf(req), {
            groupId: payload.groupId,
            inviteCode: payload.inviteCode,
            displayName: payload.displayName,
            peerId: payload.peerId,
            capability: payload.capability
          })
          return respond({ kind: 'group', snapshot: result.snapshot, sessionToken: result.sessionToken })
        }
        case 'hub.heartbeat': {
          const payload = req.payload as HeartbeatPayload
          this.service.authenticate(req.from, req.auth, payload.groupId)
          this.service.setPeerId(payload.groupId, req.from, payload.peerId)
          const snapshot = this.service.heartbeat(
            req.from,
            payload.groupId,
            payload.capability,
            payload.addresses ?? []
          )
          return respond({ kind: 'hello', snapshot })
        }
        case 'hub.leave': {
          const payload = req.payload as { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          this.service.leaveGroup(req.from, payload.groupId)
          return respond({ kind: 'ok' })
        }
        case 'hub.removeMember': {
          const payload = req.payload as { groupId: string; nodeId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const snapshot = this.service.removeMember(req.from, payload.groupId, payload.nodeId)
          return respond({ kind: 'members', members: snapshot.members })
        }
        case 'hub.setMemberAllowed': {
          const payload = req.payload as { groupId: string; nodeId: string; allowed: boolean }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const snapshot = this.service.setMemberAllowed(
            req.from,
            payload.groupId,
            payload.nodeId,
            payload.allowed
          )
          return respond({ kind: 'members', members: snapshot.members })
        }
        case 'hub.setPriority': {
          const payload = req.payload as { groupId: string; priority: number }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const snapshot = this.service.setOwnPriority(req.from, payload.groupId, payload.priority)
          return respond({ kind: 'members', members: snapshot.members })
        }
        case 'hub.createInvite': {
          const payload = req.payload as InviteCreatePayload & { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const invites = this.service.createInvite(req.from, payload.groupId, payload)
          return respond({ kind: 'invites', invites })
        }
        case 'hub.revokeInvite': {
          const payload = req.payload as { groupId: string; inviteId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const invites = this.service.revokeInvite(req.from, payload.groupId, payload.inviteId)
          return respond({ kind: 'invites', invites })
        }
        case 'hub.listInvites': {
          const payload = req.payload as { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const invites = this.service.listInvites(req.from, payload.groupId)
          return respond({ kind: 'invites', invites })
        }
        case 'hub.leaseAcquire': {
          const payload = req.payload as LeaseAcquireRequest & { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const result = this.service.leaseAcquire(req.from, payload.groupId, payload)
          return respond({ kind: 'lease', result })
        }
        case 'hub.leaseRenew': {
          const payload = req.payload as { groupId: string; epoch: number }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const result = this.service.leaseRenew(req.from, payload.groupId, payload.epoch)
          return respond({ kind: 'leaseStatus', lease: result.lease })
        }
        case 'hub.leaseRelease': {
          const payload = req.payload as LeaseReleaseRequest & { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          this.service.leaseRelease(req.from, payload.groupId, payload)
          return respond({ kind: 'ok' })
        }
        case 'hub.leaseStatus': {
          const payload = req.payload as { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          return respond({ kind: 'leaseStatus', lease: this.service.leaseStatus(payload.groupId) })
        }
        case 'hub.revokeLease': {
          const payload = req.payload as { groupId: string; reason: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          this.service.leaseRevoke(req.from, payload.groupId, payload.reason)
          return respond({ kind: 'ok' })
        }
        case 'hub.worldCommit': {
          const payload = req.payload as WorldCommitPayload
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const entry = this.service.worldCommit(req.from, payload.groupId, payload)
          return respond({ kind: 'world', entry })
        }
        case 'hub.worldState': {
          const payload = req.payload as { groupId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          return respond({ kind: 'world', entry: this.service.worldState(payload.groupId) })
        }
        case 'hub.addReplica': {
          const payload = req.payload as { groupId: string; versionId: string }
          this.service.authenticate(req.from, req.auth, payload.groupId)
          this.service.addReplica(req.from, payload.groupId, payload.versionId)
          return respond({ kind: 'ok' })
        }
        case 'hub.discovery': {
          const payload = req.payload as PeerDiscoveryRequest
          this.service.authenticate(req.from, req.auth, payload.groupId)
          const peers = this.service.discovery(req.from, payload.groupId, payload.addresses ?? [])
          return respond({ kind: 'discovery', peers })
        }
        default:
          return fail(`Unbekannter Nachrichtentyp: ${req.type}`, 'UNKNOWN_TYPE')
      }
    } catch (err) {
      if (err instanceof HubError) {
        logger.warn('hub', `Anfrage abgelehnt: ${req.type}`, { code: err.code, error: err.message })
        return fail(err.message, err.code)
      }
      logger.error('hub', `Fehler bei ${req.type}`, { error: String(err) })
      return fail(String(err), 'INTERNAL')
    }
  }
}

/**
 * Der oeffentliche Schluessel wird in der Registrierungsanfrage mitgesendet.
 * Er wird in das Feld `publicKey` gelegt (nicht Teil des signierten Bodys, da der
 * Absender den Key ja erst registriert).
 */
function publicKeyOf(req: RpcRequest): string {
  const payload = req.payload as { publicKey?: string } | undefined
  return payload?.publicKey ?? ''
}

/**
 * Bindet die nodeId an den oeffentlichen Schluessel. Ohne diese Pruefung
 * koennte ein Angreifer mit einem gueltigen Einladungscode eine fremde
 * nodeId beanspruchen.
 */
function assertKeyMatchesNode(req: RpcRequest, publicKey: string): void {
  if (!publicKey) {
    throw new HubError('Öffentlicher Schlüssel fehlt', 'NO_PUBLIC_KEY')
  }
  let derived: string
  try {
    derived = deriveNodeId(Buffer.from(publicKey, 'base64'))
  } catch {
    throw new HubError('Öffentlicher Schlüssel ist ungültig', 'BAD_PUBLIC_KEY')
  }
  if (derived !== req.from) {
    throw new HubError('nodeId passt nicht zum öffentlichen Schlüssel', 'IDENTITY_MISMATCH')
  }
}
