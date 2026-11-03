/**
 * GDB Remote Serial Protocol client — the memory-read transport for the
 * J-Link backend.
 *
 * Why this and not the J-Link SDK: the free J-Link software already speaks RSP
 * on its GDB port, and `m<addr>,<len>` is the one packet this reader needs.
 * That keeps the plugin free of a native DLL binding (no `koffi`, no ABI
 * guessing, no second copy of the harness runtime) while still going straight
 * to SEGGER's own driver instead of through OpenOCD.
 *
 * Two protocol details drive the implementation:
 *
 *   - **Acknowledgements.** Classic RSP ack/Nak's every packet. We start in ack
 *     mode for compatibility, then ask for `QStartNoAckMode`: one round trip
 *     less per sample, and the host stops waiting on us. A server that refuses
 *     the request keeps working in ack mode — the client tracks which mode is
 *     live rather than assuming.
 *   - **Asynchronous output.** The stub may interleave `O<text>` console
 *     packets with a reply. They are consumed and ignored; treating one as the
 *     answer would corrupt a read.
 *
 * The client is READ-ONLY by construction: it exposes `readMemory` and the two
 * link-management packets, and refuses to send anything else (spec §3.8.5).
 */

import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'

/** RSP control bytes. */
const PACKET_START = 0x24 // '$'
const PACKET_END = 0x23 // '#'
const ACK = 0x2b // '+'
const NAK = 0x2d // '-'
const NOTIFY = 0x25 // '%' (not used here, but must not be mis-parsed)

export interface RspOptions {
  host: string
  port: number
  /** Per-packet timeout in ms. Default 5000. */
  timeoutMs?: number
  /** Try `QStartNoAckMode` after connecting. Default true. */
  noAckMode?: boolean
}

export interface RspEvents {
  error: [error: Error]
  close: []
}

/** One pending request awaiting its reply. */
interface Pending {
  resolve: (payload: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Compute an RSP packet checksum: the low byte of the byte sum.
 * @param body - packet payload, without `$` and `#xx`.
 */
export function rspChecksum(body: string): string {
  let sum = 0
  for (let i = 0; i < body.length; i += 1) sum = (sum + body.charCodeAt(i)) & 0xff
  return sum.toString(16).padStart(2, '0')
}

/** Frame a payload into a complete wire packet. */
export function framePacket(body: string): string {
  return `$${body}#${rspChecksum(body)}`
}

/**
 * Whether a reply payload is an asynchronous console-output packet.
 *
 * `O` followed by hex-encoded text is the RSP console-output form. The check has
 * to look at the PAYLOAD, not just the first character, because `OK` — the reply
 * to link-management requests such as `QStartNoAckMode` — shares that letter:
 *
 *   - `O` alone                    → an empty console line (still a console packet)
 *   - `O` + even-length hex        → console text, skip it
 *   - `OK` / `O<anything else>`    → a normal reply, must NOT be skipped
 *
 * Getting this wrong is not cosmetic: swallowing `OK` leaves the client waiting
 * for a reply that already arrived, so the request times out and the whole
 * connection degrades to ack mode.
 */
export function isConsoleOutput(payload: string): boolean {
  if (!payload.startsWith('O')) return false
  const rest = payload.slice(1)
  if (rest.length === 0) return true
  return rest.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(rest)
}

/**
 * Undo RSP binary escaping (`}` followed by the byte XOR 0x20).
 *
 * Replies to `m` are plain hex text, but console-output packets can carry
 * escaped bytes, so the parser unescapes uniformly instead of relying on the
 * reply kind.
 */
export function unescapeRsp(payload: string): string {
  if (!payload.includes('}')) return payload
  const out: string[] = []
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i] as string
    if (ch === '}' && i + 1 < payload.length) {
      out.push(String.fromCharCode((payload.charCodeAt(i + 1) & 0xff) ^ 0x20))
      i += 1
      continue
    }
    out.push(ch)
  }
  return out.join('')
}

/**
 * Encode a memory read as an `m` packet body.
 *
 * Addresses are sent as unsigned hex: a negative JS number would otherwise
 * serialize as `-1`, which no stub accepts.
 */
export function memoryReadBody(address: number, length: number): string {
  const addr = (address >>> 0).toString(16)
  const len = Math.max(0, Math.trunc(length)).toString(16)
  return `m${addr},${len}`
}

/**
 * Decode an `m` reply into bytes.
 *
 * @throws when the stub answered with an error (`E NN`) or with text that is
 *   not an even-length hex string — a silent zero-fill would plot a lie.
 */
