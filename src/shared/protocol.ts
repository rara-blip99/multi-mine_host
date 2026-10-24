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

/** Anfrage an den bisherigen Host: Server kontrolliert herunterfahren. */
export interface QuiesceFrame {
  type: 'quiesce'
  groupId: string
  /** Epoche des neuen Hosts (muss groesser als die eigene sein). */
  epoch: number
  from: string
  ts: number
  nonce: string
  sig: string
}

/** Antwort des bisherigen Hosts auf eine Quiesce-Anfrage. */
export interface QuiesceResultFrame {
  type: 'quiesce-result'
  ok: boolean
  /** Weltversion nach dem kontrollierten Stopp. */
  versionId: string
  error?: string
}

/** Angebot einer Backup-Datei an ein anderes Mitglied. */
export interface BackupOfferFrame {
  type: 'backup-offer'
  groupId: string
  /** Metadaten des Backups (ohne Pfad). */
  meta: {
    id: string
    kind: string
    worldName: string
    worldVersionId: string
    mcVersion: string
    dataVersion: number
    sizeBytes: number
    uncompressedBytes: number
    sha256: string
    createdAt: number
  }
}

/** Antwort auf ein Backup-Angebot. */
export interface BackupAcceptFrame {
  type: 'backup-accept'
  ok: boolean
  error?: string
}

/** Abschluss der Backup-Uebertragung. */
export interface BackupCompleteFrame {
  type: 'backup-complete'
  sha256: string
}

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

// ---------------------------------------------------------------------------
// Einladungslink (Hub-Adresse + Gruppe + Einladungscode in einem Text)
// ---------------------------------------------------------------------------

/**
 * Kombiniert die drei Werte, die ein Freund benoetigt, in einem kopierbaren
 * Text. So muss niemand die Hub-Multiaddr, die Gruppen-ID und den
 * Einladungscode einzeln weitergeben oder eintippen.
 *
 * Format: `MMH-INV:<b64url(hub)>.<b64url(group)>.<b64url(code)>`
 * - base64url ist zeichensicher fuer Chats, Notizen und URLs
 * - der Einladungscode bleibt die kryptografische Schluesselkomponente
 */
export interface InviteBundle {
  hubAddress: string
  groupId: string
  inviteCode: string
}

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    binary += String.fromCharCode(b)
  }
  const b64 = btoa(binary)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64UrlToBytes(text: string): Uint8Array {
  let b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeInviteLink(bundle: InviteBundle): string {
  const encode = (text: string): string => bytesToB64Url(new TextEncoder().encode(text))
  return [
    'MMH-INV:',
    encode(bundle.hubAddress),
    '.',
    encode(bundle.groupId),
    '.',
    encode(bundle.inviteCode)
  ].join('')
}

export function parseInviteLink(text: string): InviteBundle | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('MMH-INV:')) return null
  const payload = trimmed.slice('MMH-INV:'.length)
  const parts = payload.split('.')
  if (parts.length !== 3) return null
  try {
    const decode = (seg?: string): string => new TextDecoder().decode(b64UrlToBytes(seg ?? ''))
    const hubAddress = decode(parts[0])
    const groupId = decode(parts[1])
    const inviteCode = decode(parts[2])
    if (!hubAddress.startsWith('/') || !groupId || !inviteCode.startsWith('MMH-')) return null
    return { hubAddress, groupId, inviteCode }
  } catch {
    return null
  }
}
