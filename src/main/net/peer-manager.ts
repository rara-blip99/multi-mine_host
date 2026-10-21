import type { Stream } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { PROTOCOLS, signatureBody } from '@shared/protocol'
import type { PeerDiscoveryInfo, BackupOfferFrame, BackupAcceptFrame } from '@shared/protocol'
import type { WorldManifest } from '@shared/types'
import type { PeerNode } from './transport'
import { resolvePeerId } from './transport'
import { readFrames, writeFrame } from './framing'
import { IdentityStore } from '../security/identity'
import { resolveWithin } from '../security/path-guard'
import { logger } from '../core/logger'
import {
  FRAME_CONTROL,
  FRAME_ERROR,
  FRAME_FILE_DATA,
  FRAME_TRANSFER_END,
  receiveWorld,
  sendWorld
} from '../sync/world-sync'
import { frame } from '../sync/world-sync'
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

interface QuiesceFrame {
  type: 'quiesce'
  groupId: string
  epoch: number
  from: string
  ts: number
  nonce: string
  sig: string
}

interface QuiesceResultFrame {
  type: 'quiesce-result'
  ok: boolean
  versionId: string
  error?: string
}

export interface PeerManagerOptions {
  node: PeerNode
  identity: IdentityStore
  groupId: string
  /** Liefert die Welt, die angeboten werden soll (oder null). */
  provideWorld: (requesterNodeId: string) => Promise<{ worldPath: string; manifest: WorldManifest } | null>
  /**
   * Fuehrt den kontrollierten Herunterfahren des Servers aus.
   * Liefert die Weltversion nach dem Stopp (oder null bei Fehler).
   */
  quiesceWorld: (
    requesterNodeId: string,
    epoch: number
  ) => Promise<{ ok: boolean; versionId: string; error?: string }>
  /** Bekannte Public Keys der Mitglieder (fuer Signaturpruefung). */
  publicKeys: () => Map<string, string>
  /** Aufloesung nodeId -> Peer-ID. */
  peerIdOf: (nodeId: string) => string | undefined
  /** Verzeichnis, in dem empfangene Backups abgelegt werden. */
  backupDir: () => string
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
        // Der Peer-Store erwartet reine Transportadressen ohne "/p2p/...".
        const addrs = peer.addresses
          .map((a) => a.replace(/\/p2p\/[^/]+$/, ''))
          .filter((a) => a.length > 0)
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

  /**
   * Fordert den bisherigen Host auf, den Server kontrolliert herunterzufahren.
   *
   * Ablauf auf der Gegenseite:
   *   save-off -> save-all flush -> stop
   * Danach wird die Weltversion gemeldet, die der neue Host uebernehmen soll.
   */
  async requestQuiesce(
    providerNodeId: string,
    epoch: number,
    timeoutMs = 60_000
  ): Promise<{ ok: boolean; versionId: string; error?: string }> {
    const peer = this.peers.get(providerNodeId)
    const peerId = peer?.peerId || this.opts.peerIdOf(providerNodeId)
    if (!peerId) {
      return { ok: false, versionId: '', error: `Keine Peer-ID für ${providerNodeId} bekannt` }
    }

    let stream: Stream
    try {
      stream = await this.opts.node.dial(peerId, PROTOCOLS.world, timeoutMs)
    } catch (err) {
      return {
        ok: false,
        versionId: '',
        error: `Verbindung zu ${providerNodeId} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    try {
      const request: QuiesceFrame = {
        type: 'quiesce',
        groupId: this.opts.groupId,
        epoch,
        from: this.opts.identity.nodeId,
        ts: Date.now(),
        nonce: randomId(),
        sig: ''
      }
      request.sig = this.opts.identity.sign(
        signatureBody({
          v: '1.0.0',
          id: request.nonce,
          type: 'world.quiesce',
          ts: request.ts,
          nonce: request.nonce,
          from: request.from,
          payload: { groupId: request.groupId, epoch: request.epoch }
        })
      )
      await writeFrame(
        stream,
        Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(request), 'utf8')])
      )

      const iterator = readFrames(stream)
      const first = await iterator.next()
      if (first.done || !first.value) throw new Error('Keine Antwort auf die Quiesce-Anfrage')
      const body = first.value.subarray(1)
      const result = JSON.parse(new TextDecoder().decode(body)) as QuiesceResultFrame
      if (result.type !== 'quiesce-result') throw new Error('Unerwartete Antwort')
      return { ok: result.ok, versionId: result.versionId, error: result.error }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, versionId: '', error: message }
    } finally {
      try {
        await stream.close()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Sendet ein Backup an ein anderes Mitglied (Replikation).
   */
  async sendBackup(
    targetNodeId: string,
    archivePath: string,
    meta: BackupOfferFrame['meta'],
    timeoutMs = 300_000
  ): Promise<{ ok: boolean; error?: string }> {
    const peer = this.peers.get(targetNodeId)
    const peerId = peer?.peerId || this.opts.peerIdOf(targetNodeId)
    if (!peerId) {
      return { ok: false, error: `Keine Peer-ID für ${targetNodeId} bekannt` }
    }

    let stream: Stream
    try {
      stream = await this.opts.node.dial(peerId, PROTOCOLS.world, timeoutMs)
    } catch (err) {
      return {
        ok: false,
        error: `Verbindung zu ${targetNodeId} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    try {
      const offer: BackupOfferFrame = {
        type: 'backup-offer',
        groupId: this.opts.groupId,
        meta
      }
      await writeFrame(
        stream,
        Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(offer), 'utf8')])
      )

      const iterator = readFrames(stream)
      const first = await iterator.next()
      if (first.done || !first.value) throw new Error('Keine Antwort auf das Backup-Angebot')
      const accept = JSON.parse(new TextDecoder().decode(first.value.subarray(1))) as BackupAcceptFrame
      if (accept.type !== 'backup-accept' || !accept.ok) {
        return { ok: false, error: accept.error ?? 'Das Mitglied hat das Backup abgelehnt' }
      }

      // Datei streamen
      const hash = createHash('sha256')
      await pipeline(
        createReadStream(archivePath, { highWaterMark: 256 * 1024 }),
        async function* (source) {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
            hash.update(buf)
            await writeFrame(stream, frame(FRAME_FILE_DATA, buf), 16 * 1024 * 1024)
          }
        }
      )

