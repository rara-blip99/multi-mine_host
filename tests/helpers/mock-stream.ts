import type { Stream } from '@libp2p/interface'

/**
 * Testhilfen: ein in-memory Duplex-Paar, das das Verhalten eines
 * libp2p-Streams nachbildet (Halb-Close-Semantik). Damit lassen sich
 * Protokolle ohne echtes Netzwerk testen - inklusive Abbruch mitten in der
 * Uebertragung.
 */

export class MockStream {
  readonly id: string
  readonly protocol = '/test/1.0.0'
  status = 'open'
  direction: 'inbound' | 'outbound' = 'outbound'
  timeline = { open: Date.now() }
  log = console
  readStatus = 'readable'
  writeStatus = 'writable'
  remoteReadStatus = 'readable'
  remoteWriteStatus = 'writable'
  maxReadBufferLength = 16 * 1024 * 1024
  maxWriteBufferLength = 16 * 1024 * 1024
  inactivityTimeout = 0
  writableNeedsDrain = false
  readableEnded = false
  readBufferLength = 0
  writeBufferLength = 0

  private queue: Uint8Array[] = []
  private waiter: ((v: IteratorResult<Uint8Array>) => void) | null = null
  private readClosed = false
  private writeClosed = false
  /** Bytes, nach denen der Stream einen Fehler wirft (simulierter Abbruch). */
  failAfterBytes: number | null = null
  private sent = 0

  constructor(
    id: string,
    private readonly peer?: MockStream
  ) {
    this.id = id
  }

  send(data: Uint8Array): boolean {
    if (this.writeClosed) throw new Error('Sendeseite geschlossen')
    this.sent += data.byteLength
    if (this.failAfterBytes !== null && this.sent > this.failAfterBytes) {
      throw new Error('Simulierter Verbindungsabbruch')
    }
    this.peer?.receive(data)
    return true
  }

  receive(data: Uint8Array): void {
    if (this.readClosed) return
    this.queue.push(data)
    this.readBufferLength += data.byteLength
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      const chunk = this.queue.shift() as Uint8Array
      this.readBufferLength -= chunk.byteLength
      w({ value: chunk, done: false })
    }
  }

  /** Wird von der Gegenseite aufgerufen, wenn deren Sendeseite endet. */
  remoteCloseWrite(): void {
    this.readClosed = true
    this.readStatus = 'closed'
    this.readableEnded = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  onDrain(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    if (this.writeClosed) return
    this.writeClosed = true
    this.writeStatus = 'closed'
    this.peer?.remoteCloseWrite()
  }

  abort(err: Error): void {
    this.writeClosed = true
    this.readClosed = true
    this.status = 'aborted'
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
    void err
  }

  pause(): void {}
  resume(): void {}
  push(): void {}
  unshift(): void {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.queue.length > 0) {
        const chunk = this.queue.shift() as Uint8Array
        this.readBufferLength -= chunk.byteLength
        yield chunk
        continue
      }
      if (this.readClosed) return
      const result = await new Promise<IteratorResult<Uint8Array>>((resolvePromise) => {
        this.waiter = resolvePromise
      })
      if (result.done) return
      yield result.value
    }
  }
}

/** Erzeugt zwei verbundene Streams (a <-> b). */
export function createStreamPair(): { a: MockStream; b: MockStream } {
  const a = new MockStream('a')
  const b = new MockStream('b', a)
  // a empfaengt von b
  ;(a as unknown as { peer?: MockStream }).peer = b
  return { a, b }
}

/** Wandelt einen MockStream in die libp2p-Stream-Schnittstelle. */
export function asStream(mock: MockStream): Stream {
  return mock as unknown as Stream
}