export function decodeMemoryReply(payload: string): Uint8Array {
  if (payload.startsWith('E') && payload.length <= 4) {
    throw new Error(`target refused the memory read (${payload})`)
  }
  if (payload.length === 0) return new Uint8Array(0)
  if (payload.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(payload)) {
    throw new Error(`malformed memory reply: ${JSON.stringify(payload.slice(0, 32))}`)
  }
  const out = new Uint8Array(payload.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(payload.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export class RspClient extends EventEmitter<RspEvents> {
  private socket?: Socket
  /**
   * Unparsed wire bytes.
   *
   * Typed as `Buffer<ArrayBufferLike>` because `subarray`/`concat` widen the
   * backing store; pinning it to `Buffer<ArrayBuffer>` makes every slice a type
   * error under `@types/node` 24.
   */
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private pending?: Pending
  private readonly options: RspOptions
  private readonly timeoutMs: number
  private closed = true
  /** Whether the stub agreed to `QStartNoAckMode`. */
  private noAck = false

  public constructor(options: RspOptions) {
    super()
    this.options = options
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  public get connected(): boolean {
    return this.socket !== undefined && !this.closed
  }

  public get ackMode(): 'ack' | 'noack' {
    return this.noAck ? 'noack' : 'ack'
  }

  /** Open the connection and negotiate no-ack mode. */
  public async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.options.host, port: this.options.port })
      const timer = setTimeout(() => {
        socket.removeAllListeners()
        socket.destroy()
        reject(new Error(`GDB connect timeout after ${this.timeoutMs} ms`))
      }, this.timeoutMs)

      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.destroy()
        reject(error)
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
          this.failPending(new Error('GDB connection closed'))
          this.emit('close')
        })
        resolve()
      })
    })

    if (this.options.noAckMode === false) return
    try {
      // The stub may or may not support it; a refusal ("") is not fatal.
      const reply = await this.cmd('QStartNoAckMode')
      if (reply === 'OK') this.noAck = true
    } catch {
      this.noAck = false
    }
  }

  public close(): void {
    const socket = this.socket
    this.socket = undefined
    this.closed = true
    if (socket !== undefined) {
      socket.removeAllListeners()
      socket.destroy()
    }
    this.failPending(new Error('GDB client closed'))
  }

  /** Send one packet and await the reply payload. */
  public cmd(body: string): Promise<string> {
    const socket = this.socket
    if (socket === undefined) throw new Error('GDB client is not connected')
    if (this.pending !== undefined) throw new Error('GDB client already has a request in flight')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined
        reject(new Error(`GDB request timed out: ${body.slice(0, 32)}`))
      }, this.timeoutMs)
      this.pending = { resolve, reject, timer }
      socket.write(framePacket(body))
    })
  }

  /**
   * Read target memory.
   * @returns exactly `length` bytes, or fewer when the stub truncates at the
   *   end of a readable region (the caller decides whether that is a gap).
   */
  public async readMemory(address: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0)
    const reply = await this.cmd(memoryReadBody(address, length))
    return decodeMemoryReply(reply)
  }

  /* ────────────────────────────── wire parsing ────────────────────────────── */

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    for (;;) {
      // Skip anything before a packet start: stray acks, stub banner text.
      const start = this.buffer.indexOf(PACKET_START)
      if (start === -1) {
        this.buffer = Buffer.alloc(0)
        return
      }
      if (start > 0) this.buffer = this.buffer.subarray(start)
      const end = this.buffer.indexOf(PACKET_END)
      if (end === -1) return
      // Need two checksum characters after '#'.
      if (this.buffer.length < end + 3) return

      const body = this.buffer.subarray(1, end).toString('latin1')
      const checksum = this.buffer.subarray(end + 1, end + 3).toString('latin1').toLowerCase()
      this.buffer = this.buffer.subarray(end + 3) as Buffer

      const valid = checksum === rspChecksum(body)
      if (!this.noAck) {
        // Ack good packets, Nak corrupt ones so the stub retransmits.
        this.socket?.write(Buffer.from([valid ? ACK : NAK]))
      }
      if (!valid) continue

      // Console output shares the stream with replies and is never the answer.
      //
      // The discriminator is NOT "starts with O": `OK` (the reply to
      // QStartNoAckMode) also starts with O, and treating it as console output
      // dropped the acknowledgement, so every connect() sat out its full
      // timeout in ack mode. A real `O` packet carries an EVEN number of HEX
      // digits after the marker; `OK` carries `K`, which is not a hex digit.
      if (isConsoleOutput(body)) continue
      if (body.startsWith('%')) continue

      const pending = this.pending
      if (pending === undefined) continue
      this.pending = undefined
      clearTimeout(pending.timer)
      pending.resolve(unescapeRsp(body))
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

/** Bytes of one RSP control sequence, exported for tests. */
export const RSP_BYTES = { PACKET_START, PACKET_END, ACK, NAK, NOTIFY } as const
