/**
 * Binary-frame variable parser for the RTT data channel.
 *
 * For targets that stream packed structs rather than text. Framing is either a
 * fixed frame length, or a length field inside the frame (useful when the
 * target sends variable payload sizes).
 *
 * The field layout is declared explicitly — a parser cannot guess a C struct
 * layout, and inferring one would silently mis-decode every field after the
 * first mismatch. Both endiannesses are supported; little is the default.
 */
import { FixedFrameSplitter } from '../core/framing.ts'
import { SCALAR_BYTES } from '../core/types.ts'
import type { Sample, ScalarType, VariableDescriptor, VariableProvider } from '../core/types.ts'

/** One field inside a binary frame. */
export interface BinaryField {
  name: string
  type: ScalarType
  /** Byte offset within the frame; defaults to running layout order. */
  offset?: number
  /** Optional engineering unit. */
  unit?: string
}

export interface BinaryFrameOptions {
  /** Fixed frame length in bytes. Ignored when `lengthField` is set. */
  frameLength?: number
  /** Read the frame length from inside the frame itself. */
  lengthField?: { offset: number; size: 1 | 2 | 4; includesHeader?: boolean }
  /** Default endianness for every field. Default `little`. */
  endianness?: 'little' | 'big'
  /** Declared field layout. */
  fields?: BinaryField[]
  /** Optional constant prefix the frame must start with (a magic word). */
  magic?: number[] | string
}

/** Reads one scalar out of a DataView with explicit endianness. */
function readScalar(view: DataView, offset: number, type: ScalarType, little: boolean): number | boolean {
  switch (type) {
    case 'i8': return view.getInt8(offset)
    case 'u8': return view.getUint8(offset)
    case 'i16': return view.getInt16(offset, little)
    case 'u16': return view.getUint16(offset, little)
    case 'i32': return view.getInt32(offset, little)
    case 'u32': return view.getUint32(offset, little)
    case 'f32': return view.getFloat32(offset, little)
    case 'f64': return view.getFloat64(offset, little)
    case 'bool': return view.getUint8(offset) !== 0
  }
}

export class BinaryFrameParser implements VariableProvider {
  public readonly id = 'binary-frame'

  private frames = new FixedFrameSplitter(4)
  private lengthField?: { offset: number; size: 1 | 2 | 4; includesHeader: boolean }
  private little = true
  private fields: BinaryField[] = []
  private magic?: Uint8Array
  private growable: Uint8Array = new Uint8Array(0)
  private descriptorsCache: VariableDescriptor[] = []

  public configure(options: Record<string, unknown>): void {
    if (typeof options['endianness'] === 'string') {
      this.little = options['endianness'] !== 'big'
    }
    if (Array.isArray(options['fields'])) {
      this.fields = options['fields'].filter((f): f is BinaryField => {
        if (typeof f !== 'object' || f === null) return false
        const rec = f as Record<string, unknown>
        return typeof rec['name'] === 'string' && typeof rec['type'] === 'string' && rec['type'] in SCALAR_BYTES
      })
    }
    if (options['magic'] !== undefined) {
      this.magic = normalizeMagic(options['magic'])
    }
    const lf = options['lengthField']
    if (typeof lf === 'object' && lf !== null) {
      const rec = lf as Record<string, unknown>
      const size = rec['size']
      const offset = rec['offset']
      if (typeof offset === 'number' && (size === 1 || size === 2 || size === 4)) {
        this.lengthField = { offset, size, includesHeader: rec['includesHeader'] !== false }
      }
    }
    if (typeof options['frameLength'] === 'number' && options['frameLength'] > 0) {
      this.frames.setFrameLength(Math.floor(options['frameLength']))
    }
    this.refreshDescriptors()
  }

  public feed(chunk: Uint8Array): Sample[] {
    // Length-field framing needs a byte-level scan; fixed framing is bulk.
    if (this.lengthField !== undefined) return this.feedLengthPrefixed(chunk)

    const out: Sample[] = []
    for (const frame of this.frames.push(chunk)) {
      const sample = this.decode(frame)
      if (sample !== undefined) out.push(sample)
    }
    return out
  }

