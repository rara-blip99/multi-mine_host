import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppService } from '../src/main/app-service'
import { IdentityStore } from '../src/main/security/identity'
import { HubNode } from '../src/main/hub/hub-node'
import { peerIdFromAddress } from '../src/shared/protocol'

/**
 * Regressionen fuer die Gruppenerstellung ohne manuelle Token-Eingabe
 * (Fehlerbild "Ungueltiges Hub-Token" auf dem eingebauten Hub) sowie
 * fuer stabile Hub-Identitaeten (Peer-ID und Port ueber Neustarts).
 *
 * Sicherheit bleibt unangetastet: ein falsches Token wird abgewiesen,
 * das Token des eingebauten Hubs wird nie an einen fremden Hub gesendet.
 */

const roots: string[] = []
const services: AppService[] = []
const hubs: HubNode[] = []

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mmh-embed-'))
  roots.push(dir)
  return dir
}

function newService(root: string): AppService {
  const identity = new IdentityStore(join(root, 'identity.json'))
  const service = new AppService({ identity, dataRoot: root })
  services.push(service)
  return service
}

function portOf(address: string): number {
  return Number(/\/tcp\/(\d+)\//.exec(address)?.[1] ?? 0)
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    try {
      await service.stop()
    } catch {
      /* Aufräumen darf nicht blockieren */
    }
  }
  for (const hub of hubs.splice(0)) {
    try {
      await hub.stop()
    } catch {
      /* Aufräumen darf nicht blockieren */
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Eingebauter Hub: Gruppenerstellung', () => {
  it('erstellt eine Gruppe ohne manuelle Token-Eingabe', async () => {
    const service = newService(newRoot())
    await service.start()

    // Leere Hub-Adresse + leeres Token = der Ein-Klick-Flow der Oberflaeche.
    const result = await service.createGroup('', 'Test')
    expect(result.group.groupId).toBeTruthy()
    expect(result.invites.length).toBeGreaterThan(0)
    expect(service.getState().group?.groupId).toBe(result.group.groupId)

    // Der Owner ist als Mitglied registriert.
    const self = service.getState().identity?.nodeId
    expect(service.getState().members.find((m) => m.nodeId === self)?.role).toBe('owner')
  }, 60_000)

  it('weist ein falsches Token auch auf dem eigenen Hub ab (Fail-closed)', async () => {
    const service = newService(newRoot())
    await service.start()

    await expect(service.createGroup('', 'Test', 'falsches-token')).rejects.toThrow(
      /Ungültiges Hub-Token/
    )
    // Es kehr kein halbfertiger Zustand zurueck.
    expect(service.getState().group).toBeNull()
  }, 60_000)
})

describe('Externer Hub mit Token', () => {
  it('akzeptiert nur das korrekte Token', async () => {
    const hubRoot = newRoot()
    const ext = new HubNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      token: 'extern-geheim',
      dataFile: join(hubRoot, 'hub-state.json')
    })
    hubs.push(ext)
    await ext.start()

    const address = ext.addresses[0] as string
    expect(address).toContain('/p2p/')

    const service = newService(newRoot())
    await service.start()

    // Korrektes Token -> Erstellung klappt.
    const ok = await service.createGroup(address, 'Externe Gruppe', 'extern-geheim')
    expect(ok.group.groupId).toBeTruthy()

    // Fehlendes Token an denselben geschuetzten Hub -> klare Ablehnung.
    const second = newService(newRoot())
    await second.start()
    await expect(second.createGroup(address, 'Nochmal')).rejects.toThrow(/Ungültiges Hub-Token/)
    await expect(second.createGroup(address, 'Nochmal', 'falsch')).rejects.toThrow(
      /Ungültiges Hub-Token/
    )
    // Kein halbfertiger Zustand.
    expect(second.getState().group).toBeNull()
    // Das Token des eigenen eingebauten Hubs wurde an den fremden Hub
    // niemals gesendet (sonst waere die Pruefung oben durchgelaufen).
  }, 90_000)
})

describe('Stabile Hub-Identität', () => {
  it('behält Peer-ID und Port über Neustarts', async () => {
    const root = newRoot()
    const identityPath = join(root, 'identity.json')

    const first = newService(root)
    await first.start()
    const addr1 = first.embeddedHubAddress() as string
    expect(addr1).toContain('/p2p/')
    const pid1 = peerIdFromAddress(addr1)
    expect(pid1).toMatch(/^[1-9A-HJ-NP-Za-km-z]{24,52}$/)
    const port1 = portOf(addr1)
    expect(port1).toBeGreaterThan(0)
    // Der konkret gebundene Port wird persistiert (Einstellungen).
    expect(first.getState().settings.embeddedHubLastPort).toBe(port1)
    await first.stop()

    const second = newService(root)
    await second.start()
    const addr2 = second.embeddedHubAddress() as string
    expect(peerIdFromAddress(addr2)).toBe(pid1)
    expect(portOf(addr2)).toBe(port1)
    expect(second.embeddedHubPeerId()).toBe(pid1)
  }, 90_000)

  it('stellt bestehende Gruppe und Sitzung nach Neustart wieder her', async () => {
    const root = newRoot()
    const identityPath = join(root, 'identity.json')

    const a = newService(root)
    await a.start()
    const created = await a.createGroup('', 'Dauerhafte Freunde')
    expect(created.group.name).toBe('Dauerhafte Freunde')
    const addr = a.embeddedHubAddress() as string
    await a.stop()

    // Simulierte veraltete Sitzungsadresse: gleiche Peer-ID, falscher Port.
    const sessionPath = join(root, 'state', 'session.json')
    const session = JSON.parse(readFileSync(sessionPath, 'utf8')) as { hubAddress: string }
    session.hubAddress = `/ip4/127.0.0.1/tcp/9/p2p/${peerIdFromAddress(addr)}`
    writeFileSync(sessionPath, JSON.stringify(session), 'utf8')

    const b = newService(root)
    await b.start()
    // Die veraltete Adresse wird anhand der Peer-ID auf die laufende
    // Hub-Instanz korrigiert - die Sitzung bleibt nutzbar.
    expect(b.getState().hubConnected).toBe(true)
    await b.refreshSnapshot()
    expect(b.getState().group?.name).toBe('Dauerhafte Freunde')

    // Die Sitzungsdatei wurde auf die laufende Adresse nachgezogen.
    const refreshed = JSON.parse(readFileSync(sessionPath, 'utf8')) as { hubAddress: string }
    expect(portOf(refreshed.hubAddress)).toBe(portOf(b.embeddedHubAddress() as string))
  }, 90_000)
})
