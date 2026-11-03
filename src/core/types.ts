/**
 * Shared vocabulary for the three data sources this plugin consumes.
 *
 * The plugin is DELIBERATELY generic: nothing here names a chip, a vendor, a
 * firmware project or an absolute path. Every address, port, channel, symbol
 * and parser choice arrives from user configuration (see `config.ts`), so the
 * same build drives any RTT-capable target.
 */

/** The three independent sources. Each can be enabled/disabled on its own. */
export type SourceId = 'log' | 'rttVar' | 'ocd'

/** One variable sample: the unit every series is built from. */
export interface Sample {
  /** Unix epoch milliseconds (host receive time unless the source stamps its own). */
  ts: number
  /** Variable name → numeric/boolean value. */
  values: Record<string, number | boolean>
}

/** What a series-owning consumer needs to know about one variable. */
export interface VariableDescriptor {
  /** Display name (also the series key). */
  name: string
  /** Optional engineering unit, e.g. `mV`, `ms`. */
  unit?: string
  /** Value kind; `bool` renders as a 0/1 step. */
  kind: 'number' | 'bool'
  /** Which source produced it. */
  source: SourceId
  /** Position within the source's frame, when meaningful. */
  index?: number
}

/**
 * A pluggable variable data source.
 *
 * `feed` is streaming and must tolerate chunk boundaries: a partial frame is
 * buffered internally and completed by the next chunk.
 */
export interface VariableProvider {
  /** Registry key, e.g. `csv`. */
  readonly id: string
  /** Apply parser options (delimiter, layout, regex…). */
  configure(options: Record<string, unknown>): void
  /** Consume raw bytes, return whatever completed samples they yielded. */
  feed(chunk: Uint8Array): Sample[]
  /** Variables discovered so far (may grow as frames arrive). */
  descriptors(): VariableDescriptor[]
  /** Drop buffered half-frames and discovery state. */
  reset(): void
}

/* ────────────────────────────── log records ────────────────────────────── */

/** One styled run of text inside a log line (SEGGER RTT colour support). */
export interface StyledSpan {
  text: string
  /** Foreground colour name resolved from ANSI SGR, when present. */
  color?: AnsiColor
  bold?: boolean
  underline?: boolean
  italic?: boolean
}

export type AnsiColor =
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow'
  | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'

/** Severity resolved from the line text, for filtering and colouring. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'unknown'

/** One log line. */
export interface LogRecord {
  /** Monotonic sequence number (never reused, survives ring trimming). */
  seq: number
  /** Unix epoch milliseconds. */
  ts: number
  /** Line text with ANSI escapes removed. */
  text: string
  /** Styled runs for rendering (concatenates back to `text`). */
  spans: StyledSpan[]
  level: LogLevel
}

/* ───────────────────────────── connection state ───────────────────────── */

export type LinkState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'closed'; reason?: string }
  | { kind: 'error'; message: string }

/* ──────────────────────────── OCD memory reads ─────────────────────────── *//** Scalar layouts the OCD reader can decode. */
export type ScalarType =
  | 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32' | 'f64' | 'bool'

/** One memory location sampled by the OCD reader. */
export interface SymbolBinding {
  /** Series name. */
  name: string
  /** Target address. */
  address: number
  type: ScalarType
  /** Defaults to little (Cortex-M native). */
  endianness?: 'little' | 'big'
  /** Optional engineering unit carried through to the UI. */
  unit?: string
}

/** Byte width of a scalar type. */
export const SCALAR_BYTES: Readonly<Record<ScalarType, number>> = {
  i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8, bool: 1,
}

/* ───────────────────────────── parser contract ─────────────────────────── */

/** Factory registered under a parser id. */
export type ParserFactory = () => VariableProvider
