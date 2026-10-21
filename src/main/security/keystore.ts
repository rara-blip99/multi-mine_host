import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Paths } from '../core/paths'
import { logger } from '../core/logger'

/**
 * Verschluesselter Speicher fuer Geheimnisse (Hub-Token, Passwoerter).
 *
 * Primaer wird Electron `safeStorage` genutzt (Windows: DPAPI, gebunden an
 * den Benutzerkontext des OS). In reinen Node-Kontexten (Hub-Standalone,
 * Tests) wird auf ein lokales Schluesseldatei-Verfahren zurueckgefallen,
 * bei dem der Schluessel mit scrypt aus einer Zufallsdatei abgeleitet wird.
 *
 * In keinem Fall wird ein Geheimnis im Klartext auf die Platte geschrieben.
 */

interface KeystoreFile {
  version: 1
  /** Basis64 Salt. */
  salt: string
  /** Basis64 Nonce. */
  nonce: string
  /** Basis64 Chiffretext. */
  data: string
  /** true, wenn mit Electron safeStorage verschluesselt wurde. */
  osProtected: boolean
}

export class Keystore {
  private readonly file: string
  private readonly keyFile: string
  private cache: Record<string, string> | null = null

  constructor(file?: string, keyFile?: string) {
    this.file = file ?? join(Paths.keys(), 'secrets.json')
    this.keyFile = keyFile ?? join(Paths.keys(), 'secrets.key')
  }

  private osSafeStorage(): { isEncryptionAvailable: boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { safeStorage } = require('electron')
      if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'boolean') {
        return safeStorage
      }
    } catch {
      /* nicht im Electron-Kontext */
    }
    return null
  }

  private masterKey(): Buffer {
    const ss = this.osSafeStorage()
    if (ss?.isEncryptionAvailable) {
      // safeStorage schluesselt selbst; wir brauchen keinen lokalen Schluessel.
      return Buffer.from('os-protected', 'utf8')
    }
    if (!existsSync(this.keyFile)) {
      mkdirSync(dirname(this.keyFile), { recursive: true })
      writeFileSync(this.keyFile, randomBytes(32), { mode: 0o600 })
    }
    const salt = createHash('sha256').update('multimine-keystore-salt').digest()
    return scryptSync(readFileSync(this.keyFile), salt, 32)
  }

  private encrypt(plain: string): KeystoreFile {
    const ss = this.osSafeStorage()
    const nonce = randomBytes(12)
    if (ss?.isEncryptionAvailable) {
      const enc = ss.encryptString(plain)
      return {
        version: 1,
        salt: '',
        nonce: nonce.toString('base64'),
        data: enc.toString('base64'),
        osProtected: true
      }
    }
    const key = this.masterKey()
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      version: 1,
      salt: '',
      nonce: nonce.toString('base64'),
      data: Buffer.concat([ct, tag]).toString('base64'),
      osProtected: false
    }
  }

  private decrypt(file: KeystoreFile): string {
    const ss = this.osSafeStorage()
    if (file.osProtected) {
      if (!ss?.isEncryptionAvailable) {
        throw new Error('Betriebssystem-Schluessel nicht verfuegbar (Electron safeStorage)')
      }
      return ss.decryptString(Buffer.from(file.data, 'base64'))
    }
    const key = this.masterKey()
    const raw = Buffer.from(file.data, 'base64')
    const ct = raw.subarray(0, raw.length - 16)
    const tag = raw.subarray(raw.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.nonce, 'base64'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }

  private readFile(): Record<string, string> {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) {
      this.cache = {}
      return this.cache
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as KeystoreFile
      const plain = this.decrypt(raw)
      this.cache = JSON.parse(plain) as Record<string, string>
    } catch (err) {
      logger.error('keystore', 'Keystore konnte nicht gelesen werden', { error: String(err) })
      this.cache = {}
    }
    return this.cache
  }

  private writeFile(data: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const enc = this.encrypt(JSON.stringify(data))
    writeFileSync(this.file, JSON.stringify(enc, null, 2), { mode: 0o600 })
    this.cache = data
  }

  get(name: string): string | undefined {
    return this.readFile()[name]
  }

  set(name: string, value: string): void {
    const data = { ...this.readFile(), [name]: value }
    this.writeFile(data)
  }

  delete(name: string): void {
    const data = { ...this.readFile() }
    delete data[name]
    this.writeFile(data)
  }

  has(name: string): boolean {
    return this.readFile()[name] !== undefined
  }

  /** Erzeugt und speichert ein zufaelliges Token. */
  ensureToken(name: string, bytes = 32): string {
    const existing = this.get(name)
    if (existing) return existing
    const token = randomBytes(bytes).toString('base64url')
    this.set(name, token)
    return token
  }
}

export const keystore = new Keystore()
