/**
 * OpenOCD TCL client.
 *
 * OpenOCD's TCL port speaks a simple line protocol: a command terminated by the
 * 0x1A byte, and a response that ends with the same byte. That is the transport
 * the third data source uses to read target memory — no firmware cooperation
 * needed, unlike the two RTT channels.
 *
 * The client is intentionally READ-ONLY. It exposes exactly one write-capable
 * command (`halt`, needed so a running target's memory can be sampled
 * coherently) and rejects everything else, because a debug panel that can
 * silently mutate a target is a liability (spec §3.8.5).
 */

import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'

/** The TCL protocol's message terminator. */
const TCL_TERMINATOR = 0x1a

export interface OcdTclOptions {
  host: string
  port: number
  /** Per-command response timeout in ms. Default 5000. */
  timeoutMs?: number
}

export interface OcdTclEvents {
  error: [error: Error]
  close: []
}

/**
 * Commands this client will forward to OpenOCD.
 *
 * Anything absent is refused before it reaches the wire. Read commands are
 * `mdb`/`mdh`/`mdw` (byte/half/word memory display) plus the inspection
 * helpers; `halt` is permitted because sampling a running target yields torn
 * reads, and stopping the core is the standard, reversible way to avoid that.
 */
const ALLOWED_READ_COMMANDS = new Set(['mdb', 'mdh', 'mdw', 'reg', 'halt', 'resume', 'targets', 'echo'])

/** Refuse anything that writes, erases or resets. Listed for error messages. */
const FORBIDDEN_COMMANDS = new Set([
  'mwb', 'mwh', 'mww', 'flash', 'reset', 'shutdown', 'exit', 'bp', 'rbp', 'wp', 'rwp', 'load_image',
])

/**
 * Parse a command's first word and decide whether it is safe.
 * @throws when the command is not on the read-only allowlist.
 */
export function assertReadOnly(command: string): void {
  const first = command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  if (first === '') throw new Error('empty OpenOCD command')
  if (ALLOWED_READ_COMMANDS.has(first)) return
  if (FORBIDDEN_COMMANDS.has(first)) {
    throw new Error(`refusing write-capable OpenOCD command "${first}" — this reader is read-only`)
  }
  throw new Error(`OpenOCD command "${first}" is not on the read-only allowlist`)
}

export class OcdTcl extends EventEmitter<OcdTclEvents> {
  private socket?: Socket
  private pending?: { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private buffer = ''
  private readonly options: OcdTclOptions
  private readonly timeoutMs: number
  private closed = true

  public constructor(options: OcdTclOptions) {
    super()
    this.options = options
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  public get connected(): boolean {
    return this.socket !== undefined && !this.closed
  }

  /** Open the TCL connection. @throws when the port refuses or times out. */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port })
      const onError = (error: Error): void => {
        socket.removeAllListeners()
        socket.destroy()
        reject(error)
      }
      const timer = setTimeout(() => {
        onError(new Error(`OpenOCD TCL connect timeout after ${this.timeoutMs} ms`))
      }, this.timeoutMs)

      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        onError(error)
      })
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.setNoDelay(true)
        this.socket = socket
        this.closed = false
        socket.on('data', (chunk: Buffer) => this.onData(chunk))
        socket.on('error', (error: Error) => this.emit('error', error))
        socket.on('close', () => {
          this.closed = true
          this.socket = undefined
          this.failPending(new Error('OpenOCD TCL connection closed'))
          this.emit('close')
        })
        resolve()
      })
    })
  }

  public close(): void {
    const socket = this.socket
    this.socket = undefined
    this.closed = true
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.failPending(new Error('OpenOCD TCL client closed'))
  }

  /**
   * Send one command and await its response.
   * @throws when the command is not read-only, or the response times out.
   */
  public async cmd(command: string): Promise<string> {
    assertReadOnly(command)
    const socket = this.socket
    if (socket === undefined) throw new Error('OpenOCD TCL is not connected')
    if (this.pending !== undefined) throw new Error('OpenOCD TCL already has a command in flight')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined
        reject(new Error(`OpenOCD TCL command timed out: ${command}`))
      }, this.timeoutMs)
      this.pending = { resolve, reject, timer }
      socket.write(`${command}\x1a`)
    })
  }

  /**
   * Read `count` 32-bit words starting at `address`.
   * @returns the decoded words, in address order.
   */
  public async readWords(address: number, count: number): Promise<number[]> {
    return parseMemoryWords(await this.cmd(`mdw ${hex(address)} ${count}`))
  }

  /**
   * Read `count` 16-bit halfwords starting at `address`.
   * @returns address-ordered values, widened to numbers.
   */
  public async readHalfwords(address: number, count: number): Promise<number[]> {
    return parseMemoryWords(await this.cmd(`mdh ${hex(address)} ${count}`))
  }

  /**
   * Read `count` bytes starting at `address`.
   * @returns address-ordered byte values.
   */
  public async readBytes(address: number, count: number): Promise<number[]> {
    return parseMemoryWords(await this.cmd(`mdb ${hex(address)} ${count}`))
  }

  /** List the channels/targets OpenOCD currently knows, for diagnostics. */
  public async targets(): Promise<string> {
    return this.cmd('targets')
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1')
    for (;;) {
      const at = this.buffer.indexOf(String.fromCharCode(TCL_TERMINATOR))
      if (at === -1) break
      const payload = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      const pending = this.pending
      if (pending !== undefined) {
        this.pending = undefined
        clearTimeout(pending.timer)
        pending.resolve(payload)
      }
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}

/** `0x`-prefixed lowercase hex, the form OpenOCD accepts. */
function hex(address: number): string {
  return `0x${(address >>> 0).toString(16)}`
}

/**
 * Parse OpenOCD's `md*` output.
 *
 * The reply is one or more lines of `0xADDR: 00112233 44556677 …`, so only the
 * hex tokens after the colon are values — the leading address must not be
 * mistaken for data.
 */
export function parseMemoryWords(reply: string): number[] {
  const out: number[] = []
  for (const line of reply.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    for (const token of line.slice(colon + 1).trim().split(/\s+/)) {
      if (token === '') continue
      const value = Number.parseInt(token, 16)
      if (!Number.isNaN(value)) out.push(value)
    }
  }
  return out
}
