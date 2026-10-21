import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import type { Libp2p, Stream } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { PeerId } from '@libp2p/interface'
import { ed25519SeedFromPem } from '../security/identity'
import { logger } from '../core/logger'

/**
 * Transport-Adapter fuer libp2p.
 *
 * Bewusste Entscheidung: Der gesamte Netzwerkcode der Anwendung greift
 * ausschliesslich auf dieses Modul zu. Dadurch bleibt der Rest der App frei
 * von libp2p-Details und die Implementierung ist austauschbar.
 *
 * Verschluesselung: Noise (authentifiziert, mit Forward-Secrecy).
 * Multiplexing: Yamux.
 * Transports: TCP (direkt), WebSocket (ueber Proxys/HTTPS), Circuit Relay v2
 *              (Ausweichweg, wenn direkte Verbindung nicht moeglich ist).
 */

export interface TransportOptions {
  /** Multiaddrs, auf denen gelauscht wird. */
  listen: string[]
  /** Ist dieser Node der Koordinations-Hub? Dann Relay-Server aktiv. */
  isHub?: boolean
  /** Bootstrap-Peers (nur Hub / Test). */
  bootstrap?: string[]
  /** PKCS#8-PEM eines Ed25519-Schluessels - wenn gesetzt, wird die libp2p-Peer-ID daraus abgeleitet. */
  privateKeyPem?: string
  /** 应用-Kennung fuer Identify. */
  appName?: string
}

export interface PeerNode {
  node: Libp2p
  /** Eigene Multiaddrs. */
  addresses(): string[]
  /** Dialt ein Protokoll bei einem Peer. */
  dial(peer: string, protocol: string, timeoutMs?: number): Promise<Stream>
  /** Registriert einen Protokoll-Handler. */
  handle(protocol: string, handler: (stream: Stream) => void | Promise<void>): Promise<void>
  stop(): Promise<void>
}

export async function createPeerNode(opts: TransportOptions): Promise<PeerNode> {
  const listen = opts.listen.length > 0 ? opts.listen : ['/ip4/0.0.0.0/tcp/0']

  const services: Record<string, unknown> = {
    identify: identify(),
    ping: ping()
  }

  if (opts.isHub) {
    services['circuitRelay'] = circuitRelayServer({
      reservations: { maxReservations: 32, reservationTtl: 2 * 60 * 60 * 1000 }
    })
  }

  const node = await createLibp2p({
    addresses: { listen },
    ...(opts.privateKeyPem
      ? {
          privateKey: await (
            await import('@libp2p/crypto/keys')
          ).generateKeyPairFromSeed('Ed25519', ed25519SeedFromPem(opts.privateKeyPem))
        }
      : {}),
    transports: [tcp(), webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: services as never,
    connectionManager: { maxConnections: 64 },
    peerDiscovery: opts.bootstrap?.length
      ? [(await import('@libp2p/bootstrap')).bootstrap({ list: opts.bootstrap })]
      : []
  })

  const peer: PeerNode = {
    node,
    addresses: () => node.getMultiaddrs().map((m) => m.toString()),
    async dial(peerRef: string, protocol: string, timeoutMs = 15_000): Promise<Stream> {
      const id = await resolvePeerId(peerRef)
      // Bei einer Multiaddr wird die Adresse im Peer-Store hinterlegt,
      // damit libp2p weiss, wo der Peer zu erreichen ist.
      if (peerRef.startsWith('/')) {
        try {
          await node.peerStore.save(id, { multiaddrs: [multiaddr(peerRef)] })
        } catch (err) {
          logger.warn('transport', 'Adresse konnte nicht im Peer-Store abgelegt werden', {
            error: String(err)
          })
        }
      }
      return node.dialProtocol(id, protocol, { signal: AbortSignal.timeout(timeoutMs) })
    },
    async handle(protocol: string, handler: (stream: Stream) => void | Promise<void>) {
      await node.handle(protocol, async (stream: Stream) => {
        try {
          await handler(stream)
        } catch (err) {
          logger.warn('transport', `Handler für ${protocol} fehlgeschlagen`, { error: String(err) })
        }
      })
    },
    async stop() {
      await node.stop()
    }
  }

  return peer
}

/**
 * Akzeptiert entweder einen PeerId-String ("12D3Koo...") oder eine
 * Multiaddr ("/ip4/1.2.3.4/tcp/4001/p2p/12D3Koo...").
 */
export async function resolvePeerId(ref: string): Promise<PeerId> {
  if (ref.startsWith('/')) {
    const id = extractPeerId(ref)
    if (!id) throw new Error(`Multiaddr enthält keine Peer-ID: ${ref}`)
    return peerIdFromString(id)
  }
  return peerIdFromString(ref)
}

/** Extrahiert die Peer-ID aus einer Multiaddr (String-basiert, robust). */
export function extractPeerId(multiaddr: string): string | null {
  const idx = multiaddr.lastIndexOf('/p2p/')
  if (idx < 0) return null
  const rest = multiaddr.slice(idx + 5)
  const slash = rest.indexOf('/')
  const id = slash >= 0 ? rest.slice(0, slash) : rest
  return id.length > 0 ? id : null
}

/** Extrahiert die PeerId aus einer Multiaddr. */
export function peerIdOf(multiaddr: string): string | null {
  return extractPeerId(multiaddr)
}

/** Baut die Relay-Adresse fuer einen Peer, der ueber den Hub erreichbar ist. */
export function relayAddressFor(hubPeerId: string): string {
  return `/p2p-circuit/p2p/${hubPeerId}`
}
