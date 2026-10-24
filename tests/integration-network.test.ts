import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HubNode } from '../src/main/hub/hub-node'
import { HubClient } from '../src/main/hub/hub-client'
import { IdentityStore } from '../src/main/security/identity'
import { createPeerNode } from '../src/main/net/transport'
import { measureNetworkSpeed } from '../src/main/net/speed-test'
import { LeaseClient } from '../src/main/host/lease-client'
import type { PeerNode } from '../src/main/net/transport'
import type { InviteInfo } from '../src/shared/protocol'
import type {
  GroupInfo,
  GroupSnapshot,
  HostCapability,
  LeaseAcquireResult
} from '@shared/types'

/**
 * Integrationstest ueber das echte Netzwerk (libp2p/TCP).
 *
 * Geprueft wird der komplette Pfad:
 *   Hub starten -> Mitglied A verbindet sich -> Gruppe erstellen ->
 *   Mitglied B verbindet sich -> mit Einladungscode beitreten ->
 *   Lease-Rennen (nur einer gewinnt) -> Weltstand committen.
 */

interface TestNode {
  name: string
  identity: IdentityStore
  node: PeerNode
  client: HubClient
  dir: string
}

function capability(nodeId: string): HostCapability {
  return {
    nodeId,
    displayName: nodeId,
    hostingAllowed: true,
    priority: 50,
    cpu: { model: 'Test-CPU', logicalCores: 8, physicalCores: 8, usage: 10, loadAvg1: 0.5 },
    memory: {
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 12 * 1024 ** 3,
      availableBytes: 12 * 1024 ** 3,
      usage: 25
    },
    disk: {
      path: '/tmp',
      totalBytes: 500 * 1024 ** 3,
      freeBytes: 400 * 1024 ** 3,
      writeMbps: 200,
      readMbps: 200,
      filesystem: 'ntfs'
    },
    network: {
      uploadMbps: 50,
      downloadMbps: 200,
      latencyMs: 5,
      jitterMs: 1,
      relayOnly: false,
      advertisedAddresses: []
    },
    java: { available: true, version: '17', major: 17, path: 'java' },
    stability: {
      uptimeSeconds: 1000,
      successfulHosts: 1,
      failedHosts: 0,
      availabilityRatio: 1,
      lastExitReason: 'test'
    },
    requiredWorldBytes: 0,
    measuredAt: Date.now()
  }
}

async function makeClient(name: string, hubAddress: string): Promise<TestNode> {
  const dir = mkdtempSync(join(tmpdir(), `mmh-int-${name}-`))
  const identity = new IdentityStore(join(dir, 'identity.json'))
  identity.setDisplayName(name)

  const node = await createPeerNode({
    listen: ['/ip4/127.0.0.1/tcp/0'],
    privateKeyPem: identity.material.privateKeyPem,
    appName: 'multi-mine-host-test/0.1.0'
  })

  const client = new HubClient({
    identity,
    hubAddress,
    peer: node
  })
  await client.connect()

  return { name, identity, node, client, dir }
}

