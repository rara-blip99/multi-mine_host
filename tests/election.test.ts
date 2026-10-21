import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUIREMENTS,
  scoreCandidate,
  scoreCandidates,
  selectHost,
  scoreCpu,
  scoreMemory,
  scoreNetwork
} from '../src/main/host/election'
import type { HostCapability } from '../src/shared/types'

function capability(overrides: Partial<HostCapability> = {}): HostCapability {
  const base: HostCapability = {
    nodeId: 'node-a',
    displayName: 'PC A',
    hostingAllowed: true,
    priority: 50,
    cpu: {
      model: 'AMD Ryzen 5 3600',
      logicalCores: 6,
      physicalCores: 6,
      usage: 20,
      loadAvg1: 0.8
    },
    memory: {
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 10 * 1024 ** 3,
      availableBytes: 10 * 1024 ** 3,
      usage: 37
    },
    disk: {
      path: '/tmp',
      totalBytes: 500 * 1024 ** 3,
      freeBytes: 300 * 1024 ** 3,
      writeMbps: 200,
      readMbps: 250,
      filesystem: 'ntfs'
    },
    network: {
      uploadMbps: 50,
      downloadMbps: 200,
      latencyMs: 15,
      jitterMs: 2,
      relayOnly: false,
      advertisedAddresses: []
    },
    java: { available: true, version: '17.0.10', major: 17, path: 'java' },
    stability: {
      uptimeSeconds: 86400,
      successfulHosts: 5,
      failedHosts: 0,
      availabilityRatio: 1,
      lastExitReason: 'geordnet'
    },
    requiredWorldBytes: 2 * 1024 ** 3,
    measuredAt: Date.now()
  }
  return { ...base, ...overrides }
}

const ctx = {
  requirements: { ...DEFAULT_REQUIREMENTS, requiredWorldBytes: 2 * 1024 ** 3 },
  currentHostId: null,
  worldReplicaIds: [] as string[],
  serverRamBytes: 4 * 1024 ** 3
}

describe('Host-Bewertung', () => {
  it('bewertet einen leistungsfähigen PC höher als einen schwachen', () => {
    const strong = scoreCandidate(
      capability({
        nodeId: 'strong',
        displayName: 'Starker PC',
        cpu: {
          model: 'AMD Ryzen 9 5950X',
          logicalCores: 16,
          physicalCores: 16,
          usage: 10,
          loadAvg1: 1
        },
        memory: {
          totalBytes: 32 * 1024 ** 3,
          freeBytes: 24 * 1024 ** 3,
          availableBytes: 24 * 1024 ** 3,
          usage: 25
        },
        network: {
          uploadMbps: 100,
          downloadMbps: 500,
          latencyMs: 5,
          jitterMs: 1,
          relayOnly: false,
          advertisedAddresses: []
        }
      }),
      ctx
    )
    const weak = scoreCandidate(
      capability({
        nodeId: 'weak',
        displayName: 'Schwacher PC',
        cpu: {
          model: 'Intel Pentium N4020',
          logicalCores: 4,
          physicalCores: 2,
          usage: 70,
          loadAvg1: 3
        },
        memory: {
          totalBytes: 8 * 1024 ** 3,
          freeBytes: 3 * 1024 ** 3,
          availableBytes: 3 * 1024 ** 3,
          usage: 62
        },
        network: {
          uploadMbps: 5,
          downloadMbps: 20,
          latencyMs: 120,
          jitterMs: 30,
          relayOnly: true,
          advertisedAddresses: []
        },
        stability: {
          uptimeSeconds: 600,
          successfulHosts: 1,
          failedHosts: 3,
          availabilityRatio: 0.25,
          lastExitReason: 'Absturz'
        }
      }),
      ctx
    )

    expect(strong.eligible).toBe(true)
    expect(weak.eligible).toBe(false) // 3 GB frei < 4 GB Bedarf
    expect(strong.score).toBeGreaterThan(weak.score)
  })

  it('bevorzugt einen freien PC gegenüber einem ausgelasteten', () => {
    const idle = scoreCpu({
      model: 'AMD Ryzen 5 3600',
      logicalCores: 6,
      physicalCores: 6,
      usage: 5,
      loadAvg1: 0.2
    })
    const busy = scoreCpu({
      model: 'AMD Ryzen 5 3600',
      logicalCores: 6,
      physicalCores: 6,
      usage: 95,
      loadAvg1: 5
    })
    expect(idle.score).toBeGreaterThan(busy.score)
  })

  it('bewertet CPU-Auslastung nicht nur über die Kernzahl', () => {
    const manyCoresBusy = scoreCpu({
      model: 'AMD Ryzen 9 5950X',
      logicalCores: 16,
      physicalCores: 16,
      usage: 98,
      loadAvg1: 14
    })
    const fewCoresIdle = scoreCpu({
      model: 'Intel Core i5-10400',
      logicalCores: 6,
      physicalCores: 6,
      usage: 8,
      loadAvg1: 0.5
    })
    expect(fewCoresIdle.score).toBeGreaterThan(manyCoresBusy.score)
  })

  it('schließt Kandidaten mit zu wenig RAM aus', () => {
    const score = scoreCandidate(
      capability({
        memory: {
          totalBytes: 8 * 1024 ** 3,
          freeBytes: 1 * 1024 ** 3,
          availableBytes: 1 * 1024 ** 3,
          usage: 87
        }
      }),
      ctx
    )
    expect(score.eligible).toBe(false)
    expect(score.disqualifiers.join(' ')).toContain('Arbeitsspeicher')
  })

  it('schließt Kandidaten mit zu wenig Speicherplatz aus', () => {
    const score = scoreCandidate(
      capability({
        disk: {
          path: '/tmp',
          totalBytes: 100 * 1024 ** 3,
          freeBytes: 100 * 1024 ** 2,
          writeMbps: 50,
          readMbps: 50,
          filesystem: 'ntfs'
        }
      }),
      ctx
    )
    expect(score.eligible).toBe(false)
    expect(score.disqualifiers.join(' ')).toContain('Speicherplatz')
  })

  it('schließt Kandidaten ohne passendes Java aus', () => {
    const score = scoreCandidate(
      capability({ java: { available: true, version: '11.0.20', major: 11, path: 'java' } }),
      ctx
    )
    expect(score.eligible).toBe(false)
    expect(score.disqualifiers.join(' ')).toContain('Java')
  })

  it('schließt Kandidaten aus, deren Hosting gesperrt ist', () => {
    const score = scoreCandidate(capability({ hostingAllowed: false }), ctx)
    expect(score.eligible).toBe(false)
    expect(score.disqualifiers.join(' ')).toContain('Hosting')
  })

  it('bewertet Relay-Verbindungen schlechter als direkte', () => {
    const direct = scoreNetwork({
      uploadMbps: 50,
      downloadMbps: 200,
      latencyMs: 10,
      jitterMs: 1,
      relayOnly: false,
      advertisedAddresses: []
    })
    const relayed = scoreNetwork({
      uploadMbps: 50,
      downloadMbps: 200,
      latencyMs: 10,
      jitterMs: 1,
      relayOnly: true,
      advertisedAddresses: []
    })
    expect(direct.score).toBeGreaterThan(relayed.score)
  })

  it('bewertet Speicherbedarf relativ zum Bedarf, nicht absolut', () => {
    const generous = scoreMemory(
      { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, availableBytes: 20 * 1024 ** 3, usage: 37 },
      4 * 1024 ** 3
    )
    const tight = scoreMemory(
      { totalBytes: 32 * 1024 ** 3, freeBytes: 5 * 1024 ** 3, availableBytes: 5 * 1024 ** 3, usage: 84 },
      4 * 1024 ** 3
    )
    expect(generous.score).toBeGreaterThan(tight.score)
  })

  it('berücksichtigt die Benutzerpriorität', () => {
    const low = scoreCandidate(capability({ priority: 0 }), ctx)
    const high = scoreCandidate(capability({ priority: 100 }), ctx)
    expect(high.score).toBeGreaterThan(low.score)
    // Die Priorität darf aber den Gesamtscore nicht dominieren.
    expect(high.score - low.score).toBeLessThanOrEqual(15.001)
  })

  it('bevorzugt Kandidaten, die die Welt bereits besitzen', () => {
    const withReplica = scoreCandidate(capability({ nodeId: 'has-world' }), {
      ...ctx,
      worldReplicaIds: ['has-world']
    })
    const without = scoreCandidate(capability({ nodeId: 'no-world' }), {
      ...ctx,
      worldReplicaIds: ['has-world']
    })
    expect(withReplica.score).toBeGreaterThan(without.score)
  })
})

