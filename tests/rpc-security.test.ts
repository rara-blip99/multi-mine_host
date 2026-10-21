import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RpcConnection } from '../src/main/net/rpc'
import { IdentityStore, deriveNodeId } from '../src/main/security/identity'
import { asStream, createStreamPair, MockStream } from './helpers/mock-stream'
import { PROTOCOL_VERSION, signatureBody } from '../src/shared/protocol'
import type { RpcRequest } from '../src/shared/protocol'

function makeIdentity(name: string): { store: IdentityStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `mmh-id-${name}-`))
  const store = new IdentityStore(join(dir, 'identity.json'))
  store.setDisplayName(name)
  return { store, dir }
}

describe('Identität', () => {
  it('erzeugt einen stabilen nodeId aus dem Public Key', () => {
    const { store, dir } = makeIdentity('Test')
    try {
      const identity = store.identity()
      expect(identity.nodeId).toHaveLength(26)
      expect(identity.nodeId).toMatch(/^[a-z2-7]+$/)
      expect(deriveNodeId(Buffer.from(identity.publicKey, 'base64'))).toBe(identity.nodeId)
      // Der nodeId bleibt ueber Neustarts stabil
      const store2 = new IdentityStore(join(dir, 'identity.json'))
      expect(store2.nodeId).toBe(identity.nodeId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('signiert und prüft Nachrichten', () => {
    const { store, dir } = makeIdentity('Test')
    try {
      const data = 'wichtige Nachricht'
      const sig = store.sign(data)
      expect(store.verify(data, sig)).toBe(true)
      expect(store.verify('andere Nachricht', sig)).toBe(false)
      expect(IdentityStore.verifyWith(store.publicKeyBase64, data, sig)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RPC-Sicherheit', () => {
  it('akzeptiert eine korrekt signierte Anfrage', async () => {
    const client = makeIdentity('Client')
    const server = makeIdentity('Server')
    try {
      const { a, b } = createStreamPair()
      const clientRpc = new RpcConnection(asStream(a), {
        identity: client.store,
        publicKeys: new Map([[server.store.nodeId, server.store.publicKeyBase64]]),
        peerLabel: 'server'
      })
      const serverRpc = new RpcConnection(asStream(b), {
        identity: server.store,
        publicKeys: new Map([[client.store.nodeId, client.store.publicKeyBase64]]),
        peerLabel: 'client'
      })

      serverRpc.on('test.request', ({ request, respond }) => {
        respond({ echo: request.payload })
      })

      const result = await clientRpc.request<{ echo: unknown }>('test.request', { hallo: 'welt' })
      expect(result.echo).toEqual({ hallo: 'welt' })
    } finally {
      rmSync(client.dir, { recursive: true, force: true })
      rmSync(server.dir, { recursive: true, force: true })
    }
  })

  it('lehnt eine Anfrage ohne Signatur ab', async () => {
    const client = makeIdentity('Client')
    const server = makeIdentity('Server')
    try {
      const { a, b } = createStreamPair()
      const serverRpc = new RpcConnection(asStream(b), {
        identity: server.store,
        publicKeys: new Map([[client.store.nodeId, client.store.publicKeyBase64]]),
        peerLabel: 'client'
      })

      const req: RpcRequest = {
        v: PROTOCOL_VERSION,
        id: 'x',
        type: 'test.request',
        ts: Date.now(),
        nonce: 'n1',
        from: client.store.nodeId,
        payload: {}
      }
      const { writeFrame, readFrames } = await import('../src/main/net/framing')
      await writeFrame(asStream(a), new TextEncoder().encode(JSON.stringify(req)))

      const iterator = readFrames(asStream(a))
      const next = await iterator.next()
      expect(next.done).toBe(false)
      const response = JSON.parse(new TextDecoder().decode(next.value as Uint8Array)) as {
        ok: boolean
        errorCode?: string
      }
      expect(response.ok).toBe(false)
      expect(response.errorCode).toBe('UNSIGNED')
    } finally {
      rmSync(client.dir, { recursive: true, force: true })
      rmSync(server.dir, { recursive: true, force: true })
    }
  })

  it('weist eine Anfrage mit falscher Signatur ab', () => {
    const server = makeIdentity('Server')
    const attacker = makeIdentity('Attacker')
    try {
      const stream = new MockStream('dummy')
      const rpc = new RpcConnection(asStream(stream), {
        identity: server.store,
        publicKeys: new Map([['node-x', server.store.publicKeyBase64]]),
        peerLabel: 'test'
      })
      const req: RpcRequest = {
        v: PROTOCOL_VERSION,
        id: 'x',
        type: 'test.request',
        ts: Date.now(),
        nonce: 'n1',
        from: 'node-x',
        payload: {},
        // Mit einem fremden Schlüssel signiert
        sig: attacker.store.sign('fremde nachricht')
      }
      const check = rpc.validate(req)
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.code).toBe('BAD_SIGNATURE')
    } finally {
      rmSync(server.dir, { recursive: true, force: true })
      rmSync(attacker.dir, { recursive: true, force: true })
    }
  })

  it('weist eine Anfrage von einem unbekannten Absender ab', () => {
    const server = makeIdentity('Server')
    try {
      const stream = new MockStream('dummy')
      const rpc = new RpcConnection(asStream(stream), {
        identity: server.store,
        publicKeys: new Map(),
        peerLabel: 'test'
      })
      const check = rpc.validate({
        v: PROTOCOL_VERSION,
        id: 'x',
        type: 'test.request',
        ts: Date.now(),
        nonce: 'n1',
        from: 'unbekannt',
        payload: {}
      })
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.code).toBe('UNKNOWN_SENDER')
    } finally {
      rmSync(server.dir, { recursive: true, force: true })
    }
  })

  it('weist eine veraltete Anfrage ab (Replay-Schutz)', () => {
    const server = makeIdentity('Server')
    try {
      const stream = new MockStream('dummy')
      const rpc = new RpcConnection(asStream(stream), {
        identity: server.store,
        publicKeys: new Map([['node-x', server.store.publicKeyBase64]]),
        peerLabel: 'test'
      })
      const body = {
        v: PROTOCOL_VERSION,
        id: 'x',
        type: 'test.request',
        ts: Date.now() - 10 * 60_000,
        nonce: 'n1',
        from: 'node-x',
        payload: {}
      }
      const check = rpc.validate({ ...body, sig: server.store.sign(signatureBody(body)) })
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.code).toBe('STALE')
    } finally {
      rmSync(server.dir, { recursive: true, force: true })
    }
  })

  it('weist eine doppelte Nonce ab (Replay)', () => {
    const client = makeIdentity('Client')
    try {
      const stream = new MockStream('dummy')
      const rpc = new RpcConnection(asStream(stream), {
        identity: client.store,
        publicKeys: new Map([['node-x', client.store.publicKeyBase64]]),
        peerLabel: 'test'
      })
      const body = {
        v: PROTOCOL_VERSION,
        id: 'x',
        type: 'test.request',
        ts: Date.now(),
        nonce: 'gleiche-nonce',
        from: 'node-x',
        payload: {}
      }
      const sig = client.store.sign(signatureBody(body))
      expect(rpc.validate({ ...body, sig }).ok).toBe(true)
      const second = rpc.validate({ ...body, sig })
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.code).toBe('REPLAY')
    } finally {
      rmSync(client.dir, { recursive: true, force: true })
    }
  })

  it('weist eine inkompatible Protokollversion ab', () => {
    const server = makeIdentity('Server')
    try {
      const stream = new MockStream('dummy')
      const rpc = new RpcConnection(asStream(stream), {
        identity: server.store,
        publicKeys: new Map([['node-x', server.store.publicKeyBase64]]),
        peerLabel: 'test'
      })
      const body = {
        v: '0.0.1',
        id: 'x',
        type: 'test.request',
        ts: Date.now(),
        nonce: 'n1',
        from: 'node-x',
        payload: {}
      }
      const check = rpc.validate({ ...body, sig: server.store.sign(signatureBody(body)) })
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.code).toBe('VERSION_MISMATCH')
    } finally {
      rmSync(server.dir, { recursive: true, force: true })
    }
  })

  it('signiert auch das Auth-Token mit (Schutz gegen Session-Missbrauch)', () => {
    const server = makeIdentity('Server')
    try {
      const body = {
        v: PROTOCOL_VERSION,
        id: 'x',
        type: 'hub.heartbeat',
        ts: Date.now(),
        nonce: 'n1',
        from: 'node-x',
        auth: 'geheim-token',
        payload: { a: 1 }
      }
      const sig = server.store.sign(signatureBody(body))
      const other = { ...body, auth: 'anderes-token' }
      expect(server.store.verify(signatureBody(body), sig)).toBe(true)
      expect(server.store.verify(signatureBody(other), sig)).toBe(false)
    } finally {
      rmSync(server.dir, { recursive: true, force: true })
    }
  })
})
