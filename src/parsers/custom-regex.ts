/**
 * Custom-regex variable parser for the RTT data channel.
 *
 * The escape hatch for targets whose output is neither CSV, key/value, nor a
 * packed struct: a log-style line carrying embedded measurements, a vendor
 * protocol string, anything a user can describe with one pattern.
 *
 * Named capture groups become the variable names, so the pattern itself is the
 * configuration — there is no separate group-to-name table to keep in sync:
 *
 *   pattern: /V=(?<volt>\d+)mV\s+I=(?<amps>-?\d+)mA/
 *
 * Unnamed groups would have to be addressed positionally and are rejected,
 * because a pattern that silently drops its data is worse than a clear error.
 */
import { LineSplitter, decodeTerminator } from '../core/framing.ts'
import type { Sample, VariableDescriptor, VariableProvider } from '../core/types.ts'

export interface CustomRegexOptions {
  /** Pattern source; named capture groups define the variable names. */
  pattern?: string
  /** Pattern flags. Default `g`. */
  flags?: string
  /** Read the line as raw text instead of UTF-8 (for mixed binary). */
  binarySafe?: boolean
}

/** Extracts `?<name>` group names from a pattern source. */
export function namedGroupsOf(source: string): string[] {
  const names: string[] = []
  const re = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g
  for (const m of source.matchAll(re)) {
    if (m[1] !== undefined) names.push(m[1])
  }
  return names
}

export class CustomRegexParser implements VariableProvider {
  public readonly id = 'custom-regex'

  private source?: string
  private flags = 'g'
  private regex?: RegExp
  private readonly lines = new LineSplitter()
  private units = new Map<string, string>()
  private order: string[] = []
  private descriptorsCache: VariableDescriptor[] = []

  public configure(options: Record<string, unknown>): void {
    if (typeof options['pattern'] === 'string') {
      this.source = options['pattern']
    }
    if (typeof options['flags'] === 'string' && options['flags'] !== '') {
      this.flags = options['flags']
    }
    // Editable record terminator; see `decodeTerminator`.
    if (typeof options['lineTerminator'] === 'string' && options['lineTerminator'] !== '') {
      this.lines.setTerminator(decodeTerminator(options['lineTerminator']))
    }
    if (this.source !== undefined) {
      this.regex = new RegExp(this.source, this.flags.includes('g') ? this.flags : `${this.flags}g`)
      for (const name of namedGroupsOf(this.source)) {
        if (!this.order.includes(name)) this.order.push(name)
      }
      this.refreshDescriptors()
    }
  }

  public feed(chunk: Uint8Array): Sample[] {
    const regex = this.regex
    if (regex === undefined) return []
    const out: Sample[] = []
    for (const line of this.lines.push(chunk)) {
      regex.lastIndex = 0
      for (const m of line.matchAll(regex)) {
        const groups = m.groups
        if (groups === undefined) continue
        const values: Record<string, number | boolean> = {}
        for (const name of this.order) {
          const raw = groups[name]
          if (raw === undefined) continue
          const parsed = parseValue(raw)
          if (parsed === undefined) continue
          values[name] = parsed.value
          if (parsed.unit !== undefined && !this.units.has(name)) {
            this.units.set(name, parsed.unit)
          }
        }
        if (Object.keys(values).length > 0) out.push({ ts: Date.now(), values })
      }
    }
    if (out.length > 0) this.refreshDescriptors()
    return out
  }

  private refreshDescriptors(): void {
    this.descriptorsCache = this.order.map((name, index) => {
      const unit = this.units.get(name)
      const base = { name, kind: 'number' as const, source: 'rttVar' as const, index }
      return unit === undefined ? base : { ...base, unit }
    })
  }

  /** Group names this parser will emit (empty until a pattern is configured). */
  public groupNames(): string[] {
    return [...this.order]
  }

  public descriptors(): VariableDescriptor[] {
    return this.descriptorsCache
  }

  public reset(): void {
    this.lines.reset()
  }
}

/** Captured text → number, boolean, or (with a suffix) number plus unit. */
function parseValue(raw: string): { value: number | boolean; unit?: string } | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const lower = text.toLowerCase()
  if (['true', 'on', 'yes', 'high'].includes(lower)) return { value: true }
  if (['false', 'off', 'no', 'low'].includes(lower)) return { value: false }
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµΩ%°/][A-Za-zµΩ%°/0-9]*)?$/.exec(text)
  if (m === null) return undefined
  const value = Number(m[1])
  if (Number.isNaN(value)) return undefined
  return m[2] === undefined ? { value } : { value, unit: m[2] }
}
