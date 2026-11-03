/**
 * OCD memory reader: the third data source.
 *
 * Samples configured target-memory locations through OpenOCD's TCL interface.
 * Unlike the RTT channels this needs no cooperation from the firmware at all —
 * which is exactly why it exists (a variable can be watched on a target that
 * was never instrumented for it).
 *
 * Two properties shape the implementation:
 *
 *   - **Coherence.** A target that keeps running can update a multi-byte
 *     variable between the bytes of one read, yielding a value that never
 *     existed. `verifyConsistency` reads twice and rejects the sample when the
 *     two differ, so a torn value becomes a gap instead of a lie.
 *   - **Round-trip cost.** Every TCL command is a network round trip. Bindings
 *     that live near each other are merged into one `mdw` and sliced locally,
 *     which turns N round trips into one for the common case of a struct.
 */

import { EventEmitter } from 'node:events'
import { OcdTcl } from './tcl.ts'
import { bindingWidth } from './symbols.ts'
import { SCALAR_BYTES } from '../core/types.ts'
import type { Sample, ScalarType, SymbolBinding } from '../core/types.ts'

/** Alias kept local so the reader's contract reads naturally. */
export type OcdBinding = SymbolBinding

export interface OcdReaderOptions {
  host: string
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
  /** Per-command TCL timeout in ms. */
  commandTimeoutMs?: number
}

export interface OcdReaderEvents {
  samples: [samples: Sample[]]
  error: [error: Error]
  status: [status: OcdReaderStatus]
}

export type OcdReaderStatus =
  | { kind: 'idle' }
  | { kind: 'running'; polls: number; failures: number; tornDropped: number }
  | { kind: 'error'; message: string }

/** One merged read: a base address plus the span it covers. */
interface ReadBatch {
  base: number
  /** Words (4 bytes each) to request. */
  words: number
  /** Bindings served by this batch, with their offset from `base`. */
  members: { binding: OcdBinding; offset: number }[]
}

/**
 * Group bindings into as few `mdw` reads as possible.
 *
 * Everything is read as 32-bit words because that is the cheapest OpenOCD
 * primitive; narrower values are sliced out of the word afterwards. Batches are
 * formed over ascending addresses and closed when the gap to the next binding
 * exceeds `maxDistance` — merging across a huge gap would read far more memory
 * than the variables actually need.
 */
export function planReadBatches(bindings: readonly OcdBinding[], maxDistance: number): ReadBatch[] {
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
      const offset = start - current.base
      current.members.push({ binding, offset })
      currentEnd = Math.max(currentEnd, end)
      current.words = Math.ceil((currentEnd - current.base) / 4)
      continue
    }
    current = { base: start, words: Math.ceil(width / 4), members: [{ binding, offset: 0 }] }
    currentEnd = end
    batches.push(current)
  }
  return batches
}

/**
 * Extract one value from a word array.
 *
 * `bytes` are assembled little-endian by default (Cortex-M native); a binding
 * marked `big` reverses them. Narrower-than-word values are taken from the
 * correct byte lane rather than always from the low bytes, so a `u8` at an
 * unaligned address decodes correctly.
 */
export function decodeBinding(words: readonly number[], offsetBytes: number, binding: OcdBinding): number | boolean {
  const width = bindingWidth(binding)
  const wordIndex = Math.floor(offsetBytes / 4)
  const lane = offsetBytes % 4
  const first = words[wordIndex]
  if (first === undefined) throw new Error(`read came up short for "${binding.name}"`)
  const second = words[wordIndex + 1]

  // Assemble a little-endian byte array of exactly `width` bytes.
  const bytes = new Uint8Array(width)
  for (let i = 0; i < width; i += 1) {
    const absoluteLane = lane + i
    const word = absoluteLane < 4 ? first : second
    if (word === undefined) throw new Error(`read came up short for "${binding.name}"`)
    bytes[i] = (word >>> ((absoluteLane % 4) * 8)) & 0xff
  }
  if (binding.endianness === 'big') bytes.reverse()

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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
 * Poll a set of memory bindings and emit samples.
 *
 * Emits one `samples` event per poll cycle containing every binding that was
 * read successfully, so a failed or torn binding becomes a gap in its own
 * series rather than a hole in the whole cycle.
 */
export class OcdReader extends EventEmitter<OcdReaderEvents> {
  private readonly options: Required<OcdReaderOptions>
  private tcl?: OcdTcl
  private timer?: NodeJS.Timeout
  private bindings: OcdBinding[] = []
  private running = false
  private busy = false
  private polls = 0
  private failures = 0
  private tornDropped = 0

  public constructor(options: OcdReaderOptions) {
    super()
    this.options = {
      intervalMs: 100,
      verifyConsistency: true,
      batchDistanceBytes: 64,
      commandTimeoutMs: 5000,
      ...options,
    }
  }

  public status(): OcdReaderStatus {
    if (this.tcl === undefined) return { kind: 'idle' }
    if (!this.running) return { kind: 'idle' }
    return { kind: 'running', polls: this.polls, failures: this.failures, tornDropped: this.tornDropped }
  }

  /** Replace the binding set (safe while running). */
  public setBindings(bindings: readonly OcdBinding[]): void {
    this.bindings = [...bindings]
  }

  public getBindings(): OcdBinding[] {
    return [...this.bindings]
  }

  /** Connect the TCL session and begin polling. */
  public async start(): Promise<void> {
    if (this.running) return
    const tcl = new OcdTcl({
      host: this.options.host,
      port: this.options.port,
      timeoutMs: this.options.commandTimeoutMs,
    })
    await tcl.connect()
    this.tcl = tcl
    this.running = true
    this.polls = 0
    this.failures = 0
    this.tornDropped = 0
    this.schedule()
    this.emit('status', this.status())
  }

  /** Stop polling and close the TCL session. */
  public stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.tcl?.close()
    this.tcl = undefined
    this.emit('status', this.status())
  }

  private schedule(): void {
    if (!this.running) return
    const delay = Math.max(1, Math.round(this.options.intervalMs ?? 100))
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
    const tcl = this.tcl
    if (tcl === undefined || this.bindings.length === 0) return

    this.busy = true
    try {
      const values = await this.readAll(tcl)
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
  private async readAll(tcl: OcdTcl): Promise<Record<string, number | boolean>> {
    const batches = planReadBatches(this.bindings, this.options.batchDistanceBytes)
    const values: Record<string, number | boolean> = {}

    for (const batch of batches) {
      const first = await tcl.readWords(batch.base, batch.words)
      let second: number[] | undefined
      if (this.options.verifyConsistency) {
        second = await tcl.readWords(batch.base, batch.words)
      }

      for (const member of batch.members) {
        try {
          const value = decodeBinding(first, member.offset, member.binding)
          if (second !== undefined) {
            const again = decodeBinding(second, member.offset, member.binding)
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
