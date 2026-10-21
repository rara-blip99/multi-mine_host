import type { Stream } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { PROTOCOLS, signatureBody } from '@shared/protocol'
import type { PeerDiscoveryInfo } from '@shared/protocol'
import type { WorldManifest } from '@shared/types'
import type { PeerNode } from './transport'
import { resolvePeerId } from './transport'
import { readFrames, writeFrame } from './framing'
import { IdentityStore } from '../security/identity'
import { logger } from '../core/logger'
import {
  FRAME_CONTROL,
  FRAME_ERROR,
  FRAME_TRANSFER_END,
  receiveWorld,
  sendWorld
} from '../sync/world-sync'
import type { ReceiveResult, ResumeEntry } from '../sync/world-sync'

/**
 * Direkte Verbindungen zwischen Gruppenmitgliedern.
 *
 * Ablauf einer Weltanfrage:
 *   1. Anfragender oeffnet einen Stream zum Anbieter.
 *   2. Anfragender sendet eine signierte Anfrage (mit Epoche und Weltversion).
 *   3. Anbieter prueft die Signatur und antwortet mit einem "Angebot"
 *      (Manifest der Welt, die er liefern kann).
 *   4. Anfragender bestaetigt, welche Dateien er bereits besitzt.
 *   5. Anbieter streamt die restlichen Dateien; jede Datei wird per SHA-256
 *      geprueft.
 *   6. Anfragender verifiziert die Welt und aktiviert sie atomar.
 */

export interface WorldOffer {
  versionId: string
  worldName: string
  mcVersion: string
  dataVersion: number
  totalBytes: number
  files: Array<{ path: string; size: number; sha256: string; mtimeMs: number }>
}

interface WorldRequestFrame {
  type: 'request'
  groupId: string
  epoch: number
  versionId: string
  from: string
  ts: number
  nonce: string
  sig: string
}

interface WorldAcceptFrame {
  type: 'accept'
  /** Dateien, die der Empfaenger bereits vollstaendig besitzt. */
  skip: string[]
  /** Dateien, die der Empfaenger teilweise besitzt (Fortsetzung). */
  resumes: Array<{ path: string; offset: number }>
}

interface WorldOfferFrame {
  type: 'offer'
  offer: WorldOffer
}

interface WorldErrorFrame {
  type: 'error'
  reason: string
}

export interface PeerManagerOptions {
  node: PeerNode
  identity: IdentityStore
  groupId: string
  /** Liefert die Welt, die angeboten werden soll (oder null). */
  provideWorld: (requesterNodeId: string) => Promise<{ worldPath: string; manifest: WorldManifest } | null>
  /** Bekannte Public Keys der Mitglieder (fuer Signaturpruefung). */
  publicKeys: () => Map<string, string>
  /** Aufloesung nodeId -> Peer-ID. */
  peerIdOf: (nodeId: string) => string | undefined
}

export class PeerManager {
  private readonly peers = new Map<string, PeerDiscoveryInfo>()

  constructor(private readonly opts: PeerManagerOptions) {}

  /** Registriert die Adressen der anderen Mitglieder im Peer-Store. */
  async updatePeers(list: PeerDiscoveryInfo[]): Promise<void> {
    this.peers.clear()
    for (const peer of list) {
      this.peers.set(peer.nodeId, peer)
      if (!peer.peerId) continue
      try {
        const peerId = await resolvePeerId(peer.peerId)
        const addrs: string[] = [...peer.addresses]
        if (addrs.length === 0) continue
        await this.opts.node.node.peerStore.save(peerId, {
          multiaddrs: addrs.map((a: string) => multiaddr(a))
        })
      } catch (err) {
        logger.debug('peer-manager', 'Adresse konnte nicht registriert werden', {
          nodeId: peer.nodeId,
          error: String(err)
        })
      }
    }
  }

  knownPeers(): PeerDiscoveryInfo[] {
    return [...this.peers.values()]
  }

  peer(nodeId: string): PeerDiscoveryInfo | undefined {
    return this.peers.get(nodeId)
  }

  /** Startet den Protokoll-Handler fuer Weltanfragen. */
  async listen(): Promise<void> {
    await this.opts.node.handle(PROTOCOLS.world, (stream) => this.handleIncoming(stream))
  }

