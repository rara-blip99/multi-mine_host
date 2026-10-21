import { describe, expect, it } from 'vitest'
import { HubService } from '../src/main/hub/hub-service'
import { LeaseAuthority } from '../src/main/host/lease-authority'
import { scoreCandidates, selectHost, DEFAULT_REQUIREMENTS } from '../src/main/host/election'
import { generateInviteSecret, formatInviteCode } from '../src/main/security/invites'
import type { HostCapability, HostLease } from '../src/shared/types'

/**
 * End-to-End-Szenario auf Hub-Ebene:
 * Gruppe -> zwei Mitglieder -> Host-A hostet -> A faellt aus -> B uebernimmt
 * -> die Welt wird uebertragen -> kein Split-Brain.
 */

function capability(nodeId: string, overrides: Partial<HostCapability> = {}): HostCapability {
  return {
    nodeId,
    displayName: `PC ${nodeId}`,
    hostingAllowed: true,
    priority: 50,
    cpu: { model: 'AMD Ryzen 5 3600', logicalCores: 6, physicalCores: 6, usage: 15, loadAvg1: 0.5 },
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
      writeMbps: 300,
      readMbps: 350,
      filesystem: 'ntfs'
    },
    network: {
      uploadMbps: 80,
      downloadMbps: 300,
      latencyMs: 8,
      jitterMs: 1,
      relayOnly: false,
      advertisedAddresses: [`/ip4/10.0.0.1/tcp/4001`]
    },
    java: { available: true, version: '17.0.10', major: 17, path: 'java' },
    stability: {
      uptimeSeconds: 100_000,
      successfulHosts: 3,
      failedHosts: 0,
      availabilityRatio: 1,
      lastExitReason: 'geordnet'
    },
    requiredWorldBytes: 0,
    measuredAt: Date.now(),
    ...overrides
  }
}

const GROUP_ID = 'gruppe-failover'

function setupGroup(): { hub: HubService; authority: LeaseAuthority; inviteCode: string } {
  const authority = new LeaseAuthority({ ttlMs: 30_000, graceMs: 3_000 })
  const hub = new HubService({ authority })
  hub.createGroup('node-a', 'key-a', {
    groupId: GROUP_ID,
    name: 'Failover-Test',
    displayName: 'PC A'
  })
  const inviteCode = hub.listInvites('node-a', GROUP_ID)[0]?.code as string
  hub.joinGroup(
    'node-b',
    'key-b',
    { groupId: GROUP_ID, inviteCode, displayName: 'PC B', capability: capability('node-b') },
    Date.now()
  )
  return { hub, authority, inviteCode }
}

