/**
 * Manual-binding parsing: the ONE implementation both halves share.
 *
 * This module is deliberately dependency-free apart from erased types. It is the
 * single source of truth for the two manual spellings —
 * `0x20000000:u16:VoltMv` and `VoltMv@0x20000000:u16` — plus the type-alias
 * vocabulary, and it is imported by BOTH:
 *
 *   - the host (`src/ocd/symbols.ts` re-exports these, so no import path moved);
 *   - the browser half (`src/client/panel.tsx`), which must preview exactly what
 *     the host will store.
 *
 * Why it lives here rather than in `symbols.ts`: that module imports the Node
 * `child_process` builtin for the ELF scan, so a client import of it would drag
 * a Node builtin into the browser bundle. Keeping the pure logic in its own
 * module lets the client share one implementation instead of copying it. A copy
 * is how the two halves drifted: the client's copy accepted only the nine
 * canonical spellings, and for the `name@address:type` form it fell back to
 * `u32` on an unrecognised spelling, so `float`/`double`/`int16` were stored as
 * 32-bit integers and the reader decoded them at the wrong width.
 *
 * Nothing here reads configuration, touches the network, or knows a toolchain
 * path: the plugin stays generic (spec G1). The ONLY import is a type-only one,
 * erased at build time, so this module adds no runtime edge at all.
 */

import type { ScalarType, SymbolBinding } from '../core/types.ts'
import { SCALAR_BYTES } from '../core/types.ts'

/** Canonical scalar spellings, accepted verbatim. */
const DIRECT_TYPES: readonly ScalarType[] = ['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'f32', 'f64', 'bool']

/**
 * Common C spellings mapped onto the scalar vocabulary.
 *
 * This table is the contract for what a user may type. An absent entry is an
 * ERROR, never a silent default: guessing `u32` for an unrecognised spelling is
 * how a 16-bit quantity ends up decoded at 32 bits, swallowing the neighbouring
 * two bytes with no visible symptom.
 */
const TYPE_ALIASES: Readonly<Record<string, ScalarType>> = {
  int8: 'i8', uint8: 'u8', char: 'i8', byte: 'u8',
  int16: 'i16', uint16: 'u16', short: 'i16', ushort: 'u16',
  int32: 'i32', uint32: 'u32', int: 'i32', unsigned: 'u32', long: 'i32', ulong: 'u32',
  float: 'f32', double: 'f64', boolean: 'bool', flag: 'bool',
}

/** `0x20000000` / `0x2000_0000` / `536870912` all accepted. */
export function parseAddress(text: string): number | undefined {
  const trimmed = text.trim().replace(/_/g, '')
  if (trimmed === '') return undefined
  const value = /^0[xX]/.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10)
  return Number.isNaN(value) || value < 0 ? undefined : value >>> 0
}

/**
 * Normalise a type spelling; accepts `uint16`, `int16_t`, `u16`, `float`.
 *
 * @param text - the raw spelling, or undefined when the field was omitted.
 * @returns the scalar type, or undefined when the spelling is not recognised.
 *   Callers must treat undefined as "refuse this input", not as "use a default"
 *   — except where the omitted-type shorthand applies (see `parseManualBinding`).
 */
export function normalizeType(text: string | undefined): ScalarType | undefined {
  if (text === undefined) return undefined
  const raw = text.trim().toLowerCase().replace(/^std::/, '').replace(/_t$/, '')
  for (const type of DIRECT_TYPES) {
    if (raw === type) return type
  }
  return TYPE_ALIASES[raw]
}

/** The outcome of parsing a manual binding. */
export type ManualBindingResult =
  | { ok: true; binding: SymbolBinding }
  | { ok: false; reason: 'empty' | 'unparsable' | 'unknown-type'; /** The offending spelling, when there is one. */ spelling?: string }

/**
 * Parse one manual binding: `name@address:type`, `address:type:name`, or
 * `0x20000000:u16:VoltMv`.
 *
 * Both orders are accepted because both read naturally, and requiring one would
 * mean users hit a parse error for writing the other.
 *
 * The two-part shorthand `0x20000000:VoltMv` deliberately defaults to `u32`: the
 * type is simply absent there, which is a documented convenience, and it is
 * pinned by `test/ocd.test.ts`. That is different from an UNRECOGNISED type,
 * which is refused (`unknown-type`) rather than defaulted.
 *
 * @param text - the raw field contents.
 * @returns the binding, or undefined when the spelling cannot be parsed.
 */
export function parseManualBinding(text: string): SymbolBinding | undefined {
  const result = parseManualBindingDetailed(text)
  return result.ok ? result.binding : undefined
}

/**
 * Parse one manual binding, reporting WHY it was refused.
 *
 * The panel needs the reason so it can tell the user their type spelling is
 * wrong instead of silently storing a different width. The host's plain
 * `parseManualBinding` keeps its `undefined`-on-failure contract.
 *
 * @param text - the raw field contents.
 * @returns the binding, or a reason the input was refused.
 */
