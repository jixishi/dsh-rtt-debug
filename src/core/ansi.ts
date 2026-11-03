/**
 * ANSI SGR decoder for the RTT log channel.
 *
 * SEGGER RTT delimits colour with ordinary ANSI escape sequences
 * (`"\x1b[1;32m"`, `RTT_CTRL_RESET` = `"\x1b[0m"`), so a log channel's raw bytes
 * contain both text and styling. Two properties matter here:
 *
 * 1. A target typically sets a colour once and then prints many lines — the
 *    style state therefore has to SURVIVE across lines, which is why this
 *    decoder is stateful and lives at the stream level, not per line.
 * 2. A sequence can be split across chunks. Since the log path decodes whole
 *    lines this cannot happen mid-line in practice, but a partial escape at
 *    end-of-buffer is still handled so no raw control bytes leak into the view.
 */

import type { AnsiColor, LogLevel, StyledSpan } from './types.ts'

/** The 8 base SGR foreground codes plus their bright counterparts. */
const FG_CODES: Readonly<Record<number, AnsiColor>> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
  34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'brightBlack', 91: 'brightRed', 92: 'brightGreen', 93: 'brightYellow',
  94: 'brightBlue', 95: 'brightMagenta', 96: 'brightCyan', 97: 'brightWhite',
}

/** Matches one SGR escape; other escape families are matched for stripping. */
const SGR = /\x1b\[([0-9;]*)m/g
/** Any other CSI/FE escape sequence that must not reach the view as text. */
const OTHER_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

/** Accumulated display attributes. */
export interface AnsiStyle {
  color?: AnsiColor
  bold?: boolean
  underline?: boolean
  italic?: boolean
}

/**
 * Stateful SGR decoder: `push` one line's raw text, get styled spans back,
 * with the style state carried into the next line.
 */
export class AnsiDecoder {
  private style: AnsiStyle = {}

  /** Current style (what a newly started line inherits). */
  public current(): AnsiStyle {
    return { ...this.style }
  }

  /** Drop carried state — used on reconnect so a new stream starts clean. */
  public reset(): void {
    this.style = {}
  }

  /**
   * Decode one line.
   * @param raw - line text, possibly containing escape sequences.
   * @returns the display spans; concatenating their `text` gives the clean line
   *   text, so callers never need a second pass to strip escapes.
   */
  public push(raw: string): StyledSpan[] {
    const spans: StyledSpan[] = []
    let cursor = 0

    SGR.lastIndex = 0
    for (const match of raw.matchAll(SGR)) {
      const at = match.index
      if (at > cursor) this.emit(spans, raw.slice(cursor, at))
      this.applySgr(match[1] ?? '')
      cursor = at + match[0].length
    }
    if (cursor < raw.length) this.emit(spans, stripOtherEscapes(raw.slice(cursor)))
    return spans
  }

  private emit(spans: StyledSpan[], text: string): void {
    if (text === '') return
    const span: StyledSpan = { text }
    if (this.style.color !== undefined) span.color = this.style.color
    if (this.style.bold === true) span.bold = true
    if (this.style.underline === true) span.underline = true
    if (this.style.italic === true) span.italic = true
    spans.push(span)
  }

  /** Apply one SGR parameter list to the running style. */
  private applySgr(params: string): void {
    const codes = params === '' ? [0] : params.split(';').map(p => (p === '' ? 0 : Number.parseInt(p, 10)))
    for (const code of codes) {
      if (Number.isNaN(code)) continue
      if (code === 0) {
        this.style = {}
        continue
      }
      if (code === 1) { this.style.bold = true; continue }
      if (code === 3) { this.style.italic = true; continue }
      if (code === 4) { this.style.underline = true; continue }
      if (code === 22) { delete this.style.bold; continue }
      if (code === 23) { delete this.style.italic; continue }
      if (code === 24) { delete this.style.underline; continue }
      if (code === 39) { delete this.style.color; continue }
      const color = FG_CODES[code]
      if (color !== undefined) this.style.color = color
      // Background colours (40-49, 100-107) and anything else are ignored:
      // the log view owns its own background for readability.
    }
  }
}

/** Removes non-SGR escape sequences so they never render as literal text. */
function stripOtherEscapes(text: string): string {
  OTHER_ESCAPE.lastIndex = 0
  return text.replace(OTHER_ESCAPE, '')
}

/** Plain text of a span list (for search, export and copy). */
export function spansToText(spans: readonly StyledSpan[]): string {
  return spans.map(s => s.text).join('')
}

/**
 * Word-level severity detection.
 *
 * Deliberately conservative: matching a bare `E` or a stray `error` inside a
 * symbol name would mis-colour ordinary lines, so only unambiguous
 * bracketed/prefixed level markers and standalone keywords count.
 *
 * `ok`/`success`/`done` map to `info` rather than a level of their own: they
 * mark an ordinary successful line, which is exactly what `info` means in a
 * log view, and giving them a separate colour would imply a severity the log
 * does not have.
 */
const LEVEL_PATTERNS: ReadonlyArray<{ level: LogLevel; re: RegExp }> = [
  { level: 'error', re: /(?:^|[\s[(<])(?:error|err|fatal|fail(?:ed|ure)?)(?:[\s\])>:]|$)/i },
  { level: 'warn', re: /(?:^|[\s[(<])(?:warn(?:ing)?|wrn)(?:[\s\])>:]|$)/i },
  { level: 'debug', re: /(?:^|[\s[(<])(?:dbg|debug|trace|verbose)(?:[\s\])>:]|$)/i },
  { level: 'info', re: /(?:^|[\s[(<])(?:info|inf|notice|ok|success|done)(?:[\s\])>:]|$)/i },
]

/**
 * Classify a line's severity.
 *
 * Order matters: a line reading "INFO: error count 0" is an INFO line about an
 * error counter, while "ERROR: info sync failed" is an error — the FIRST
 * marker in the line wins, which is how loggers prefix their levels.
 */
export function detectLevel(text: string): LogLevel {
  let bestAt = Number.POSITIVE_INFINITY
  let best: LogLevel = 'unknown'
  for (const { level, re } of LEVEL_PATTERNS) {
    const m = re.exec(text)
    if (m === null) continue
    const at = m.index + (m[0].length - m[0].trimStart().length)
    if (at < bestAt) {
      bestAt = at
      best = level
    }
  }
  return best
}
