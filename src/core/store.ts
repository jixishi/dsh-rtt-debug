/**
 * Ring buffers for the two long-lived streams.
 *
 * Both classes answer the same question: a debug session runs for hours, so
 * memory must stay bounded no matter how much the target prints. Each keeps a
 * monotonic `seq` so a consumer can tell "new data" from "the ring wrapped"
 * without diffing contents.
 *
 * Deliberately free of any transport or framework dependency so the trimming
 * rules can be unit-tested in isolation.
 */

import type { LogRecord, Sample } from './types.ts'

/**
 * One variable's time series.
 *
 * Parallel arrays rather than objects: a series holds tens of thousands of
 * points, and two typed arrays cost a fraction of an array of `{t, v}` objects.
 */
export interface Series {
  name: string
  unit?: string
  kind: 'number' | 'bool'
  /** Sample timestamps; `ts[i]` pairs with `values[i]`. */
  ts: number[]
  values: (number | boolean)[]
}

export interface SeriesStoreOptions {
  /** How much history to keep, in milliseconds. */
  retentionMs: number
  /** Hard cap per series, independent of the time window. */
  maxPointsPerSeries: number
  /**
   * Decimation rate in Hz. Two samples closer together than this are merged
   * (the newer value wins), which keeps a fast target from flooding the view.
   * `0` disables decimation.
   */
  sampleRateHz: number
}

export const DEFAULT_SERIES_OPTIONS: SeriesStoreOptions = {
  retentionMs: 10 * 60 * 1000,
  maxPointsPerSeries: 100_000,
  sampleRateHz: 10,
}

/**
 * Per-variable ring buffers with time- and size-based trimming.
 *
 * Decimation keeps the most recent value in each interval: for a waveform the
 * newest reading is the truthful one, and averaging would invent values the
 * target never produced.
 */
export class SeriesStore {
  private readonly series = new Map<string, Series>()
  private options: SeriesStoreOptions
  /** Last accepted timestamp per series, for decimation. */
  private readonly lastAccepted = new Map<string, number>()
  /**
   * Newest timestamp ever appended.
   *
   * Trimming is relative to THIS, not to the wall clock: a source may stamp its
   * own samples (target uptime in milliseconds is the usual choice), and those
   * numbers share no epoch with `Date.now()`. Anchoring the retention window to
   * the newest sample keeps the window meaningful for both stamped and
   * host-timestamped sources instead of silently discarding every point.
   */
  private newestTs = Number.NEGATIVE_INFINITY

  public constructor(options: Partial<SeriesStoreOptions> = {}) {
    this.options = { ...DEFAULT_SERIES_OPTIONS, ...options }
  }

  /** Apply new limits; trims every series immediately so a shrink takes effect. */
  public configure(options: Partial<SeriesStoreOptions>): void {
    this.options = { ...this.options, ...options }
    for (const s of this.series.values()) this.trim(s)
  }

  public getOptions(): SeriesStoreOptions {
    return { ...this.options }
  }

  /** Series names, in first-seen order. */
  public names(): string[] {
    return [...this.series.keys()]
  }

  public get(name: string): Series | undefined {
    return this.series.get(name)
  }

  public all(): Series[] {
    return [...this.series.values()]
  }

  /**
   * Append samples.
   * @param samples - samples from any source; each is routed to its own series.
   * @returns the number of points actually stored (after decimation).
   */
  public append(samples: readonly Sample[]): number {
    let stored = 0
    for (const sample of samples) {
      if (Number.isFinite(sample.ts) && sample.ts > this.newestTs) this.newestTs = sample.ts
      for (const [name, value] of Object.entries(sample.values)) {
        if (!this.accept(name, sample.ts)) continue
        const series = this.ensure(name, typeof value === 'boolean' ? 'bool' : 'number')
        series.ts.push(sample.ts)
        series.values.push(value)
        this.lastAccepted.set(name, sample.ts)
        stored += 1
      }
    }
    for (const s of this.series.values()) this.trim(s)
    return stored
  }