  /**
   * Fordert eine Welt bei einem anderen Mitglied an.
   */
  async requestWorld(
    providerNodeId: string,
    targetPath: string,
    expected: WorldManifest,
    opts: {
      resume?: ResumeEntry[]
      onProgress?: (progress: import('@shared/types').SyncProgress) => void
      timeoutMs?: number
    } = {}
  ): Promise<ReceiveResult> {
    const peer = this.peers.get(providerNodeId)
    const peerId = peer?.peerId || this.opts.peerIdOf(providerNodeId)
    if (!peerId) {
      return {
        ok: false,
        versionId: null,
        bytesTransferred: 0,
        error: `Keine Peer-ID für ${providerNodeId} bekannt`,
        resumed: false,
        filesReceived: 0,
        filesSkipped: 0
      }
    }

    let stream: Stream
    try {
      stream = await this.opts.node.dial(peerId, PROTOCOLS.world, opts.timeoutMs ?? 60_000)
    } catch (err) {
      return {
        ok: false,
        versionId: null,
        bytesTransferred: 0,
        error: `Verbindung zu ${providerNodeId} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        resumed: false,
        filesReceived: 0,
        filesSkipped: 0
      }
    }

    try {
      // 1) Signierte Anfrage
      const request: WorldRequestFrame = {
        type: 'request',
        groupId: this.opts.groupId,
        epoch: 0,
        versionId: expected.versionId,
        from: this.opts.identity.nodeId,
        ts: Date.now(),
        nonce: randomId(),
        sig: ''
      }
      request.sig = this.opts.identity.sign(
        signatureBody({
          v: '1.0.0',
          id: request.nonce,
          type: 'world.request',
          ts: request.ts,
          nonce: request.nonce,
          from: request.from,
          payload: {
            groupId: request.groupId,
            versionId: request.versionId
          }
        })
      )
      await writeFrame(
        stream,
        Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(request), 'utf8')])
      )

      // 2) Angebot empfangen
      const iterator = readFrames(stream)
      const first = await iterator.next()
      if (first.done || !first.value) throw new Error('Anbieter hat nicht geantwortet')
      const type = first.value[0] as number
      const body = first.value.subarray(1)
      if (type === FRAME_ERROR) {
        const err = JSON.parse(new TextDecoder().decode(body)) as WorldErrorFrame
        throw new Error(err.reason)
      }
      if (type !== FRAME_CONTROL) throw new Error('Unerwartete Antwort vom Anbieter')
      const offerFrame = JSON.parse(new TextDecoder().decode(body)) as WorldOfferFrame
      if (offerFrame.offer.versionId !== expected.versionId) {
        throw new Error(
          `Der Anbieter hat eine andere Weltversion (${offerFrame.offer.versionId} statt ${expected.versionId})`
        )
      }

      // 3) Bereits vorhandene Dateien melden
      const plan = computeResumePlan(expected, opts.resume ?? [])
      await writeFrame(
        stream,
        Buffer.concat([
          Buffer.from([FRAME_CONTROL]),
          Buffer.from(
            JSON.stringify({ type: 'accept', skip: plan.skip, resumes: plan.resumes } satisfies WorldAcceptFrame),
            'utf8'
          )
        ])
      )

      // 4) Dateien empfangen
      const result = await receiveWorld(stream, {
        targetPath,
        manifest: expected,
        resume: opts.resume,
        onProgress: opts.onProgress
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('peer-manager', 'Weltanfrage fehlgeschlagen', { error: message })
      return {
        ok: false,
        versionId: null,
        bytesTransferred: 0,
        error: message,
        resumed: false,
        filesReceived: 0,
        filesSkipped: 0
      }
    } finally {
      try {
        await stream.close()
      } catch {
        /* ignore */
      }
    }
  }

  /** Behandelt eine eingehende Weltanfrage. */
  private async handleIncoming(stream: Stream): Promise<void> {
    const iterator = readFrames(stream)
    try {
      const first = await iterator.next()
      if (first.done || !first.value) return
      const type = first.value[0] as number
      if (type !== FRAME_CONTROL) return
      const body = first.value.subarray(1)
      const request = JSON.parse(new TextDecoder().decode(body)) as WorldRequestFrame
      if (request.type !== 'request') return

      // Signatur pruefen
      const publicKey = this.opts.publicKeys().get(request.from)
      if (!publicKey) {
        await this.sendError(stream, 'Unbekannter Absender')
        return
      }
      const valid = IdentityStore.verifyWith(
        publicKey,
        signatureBody({
          v: '1.0.0',
          id: request.nonce,
          type: 'world.request',
          ts: request.ts,
          nonce: request.nonce,
          from: request.from,
          payload: { groupId: request.groupId, versionId: request.versionId }
        }),
        request.sig
      )
      if (!valid) {
        await this.sendError(stream, 'Ungültige Signatur')
        return
      }
      if (request.groupId !== this.opts.groupId) {
        await this.sendError(stream, 'Anfrage gehört zu einer anderen Gruppe')
        return
      }
      // Zeitstempel pruefen (Replay-Schutz)
      if (Math.abs(Date.now() - request.ts) > 60_000) {
        await this.sendError(stream, 'Anfrage ist zu alt')
        return
      }

      const provided = await this.opts.provideWorld(request.from)
      if (!provided) {
        await this.sendError(stream, 'Es ist keine Welt zum Teilen vorhanden')
        return
      }

      // Angebot senden
      const offer: WorldOffer = {
        versionId: provided.manifest.versionId,
        worldName: provided.manifest.worldName,
        mcVersion: provided.manifest.mcVersion,
        dataVersion: provided.manifest.dataVersion,
        totalBytes: provided.manifest.totalBytes,
        files: provided.manifest.entries.map((e) => ({
          path: e.path,
          size: e.size,
          sha256: e.sha256,
          mtimeMs: e.mtimeMs
        }))
      }
      await writeFrame(
        stream,
        Buffer.concat([
          Buffer.from([FRAME_CONTROL]),
          Buffer.from(JSON.stringify({ type: 'offer', offer } satisfies WorldOfferFrame), 'utf8')
        ])
      )

      // Bestaetigung abwarten
      const second = await iterator.next()
      if (second.done || !second.value) return
      const acceptType = second.value[0] as number
      if (acceptType !== FRAME_CONTROL) return
      const accept = JSON.parse(new TextDecoder().decode(second.value.subarray(1))) as WorldAcceptFrame
      const skip = new Set(accept.skip ?? [])
      const resumeMap = new Map<string, number>()
      for (const r of accept.resumes ?? []) {
        if (r.offset > 0) resumeMap.set(r.path, r.offset)
      }

      // Dateien senden
      await sendWorld(stream, provided.worldPath, provided.manifest, { skip, resume: resumeMap })
      await writeFrame(
        stream,
        Buffer.concat([
          Buffer.from([FRAME_TRANSFER_END]),
          Buffer.from(JSON.stringify({ versionId: provided.manifest.versionId }), 'utf8')
        ])
      )
    } catch (err) {
      logger.debug('peer-manager', 'Weltanfrage fehlgeschlagen', { error: String(err) })
      try {
        await this.sendError(stream, err instanceof Error ? err.message : String(err))
      } catch {
        /* ignore */
      }
    }
  }

  private async sendError(stream: Stream, reason: string): Promise<void> {
    await writeFrame(
      stream,
      Buffer.concat([
        Buffer.from([FRAME_ERROR]),
        Buffer.from(JSON.stringify({ type: 'error', reason }), 'utf8')
      ])
    )
  }
}

/**
 * Berechnet, welche Dateien bereits vollstaendig vorhanden sind und wo
 * unterbrochene Dateien fortgesetzt werden koennen.
 */
export function computeResumePlan(
  manifest: WorldManifest,
  resume: ResumeEntry[]
): { skip: string[]; resumes: Array<{ path: string; offset: number }> } {
  const have = new Map(resume.map((r) => [r.path, r]))
  const skip: string[] = []
  const resumes: Array<{ path: string; offset: number }> = []
  for (const entry of manifest.entries) {
    const local = have.get(entry.path)
    if (!local) continue
    if (local.sha256 !== entry.sha256) continue
    if (local.received >= entry.size) {
      skip.push(entry.path)
    } else if (local.received > 0) {
      resumes.push({ path: entry.path, offset: local.received })
    }
  }
  return { skip, resumes }
}

/** Bequemer Zugriff auf die vollstaendig vorhandenen Dateien. */
export function computeSkip(manifest: WorldManifest, resume: ResumeEntry[]): string[] {
  return computeResumePlan(manifest, resume).skip
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
