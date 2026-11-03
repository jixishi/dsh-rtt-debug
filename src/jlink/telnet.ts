/**
 * SEGGER J-Link TELNET channel client.
 *
 * J-Link exposes RTT through a "TELNET-like" port (19021 by default). One
 * connection carries ONE RTT up-channel, chosen by a config string the client
 * must send within the first 100 ms of the connection — after that window the
 * same bytes are forwarded to the target as plain RTT input, so a late selector
 * silently becomes data. That deadline is why {@link JLinkTelnet.connect}
 * writes the selector immediately on `connect`, before wiring up buffering.
 *
 * The selector syntax (SEGGER knowledge base, "J-Link RTT TELNET Channel"):
 *
 *     $$SEGGER_TELNET_ConfigStr=RTTCh;1;SetRTTAddr;0x20000000;$$
 *
 * Commands are `;`-separated and the whole string is `$$`-delimited. Sending it
 * is optional — without one the connection defaults to channel 0 — which is why
 * a channel-0 link works even when the selector is rejected.
 *
 * Unlike OpenOCD's `rtt server start <port> <channel>`, J-Link gives one port
 * for every channel, so the two data sources are two connections to the same
 * port rather than two ports.
 */

import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'

export interface JLinkTelnetOptions {
  host: string
  /** J-Link's RTT TELNET port (SEGGER default 19021). */
  port: number
  /** RTT up-channel this connection reads. */
  channel: number
  /**
   * Control-block search address, sent as `SetRTTAddr`. `undefined` lets
   * J-Link use its own default search behaviour.
   */
  rttAddress?: number
  /**
   * Control-block search range, sent as `SetRTTSearchRanges`
   * (`"0x20000000 0x1000"`). Ignored when `rttAddress` is set, because the two
   * commands are alternatives.
   */
  rttSearchRange?: string
  /** Connect timeout in ms. Default 5000. */
  connectTimeoutMs?: number
  /** Reconnect automatically after an unexpected close. Default true. */
  reconnect?: boolean
  /** First retry delay in ms. Default 500. */
  initialDelayMs?: number
  /** Retry delay ceiling in ms. Default 10000. */
  maxDelayMs?: number
}

export type JLinkTelnetStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open'; channel: number; ack: 'sent' }
  | { kind: 'reconnecting'; attempt: number; delayMs: number }
  | { kind: 'closed'; reason: string }

export interface JLinkTelnetEvents {
  data: [chunk: Buffer]
  status: [status: JLinkTelnetStatus]
  error: [error: Error]
  /**
   * Emitted when the connection was open and J-Link then closed it.
   *
   * Coexistence of several TELNET clients on one J-Link port is NOT documented
   * by SEGGER, so a second connection may be refused or may displace the first.
   * The service uses this event to tell the two apart from an ordinary network
   * blip: a drop with no data ever seen on a channel above 0 is reported as
   * "this channel cannot be opened", not retried silently.
   */
  dropped: [info: { channel: number; hadData: boolean }]
}

/**
 * Build the SEGGER TELNET config string for one channel.
 *
 * Exported because the exact framing is the whole contract with J-Link and a
 * test pins it: `$$` delimiters, `;`-separated `Name;Value` pairs, a trailing
 * `;` before the closing `$$`.
 *
 * @param channel - RTT up-channel index.
 * @param options - optional control-block address / search range.
 */
export function buildConfigString(
  channel: number,
  options: { rttAddress?: number; rttSearchRange?: string } = {},
): string {
  const parts: string[] = [`RTTCh;${channel}`]
  if (options.rttAddress !== undefined) {
    parts.push(`SetRTTAddr;0x${(options.rttAddress >>> 0).toString(16)}`)
  } else if (options.rttSearchRange !== undefined && options.rttSearchRange.trim() !== '') {
    parts.push(`SetRTTSearchRanges;${options.rttSearchRange.trim()}`)
  }
  return `$$SEGGER_TELNET_ConfigStr=${parts.join(';')};$$`
}

export class JLinkTelnet extends EventEmitter<JLinkTelnetEvents> {
  private socket?: Socket
  private status: JLinkTelnetStatus = { kind: 'idle' }
  private retryTimer?: NodeJS.Timeout
  private attempt = 0
  private disposed = false
  private readonly options: JLinkTelnetOptions
  /** Whether any RTT byte has arrived since the connection opened. */
  private sawData = false

  public constructor(options: JLinkTelnetOptions) {
    super()
    this.options = { connectTimeoutMs: 5000, reconnect: true, initialDelayMs: 500, maxDelayMs: 10_000, ...options }
  }

  public getStatus(): JLinkTelnetStatus {
    return this.status
  }

  /** Open the connection (idempotent while connected/connecting). */
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
        socket.destroy(new Error(`connect timeout after ${this.options.connectTimeoutMs ?? 5000} ms`))
      }
    }, this.options.connectTimeoutMs ?? 5000)

    socket.on('connect', () => {
      clearTimeout(timeout)
      this.attempt = 0
      // Write the channel selector FIRST — J-Link only honours it inside the
      // first 100 ms, and a selector sent later is forwarded to the target as
      // ordinary RTT input, which would corrupt the down-channel.
      const selector = buildConfigString(this.options.channel, {
        ...(this.options.rttAddress === undefined ? {} : { rttAddress: this.options.rttAddress }),
        ...(this.options.rttSearchRange === undefined ? {} : { rttSearchRange: this.options.rttSearchRange }),
      })
      this.emit('dropped', { channel: this.options.channel, hadData: this.sawData })
      socket.write(selector)
      this.setStatus({ kind: 'open', channel: this.options.channel, ack: 'sent' })
    })

      this.sawData = false
    socket.on('data', (chunk: Buffer) => {
      if (chunk.length > 0) this.sawData = true
      this.emit('data', chunk)
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

  private scheduleRetry(): void {
    if (this.disposed) {
      this.setStatus({ kind: 'closed', reason: 'disposed' })
      return
    }
    if (this.options.reconnect === false) {
      this.setStatus({ kind: 'closed', reason: 'connection closed' })
      return
    }
    this.attempt += 1
    const raw = (this.options.initialDelayMs ?? 500) * Math.pow(1.8, this.attempt - 1)
    const delayMs = Math.min(Math.round(raw), this.options.maxDelayMs ?? 10_000)
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

  private setStatus(status: JLinkTelnetStatus): void {
    this.status = status
    this.emit('status', status)
  }
}
