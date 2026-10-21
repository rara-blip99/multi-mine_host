/**
 * Minecraft-Versionen und DataVersion-Zuordnung.
 *
 * `DataVersion` ist die interne, monotone Nummer des Weltformats. Sie steht
 * in `level.dat` und ist das verlaesslichste Merkmal, um die Kompatibilitaet
 * einer Welt mit einer Server-Version zu pruefen.
 */

export interface McVersionInfo {
  /** Anzeigename, z.B. "1.20.4" */
  version: string
  /** Interne Weltformat-Version. */
  dataVersion: number
  /** Minecraft-Protokollnummer (fuer Server-List-Ping). */
  protocol: number
  /** Benötigte Java-Hauptversion. */
  javaMajor: number
  /** Verfügbar als Paper-Build. */
  paperAvailable: boolean
}

export const MC_VERSIONS: McVersionInfo[] = [
  { version: '1.20.2', dataVersion: 3578, protocol: 764, javaMajor: 17, paperAvailable: true },
  { version: '1.20.3', dataVersion: 3698, protocol: 765, javaMajor: 17, paperAvailable: true },
  { version: '1.20.4', dataVersion: 3700, protocol: 765, javaMajor: 17, paperAvailable: true },
  { version: '1.20.5', dataVersion: 3837, protocol: 766, javaMajor: 21, paperAvailable: true },
  { version: '1.20.6', dataVersion: 3839, protocol: 766, javaMajor: 21, paperAvailable: true },
  { version: '1.21', dataVersion: 3953, protocol: 767, javaMajor: 21, paperAvailable: true },
  { version: '1.21.1', dataVersion: 3955, protocol: 767, javaMajor: 21, paperAvailable: true },
  { version: '1.21.4', dataVersion: 4189, protocol: 769, javaMajor: 21, paperAvailable: true }
]

/** Die in der ersten Version unterstützte Kombination. */
export const DEFAULT_MC_VERSION = '1.20.4'

export function findVersion(version: string): McVersionInfo | undefined {
  return MC_VERSIONS.find((v) => v.version === version)
}

export function dataVersionFor(version: string): number | null {
  return findVersion(version)?.dataVersion ?? null
}

/**
 * Ermittelt die Minecraft-Version zu einer DataVersion.
 * Es wird die aelteste Version mit passender DataVersion gewaehlt, weil
 * Minecraft-Welten abwaerts-kompatibel gelesen werden koennen.
 */
export function mcVersionForDataVersion(dataVersion: number): string | null {
  const candidates = MC_VERSIONS.filter((v) => v.dataVersion <= dataVersion)
  if (candidates.length === 0) return null
  return candidates[candidates.length - 1]?.version ?? null
}

/**
 * Prueft, ob eine Welt mit der angegebenen Server-Version kompatibel ist.
 *
 * Regeln:
 *  - Gleiche DataVersion -> kompatibel.
 *  - Aeltere Welt (kleinere DataVersion) -> kompatibel, solange der Sprung
 *    nicht zu gross ist (Server koennen aeltere Welten oeffnen).
 *  - Neuere Welt (groessere DataVersion) -> NICHT kompatibel. Der Server
 *    wuerde die Welt upgraden und damit die Daten in einem Format speichern,
 *    das der alte Host nicht mehr lesen kann. Das wird verhindert.
 */
export interface CompatibilityResult {
  compatible: boolean
  reason: string
  worldVersion: string | null
  serverVersion: string
  worldDataVersion: number
  serverDataVersion: number
  /** true, wenn ein Upgrade der Welt noetig waere. */
  requiresUpgrade: boolean
}

export function checkCompatibility(
  worldDataVersion: number,
  serverVersion: string
): CompatibilityResult {
  const server = findVersion(serverVersion)
  const serverDataVersion = server?.dataVersion ?? 0
  const worldVersion = mcVersionForDataVersion(worldDataVersion)

  if (!server) {
    return {
      compatible: false,
      reason: `Server-Version ${serverVersion} ist nicht unterstützt`,
      worldVersion,
      serverVersion,
      worldDataVersion,
      serverDataVersion: 0,
      requiresUpgrade: false
    }
  }

  if (worldDataVersion === serverDataVersion) {
    return {
      compatible: true,
      reason: `Welt und Server passen exakt zusammen (DataVersion ${worldDataVersion})`,
      worldVersion,
      serverVersion,
      worldDataVersion,
      serverDataVersion,
      requiresUpgrade: false
    }
  }

  if (worldDataVersion < serverDataVersion) {
    return {
      compatible: true,
      reason: `Welt stammt aus ${worldVersion ?? `DataVersion ${worldDataVersion}`} und wird von ${serverVersion} gelesen - die Welt wird beim Start upgradet`,
      worldVersion,
      serverVersion,
      worldDataVersion,
      serverDataVersion,
      requiresUpgrade: true
    }
  }

  return {
    compatible: false,
    reason:
      `Die Welt stammt aus einer neueren Minecraft-Version (DataVersion ${worldDataVersion} > ${serverDataVersion}). ` +
      `Ein Start mit ${serverVersion} wuerde die Welt downgraden und damit Daten zerstoeren - der Start wird verhindert.`,
    worldVersion,
    serverVersion,
    worldDataVersion,
    serverDataVersion,
    requiresUpgrade: false
  }
}
