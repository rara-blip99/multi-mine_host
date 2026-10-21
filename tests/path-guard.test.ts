import { describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PathGuardError,
  assertRealPathWithin,
  isWithin,
  normalizeRelative,
  resolveWithin
} from '../src/main/security/path-guard'

/**
 * Sicherheitstests: Path Traversal und manipulierte Archivpfade.
 */
describe('Pfadschutz', () => {
  it('normalisiert gültige relative Pfade', () => {
    expect(normalizeRelative('region/r.0.0.mca')).toBe('region/r.0.0.mca')
    expect(normalizeRelative('data\\foo\\bar.dat')).toBe('data/foo/bar.dat')
    expect(normalizeRelative('./level.dat')).toBe('level.dat')
  })

  it('lehnt absolute Pfade ab', () => {
    expect(() => normalizeRelative('/etc/passwd')).toThrow(PathGuardError)
    expect(() => normalizeRelative('C:\\Windows\\System32\\config')).toThrow(PathGuardError)
    expect(() => normalizeRelative('\\\\server\\share')).toThrow(PathGuardError)
  })

  it('lehnt Traversal-Segmente ab', () => {
    expect(() => normalizeRelative('../../../etc/passwd')).toThrow(/Verbotenes Pfadsegment/)
    expect(() => normalizeRelative('region/../../outside')).toThrow(/Verbotenes Pfadsegment/)
    expect(() => normalizeRelative('a/./b')).toThrow(/Verbotenes Pfadsegment/)
  })

  it('lehnt Nullbytes ab', () => {
    expect(() => normalizeRelative('level.dat\0.png')).toThrow(/Nullbyte/)
  })

  it('lehnt reservierte Windows-Namen ab', () => {
    expect(() => normalizeRelative('CON')).toThrow(/Reservierter/)
    expect(() => normalizeRelative('data/nul.txt')).toThrow(/Reservierter/)
    expect(() => normalizeRelative('PRN')).toThrow(/Reservierter/)
  })

  it('lehnt Doppelpunkte in Segmenten ab', () => {
    expect(() => normalizeRelative('data/file:stream')).toThrow(/Doppelpunkt/)
  })

  it('lehnt leere und zu lange Pfade ab', () => {
    expect(() => normalizeRelative('')).toThrow(PathGuardError)
    expect(() => normalizeRelative('a'.repeat(2000))).toThrow(/zu lang/)
  })

  it('löst Pfade innerhalb des Basisverzeichnisses auf', () => {
    const base = tmpdir()
    const resolved = resolveWithin(base, 'region/r.0.0.mca')
    expect(resolved.startsWith(base)).toBe(true)
    expect(resolved.endsWith('region\\r.0.0.mca')).toBe(true)
  })

  it('verhindert, dass ein aufgelöster Pfad das Basisverzeichnis verlässt', () => {
    const base = tmpdir()
    expect(() => resolveWithin(base, '../secrets')).toThrow(PathGuardError)
    expect(() => resolveWithin(base, 'a/../../b')).toThrow(PathGuardError)
  })

  it('erkennt Symlinks, die aus dem Basisverzeichnis herausführen', () => {
    const root = join(tmpdir(), `mmh-pg-${Date.now()}`)
    const base = join(root, 'base')
    const outside = join(root, 'outside')
    mkdirSync(base, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'geheim')

    try {
      symlinkSync(outside, join(base, 'link'), 'junction')
    } catch {
      // Symlinks sind nicht erlaubt -> Test überspringen
      return
    }

    expect(() => assertRealPathWithin(base, join(base, 'link', 'secret.txt'))).toThrow(
      /ausserhalb/
    )
  })

  it('prüft die Zugehörigkeit zu einem Verzeichnis', () => {
    const base = tmpdir()
    expect(isWithin(base, join(base, 'a', 'b'))).toBe(true)
    expect(isWithin(base, join(base, '..', 'x'))).toBe(false)
  })
})