      const digest = hash.digest('hex')
      if (digest !== meta.sha256) {
        return { ok: false, error: 'Prüfsumme der gesendeten Datei stimmt nicht' }
      }
      await writeFrame(
        stream,
        frame(FRAME_CONTROL, Buffer.from(JSON.stringify({ type: 'backup-complete', sha256: digest })))
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      try {
        await stream.close()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Nimmt ein repliziertes Backup entgegen.
   */
  async receiveBackup(
    stream: Stream,
    targetDir: string
  ): Promise<{ ok: boolean; error?: string; sha256?: string }> {
    const iterator = readFrames(stream)
    const first = await iterator.next()
    if (first.done || !first.value) return { ok: false, error: 'Kein Angebot empfangen' }
    if (first.value[0] !== FRAME_CONTROL) return { ok: false, error: 'Unerwartetes Format' }

    const offer = JSON.parse(new TextDecoder().decode(first.value.subarray(1))) as BackupOfferFrame
    if (offer.type !== 'backup-offer') return { ok: false, error: 'Unerwartetes Format' }
    if (offer.groupId !== this.opts.groupId) {
      return { ok: false, error: 'Angebot gehört zu einer anderen Gruppe' }
    }

    // Der Dateiname wird streng geprueft (kein Pfad, keine Traversal).
    let safeName = offer.meta.id.replace(/[^A-Za-z0-9._-]/g, '_')
    if (!safeName.endsWith('.tar.gz')) safeName = `${safeName}.tar.gz`
    const target = resolveWithin(targetDir, safeName)
    const partPath = `${target}.part`

    const respond = (payload: unknown): void => {
      void writeFrame(
        stream,
        Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(payload), 'utf8')])
      ).catch(() => {
        /* ignore */
      })
    }

