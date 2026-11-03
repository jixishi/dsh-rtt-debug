/**
 * J-Link memory reader — the `driver: 'jlink'` counterpart of `OcdReader`.
 *
 * Same contract (poll a set of address bindings, verify coherence, batch nearby
 * reads), different transport: instead of OpenOCD's TCL `mdw`, this reads
 * target memory over the GDB remote serial protocol served by JLinkGDBServer.
 *
 * Batching is expressed directly in bytes rather than words: RSP's `m` packet
 * takes a byte count, so a run of nearby bindings becomes one exact-length read
 * instead of a word-rounded one. That is strictly less traffic than the TCL
 * path for narrow values.
 *
 * Coherence keeps the same policy as the OpenOCD reader: `verifyConsistency`
 * reads twice and turns a value that moved between the two reads into a gap,
 * because a torn sample is worse than a missing one.
 */

import { EventEmitter } from 'node:events'
import { bindingWidth } from '../ocd/symbols.ts'
import { SCALAR_BYTES } from '../core/types.ts'
import type { Sample, ScalarType, SymbolBinding } from '../core/types.ts'
import { RspClient } from './rsp.ts'

/** Alias kept local so the reader's contract reads naturally. */
export type JLinkBinding = SymbolBinding

export interface JLinkReaderOptions {
  host: string
  /** The GDB port J-Link is listening on. */
  port: number
  /** Poll period in ms (100 → 10 Hz). */
  intervalMs?: number
  /** Read each value twice and drop the sample when they differ. Default true. */
  verifyConsistency?: boolean
  /**
   * Merge bindings no further apart than this many bytes into one read.
   * `0` disables batching. Default 64.
   */
  batchDistanceBytes?: number
  /** Per-request timeout in ms. */
  commandTimeoutMs?: number
}

export interface JLinkReaderEvents {
  samples: [samples: Sample[]]
  error: [error: Error]
  status: [status: JLinkReaderStatus]
}

export type JLinkReaderStatus =
  | { kind: 'idle' }
  | { kind: 'running'; polls: number; failures: number; tornDropped: number }
  | { kind: 'error'; message: string }

/** One merged read: a base address plus the byte span it covers. */
interface ReadBatch {
  base: number
  /** Bytes to request. */
  length: number
  /** Bindings served by this batch, with their offset from `base`. */
  members: { binding: JLinkBinding; offset: number }[]
}

/**
 * Group bindings into as few memory reads as possible.
 *
 * Batches are formed over ascending addresses and closed when the gap to the
 * next binding exceeds `maxDistance` — merging across a huge gap would read far
 * more memory than the variables actually need.
 */
export function planReadBatches(bindings: readonly JLinkBinding[], maxDistance: number): ReadBatch[] {
  if (bindings.length === 0) return []
  const sorted = [...bindings].sort((a, b) => a.address - b.address)
  const batches: ReadBatch[] = []

  let current: ReadBatch | undefined
  let currentEnd = 0
  for (const binding of sorted) {
    const width = bindingWidth(binding)
    const start = binding.address
    const end = start + width
    const gap = start - currentEnd
    if (current !== undefined && maxDistance > 0 && gap <= maxDistance) {
      current.members.push({ binding, offset: start - current.base })
      currentEnd = Math.max(currentEnd, end)
      current.length = currentEnd - current.base
      continue
    }
    current = { base: start, length: width, members: [{ binding, offset: 0 }] }
    currentEnd = end
    batches.push(current)
  }
  return batches
}

/**
 * Extract one value from a raw byte window.
 *
 * Bytes arrive little-endian from the target (Cortex-M native); a binding
 * marked `big` reverses them. Takes the value from its own byte offset, so a
 * `u8` at an unaligned address decodes correctly.
 */
export function decodeBindingBytes(bytes: Uint8Array, offsetBytes: number, binding: JLinkBinding): number | boolean {
  const width = bindingWidth(binding)
  if (offsetBytes < 0 || offsetBytes + width > bytes.length) {
    throw new Error(`read came up short for "${binding.name}"`)
  }
  const slice = new Uint8Array(bytes.subarray(offsetBytes, offsetBytes + width))
  if (binding.endianness === 'big') slice.reverse()
  const view = new DataView(slice.buffer, slice.byteOffset, slice.byteLength)
  return readValue(view, binding.type)
}

function readValue(view: DataView, type: ScalarType): number | boolean {
  switch (type) {
    case 'i8': return view.getInt8(0)
    case 'u8': return view.getUint8(0)
    case 'i16': return view.getInt16(0, true)
    case 'u16': return view.getUint16(0, true)
    case 'i32': return view.getInt32(0, true)
    case 'u32': return view.getUint32(0, true)
    case 'f32': return view.getFloat32(0, true)
    case 'f64': return view.getFloat64(0, true)
    case 'bool': return view.getUint8(0) !== 0
  }
}

