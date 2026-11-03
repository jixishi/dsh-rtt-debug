/**
 * ELF symbol resolution for the OCD memory reader.
 *
 * The reader needs `name → address + size + signedness`. Two ways in:
 *
 *   1. An ELF file, read through `arm-none-eabi-nm` (or any `nm` compatible with
 *      the target's object format). Portable across toolchains, and it is the
 *      symbol table the linker actually produced.
 *   2. Manual bindings (`0x20000005f0:u16:VoltMv`), for when no ELF is at hand.
 *
 * Nothing here hardcodes a toolchain path or a symbol name: both arrive from
 * configuration, which is what keeps the plugin generic (spec G1).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SCALAR_BYTES } from '../core/types.ts'
import type { ScalarType, SymbolBinding } from '../core/types.ts'

// The manual-binding grammar lives in its own dependency-free module so the
// browser half can import the SAME implementation (see `binding-parse.ts` for
// why this used to be duplicated, and what that cost). Re-exported here so the
// existing import paths — `src/index.ts` and `test/ocd.test.ts` — stay put.
export { normalizeType, parseAddress, parseManualBinding } from './binding-parse.ts'

const execFileAsync = promisify(execFile)

/** One symbol as `nm` reports it. */
export interface ElfSymbol {
  name: string
  address: number
  size: number
  /** Raw `nm` type letter (`D`, `b`, `R`…). */
  nmType: string
  /** Type inferred from the `nm` letter when the name carries no hint. */
  inferredType: ScalarType
}

/**
 * `nm -S` emits: `<address> <size> <type> <name>`.
 *
 * Older/limited `nm` builds omit the size column, so both shapes are accepted —
 * a missing size is not fatal, the caller supplies a width instead.
 */
const NM_WITH_SIZE = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/
const NM_WITHOUT_SIZE = /^([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/

/**
 * Map an `nm` type letter to a scalar type.
 *
 * The letter states the symbol's SECTION, not its C type, so this can only ever
 * be a guess — it decides a default width, and the user overrides it when the
 * real type differs. (Global vs file-local is a separate question, answered by
 * {@link isGlobalDataSymbol}.)
 */
function inferFromNmType(nmType: string): ScalarType {
  switch (nmType.toUpperCase()) {
    case 'B': case 'D': case 'C': case 'G': case 'S':
      return 'u32'   // .bss / .data / common / small data — most globals are 32-bit
    case 'R': case 'T': case 'W': case 'V':
      return 'u32'   // rodata / text / weak — readable as words
    default:
      return 'u32'
  }
}

/**
 * Refine a guess using the symbol's name.
 *
 * C type information is gone by link time, but names are conventionally typed
 * (`_u8`, `IsReady`, `voltageMv`). Only unambiguous suffixes are honoured;
 * an unrecognised name keeps the width guess.
 *
 * The signedness prefix accepts every spelling seen in practice — `u16`,
 * `i16`, `s16`, `int16`, `uint16` — because omitting `i` would silently
 * widen a signed field to unsigned and flip every negative reading.
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

export interface SymbolParseOptions {
  /** Keep only names containing this substring (case-insensitive). */
  filter?: string
  /** Hard cap on returned symbols, to keep a huge ELF from flooding the UI. */
  limit?: number
  /**
   * Keep only GLOBAL data symbols (default `true`).
   *
   * `nm`'s type letter says where a symbol lives AND its linkage: an UPPERCASE
   * data letter (`B`/`D`/`G`/`R`/`S`) is a global, a lowercase one
   * (`b`/`d`/`g`/`r`/`s`) is file-local (C `static`). A file-local symbol is
   * useless here: `nm` reports it, but it is a private implementation detail of
   * one translation unit, usually unaligned into a pool or optimized away, so
   * offering it invites the user to sample a copy that is not the one the code
   * updates. Set to `false` only to deliberately see statics.
   */
  globalsOnly?: boolean
}

/**
 * Whether an `nm` type letter denotes a GLOBAL (externally visible) data symbol.
 *
 * Uppercase = global, lowercase = file-local (`static`). Non-data letters
 * (`T`/`t` text, `U` undefined) are rejected here too, so the caller gets "is
 * this samplable global data" in one question rather than two.
 *
 * @param nmType - the single type letter `nm` printed.
 */
export function isGlobalDataSymbol(nmType: string): boolean {
  // Only the data-bearing letters, and only in their uppercase (global) form.
  return /[BDGSR]/.test(nmType)
}

/**
 * Parse `nm` output into symbols.
 *
 * Split out from {@link listElfSymbols} so the filtering rules — which are the
 * part with real consequences — can be tested without a toolchain on the box,
 * and so a future `nm` variant only needs a new parser rather than a second
 * spawn path.
 *
 * @param stdout - raw `nm -S --defined-only` output.
 * @param options - filter / limit / globals-only rules.
 */
export function parseNmOutput(stdout: string, options: SymbolParseOptions = {}): ElfSymbol[] {
  const out: ElfSymbol[] = []
  const limit = options.limit ?? 5000
  const filter = options.filter?.toLowerCase()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const withSize = NM_WITH_SIZE.exec(trimmed)
    const withoutSize = withSize === null ? NM_WITHOUT_SIZE.exec(trimmed) : null
    if (withSize === null && withoutSize === null) continue

    const address = Number.parseInt((withSize ?? withoutSize)?.[1] ?? '', 16)
    if (Number.isNaN(address)) continue
    // The two output shapes put their columns in DIFFERENT positions:
    //   with size:    <addr> <size> <type> <name>   (groups 1,2,3,4)
    //   without size: <addr>        <type> <name>   (groups 1,2,3)
    // Reading the type from a fixed index made the "without size" form parse the
    // NAME as the type and then find an empty name — so every symbol from an
    // older `nm` was silently dropped.
    const size = withSize !== null ? Number.parseInt(withSize[2] ?? '0', 16) : 0
    const nmType = withSize !== null ? (withSize[3] ?? '?') : (withoutSize?.[2] ?? '?')
    const name = withSize !== null ? (withSize[4] ?? '') : (withoutSize?.[3] ?? '')
    if (name === '') continue

    // Only data-bearing sections can be sampled for a waveform.
    if (!/[bBdDgGsSrR]/.test(nmType)) continue
    // A file-local (lowercase) symbol is a `static`: it exists, but it is a
    // private copy in one translation unit, so sampling it is almost never what
    // the user means. Listing it only adds noise and wrong-looking values.
    if ((options.globalsOnly ?? true) && !isGlobalDataSymbol(nmType)) continue
    if (filter !== undefined && !name.toLowerCase().includes(filter)) continue

    const inferred = refineTypeFromName(name, inferFromNmType(nmType))
    out.push({ name, address, size, nmType, inferredType: inferred })
    if (out.length >= limit) break
  }
  return out
}

