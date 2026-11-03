/**
 * Minimal RFC 6455 WebSocket server.
 *
 * The plugin streams two live feeds to the browser and needs nothing beyond the
 * handshake, text frames, ping/pong and close — so it implements those directly
 * instead of taking a dependency. That keeps the host half dependency-free
 * (spec C1/C3 context: no runtime dependency is installed for this plugin).
 *
 * Deliberately NOT implemented, because nothing here needs them: extensions
 * (`permessage-deflate`), subprotocols, fragmented message reassembly beyond
 * continuation frames, and client-side masking (a server never masks).
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** The fixed GUID from RFC 6455 §1.3. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Opcodes this server understands. */
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Refuse absurd frames rather than allocating for them. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  ping(): void
  close(): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'message', listener: (data: string) => void): void
}

/** `readyState` values, matching the browser API. */
export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

/**
 * One upgraded socket.
 *
 * Incoming frames are parsed incrementally: a frame may arrive split across
 * several TCP reads, so a byte buffer is retained until a whole frame is
 * available.
 */
export class ServerWebSocket implements WebSocketLike {
  private buffer: Buffer = Buffer.alloc(0)
  private state = WS_CONNECTING
  private readonly closeListeners: (() => void)[] = []
  private readonly errorListeners: ((error: Error) => void)[] = []
  private readonly messageListeners: ((data: string) => void)[] = []

  public constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => this.markClosed())
    this.state = WS_OPEN
  }

  public get readyState(): number {
    return this.state
  }

  public on(event: 'close' | 'error' | 'message', listener: ((error: Error) => void) | ((data: string) => void) | (() => void)): void {
    if (event === 'close') this.closeListeners.push(listener as () => void)
    else if (event === 'error') this.errorListeners.push(listener as (error: Error) => void)
    else this.messageListeners.push(listener as (data: string) => void)
  }

  /** Send a text frame (never masked — this is the server side). */
  public send(data: string): void {
    if (this.state !== WS_OPEN) return
    this.writeFrame(OP_TEXT, Buffer.from(data, 'utf8'))
  }

  public ping(): void {
    if (this.state !== WS_OPEN) return
    this.writeFrame(OP_PING, Buffer.alloc(0))
  }

  /** Send a close frame and end the socket. */
  public close(): void {
    if (this.state === WS_CLOSED || this.state === WS_CLOSING) return
    this.state = WS_CLOSING
    try {
      this.writeFrame(OP_CLOSE, Buffer.alloc(0))
    } catch {
      // The socket may already be gone; the end() below still settles it.
    }
    this.socket.end()
    this.markClosed()
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const length = payload.length
    let header: Buffer
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = length
    } else if (length < 65_536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode   // FIN set: every message we send is unfragmented
    this.socket.write(Buffer.concat([header, payload]))
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (frame === undefined) return
      const { opcode, payload } = frame
      if (opcode === OP_CLOSE) {
        this.close()
        return
      }
      if (opcode === OP_PING) {
        this.writeFrame(OP_PONG, payload)
        continue
      }
      if (opcode === OP_PONG) continue
      if (opcode === OP_TEXT || opcode === OP_BINARY || opcode === OP_CONTINUATION) {
        const text = payload.toString('utf8')
        for (const listener of this.messageListeners) listener(text)
      }
    }
  }

  /**
   * Try to pull one complete frame off the buffer.
   * @returns the frame, or `undefined` when more bytes are needed.
   * @throws when the frame violates the protocol.
   */
  private readFrame(): { opcode: number; payload: Buffer } | undefined {
    if (this.buffer.length < 2) return undefined
    const first = this.buffer[0] as number
    const second = this.buffer[1] as number
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2

    if (length === 126) {
      if (this.buffer.length < offset + 2) return undefined
      length = this.buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return undefined
      const big = this.buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_PAYLOAD_BYTES)) throw new Error('websocket frame too large')
      length = Number(big)
      offset += 8
    }
    if (length > MAX_PAYLOAD_BYTES) throw new Error('websocket frame too large')

    // Clients MUST mask; unmasked client frames are a protocol error.
    let maskKey: Buffer | undefined
    if (masked) {
      if (this.buffer.length < offset + 4) return undefined
      maskKey = this.buffer.subarray(offset, offset + 4)
      offset += 4
    } else if (opcode !== OP_CLOSE) {
      throw new Error('client frame is not masked')
    }

    if (this.buffer.length < offset + length) return undefined
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
    if (maskKey !== undefined) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] as number) ^ (maskKey[i % 4] as number)
      }
    }
    this.buffer = this.buffer.subarray(offset + length)
    return { opcode, payload }
  }

  private fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
    this.markClosed()
  }

  private markClosed(): void {
    if (this.state === WS_CLOSED) return
    this.state = WS_CLOSED
    for (const listener of this.closeListeners) listener()
  }
}

/**
 * Complete the WebSocket handshake over an upgraded socket.
 *
 * @returns the live socket, or `undefined` when the request is not a valid
 *   WebSocket upgrade (the caller should then destroy the socket).
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): ServerWebSocket | undefined {
  const key = req.headers['sec-websocket-key']
  const upgrade = req.headers.upgrade?.toLowerCase()
  if (upgrade !== 'websocket' || typeof key !== 'string' || key === '') {
    return undefined
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n',
  )
  return new ServerWebSocket(socket)
}
