/**
 * Line/word framing helpers shared by every streaming parser.
 *
 * Chunk boundaries are the single most common source of parser bugs: a TCP
 * read can split a line anywhere, including between the CR and LF of one
 * terminator. These helpers keep the partial tail so the next `feed` completes
 * it, and they cap the retained tail so a source that never emits a terminator
 * cannot grow memory without bound.
 */

/** Retained-tail cap when no terminator ever arrives (~1 MiB of pending text). */
const DEFAULT_MAX_PENDING = 1 << 20

/**
 * Turn a user-typed terminator into the character(s) it names.
 *
 * A settings field is a text box, so the user cannot type a real newline. Two
 * spellings are therefore accepted, and both are what people actually write:
 *
 *   - escape sequences: `\n`, `\r`, `\r\n`, `\t`, `\0`, `\\`
 *   - a literal single character, which is what a paste produces
 *
 * Anything unrecognised is returned verbatim, so a genuinely odd delimiter
 * still works instead of silently becoming `\n`.
 *
 * @param raw - the user's text.
 * @returns the terminator string (never empty).
 */
export function decodeTerminator(raw: string): string {
  if (raw === '') return '\n'
  const ESCAPES: Record<string, string> = {
    '\\n': '\n',
    '\\r': '\r',
    '\\t': '\t',
    '\\0': '\0',
    '\\s': ' ',
    '\\\\': '\\',
  }
  // A whole-string escape wins, so `\r\n` becomes a two-character terminator.
  const direct = ESCAPES[raw]
  if (direct !== undefined) return direct
  // Otherwise expand every escape the string contains.
  const expanded = raw.replace(/\\([nrt0s\\])/g, (_match, ch: string) => ESCAPES[`\\${ch}`] ?? ch)
  return expanded === '' ? '\n' : expanded
}

/**
 * Accumulates bytes and emits complete lines.
 *
 * Decoding runs on the joined buffer, so a multi-byte UTF-8 sequence split
 * across two chunks is decoded correctly. Line ending is stripped and both
 * `\n` and `\r\n` are accepted.
 */
export class LineSplitter {
  private decoder = new TextDecoder('utf-8')
  private pending = ''
  private readonly maxPending: number
  /**
   * Record terminator.
   *
   * `\n` is the default because that is what almost every firmware prints, but
   * a target may frame records with `\r`, `\0`, or any other single character —
   * so the terminator is data, not a constant. A CR immediately before the
   * terminator is still stripped, which is what makes `\r\n` work whether the
   * terminator is configured as `\n` or as `\r\n`-collapsed `\r`.
   */
  private terminator: string

  /**
   * @param maxPending - retained-tail cap in characters.
   * @param terminator - record terminator (default `'\n'`).
   */
  public constructor(maxPending: number = DEFAULT_MAX_PENDING, terminator = '\n') {
    this.maxPending = maxPending
    this.terminator = terminator
  }

  /** Change the terminator (safe mid-stream; the pending tail is kept). */
  public setTerminator(terminator: string): void {
    this.terminator = terminator === '' ? '\n' : terminator
  }

  public getTerminator(): string {
    return this.terminator
  }

  /**
   * Feed one raw chunk.
   * @param chunk - bytes as they arrived.
   * @returns every complete line the chunk completed, terminator stripped.
   */
  public push(chunk: Uint8Array): string[] {
    if (chunk.length > 0) this.pending += this.decoder.decode(chunk, { stream: true })
    const out: string[] = []
    let start = 0
    for (;;) {
      const nl = this.pending.indexOf(this.terminator, start)
      if (nl === -1) break
      let end = nl
      // A CR just before the terminator is part of a CRLF pair, not content.
      if (end > start && this.pending.charCodeAt(end - 1) === 0x0d) end -= 1
      out.push(this.pending.slice(start, end))
      start = nl + this.terminator.length
    }
    this.pending = start === 0 ? this.pending : this.pending.slice(start)
    if (this.pending.length > this.maxPending) {
      // A source that never terminates a line must not grow memory without
      // bound: keep the newest tail (the oldest bytes are unrecoverable anyway).
      this.pending = this.pending.slice(this.pending.length - this.maxPending)
    }
    return out
  }

  /** Flush any decoder holdover and return the unterminated tail, if any. */
  public flush(): string | undefined {
    const rest = this.pending + this.decoder.decode()
    this.decoder = new TextDecoder('utf-8')
    this.pending = ''
    return rest === '' ? undefined : rest
  }

  public reset(): void {
    this.decoder = new TextDecoder('utf-8')
    this.pending = ''
  }
}

/**
 * Splits a byte stream into fixed-size frames.
 *
 * Used by the binary variable parser: a target streaming raw structs has no
 * line terminator at all, so framing comes from the declared frame length.
 */
export class FixedFrameSplitter {
  private pending: Uint8Array = new Uint8Array(0)
  private frameLength: number

  /**
   * @param frameLength - bytes per frame; must be a positive integer.
   */
  public constructor(frameLength: number) {
    if (!Number.isInteger(frameLength) || frameLength <= 0) {
      throw new RangeError(`frameLength must be a positive integer, got ${String(frameLength)}`)
    }
    this.frameLength = frameLength
  }

  /** Resize the frame length (drops any partial frame). */
  public setFrameLength(frameLength: number): void {
    if (!Number.isInteger(frameLength) || frameLength <= 0) {
      throw new RangeError(`frameLength must be a positive integer, got ${String(frameLength)}`)
    }
    this.frameLength = frameLength
  }

  /** @returns each complete frame the chunk completed. */
  public push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending, 0)
    merged.set(chunk, this.pending.length)

    const count = Math.floor(merged.length / this.frameLength)
    const out: Uint8Array[] = []
    for (let i = 0; i < count; i += 1) {
      const at = i * this.frameLength
      out.push(merged.subarray(at, at + this.frameLength))
    }
    this.pending = merged.subarray(count * this.frameLength)
    return out
  }

  public reset(): void {
    this.pending = new Uint8Array(0)
  }
}
