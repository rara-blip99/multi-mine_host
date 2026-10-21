/**
 * Diagnose des Server-List-Pings: verbindet sich und zeigt die rohe Antwort.
 * Aufruf: npx tsx scripts/debug-slp.ts [port]
 */
import { createConnection } from 'node:net'

const port = Number(process.argv[2] ?? 25565)

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

function writeString(value: string): Buffer {
  const data = Buffer.from(value, 'utf8')
  return Buffer.concat([writeVarInt(data.length), data])
}

const socket = createConnection({ host: '127.0.0.1', port })
let buffer = Buffer.alloc(0)

socket.on('connect', () => {
  console.log('verbunden')
  const handshake = Buffer.concat([
    writeVarInt(0),
    writeVarInt(765),
    writeString('127.0.0.1'),
    (() => {
      const b = Buffer.alloc(2)
      b.writeUInt16BE(port)
      return b
    })(),
    writeVarInt(1)
  ])
  socket.write(Buffer.concat([writeVarInt(handshake.length), handshake]))
  socket.write(Buffer.concat([writeVarInt(1), writeVarInt(0)]))
})

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  console.log('empfangen:', chunk.toString('hex'))
  console.log('als Text:', chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'))
  socket.end()
})

socket.on('error', (err) => console.log('Fehler:', err.message))
socket.on('close', () => {
  console.log('geschlossen, insgesamt', buffer.length, 'Bytes')
  process.exit(0)
})
