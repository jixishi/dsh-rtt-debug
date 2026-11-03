/**
 * Script parser — a user-defined record → variables transform.
 *
 * WHY THIS IS AN EXPRESSION, NOT A SCRIPT: this runs in the HOST process, next
 * to the user's shell and their source tree. `new Function` on arbitrary text
 * would be remote code execution with the plugin as the delivery vehicle — one
 * pasted "parser" and the machine is gone. So the user writes an EXPRESSION that
 * maps the already-split fields of one record to a value map, and nothing else:
 *
 *     { volt: fields[0] * 3.3 / 4095, amps: fields[1] / 1000 }
 *
 * That covers every real "my format is slightly different" case — scaling,
 * combining columns, renaming, unit conversion, conditional booleans — while
 * remaining a pure function of the record. There is no `require`, no `process`,
 * no `globalThis`: the compiler below accepts a closed set of syntax and rejects
 * everything else, so `fields`, `line`, `index` and numeric literals are the
 * entire available universe.
 *
 * Compiled once per configuration change, and a throw during evaluation is
 * contained per record (one bad line must not kill the stream).
 */

import { LineSplitter, decodeTerminator } from '../core/framing.ts'
import type { Sample, VariableDescriptor, VariableProvider } from '../core/types.ts'

export interface ScriptOptions {
  /**
   * The record → variables expression.
   *
   * Available bindings:
   *   - `fields` — the record split on `delimiter` (already trimmed),
   *   - `line`   — the raw record text (without terminator),
   *   - `index`  — 0-based record counter.
   *
   * Must evaluate to an object; each numeric/boolean property becomes one series.
   */
  expression?: string
  /** Field separator used to build `fields`. Default `,`. */
  delimiter?: string
  /** Record terminator, as text. Default `\n`. */
  lineTerminator?: string
  /** Skip a leading line (header) before evaluating records. */
  skipFirstLine?: boolean
}

export type ScriptResult =
  | { ok: true; values: Record<string, number | boolean> }
  | { ok: false; reason: string }

/**
 * Names an expression may reference.
 *
 * Deliberately tiny: there is no path from here to the host process.
 */
const ALLOWED_IDENTIFIERS = new Set(['fields', 'line', 'index', 'Number', 'Math', 'true', 'false', 'null', 'undefined'])

/**
 * Whether an identifier sits in an object-key position (`{ key: value }`).
 *
 * Decided from BOTH sides so a name cannot be smuggled into value position: the
 * text before must end at an object boundary (`{` opening or `,` separating),
 * and the text after must begin with the key's colon. A ternary `cond ? a : b`
 * therefore does NOT qualify — its `a` is preceded by `?`, not by `{` or `,`.
 *
 * @param before - expression text preceding the identifier.
 * @param after - expression text following the identifier.
 */
function isObjectKey(before: string, after: string): boolean {
  if (!/^\s*:/.test(after)) return false
  // Walk back over whitespace: the key must open its own entry.
  const trimmed = before.replace(/\s+$/, '')
  if (trimmed === '') return false
  const last = trimmed[trimmed.length - 1]
  // `{ k: …` and `, k: …` are key positions. Anything else (`+`, `?`, `(`)
  // means the identifier is an operand.
  return last === '{' || last === ','
}

/**
 * Reject anything that could escape the sandbox BEFORE the expression is ever
 * compiled.
 *
 * This is a deny-list on top of a small allow-list (`ALLOWED_IDENTIFIERS`): each
 * banned form is one that reaches host capability even without a global object
 * — `constructor` walks to `Function`, the others name the runtime directly.
 */
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bconstructor\b/, reason: '"constructor" can reach the Function object' },
  { pattern: /\bprototype\b/, reason: '"prototype" can reach the Function object' },
  { pattern: /\brequire\b/, reason: '"require" would load host modules' },
  { pattern: /\bimport\b/, reason: '"import" would load host modules' },
  { pattern: /\bprocess\b/, reason: '"process" would expose the host process' },
  { pattern: /\bglobalThis\b/, reason: '"globalThis" would expose the global object' },
  { pattern: /\bglobal\b/, reason: '"global" would expose the global object' },
  { pattern: /\bwindow\b/, reason: '"window" would expose the global object' },
  { pattern: /\beval\b/, reason: '"eval" would defeat this check' },
  { pattern: /\bFunction\b/, reason: '"Function" would compile arbitrary code' },
  { pattern: /\bthis\b/, reason: '"this" would escape the sandbox' },
  { pattern: /\bawait\b/, reason: 'async syntax is not supported' },
  { pattern: /\byield\b/, reason: 'generator syntax is not supported' },
  { pattern: /=>/, reason: 'function syntax is not supported' },
  { pattern: /\bfunction\b/, reason: 'function syntax is not supported' },
  { pattern: /;/, reason: 'a single expression is expected, not a statement list' },
  { pattern: /[{}][^{}]*[{}][^{}]*\breturn\b/, reason: 'statements are not supported' },
]

/**
 * Characters an expression may contain, after the deny-list passes.
 *
 * Deliberately includes the object literal braces and colon, because the result
 * IS an object; it excludes backticks (template literals) and backslashes.
 */
