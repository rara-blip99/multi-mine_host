import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPeerNode } from '../src/main/net/transport'
import { PeerManager } from '../src/main/net/peer-manager'
import { IdentityStore } from '../src/main/security/identity'
import type { PeerDiscoveryInfo } from '../src/shared/protocol'

/**
 * Regressionstest fuer die Backup-Replikation ueber das echte Netzwerk.
 *
 * Abgedeckt ist genau der Fehlerfall aus dem Failover-Test: handleIncoming
 * liest das Backup-Angebot und reicht den Stream an receiveBackup weiter.
 * receiveBackup darf nicht erneut ein "erstes" Angebot erwarten - sonst
 * wartet Sender (auf Bestaetigung) und Empfaenger (auf Angebot) eewig
 * gegenseitig (Deadlock).
 */

function stubOptions() {
  return {
    provideWorld: async () => null,
    quiesceWorld: async () => ({ ok: false, versionId: '' }),
    publicKeys: () => new Map<string, string>()
  }
}

describe('Integration: Backup-Replikation ueber echtes libp2p', () => {
  it('uebertraegt ein Backup vollstaendig und verifiziert die Pruefsumme', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'mmh-repl-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'mmh-repl-b-'))
    const identityA = new IdentityStore(join(dirA, 'identity.json'))
    const identityB = new IdentityStore(join(dirB, 'identity.json'))
    const nodeA = await createPeerNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      privateKeyPem: identityA.material.privateKeyPem,
      appName: 'mmh-test/0.1.0'
    })
    const nodeB = await createPeerNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      privateKeyPem: identityB.material.privateKeyPem,
      appName: 'mmh-test/0.1.0'
    })

    const backupsB = join(dirB, 'backups')
    const managerB = new PeerManager({
      node: nodeB,
      identity: identityB,
      groupId: 'g-test',
      ...stubOptions(),
      peerIdOf: () => undefined,
      backupDir: () => backupsB
    })
    await managerB.listen()

    const backupsA = join(dirA, 'backups')
    const managerA = new PeerManager({
      node: nodeA,
      identity: identityA,
      groupId: 'g-test',
      ...stubOptions(),
      peerIdOf: (nodeId) => (nodeId === 'node-b' ? nodeB.node.peerId.toString() : undefined),
      backupDir: () => backupsA
    })

    try {
      // Adressen von B bei A hinterlegen (entspricht hub.discovery -> updatePeers)
      const addrB = nodeB
        .addresses()
        .find((a) => a.includes('/ip4/127.0.0.1'))
        ?.replace(/\/p2p\/.*$/, '')
      expect(addrB).toBeTruthy()
      const discovery: PeerDiscoveryInfo[] = [
        {
          nodeId: 'node-b',
          displayName: 'PC-B',
          peerId: nodeB.node.peerId.toString(),
          addresses: [addrB as string],
          lastSeenAt: Date.now(),
          online: true
        }
      ]
      await managerA.updatePeers(discovery)

      // Das zu replizierende Backup (realistische Groesse fuer viele Frames).
      mkdirSync(backupsA, { recursive: true })
      const data = randomBytes(3 * 1024 * 1024)
      const file = join(backupsA, 'quell-backup.tar.gz')
      writeFileSync(file, data)
      const sha256 = createHash('sha256').update(data).digest('hex')

      const result = await managerA.sendBackup('node-b', file, {
        id: '2026-01-01T00-00-00-000Z_manual_deadlock-a1',
        kind: 'manual',
        worldName: 'welt',
        worldVersionId: 'welt-v1',
        mcVersion: '1.20.4',
        dataVersion: 3657,
        sizeBytes: data.byteLength,
        uncompressedBytes: data.byteLength,
        sha256,
        createdAt: Date.now()
      })
      expect(result.ok).toBe(true)

      // Bei B angekommen? Renaming geschieht asynchron nach dem Senden,
      // wir warten bis zu 5 Sekunden auf die Zieldatei.
      const target = join(backupsB, '2026-01-01T00-00-00-000Z_manual_deadlock-a1.tar.gz')
      for (let i = 0; i < 50 && !existsSync(target); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(readFileSync(target)).toEqual(data)
      const meta = JSON.parse(readFileSync(`${target}.meta.json`, 'utf8')) as { replicated: boolean }
      expect(meta.replicated).toBe(true)
    } finally {
      await nodeA.stop()
      await nodeB.stop()
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  }, 45_000)

  it('lehnt ein Backup einer fremden Gruppe ab, ohne eine Datei zu schreiben', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'mmh-repl-foreign-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'mmh-repl-foreign-b-'))
    const identityA = new IdentityStore(join(dirA, 'identity.json'))
    const identityB = new IdentityStore(join(dirB, 'identity.json'))
    const nodeA = await createPeerNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      privateKeyPem: identityA.material.privateKeyPem,
      appName: 'mmh-test/0.1.0'
    })
    const nodeB = await createPeerNode({
      listen: ['/ip4/127.0.0.1/tcp/0'],
      privateKeyPem: identityB.material.privateKeyPem,
      appName: 'mmh-test/0.1.0'
    })
    const backupsB = join(dirB, 'backups')
    const managerB = new PeerManager({
      node: nodeB,
      identity: identityB,
      groupId: 'g-empfang',
      ...stubOptions(),
      peerIdOf: () => undefined,
      backupDir: () => backupsB
    })
    await managerB.listen()

    const managerA = new PeerManager({
      node: nodeA,
      identity: identityA,
      // Bewusst abweichende Gruppe -> muess abgelehnt werden.
      groupId: 'g-anderer',
      ...stubOptions(),
      peerIdOf: (nodeId) => (nodeId === 'node-b' ? nodeB.node.peerId.toString() : undefined),
      backupDir: () => join(dirA, 'backups')
    })
    try {
      const addrB = nodeB
        .addresses()
        .find((a) => a.includes('/ip4/127.0.0.1'))
        ?.replace(/\/p2p\/.*$/, '')
      expect(addrB).toBeTruthy()
      await managerA.updatePeers([
        {
          nodeId: 'node-b',
          displayName: 'PC-B',
          peerId: nodeB.node.peerId.toString(),
          addresses: [addrB as string],
          lastSeenAt: Date.now(),
          online: true
        }
      ])

      const data = randomBytes(1024)
      const backupDirA = join(dirA, 'backups')
      mkdirSync(backupDirA, { recursive: true })
      const file = join(backupDirA, 'fremd.tar.gz')
      writeFileSync(file, data)

      const result = await managerA.sendBackup('node-b', file, {
        id: '2026-01-01T00-00-00-000Z_manual_fremd-x1',
        kind: 'manual',
        worldName: 'welt',
        worldVersionId: 'welt-v1',
        mcVersion: '1.20.4',
        dataVersion: 3657,
        sizeBytes: data.byteLength,
        uncompressedBytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
        createdAt: Date.now()
      })
      expect(result.ok).toBe(false)

      // Nichts angelegt - weder Datei noch Metadaten.
      expect(existsSync(backupsB)).toBe(false)
    } finally {
      await nodeA.stop()
      await nodeB.stop()
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  }, 45_000)
})
