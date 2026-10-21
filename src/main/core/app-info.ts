import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cjsRequire } from './cjs'

/**
 * Angaben ueber die laufende Anwendung.
 *
 * Funktioniert sowohl in Electron (dort liefert `app.getVersion()` die
 * Version aus dem Installer) als auch im Standalone-Hub und in Tests.
 */
export function appVersion(): string {
  try {
    const electron = cjsRequire('electron') as { app?: { getVersion(): string } }
    if (electron.app?.getVersion) {
      const version = electron.app.getVersion()
      if (version) return version
    }
  } catch {
    /* nicht im Electron-Kontext */
  }
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: string }).version
    if (version) return version
  } catch {
    /* ignore */
  }
  return '0.0.0'
}

/** Betriebssystem-Plattform fuer die Diagnose. */
export function platformInfo(): { platform: string; arch: string; nodeVersion: string } {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node
  }
}
