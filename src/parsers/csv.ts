/**
 * CSV variable parser — the default for the RTT data channel.
 *
 * Handles the common "NumericColumn,AnotherColumn,..." streaming shape,
 * optionally preceded by one header line naming the columns. Also accepts
 * whitespace/semicolon/tab delimiters, because firmware authors pick whatever
 * their printf habits suggest.
 *
 * Fractional numbers with an optional unit suffix are accepted
 * (`12007 mV`, `3.3V`, `-12.5`), which keeps a target from having to strip
 * units before writing to the channel.
 */
import { LineSplitter, decodeTerminator } from '../core/framing.ts'
import type { Sample, VariableDescriptor, VariableProvider } from '../core/types.ts'

export interface CsvOptions {
  /** Field separator: `,` (default), `;`, `\t`, or ` ` (whitespace runs). */
  delimiter?: string
  /**
   * How to treat the first line.
   *
   * `auto` (default) treats a first line whose fields are ALL non-numeric as a
   * header. That is what a firmware author almost always means by starting a
   * CSV stream with `volt,amps`, and it means the common case needs no
   * configuration while a headerless stream still works unchanged.
   */
  hasHeader?: boolean | 'auto'
  /** Explicit column names, overriding whatever the header says. */
  columns?: string[]
  /** Optional per-column unit labels, applied by position. */
  units?: string[]
  /** Stop parsing after this many columns (guards against trailing junk). */
  maxColumns?: number
  /**
   * Record terminator, as text: `\n` (default), `\r`, `\r\n`, `\0`, or a literal.
   * See `decodeTerminator` in `core/framing.ts` for the accepted spellings.
   */
  lineTerminator?: string
}

/** `-1.5e3`, `12007 mV`, `3,3` are not accepted — one number, optional unit. */
const NUMBER_WITH_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµΩ%°/][A-Za-zµΩ%°/0-9]*)?$/

/** Splits one line on the configured delimiter. */
function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === ' ') return line.trim().split(/\s+/)
  return line.split(delimiter).map(field => field.trim())
}

/**
 * Parses one numeric field into a value plus an optional unit.
 * @returns `undefined` when the field is not a number (e.g. a label).
 */
function parseField(raw: string): { value: number; unit?: string } | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const m = NUMBER_WITH_UNIT.exec(text)
  if (m === null) return undefined
  const value = Number(m[1])
  if (Number.isNaN(value)) return undefined
  return m[2] === undefined ? { value } : { value, unit: m[2] }
}

export class CsvParser implements VariableProvider {
  public readonly id = 'csv'

  private delimiter = ','
  private headerMode: boolean | 'auto' = 'auto'
  private explicitColumns?: string[]
  private explicitUnits?: string[]
  private maxColumns = Number.POSITIVE_INFINITY

  private readonly lines = new LineSplitter()
  private names: string[] = []
  private units: (string | undefined)[] = []
  /** Whether the first data-bearing line has already been classified. */
  private firstLineSeen = false
  private descriptorsCache: VariableDescriptor[] = []

  public configure(options: Record<string, unknown>): void {
    if (typeof options['delimiter'] === 'string' && options['delimiter'] !== '') {
      this.delimiter = options['delimiter']
    }
    // Record terminator is editable: a target may frame records with `\r`, `\0`
    // or nothing printable at all, so this cannot be a hardcoded `\n`.
    if (typeof options['lineTerminator'] === 'string' && options['lineTerminator'] !== '') {
      this.lines.setTerminator(decodeTerminator(options['lineTerminator']))
    }
    const header = options['hasHeader']
    if (typeof header === 'boolean' || header === 'auto') this.headerMode = header
    if (Array.isArray(options['columns'])) {
      this.explicitColumns = options['columns'].filter((c): c is string => typeof c === 'string')
    }
    if (Array.isArray(options['units'])) {
      this.explicitUnits = options['units'].filter((u): u is string => typeof u === 'string')
    }
    if (typeof options['maxColumns'] === 'number' && options['maxColumns'] > 0) {
      this.maxColumns = Math.floor(options['maxColumns'])
    }
  }

  public feed(chunk: Uint8Array): Sample[] {
    const out: Sample[] = []
    for (const line of this.lines.push(chunk)) {
      const trimmed = line.trim()
      if (trimmed === '') continue

      if (!this.firstLineSeen) {
        this.firstLineSeen = true
        const fields = splitLine(trimmed, this.delimiter)
        if (this.isHeaderLine(fields)) {
          this.names = this.explicitColumns ?? fields
          this.units = this.explicitUnits ?? []
          this.refreshDescriptors()
          // A header carries no data.
          continue
        }
        // Not a header: this line is data, so name the columns and fall
        // through to parse it in the same call — dropping it would lose the
        // very first sample.
        this.names = this.explicitColumns
          ?? Array.from({ length: Math.min(fields.length, this.maxColumns) }, (_, i) => `col${i + 1}`)
        this.units = this.explicitUnits ?? []
        this.refreshDescriptors()
      }

      const sample = this.parseDataLine(trimmed)
      if (sample !== undefined) out.push(sample)
    }
    return out
  }

  /**
   * Decide whether the first line names the columns.
   *
   * `auto` calls it a header when NO field parses as a number — a data row with
   * every field numeric is by far the common case, so the two are cleanly
   * separable, and a row of pure labels was never going to yield samples.
   */
  private isHeaderLine(fields: readonly string[]): boolean {
    if (this.headerMode === true) return true
    if (this.headerMode === false) return false
    if (fields.length === 0) return false
    return fields.every(field => parseField(field) === undefined)
  }

  private parseDataLine(line: string): Sample | undefined {
    const fields = splitLine(line, this.delimiter)
    if (fields.length === 0) return undefined

    // Reached only when the first line already classified as data, so the
    // names are established by then; this guards a direct internal call.
    if (this.names.length === 0) {
      const width = Math.min(fields.length, this.maxColumns)
      this.names = this.explicitColumns ?? Array.from({ length: width }, (_, i) => `col${i + 1}`)
      this.units = this.explicitUnits ?? []
      this.refreshDescriptors()
    }

    const values: Record<string, number | boolean> = {}
    const limit = Math.min(fields.length, this.names.length, this.maxColumns)
    for (let i = 0; i < limit; i += 1) {
      const parsed = parseField(fields[i] ?? '')
      // A non-numeric field (a status word, a dash) is simply absent from this
      // sample rather than poisoning the whole frame.
      if (parsed === undefined) continue
      const name = this.names[i]
      if (name === undefined) continue
      values[name] = parsed.value
      if (parsed.unit !== undefined && this.units[i] === undefined) {
        this.units[i] = parsed.unit
        this.refreshDescriptors()
      }
    }
    if (Object.keys(values).length === 0) return undefined
    return { ts: Date.now(), values }
  }

  private refreshDescriptors(): void {
    this.descriptorsCache = this.names.map((name, i) => {
      const unit = this.units[i]
      return unit === undefined
        ? { name, kind: 'number' as const, source: 'rttVar' as const, index: i }
        : { name, unit, kind: 'number' as const, source: 'rttVar' as const, index: i }
    })
  }

  public descriptors(): VariableDescriptor[] {
    return this.descriptorsCache
  }

  public reset(): void {
    this.lines.reset()
    this.names = []
    this.units = []
    this.firstLineSeen = false
    this.descriptorsCache = []
  }
}
