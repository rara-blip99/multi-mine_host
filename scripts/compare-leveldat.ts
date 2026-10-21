/**
 * Vergleicht eine erzeugte level.dat byteweise mit einer echten, um
 * Unterschiede im NBT-Aufbau zu finden.
 *
 * Aufruf: npx tsx scripts/compare-leveldat.ts <echte level.dat> <synthetische level.dat>
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

function dump(label: string, path: string): void {
  const raw = readFileSync(path)
  const data = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
  console.log(`\n=== ${label} (${data.length} Bytes entpackt) ===`)
  console.log(data.subarray(0, 96).toString('hex').replace(/(..)/g, '$1 '))
  console.log(
    data
      .subarray(0, 96)
      .toString('latin1')
      .replace(/[^\x20-\x7e]/g, '.')
  )
}

const [, , real, synth] = process.argv
if (real && synth) {
  dump('ECHTE level.dat', real)
  dump('SYNTHETISCHE level.dat', synth)
} else {
  console.log('Aufruf: npx tsx scripts/compare-leveldat.ts <echte> <synthetische>')
}