    try {
      mkdirSync(dirname(target), { recursive: true })
      const handle = openSync(partPath, 'w')
      const hash = createHash('sha256')
      let received = 0
      try {
        for await (const frame of iterator) {
          if (frame[0] !== FRAME_FILE_DATA) break
          const data = frame.subarray(1)
          hash.update(data)
          writeSync(handle, data, 0, data.byteLength, received)
          received += data.byteLength
          if (received > offer.meta.sizeBytes * 2) {
            throw new Error('Übertragene Datenmenge überschreitet das angekündigte Maß')
          }
        }
      } finally {
        closeSync(handle)
      }

      const digest = hash.digest('hex')
      if (digest !== offer.meta.sha256) {
        rmSync(partPath, { force: true })
        respond({ type: 'backup-accept', ok: false, error: 'Prüfsumme stimmt nicht überein' })
        return { ok: false, error: 'Prüfsumme stimmt nicht überein' }
      }

      renameSync(partPath, target)
      const meta = {
        id: offer.meta.id,
        kind: offer.meta.kind,
        createdAt: offer.meta.createdAt,
        worldName: offer.meta.worldName,
        worldVersionId: offer.meta.worldVersionId,
        sizeBytes: offer.meta.sizeBytes,
        uncompressedBytes: offer.meta.uncompressedBytes,
        mcVersion: offer.meta.mcVersion,
        dataVersion: offer.meta.dataVersion,
        sha256: offer.meta.sha256,
        verified: true,
        replicated: true,
        path: target
      }
      writeFileSync(`${target}.meta.json`, JSON.stringify(meta, null, 2), 'utf8')

      respond({ type: 'backup-accept', ok: true })
      return { ok: true, sha256: digest }
    } catch (err) {
      try {
        rmSync(partPath, { force: true })
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : String(err)
      respond({ type: 'backup-accept', ok: false, error: message })
      return { ok: false, error: message }
    }
  }

  /**
   * Nimmt ein repliziertes Backup entgegen und legt es im Backup-Speicher ab.
   */
  private async handleBackupOffer(
    stream: Stream,
    offer: BackupOfferFrame
  ): Promise<void> {
    const result = await this.receiveBackup(stream, this.opts.backupDir())
    if (!result.ok) {
      logger.warn('peer-manager', 'Empfangenes Backup abgelehnt', { error: result.error })
    } else {
      logger.info('peer-manager', 'Backup repliziert', { id: offer.meta.id })
    }
  }

  /**
   * Behandelt eine eingehende Weltanfrage.
   */
  private async handleIncoming(stream: Stream): Promise<void> {
    const iterator = readFrames(stream)
    try {
      const first = await iterator.next()
      if (first.done || !first.value) return
      const type = first.value[0] as number
      if (type !== FRAME_CONTROL) return
      const body = first.value.subarray(1)
      const parsed = JSON.parse(new TextDecoder().decode(body)) as
        | WorldRequestFrame
        | QuiesceFrame

      if (parsed.type === 'quiesce') {
        await this.handleQuiesce(stream, parsed)
        return
      }
      if ((parsed as unknown as BackupOfferFrame).type === 'backup-offer') {
        await this.handleBackupOffer(stream, parsed as unknown as BackupOfferFrame)
        return
      }
      const request = parsed as WorldRequestFrame
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

  /**
   * Behandelt eine Quiesce-Anfrage: der Server wird kontrolliert gestoppt
   * und die Weltversion gemeldet.
   */
  private async handleQuiesce(stream: Stream, request: QuiesceFrame): Promise<void> {
    const respond = (result: QuiesceResultFrame): void => {
      void writeFrame(
        stream,
        Buffer.concat([Buffer.from([FRAME_CONTROL]), Buffer.from(JSON.stringify(result), 'utf8')])
      ).catch(() => {
        /* ignore */
      })
    }

    // Signatur pruefen
    const publicKey = this.opts.publicKeys().get(request.from)
    if (!publicKey) {
      respond({ type: 'quiesce-result', ok: false, versionId: '', error: 'Unbekannter Absender' })
      return
    }
    const valid = IdentityStore.verifyWith(
      publicKey,
      signatureBody({
        v: '1.0.0',
        id: request.nonce,
        type: 'world.quiesce',
        ts: request.ts,
        nonce: request.nonce,
        from: request.from,
        payload: { groupId: request.groupId, epoch: request.epoch }
      }),
      request.sig
    )
    if (!valid) {
      respond({ type: 'quiesce-result', ok: false, versionId: '', error: 'Ungültige Signatur' })
      return
    }
    if (request.groupId !== this.opts.groupId) {
      respond({
        type: 'quiesce-result',
        ok: false,
        versionId: '',
        error: 'Anfrage gehört zu einer anderen Gruppe'
      })
      return
    }
    if (Math.abs(Date.now() - request.ts) > 60_000) {
      respond({ type: 'quiesce-result', ok: false, versionId: '', error: 'Anfrage ist zu alt' })
      return
    }

    const result = await this.opts.quiesceWorld(request.from, request.epoch)
    respond({
      type: 'quiesce-result',
      ok: result.ok,
      versionId: result.versionId,
      ...(result.error ? { error: result.error } : {})
    })
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
