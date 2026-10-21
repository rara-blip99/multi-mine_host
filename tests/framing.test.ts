import { describe, expect, it } from 'vitest'
import { readFrames, writeFrame, FrameError } from '../src/main/net/framing'
import { asStream, createStreamPair } from './helpers/mock-stream'

describe('Framing', () => {
  it('überträgt Nachrichten verlustfrei', async () => {
    const { a, b } = createStreamPair()
    const payloads = [
      new TextEncoder().encode('erste Nachricht'),
      new TextEncoder().encode('zweite Nachricht mit Unicode: äöü'),
      new Uint8Array(0),
      new Uint8Array(1024).fill(42)
    ]

    const sender = (async (): Promise<void> => {
      for (const p of payloads) await writeFrame(asStream(a), p)
      await asStream(a).close()
    })()

    const received: Uint8Array[] = []
    for await (const frame of readFrames(asStream(b))) {
      received.push(frame)
    }
    await sender

    expect(received.length).toBe(payloads.length)
    for (let i = 0; i < payloads.length; i++) {
      expect(Array.from(received[i] as Uint8Array)).toEqual(Array.from(payloads[i] as Uint8Array))
    }
  })

  it('zerlegt große Frames korrekt', async () => {
    const { a, b } = createStreamPair()
    const big = new Uint8Array(200_000).fill(7)
    const sender = (async (): Promise<void> => {
      await writeFrame(asStream(a), big)
      await asStream(a).close()
    })()

    const received: Uint8Array[] = []
    for await (const frame of readFrames(asStream(b))) {
      received.push(frame)
    }
    await sender

    expect(received.length).toBe(1)
    expect(received[0]?.byteLength).toBe(big.byteLength)
  })

  it('lehnt Frames ab, die das Größenlimit überschreiten', async () => {
    const { a, b } = createStreamPair()
    const tooBig = new Uint8Array(100)
    await expect(writeFrame(asStream(a), tooBig, 10)).rejects.toThrow(FrameError)
    void b
  })

  it('meldet unvollständige Frames am Streamende', async () => {
    const { a, b } = createStreamPair()
    // Nur die Länge schreiben, nicht die Daten
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, 100, false)
    asStream(a).send(header)
    await asStream(a).close()

    const iterator = readFrames(asStream(b))
    await expect(iterator.next()).rejects.toThrow(/unvollständig|TRUNCATED/i)
  })

  it('lehnt eine manipulierte Längenangabe ab', async () => {
    const { a, b } = createStreamPair()
    const header = new Uint8Array(4)
    // Länge auf 10 MB setzen, aber nur 4 Byte senden
    new DataView(header.buffer).setUint32(0, 10 * 1024 * 1024, false)
    asStream(a).send(header)

    const iterator = readFrames(asStream(b), 1024)
    await expect(iterator.next()).rejects.toThrow(/Maximum|FRAME_TOO_LARGE/i)
  })
})
