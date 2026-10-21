/**
 * Minimaler NBT-Leser.
 *
 * Wird benoetigt, um aus `level.dat` die Minecraft-DataVersion auszulesen.
 * Nur lesende Operationen, keine Referenz auf fremde Dateien.
 *
 * NBT-Tag-Typen:
 *  0 End, 1 Byte, 2 Short, 3 Int, 4 Long, 5 Float, 6 Double,
 *  7 ByteArray, 8 String, 9 List, 10 Compound, 11 IntArray, 12 LongArray
 */

export const TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12
} as const

export type NbtValue =
  | number
  | string
  | boolean
  | bigint
  | Uint8Array
  | number[]
  | bigint[]
  | NbtValue[]
  | { [key: string]: NbtValue }

export class NbtError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NbtError'
  }
}

class Reader {
  private offset = 0
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset
  }

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new NbtError('NBT-Daten unvollständig')
    }
  }

  readUByte(): number {
    this.need(1)
    return this.buf.readUInt8(this.offset++)
  }

  readByte(): number {
    this.need(1)
    return this.buf.readInt8(this.offset++)
  }

  readShort(): number {
    this.need(2)
    const v = this.buf.readInt16BE(this.offset)
    this.offset += 2
    return v
  }

  readInt(): number {
    this.need(4)
    const v = this.buf.readInt32BE(this.offset)
    this.offset += 4
    return v
  }

  readLong(): bigint {
    this.need(8)
    const v = this.buf.readBigInt64BE(this.offset)
    this.offset += 8
    return v
  }

  readFloat(): number {
    this.need(4)
    const v = this.buf.readFloatBE(this.offset)
    this.offset += 4
    return v
  }

  readDouble(): number {
    this.need(8)
    const v = this.buf.readDoubleBE(this.offset)
    this.offset += 8
    return v
  }

  readString(): string {
    const len = this.readShort()
    if (len < 0) throw new NbtError('Negative Stringlänge')
    this.need(len)
    const s = this.buf.toString('utf8', this.offset, this.offset + len)
    this.offset += len
    return s
  }

  readBytes(n: number): Buffer {
    this.need(n)
    const b = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return b
  }
}

/** Liest einen NBT-Baum aus einem Buffer (Root muss ein Compound sein). */
export function parseNbt(buf: Buffer): { [key: string]: NbtValue } {
  const r = new Reader(buf)
  const type = r.readUByte()
  if (type === TAG.END) return {}
  if (type !== TAG.COMPOUND) {
    throw new NbtError(`Unerwarteter Root-Tag ${type} (Compound erwartet)`)
  }
  r.readString() // Root-Name (meist leer)
  return readCompoundPayload(r)
}

function readCompoundPayload(r: Reader): { [key: string]: NbtValue } {
  const out: { [key: string]: NbtValue } = {}
  for (;;) {
    const type = r.readUByte()
    if (type === TAG.END) break
    const name = r.readString()
    out[name] = readPayload(r, type)
  }
  return out
}

function readPayload(r: Reader, type: number): NbtValue {
  switch (type) {
    case TAG.BYTE:
      return r.readByte()
    case TAG.SHORT:
      return r.readShort()
    case TAG.INT:
      return r.readInt()
    case TAG.LONG:
      return r.readLong()
    case TAG.FLOAT:
      return r.readFloat()
    case TAG.DOUBLE:
      return r.readDouble()
    case TAG.BYTE_ARRAY: {
      const len = r.readInt()
      if (len < 0) throw new NbtError('Negative ByteArray-Länge')
      return new Uint8Array(r.readBytes(len))
    }
    case TAG.STRING:
      return r.readString()
    case TAG.LIST: {
      const itemType = r.readUByte()
      const len = r.readInt()
      if (len < 0) throw new NbtError('Negative Listenlänge')
      const list: NbtValue[] = []
      for (let i = 0; i < len; i++) list.push(readPayload(r, itemType))
      return list
    }
    case TAG.COMPOUND:
      return readCompoundPayload(r)
    case TAG.INT_ARRAY: {
      const len = r.readInt()
      if (len < 0) throw new NbtError('Negative IntArray-Länge')
      const arr: number[] = []
      for (let i = 0; i < len; i++) arr.push(r.readInt())
      return arr
    }
    case TAG.LONG_ARRAY: {
      const len = r.readInt()
      if (len < 0) throw new NbtError('Negative LongArray-Länge')
      const arr: bigint[] = []
      for (let i = 0; i < len; i++) arr.push(r.readLong())
      return arr
    }
    default:
      throw new NbtError(`Unbekannter NBT-Tag ${type}`)
  }
}

/** Liest einen verschachtelten Wert aus einem NBT-Baum. */
export function nbtGet(tree: { [key: string]: NbtValue }, path: string[]): NbtValue | undefined {
  let current: NbtValue | undefined = tree
  for (const key of path) {
    if (current === undefined || typeof current !== 'object' || Array.isArray(current)) return undefined
    if (current instanceof Uint8Array) return undefined
    current = current[key]
  }
  return current
}
