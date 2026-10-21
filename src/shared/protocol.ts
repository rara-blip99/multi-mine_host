/**
 * Versionierte Netzwerkprotokolle.
 *
 * Grundregeln:
 *  - Jedes Protokoll hat einen eigenen Multihash-Namen mit Versionsziffer.
 *  - Breaking Changes erfordern eine neue Version im Namen.
 *  - Alle Requests werden vom Empfaenger signiert geprueft (Replay-Schutz
 *    ueber Zeitstempel + Nonce).
 */

import type {
  GroupInfo,
  GroupMember,
  GroupSnapshot,
  HostCapability,
  HostLease,
  LeaseAcquireResult,
  WorldRegistryEntry
} from './types'

export const PROTOCOL_VERSION = '1.0.0'

/** Multihash-Protokollnamen (libp2p). */
export const PROTOCOLS = {
  /** Koordination mit dem Hub. */
  hub: '/multimine/hub/1.0.0',
  /** Direkte Peer-Kommunikation zwischen Mitgliedern. */
  peer: '/multimine/peer/1.0.0',
  /** Weltübertragung. */
  world: '/multimine/world/1.0.0'
} as const

export type ProtocolName = (typeof PROTOCOLS)[keyof typeof PROTOCOLS]

/** Höchstalter einer signierten Anfrage in ms. */
export const REQUEST_MAX_AGE_MS = 60_000

// ---------------------------------------------------------------------------
// RPC-Rahmen
// ---------------------------------------------------------------------------

export interface RpcRequest<P = unknown> {
  /** Protokollversion der Nachricht. */
  v: string
  /** Eindeutige Anfrage-ID (UUID-ish, random). */
  id: string
  /** Nachrichtentyp. */
  type: string
  /** Zeitstempel in ms seit Epoch. */
  ts: number
  /** Zufälliger Nonce gegen Replay. */
  nonce: string
  /** Node-ID des Absenders. */
  from: string
  /** Sitzungstoken (Hub) - widerrufbar, ohne Schluesselwechsel. */
  auth?: string
  /** Payload, typabhängig. */
  payload: P
  /** Base64-Signatur (Ed25519) über den kanonischen Body. */
  sig?: string
}

export interface RpcResponse<T = unknown> {
  v: string
  id: string
  type: string
  ok: boolean
  payload?: T
  error?: string
  errorCode?: string
  /** Signatur des Antwortenden (für Requests an Unbekannte/Peer-Auth). */
  sig?: string
  ts: number
}

// ---------------------------------------------------------------------------
// Hub-Protokoll: Anfrage-/Antwort-Payloads
// ---------------------------------------------------------------------------

export interface HelloPayload {
  displayName: string
  capability: HostCapability
  protocolVersion: string
}

export interface GroupCreatePayload {
  groupId: string
  name: string
  displayName: string
  /** Rohes oeffentlicher Schluessel (base64) - bindet die nodeId an den Key. */
  publicKey: string
  /** libp2p-Peer-ID dieses Knotens (fuer Direktverbindungen). */
  peerId: string
  /** Optionales Hub-Token (PSK) - nur noetig, wenn der Hub eines verlangt. */
  hubToken?: string
  /** Adresse des Hubs (wird vom Hub selbst gesetzt). */
  hubAddress?: string
}

export interface GroupJoinPayload {
  groupId: string
  inviteCode: string
  displayName: string
  /** Rohes oeffentlicher Schluessel (base64). */
  publicKey: string
  /** libp2p-Peer-ID dieses Knotens. */
  peerId: string
  capability: HostCapability
}

/** Heartbeat an den Hub. */
export interface HeartbeatPayload {
  groupId: string
  /** Aktuelle Leistungsdaten. */
  capability: HostCapability
  /** Bekannte Multiaddrs dieses Knotens. */
  addresses: string[]
  /** libp2p-Peer-ID (unveraenderlich). */
  peerId: string
}

export interface GroupLeavePayload {
  groupId: string
}

export interface MemberRemovePayload {
  groupId: string
  nodeId: string
}

export interface InviteRevokePayload {
  groupId: string
  inviteId: string
}

export interface InviteCreatePayload {
  groupId: string
  name: string
  /** Ablaufzeit in ms (0 = kein Ablauf). */
  expiresInMs: number
  maxUses: number
}

export interface InviteInfo {
  inviteId: string
  name: string
  /** Nur der Code selbst – der Hub speichert nur den Hash. */
  code: string
  createdAt: number
  expiresAt: number | null
  maxUses: number
  uses: number
  revoked: boolean
  createdBy: string
}

