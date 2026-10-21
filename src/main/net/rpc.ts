import type { Stream } from '@libp2p/interface'
import { PROTOCOL_VERSION, REQUEST_MAX_AGE_MS, signatureBody } from '@shared/protocol'
import type { RpcRequest, RpcResponse } from '@shared/protocol'
import { readFrames, writeFrame } from './framing'
import { logger } from '../core/logger'
import { IdentityStore } from '../security/identity'
import type { IdentityStore as IdentityStoreType } from '../security/identity'

/**
 * Schichtfragenloser RPC ueber einen libp2p-Stream.
 *
 * Sicherheitseigenschaften:
 *  - Jede Anfrage wird mit dem Ed25519-Schluessel des Absenders signiert.
 *  - Der Zeitstempel muss innerhalb von REQUEST_MAX_AGE_MS liegen
 *    (verhindert Wiederverwendung alter Anfragen).
 *  - Nonces werden pro Absender短期内 gespeichert; doppelte Nonces werden
 *    abgewiesen (Replay-Schutz).
 *  - Unbekannte Protokollversionen werden abgelehnt.
 */

export interface RpcHandlerContext {
  request: RpcRequest
  /** Antwort des Handlers. */
  respond(payload: unknown): void
  /** Fehlerantwort. */
  fail(error: string, code?: string): void
}

export type RpcHandler = (ctx: RpcHandlerContext) => void | Promise<void>

export interface RpcConnectionOptions {
  identity: IdentityStoreType
  /** Bekannte Public Keys pro nodeId (fuer Signaturpruefung). */
  publicKeys?: Map<string, string>
  /** Liefert das aktuelle Sitzungstoken (wird signiert mitgesendet). */
  auth?: () => string | undefined
  requestTimeoutMs?: number
  /** Peer-ID des Gegenuebers (fuer Logging). */
  peerLabel?: string
}

export class RpcConnection {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly seenNonces = new Map<string, number>()
  private readonly handlers = new Map<string, RpcHandler>()
  private readonly publicKeys: Map<string, string>
  private readonly requestTimeoutMs: number
  private closed = false
  private reader: Promise<void> | null = null

  constructor(
    private readonly stream: Stream,
    private readonly opts: RpcConnectionOptions
  ) {
    this.publicKeys = opts.publicKeys ?? new Map()
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
    this.reader = this.readLoop()
  }

  get label(): string {
    return this.opts.peerLabel ?? 'peer'
  }

  /** Registriert einen Handler fuer einen Nachrichtentyp. */
  on(type: string, handler: RpcHandler): void {
    this.handlers.set(type, handler)
  }

  /** Sendet eine Anfrage und wartet auf die Antwort. */
  async request<T = unknown>(type: string, payload: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) throw new Error('RPC-Verbindung ist geschlossen')
    const id = randomId()
    const auth = this.opts.auth?.()
    const req: RpcRequest = {
      v: PROTOCOL_VERSION,
      id,
      type,
      ts: Date.now(),
      nonce: randomId(),
      from: this.opts.identity.nodeId,
      ...(auth ? { auth } : {}),
      payload
    }
    req.sig = this.opts.identity.sign(signatureBody(req))