describe('Host-Auswahl', () => {
  it('wählt den höchsten bewerteten geeigneten Kandidaten', () => {
    const scores = scoreCandidates(
      [
        capability({ nodeId: 'a', displayName: 'A', priority: 20 }),
        capability({
          nodeId: 'b',
          displayName: 'B',
          priority: 90,
          cpu: { model: 'AMD Ryzen 9 5950X', logicalCores: 16, physicalCores: 16, usage: 5, loadAvg1: 0.5 }
        })
      ],
      ctx
    )
    const result = selectHost(scores)
    expect(result.chosen?.nodeId).toBe('b')
    expect(result.reason).toContain('B')
  })

  it('wählt keinen Host, wenn kein Kandidat geeignet ist', () => {
    const scores = scoreCandidates(
      [
        capability({
          nodeId: 'bad',
          java: { available: false, version: '', major: 0, path: '' }
        })
      ],
      ctx
    )
    const result = selectHost(scores)
    expect(result.chosen).toBeNull()
    expect(result.reason).toContain('kein Host gestartet')
  })

  it('sortiert disqualifizierte Kandidaten nach hinten', () => {
    const scores = scoreCandidates(
      [
        capability({ nodeId: 'bad', java: { available: false, version: '', major: 0, path: '' } }),
        capability({ nodeId: 'good' })
      ],
      ctx
    )
    expect(scores[0]?.nodeId).toBe('good')
    expect(scores[0]?.eligible).toBe(true)
    expect(scores[1]?.eligible).toBe(false)
  })

  it('liefert nachvollziehbare Gründe für jeden Kandidaten', () => {
    const scores = scoreCandidates([capability()], ctx)
    const reasons = scores[0]?.reasons ?? []
    expect(reasons.length).toBeGreaterThanOrEqual(6)
    for (const r of reasons) {
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.detail.length).toBeGreaterThan(0)
      expect(r.weight).toBeGreaterThan(0)
    }
    const total = reasons.reduce((s, r) => s + r.weight, 0)
    expect(total).toBeCloseTo(100, 0)
  })
})
