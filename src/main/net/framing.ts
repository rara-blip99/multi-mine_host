import { Uint8ArrayList } from 'uint8arraylist'

/**
 * Framing ueber libp2p-Streams.
 *
 * Ein Frame besteht aus einer 4-Byte-Lengenangabe (Big Endian) gefolgt von
 * genau so vielen Nutzdaten. Die maximale Frame-Groesse ist begrenzt, damit
 * ein boeswilliger Peer nicht durch eine riesige Laengenangabe den Speicher
 * des Empfaengers belastet.
 */

export const DEFAULT_MAX_FRAME = 8 * 1024 * 1024
const HEADER_SIZE = 4

export class FrameError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Minimal-Interface, das ein Stream fuer das Framing anbieten muss. */
export interface FrameSink {
  send(data: Uint8Array): boolean
  onDrain?(): Promise<void>
}

export type FrameChunk = Uint8Array | Uint8ArrayList

/**
 * Sendet einen Frame. Wartet bei vollem Sendepuffer auf 'drain'.
 */
export async function writeFrame(
  sink: FrameSink,
  payload: Uint8Array,
  maxFrame = DEFAULT_MAX_FRAME
): Promise<void> {
  if (payload.byteLength > maxFrame) {
    throw new FrameError(
      `Frame zu gross: ${payload.byteLength} > ${maxFrame}`,
      'FRAME_TOO_LARGE'
    )
  }
  const header = new Uint8Array(HEADER_SIZE)
  new DataView(header.buffer).setUint32(0, payload.byteLength, false)
  if (!sink.send(header)) await waitDrain(sink)
  if (!sink.send(payload)) await waitDrain(sink)
}

async function waitDrain(sink: FrameSink): Promise<void> {
  if (sink.onDrain) {
    await sink.onDrain()
    return
  }
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/**
 * Liest Frames aus einem Stream. Der Generator endet, wenn der Stream
 * endet. Ein unvollstaendiger letzter Frame fuehrt zu einem Fehler.
 */
export async function* readFrames(
  source: AsyncIterable<FrameChunk>,
  maxFrame = DEFAULT_MAX_FRAME
): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8ArrayList()

  for await (const chunk of source) {
    buffer.append(toBytes(chunk))

    for (;;) {
      if (buffer.byteLength < HEADER_SIZE) break
      const len = buffer.getUint32(0, false)
      if (len > maxFrame) {
        throw new FrameError(
          `Frame-Länge ${len} überschreitet Maximum ${maxFrame}`,
          'FRAME_TOO_LARGE'
        )
      }
      if (buffer.byteLength < HEADER_SIZE + len) break
      const payload = buffer.slice(HEADER_SIZE, HEADER_SIZE + len)
      buffer.consume(HEADER_SIZE + len)
      yield payload
    }
  }

  if (buffer.byteLength > 0) {
    throw new FrameError('Stream endete mit unvollständigem Frame', 'TRUNCATED_FRAME')
  }
}

function toBytes(chunk: FrameChunk): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  return chunk.subarray()
}