export function parseManualBindingDetailed(text: string): ManualBindingResult {
  const trimmed = text.trim().replace(/^[`'"]|[`'"]$/g, '')
  if (trimmed === '') return { ok: false, reason: 'empty' }

  // Form A: name@address:type  (or name@address with the type absent)
  //
  // The type group accepts underscores so that `_t`-suffixed C spellings
  // (`uint16_t`, `int32_t`) reach `normalizeType`, which is where acceptance is
  // decided. It deliberately does NOT decide acceptance itself: a charset narrow
  // enough to exclude underscores rejected every `uint*_t` alias as `unparsable`
  // — 18 spellings this module's own `normalizeType` accepts — while Form B
  // accepted them, so the same type was refused purely for being written in the
  // name-first order. Widening it moves the decision to one place and upgrades
  // the refusal for a genuinely unknown spelling from `unparsable` to
  // `unknown-type`, which carries the offending token.
  const atForm = /^([A-Za-z_][A-Za-z0-9_.\-[\]$]*)\s*@\s*([^:\s]+)(?::\s*([A-Za-z0-9_]+))?$/.exec(trimmed)
  if (atForm !== null) {
    const address = parseAddress(atForm[2] ?? '')
    if (address === undefined) return { ok: false, reason: 'unparsable' }
    const spelling = atForm[3]
    if (spelling === undefined) return { ok: true, binding: { name: atForm[1] as string, address, type: 'u32' } }
    const type = normalizeType(spelling)
    if (type === undefined) return { ok: false, reason: 'unknown-type', spelling }
    return { ok: true, binding: { name: atForm[1] as string, address, type } }
  }

  // Form B: address:type:name  or  address:name (type absent)
  const parts = trimmed.split(':').map(part => part.trim())
  if (parts.length >= 2) {
    const address = parseAddress(parts[0] ?? '')
    if (address === undefined) return { ok: false, reason: 'unparsable' }
    if (parts.length >= 3) {
      const spelling = parts[1]
      const name = parts[2]
      if (name === undefined || name === '') return { ok: false, reason: 'unparsable' }
      const type = normalizeType(spelling)
      if (type === undefined) return { ok: false, reason: 'unknown-type', spelling }
      return { ok: true, binding: { name, address, type } }
    }
    const name = parts[1]
    if (name === undefined || name === '') return { ok: false, reason: 'unparsable' }
    return { ok: true, binding: { name, address, type: 'u32' } }
  }
  return { ok: false, reason: 'unparsable' }
}

/* ─────────────────────────── symbol type inference ─────────────────────────── */

/**
 * Refine a guess using the symbol's name.
 *
 * C type information is gone by link time, but names are conventionally typed
 * (`_u8`, `isReady`, `fVoltage`, `gain_f32`). Only unambiguous suffixes/prefixes
 * are honoured; an unrecognised name keeps the fallback width.
 */
export function refineTypeFromName(name: string, fallback: ScalarType): ScalarType {
  const m = /_(u?int|[uis])?(8|16|32|64|f32|f64)$/i.exec(name)
  if (m !== null) {
    const kind = (m[1] ?? '').toLowerCase()
    const width = m[2]?.toLowerCase()
    if (width === 'f32') return 'f32'
    if (width === 'f64') return 'f64'
    const signed = kind === 's' || kind === 'i' || kind === 'int'
    if (width === '8') return signed ? 'i8' : 'u8'
    if (width === '16') return signed ? 'i16' : 'u16'
    if (width === '32') return signed ? 'i32' : 'u32'
  }
  if (/^(is|has|was|should)[A-Z_]/.test(name) || /Flag$/i.test(name)) return 'bool'
  if (/^(f|d)[A-Z]/.test(name)) return 'f32'
  return fallback
}

/**
 * Test whether a symbol name contains an unambiguous type hint.
 */
export function hasNameHint(name: string): boolean {
  if (/_(u?int|[uis])?(8|16|32|64|f32|f64)$/i.test(name)) return true
  if (/^(is|has|was|should)[A-Z_]/.test(name) || /Flag$/i.test(name)) return true
  if (/^(f|d)[A-Z]/.test(name)) return true
  return false
}

/**
 * Turn a symbol's byte width into a concrete scalar type (WIDTH-ONLY).
 *
 * Kept for compatibility: it is what `test/ocd.test.ts` pins and what the
 * `/symbols` listing used before this task. It maps a size to its natural width
 * and preserves the fallback when it is a valid width or the size is unknown. New
 * call sites that need to reconcile a NAME inference should prefer
 * `resolveSymbolType`.
 *
 * @param size - symbol size in bytes as `nm` reported it (0 when unknown).
 * @param fallback - the type to keep when the size gives no guidance.
  if (size === 2) return nameType === 'u16' || nameType === 'i16' ? nameType : 'u16'
  if (size === 4) return nameType === 'i32' || nameType === 'f32' ? nameType : 'u32'
  if (size === 8) return nameType === 'f64' ? nameType : 'f64'
  return nameType
}

/**
 * Turn a symbol's byte width into a concrete scalar type (WIDTH-ONLY).
 *
 * Kept for compatibility: it is what `test/ocd.test.ts` pins and what the
 * `/symbols` listing used before this task. It maps a size to its natural width
 * and preserves the fallback when it is a valid width or the size is unknown. New
 * call sites that need to reconcile a NAME inference should prefer
 * `resolveSymbolType`.
 *
 * @param size - symbol size in bytes as `nm` reported it (0 when unknown).
 * @param fallback - the type to keep when the size gives no guidance.
 */
export function typeForSize(size: number, fallback: ScalarType): ScalarType {
  if (size === 1) return 'u8'
  if (size === 2) return 'u16'
  if (size === 4) return fallback === 'f32' || fallback === 'i32' ? fallback : 'u32'
  if (size === 8) return 'f64'
  return fallback
}
