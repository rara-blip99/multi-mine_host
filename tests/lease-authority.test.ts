import { describe, expect, it } from 'vitest'
import { LeaseAuthority, DEFAULT_LEASE_TTL_MS, LEASE_GRACE_MS } from '../src/main/host/lease-authority'

/**
 * Tests fuer das Fencing-Verhalten.
 *
 * Diese Tests sind das sicherheitskritischste Stueck der Anwendung:
 * Sie stellen sicher, dass nie zwei Hosts gleichzeitig die Welt beschreiben.
 */
describe('Host-Lease (Fencing)', () => {
  it('vergibt die Lease an genau einen Kandidaten', () => {
    const authority = new LeaseAuthority()
    const t0 = 1_000_000

    const first = authority.acquire('gruppe', 'node-a', t0)
    expect(first.granted).toBe(true)
    expect(first.lease?.holderId).toBe('node-a')
    expect(first.lease?.epoch).toBe(1)

    // Zweiter Kandidat versucht es gleichzeitig -> abgelehnt
    const second = authority.acquire('gruppe', 'node-b', t0 + 100)
    expect(second.granted).toBe(false)
    expect(second.lease?.holderId).toBe('node-a')
  })

  it('erhöht die Epoche bei jedem Wechsel (monoton steigend)', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000, graceMs: 0 })
    const t0 = 1_000_000

    const a = authority.acquire('gruppe', 'node-a', t0)
    expect(a.lease?.epoch).toBe(1)

    // Lease läuft ab, node-b übernimmt
    const b = authority.acquire('gruppe', 'node-b', t0 + 2000)
    expect(b.granted).toBe(true)
    expect(b.lease?.epoch).toBe(2)

    // node-a kehrt zurück und versucht es erneut, solange node-b noch hostet
    const aAgain = authority.acquire('gruppe', 'node-a', t0 + 2500)
    expect(aAgain.granted).toBe(false)
    expect(aAgain.lease?.holderId).toBe('node-b')
  })

  it('fenced einen Host, dessen Epoche veraltet ist', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000, graceMs: 0 })
    const t0 = 1_000_000
    const a = authority.acquire('gruppe', 'node-a', t0)
    const epochA = a.lease?.epoch ?? 0

    // node-a erneuert seine eigene Lease -> neue Epoche
    const renewed = authority.acquire('gruppe', 'node-a', t0 + 100)
    expect(renewed.granted).toBe(true)
    expect(renewed.lease?.epoch).toBe(epochA + 1)

    // Die alte Epoche ist jetzt wertlos -> Fencing
    const renew = authority.renew('gruppe', 'node-a', epochA, t0 + 200)
    expect(renew.ok).toBe(false)
    expect(renew.fenced).toBe(true)
    expect(renew.reason).toContain('Epoche veraltet')
  })

  it('fenced einen Host, der nach einer fremden Übernahme verlängern will', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000, graceMs: 0 })
    const t0 = 1_000_000
    const a = authority.acquire('gruppe', 'node-a', t0)
    const epochA = a.lease?.epoch ?? 0

    // Lease läuft ab, node-b uebernimmt
    authority.acquire('gruppe', 'node-b', t0 + 2000)

    // node-a versucht zu verlaengern -> fenced
    const renew = authority.renew('gruppe', 'node-a', epochA, t0 + 2100)
    expect(renew.ok).toBe(false)
    expect(renew.fenced).toBe(true)
    expect(renew.reason).toMatch(/Epoche veraltet|gehört jetzt/)
  })

  it('fenced einen Host, der die Lease eines anderen verlaengern will', () => {
    const authority = new LeaseAuthority({ ttlMs: 10_000 })
    const t0 = 1_000_000
    authority.acquire('gruppe', 'node-a', t0)

    const renew = authority.renew('gruppe', 'node-b', 1, t0 + 100)
    expect(renew.ok).toBe(false)
    expect(renew.fenced).toBe(true)
    expect(renew.reason).toContain('gehört jetzt')
  })

  it('beachtet die Grazienzeit nach Ablauf der Lease', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000, graceMs: 3000 })
    const t0 = 1_000_000
    authority.acquire('gruppe', 'node-a', t0)

    // 1 ms nach Ablauf: noch keine Uebernahme moeglich
    const tooEarly = authority.acquire('gruppe', 'node-b', t0 + 1001)
    expect(tooEarly.granted).toBe(false)
    expect(tooEarly.reason).toContain('Grazienzeit')

    // Nach der Grazienzeit: Uebernahme moeglich
    const ok = authority.acquire('gruppe', 'node-b', t0 + 1001 + 3000)
    expect(ok.granted).toBe(true)
  })

  it('verhindert, dass zwei Kandidaten gleichzeitig die Lease bekommen', () => {
    const authority = new LeaseAuthority({ ttlMs: 5000, graceMs: 0 })
    const t0 = 1_000_000

    // Simuliert gleichzeitige Anfragen mehrerer Mitglieder
    const results = ['node-a', 'node-b', 'node-c', 'node-d'].map((id) =>
      authority.acquire('gruppe', id, t0 + 10)
    )
    const granted = results.filter((r) => r.granted)
    expect(granted.length).toBe(1)
    expect(results.every((r) => r.lease?.holderId === granted[0]?.lease?.holderId)).toBe(true)
  })

  it('erlaubt kein Commit ohne gueltige Lease', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000, graceMs: 0 })
    const t0 = 1_000_000

    const withoutLease = authority.commitWorld(
      'gruppe',
      'node-a',
      1,
      {
        versionId: 'v1',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        committedAt: t0,
        totalBytes: 100,
        replicaIds: []
      },
      t0
    )
    expect(withoutLease.ok).toBe(false)

    const lease = authority.acquire('gruppe', 'node-a', t0)
    const withLease = authority.commitWorld(
      'gruppe',
      'node-a',
      lease.lease?.epoch ?? 0,
      {
        versionId: 'v1',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        committedAt: t0,
        totalBytes: 100,
        replicaIds: []
      },
      t0
    )
    expect(withLease.ok).toBe(true)
    expect(authority.world('gruppe')?.versionId).toBe('v1')
  })

  it('lehnt einen Commit mit falscher Epoche ab (Split-Brain-Schutz)', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000, graceMs: 0 })
    const t0 = 1_000_000
    const first = authority.acquire('gruppe', 'node-a', t0)
    const epochA = first.lease?.epoch ?? 0

    // Lease läuft ab, node-b uebernimmt
    authority.acquire('gruppe', 'node-b', t0 + 2000)

    // node-a versucht trotzdem zu committen -> abgelehnt
    const stale = authority.commitWorld(
      'gruppe',
      'node-a',
      epochA,
      {
        versionId: 'v-stale',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        committedAt: t0,
        totalBytes: 100,
        replicaIds: []
      },
      t0 + 2100
    )
    expect(stale.ok).toBe(false)
    expect(stale.reason).toContain('Fencing')
    expect(authority.world('gruppe')).toBeNull()
  })

  it('gibt die Lease kontrolliert frei und vergibt danach eine hoehere Epoche', () => {
    const authority = new LeaseAuthority({ ttlMs: 10_000 })
    const t0 = 1_000_000
    const a = authority.acquire('gruppe', 'node-a', t0)

    const released = authority.release('gruppe', 'node-a', a.lease?.epoch ?? 0, 'geordneter Wechsel')
    expect(released).toBe(true)

    const b = authority.acquire('gruppe', 'node-b', t0 + 100)
    expect(b.granted).toBe(true)
    expect(b.lease?.epoch).toBe((a.lease?.epoch ?? 0) + 1)
  })

  it('erlaubt das Freigeben nur mit korrekter Epoche', () => {
    const authority = new LeaseAuthority({ ttlMs: 10_000 })
    const t0 = 1_000_000
    authority.acquire('gruppe', 'node-a', t0)
    expect(authority.release('gruppe', 'node-a', 99, 'falsch')).toBe(false)
    expect(authority.release('gruppe', 'node-b', 1, 'falscher Holder')).toBe(false)
  })

  it('gibt keine Lease frei, die nicht existiert', () => {
    const authority = new LeaseAuthority()
    expect(authority.release('gruppe', 'node-a', 1, 'x')).toBe(false)
    expect(authority.status('gruppe')).toBeNull()
  })

  it('erlaubt dem Administrator, die Lease zu widerrufen', () => {
    const authority = new LeaseAuthority({ ttlMs: 10_000 })
    const t0 = 1_000_000
    authority.acquire('gruppe', 'node-a', t0)
    expect(authority.revoke('gruppe', 'Missbrauch')).toBe(true)
    expect(authority.status('gruppe')).toBeNull()

    const b = authority.acquire('gruppe', 'node-b', t0 + 100)
    expect(b.granted).toBe(true)
    expect(b.lease?.epoch).toBe(2)
  })

  it('trägt Replikate nach, ohne die Weltversion zu wechseln', () => {
    const authority = new LeaseAuthority({ ttlMs: 10_000 })
    const t0 = 1_000_000
    const lease = authority.acquire('gruppe', 'node-a', t0)
    authority.commitWorld(
      'gruppe',
      'node-a',
      lease.lease?.epoch ?? 0,
      {
        versionId: 'v1',
        worldName: 'welt',
        mcVersion: '1.20.4',
        dataVersion: 3700,
        committedAt: t0,
        totalBytes: 100,
        replicaIds: []
      },
      t0
    )
    authority.addReplica('gruppe', 'v1', 'node-b')
    expect(authority.world('gruppe')?.replicaIds).toContain('node-b')
    expect(authority.world('gruppe')?.versionId).toBe('v1')
  })

  it('überlebt eine Netzwerktrennung (Lease läuft ab, Übernahme nach Grazienzeit)', () => {
    const authority = new LeaseAuthority({ ttlMs: 2000, graceMs: 1000 })
    let t = 1_000_000
    const a = authority.acquire('gruppe', 'node-a', t)
    expect(a.granted).toBe(true)

    // Netzwerktrennung: der Host kann nicht mehr verlängern
    t += 2500
    const renew = authority.renew('gruppe', 'node-a', a.lease?.epoch ?? 0, t)
    expect(renew.ok).toBe(false)
    expect(renew.fenced).toBe(true)

    // Ein anderes Mitglied übernimmt nach der Grazienzeit
    const b = authority.acquire('gruppe', 'node-b', t + 1000)
    expect(b.granted).toBe(true)
    expect(b.lease?.epoch).toBeGreaterThan(a.lease?.epoch ?? 0)
  })

  it('verhindert, dass eine abgelaufene Lease als gültig gemeldet wird', () => {
    const authority = new LeaseAuthority({ ttlMs: 1000 })
    const t0 = 1_000_000
    authority.acquire('gruppe', 'node-a', t0)
    const status = authority.status('gruppe', t0 + 500)
    expect(status?.holderId).toBe('node-a')
    const expired = authority.status('gruppe', t0 + 5000)
    expect(expired?.expiresAt).toBe(t0 + 1000)
    expect(expired!.expiresAt <= t0 + 5000).toBe(true)
  })

  it('erhält die Standardwerte sinnvoll', () => {
    expect(DEFAULT_LEASE_TTL_MS).toBeGreaterThan(10_000)
    expect(LEASE_GRACE_MS).toBeGreaterThan(0)
  })
})
