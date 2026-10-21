import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Gruppen-Einladungen.
 *
 * Einladungscode-Format:  `MMH-XXXX-XXXX-XXXX`
 * - Crockford-Base32 (ohne I, L, O, U), 12 Zeichen = 60 Bit Entropie
 * - Der Hub speichert ausschliesslich den SHA-256-Hash des Codes
 * - Ablaufzeit und maximale Nutzungszahl werden serverseitig erzwungen
 * - Widerruf ist jederzeit moeglich
 *
 * Der Code ist bewusst so gewaehlt, dass er am Telefon abgelesen werden kann
 * und trotzdem nicht durch blosses Raten erraten wird.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford Base32

export const INVITE_PREFIX = 'MMH'

export function generateInviteSecret(bytes = 8): string {
  const buf = randomBytes(bytes)
  let bits = 0
  let value = 0
  let out = ''
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.slice(0, 12).padEnd(12, '0')
}

/** Formatierter Code: MMH-XXXX-XXXX-XXXX */
export function formatInviteCode(secret: string): string {
  const s = secret.toUpperCase().replace(/[^0-9A-Z]/g, '')
  return `${INVITE_PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`
}

/** Parst einen Code und liefert das Secret (ohne Formatierung). */
export function parseInviteCode(code: string): string | null {
  if (typeof code !== 'string') return null
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(new RegExp(`^${INVITE_PREFIX}`), '')
  if (cleaned.length !== 12) return null
  return cleaned
}

/** Normalisierter SHA-256-Hash eines Einladungscodes (Hex). */
export function hashInviteCode(code: string): string {
  const secret = parseInviteCode(code)
  if (!secret) return ''
  return createHash('sha256').update(`multimine-invite:${secret}`).digest('hex')
}

/** Zeitkonstanter Vergleich zweier Hex-Hashes. */
export function safeCompareHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export interface InvitePolicy {
  /** Maximale Nutzungen (0 = unbegrenzt). */
  maxUses: number
  /** Gueltig bis Zeitstempel (null = unbegrenzt). */
  expiresAt: number | null
  revoked: boolean
  uses: number
}

export interface InviteCheckResult {
  valid: boolean
  reason: string
}

/**
 * Prueft einen Einladungscode gegen die serverseitig gespeicherte Richtlinie.
 * Der Hash-Vergleich erfolgt zeitkonstant.
 */
export function checkInvite(
  code: string,
  storedHash: string | undefined,
  policy: InvitePolicy | undefined,
  now = Date.now()
): InviteCheckResult {
  if (!storedHash || !policy) return { valid: false, reason: 'Einladung existiert nicht' }
  const hash = hashInviteCode(code)
  if (!hash) return { valid: false, reason: 'Einladungscode hat ein ungueltiges Format' }
  if (!safeCompareHex(hash, storedHash)) return { valid: false, reason: 'Einladungscode stimmt nicht' }
  if (policy.revoked) return { valid: false, reason: 'Einladung wurde widerrufen' }
  if (policy.expiresAt !== null && policy.expiresAt <= now) {
    return { valid: false, reason: 'Einladung ist abgelaufen' }
  }
  if (policy.maxUses > 0 && policy.uses >= policy.maxUses) {
    return { valid: false, reason: 'Einladung wurde bereits zu oft verwendet' }
  }
  return { valid: true, reason: 'gueltig' }
}