const ALLOWED_CHARS = /^[\s0-9A-Za-z_$.,:+\-*/%()<>!=&|?'"[\]{}\u00b0\u2103]+$/

export interface CompileResult {
  /** Evaluate one record; `undefined` when it produced nothing usable. */
  evaluate?: (fields: string[], line: string, index: number) => Record<string, number | boolean> | undefined
  /** Why compilation failed, for the UI. */
  error?: string
}

/**
 * Compile a user expression into an evaluator.
 *
 * @param source - the expression text.
 * @returns either an evaluator or an `error` explaining the rejection.
 */
export function compileScript(source: string): CompileResult {
  const text = source.trim()
  if (text === '') return { error: 'expression is empty' }
  if (!ALLOWED_CHARS.test(text)) {
    return { error: 'expression contains characters that are not allowed' }
  }
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) return { error: `rejected: ${reason}` }
  }
  // Every identifier must be resolvable. Two positions are NOT scope lookups and
  // must be skipped, or the natural way to write a mapping would be rejected:
  //
  //   - after a dot: `Math.round` — `round` is a member name,
  //   - an object key: in `{ volt: … }` — `volt` names an OUTPUT series.
  //
  // Everything else is a value-position identifier and must be allow-listed.
  const withoutStrings = text.replace(/'[^']*'|"[^"]*"/g, "''")
  for (const match of withoutStrings.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = match[0]
    const at = match.index ?? 0
    if (ALLOWED_IDENTIFIERS.has(name)) continue
    const before = withoutStrings.slice(0, at)
    const after = withoutStrings.slice(at + name.length)
    if (/[.]\s*$/.test(before)) continue
    if (isObjectKey(before, after)) continue
    return { error: `unknown name "${name}"; available: fields, line, index, Number, Math` }
  }

  let compiled: (fields: string[], line: string, index: number) => unknown
  try {
    // No `with`, no scope object: the three bindings are the parameter list, so
    // nothing else is lexically reachable from inside the body. `Number` and
    // `Math` are passed explicitly so the body needs no global lookup at all.
    compiled = new Function(
      'fields', 'line', 'index', 'Number', 'Math',
      `"use strict"; return (${text});`,
    ) as unknown as (fields: string[], line: string, index: number) => unknown
  } catch (error) {
    return { error: `expression does not compile: ${error instanceof Error ? error.message : String(error)}` }
  }
  // The two extra parameters exist only inside the generated body.
  const invoke = compiled as unknown as (
    fields: string[], line: string, index: number, num: NumberConstructor, math: Math,
  ) => unknown

  return {
    evaluate: (fields, line, index) => {
      let raw: unknown
      try {
        raw = invoke(fields, line, index, Number, Math)
      } catch {
        // A throwing record yields nothing; the stream continues.
        return undefined
      }
      if (typeof raw !== 'object' || raw === null) return undefined
      const values: Record<string, number | boolean> = {}
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) values[key] = value
        else if (typeof value === 'boolean') values[key] = value
        else if (typeof value === 'string') {
          const parsed = Number.parseFloat(value)
          if (Number.isFinite(parsed)) values[key] = parsed
        }
      }
      return Object.keys(values).length === 0 ? undefined : values
    },
  }
}

export class ScriptParser implements VariableProvider {
  public readonly id = 'script'

  private readonly lines = new LineSplitter()
  private delimiter = ','
  private skipFirstLine = false
  private evaluate?: (fields: string[], line: string, index: number) => Record<string, number | boolean> | undefined
  private compileError?: string
  private index = 0
  private skipped = false
  private names: string[] = []
  private descriptorsCache: VariableDescriptor[] = []

  /** The last compile error, surfaced so the UI can show why nothing parses. */
  public get error(): string | undefined {
    return this.compileError
  }

  public configure(options: Record<string, unknown>): void {
    if (typeof options['delimiter'] === 'string' && options['delimiter'] !== '') {
      this.delimiter = options['delimiter']
    } else {
      this.delimiter = ','
    }
    this.skipFirstLine = options['skipFirstLine'] === true
    if (typeof options['lineTerminator'] === 'string' && options['lineTerminator'] !== '') {
      this.lines.setTerminator(decodeTerminator(options['lineTerminator']))
    }
    const expression = typeof options['expression'] === 'string' ? options['expression'] : ''
    const result = compileScript(expression)
    this.evaluate = result.evaluate
    this.compileError = result.error
    // A new expression means new names: drop the old roster so the legend does
    // not keep advertising variables the script no longer produces.
    this.names = []
    this.descriptorsCache = []
    this.index = 0
    this.skipped = false
  }

  public feed(chunk: Uint8Array): Sample[] {
    const evaluate = this.evaluate
    if (evaluate === undefined) return []
    const out: Sample[] = []
    for (const line of this.lines.push(chunk)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (this.skipFirstLine && !this.skipped) {
        this.skipped = true
        continue
      }
      const fields = this.delimiter === ' ' ? trimmed.split(/\s+/) : trimmed.split(this.delimiter).map(f => f.trim())
      const values = evaluate(fields, trimmed, this.index)
      this.index += 1
      if (values === undefined) continue
      for (const name of Object.keys(values)) {
        if (!this.names.includes(name)) {
          this.names.push(name)
          this.refreshDescriptors()
        }
      }
      out.push({ ts: Date.now(), values })
    }
    return out
  }

  public descriptors(): VariableDescriptor[] {
    return this.descriptorsCache
  }

  /** Drop buffered text and the record counter (stream restart). */
  public reset(): void {
    this.lines.reset()
    this.index = 0
    this.skipped = false
  }

  private refreshDescriptors(): void {
    this.descriptorsCache = this.names.map((name, index) => ({
      name,
      kind: 'number',
      source: 'rttVar',
      index,
    }))
  }
}