export interface LeaseAcquireRequest {
  groupId: string
  /** Gemeldete Epoche des Anfragenden (für Optimierung; der Hub ist autoritativ). */
  knownEpoch: number
  /** Priorität des Anfragenden, für Logging/Debug. */
  priority: number
}

export interface LeaseReleaseRequest {
  groupId: string
  epoch: number
  reason: string
}

export interface LeaseStatusRequest {
  groupId: string
}

export interface WorldCommitPayload {
  groupId: string
  epoch: number
  versionId: string
  worldName: string
  mcVersion: string
  dataVersion: number
  totalBytes: number
  /** Nodes, die diese Weltversion bereits besitzen. */
  replicaIds: string[]
}

export interface WorldStateRequest {
  groupId: string
}

export interface PeerDiscoveryRequest {
  groupId: string
  /** Bekannte Adressen dieses Nodes. */
  addresses: string[]
}

/** Antwort auf jeden Hub-Request. */
export type HubResponsePayload =
  | { kind: 'hello'; snapshot: GroupSnapshot }
  | { kind: 'group'; snapshot: GroupSnapshot; sessionToken: string }
  | { kind: 'lease'; result: LeaseAcquireResult }
  | { kind: 'leaseStatus'; lease: HostLease | null }
  | { kind: 'world'; entry: WorldRegistryEntry | null }
  | { kind: 'invites'; invites: InviteInfo[] }
  | { kind: 'members'; members: GroupMember[] }
  | { kind: 'discovery'; peers: PeerDiscoveryInfo[] }
  | { kind: 'ok' }

export interface PeerDiscoveryInfo {
  nodeId: string
  displayName: string
  /** libp2p-Peer-ID (fuer Direktverbindungen). */
  peerId: string
  addresses: string[]
  lastSeenAt: number
  online: boolean
}

// ---------------------------------------------------------------------------
// Peer-Protokoll (direkt zwischen Mitgliedern)
// ---------------------------------------------------------------------------

export interface PeerHelloPayload {
  nodeId: string
  displayName: string
  groupId: string
  capability: HostCapability
}

export interface PeerMetricsRequest {
  groupId: string
  epoch: number
}

export interface PeerMetricsResponse {
  capability: HostCapability
}

// ---------------------------------------------------------------------------
// Weltübertragung
// ---------------------------------------------------------------------------

export interface WorldRequestPayload {
  groupId: string
  /** Erwartete Weltversion des Anfragenden. */
  versionId: string
  epoch: number
  /** Nur benoetigte Dateien uebertragen (incrementell). */
  onlyMissing: boolean
  /** Bekannte Dateigroessen/Hashes des Anfragenden. */
  have: Array<{ path: string; size: number; sha256: string }>
}

export interface WorldResponsePayload {
  ok: boolean
  manifest: {
    versionId: string
    worldName: string
    mcVersion: string
    dataVersion: number
    totalBytes: number
    entryCount: number
    entries: Array<{ path: string; size: number; mtimeMs: number; sha256: string }>
  }
  /** Dateien, die uebertragen werden muessen. */
  transfer: Array<{ path: string; size: number; sha256: string }>
  /** Bereits vorhandene Dateien, die uebersprungen werden koennen. */
  skip: string[]
  error?: string
}

/** Einzelnes Datei-Frame im Datenstrom. */
export interface FileChunkFrame {
  path: string
  index: number
  total: number
  offset: number
  length: number
  sha256: string
  data: Uint8Array
}

export interface FileCompleteFrame {
  path: string
  sha256: string
  size: number
}

export interface TransferErrorFrame {
  path: string
  reason: string
}

export type WorldFrame =
  | { t: 'chunk'; f: FileChunkFrame }
  | { t: 'file-done'; f: FileCompleteFrame }
  | { t: 'error'; f: TransferErrorFrame }
  | { t: 'end'; f: { versionId: string } }

// ---------------------------------------------------------------------------
// Kanonische Signatur-Normalisierung
// ---------------------------------------------------------------------------

/**
 * Erzeugt eine deterministische JSON-Darstellung eines Objekts.
 * Wird sowohl fuer Signaturen (Hub/Peer) als auch fuer die
 * Welt-Manifest-Versionierung verwendet.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
}

/** Body, der signiert wird (ohne das Signaturfeld selbst). */
export function signatureBody(req: {
  v: string
  id: string
  type: string
  ts: number
  nonce: string
  from: string
  auth?: string
  payload: unknown
}): string {
  return canonicalize({
    v: req.v,
    id: req.id,
    type: req.type,
    ts: req.ts,
    nonce: req.nonce,
    from: req.from,
    auth: req.auth ?? '',
    payload: req.payload
  })
}
