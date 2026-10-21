import { PROTOCOLS } from '@shared/protocol'
import { createPeerNode, resolvePeerId } from '../net/transport'
import type { PeerNode } from '../net/transport'
import { RpcConnection } from '../net/rpc'
import { IdentityStore } from '../security/identity'
import { logger } from '../core/logger'

/**
 * Client-Seite der Hub-Kommunikation.
 *
 * Der Client nutzt einen gemeinsamen libp2p-Knoten, damit andere Mitglieder
 * ihn direkt erreichen koennen (TCP). Die Kommunikation mit dem Hub laeuft
 * ueber den authentifizierten RPC-Kanal.
 */

export interface HubClientOptions {
  identity: IdentityStore
  /** Multiaddr des Hubs. */
  hubAddress: string
  /** Gemeinsamer libp2p-Knoten (optional - sonst wird einer erzeugt). */
  peer?: PeerNode
  /** Eigene Listen-Adressen (nur wenn `peer` nicht gesetzt ist). */
  listen?: string[]
  /** Session-Token des Hubs (wird nach create/join gesetzt). */
  sessionToken?: string
  /** Gruppen-ID (wird nach create/join gesetzt). */
  groupId?: string
  onConnected?: () => void
  onDisconnected?: (error: Error) => void
}

export class HubClient {
  private peer: PeerNode | null = null
  private ownsPeer = false
  private rpc: RpcConnection | null = null
  private connecting: Promise<void> | null = null
  private closed = false
  private _sessionToken: string | undefined
  private _groupId: string | undefined

  constructor(private readonly opts: HubClientOptions) {
    this._sessionToken = opts.sessionToken
    this._groupId = opts.groupId
  }

  get sessionToken(): string | undefined {
    return this._sessionToken
  }

  get groupId(): string | undefined {
    return this._groupId
  }

  get connected(): boolean {
    return this.rpc !== null
  }

  get peerId(): string {
    return this.peer?.node.peerId.toString() ?? ''
  }

  get addresses(): string[] {
    return this.peer?.addresses() ?? []
  }

  /** Der gemeinsam genutzte libp2p-Knoten. */
  get node(): PeerNode | null {
    return this.peer
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('Client wurde geschlossen')
    if (this.rpc) return
    if (this.connecting) return this.connecting
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    const hubAddr = this.opts.hubAddress
    if (!hubAddr) throw new Error('Keine Hub-Adresse konfiguriert')

    if (this.opts.peer) {
      this.peer = this.opts.peer
      this.ownsPeer = false
    } else {
      this.peer = await createPeerNode({
        listen: this.opts.listen ?? ['/ip4/0.0.0.0/tcp/0'],
        appName: 'multi-mine-host/0.1.0'
      })
      this.ownsPeer = true
    }

    const peerId = await resolvePeerId(hubAddr)
    // Die Multiaddr wird dabei im Peer-Store hinterlegt.
    const stream = await this.peer.dial(hubAddr, PROTOCOLS.hub, 20_000)

    this.rpc = new RpcConnection(stream, {
      identity: this.opts.identity,
      // Der Hub ist ueber den Transport authentifiziert (Noise + PeerId).
      publicKeys: new Map(),
      // Das Sitzungstoken wird bei jeder Anfrage mitgesendet und signiert.
      auth: () => this._sessionToken,
      peerLabel: 'hub'
    })

    this.opts.onConnected?.()
    logger.info('hub-client', 'Verbindung zum Hub hergestellt', { peerId: peerId.toString() })
  }

  /** Sendet eine Anfrage an den Hub. */
  async call<T = unknown>(type: string, payload: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.rpc) throw new Error('Keine Verbindung zum Hub')
    return (await this.rpc.request<T>(type, payload, timeoutMs)) as T
  }

  /** Setzt Sitzungstoken und Gruppe (nach create/join). */
  setSession(token: string | undefined, groupId: string | undefined): void {
    this._sessionToken = token
    this._groupId = groupId
  }

  async disconnect(): Promise<void> {
    await this.rpc?.close()
    this.rpc = null
    if (this.ownsPeer) {
      await this.peer?.stop()
      this.peer = null
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.disconnect()
  }

  /** Prueft, ob der Hub erreichbar ist. */
  async ping(timeoutMs = 5_000): Promise<boolean> {
    try {
      await this.call('hub.ping', {}, timeoutMs)
      return true
    } catch {
      return false
    }
  }
}
