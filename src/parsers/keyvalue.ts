/**
 * `key=value` variable parser for the RTT data channel.
 *
 * Accepts one pair per line (`Volt=12007`) and several pairs per line
 * (`Volt=12007 Cycles=3`), with `=` or `:` as the separator, optional
 * surrounding whitespace, and an optional unit suffix on the value.
 *
 * Unlike the CSV parser — where a row is one sample — each *pair* here is its
 * own sample timestamped when it was parsed. That matches how firmware tends
 * to emit key/value streams: fields become available at different times, and a
 * consumer reading only `Volt` should not be forced to wait for the slower
 * fields of the same logical group.
 */
import { LineSplitter, decodeTerminator } from '../core/framing.ts'
import type { Sample, VariableDescriptor, VariableProvider } from '../core/types.ts'

export interface KeyValueOptions {
  /** Split several pairs on one line. Default `true`. */
  multiplePerLine?: boolean
  /** Optional explicit separator (`=` or `:`); when omitted both are accepted. */
  separator?: string
}

/**
 * `name=12007 mV`, `name: 3`, `flag=true`, `12007mV`.
 *
 * The unit group needs two guards, and leaving either out silently eats the
 * NEXT pair's key: `volt=12007 amps=3` would otherwise parse `amps` as volt's
 * unit and lose the `amps` pair entirely.
 *
 *   (?![A-Za-z0-9µΩ%°/])  the candidate token must be maximal — without it the
 *                         engine backtracks to `amp` and accepts that instead
 *   (?!\s*[:=])           and it must not be followed by a pair separator
 *
 * Units written flush against the number (`12007mV`) always survive, so a
 * target that omits the space is unaffected.
 */
const PAIR = /([A-Za-z_][A-Za-z0-9_.\-[\]$]*)\s*[:=]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµΩ%°/][A-Za-zµΩ%°/0-9]*)?(?![A-Za-z0-9µΩ%°/])(?!\s*[:=])/g

/** Boolean spellings a target may print. */
const TRUE_WORDS = new Set(['true', 'on', 'yes', 'high'])
const FALSE_WORDS = new Set(['false', 'off', 'no', 'low'])

const BOOL_PAIR = /([A-Za-z_][A-Za-z0-9_.\-[\]$]*)\s*[:=]\s*(true|false|on|off|yes|no|high|low)\b/gi

export class KeyValueParser implements VariableProvider {
  public readonly id = 'keyvalue'

  private multiplePerLine = true
  private separator?: string

  private readonly lines = new LineSplitter()
  private units = new Map<string, string>()
  private kinds = new Map<string, 'number' | 'bool'>()
  private order: string[] = []
  private descriptorsCache: VariableDescriptor[] = []

  public configure(options: Record<string, unknown>): void {
    if (typeof options['multiplePerLine'] === 'boolean') {
      this.multiplePerLine = options['multiplePerLine']
    }
    if (typeof options['separator'] === 'string' && options['separator'] !== '') {
      this.separator = options['separator']
    }
    // Editable record terminator; see `decodeTerminator`.
    if (typeof options['lineTerminator'] === 'string' && options['lineTerminator'] !== '') {
      this.lines.setTerminator(decodeTerminator(options['lineTerminator']))
    }
  }

  public feed(chunk: Uint8Array): Sample[] {
    const out: Sample[] = []
    for (const line of this.lines.push(chunk)) {
      if (line.trim() === '') continue
      out.push(...this.parseLine(line))
    }
    return out
  }

  private parseLine(line: string): Sample[] {
    const values: Record<string, number | boolean> = {}
    const unitsSeen: Record<string, string> = {}

    // Booleans first: the numeric pattern would otherwise skip them silently.
    for (const m of line.matchAll(BOOL_PAIR)) {
      const name = m[1]
      const word = m[2]?.toLowerCase()
      if (name === undefined || word === undefined) continue
      const value = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : undefined
      if (value === undefined) continue
      values[name] = value
      this.kinds.set(name, 'bool')
      this.noteName(name)
    }

    const pattern = new RegExp(PAIR.source, PAIR.flags)
    for (const m of line.matchAll(pattern)) {
      const name = m[1]
      if (name === undefined) continue
      if (this.separator !== undefined) {
        // Enforce the configured separator by re-checking the raw match.
        const between = m[0].slice(name.length)
        if (!between.trimStart().startsWith(this.separator)) continue
      }
      const value = Number(m[2])
      if (Number.isNaN(value)) continue
      values[name] = value
      const unit = m[3]
      if (unit !== undefined && !unitsSeen[name]) {
        unitsSeen[name] = unit
        this.units.set(name, unit)
      }
      this.kinds.set(name, 'number')
      this.noteName(name)
      if (!this.multiplePerLine) break
    }

    if (Object.keys(values).length === 0) return []
    this.refreshDescriptors()

    // One sample per pair, so a consumer of a single key is not gated on the
    // rest of the line's fields.
    const ts = Date.now()
    return Object.entries(values).map(([name, value]) => ({ ts, values: { [name]: value } }))
  }

  private noteName(name: string): void {
    if (!this.order.includes(name)) this.order.push(name)
  }

  private refreshDescriptors(): void {
    this.descriptorsCache = this.order.map((name, index) => {
      const unit = this.units.get(name)
      const kind = this.kinds.get(name) ?? 'number'
      const base = { name, kind, source: 'rttVar' as const, index }
      return unit === undefined ? base : { ...base, unit }
    })
  }

  public descriptors(): VariableDescriptor[] {
    return this.descriptorsCache
  }

  public reset(): void {
    this.lines.reset()
    this.units.clear()
    this.kinds.clear()
    this.order = []
    this.descriptorsCache = []
  }
}
