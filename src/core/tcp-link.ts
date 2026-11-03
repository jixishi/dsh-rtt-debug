/**
 * Reconnecting TCP byte-stream link.
 *
 * One instance per stream (log channel, variable channel). The two links never
 * share a socket, a buffer or a timer — that separation is what keeps a burst
 * on the variable channel from delaying log lines (spec D20/A16).
 *
 * Backpressure policy is per-instance because the two streams want opposite
 * answers: the log link must never drop bytes, while the variable link may
 * discard stale frames when a consumer falls behind.
 */

import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'

export interface TcpLinkOptions {
  host: string
  port: number

  /**
   * How to behave when the consumer is slower than the producer.
   *
   * - `pause` (default): stop reading from the socket so nothing is lost. The
   *   log link uses this — dropping a log line is the one failure the spec
   *   forbids.
   * - `drop-oldest`: keep reading and discard the oldest buffered bytes. The
   *   variable link uses this so a stalled parser cannot wedge the socket.
   */
  overflowPolicy?: 'pause' | 'drop-oldest'

  /** Buffered-byte ceiling before `overflowPolicy` engages. */
  maxBufferedBytes?: number

  /** Reconnect automatically after an unexpected close. Default true. */
  reconnect?: boolean
  /** First retry delay in ms. Default 500. */
  initialDelayMs?: number
  /** Retry delay ceiling in ms. Default 10000. */
  maxDelayMs?: number
  /** Exponential backoff factor. Default 1.8. */
  backoffFactor?: number

  /** Connect timeout in ms. Default 5000. */
  connectTimeoutMs?: number
}

/** Observable link state. */
export type LinkStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'reconnecting'; attempt: number; delayMs: number }
  | { kind: 'closed'; reason: string }

export interface TcpLinkEvents {
  data: [chunk: Buffer]
  status: [status: LinkStatus]
  error: [error: Error]
}

export class TcpLink extends EventEmitter<TcpLinkEvents> {
  private socket?: Socket
  private status: LinkStatus = { kind: 'idle' }
  /** Bytes received but not yet consumed by a `data` listener. */
  private buffered: Buffer[] = []
  private bufferedBytes = 0
  private retryTimer?: NodeJS.Timeout
  private attempt = 0
  private disposed = false
  private paused = false
  private readonly options: Required<TcpLinkOptions>

  public constructor(options: TcpLinkOptions) {
    super()
    this.options = {
      overflowPolicy: 'pause',
      maxBufferedBytes: 8 * 1024 * 1024,
      reconnect: true,
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      backoffFactor: 1.8,
      connectTimeoutMs: 5000,
      ...options,
    }
  }

  public getStatus(): LinkStatus {
    return this.status
  }

  /** Bytes currently held awaiting delivery (diagnostics + A16 evidence). */
  public get bufferedLength(): number {
    return this.bufferedBytes
  }

  /** Open the socket (idempotent while connected/connecting). */
  public connect(): void {
    if (this.disposed) return
    if (this.socket !== undefined) return
    this.clearRetry()
    this.setStatus({ kind: 'connecting' })
    this.openSocket()
  }

  /** Close permanently: no reconnect, no further events. */
  public dispose(): void {
    this.disposed = true
    this.clearRetry()
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.setStatus({ kind: 'closed', reason: 'disposed' })
  }

  /** Close the current socket but allow an explicit `connect()` later. */
  public close(reason = 'closed by caller'): void {
    this.clearRetry()
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.setStatus({ kind: 'closed', reason })
  }

  private openSocket(): void {
    const socket = connect({ host: this.options.host, port: this.options.port })
    this.socket = socket
    socket.setNoDelay(true)

    const timeout = setTimeout(() => {
      if (this.socket === socket && this.status.kind !== 'open') {
        socket.destroy(new Error(`connect timeout after ${this.options.connectTimeoutMs} ms`))
      }
    }, this.options.connectTimeoutMs)

    socket.on('connect', () => {
      clearTimeout(timeout)
      this.attempt = 0
      this.setStatus({ kind: 'open' })
      // Resume reading — a previous socket may have left us paused.
      this.paused = false
      socket.resume()
    })

    socket.on('data', (chunk: Buffer) => {
      this.accept(chunk)
    })

    socket.on('error', (error: Error) => {
      clearTimeout(timeout)
      this.emit('error', error)
      // `close` follows and owns the retry decision.
    })

    socket.on('close', () => {
      clearTimeout(timeout)
      if (this.socket !== socket) return
      this.socket = undefined
      this.scheduleRetry()
    })
  }

  /** Buffer an incoming chunk and deliver what the consumer can take. */
  private accept(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.buffered.push(chunk)
    this.bufferedBytes += chunk.length

    if (this.bufferedBytes > this.options.maxBufferedBytes) {
      if (this.options.overflowPolicy === 'drop-oldest') {
        this.dropOldest()
      } else {
        // Stop reading: the producer blocks until the consumer catches up, so
        // no byte is lost.
        this.pauseSocket()
      }
    }
    this.drain()
  }

  /** Discard the oldest buffered bytes until under the ceiling. */
  private dropOldest(): void {
    let excess = this.bufferedBytes - this.options.maxBufferedBytes
    while (excess > 0 && this.buffered.length > 0) {
      const head = this.buffered[0] as Buffer
      if (head.length <= excess) {
        this.buffered.shift()
        this.bufferedBytes -= head.length
        excess -= head.length
      } else {
        this.buffered[0] = head.subarray(excess)
        this.bufferedBytes -= excess
        excess = 0
      }
    }
  }

  private pauseSocket(): void {
    if (this.paused) return
    this.paused = true
    this.socket?.pause()
  }

  /** Hand buffered bytes to listeners, honouring a listener that pauses us. */
  private drain(): void {
    while (this.buffered.length > 0) {
      const hadListener = this.listenerCount('data') > 0
      const chunk = this.buffered[0] as Buffer
      this.emit('data', chunk)
      // No listener means nobody consumed it: keep it buffered rather than
      // losing it, and stop draining until someone subscribes.
      if (!hadListener) return
      // A listener may have paused us (its own backpressure); stop here.
      if (this.paused) return
      this.buffered.shift()
      this.bufferedBytes -= chunk.length
    }
    if (this.bufferedBytes === 0 && this.paused) {
      this.paused = false
      this.socket?.resume()
    }
    if (this.bufferedBytes < this.options.maxBufferedBytes / 2 && this.paused) {
      this.paused = false
      this.socket?.resume()
    }
  }

  /** Ask the link to stop delivering until `resume()` (consumer backpressure). */
  public pause(): void {
    this.paused = true
  }

  public resume(): void {
    this.paused = false
    this.drain()
    this.socket?.resume()
  }

  private scheduleRetry(): void {
    if (this.disposed) {
      this.setStatus({ kind: 'closed', reason: 'disposed' })
      return
    }
    if (!this.options.reconnect) {
      this.setStatus({ kind: 'closed', reason: 'connection closed' })
      return
    }
    this.attempt += 1
    const raw = this.options.initialDelayMs * Math.pow(this.options.backoffFactor, this.attempt - 1)
    const delayMs = Math.min(Math.round(raw), this.options.maxDelayMs)
    this.setStatus({ kind: 'reconnecting', attempt: this.attempt, delayMs })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.disposed || this.socket !== undefined) return
      this.setStatus({ kind: 'connecting' })
      this.openSocket()
    }, delayMs)
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private setStatus(status: LinkStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

/**
 * Probe a TCP endpoint once.
 * @returns true when the port accepted a connection.
 */
export function probeTcp(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}
