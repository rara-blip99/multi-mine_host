import { describe, expect, it } from 'vitest'
import {
  checkInvite,
  formatInviteCode,
  generateInviteSecret,
  hashInviteCode,
  parseInviteCode,
  safeCompareHex
} from '../src/main/security/invites'

describe('Einladungscodes', () => {
  it('erzeugt gut lesbare Codes', () => {
    const secret = generateInviteSecret()
    expect(secret).toHaveLength(12)
    expect(secret).toMatch(/^[0-9A-Z]+$/)
    const formatted = formatInviteCode(secret)
    expect(formatted).toMatch(/^MMH-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it('erzeugt unterschiedliche Codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateInviteSecret()))
    expect(codes.size).toBeGreaterThan(190)
  })

  it('parst formatierte und unformatierte Codes gleich', () => {
    const secret = generateInviteSecret()
    expect(parseInviteCode(formatInviteCode(secret))).toBe(secret)
    expect(parseInviteCode(secret)).toBe(secret)
    expect(parseInviteCode('MMH-ABCD-EFGH-IJKL')).toBe('ABCDEFGHIJKL')
    expect(parseInviteCode('ungültig')).toBeNull()
  })

  it('erlaubt keine mehrdeutigen Zeichen', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteSecret()).not.toMatch(/[ILOU]/)
    }
  })

  it('speichert nur den Hash des Codes', () => {
    const secret = generateInviteSecret()
    const hash = hashInviteCode(formatInviteCode(secret))
    expect(hash).toHaveLength(64)
    expect(hash).not.toContain(secret)
    expect(hashInviteCode(formatInviteCode(secret))).toBe(hash)
  })

  it('akzeptiert einen gültigen Code', () => {
    const secret = generateInviteSecret()
    const code = formatInviteCode(secret)
    const result = checkInvite(code, hashInviteCode(code), {
      maxUses: 0,
      expiresAt: null,
      revoked: false,
      uses: 0
    })
    expect(result.valid).toBe(true)
  })

  it('lehnt einen falschen Code ab', () => {
    const secret = generateInviteSecret()
    const other = formatInviteCode(generateInviteSecret())
    const result = checkInvite(other, hashInviteCode(secret), {
      maxUses: 0,
      expiresAt: null,
      revoked: false,
      uses: 0
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('stimmt nicht')
  })

  it('lehnt abgelaufene Einladungen ab', () => {
    const secret = generateInviteSecret()
    const code = formatInviteCode(secret)
    const result = checkInvite(
      code,
      hashInviteCode(code),
      { maxUses: 0, expiresAt: Date.now() - 1000, revoked: false, uses: 0 },
      Date.now()
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('abgelaufen')
  })

  it('begrenzt die Anzahl der Nutzungen', () => {
    const secret = generateInviteSecret()
    const code = formatInviteCode(secret)
    const result = checkInvite(code, hashInviteCode(code), {
      maxUses: 1,
      expiresAt: null,
      revoked: false,
      uses: 1
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('zu oft')
  })

  it('kann widerrufen werden', () => {
    const secret = generateInviteSecret()
    const code = formatInviteCode(secret)
    const result = checkInvite(code, hashInviteCode(code), {
      maxUses: 0,
      expiresAt: null,
      revoked: true,
      uses: 0
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('widerrufen')
  })

  it('vergleicht Hashes zeitkonstant', () => {
    const a = 'a'.repeat(64)
    const b = 'a'.repeat(64)
    expect(safeCompareHex(a, b)).toBe(true)
    expect(safeCompareHex(a, 'b'.repeat(64))).toBe(false)
    expect(safeCompareHex(a, 'kurz')).toBe(false)
  })
})
