import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HubNode } from '../src/main/hub/hub-node'
import { HubClient } from '../src/main/hub/hub-client'
import { IdentityStore } from '../src/main/security/identity'
import { createPeerNode } from '../src/main/net/transport'
import type { PeerNode } from '../src/main/net/transport'
import { PeerManager } from '../src/main/net/peer-manager'
import { buildManifest } from '../src/main/sync/manifest'
import { verifyWorld } from '../src/main/sync/manifest'
import type { WorldManifest } from '@shared/types'

/**
 * Integrationstest der Weltuebergabe ueber echtes libp2p-Netzwerk.
 *
 * Geprueft wird der komplette Weg:
 *   A bietet eine Welt an -> B fordert sie an -> B prueft sie ->
 *   B fordert A zum kontrollierten Herunterfahren auf.
 */

interface TestPeer {
  name: string
  identity: IdentityStore
  node: PeerNode
  dir: string
  peerManager: PeerManager
  quiesceCalls: Array<{ requester: string; epoch: number }>
}

const cleanups: Array<() => Promise<void> | void> = []
const dirs: string[] = []

afterAll(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function createWorld(path: string): void {
  mkdirSync(join(path, 'region'), { recursive: true })
  writeFileSync(join(path, 'level.dat'), 'LEVELDAT')
  writeFileSync(join(path, 'region', 'r.0.0.mca'), 'CHUNK-DATEN')
  writeFileSync(join(path, 'player.dat'), 'SPIELER')
}

async function makePeer(
  name: string,
  hubAddress: string,
  groupId: string,
  peers: Map<string, string>,
  publicKeys: Map<string, string>
): Promise<TestPeer> {
  const dir = newDir(`mmh-wh-${name}-`)
  const identity = new IdentityStore(join(dir, 'identity.json'))
  identity.setDisplayName(name)

  const node = await createPeerNode({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    privateKeyPem: identity.material.privateKeyPem
  })

  const peerManager = new PeerManager({
    node,
    identity,
    groupId,
    provideWorld: async () => null,
    quiesceWorld: async () => ({ ok: false, versionId: '', error: 'nicht konfiguriert' }),
    publicKeys: () => publicKeys,
    peerIdOf: (nodeId) => peers.get(nodeId),
    backupDir: () => dir
  })
  await peerManager.listen()

  // Verbindung zum Hub aufbauen, damit der Peer im Hub-Addressbuch steht.
  const client = new HubClient({ identity, hubAddress, peer: node })
  await client.connect()
  cleanups.push(async () => {
    await client.close()
    await node.stop()
  })

  return { name, identity, node, dir, peerManager, quiesceCalls: [] }
}

describe('Integration: Weltübergabe', () => {
  it('überträgt die Welt und führt den kontrollierten Herunterfahren aus', async () => {
    // --- Hub starten ---
    const hub = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: null,
      dataFile: join(newDir('mmh-wh-hub-'), 'hub.json')
    })
    await hub.start()
    cleanups.push(() => hub.stop())
    const hubAddress = `${hub.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/'))}/p2p/${hub.peerId}`

    // --- Testwelt ---
    const worldPath = join(newDir('mmh-wh-world-'), 'world')
    createWorld(worldPath)
    const manifest: WorldManifest = await buildManifest({
      worldPath,
      worldName: 'uebergabewelt',
      mcVersion: '1.20.4',
      dataVersion: 3700
    })

    // --- Zwei Mitglieder ---
    const peers = new Map<string, string>()
    const publicKeys = new Map<string, string>()
    const a = await makePeer('PC-A', hubAddress, 'gruppe-wh', peers, publicKeys)
    const b = await makePeer('PC-B', hubAddress, 'gruppe-wh', peers, publicKeys)
    peers.set(a.identity.nodeId, a.node.node.peerId.toString())
    peers.set(b.identity.nodeId, b.node.node.peerId.toString())
    publicKeys.set(a.identity.nodeId, a.identity.publicKeyBase64)
    publicKeys.set(b.identity.nodeId, b.identity.publicKeyBase64)

    // A bietet die Welt an und reagiert auf Quiesce-Anfragen
    const aQuiesce = async (requester: string, epoch: number): Promise<{
      ok: boolean
      versionId: string
      error?: string
    }> => {
      a.quiesceCalls.push({ requester, epoch })
      return { ok: true, versionId: manifest.versionId }
    }
    ;(a.peerManager as unknown as { opts: { provideWorld: unknown; quiesceWorld: unknown } }).opts.provideWorld =
      async () => ({ worldPath, manifest })
    ;(a.peerManager as unknown as { opts: { provideWorld: unknown; quiesceWorld: unknown } }).opts.quiesceWorld =
      aQuiesce

    // B kennt A als Peer
    await b.peerManager.updatePeers([
      {
        nodeId: a.identity.nodeId,
        displayName: 'PC-A',
        peerId: a.node.node.peerId.toString(),
        addresses: a.node.addresses(),
        lastSeenAt: Date.now(),
        online: true
      }
    ])

    // --- Welt anfordern ---
    const target = join(newDir('mmh-wh-dst-'), 'welt')
    mkdirSync(target, { recursive: true })

    const result = await b.peerManager.requestWorld(a.identity.nodeId, target, manifest, {
      timeoutMs: 30_000
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.versionId).toBe(manifest.versionId)
    expect(existsSync(join(target, 'level.dat'))).toBe(true)
    expect(readFileSync(join(target, 'region', 'r.0.0.mca'), 'utf8')).toBe('CHUNK-DATEN')

    // Die empfangene Welt muss das Manifest exakt erfuellen
    const verification = await verifyWorld(target, manifest)
    expect(verification.ok).toBe(true)
    expect(verification.problems).toHaveLength(0)

    // --- Kontrollierter Herunterfahren anfordern ---
    const quiesce = await b.peerManager.requestQuiesce(a.identity.nodeId, 7, 30_000)
    expect(quiesce.ok).toBe(true)
    expect(quiesce.versionId).toBe(manifest.versionId)
    expect(a.quiesceCalls.length).toBe(1)
    expect(a.quiesceCalls[0]?.requester).toBe(b.identity.nodeId)
    expect(a.quiesceCalls[0]?.epoch).toBe(7)
  }, 90_000)

  it('lehnt eine Quiesce-Anfrage mit falscher Signatur ab', async () => {
    const hub = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: null,
      dataFile: join(newDir('mmh-wh-hub2-'), 'hub.json')
    })
    await hub.start()
    cleanups.push(() => hub.stop())
    const hubAddress = `${hub.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/'))}/p2p/${hub.peerId}`

    const peers = new Map<string, string>()
    const publicKeys = new Map<string, string>()
    const a = await makePeer('PC-A2', hubAddress, 'gruppe-wh2', peers, publicKeys)
    const attacker = await makePeer('Böse', hubAddress, 'gruppe-wh2', peers, publicKeys)
    peers.set(a.identity.nodeId, a.node.node.peerId.toString())
    peers.set(attacker.identity.nodeId, attacker.node.node.peerId.toString())
    // Der Angreifer ist dem Hub nicht als Mitglied bekannt -> sein
    // oeffentlicher Schluessel ist nicht hinterlegt -> Ablehnung.

    let called = false
    ;(a.peerManager as unknown as { opts: { quiesceWorld: unknown } }).opts.quiesceWorld =
      async () => {
        called = true
        return { ok: true, versionId: 'x' }
      }

    await attacker.peerManager.updatePeers([
      {
        nodeId: a.identity.nodeId,
        displayName: 'PC-A2',
        peerId: a.node.node.peerId.toString(),
        addresses: a.node.addresses(),
        lastSeenAt: Date.now(),
        online: true
      }
    ])

    // Der Angreifer ist dem Hub nicht als Mitglied bekannt -> die
    // oeffentlichen Schluessel sind nicht hinterlegt -> Ablehnung.
    const result = await attacker.peerManager.requestQuiesce(a.identity.nodeId, 99, 20_000)
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  }, 60_000)
})
