import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { Paths } from '../core/paths'
import { logger } from '../core/logger'
import type { NodeIdentity } from '@shared/types'

/**
 * Kryptographische Identitaet eines Mitglieds.
 *
 * - Ed25519 Schluesselpaar (OEFFENTLICH fuer das Netzwerk, PRIVAT nur lokal)
 * - nodeId = base32(sha256(publicKeyRaw))[0..26]
 * - Signaturen schuetzen alle steuerenden Nachrichten (Replay via Zeitstempel+Nonce)
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ID_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += ID_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/** nodeId aus einem Roh-Key ableiten (base32, 26 Zeichen = 130 Bit). */
export function deriveNodeId(publicKeyRaw: Buffer): string {
  const hash = createHash('sha256').update(publicKeyRaw).digest()
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of hash) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ID_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
      if (out.length === 26) return out
    }
  }
  return out
}

export interface KeyMaterial {
  publicKeyRaw: Buffer
  privateKeyPem: string
  publicKeyPem: string
}

export interface StoredIdentity {
  version: 1
  nodeId: string
  publicKeyRaw: string
  privateKeyPem: string
  displayName: string
  createdAt: number
}

export class IdentityStore {
  private readonly file: string
  private cachedMaterial: KeyMaterial | null = null
  private stored: StoredIdentity | null = null

  constructor(file?: string) {
    this.file = file ?? join(Paths.keys(), 'identity.json')
  }

  private load(): StoredIdentity {
    if (this.stored) return this.stored
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as StoredIdentity
        if (parsed.version === 1 && parsed.nodeId && parsed.privateKeyPem) {
          this.stored = parsed
          return parsed
        }
        logger.warn('identity', 'Identitaetsdatei hat unbekanntes Format, erzeuge neue')
      } catch (err) {
        logger.error('identity', 'Identitaet konnte nicht gelesen werden', { error: String(err) })
      }
    }
    const fresh = this.generate()
    this.stored = fresh
    this.persist(fresh)
    return fresh
  }

  private generate(): StoredIdentity {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    return {
      version: 1,
      nodeId: deriveNodeId(publicKeyRaw),
      publicKeyRaw: publicKeyRaw.toString('base64'),
      privateKeyPem,
      displayName: defaultDisplayName(),
      createdAt: Date.now()
    }
  }

  private persist(id: StoredIdentity): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(id, null, 2), { mode: 0o600 })
      try {
        chmodSync(this.file, 0o600)
      } catch {
        /* Windows: Rechte werden nicht erzwungen */
      }
    } catch (err) {
      logger.error('identity', 'Identitaet konnte nicht gespeichert werden', { error: String(err) })
      throw err
    }
  }

  get material(): KeyMaterial {
    if (!this.cachedMaterial) {
      const id = this.load()
      const priv = createPrivateKey(id.privateKeyPem)
      const pub = createPublicKey(priv)
      this.cachedMaterial = {
        publicKeyRaw: Buffer.from(id.publicKeyRaw, 'base64'),
        privateKeyPem: id.privateKeyPem,
        publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString()
      }
    }
    return this.cachedMaterial
  }

  get nodeId(): string {
    return this.load().nodeId
  }

  get publicKeyBase64(): string {
    return this.load().publicKeyRaw
  }

  get displayName(): string {
    return this.load().displayName
  }

  setDisplayName(name: string): void {
    const id = this.load()
    id.displayName = name.slice(0, 48) || defaultDisplayName()
    this.persist(id)
  }

  identity(): NodeIdentity {
    const id = this.load()
    return {
      nodeId: id.nodeId,
      publicKey: id.publicKeyRaw,
      displayName: id.displayName,
      createdAt: id.createdAt
    }
  }

  /** Signiert beliebige Bytes. */
  sign(data: Buffer | string): string {
    const priv = createPrivateKey(this.material.privateKeyPem)
    return sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), priv).toString('base64')
  }

  /** Prueft eine Signatur gegen einen Public Key (base64, roh). */
  static verifyWith(publicKeyBase64: string, data: Buffer | string, signatureBase64: string): boolean {
    try {
      const raw = Buffer.from(publicKeyBase64, 'base64')
      // Rohes 32-Byte-Key in ein DER-SPKI-Framework einbetten.
      const der = Buffer.concat([
        Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
        raw
      ])
      const pub = createPublicKey({ key: der, format: 'der', type: 'spki' })
      return verify(
        null,
        Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'),
        pub,
        Buffer.from(signatureBase64, 'base64')
      )
    } catch {
      return false
    }
  }

  verify(data: Buffer | string, signatureBase64: string): boolean {
    return IdentityStore.verifyWith(this.publicKeyBase64, data, signatureBase64)
  }
}

function defaultDisplayName(): string {
  return hostname().slice(0, 32) || 'player'
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx <= 0 ? '.' : p.slice(0, idx)
}

export const identityStore = new IdentityStore()

/**
 * Extrahiert den 32-Byte-Ed25519-Seed aus einem PKCS#8-PEM.
 *
 * Wird verwendet, um libp2p denselben Schluessel verwenden zu lassen. Dadurch
 * ist die libp2p-Peer-ID deterministisch aus unserer Anwendungs-Identitaet
 * abgeleitet - es ist keine zusaetzliche Zuordnungstabelle noetig.
 */
export function ed25519SeedFromPem(pem: string): Buffer {
  const key = createPrivateKey(pem)
  const der = key.export({ type: 'pkcs8', format: 'der' })
  if (der.length < 32) throw new Error('PKCS#8-Daten zu kurz fuer einen Ed25519-Seed')
  return der.subarray(der.length - 32)
}

/**
 * Erzeugt einen neuen Ed25519-Schluessel als PKCS#8-PEM.
 *
 * Wird fuer die Identitaet des eingebauten Hubs genutzt: Der Hub braucht
 * eine eigene, ueber Anwendungsneustarts bestehende Peer-ID (die nicht mit
 * der Peer-ID der Anwendung zusammenfallen darf).
 */
export function generateEd25519Pem(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}
