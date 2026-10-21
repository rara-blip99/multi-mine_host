import { createConnection } from 'node:net'

/**
 * Server-List-Ping (SLP) fuer Minecraft Java Edition.
 *
 * Wird verwendet, um die tatsaechliche Spielerzahl und den Status des
 * Servers abzufragen - unabhaengig vom Log-Output.
 *
 * Protokoll (Handshake -> Status Request -> Status Response):
 *   1. VarInt ProtocolVersion, String Adresse, unsigned short Port, VarInt NextState=1
 *   2. Packet: VarInt length + VarInt packetId(0)
 *   3. Antwort: VarInt length + VarInt packetId(0) + String (JSON)
 */

export interface ServerStatusPing {
  version: { name: string; protocol: number }
  players: { max: number; online: number }
  description: unknown
  favicon?: string
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let temp = v & 0b0111_1111
    v >>>= 7
    if (v !== 0) temp |= 0b1000_0000
    bytes.push(temp)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } {
  let numRead = 0
  let result = 0
  let read: number
  do {
    if (offset + numRead >= buf.length) throw new Error('VarInt unvollständig')
    read = buf[offset + numRead] as number
    result |= (read & 0b0111_1111) << (7 * numRead)
    numRead++
    if (numRead > 5) throw new Error('VarInt zu lang')
  } while ((read & 0b1000_0000) !== 0)
  return { value: result >>> 0, size: numRead }
}

function writeString(value: string): Buffer {
  const data = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(data.length), data])
}

/**
 * Fragt den Status eines Minecraft-Servers ab.
 */
export function probeServerStatus(
  host: string,
  port: number,
  timeoutMs = 3_000
): Promise<ServerStatusPing> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    let buffer = Buffer.alloc(0)
    let settled = false

    const timer = setTimeout(() => {
      finish(new Error('Timeout beim Server-List-Ping'))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
    }

    const finish = (err: Error | null, value?: ServerStatusPing): void => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(value as ServerStatusPing)
    }

    socket.on('error', (err) => finish(err))
    socket.on('close', () => finish(new Error('Verbindung vorzeitig geschlossen')))

    socket.on('connect', () => {
      try {
        const hostAndPort = writeVarInt(0) // ProtocolVersion (beliebig)
        const handshake = Buffer.concat([
          hostAndPort,
          writeString(host),
          (() => {
            const b = Buffer.alloc(2)
            b.writeUInt16BE(port)
            return b
          })(),
          writeVarInt(1) // NextState: Status
        ])
        const handshakePacket = Buffer.concat([writeVarInt(handshake.length), handshake])

        const statusPacket = Buffer.concat([writeVarInt(1), writeVarInt(0)]) // length=1, packetId=0

        socket.write(handshakePacket)
        socket.write(statusPacket)
      } catch (err) {
        finish(err as Error)
      }
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const len = readVarInt(buffer, 0)
        const total = len.size + len.value
        if (buffer.length < total) return
        const payload = buffer.subarray(len.size, total)
        const id = readVarInt(payload, 0)
        if (id.value !== 0) {
          finish(new Error('Unerwartete Paket-ID im Status-Response'))
          return
        }
        const strLen = readVarInt(payload, id.size)
        const json = payload
          .subarray(id.size + strLen.size, id.size + strLen.size + strLen.value)
          .toString('utf8')
        finish(null, JSON.parse(json) as ServerStatusPing)
      } catch (err) {
        finish(err as Error)
      }
    })
  })
}
