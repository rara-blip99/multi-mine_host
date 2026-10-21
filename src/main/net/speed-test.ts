import { randomBytes } from 'node:crypto'
import type { Stream } from '@libp2p/interface'
import { readFrames, writeFrame } from './framing'
import type { PeerNode } from './transport'
import { logger } from '../core/logger'

/**
 * Messung der tatsaechlichen Netzwerkqualitaet zum Koordinations-Hub.
 *
 * Der Hub ist von jedem Mitglied garantiert erreichbar - deshalb eignet er
 * sich als Messpunkt. Die Messung nutzt einen eigenen Strom, damit sie die
 * Weltuebertragung nicht stoert.
 *
 * Ablauf:
 *   - `ping`  : Rundlaufzeit (Latenz, Jitter)
 *   - `download`: Der Hub sendet eine definierte Menge Zufallsdaten
 *   - `upload`  : Das Mitglied sendet eine definierte Menge Zufallsdaten
 */

export const SPEED_PROTOCOL = '/multimine/speed/1.0.0'

export interface SpeedRequest {
  direction: 'ping' | 'download' | 'upload'
  bytes: number
}

export interface NetworkSpeedResult {
  downloadMbps: number
  uploadMbps: number
  latencyMs: number
  jitterMs: number
  measuredAt: number
}

const BLOCK = 64 * 1024
/** Kennzeichnet einen Steuerframe (JSON folgt). */
const FRAME_CONTROL = 1

function controlFrame(request: SpeedRequest): Uint8Array {
  return Buffer.concat([
    Buffer.from([FRAME_CONTROL]),
    Buffer.from(JSON.stringify(request), 'utf8')
  ])
}

/**
 * Serverseitige Antwort auf eine Messanfrage.
 * Wird vom Hub aufgerufen, wenn ein Mitglied den Speed-Strom oeffnet.
 */
export async function handleSpeedRequest(stream: Stream): Promise<void> {
  const iterator = readFrames(stream)
  const first = await iterator.next()
  if (first.done || !first.value) return
  if (first.value.byteLength < 2) return
  if (first.value[0] !== FRAME_CONTROL) return

  let request: SpeedRequest
  try {
    request = JSON.parse(new TextDecoder().decode(first.value.subarray(1))) as SpeedRequest
  } catch {
    return
  }

  switch (request.direction) {
    case 'ping': {
      // Eine identische Antwort zurueckschicken -> der Client misst die RTT
      await writeFrame(stream, first.value.subarray(1))
      break
    }
    case 'download': {
      const block = randomBytes(BLOCK)
      let sent = 0
      while (sent < request.bytes) {
        const n = Math.min(block.length, request.bytes - sent)
        await writeFrame(stream, block.subarray(0, n))
        sent += n
      }
      break
    }
    case 'upload': {
      // Daten empfangen und verwerfen
      let received = 0
      for await (const frame of iterator) {
        received += frame.byteLength
        if (received >= request.bytes) break
      }
      // Bestaetigung -> der Client misst bis hierhin (inkl. Upload)
      await writeFrame(stream, controlFrame({ direction: 'ping', bytes: 0 }))
      break
    }
    default:
      break
  }
  try {
    await stream.close()
  } catch {
    /* ignore */
  }
}

/**
 * Misst Download-, Upload-Bandbreite und Latenz zum Hub.
 */
export async function measureNetworkSpeed(
  node: PeerNode,
  hubAddress: string,
  options: { bytes?: number; pings?: number } = {}
): Promise<NetworkSpeedResult> {
  const bytes = options.bytes ?? 4 * 1024 * 1024
  const pingCount = options.pings ?? 5

  const result: NetworkSpeedResult = {
    downloadMbps: 0,
    uploadMbps: 0,
    latencyMs: 0,
    jitterMs: 0,
    measuredAt: Date.now()
  }

  try {
    // --- Latenz ---
    const latencies: number[] = []
    for (let i = 0; i < pingCount; i++) {
      const stream = await node.dial(hubAddress, SPEED_PROTOCOL, 15_000)
      try {
        const t0 = process.hrtime.bigint()
        await writeFrame(stream, controlFrame({ direction: 'ping', bytes: 0 }))
        const iterator = readFrames(stream)
        const first = await iterator.next()
        if (first.done || !first.value) throw new Error('Keine Ping-Antwort')
        const t1 = process.hrtime.bigint()
        latencies.push(Number(t1 - t0) / 1e6)
      } finally {
        try {
          await stream.close()
        } catch {
          /* ignore */
        }
      }
    }
    if (latencies.length > 0) {
      latencies.sort((a, b) => a - b)
      const median = latencies[Math.floor(latencies.length / 2)] as number
      result.latencyMs = Math.round(median * 100) / 100
      // Jitter = mittlere absolute Abweichung vom Median
      const jitter =
        latencies.reduce((s, v) => s + Math.abs(v - median), 0) / latencies.length
      result.jitterMs = Math.round(jitter * 100) / 100
    }

    // --- Download ---
    const dlStream = await node.dial(hubAddress, SPEED_PROTOCOL, 30_000)
    try {
      await writeFrame(dlStream, controlFrame({ direction: 'download', bytes }))
      const t0 = process.hrtime.bigint()
      let received = 0
      for await (const frame of readFrames(dlStream)) {
        received += frame.byteLength
        if (received >= bytes) break
      }
      const t1 = process.hrtime.bigint()
      result.downloadMbps = toMbps(bytes, Number(t1 - t0))
    } finally {
      try {
        await dlStream.close()
      } catch {
        /* ignore */
      }
    }

    // --- Upload ---
    const ulStream = await node.dial(hubAddress, SPEED_PROTOCOL, 30_000)
    try {
      await writeFrame(ulStream, controlFrame({ direction: 'upload', bytes }))
      const block = randomBytes(BLOCK)
      const t0 = process.hrtime.bigint()
      let sent = 0
      while (sent < bytes) {
        const n = Math.min(block.length, bytes - sent)
        await writeFrame(ulStream, block.subarray(0, n))
        sent += n
      }
      // Auf die Bestaetigung des Hubs warten, damit der Upload wirklich
      // abgeschlossen ist, bevor gemessen wird.
      const iterator = readFrames(ulStream)
      await iterator.next()
      const t1 = process.hrtime.bigint()
      result.uploadMbps = toMbps(bytes, Number(t1 - t0))
    } finally {
      try {
        await ulStream.close()
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logger.debug('speed-test', 'Geschwindigkeitsmessung fehlgeschlagen', { error: String(err) })
  }

  return result
}

function toMbps(bytes: number, nanoseconds: number): number {
  if (nanoseconds <= 0) return 0
  const seconds = nanoseconds / 1e9
  const mbit = (bytes * 8) / 1_000_000
  return Math.round((mbit / seconds) * 100) / 100
}
