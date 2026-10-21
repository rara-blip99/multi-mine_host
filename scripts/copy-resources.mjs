/**
 * Kopiert die statischen Ressourcen (Icon) nach `out/`, damit sie sowohl im
 * Entwicklungs-Build als auch im Installer vorhanden sind.
 *
 * Aufruf: node scripts/copy-resources.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '..', 'resources')
const target = resolve(here, '..', 'out', 'resources')

if (!existsSync(source)) {
  console.log('Keine Ressourcen vorhanden - nichts zu kopieren.')
  process.exit(0)
}

mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

let count = 0
let bytes = 0
for (const entry of readdirSync(target)) {
  const st = statSync(join(target, entry))
  if (st.isFile()) {
    count += 1
    bytes += st.size
  }
}
console.log(`Ressourcen kopiert: ${count} Datei(en), ${bytes} Bytes -> ${target}`)