/**
 * List the data symbols of an ELF using `nm`.
 *
 * @param elfPath - path to the ELF file (user-supplied; never hardcoded).
 * @param nmPath - `nm` executable to run; defaults to `arm-none-eabi-nm`.
 * @throws when `nm` is missing or the ELF cannot be read, so a bad path is
 *   reported instead of silently producing an empty symbol list.
 */
export async function listElfSymbols(
  elfPath: string,
  nmPath = 'arm-none-eabi-nm',
  options: SymbolParseOptions = {},
): Promise<ElfSymbol[]> {
  let stdout: string
  try {
    const result = await execFileAsync(nmPath, ['-S', '--defined-only', elfPath], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    stdout = result.stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to read symbols from "${elfPath}" via "${nmPath}": ${message}`)
  }

  return parseNmOutput(stdout, options)
}

/**
 * Turn a symbol's byte width into a concrete scalar type.
 *
 * This is a WIDTH-ONLY resolver: it maps a `nm` size to its natural unsigned/float
 * width and keeps the previous fallback when the size gives no guidance. It does
 * NOT reconcile a NAME inference against the size — that is
 * `resolveSymbolType`, which preserves an explicit name hint when it fits the
 * size. Both are exported from the shared `binding-parse.ts`; this wrapper exists
 * so the existing import path (and `test/ocd.test.ts`) keeps compiling.
 *
 * @param size - symbol size in bytes as `nm` reported it (0 when unknown).
 * @param fallback - the type to keep when the size gives no guidance.
 */
export { typeForSize } from './binding-parse.ts'

/** Byte width for a binding (used for batching neighbouring reads). */
export function bindingWidth(binding: SymbolBinding): number {
  return SCALAR_BYTES[binding.type]
}