describe('Szenario: Host-Ausfall und Übernahme', () => {
  it('führt einen kontrollierten Host-Wechsel ohne Split-Brain durch', () => {
    const { hub } = setupGroup()
    const t0 = 1_000_000

    // --- Phase 1: Node A ist Host ---
    const leaseA = hub.leaseAcquire(
      'node-a',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 60 },
      t0
    )
    expect(leaseA.granted).toBe(true)
    const epochA = leaseA.lease?.epoch ?? 0
    expect(epochA).toBe(1)

    // Node A committet die Welt
    hub.worldCommit(
      'node-a',
      GROUP_ID,
      {
        groupId: GROUP_ID,
        epoch: epochA,
        versionId: 'welt-v1',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        totalBytes: 1024,
        replicaIds: []
      },
      t0
    )
    expect(hub.worldState(GROUP_ID)?.versionId).toBe('welt-v1')

    // --- Phase 2: Node A faellt aus (kein Heartbeat, Lease laeuft ab) ---
    // Die Lease laeuft 30 s nach der Vergabe ab. Der Ausfall wird kurz
    // danach erkannt.
    const tCrash = t0 + 30_100
    const stillHeld = hub.leaseStatus(GROUP_ID, tCrash)
    expect(stillHeld?.holderId).toBe('node-a')

    // --- Phase 3: Node B versucht die Uebernahme ---
    // Kurz nach Ablauf: wegen der Grazienzeit noch nicht moeglich
    const tooEarly = hub.leaseAcquire(
      'node-b',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 50 },
      tCrash + 1000
    )
    expect(tooEarly.granted).toBe(false)
    expect(tooEarly.reason).toContain('Grazienzeit')

    // Nach der Grazienzeit: Uebernahme moeglich, mit neuer Epoche
    const leaseB = hub.leaseAcquire(
      'node-b',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 50 },
      tCrash + 5000
    )
    expect(leaseB.granted).toBe(true)
    const epochB = leaseB.lease?.epoch ?? 0
    expect(epochB).toBeGreaterThan(epochA)

    // --- Phase 4: Der alte Host darf nicht mehr schreiben ---
    const renewOld = hub.leaseRenew('node-a', GROUP_ID, epochA, tCrash + 6000)
    expect(renewOld.ok).toBe(false)
    expect(renewOld.fenced).toBe(true)

    // Ein Commit des alten Hosts wird abgelehnt
    expect(() =>
      hub.worldCommit(
        'node-a',
        GROUP_ID,
        {
          groupId: GROUP_ID,
          epoch: epochA,
          versionId: 'welt-v1-kaputt',
          worldName: 'welt',
          mcVersion: '1.20.4',
          dataVersion: 3700,
          totalBytes: 1024,
          replicaIds: []
        },
        tCrash + 6000
      )
    ).toThrow(/Fencing/)

    // Der Weltstand ist unveraendert
    expect(hub.worldState(GROUP_ID)?.versionId).toBe('welt-v1')

    // --- Phase 5: Node B uebernimmt die Welt ---
    const entry = hub.worldCommit(
      'node-b',
      GROUP_ID,
      {
        groupId: GROUP_ID,
        epoch: epochB,
        versionId: 'welt-v1',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        totalBytes: 1024,
        replicaIds: []
      },
      tCrash + 7000
    )
    expect(entry?.ownerId).toBe('node-b')
    expect(entry?.epoch).toBe(epochB)
  })

  it('verhindert, dass zwei Mitglieder gleichzeitig hosten', () => {
    const { hub } = setupGroup()
    const t0 = 1_000_000

    // Alle Mitglieder versuchen gleichzeitig, die Lease zu bekommen
    const results = ['node-a', 'node-b'].map((id) =>
      hub.leaseAcquire(id, GROUP_ID, { groupId: GROUP_ID, knownEpoch: 0, priority: 50 }, t0)
    )
    const granted = results.filter((r) => r.granted)
    expect(granted.length).toBe(1)

    // Und beide versuchen zu committen
    const holder = granted[0]?.lease?.holderId as string
    const epoch = granted[0]?.lease?.epoch ?? 0
    const loser = holder === 'node-a' ? 'node-b' : 'node-a'
    expect(() =>
      hub.worldCommit(
        loser,
        GROUP_ID,
        {
          groupId: GROUP_ID,
          epoch,
          versionId: 'x',
          worldName: 'w',
          mcVersion: '1.20.4',
          dataVersion: 3700,
          totalBytes: 1,
          replicaIds: []
        },
        t0
      )
    ).toThrow(/Fencing/)
  })

  it('wählt nach dem Ausfall den passenden Kandidaten', () => {
    const { hub } = setupGroup()
    const t0 = 1_000_000
    hub.leaseAcquire('node-a', GROUP_ID, { groupId: GROUP_ID, knownEpoch: 0, priority: 60 }, t0)

    // Node B ist schneller und hat mehr freien Speicher
    const caps = [
      capability('node-a'),
      capability('node-b', {
        cpu: { model: 'AMD Ryzen 9 5950X', logicalCores: 16, physicalCores: 16, usage: 5, loadAvg1: 0.3 },
        memory: {
          totalBytes: 32 * 1024 ** 3,
          freeBytes: 28 * 1024 ** 3,
          availableBytes: 28 * 1024 ** 3,
          usage: 12
        },
        network: {
          uploadMbps: 120,
          downloadMbps: 500,
          latencyMs: 4,
          jitterMs: 1,
          relayOnly: false,
          advertisedAddresses: []
        }
      })
    ]
    const scores = scoreCandidates(caps, {
      requirements: { ...DEFAULT_REQUIREMENTS },
      currentHostId: 'node-a',
      worldReplicaIds: [],
      serverRamBytes: 4 * 1024 ** 3
    })
    const selection = selectHost(scores)
    expect(selection.chosen).not.toBeNull()
    expect(selection.chosen?.nodeId).toBe('node-b')
  })

  it('kommt nach einer Netzwerktrennung wieder zurecht', () => {
    const { hub } = setupGroup()
    const t0 = 1_000_000
    const leaseA = hub.leaseAcquire(
      'node-a',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 60 },
      t0
    )
    const epochA = leaseA.lease?.epoch ?? 0

    // Netzwerktrennung: A kann nicht mehr verlängern
    const tDown = t0 + 31_000
    expect(hub.leaseRenew('node-a', GROUP_ID, epochA, tDown).fenced).toBe(true)

    // B uebernimmt
    const leaseB = hub.leaseAcquire(
      'node-b',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 50 },
      tDown + 4000
    )
    expect(leaseB.granted).toBe(true)

    // Netzwerk kommt zurueck: A versucht erneut zu verlängern -> fenced
    const retry = hub.leaseRenew('node-a', GROUP_ID, epochA, tDown + 5000)
    expect(retry.fenced).toBe(true)

    // A muss die Lease beim Hub erst wieder freigeben/verlängern können
    const renewB = hub.leaseRenew(
      'node-b',
      GROUP_ID,
      leaseB.lease?.epoch ?? 0,
      tDown + 6000
    )
    expect(renewB.ok).toBe(true)
  })

  it('gibt die Lease frei, wenn der Host die Gruppe verlässt', () => {
    const { hub } = setupGroup()
    const t0 = 1_000_000
    hub.leaseAcquire('node-b', GROUP_ID, { groupId: GROUP_ID, knownEpoch: 0, priority: 50 }, t0)
    expect(hub.leaseStatus(GROUP_ID, t0)?.holderId).toBe('node-b')

    hub.leaveGroup('node-b', GROUP_ID, t0 + 100)
    expect(hub.leaseStatus(GROUP_ID, t0 + 100)).toBeNull()

    // Danach kann A sofort uebernehmen
    const leaseA = hub.leaseAcquire(
      'node-a',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 60 },
      t0 + 200
    )
    expect(leaseA.granted).toBe(true)
  })

  it('schützt die Welt, wenn der Koordinator nicht erreichbar ist', () => {
    // Wenn der Hub ausfaellt, kann keine neue Lease vergeben werden.
    // Die bestehende Lease laeuft aus -> niemand darf die Welt uebernehmen.
    const { hub } = setupGroup()
    const t0 = 1_000_000
    const leaseA = hub.leaseAcquire(
      'node-a',
      GROUP_ID,
      { groupId: GROUP_ID, knownEpoch: 0, priority: 60 },
      t0
    )
    expect(leaseA.granted).toBe(true)

    // "Hub nicht erreichbar" simulieren: der Hub beantwortet nichts.
    // Der Host prueft die Lease lokal und fenced sich selbst, wenn die
    // Verlaengerung fehlschlaegt.
    const renew = hub.leaseRenew('node-a', GROUP_ID, leaseA.lease?.epoch ?? 0, t0 + 31_000)
    expect(renew.ok).toBe(false)
    expect(renew.fenced).toBe(true)
    // Ohne gueltige Lease ist kein Commit moeglich
    expect(() =>
      hub.worldCommit(
        'node-a',
        GROUP_ID,
        {
          groupId: GROUP_ID,
          epoch: leaseA.lease?.epoch ?? 0,
          versionId: 'y',
          worldName: 'w',
          mcVersion: '1.20.4',
          dataVersion: 3700,
          totalBytes: 1,
          replicaIds: []
        },
        t0 + 31_000
      )
    ).toThrow(/gueltige Lease/)
  })
})