  private feedLengthPrefixed(chunk: Uint8Array): Sample[] {
    const lf = this.lengthField
    if (lf === undefined) return []
    const merged = new Uint8Array(this.growable.length + chunk.length)
    merged.set(this.growable, 0)
    merged.set(chunk, this.growable.length)
    this.growable = merged

    const out: Sample[] = []
    for (;;) {
      const headerBytes = lf.offset + lf.size
      if (this.growable.length < headerBytes) break
      const view = new DataView(this.growable.buffer, this.growable.byteOffset, this.growable.byteLength)
      let declared: number
      if (lf.size === 1) declared = view.getUint8(lf.offset)
      else if (lf.size === 2) declared = view.getUint16(lf.offset, this.little)
      else declared = view.getUint32(lf.offset, this.little)

      const total = lf.includesHeader ? declared : declared + headerBytes
      if (total <= 0 || total > (1 << 20)) {
        // Nonsense length: drop one byte and resync rather than allocating.
        this.growable = this.growable.subarray(1)
        continue
      }
      if (this.growable.length < total) break
      const frame = this.growable.subarray(0, total)
      const sample = this.decode(frame)
      if (sample !== undefined) out.push(sample)
      this.growable = this.growable.subarray(total)
    }
    // Copy out of the view chain so the retained tail never pins a huge buffer.
    this.growable = new Uint8Array(this.growable)
    return out
  }

  private decode(frame: Uint8Array): Sample | undefined {
    if (this.magic !== undefined) {
      if (frame.length < this.magic.length) return undefined
      for (let i = 0; i < this.magic.length; i += 1) {
        if (frame[i] !== this.magic[i]) return undefined
      }
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const values: Record<string, number | boolean> = {}
    // Auto layout starts after the magic prefix: the prefix occupies real
    // bytes at the head of the frame, so field 0 does not begin at offset 0.
    let auto = this.magic?.length ?? 0
    for (const field of this.fields) {
      const width = SCALAR_BYTES[field.type]
      let offset = field.offset
      if (offset === undefined) {
        offset = auto
      }
      auto = offset + width
      if (offset + width > frame.length) return undefined
      values[field.name] = readScalar(view, offset, field.type, this.little)
    }
    if (Object.keys(values).length === 0) return undefined
    return { ts: Date.now(), values }
  }

  private refreshDescriptors(): void {
    this.descriptorsCache = this.fields.map((field, index) => {
      const kind: 'number' | 'bool' = field.type === 'bool' ? 'bool' : 'number'
      const base = { name: field.name, kind, source: 'rttVar' as const, index }
      return field.unit === undefined ? base : { ...base, unit: field.unit }
    })
  }

  public descriptors(): VariableDescriptor[] {
    return this.descriptorsCache
  }

  public reset(): void {
    this.frames.reset()
    this.growable = new Uint8Array(0)
  }
}

/**
 * Accepts `"AA 55"`, `"0xAA,0x55"`, `"aa55"`, or `[0xAA, 0x55]` as a magic prefix.
 *
 * Bare two-digit hex is the common way people write a magic word, so a token
 * that is exactly two hex digits is read as hex rather than decimal — reading
 * `"AA"` as decimal yields NaN and would silently disable the filter, which is
 * the one failure mode a magic check must never have.
 */
function normalizeMagic(raw: unknown): Uint8Array | undefined {
  const toByte = (token: string): number | undefined => {
    const text = token.trim()
    if (text === '') return undefined
    if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
      const n = Number.parseInt(text.slice(2), 16)
      return Number.isNaN(n) ? undefined : n & 0xff
    }
    if (/^[0-9a-fA-F]{2}$/.test(text)) {
      // Two hex digits: treat as hex (the far more likely intent).
      return Number.parseInt(text, 16) & 0xff
    }
    if (/^\d{1,3}$/.test(text)) {
      const n = Number.parseInt(text, 10)
      return n > 255 ? undefined : n
    }
    // A longer bare hex run such as `aa55` — split into byte pairs.
    if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
      const first = Number.parseInt(text.slice(0, 2), 16)
      return Number.isNaN(first) ? undefined : first & 0xff
    }
    return undefined
  }

  if (typeof raw === 'string') {
    const compact = raw.trim()
    // A contiguous hex run without separators, e.g. `aa55`.
    if (/^[0-9a-fA-F]+$/.test(compact) && compact.length > 2 && compact.length % 2 === 0) {
      const bytes: number[] = []
      for (let i = 0; i < compact.length; i += 2) {
        bytes.push(Number.parseInt(compact.slice(i, i + 2), 16) & 0xff)
      }
      return bytes.length === 0 ? undefined : Uint8Array.from(bytes)
    }
    const parsed = compact
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(toByte)
      .filter((b): b is number => b !== undefined)
    return parsed.length === 0 ? undefined : Uint8Array.from(parsed)
  }
  if (Array.isArray(raw)) {
    const clean = raw.filter((b): b is number => typeof b === 'number').map(b => b & 0xff)
    return clean.length === 0 ? undefined : Uint8Array.from(clean)
  }
  return undefined
}