/**
 * Poll a set of memory bindings over J-Link's GDB server and emit samples.
 *
 * Emits one `samples` event per poll cycle containing every binding read
 * successfully, so a failed or torn binding becomes a gap in its own series
 * rather than a hole in the whole cycle.
 */
export class JLinkReader extends EventEmitter<JLinkReaderEvents> {
  private readonly options: Required<JLinkReaderOptions>
  private rsp?: RspClient
  private timer?: NodeJS.Timeout
  private bindings: JLinkBinding[] = []
  private running = false
  private busy = false
  private polls = 0
  private failures = 0
  private tornDropped = 0

  public constructor(options: JLinkReaderOptions) {
    super()
    this.options = {
      intervalMs: 100,
      verifyConsistency: true,
      batchDistanceBytes: 64,
      commandTimeoutMs: 5000,
      ...options,
    }
  }

  public status(): JLinkReaderStatus {
    if (this.rsp === undefined || !this.running) return { kind: 'idle' }
    return { kind: 'running', polls: this.polls, failures: this.failures, tornDropped: this.tornDropped }
  }

  /** Replace the binding set (safe while running). */
  public setBindings(bindings: readonly JLinkBinding[]): void {
    this.bindings = [...bindings]
  }

  public getBindings(): JLinkBinding[] {
    return [...this.bindings]
  }

  /** The negotiated acknowledgement mode, for diagnostics. */
  public get ackMode(): 'ack' | 'noack' | undefined {
    return this.rsp?.ackMode
  }

  /** Connect the GDB session and begin polling. */
  public async start(): Promise<void> {
    if (this.running) return
    const rsp = new RspClient({
      host: this.options.host,
      port: this.options.port,
      timeoutMs: this.options.commandTimeoutMs,
    })
    await rsp.connect()
    rsp.on('error', (error: Error) => this.emit('error', error))
    this.rsp = rsp
    this.running = true
    this.polls = 0
    this.failures = 0
    this.tornDropped = 0
    this.schedule()
    this.emit('status', this.status())
  }

  /** Stop polling and close the GDB session. */
  public stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.rsp?.close()
    this.rsp = undefined
    this.emit('status', this.status())
  }

  private schedule(): void {
    if (!this.running) return
    const delay = Math.max(1, Math.round(this.options.intervalMs))
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, delay)
  }

  /**
   * One poll cycle.
   *
   * Re-entrancy is guarded: a slow cycle skips its next slot instead of
   * stacking up requests the target cannot answer any faster.
   */
  public async tick(): Promise<void> {
    if (this.busy) return
    const rsp = this.rsp
    if (rsp === undefined || this.bindings.length === 0) return

    this.busy = true
    try {
      const values = await this.readAll(rsp)
      this.polls += 1
      if (Object.keys(values).length > 0) {
        this.emit('samples', [{ ts: Date.now(), values }])
      }
      this.emit('status', this.status())
    } catch (error) {
      this.failures += 1
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit('error', err)
      this.emit('status', { kind: 'error', message: err.message })
    } finally {
      this.busy = false
    }
  }

  /** Read every binding, honouring batching and the consistency check. */
  private async readAll(rsp: RspClient): Promise<Record<string, number | boolean>> {
    const batches = planReadBatches(this.bindings, this.options.batchDistanceBytes)
    const values: Record<string, number | boolean> = {}

    for (const batch of batches) {
      const first = await rsp.readMemory(batch.base, batch.length)
      let second: Uint8Array | undefined
      if (this.options.verifyConsistency) {
        second = await rsp.readMemory(batch.base, batch.length)
      }

      for (const member of batch.members) {
        try {
          const value = decodeBindingBytes(first, member.offset, member.binding)
          if (second !== undefined) {
            const again = decodeBindingBytes(second, member.offset, member.binding)
            if (!sameValue(value, again)) {
              // The target moved between reads: report a gap, not a guess.
              this.tornDropped += 1
              continue
            }
          }
          values[member.binding.name] = value
        } catch {
          // A short read for one member must not lose the rest of the batch.
          this.failures += 1
        }
      }
    }
    return values
  }
}

/** NaN-aware equality (a float read that stays NaN is stable, not torn). */
function sameValue(a: number | boolean, b: number | boolean): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  return a === b
}

/** Byte width of a scalar, re-exported for callers that build bindings. */
export { SCALAR_BYTES }
