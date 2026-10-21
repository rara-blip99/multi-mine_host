import type { CandidateScore, HostCapability, ScoreReason } from '@shared/types'

/**
 * Bewertung von Host-Kandidaten.
 *
 * Grundsaetze:
 *  1. Ein Kandidat muss ALLE Mindestanforderungen erfuellen, sonst ist er
 *     disqualifiziert - unabhaengig von seiner nominellen Leistung.
 *  2. Die Bewertung ist gewichtet und nachvollziehbar: jeder Beitrag wird
 *     mit Label, Gewicht und erreichtem Wert zurueckgemeldet.
 *  3. CPU-Leistung wird NICHT ueber die Kernzahl allein bestimmt. Es fliessen
 *     CPU-Modellklasse, logische Kerne und aktuelle Auslastung ein.
 *  4. Der Benutzer kann per Prioritaet explicit steuern, diese hat aber nur
 *     einen begrenzten Anteil am Gesamtscore.
 */

export interface HostRequirements {
  /** Minimaler verfuegbarer Arbeitsspeicher (Bytes). */
  minRamBytes: number
  /** Benoetigter Plattenplatz fuer die Welt (Bytes). */
  requiredWorldBytes: number
  /** Minimaler freier Plattenplatz (Bytes). */
  minFreeDiskBytes: number
  /** Benoetigte Java-Hauptversion. */
  minJavaMajor: number
  /** Minimal erforderliche Upload-Bandbreite (Mbit/s), 0 = kein Minimalwert. */
  minUploadMbps: number
  /** Faktor, mit dem der benoetigte Plattenplatz multipliziert wird. */
  diskSafetyFactor: number
}

export const DEFAULT_REQUIREMENTS: HostRequirements = {
  minRamBytes: 2 * 1024 * 1024 * 1024,
  requiredWorldBytes: 0,
  minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
  minJavaMajor: 17,
  minUploadMbps: 0,
  diskSafetyFactor: 1.35
}

export const WEIGHTS = {
  cpu: 22,
  memory: 13,
  disk: 10,
  network: 20,
  stability: 15,
  userPriority: 15,
  worldLocality: 5
} as const

/** Modelleingangsstufen fuer haeufige CPU-Familien (relativ, 0..1). */
const CPU_MODEL_INDEX: Array<{ pattern: RegExp; index: number; label: string }> = [
  { pattern: /ryzen\s*9|ryzen\s*threadripper|epyc\s*(9|7)|i9-|i9\s|core\s*ultra\s*9/i, index: 1.0, label: 'Hochklasse (8+ Kerne, hoher IPC)' },
  { pattern: /ryzen\s*7|epyc\s*5|i7-|i7\s|core\s*ultra\s*7/i, index: 0.82, label: 'Oberklasse' },
  { pattern: /ryzen\s*5|i5-|i5\s|core\s*ultra\s*5/i, index: 0.65, label: 'Mittelklasse' },
  { pattern: /ryzen\s*3|i3-|i3\s|core\s*ultra\s*3/i, index: 0.45, label: 'Einsteigerklasse' },
  { pattern: /celeron|pentium|athlon/i, index: 0.2, label: 'Sparten-CPU' }
]