    const timeout = timeoutMs ?? this.requestTimeoutMs
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Anfrage ${type} nach ${timeout} ms nicht beantwortet`))
      }, timeout)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })
    })

    await this.send(req)
    return promise
  }

  private async send(req: RpcRequest): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(req))
    await writeFrame(this.stream, data)
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const frame of readFrames(this.stream)) {
        let msg: RpcRequest | RpcResponse
        try {
          msg = JSON.parse(new TextDecoder().decode(frame)) as RpcRequest | RpcResponse
        } catch {
          logger.warn('rpc', 'Ungültige JSON-Nachricht verworfen', { peer: this.label })
          continue
        }
        if (this.isResponse(msg)) {
          this.handleResponse(msg)
        } else {
          await this.handleRequest(msg)
        }
      }
    } catch (err) {
      if (!this.closed) {
        logger.debug('rpc', 'RPC-Leseschleife beendet', { peer: this.label, error: String(err) })
      }
    } finally {
      this.failAllPending(new Error('Verbindung beendet'))
    }
  }

  private isResponse(m: RpcRequest | RpcResponse): m is RpcResponse {
    // Antworten tragen `ok`; Anfragen tragen `nonce` und `from`.
    return typeof (m as RpcResponse).ok === 'boolean' && (m as RpcRequest).nonce === undefined
  }

  private handleResponse(res: RpcResponse): void {
    const entry = this.pending.get(res.id)
    if (!entry) return
    this.pending.delete(res.id)
    clearTimeout(entry.timer)
    if (res.ok) entry.resolve(res.payload)
    else entry.reject(new Error(res.error ?? 'Unbekannter Fehler'))
  }

  private async handleRequest(req: RpcRequest): Promise<void> {
    const respond = (payload: unknown) => {
      const res: RpcResponse = {
        v: PROTOCOL_VERSION,
        id: req.id,
        type: req.type,
        ok: true,
        payload,
        ts: Date.now()
      }
      void writeFrame(this.stream, new TextEncoder().encode(JSON.stringify(res))).catch(() => {
        /* Verbindung schon weg */
      })
    }
    const fail = (error: string, errorCode?: string) => {
      const res: RpcResponse = {
        v: PROTOCOL_VERSION,
        id: req.id,
        type: req.type,
        ok: false,
        error,
        ...(errorCode ? { errorCode } : {}),
        ts: Date.now()
      }
      void writeFrame(this.stream, new TextEncoder().encode(JSON.stringify(res))).catch(() => {
        /* ignore */
      })
    }

    const check = this.validate(req)
    if (!check.ok) {
      logger.warn('rpc', 'Anfrage abgewiesen', { peer: this.label, reason: check.reason })
      fail(check.reason, check.code)
      return
    }

    const handler = this.handlers.get(req.type)
    if (!handler) {
      fail(`Unbekannter Nachrichtentyp: ${req.type}`, 'UNKNOWN_TYPE')
      return
    }
    try {
      await handler({ request: req, respond, fail })
    } catch (err) {
      logger.error('rpc', 'Handler-Fehler', { peer: this.label, type: req.type, error: String(err) })
      fail(String(err), 'HANDLER_ERROR')
    }
  }

  /**
   * Prueft Signatur, Zeitstempel und Nonce einer Anfrage.
   */
  validate(req: RpcRequest): { ok: true } | { ok: false; reason: string; code: string } {
    if (!req || typeof req !== 'object') return { ok: false, reason: 'Ungültige Anfrage', code: 'MALFORMED' }
    if (req.v !== PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `Protokollversion ${req.v} wird nicht unterstützt (erwartet ${PROTOCOL_VERSION})`,
        code: 'VERSION_MISMATCH'
      }
    }
    const age = Date.now() - req.ts
    if (!Number.isFinite(age) || age > REQUEST_MAX_AGE_MS || age < -REQUEST_MAX_AGE_MS) {
      return { ok: false, reason: 'Zeitstempel liegt ausserhalb des erlaubten Fensters', code: 'STALE' }
    }
    const publicKey = this.publicKeys.get(req.from)
    if (!publicKey) {
      return { ok: false, reason: `Unbekannter Absender ${req.from}`, code: 'UNKNOWN_SENDER' }
    }
    if (!req.sig) {
      return { ok: false, reason: 'Anfrage ist nicht signiert', code: 'UNSIGNED' }
    }
    const valid = verifySignature(publicKey, signatureBody(req), req.sig)
    if (!valid) {
      return { ok: false, reason: 'Ungültige Signatur', code: 'BAD_SIGNATURE' }
    }
    if (this.seenNonces.has(req.nonce)) {
      return { ok: false, reason: 'Nonce wurde bereits verwendet (Replay-Schutz)', code: 'REPLAY' }
    }
    this.seenNonces.set(req.nonce, Date.now())
    this.pruneNonces()
    return { ok: true }
  }

  private pruneNonces(): void {
    const cutoff = Date.now() - REQUEST_MAX_AGE_MS * 2
    for (const [nonce, ts] of this.seenNonces) {
      if (ts < cutoff) this.seenNonces.delete(nonce)
    }
  }

  /** Schliesst die Verbindung und lehnt offene Anfragen ab. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAllPending(new Error('Verbindung geschlossen'))
    try {
      await this.stream.close()
    } catch {
      /* ignore */
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}

function verifySignature(publicKeyBase64: string, body: string, sigBase64: string): boolean {
  return IdentityStore.verifyWith(publicKeyBase64, body, sigBase64)
}

function randomId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