  /** Attach/refresh unit metadata discovered by a parser. */
  public setMeta(name: string, meta: { unit?: string; kind?: 'number' | 'bool' }): void {
    const series = this.series.get(name)
    if (series === undefined) return
    if (meta.unit !== undefined) series.unit = meta.unit
    if (meta.kind !== undefined) series.kind = meta.kind
  }

  /** Drop every series. */
  public clear(): void {
    this.series.clear()
    this.lastAccepted.clear()
    this.newestTs = Number.NEGATIVE_INFINITY
  }

  private ensure(name: string, kind: 'number' | 'bool'): Series {
    const existing = this.series.get(name)
    if (existing !== undefined) return existing
    const created: Series = { name, kind, ts: [], values: [] }
    this.series.set(name, created)
    return created
  }

  /** Whether a sample for `name` passes the decimation gate. */
  private accept(name: string, ts: number): boolean {
    const rate = this.options.sampleRateHz
    if (rate <= 0) return true
    const previous = this.lastAccepted.get(name)
    if (previous === undefined) return true
    return ts - previous >= 1000 / rate
  }

  /** Enforce both limits, oldest first. */
  private trim(series: Series): void {
    const newest = this.newestTs
    const cutoff = Number.isFinite(newest) ? newest - this.options.retentionMs : Number.NEGATIVE_INFINITY
    let drop = 0
    // Series are appended in time order, so the expired prefix is contiguous.
    while (drop < series.ts.length && (series.ts[drop] ?? Number.POSITIVE_INFINITY) < cutoff) drop += 1
    const sizeOverflow = series.ts.length - drop - this.options.maxPointsPerSeries
    if (sizeOverflow > 0) drop += sizeOverflow
    if (drop <= 0) return
    series.ts.splice(0, drop)
    series.values.splice(0, drop)
  }
}

/* ──────────────────────────────── log store ─────────────────────────────── */

export interface LogStoreOptions {
  /** Ring capacity in lines. */
  maxLines: number
}

export const DEFAULT_LOG_OPTIONS: LogStoreOptions = { maxLines: 5000 }

/**
 * Fixed-capacity log ring.
 *
 * `seq` keeps increasing after the ring wraps, and `totalIngested` never
 * decreases: those two counters are what let the view prove "no line was
 * dropped" (spec A16) instead of merely hoping so — the received count is
 * independent of what the ring retains.
 */
export class LogStore {
  private lines: LogRecord[] = []
  private nextSeq = 1
  private total = 0
  private options: LogStoreOptions

  public constructor(options: Partial<LogStoreOptions> = {}) {
    this.options = { ...DEFAULT_LOG_OPTIONS, ...options }
  }

  public configure(options: Partial<LogStoreOptions>): void {
    this.options = { ...this.options, ...options }
    this.enforceCapacity()
  }

  public getOptions(): LogStoreOptions {
    return { ...this.options }
  }

  /** Total lines ever accepted (survives trimming; the completeness counter). */
  public get totalIngested(): number {
    return this.total
  }

  /** Sequence number the next accepted line will receive. */
  public get nextSequence(): number {
    return this.nextSeq
  }

  /** Currently retained lines, oldest first. */
  public entries(): LogRecord[] {
    return this.lines
  }

  public push(record: Omit<LogRecord, 'seq'>): LogRecord {
    const full: LogRecord = { ...record, seq: this.nextSeq }
    this.nextSeq += 1
    this.total += 1
    this.lines.push(full)
    this.enforceCapacity()
    return full
  }

  /** Drop retained lines but keep the counters (so completeness stays provable). */
  public clear(): void {
    this.lines = []
  }

  /** Reset counters as well — a fresh session, not a cleared view. */
  public reset(): void {
    this.lines = []
    this.nextSeq = 1
    this.total = 0
  }

  /** Serialize for export, oldest first. */
  public toText(formatTimestamp: (ts: number) => string): string {
    return this.lines
      .map(line => `${formatTimestamp(line.ts)} [${line.level.toUpperCase()}] ${line.text}`)
      .join('\n')
  }

  private enforceCapacity(): void {
    const overflow = this.lines.length - this.options.maxLines
    if (overflow > 0) this.lines.splice(0, overflow)
  }
}
