/**
 * Erzeugt mit dem echten Minecraft-Server eine Welt und analysiert die
 * Struktur von level.dat. Dient dazu, den NBT-Leser zu verifizieren.
 *
 * Aufruf: npx tsx scripts/inspect-leveldat.ts
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { parseNbt, nbtGet } from '../src/main/minecraft/nbt'

const dir = mkdtempSync(join(tmpdir(), 'mmh-leveldat-'))
const jar = process.argv[2]

async function main(): Promise<void> {
  if (!jar || !existsSync(jar)) {
    console.error('Pfad zur Paper-JAR angeben: npx tsx scripts/inspect-leveldat.ts <pfad>')
    process.exit(1)
  }

  const child = spawn(
    'java',
    ['-Xms512M', '-Xmx1024M', '-jar', jar, 'nogui'],
    { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8')
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let output = ''
  const onData = (d: string): void => {
    output += d
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (/Done \([\d.,]+s\)!/.test(output)) {
        clearInterval(timer)
        resolve()
      }
    }, 500)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 180_000)
  })

  child.stdin.write('stop\n')
  await new Promise((r) => setTimeout(r, 6000))
  if (!child.killed) child.kill()

  const levelDat = join(dir, 'world', 'level.dat')
  if (!existsSync(levelDat)) {
    console.error('level.dat wurde nicht erzeugt')
    console.log(output.split('\n').slice(-30).join('\n'))
    process.exit(1)
  }

  const raw = readFileSync(levelDat)
  const nbt = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
  const tree = parseNbt(nbt)

  console.log('Root-Schlüssel:', Object.keys(tree).sort().join(', '))
  console.log('Root/DataVersion    :', nbtGet(tree, ['DataVersion']))
  console.log('Root/Data/DataVersion:', nbtGet(tree, ['Data', 'DataVersion']))
  console.log('Root/LevelName     :', nbtGet(tree, ['LevelName']))
  console.log('Root/version/Name  :', nbtGet(tree, ['version', 'Name']))
  console.log('Root/version/Id    :', nbtGet(tree, ['version', 'Id']))
  console.log('Root/Data/LevelName:', nbtGet(tree, ['Data', 'LevelName']))

  console.log(`\nTestverzeichnis: ${dir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
