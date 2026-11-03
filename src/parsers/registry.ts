/**
 * Parser registry: the extension seam for variable sources.
 *
 * Four parsers ship built in (CSV, key/value, binary frame, custom regex) and
 * cover the shapes firmware authors actually emit. A deployment that needs
 * another shape registers its own factory here instead of patching this plugin
 * — which is what keeps the plugin generic (spec §0, G1).
 */
import type { ParserFactory, VariableProvider } from '../core/types.ts'
import { CsvParser } from './csv.ts'
import { KeyValueParser } from './keyvalue.ts'
import { BinaryFrameParser } from './binary-frame.ts'
import { CustomRegexParser } from './custom-regex.ts'
import { ScriptParser } from './script.ts'

export class ParserRegistry {
  private readonly factories = new Map<string, ParserFactory>()

  /** @returns the disposer removing the registration. */
  public register(id: string, factory: ParserFactory): () => void {
    this.factories.set(id, factory)
    return () => {
      // Only remove what this registration installed; a later registration of
      // the same id owns the slot by then.
      if (this.factories.get(id) === factory) this.factories.delete(id)
    }
  }

  /** @returns true when an id is available. */
  public has(id: string): boolean {
    return this.factories.has(id)
  }

  /** Registered ids, in insertion order. */
  public list(): string[] {
    return [...this.factories.keys()]
  }

  /**
   * Instantiate a provider by id.
   * @throws when the id is unknown — a misconfigured profile must fail loudly
   *   instead of silently producing an empty waveform.
   */
  public create(id: string): VariableProvider {
    const factory = this.factories.get(id)
    if (factory === undefined) {
      throw new Error(`unknown variable parser "${id}"; available: ${this.list().join(', ') || '(none)'}`)
    }
    return factory()
  }
}

/** A registry with the built-in parsers installed. */
export function createDefaultRegistry(): ParserRegistry {
  const registry = new ParserRegistry()
  registry.register('csv', () => new CsvParser())
  registry.register('keyvalue', () => new KeyValueParser())
  registry.register('binary-frame', () => new BinaryFrameParser())
  registry.register('custom-regex', () => new CustomRegexParser())
  // The escape hatch for "my format is slightly different": a user expression
  // rather than a code blob (see `script.ts` for the sandbox rationale).
  registry.register('script', () => new ScriptParser())
  return registry
}