describe('Integration: echtes Netzwerk', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  let hub: HubNode | null = null

  afterAll(async () => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn()
      } catch {
        /* ignore */
      }
    }
  })

  it('verbindet Mitglieder, verwaltet die Gruppe und vergibt die Lease eindeutig', async () => {
    // --- Hub starten ---
    hub = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: null,
      dataFile: join(mkdtempSync(join(tmpdir(), 'mmh-hub-')), 'hub.json')
    })
    await hub.start()
    cleanups.push(() => hub?.stop())

    const hubAddress = hub.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/'))
    expect(hubAddress).toBeDefined()
    const fullAddress = `${hubAddress}/p2p/${hub.peerId}`

    // --- Mitglied A verbindet sich ---
    const a = await makeClient('PC-A', fullAddress)
    cleanups.push(async () => {
      await a.client.close()
      await a.node.stop()
      rmSync(a.dir, { recursive: true, force: true })
    })
    expect(a.client.connected).toBe(true)

    // --- A erstellt die Gruppe ---
    const groupId = 'gruppe-integration'
    const created = await a.client.call<{ kind: 'group'; snapshot: GroupSnapshot; sessionToken: string }>(
      'hub.create',
      {
        groupId,
        name: 'Integration',
        displayName: a.identity.displayName,
        publicKey: a.identity.publicKeyBase64,
        peerId: a.client.peerId
      }
    )
    expect(created.kind).toBe('group')
    expect(created.snapshot.group.groupId).toBe(groupId)
    expect(created.snapshot.members.length).toBe(1)
    a.client.setSession(created.sessionToken, groupId)

    // --- A holt den Einladungscode (erfordert gültige Sitzung) ---
    const invites = await a.client.call<{ kind: 'invites'; invites: InviteInfo[] }>('hub.listInvites', {
      groupId
    })
    expect(invites.invites.length).toBeGreaterThan(0)
    const inviteCode = invites.invites[0]?.code as string
    expect(inviteCode).toMatch(/^MMH-/)

    // --- Mitglied B verbindet sich und tritt bei ---
    const b = await makeClient('PC-B', fullAddress)
    cleanups.push(async () => {
      await b.client.close()
      await b.node.stop()
      rmSync(b.dir, { recursive: true, force: true })
    })

    const joined = await b.client.call<{ kind: 'group'; snapshot: GroupSnapshot; sessionToken: string }>(
      'hub.join',
      {
        groupId,
        inviteCode,
        displayName: b.identity.displayName,
        publicKey: b.identity.publicKeyBase64,
        peerId: b.client.peerId,
        capability: capability(b.identity.nodeId)
      }
    )
    expect(joined.kind).toBe('group')
    expect(joined.snapshot.members.length).toBe(2)
    b.client.setSession(joined.sessionToken, groupId)

    // --- Heartbeat mit Leistungsdaten ---
    const heartbeat = await b.client.call<{ kind: 'hello'; snapshot: GroupSnapshot }>('hub.heartbeat', {
      groupId,
      capability: capability(b.identity.nodeId),
      addresses: [`/ip4/127.0.0.1/tcp/1234`],
      peerId: b.client.peerId
    })
    expect(heartbeat.snapshot.members.length).toBe(2)

    // --- Lease-Rennen: beide versuchen gleichzeitig ---
    const results = await Promise.all([
      a.client.call<{ kind: 'lease'; result: LeaseAcquireResult }>('hub.leaseAcquire', {
        groupId,
        knownEpoch: 0,
        priority: 50
      }),
      b.client.call<{ kind: 'lease'; result: LeaseAcquireResult }>('hub.leaseAcquire', {
        groupId,
        knownEpoch: 0,
        priority: 50
      })
    ])
    const granted = results.filter((r) => r.result.granted)
    expect(granted.length).toBe(1)
    const holder = granted[0]?.result.lease?.holderId
    expect([a.identity.nodeId, b.identity.nodeId]).toContain(holder)

    // --- Weltstand committen (nur der Lease-Halter darf das) ---
    const epoch = granted[0]?.result.lease?.epoch ?? 0
    const winner = holder === a.identity.nodeId ? a : b
    const commit = await winner.client.call<{ kind: 'world'; entry: { versionId: string } | null }>(
      'hub.worldCommit',
      {
        groupId,
        epoch,
        versionId: 'welt-integration',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        totalBytes: 1024,
        replicaIds: []
      }
    )
    expect(commit.entry?.versionId).toBe('welt-integration')

    // --- Der Verlierer darf nicht committen ---
    const loser = holder === a.identity.nodeId ? b : a
    await expect(
      loser.client.call('hub.worldCommit', {
        groupId,
        epoch,
        versionId: 'manipulation',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        totalBytes: 1,
        replicaIds: []
      })
    ).rejects.toThrow(/Fencing/)

    // --- Peer-Discovery: die Mitglieder sehen sich ---
    const discovery = await a.client.call<{ kind: 'discovery'; peers: Array<{ nodeId: string; peerId: string }> }>(
      'hub.discovery',
      { groupId, addresses: [`/ip4/127.0.0.1/tcp/1234`] }
    )
    expect(discovery.peers.length).toBe(2)
    const peerB = discovery.peers.find((p) => p.nodeId === b.identity.nodeId)
    expect(peerB?.peerId).toBe(b.client.peerId)
  }, 90_000)

  it('fährt den Lease-Client gegen einen echten Hub', async () => {
    const hub4 = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: null,
      dataFile: join(mkdtempSync(join(tmpdir(), 'mmh-hub4-')), 'hub.json')
    })
    await hub4.start()
    const address = `${hub4.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/'))}/p2p/${hub4.peerId}`

    const client = await makeClient('PC-D', address)
    try {
      const groupId = 'gruppe-lease-client'
      const created = await client.client.call<{
        kind: 'group'
        snapshot: GroupSnapshot
        sessionToken: string
      }>('hub.create', {
        groupId,
        name: 'Lease-Client-Test',
        displayName: client.identity.displayName,
        publicKey: client.identity.publicKeyBase64,
        peerId: client.client.peerId
      })
      client.client.setSession(created.sessionToken, groupId)

      // Der Lease-Client muss die Hüllen-Antwort des Hubs korrekt verarbeiten.
      const leaseClient = new LeaseClient({
        call: (type, payload, timeout) => client.client.call(type, payload, timeout),
        groupId,
        nodeId: client.identity.nodeId,
        onFence: () => undefined
      })

      const acquired = await leaseClient.acquire(50)
      expect(acquired.granted).toBe(true)
      expect(acquired.lease?.epoch).toBe(1)
      expect(acquired.lease?.holderId).toBe(client.identity.nodeId)

      // Verlängern muss funktionieren, ohne den Host zu fenced'en.
      const renewed = await leaseClient.renew()
      expect(renewed.ok).toBe(true)
      expect(renewed.fenced).toBe(false)
      expect(leaseClient.fenced).toBe(false)
      expect(leaseClient.epoch).toBe(1)

      // Ein zweiter Versuch desselben Mitglieds erneuert die Lease
      // (mit neuer Epoche) - das ist gewollt.
      const second = await leaseClient.acquire(50)
      expect(second.granted).toBe(true)
      expect(second.lease?.epoch).toBe(2)

      // Ein anderes Mitglied darf die Lease NICHT bekommen.
      const other = await makeClient('PC-E', address)
      try {
        // Der Beitritt mit einem falschen Einladungscode muss scheitern.
        await expect(
          other.client.call('hub.join', {
            groupId,
            inviteCode: 'MMH-ABCD-EFGH-JKLM',
            displayName: other.identity.displayName,
            publicKey: other.identity.publicKeyBase64,
            peerId: other.client.peerId,
            capability: capability(other.identity.nodeId)
          })
        ).rejects.toThrow()
      } finally {
        await other.client.close()
        await other.node.stop()
        rmSync(other.dir, { recursive: true, force: true })
      }
    } finally {
      await client.client.close()
      await client.node.stop()
      rmSync(client.dir, { recursive: true, force: true })
      await hub4.stop()
    }
  }, 60_000)

  it('misst die Netzwerkqualität zum Hub', async () => {
    const hub3 = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: null,
      dataFile: join(mkdtempSync(join(tmpdir(), 'mmh-hub3-')), 'hub.json')
    })
    await hub3.start()
    const address = `${hub3.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/'))}/p2p/${hub3.peerId}`

    const dir = mkdtempSync(join(tmpdir(), 'mmh-speed-'))
    const identity = new IdentityStore(join(dir, 'identity.json'))
    const node = await createPeerNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      privateKeyPem: identity.material.privateKeyPem
    })

    try {
      const result = await measureNetworkSpeed(node, address, {
        bytes: 512 * 1024,
        pings: 3
      })
      expect(result.downloadMbps).toBeGreaterThan(0)
      expect(result.uploadMbps).toBeGreaterThan(0)
      expect(result.latencyMs).toBeGreaterThan(0)
      expect(result.measuredAt).toBeGreaterThan(0)
    } finally {
      await node.stop()
      rmSync(dir, { recursive: true, force: true })
      await hub3.stop()
    }
  }, 60_000)

  it('lehnt Anfragen ohne gültige Sitzung ab', async () => {
    const hub2 = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: null,
      dataFile: join(mkdtempSync(join(tmpdir(), 'mmh-hub2-')), 'hub.json')
    })
    await hub2.start()
    const address = `${hub2.addresses.find((a) => a.includes('/ip4/127.0.0.1/tcp/'))}/p2p/${hub2.peerId}`

    const client = await makeClient('PC-C', address)
    try {
      // Ein unbekannter Absender wird bereits abgewiesen.
      await expect(
        client.client.call('hub.listInvites', { groupId: 'irgendeine-gruppe' })
      ).rejects.toThrow(/Unbekannter Absender|Sitzung/)

      // Jetzt ist der Absender ein bekanntes Mitglied, aber das Sitzungstoken
      // ist falsch -> die Anfrage muss ebenfalls abgelehnt werden.
      const created = await client.client.call<{
        kind: 'group'
        snapshot: GroupSnapshot
        sessionToken: string
      }>('hub.create', {
        groupId: 'gruppe-sitzung',
        name: 'Sitzungstest',
        displayName: client.identity.displayName,
        publicKey: client.identity.publicKeyBase64,
        peerId: client.client.peerId
      })
      client.client.setSession(created.sessionToken, 'gruppe-sitzung')

      // Gültige Sitzung -> funktioniert
      const ok = await client.client.call<{ kind: 'invites'; invites: InviteInfo[] }>(
        'hub.listInvites',
        { groupId: 'gruppe-sitzung' }
      )
      expect(ok.invites.length).toBeGreaterThan(0)

      // Falsches Sitzungstoken -> abgelehnt
      client.client.setSession('falsches-token', 'gruppe-sitzung')
      await expect(
        client.client.call('hub.listInvites', { groupId: 'gruppe-sitzung' })
      ).rejects.toThrow(/Sitzung/)
    } finally {
      await client.client.close()
      await client.node.stop()
      rmSync(client.dir, { recursive: true, force: true })
      await hub2.stop()
    }
  }, 60_000)
})
