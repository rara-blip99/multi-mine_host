import { describe, expect, it } from 'vitest'
import { checkCompatibility, dataVersionFor, mcVersionForDataVersion } from '../src/main/minecraft/versions'
import { parseNbt, nbtGet } from '../src/main/minecraft/nbt'
import { gunzipSync, gzipSync } from 'node:zlib'

describe('Minecraft-Versionen', () => {
  it('ordnet DataVersion und Versionen zu', () => {
    expect(dataVersionFor('1.20.4')).toBe(3700)
    expect(mcVersionForDataVersion(3700)).toBe('1.20.4')
    expect(mcVersionForDataVersion(3698)).toBe('1.20.3')
    expect(mcVersionForDataVersion(3578)).toBe('1.20.2')
    // Eine unbekannte (neuerere) DataVersion entspricht der neuesten
    // bekannten Version - die Kompatibilitaetspruefung verhindert dann den Start.
    expect(mcVersionForDataVersion(999999)).toBe('1.21.4')
    expect(mcVersionForDataVersion(1)).toBeNull()
  })

  it('akzeptiert eine exakt passende Welt', () => {
    const result = checkCompatibility(3700, '1.20.4')
    expect(result.compatible).toBe(true)
    expect(result.requiresUpgrade).toBe(false)
  })

  it('akzeptiert eine ältere Welt mit Upgrade-Hinweis', () => {
    const result = checkCompatibility(3578, '1.20.4')
    expect(result.compatible).toBe(true)
    expect(result.requiresUpgrade).toBe(true)
    expect(result.reason).toContain('upgradet')
  })

  it('verhindert den Start einer neueren Welt (Downgrade-Gefahr)', () => {
    const result = checkCompatibility(4325, '1.20.4')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('neueren Minecraft-Version')
  })

  it('lehnt unbekannte Server-Versionen ab', () => {
    const result = checkCompatibility(3700, '1.5.2')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('nicht unterstützt')
  })
})

/** Baut ein minimales level.dat (NBT) für Tests. */
function buildLevelDat(dataVersion: number, levelName = 'Testwelt'): Buffer {
  // TAG_Compound "": { Data: { DataVersion: int, LevelName: string } }
  const parts: Buffer[] = []
  const writeString = (s: string): Buffer => {
    const data = Buffer.from(s, 'utf8')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(data.length)
    return Buffer.concat([len, data])
  }
  // Root
  parts.push(Buffer.from([0x0a]))
  parts.push(writeString(''))
  // "Data"
  parts.push(Buffer.from([0x0a]))
  parts.push(writeString('Data'))
  // DataVersion (int)
  parts.push(Buffer.from([0x03]))
  parts.push(writeString('DataVersion'))
  const dv = Buffer.alloc(4)
  dv.writeInt32BE(dataVersion)
  parts.push(dv)
  // LevelName (string)
  parts.push(Buffer.from([0x08]))
  parts.push(writeString('LevelName'))
  parts.push(writeString(levelName))
  // Ende des Compounds
  parts.push(Buffer.from([0x00]))
  parts.push(Buffer.from([0x00]))
  return Buffer.concat(parts)
}

describe('NBT-Leser', () => {
  it('liest die DataVersion aus level.dat', () => {
    const tree = parseNbt(buildLevelDat(3700, 'Meine Welt'))
    const data = nbtGet(tree, ['Data'])
    expect(data).toBeDefined()
    expect(nbtGet(tree, ['Data', 'DataVersion'])).toBe(3700)
    expect(nbtGet(tree, ['Data', 'LevelName'])).toBe('Meine Welt')
  })

  it('liest gzip-komprimierte Daten', () => {
    const raw = buildLevelDat(3578)
    const compressed = gzipSync(raw)
    expect(compressed[0]).toBe(0x1f)
    const tree = parseNbt(gunzipSync(compressed))
    expect(nbtGet(tree, ['Data', 'DataVersion'])).toBe(3578)
  })

  it('lehnt beschädigte Daten ab', () => {
    expect(() => parseNbt(Buffer.from([0x0a, 0x00, 0x00]))).toThrow()
    expect(() => parseNbt(Buffer.from([0x01, 0x00]))).toThrow(/Compound/)
  })

  it('gibt unbekannte Pfade als undefined zurück', () => {
    const tree = parseNbt(buildLevelDat(3700))
    expect(nbtGet(tree, ['Data', 'GibtEsNicht'])).toBeUndefined()
    expect(nbtGet(tree, ['GibtEsNicht', 'DataVersion'])).toBeUndefined()
  })
})