export function cpuModelIndex(model: string): { index: number; label: string } {
  for (const entry of CPU_MODEL_INDEX) {
    if (entry.pattern.test(model)) return { index: entry.index, label: entry.label }
  }
  return { index: 0.55, label: 'Unbekanntes Modell (mittelklassig angenommen)' }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Kapazitaetsanteil aus der logischen Kernzahl (nichtlinear). */
export function cpuCapacityIndex(cores: number): number {
  if (!Number.isFinite(cores) || cores <= 1) return 0.05
  // 2 Kerne -> ~0.12, 4 -> ~0.33, 8 -> ~0.63, 12 -> ~0.83, 16+ -> 1.0
  return clamp01(Math.log2(cores) / Math.log2(16))
}

export interface CpuBreakdown {
  capacity: number
  model: number
  headroom: number
  score: number
  label: string
}

/** Bewertet die CPU eines Kandidaten. */
export function scoreCpu(cpu: HostCapability['cpu']): CpuBreakdown {
  const capacity = cpuCapacityIndex(cpu.logicalCores)
  const model = cpuModelIndex(cpu.model)
  // Auslastung: 100% Last -> kein Headroom. Sanft abfallend.
  const headroom = clamp01(1 - cpu.usage / 100)
  // 40% Kapazitaet, 20% Modellklasse, 40% freie Kapazitaet.
  // Die freie Kapazitaet ist bewusst der groesste Einzelfaktor: ein PC mit
  // vielen Kernen, der bereits voll ausgelastet ist, ist kein guter
  // Minecraft-Host.
  const score = clamp01(0.4 * capacity + 0.2 * model.index + 0.4 * headroom)
  return { capacity, model: model.index, headroom, score, label: model.label }
}

export interface MemoryBreakdown {
  score: number
  label: string
}

/** Bewertet den Arbeitsspeicher: Ueberschuss ueber den Bedarf zaehlt mehr als Rohmenge. */
export function scoreMemory(mem: HostCapability['memory'], requiredBytes: number): MemoryBreakdown {
  const total = Math.max(mem.totalBytes, 1)
  const available = Math.max(mem.availableBytes, 0)
  const need = Math.max(requiredBytes, 1)
  // Headroom-Faktor: verfuegbar / benoetigt
  const headroom = clamp01(available / (need * 2))
  // Grosse Gesamtmenge gibt einen kleinen Bonus (mehr Puffer fuer Plugins/Backups)
  const capacity = clamp01(total / (16 * 1024 * 1024 * 1024))
  const score = clamp01(0.75 * headroom + 0.25 * capacity)
  return {
    score,
    label: `${fmtGiB(available)} verfuegbar / ${fmtGiB(total)} gesamt, benoetigt ${fmtGiB(need)}`
  }
}

export interface DiskBreakdown {
  score: number
  label: string
}

/** Bewertet den Speicherplatz: freier Platz relativ zum Bedarf + Schreibleistung. */
export function scoreDisk(disk: HostCapability['disk'], requiredBytes: number): DiskBreakdown {
  const need = Math.max(requiredBytes, 1)
  const free = Math.max(disk.freeBytes, 0)
  const space = clamp01(free / (need * 3))
  // Schreibgeschwindigkeit: 0 MB/s = unbekannt -> neutraler Mittelwert
  const speed = disk.writeMbps > 0 ? clamp01(disk.writeMbps / 120) : 0.5
  const score = clamp01(0.75 * space + 0.25 * speed)
  return {
    score,
    label: `${fmtGiB(free)} frei, benoetigt ${fmtGiB(need)}, Schreibrate ${disk.writeMbps.toFixed(1)} MB/s`
  }
}

export interface NetworkBreakdown {
  score: number
  label: string
}

/** Bewertet die Netzwerkanbindung. */
export function scoreNetwork(net: HostCapability['network']): NetworkBreakdown {
  // Download (fuer Weltuebertragung zum Host) ist wichtiger als Upload.
  const download = net.downloadMbps > 0 ? clamp01(net.downloadMbps / 100) : 0.35
  // Upload (fuer die Spieler) ebenfalls relevant.
  const upload = net.uploadMbps > 0 ? clamp01(net.uploadMbps / 20) : 0.35
  // Latenz: 0 ms (LAN) -> 1, 200 ms -> 0
  const latency = net.latencyMs > 0 ? clamp01(1 - net.latencyMs / 200) : 0.4
  // Relay-only ist ein deutlicher Nachteil (Umwege, geringere Bandbreite)
  const relayPenalty = net.relayOnly ? 0.55 : 1
  const score = clamp01((0.4 * download + 0.4 * upload + 0.2 * latency) * relayPenalty)
  return {
    score,
    label:
      `↓ ${net.downloadMbps.toFixed(1)} Mbit/s, ↑ ${net.uploadMbps.toFixed(1)} Mbit/s, ` +
      `${net.latencyMs.toFixed(0)} ms${net.relayOnly ? ', nur ueber Relay erreichbar' : ''}`
  }
}

export interface StabilityBreakdown {
  score: number
  label: string
}

/** Bewertet die Stabilitaet: bisherige Verfuegbarkeit + Laufzeit. */
export function scoreStability(st: HostCapability['stability']): StabilityBreakdown {
  const ratio = clamp01(st.availabilityRatio)
  const total = st.successfulHosts + st.failedHosts
  // Bei wenigen bisherigen Einsaetzen ist die Aussagekraft gering -> neutral
  const confidence = total >= 3 ? 1 : 0.6
  const uptime = clamp01(st.uptimeSeconds / (7 * 24 * 3600))
  const score = clamp01((0.75 * ratio + 0.25 * uptime) * confidence + (1 - confidence) * 0.5)
  return {
    score,
    label: `Verfuegbarkeit ${(ratio * 100).toFixed(0)}% (${st.successfulHosts}/${st.successfulHosts + st.failedHosts}), Laufzeit ${fmtUptime(st.uptimeSeconds)}`
  }
}

export interface ElectionContext {
  /** Anforderungen an einen akzeptablen Host. */
  requirements: HostRequirements
  /** Aktuell aktiver Host (wird bei gehaltenem Lease nicht abgelost). */
  currentHostId: string | null
  /** Node-IDs, die bereits eine Replik der aktuellen Weltversion besitzen. */
  worldReplicaIds: string[]
  /** Reservierter RAM des Minecraft-Servers (fuer die Speicherbewertung). */
  serverRamBytes: number
}

function fmtGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function fmtUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86400)} d`
}

/**
 * Bewertet einen einzelnen Kandidaten.
 */
export function scoreCandidate(
  candidate: HostCapability,
  ctx: ElectionContext
): CandidateScore {
  const reasons: ScoreReason[] = []
  const disqualifiers: string[] = []
  const req = ctx.requirements
  const neededRam = Math.max(req.minRamBytes, ctx.serverRamBytes)
  const neededDisk = Math.max(req.requiredWorldBytes * req.diskSafetyFactor, req.minFreeDiskBytes)

  // --- Mindestanforderungen (Hartkriterien) --------------------------------
  if (!candidate.hostingAllowed) {
    disqualifiers.push('Hosting ist fuer dieses Mitglied deaktiviert')
  }
  if (!candidate.java.available) {
    disqualifiers.push('Keine Java-Laufzeit verfuegbar')
  } else if (candidate.java.major < req.minJavaMajor) {
    disqualifiers.push(
      `Java ${candidate.java.major} ist zu alt (benoetigt mindestens Java ${req.minJavaMajor})`
    )
  }
  if (candidate.memory.availableBytes < neededRam) {
    disqualifiers.push(
      `Zu wenig Arbeitsspeicher frei (${fmtGiB(candidate.memory.availableBytes)} < ${fmtGiB(neededRam)})`
    )
  }
  if (candidate.disk.freeBytes < neededDisk) {
    disqualifiers.push(
      `Zu wenig Speicherplatz frei (${fmtGiB(candidate.disk.freeBytes)} < ${fmtGiB(neededDisk)})`
    )
  }
  if (req.minUploadMbps > 0 && candidate.network.uploadMbps > 0 && candidate.network.uploadMbps < req.minUploadMbps) {
    disqualifiers.push(
      `Upload zu langsam (${candidate.network.uploadMbps.toFixed(1)} < ${req.minUploadMbps} Mbit/s)`
    )
  }

  // --- Gewichtete Bewertung ------------------------------------------------
  const cpu = scoreCpu(candidate.cpu)
  reasons.push({
    key: 'cpu',
    label: 'CPU-Leistung',
    weight: WEIGHTS.cpu,
    contribution: cpu.score * WEIGHTS.cpu,
    detail: `${candidate.cpu.model || 'Unbekannt'} - ${candidate.cpu.logicalCores} Threads, ${cpu.label}, Auslastung ${candidate.cpu.usage.toFixed(0)}%`,
    satisfied: true
  })

  const mem = scoreMemory(candidate.memory, neededRam)
  reasons.push({
    key: 'memory',
    label: 'Arbeitsspeicher',
    weight: WEIGHTS.memory,
    contribution: mem.score * WEIGHTS.memory,
    detail: mem.label,
    satisfied: candidate.memory.availableBytes >= neededRam
  })

  const disk = scoreDisk(candidate.disk, neededDisk)
  reasons.push({
    key: 'disk',
    label: 'Speicherplatz & Laufwerk',
    weight: WEIGHTS.disk,
    contribution: disk.score * WEIGHTS.disk,
    detail: disk.label,
    satisfied: candidate.disk.freeBytes >= neededDisk
  })

  const net = scoreNetwork(candidate.network)
  reasons.push({
    key: 'network',
    label: 'Netzwerk',
    weight: WEIGHTS.network,
    contribution: net.score * WEIGHTS.network,
    detail: net.label,
    satisfied: true
  })

  const stab = scoreStability(candidate.stability)
  reasons.push({
    key: 'stability',
    label: 'Stabilitaet',
    weight: WEIGHTS.stability,
    contribution: stab.score * WEIGHTS.stability,
    detail: stab.label,
    satisfied: true
  })

  const priority = clamp01(candidate.priority / 100)
  reasons.push({
    key: 'priority',
    label: 'Hosting-Prioritaet',
    weight: WEIGHTS.userPriority,
    contribution: priority * WEIGHTS.userPriority,
    detail: `Vom Benutzer festgelegt: ${candidate.priority}`,
    satisfied: candidate.priority > 0
  })

  const hasReplica = ctx.worldReplicaIds.includes(candidate.nodeId)
  const locality = hasReplica ? 1 : 0
  reasons.push({
    key: 'worldLocality',
    label: 'Welt bereits vorhanden',
    weight: WEIGHTS.worldLocality,
    contribution: locality * WEIGHTS.worldLocality,
    detail: hasReplica
      ? 'Weltversion liegt bereits lokal vor - kein grosser Transfer noetig'
      : 'Welt muss uebertragen werden',
    satisfied: hasReplica
  })

  const score = reasons.reduce((sum, r) => sum + r.contribution, 0)

  return {
    nodeId: candidate.nodeId,
    displayName: candidate.displayName,
    eligible: disqualifiers.length === 0,
    score: Math.round(score * 10) / 10,
    reasons,
    disqualifiers
  }
}

/** Bewertet alle Kandidaten und sortiert sie nach Score (absteigend). */
export function scoreCandidates(
  candidates: HostCapability[],
  ctx: ElectionContext
): CandidateScore[] {
  return candidates
    .map((c) => scoreCandidate(c, ctx))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
      return b.score - a.score
    })
}

export interface SelectionResult {
  chosen: CandidateScore | null
  reason: string
  considered: number
}

/**
 * Waehlt den Host aus. Wenn kein Kandidat alle Mindestanforderungen erfuellt,
 * wird bewusst KEIN Host gewaehlt - Datenintegritaet hat Vorrang.
 */
export function selectHost(scores: CandidateScore[]): SelectionResult {
  const eligible = scores.filter((s) => s.eligible)
  if (eligible.length === 0) {
    return {
      chosen: null,
      reason:
        scores.length === 0
          ? 'Kein Mitglied meldet Hosting-Faehigkeiten an'
          : 'Kein Kandidat erfuellt alle Mindestanforderungen - es wird kein Host gestartet, um die Welt zu schuetzen',
      considered: scores.length
    }
  }
  const chosen = eligible[0] as CandidateScore
  const runnerUp = eligible[1]
  const margin = runnerUp ? chosen.score - runnerUp.score : chosen.score
  const reason = runnerUp
    ? `${chosen.displayName} (${chosen.score.toFixed(1)} Punkte, +${margin.toFixed(1)} vor ${runnerUp.displayName})`
    : `${chosen.displayName} (${chosen.score.toFixed(1)} Punkte, einziger geeigneter Kandidat)`
  return { chosen, reason, considered: scores.length }
}

/** Bequeme Helfer: Map von nodeId -> Bewertung. */
export function scoreMap(scores: CandidateScore[]): Map<string, CandidateScore> {
  return new Map(scores.map((s) => [s.nodeId, s]))
}
