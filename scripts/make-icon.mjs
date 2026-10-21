/**
 * Erzeugt das Anwendungs-Icon (resources/icon.png).
 *
 * Wird beim Build ausgefuehrt, damit das Repository keine binaeren
 * Bilddateien enthalten muss. Aufruf: node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const size = 256

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/** Zeichnet das Logo: abgerundetes Quadrat mit Verlauf und stilisiertem "M". */
function pixel(x, y) {
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.22
  // Abgerundete Ecken
  const dx = Math.max(Math.abs(x - cx) - (size / 2 - r), 0)
  const dy = Math.max(Math.abs(y - cy) - (size / 2 - r), 0)
  if (Math.sqrt(dx * dx + dy * dy) > r) return [0, 0, 0, 0]

  // Verlauf von Mintgruen nach Cyan
  const t = (x + y) / (2 * size)
  const base = [
    Math.round(56 + (76 - 56) * t),
    Math.round(232 + (201 - 232) * t),
    Math.round(176 + (240 - 176) * t)
  ]

  // Buchstabe "M" als Blockglyphe
  const mx = x - size * 0.28
  const my = y - size * 0.3
  const mw = size * 0.56
  const mh = size * 0.6
  const stroke = size * 0.1
  if (mx >= 0 && mx <= mw && my >= 0 && my <= mh) {
    const inStroke =
      (mx < stroke && my < mh) ||
      (mx > mw - stroke && my < mh) ||
      (my > mh - stroke && mx >= stroke && mx <= mw - stroke) ||
      // Diagonalen
      (Math.abs(mx - my * 0.9) < stroke * 0.8 && mx < mw / 2) ||
      (Math.abs(mw - mx - my * 0.9) < stroke * 0.8 && mx > mw / 2)
    if (inStroke) return [4, 18, 26, 255]
  }
  return [base[0], base[1], base[2], 255]
}

const raw = Buffer.alloc((size * 4 + 1) * size)
let o = 0
for (let y = 0; y < size; y++) {
  raw[o++] = 0 // Filter: none
  for (let x = 0; x < size; x++) {
    const [r, g, b, a] = pixel(x, y)
    raw[o++] = r
    raw[o++] = g
    raw[o++] = b
    raw[o++] = a
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(size, 0)
ihdr.writeUInt32BE(size, 4)
ihdr[8] = 8 // Bit-Tiefe
ihdr[9] = 6 // Farbtyp RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const target = resolve(here, '..', 'resources', 'icon.png')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, png)
console.log(`Icon geschrieben: ${target} (${png.length} Bytes)`)
