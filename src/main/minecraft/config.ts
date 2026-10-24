import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Erzeugung der Minecraft-Serverkonfiguration.
 *
 * Grundsatz: Jede Konfiguration wird explizit geschrieben. Es werden keine
 * Dateien aus fremden Quellen ungeprueft uebernommen.
 */

export interface ServerConfigOptions {
  /** Port des Minecraft-Servers. */
  port: number
  /** Name des Weltverzeichnisses unterhalb des Serverordners. */
  levelName: string
  /** Maximale Spielerzahl. */
  maxPlayers: number
  /** MOTD. */
  motd: string
  /** Whitelist aktiv? */
  whitelist: boolean
  /** Online-Mode (true = echte Microsoft-Accounts). */
  onlineMode: boolean
  /** Sichtweite in Chunks. */
  viewDistance: number
  /** Schwierigkeit. */
  difficulty: string
  /** Spielmodus. */
  gamemode: string
  /** Welttyp. */
  levelType: string
  /**
   * Optionaler Welt-Seed. Leere/fehlende Angabe = Minecraft erzeugt
   * einen Zufalls-Seed.
   */
  seed?: string
  /** Ob der Server sich selbst ueber IPv6 erreichbar machen soll. */
  enableStatus: boolean
}

export const DEFAULT_SERVER_CONFIG: ServerConfigOptions = {
  port: 25565,
  levelName: 'world',
  maxPlayers: 20,
  motd: 'Multi-Mine Host',
  whitelist: false,
  onlineMode: true,
  viewDistance: 8,
  difficulty: 'normal',
  gamemode: 'survival',
  levelType: 'minecraft\\:normal',
  enableStatus: true
}

function escapeProperties(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/=/g, '\\=')
}

/** Erzeugt den Inhalt von server.properties. */
export function renderServerProperties(opts: ServerConfigOptions): string {
  const lines: Array<[string, string]> = [
    ['server-port', String(opts.port)],
    ['level-name', opts.levelName],
    ['level-seed', opts.seed ? escapeProperties(String(opts.seed)) : ''],
    ['level-type', opts.levelType],
    ['gamemode', opts.gamemode],
    ['difficulty', opts.difficulty],
    ['max-players', String(opts.maxPlayers)],
    ['motd', escapeProperties(opts.motd)],
    ['online-mode', String(opts.onlineMode)],
    ['white-list', String(opts.whitelist)],
    ['enforce-whitelist', String(opts.whitelist)],
    ['spawn-protection', '16'],
    ['view-distance', String(opts.viewDistance)],
    ['simulation-distance', String(Math.min(opts.viewDistance, 10))],
    ['enable-status', String(opts.enableStatus)],
    ['allow-flight', 'false'],
    ['allow-nether', 'true'],
    ['enable-command-block', 'false'],
    ['sync-chunk-writes', 'true'],
    ['network-compression-threshold', '256'],
    ['player-idle-timeout', '0'],
    ['prevent-proxy-connections', 'false'],
    ['use-native-transport', 'true'],
    ['enforce-secure-profile', 'false'],
    ['rcon.port', '0'],
    ['rcon.password', ''],
    ['enable-rcon', 'false'],
    ['broadcast-console-to-ops', 'true'],
    ['max-tick-time', '60000'],
    ['rate-limit', '0'],
    ['resource-pack', ''],
    ['require-resource-pack', 'false'],
    ['pvp', 'true'],
    ['entity-broadcast-range-percentage', '100'],
    ['hide-online-players', 'false']
  ]
  return lines.map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

/** Aktualisiert einzelne Properties in einer bestehenden server.properties. */
export function updateServerProperties(
  content: string,
  updates: Record<string, string | number | boolean>
): string {
  const lines = content.split(/\r?\n/)
  const seen = new Set<string>()
  const out = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return line
    const key = trimmed.slice(0, eq)
    if (!(key in updates)) return line
    seen.add(key)
    const value = updates[key]
    return `${key}=${typeof value === 'boolean' ? value : escapeProperties(String(value))}`
  })
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue
    out.push(`${key}=${typeof value === 'boolean' ? value : escapeProperties(String(value))}`)
  }
  return out.join('\n')
}

export interface ServerDirOptions {
  config: ServerConfigOptions
  /** Bedienernamen, die Operator werden sollen. */
  ops: string[]
  /** Erlaubte Spieler (nur bei aktiver Whitelist). */
  whitelist: string[]
}

/** Legt die Grundausstattung eines Serververzeichnisses an. */
export function ensureServerDir(dir: string, opts: ServerDirOptions): void {
  mkdirSync(dir, { recursive: true })

  const eulaPath = join(dir, 'eula.txt')
  if (!existsSync(eulaPath)) {
    writeFileSync(
      eulaPath,
      '# Mit dieser Datei stimmst du der Mojang-EULA (https://aka.ms/MinecraftEULA) zu.\n' +
        '# Wird automatisch gesetzt, da Multi-Mine Host die Software\n' +
        '# automatisch installiert und betreibt.\n' +
        'eula=true\n',
      'utf8'
    )
  }

  const propsPath = join(dir, 'server.properties')
  const props = renderServerProperties(opts.config)
  if (!existsSync(propsPath)) {
    writeFileSync(propsPath, props, 'utf8')
  } else {
    const current = readFileSync(propsPath, 'utf8')
    writeFileSync(propsPath, updateServerProperties(current, { 'server-port': opts.config.port }), 'utf8')
  }

  const opsPath = join(dir, 'ops.json')
  if (!existsSync(opsPath)) {
    writeFileSync(opsPath, JSON.stringify(opsToJson(opts.ops), null, 2), 'utf8')
  }

  const wlPath = join(dir, 'whitelist.json')
  if (!existsSync(wlPath)) {
    writeFileSync(wlPath, JSON.stringify(whitelistToJson(opts.whitelist), null, 2), 'utf8')
  }
}

interface OpJson {
  uuid: string
  name: string
  level: number
  bypassesPlayerLimit: boolean
}

interface WhitelistJson {
  uuid: string
  name: string
}

/**
 * Erzeugt UUIDs aus Spielernamen (Version-3-UUID, wie es Minecraft fuer
 * "offline mode" verwendet). Wird nur fuer die Datei ops.json verwendet.
 */
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest()
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x30
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function opsToJson(names: string[]): OpJson[] {
  return names.map((name) => ({
    uuid: offlineUuid(name),
    name,
    level: 4,
    bypassesPlayerLimit: false
  }))
}

export function whitelistToJson(names: string[]): WhitelistJson[] {
  return names.map((name) => ({
    uuid: offlineUuid(name),
    name
  }))
}

/** Liest die Operatornamen aus ops.json. */
export function readOps(dir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'ops.json'), 'utf8')) as OpJson[]
    return raw.map((o) => o.name)
  } catch {
    return []
  }
}

/** Schreibt die Operatorliste. */
export function writeOps(dir: string, names: string[]): void {
  writeFileSync(join(dir, 'ops.json'), JSON.stringify(opsToJson(names), null, 2), 'utf8')
}

/** Liest die Whitelist. */
export function readWhitelist(dir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'whitelist.json'), 'utf8')) as WhitelistJson[]
    return raw.map((w) => w.name)
  } catch {
    return []
  }
}

/** Schreibt die Whitelist. */
export function writeWhitelist(dir: string, names: string[]): void {
  writeFileSync(join(dir, 'whitelist.json'), JSON.stringify(whitelistToJson(names), null, 2), 'utf8')
}
