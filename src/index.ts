/**
 * Host half: routes, WebSocket push, and the plugin lifecycle.
 *
 * Three transports reach the browser, one per stream so they never contend:
 *
 *   GET  /api/rtt-debug/state     full panel state
 *   GET  /api/rtt-debug/snapshot  state plus retained log/series history
 *   GET  /api/rtt-debug/export    retained log as a text download
 *   POST /api/rtt-debug/start     start the enabled sources
 *   POST /api/rtt-debug/stop      stop them
 *   POST /api/rtt-debug/clear     drop retained data
 *   POST /api/rtt-debug/config    read or replace the configuration
 *   POST /api/rtt-debug/symbols   resolve ELF symbols for the OCD reader
 *   POST /api/rtt-debug/ocd-vars  resolve configured symbols into bindings
 *   WS   /api/rtt-debug/ws/log    batched log lines
 *   WS   /api/rtt-debug/ws/series batched samples
 *
 * Every route passes the same browser-trust fence the host's own gateway uses,
 * so a cross-site page cannot reach the debug channel.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, isAbsolute, relative, dirname } from 'node:path'
import { acceptWebSocket, type ServerWebSocket } from './core/ws.ts'
import { DebugService, checkConfig } from './service.ts'
export { DebugService } from './service.ts'
import { createDefaultProfile, migrateConfig, applyToolPaths, extractToolPaths, stripToolPaths, type PluginConfig, type OcdVariableConfig, type ToolPaths } from './config.ts'
import { listElfSymbols, parseManualBinding } from './ocd/symbols.ts'
import { typeForSize, parseAddress, normalizeType } from './ocd/binding-parse.ts'
import type { SymbolBinding } from './core/types.ts'

export const name = 'dsh-rtt-debug'

/**
 * This plugin's own loader-entry id, which is also how the profile patch keys
 * its configuration (`- id: dsh-rtt-debug`). `configEditor` addresses the entry
 * by this id, so persistence depends on the two staying in sync.
 */
const PLUGIN_ID = name

/** Services this plugin needs before it can mount. */
export const inject = ['webServer', 'sessions']

/** Route prefix, kept in one place so the client and host cannot drift. */
export const ROUTE_PREFIX = '/api/rtt-debug'

/** Structural faces the host provides (typed narrowly to avoid a hard import). */
interface WebServerFace {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponseLike) => void | Promise<void> }): () => void
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void> }): () => void
}

interface ServerResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(data?: string | Uint8Array): void
}

interface SessionRow {
  header: { cwd?: string }
}
interface SessionsFace {
  get(id: string): SessionRow | undefined
}

interface PluginContext {
  webServer: WebServerFace
  sessions: SessionsFace
  /**
   * Register an effect owned by the current fiber.
   *
   * The callback may return a disposer, and that disposer may return a promise:
   * cordis awaits it (measured) before running the next one. Persistence relies
   * on that, because the teardown write must finish while the settings
   * registration is still alive.
   */
  effect(callback: () => void | (() => void | Promise<unknown>), label?: string): void
  get(name: string): unknown
  /**
   * Wait for services, then run `callback` with a context that has them.
   *
   * Declaring a dependency here is what makes the persistence path reachable:
   * `ctx.get('settings')` returns undefined during apply (a sibling provider has
   * not published yet), so reading it eagerly would skip registration, the
   * startup read, AND the teardown write — silently.
   */
  inject?(names: string[], callback: (injected: PluginContext) => void): unknown
}

/** Config namespace used with the settings face, when one is installed. */
const SETTINGS_NAMESPACE = 'dsh-rtt-debug'

/**
 * The settings service's real seam.
 *
 * This mirrors `dsh-settings`'s `SettingsProvider` (`lib/index.js`), whose
 * contract is:
 *
 *   - `register(ns, schema, options)` — `ns` must match `/^[a-z][a-z0-9-]*$/`,
 *     `schema` is a FUNCTION `(mergedLayer) => value` (a schemastery schema is
 *     callable, which is how the shipped plugins pass theirs), and the caller
 *     must register BEFORE writing: `write()` refuses an unregistered namespace.
 *     The registration is an effect on the calling fiber, so a plugin reload
 *     removes the namespace and re-registering fails loud.
 *   - `get(ns)` — returns that namespace's resolved value.
 *   - `update(ns, patch, expectedRevision?)` — merges `patch` into the namespace
 *     section as a plain object.
 *
 * The previous shape here (`get(): {value}`, `update(value)`) was invented rather
 * than read, and that assumption is exactly what hid a total persistence failure:
 * a stub built to the assumption accepts both calls, while the real service
 * stringifies the single-object argument into namespace `"[object Object]"`.
 */
interface SettingsFace {
  /**
   * Register a namespace and receive its owner scope.
   * @param ns - namespace; must match `/^[a-z][a-z0-9-]*$/`.
   * @param schema - resolves the merged layer into this namespace's value.
   * @returns a scope exposing at least `get()`, plus the namespace's disposer
   *   through the provider's own effect (cordis removes it on fiber disposal).
   *
   * ABSENT on DSH 0.2.x: that release removed namespace registration, because
   * a plugin's settings are now volatile fields of its OWN Config, edited
   * through `ctx.configEditor`. The optional marker is what lets this file
   * support both releases instead of crashing on the newer one.
   */
  register?(ns: string, schema: unknown): unknown
  /** Read a namespace's currently resolved value. */
  get?(ns: string): unknown
  /** Merge `patch` into a namespace's stored section. */
  update?(ns: string, patch: unknown, expectedRevision?: number): Promise<void> | void
}

/**
 * DSH 0.2.x's configuration editor.
 *
 * `edit(entry, change)` validates a complete candidate configuration, writes it
 * into the ACTIVE PROFILE's patch layer, and applies it immediately — that is the
 * supported way for a plugin to persist its own settings on this release.
 */
interface ConfigEditorFace {
  /** Every configurable loader entry in this profile. */
  entries(): { options: { id?: string; name?: string; config?: unknown } }[]
  /** Atomically replace one entry's configuration. */
  edit(entry: unknown, change: (current: unknown, inherited: unknown) => unknown): Promise<void>
}

// What this plugin's namespace holds: one whole plugin configuration.
interface StoredSettings {
  activeProfile?: unknown
  profiles?: unknown
}

export function apply(ctx: PluginContext): void {
  // so the service is rebuilt lazily if the session's cwd is not known yet.
  const service = new DebugService(process.cwd())

  /**
   * The registered settings face, once the service has appeared.
   *
   * Hoisted to `apply` scope because two paths need the SAME reference: the
   * `/config` handler persists through it, and the teardown disposer flushes
   * through it. `undefined` means either that no settings service is installed
   * (the plugin then keeps configuration for the process lifetime) or that its
   * registration is currently torn down — both are legitimate, non-error states.
   */
  let settingsRef: SettingsFace | undefined

  /**
   * A registration failure that leaves persistence unusable.
   *
   * Kept separate from `settingsRef` so `/config` can report "the change is live
   * but will not survive a restart" rather than reporting a clean save. Set only
   * by a non-recoverable `register` failure.
   */
  let settingsError: string | undefined

  /**
   * Resolves once the stored configuration has either been applied or been found
   * to be unavailable.
   *
   * The routes are registered synchronously inside the effect below, but the
   * stored configuration is applied from the injecting body, which runs later.
   * Measured: on a fresh boot a `/config` request can arrive in that window and
   * is then served the DEFAULTS (`intervalMs: 100`, empty `elfPath`). That is
   * indistinguishable from persistence being broken, and the t14 restart check
   * reads exactly once — so the window has to be closed rather than raced.
   *
   * Resolved on every exit path (service present, service absent, timeout) so a
   * request can never wait forever on it.
   */
  let persistenceReady: () => void = () => {}
  const ready = new Promise<void>(resolve => { persistenceReady = resolve })
  // Bounded so a deployment with no settings service cannot stall requests: in
  // that case the inject callback never runs, so this timer is the only release.
  // It fires once, and `await`-ing an already-settled promise costs nothing, so
  // the price is at most one short startup delay rather than one per request.
  //
  // Note this CANNOT be shortened by checking `ctx.get('settings')` here: at apply
  // time that is undefined even when the provider is about to publish (that is the
  // root cause of this whole defect), so such a check would release the gate
  // immediately and reopen the very race it exists to close.
  const readyDeadline = setTimeout(persistenceReady, 1000)
  const releaseReady = (): void => {
    clearTimeout(readyDeadline)
    persistenceReady()
  }

  ctx.effect(() => {
    const disposers: (() => void)[] = []

    /**
     * Write the live configuration through whichever backend this host provides.
     *
     * One function for every call site — the immediate `/config` write and the
     * teardown flush — so the two can never drift onto different backends.
     */
    const persistNow = async (): Promise<string | undefined> => {
      switch (persistence.kind) {
        case 'editor': return persistViaEditor(persistence.editor, service)
        case 'settings': return persistConfig(persistence.settings, service)
        // No persistence backend at all. Reporting success here would be the
        // exact silent-loss failure this whole path exists to prevent: the UI
        // would say "saved", and the configuration would be gone on restart.
        default:
          return settingsError
            ?? 'no configuration persistence is available on this host (neither configEditor nor settings.update)'
      }
    }

    /* ───────────────────────────── HTTP routes ──────────────────────────── */

    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isTrusted(req)) return send(res, 403, { error: 'forbidden' })
        try {
          await handleRoute(ctx, service, persistNow, () => settingsError, ready, req, res)
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))

    /* ──────────────────────────── WebSocket: log ────────────────────────── */

    const logSockets = new Set<ServerWebSocket>()
    const seriesSockets = new Set<ServerWebSocket>()

    const broadcast = (set: Set<ServerWebSocket>, payload: unknown): void => {
      if (set.size === 0) return
      const text = JSON.stringify(payload)
      for (const socket of set) {
        if (socket.readyState === 1) socket.send(text)
      }
    }

    const onLog = (records: unknown): void => broadcast(logSockets, { type: 'log', records })
    const onSeries = (samples: unknown): void => broadcast(seriesSockets, { type: 'series', samples })
    const onState = (state: unknown): void => {
      broadcast(logSockets, { type: 'state', state })
      broadcast(seriesSockets, { type: 'state', state })
    }
    const onClear = (what: 'log' | 'series' | 'all'): void => {
      broadcast(logSockets, { type: 'clear', what })
      broadcast(seriesSockets, { type: 'clear', what })
    }

    service.on('log', onLog)
    service.on('series', onSeries)
    service.on('state', onState)
    service.on('clear', onClear)
    disposers.push(() => {
      service.off('log', onLog)
      service.off('series', onSeries)
      service.off('state', onState)
      service.off('clear', onClear)
    })

    const attach = (set: Set<ServerWebSocket>, req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      if (!isTrusted(req)) {
        socket.destroy()
        return
      }
      const ws = acceptWebSocket(req, socket)
      if (ws === undefined) {
        socket.destroy()
        return
      }
      set.add(ws)
      // not wait for the next change to learn what is running.
      ws.send(JSON.stringify({ type: 'state', state: service.state() }))
      const heartbeat = setInterval(() => ws.ping(), 30_000)
      heartbeat.unref?.()
      ws.on('close', () => {
        clearInterval(heartbeat)
        set.delete(ws)
      })
      ws.on('error', () => {
        clearInterval(heartbeat)
        set.delete(ws)
      })
    }

    disposers.push(ctx.webServer.registerUpgrade({
      path: `${ROUTE_PREFIX}/ws/log`,
      handler: (req, socket, head) => attach(logSockets, req, socket, head),
    }))
    disposers.push(ctx.webServer.registerUpgrade({
      path: `${ROUTE_PREFIX}/ws/series`,
      handler: (req, socket, head) => attach(seriesSockets, req, socket, head),
    }))

    /* ─────────────────────────── settings persistence ───────────────────── */

    /**
     * Persistence backend shared by the `/config` handler and the teardown flush.
     *
     * Two host generations are supported, because they differ fundamentally:
     *
     *  - DSH 0.1.x: `settings.register(ns, schema)` gave a plugin a namespace of
     *    its own, and `update(ns, patch)` wrote it. The whole configuration lived
     *    there.
     *  - DSH 0.2.x: namespace registration is GONE. A plugin's settings are now
     *    volatile fields of its own Config, and `ctx.configEditor.edit(entry, …)`
     *    writes it into the active profile's patch layer.
     *
     * Reading the generation from the service itself — rather than from a version
     * number — is what keeps this honest: `register` being absent IS the signal,
     * and probing it is cheaper and more reliable than comparing version strings.
     */
    type Persistence =
      | { kind: 'editor'; editor: ConfigEditorFace }
      | { kind: 'settings'; settings: SettingsFace }
      | { kind: 'none' }

    let persistence: Persistence = { kind: 'none' }

    /**
     * Whether this settings face is the 0.1.x generation.
     *
     * The discriminator is `register` ALONE. `update` is NOT a signal: 0.2.x
     * still exposes `update`/`write` for editing a plugin's own volatile Config,
     * so testing for it made this file mistake the newer service for the older
     * one and skip `configEditor` entirely — which is exactly how configuration
     * stopped being persisted while every call still reported success.
     */
    const isLegacySettings = (face: SettingsFace): boolean => typeof face.register === 'function'

    const setupPersistence = (settings: SettingsFace, child: PluginContext): void => {
      // DSH 0.2.x: no namespace registration exists. `configEditor` owns
      // persistence there, and `setupEditorPersistence` has already been wired,
      // so declining here is correct — not a failure.
      if (!isLegacySettings(settings)) {
        if (persistence.kind === 'none') settingsError = undefined
        return
      }

      // Register BEFORE any read or write: the provider refuses an unregistered
      // namespace (`settings namespace "…" is not registered`), and the schema is
      // what turns the stored section into this plugin's value. The registration
      // is an effect on the injecting fiber, so a reload removes it — and the
      // re-run re-registers. `isLegacySettings` already proved `register` exists.
      try {
        settings.register?.(SETTINGS_NAMESPACE, resolveStoredConfig)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A namespace that is ALREADY registered belongs to another live instance
        // of this plugin (a hot reload overlapping the previous fiber). Reads and
        // writes still work against it, so carry on rather than losing persistence
        // for the rest of the process.
        if (!message.includes('already registered')) {
          // Any other failure means every write would throw. Record it so /config
          // reports it as `persistError` instead of the change looking saved —
          // the silent-skip failure mode this whole path exists to avoid.
          settingsError = message
          return
        }
      }
      settingsRef = settings
      persistence = { kind: 'settings', settings }

      // Load any saved configuration, then keep the service in step with it.
      const saved = readStoredConfig(settings)
      if (saved !== undefined) {
        try {
          service.setConfig(saved)
        } catch {
          // A stored document that no longer validates is ignored rather than
          // blocking startup; the defaults apply.
        }
      }

      // The teardown write is registered on the CHILD fiber, immediately after
      // the registration, because the two must be ordered: cordis disposes a
      // fiber's effects in reverse registration order and AWAITS a disposer's
      // returned promise (measured: `dispose()` blocked 51 ms on a 50 ms
      // disposer). Registering the write here therefore runs it while the
      // namespace is still registered.
      child.effect(() => {
        return () => persistConfig(settings, service)
      }, 'dsh-rtt-debug: persist settings on teardown')
    }

    /**
     * DSH 0.2.x persistence: bind to `configEditor` and adopt this entry's
     * Config as the live configuration.
     *
     * The entry is identified by the plugin's own id, which is what the profile
     * patch keys it under (see `cordis.patch.yml`: `- id: dsh-rtt-debug`).
     */
    const setupEditorPersistence = (editor: ConfigEditorFace): void => {
      persistence = { kind: 'editor', editor }
      try {
        const entry = findOwnEntry(editor)
        if (entry === undefined) return
        // A profile that already carries our configuration is the source of
        // truth on boot; the built-in defaults only apply while it is empty.
        const configured = migrateConfig(entry.options.config)
        if (configured !== undefined && checkConfig(configured).length === 0) {
          try {
            service.setConfig(configured as PluginConfig)
          } catch {
            // An unusable stored document falls back to the defaults.
          }
        }
      } catch {
        // Reading the entry list must never fail plugin activation.
      }
    }

    // Preferred path: declare the dependency and let cordis hand us the service
    // once it is present. A sibling provider has NOT published at apply time, so
    // reading `ctx.get('settings')` eagerly would find undefined and skip
    // registration, the startup read, AND the teardown write — silently, which is
    // precisely how persistence came to be broken while logging stayed clean.
    const injected = ctx.inject
    if (typeof injected === 'function') {
      // DSH 0.2.x: the configuration editor owns persistence. Declared first
      // because on that release the settings service has no `register`, so the
      // settings path below deliberately declines.
      injected.call(ctx, ['configEditor'], child => {
        const editor = child.get('configEditor') as ConfigEditorFace | undefined
        if (editor === undefined) return
        setupEditorPersistence(editor)
        releaseReady()
        // Persist on teardown through the editor: an orderly stop must flush the
        // live configuration, exactly like the settings path does on 0.1.x.
        child.effect(() => () => persistViaEditor(editor, service), 'dsh-rtt-debug: persist config on teardown')
      })

      injected.call(ctx, ['settings'], child => {
        const settings = child.get('settings') as SettingsFace | undefined
        try {
          // A settings-less deployment is legitimate: the plugin then keeps its
          // configuration for the process lifetime. Setup is skipped, but the
          // readiness gate is still released below — otherwise every request
          // would wait on a promise nothing resolves.
          if (settings !== undefined) setupPersistence(settings, child)
        } finally {
          // Release any request that arrived before the stored config was applied.
          releaseReady()
        }
      })
    } else {
      // Fallback for a context whose service is already available synchronously
      // and which exposes no `inject`. Reached by narrower harnesses rather than
      // by the real host, but skipping it would restore the silent no-op — so the
      // write goes on the outer fiber, where such a context disposes it.
      const settings = ctx.get('settings') as SettingsFace | undefined
      if (settings !== undefined) setupPersistence(settings, ctx)
      releaseReady()
    }

    // The teardown write above belongs to the persistence child fiber, so nothing
    // is registered here. `service.dispose()` stays on the outer fiber and runs
    // after the child (outer effects dispose first, then children) — which is the
    disposers.push(() => {
      void service.dispose()
    })

    return () => {
      // Chain the disposers and RETURN the chain. Cordis awaits a disposer's
      // returned promise before moving on, so returning it here is what lets the
      // settings write finish while the namespace is still registered. Running
      // them in a plain synchronous loop and dropping the promise left the write
      // racing the unregistration — the profile edit was then lost on an orderly
      // stop, which no HTTP-level assertion would have caught.
      const ordered = [...disposers].reverse()
      let task: Promise<unknown> | undefined
      for (const dispose of ordered) {
        task = task === undefined
          ? Promise.resolve(dispose()).catch(() => undefined)
          : task.then(() => dispose()).catch(() => undefined)
      }
      return task
    }
  }, 'dsh-rtt-debug: host routes')
}

/**
 * Resolve this plugin's namespace value from the merged settings layer.
 *
 * Passed to `settings.register` and called by the provider with the composition
 * base merged under the user's stored section. It must therefore tolerate
 * anything the document may hold: an invalid or partial stored section falls back
 * to the defaults rather than throwing, because a throw here fails the
 * registration itself (and with it every later write).
 *
 * @param value - the merged layer; `{}` when nothing has been stored yet.
 * @returns a configuration this plugin can run with, or undefined when the
 *   stored document has no usable shape.
 */
function resolveStoredConfig(value: unknown): PluginConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const stored = value as StoredSettings
  // An empty section means "nothing stored yet": let the service keep its
  // defaults instead of writing an empty document back.
  if (stored.profiles === undefined && stored.activeProfile === undefined) return undefined
  // A document written before the J-Link backend existed carries no `driver`
  // and no `jlink` block. Upgrading it here means every later read sees a
  // complete profile, instead of each call site inventing its own fallback.
  const migrated = migrateConfig(value)
  return checkConfig(migrated).length === 0 ? (migrated as PluginConfig) : undefined
}

// Schemastery / dsh-settings contract: when the settings catalog or any settings
// page calls `settings.describe()`, it invokes `registration.schema.toJSON()`,
// and `redactSecrets` inspects `schema.type` and `schema.dict`. Attaching these
// duck-typed properties allows DSH Web's settings catalog (and all settings pages)
// to serialize this registration without throwing `registration.schema.toJSON is not a function`.
Object.assign(resolveStoredConfig, {
  type: 'object',
  dict: {},
  toJSON: () => ({
    uid: 0,
    refs: { '0': { type: 'object', meta: { default: {} }, dict: {} } },
  }),
})

/**
 * Read this namespace's stored configuration through the real `get(ns)` seam.
 *
 * @param settings - the registered settings face.
 * @returns the stored configuration, or undefined when nothing usable is stored.
 */
function readStoredConfig(settings: SettingsFace): PluginConfig | undefined {
  // `get` is optional on the newer interface; without it there is nothing stored
  // to read, which is a normal state rather than an error.
  if (typeof settings.get !== 'function') return undefined
  try {
    return resolveStoredConfig(settings.get(SETTINGS_NAMESPACE))
  } catch {
    // An unreadable document must not block startup; the defaults apply.
    return undefined
  }
}

/**
 * Write the service's current configuration through to the settings face.
 *
 * Shared by the immediate `/config` write path and the teardown disposer so the
 * two cannot drift. Two arguments, never one object: the real seam treats the
 * first parameter as the namespace itself. A missing settings service is not an
 * error: the plugin runs without one, and then configuration simply lives for the
 * process lifetime.
 *
 * @param settings - the registered settings face, when one is present.
 * @param service - the service whose configuration is persisted.
 * @returns undefined on success (or when no settings face exists), else the
 *   failure message — persistence must never fail a request whose configuration
 *   change already succeeded in memory.
 */
async function persistConfig(settings: SettingsFace | undefined, service: DebugService): Promise<string | undefined> {
  if (settings === undefined) return undefined
  if (typeof settings.update !== 'function') return undefined
  try {
    await settings.update(SETTINGS_NAMESPACE, service.getConfig())
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** This plugin's own loader entry, as `configEditor` addresses it. */
function findOwnEntry(editor: ConfigEditorFace): { options: { id?: string; name?: string; config?: unknown } } | undefined {
  try {
    return editor.entries().find(entry => entry.options.id === PLUGIN_ID || entry.options.name === PLUGIN_ID)
  } catch {
    return undefined
  }
}

/**
 * Persist the live configuration through DSH 0.2.x's `configEditor`.
 *
 * `edit` is given a change function, not a value: the editor reconciles the
 * current and inherited layers itself and validates the complete candidate, so
 * returning the whole configuration is both the documented and the safe form —
 * it cannot lose a field it did not know about, because it replaces the entry's
 * section wholesale with what the service actually holds.
 *
 * @returns undefined on success, else the failure message. Persistence must
 *   never fail a request whose configuration change already succeeded in memory.
 */
async function persistViaEditor(editor: ConfigEditorFace, service: DebugService): Promise<string | undefined> {
  try {
    const entry = findOwnEntry(editor)
    if (entry === undefined) return `no profile entry "${PLUGIN_ID}" to persist into`
    const config = service.getConfig()
    await editor.edit(entry, () => config)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
const WORKSPACE_CONFIG_REL = '.dsh/rtt-debug.json'

/**
 * Read configuration saved specifically to this workspace (.dsh/rtt-debug.json).
 * Allows project-level configuration to travel with the repository/session.
 */
async function readWorkspaceConfig(workspaceRoot: string): Promise<PluginConfig | undefined> {
  try {
    const fullPath = join(workspaceRoot, WORKSPACE_CONFIG_REL)
    const text = await readFile(fullPath, 'utf8')
    const parsed = JSON.parse(text)
    // Migrate before validating: a `.dsh/rtt-debug.json` committed to a repo
    // before the J-Link backend existed would otherwise fail validation here and
    // be silently ignored, losing every setting the project pinned.
    const migrated = migrateConfig(parsed)
    if (checkConfig(migrated).length === 0) return migrated as PluginConfig
  } catch {
    // Missing, unreadable, or invalid — fall back to global settings
  }
  return undefined
}

/**
 * Write the PROJECT layer: the workspace's `.dsh/rtt-debug.json`.
 *
 * Tool paths are pulled back to their generic defaults here — see `ToolPaths`.
 * They are machine-wide facts living in the global layer, so a copy in the
 * repository would be both redundant and actively harmful (it would ship one
 * developer's absolute install paths to everyone).
 */
async function writeWorkspaceConfig(workspaceRoot: string, config: PluginConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const fullPath = join(workspaceRoot, WORKSPACE_CONFIG_REL)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, JSON.stringify(stripToolPaths(config), null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read the MACHINE-WIDE tool paths.
 *
 * They live in the plugin's global layer — on DSH 0.2.x that is this entry's
 * `config` in the active profile patch, on 0.1.x it is the settings namespace.
 * The caller passes the currently live configuration, which already holds
 * whatever either layer supplied, so this only needs to identify the subset.
 */
function readToolPaths(config: PluginConfig): ToolPaths {
  return extractToolPaths(config)
}

/**
 * Scan workspace (and user desktop fallback) for candidate files (*.cfg, *.elf, etc.).
 */
async function discoverWorkspaceFiles(root: string, type: string): Promise<{ path: string; relPath: string; name: string }[]> {
  const exts = type === 'openocd'
    ? ['.cfg']
    : type === 'elf'
      ? ['.elf', '.axf', '.out']
      : ['.cfg', '.elf', '.axf', '.out']
  const results: { path: string; relPath: string; name: string }[] = []
  const seen = new Set<string>()

  async function scan(dir: string, depth: number) {
    if (depth > 4) return
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.dsh') continue
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.verify') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await scan(full, depth + 1)
        } else if (entry.isFile()) {
          const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : ''
          if (exts.includes(ext) && !seen.has(full)) {
            seen.add(full)
            const rel = relative(root, full).replace(/\\/g, '/')
            results.push({ path: full, relPath: rel, name: entry.name })
          }
        }
      }
    } catch {}
  }

  await scan(root, 0)
  return results
}

/* ─────────────────────────────── route handling ───────────────────────────── */

/**
 * Handle one request under the route prefix.
 *
 * @param ctx - plugin context (sessions, for the workspace root).
 * @param service - the debug service backing every route.
 * @param persistence - writes the live configuration to whichever backend this
 *   host generation provides (DSH 0.2.x `configEditor`, or 0.1.x settings).
 *   Passed as a function rather than a captured face because the backend appears
 *   and disappears with the services' lifecycle, so a captured value would go
 *   stale.
 * @param settingsError - a registration failure that makes persistence unusable,
 *   or undefined. Reported so a change is never presented as durable when it is
 *   not.
 * @param persistenceReady - resolves once the stored configuration has been
 *   applied or found unavailable. Every read waits on it so a request that lands
 *   during startup cannot be served the defaults (see `apply`).
 * @param req - incoming request.
 * @param res - response to write.
 */
async function handleRoute(
  ctx: PluginContext,
  service: DebugService,
  persistence: () => Promise<string | undefined>,
  settingsError: () => string | undefined,
  persistenceReady: Promise<void>,
  req: IncomingMessage,
  res: ServerResponseLike,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.slice(ROUTE_PREFIX.length)
  const method = (req.method ?? 'GET').toUpperCase()

  // Wait for the stored configuration to be applied before serving anything that
  // reflects it (`/state`, `/snapshot`, `/config`, `/profiles`). A request landing
  // during startup would otherwise be told the DEFAULTS — indistinguishable from
  // persistence having failed, and the t14 restart check reads exactly once. The
  // gate is bounded (see `apply`), so this can never hang a request.
  await persistenceReady

  // Every request carries the caller's workspace so relative config paths,
  // ELF paths and uploads resolve consistently against the active session's cwd.
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId !== null) {
    const cwd = ctx.sessions.get(sessionId)?.header.cwd
    if (cwd !== undefined && cwd !== '') {
      service.setWorkspaceRoot(cwd)
    } else {
      // Session missing or empty cwd: fall back to host process.cwd() (F3 convention)
      service.setWorkspaceRoot(process.cwd())
    }
  } else {
    // No sessionId provided: fall back to host process.cwd() (F3 convention)
    service.setWorkspaceRoot(process.cwd())
  }

  if (method === 'GET' && path === '/state') {
    send(res, 200, service.state())
    return
  }

  if (method === 'GET' && path === '/snapshot') {
    send(res, 200, service.snapshot())
    return
  }

  if (method === 'GET' && path === '/export') {
    const text = service.exportLog()
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`rtt-log-${stamp()}.txt`)}`,
    )
    res.end(text)
    return
  }

  if (method === 'GET' && path === '/fs/discover') {
    const type = url.searchParams.get('type') ?? 'all'
    const root = service.getWorkspaceRoot()
    const files = await discoverWorkspaceFiles(root, type)
    send(res, 200, { root, files })
    return
  }

  if (method === 'GET' && path === '/fs/list') {
    const reqDir = url.searchParams.get('dir') ?? ''
    const extFilter = url.searchParams.get('ext')?.toLowerCase().split(',').filter(Boolean) ?? []
    const root = service.getWorkspaceRoot()
    const targetDir = reqDir === '' ? root : (isAbsolute(reqDir) ? reqDir : resolve(root, reqDir))
    try {
      const dirents = await readdir(targetDir, { withFileTypes: true })
      const entries: { name: string; isDirectory: boolean; size?: number; ext?: string; path: string }[] = []
      for (const d of dirents) {
        if (d.name.startsWith('.') && d.name !== '.dsh') continue
        if (d.name === 'node_modules') continue
        const fullPath = join(targetDir, d.name)
        const isDir = d.isDirectory()
        if (isDir) {
          entries.push({ name: d.name, isDirectory: true, path: fullPath })
        } else {
          const ext = d.name.includes('.') ? '.' + d.name.split('.').pop()!.toLowerCase() : ''
          if (extFilter.length > 0 && !extFilter.includes(ext)) continue
          let size = 0
          try {
            const st = await stat(fullPath)
            size = st.size
          } catch {}
          entries.push({ name: d.name, isDirectory: false, size, ext, path: fullPath })
        }
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const isRoot = resolve(targetDir) === resolve(root)
      const parentDir = isRoot ? null : resolve(targetDir, '..')
      const relPath = relative(root, targetDir).replace(/\\/g, '/')
      send(res, 200, {
        currentDir: targetDir,
        displayDir: relPath === '' ? '.' : relPath,
        parentDir,
        isRoot,
        entries,
      })
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (method === 'GET' && path === '/variables') {
    const config = service.getConfig()
    const active = config.profiles.find(p => p.id === config.activeProfile) ?? config.profiles[0]
    const root = service.getWorkspaceRoot()
    const workspaceCfg = await readWorkspaceConfig(root)
    const hasWorkspace = workspaceCfg !== undefined
    send(res, 200, {
      enabled: active?.ocd.enabled ?? false,
      configPath: active?.openocd.configPath ?? '',
      // Machine-wide: which OpenOCD binary to run.
      openocdExecutable: active?.openocd.executable ?? 'openocd',
      // Machine-wide: which J-Link launcher to run.
      jlinkExecutable: active?.jlink.executable ?? '',
      elfPath: active?.ocd.elfPath ?? '',
      nmPath: active?.ocd.nmPath ?? 'arm-none-eabi-nm',
      intervalMs: active?.ocd.intervalMs ?? 100,
      variables: active?.ocd.variables ?? [],
      configScope: hasWorkspace ? 'workspace' : 'global',
      workspaceFile: hasWorkspace ? WORKSPACE_CONFIG_REL : undefined,
    })
    return
  }

  if (method !== 'POST') return send(res, 405, { error: 'method not allowed' })

  const body = await readJson(req)

  if (path === '/variables') {
    const input = body as {
      variables?: unknown[]
      elfPath?: string
      configPath?: string
      openocdExecutable?: string
      jlinkExecutable?: string
      nmPath?: string
      intervalMs?: number
      enabled?: boolean
      target?: 'workspace' | 'global'
    } | undefined

    if (input === undefined || typeof input !== 'object') {
      return send(res, 400, { error: 'request body must be an object' })
    }

    const config = service.getConfig()
    const profileId = config.activeProfile
    const profile = config.profiles.find(p => p.id === profileId) ?? config.profiles[0]
    if (profile === undefined) return send(res, 500, { error: 'no active profile' })

    if (typeof input.configPath === 'string') {
      profile.openocd.configPath = input.configPath.trim()
    }
    // Machine-wide tool locations: they belong to the global layer, but they ride
    // the same request so one save keeps both layers consistent.
    if (typeof input.openocdExecutable === 'string') {
      profile.openocd.executable = input.openocdExecutable.trim() === '' ? 'openocd' : input.openocdExecutable.trim()
    }
    if (typeof input.jlinkExecutable === 'string') {
      profile.jlink.executable = input.jlinkExecutable.trim()
    }
    if (typeof input.nmPath === 'string') {
      profile.ocd.nmPath = input.nmPath.trim() === '' ? 'arm-none-eabi-nm' : input.nmPath.trim()
    }
    if (typeof input.elfPath === 'string') {
      profile.ocd.elfPath = input.elfPath.trim()
    }
    if (typeof input.enabled === 'boolean') {
      profile.ocd.enabled = input.enabled
    }
    if (typeof input.intervalMs === 'number' && Number.isFinite(input.intervalMs) && input.intervalMs > 0) {
      profile.ocd.intervalMs = input.intervalMs
    }

    if (Array.isArray(input.variables)) {
      const resolvedVariables: OcdVariableConfig[] = []
      const effectiveElfPath = profile.ocd.elfPath
      let elfSymbols: Awaited<ReturnType<typeof listElfSymbols>> | undefined

      for (const item of input.variables) {
        if (typeof item === 'string') {
          const manual = parseManualBinding(item)
          if (manual !== undefined) {
            resolvedVariables.push({
              source: 'manual',
              name: manual.name,
              address: manual.address,
              type: manual.type,
            })
            continue
          }
          const symName = item.trim()
          if (symName === '') continue
          if (effectiveElfPath !== '') {
            if (elfSymbols === undefined) {
              const realElf = service.resolveWorkspacePath(effectiveElfPath)
              try {
                elfSymbols = await listElfSymbols(realElf, profile.ocd.nmPath)
              } catch {}
            }
            const found = elfSymbols?.find(s => s.name === symName)
            if (found !== undefined) {
              const type = found.size > 0 ? typeForSize(found.size, found.inferredType) : found.inferredType
              resolvedVariables.push({
                source: 'symbol',
                symbol: found.name,
                name: found.name,
                address: found.address,
                type,
              })
              continue
            }
          }
          resolvedVariables.push({ source: 'symbol', symbol: symName, name: symName, address: 0, type: 'u32' })
        } else if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>
          const name = typeof obj.name === 'string' ? obj.name : (typeof obj.symbol === 'string' ? obj.symbol : 'var')
          const rawAddr = obj.address
          let address = 0
          if (typeof rawAddr === 'number') address = rawAddr >>> 0
          else if (typeof rawAddr === 'string') address = parseAddress(rawAddr) ?? 0
          const type = typeof obj.type === 'string' ? (normalizeType(obj.type) ?? 'u32') : 'u32'
          const unit = typeof obj.unit === 'string' && obj.unit.trim() !== '' ? obj.unit.trim() : undefined
          const source = obj.source === 'manual' || (obj.source === undefined && address > 0 && typeof obj.symbol !== 'string')
            ? 'manual'
            : 'symbol'
          resolvedVariables.push({
            source,
            ...(typeof obj.symbol === 'string' ? { symbol: obj.symbol } : {}),
            name,
            address,
            type,
            ...(unit ? { unit } : {}),
          })
        }
      }
      profile.ocd.variables = resolvedVariables
    }

    service.setConfig(config)

    /* Same two-layer split as /config: tool paths are machine-wide, everything
       else belongs to the project. One save writes both, so a failure in either
       layer is reported rather than silently dropping half the change. */
    const workspaceRoot = service.getWorkspaceRoot()
    const persistError = await persistence()
    const resW = await writeWorkspaceConfig(workspaceRoot, config)
    const reported = persistError ?? (resW.ok ? undefined : resW.error)
    send(res, 200, {
      ok: true,
      count: profile.ocd.variables.length,
      variables: profile.ocd.variables,
      enabled: profile.ocd.enabled,
      intervalMs: profile.ocd.intervalMs,
      configPath: profile.openocd.configPath,
      openocdExecutable: profile.openocd.executable,
      jlinkExecutable: profile.jlink.executable,
      elfPath: profile.ocd.elfPath,
      nmPath: profile.ocd.nmPath,
      persisted: reported === undefined,
      configScope: 'both',
      workspaceFile: WORKSPACE_CONFIG_REL,
      ...(reported ? { persistError: reported } : {}),
    })
    return
  }

  if (path === '/start') {
    await service.start()
    send(res, 200, service.state())
    return
  }

  if (path === '/stop') {
    await service.stop()
    send(res, 200, service.state())
    return
  }

  if (path === '/clear') {
    const what = (body as { what?: unknown })?.what
    if (what !== 'log' && what !== 'series' && what !== 'all') {
      return send(res, 400, { error: 'what must be "log", "series" or "all"' })
    }
    service.clear(what)
    send(res, 200, service.state())
    return
  }

  if (path === '/config') {
    const patch = body as { config?: unknown; profileId?: unknown; target?: 'workspace' | 'global' } | undefined
    const workspaceRoot = service.getWorkspaceRoot()
    const workspaceCfg = await readWorkspaceConfig(workspaceRoot)
    const hasWorkspaceConfig = workspaceCfg !== undefined

    let changed = false
    if (patch?.profileId !== undefined) {
      if (typeof patch.profileId !== 'string') return send(res, 400, { error: 'profileId must be a string' })
      service.setActiveProfile(patch.profileId)
      changed = true
    }
    if (patch?.config !== undefined) {
      const problems = checkConfig(patch.config)
      if (problems.length > 0) return send(res, 400, { error: problems.join('; ') })
      service.setConfig(patch.config as PluginConfig)
      changed = true
    }

    const config = service.getConfig()
    if (!changed) {
      if (hasWorkspaceConfig && workspaceCfg !== undefined) {
        // Recombine the two layers: the PROJECT document supplies the target
        // settings, the live configuration supplies the machine-wide tool paths
        // (which the workspace file deliberately does not carry).
        service.setConfig(applyToolPaths(workspaceCfg, readToolPaths(service.getConfig())))
      }
      const active = service.getConfig()
      send(res, 200, {
        ...active,
        configScope: hasWorkspaceConfig ? 'workspace' : 'global',
        workspaceFile: hasWorkspaceConfig ? WORKSPACE_CONFIG_REL : undefined,
      })
      return
    }

    /* One save writes BOTH layers, because the settings split along two owners:
       the machine-wide tool paths and the project-scoped target settings. Which
       one the caller named only decides where a FAILURE is reported; neither
       layer is skipped, or the split would silently drop half the change. */
    const persistError = await persistence()
    const resW = await writeWorkspaceConfig(workspaceRoot, config)
    const reported = persistError ?? settingsError() ?? (resW.ok ? undefined : resW.error)
    send(res, 200, reported === undefined
      ? { ...config, persisted: true, configScope: 'both', workspaceFile: WORKSPACE_CONFIG_REL }
      : { ...config, persisted: false, persistError: reported, configScope: 'both', workspaceFile: WORKSPACE_CONFIG_REL })
    return
  }

  if (path === '/profiles') {
    const config = service.getConfig()
    send(res, 200, { profiles: config.profiles, activeProfile: config.activeProfile })
    return
  }

  if (path === '/profiles/add') {
    const label = (body as { name?: unknown })?.name
    if (typeof label !== 'string' || label.trim() === '') {
      return send(res, 400, { error: 'name must be a non-empty string' })
    }
    const config = service.getConfig()
    const id = uniqueId(label, config.profiles.map(p => p.id))
    config.profiles.push(createDefaultProfile(id, label.trim()))
    service.setConfig(config)
    // Persist here too, for the same reason /config does: relying on the teardown
    // write alone makes durability depend on the disposal order between this
    // plugin's fiber and the settings registration's own effect. The provider's
    // write queue can then lose the race and reject the write as
    // "registration was disposed before the queued update ran" — and an abnormal
    // exit never runs teardown at all. Writing while the request is in flight is
    // the only ordering that is unconditionally safe.
    const addedError = await persistence()
    const added = service.getConfig()
    send(res, 200, addedError === undefined ? added : { ...added, persisted: false, persistError: addedError })
    return
  }

  if (path === '/symbols') {
    const params = body as { elfPath?: unknown; nmPath?: unknown; filter?: unknown; globalsOnly?: unknown } | undefined
    if (typeof params?.elfPath !== 'string' || params.elfPath.trim() === '') {
      return send(res, 400, { error: 'elfPath must be a non-empty string' })
    }
    const rawElfPath = params.elfPath.trim()
    // Resolve relative elfPath against the session workspace root (or process.cwd() fallback).
    // Absolute paths are passed through unchanged; nmPath is an executable name and is not path-resolved.
    const elfPath = service.resolveWorkspacePath(rawElfPath)
    const nmPath = typeof params.nmPath === 'string' && params.nmPath.trim() !== ''
      ? params.nmPath.trim()
      : 'arm-none-eabi-nm'
    let symbols: Awaited<ReturnType<typeof listElfSymbols>>
    try {
      symbols = await listElfSymbols(
        elfPath,
        nmPath,
        {
          // A file-local `static` is a private copy in one translation unit;
          // offering it would invite sampling an address the running code never
          // writes. Globals only, unless a caller explicitly asks otherwise.
          globalsOnly: params.globalsOnly !== false,
          ...(typeof params.filter === 'string' && params.filter !== '' ? { filter: params.filter } : {}),
        },
      )
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    send(res, 200, { symbols })
    return
  }

  if (path === '/ocd-vars') {
    // Resolve configured symbols against a fresh ELF read so the UI can show
    // the concrete addresses the reader will sample.
    const params = body as { elfPath?: unknown; variables?: unknown } | undefined
    if (!Array.isArray(params?.variables)) {
      return send(res, 400, { error: 'variables must be an array' })
    }
    const rawElfPath = typeof params.elfPath === 'string' ? params.elfPath.trim() : ''
    // Resolve relative elfPath against the session workspace root (or process.cwd() fallback).
    const elfPath = rawElfPath !== '' ? service.resolveWorkspacePath(rawElfPath) : ''
    let resolved: (SymbolBinding & { ok: boolean; reason?: string })[] = []

    if (elfPath !== '') {
      let symbols: Awaited<ReturnType<typeof listElfSymbols>>
      try {
        symbols = await listElfSymbols(elfPath)
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      const byName = new Map(symbols.map(s => [s.name, s]))
      resolved = (params.variables as unknown[]).map(raw => {
        const entry = raw as { symbol?: unknown; name?: unknown }
        const symbolName = typeof entry.symbol === 'string' ? entry.symbol : ''
        const found = byName.get(symbolName)
        if (found === undefined) {
          return {
            ok: false,
            reason: `symbol "${symbolName}" not found in ${elfPath}`,
            name: symbolName,
            address: 0,
            type: 'u32' as const,
          }
        }
        // Reconcile the symbol's NAME inference against `nm`'s SIZE. When a name
        // hint is present, developer intent governs (preserving signedness, float
        // and bool semantics even on conflict); when no hint is present, size determines
        // the width (see `typeForSize`).
        const type = found.size > 0 ? typeForSize(found.size, found.inferredType) : found.inferredType
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : found.name
        return { ok: true, name, address: found.address, type }
      })
    } else {
      // No ELF: fall back to manual address syntax in the symbol field.
      resolved = (params.variables as unknown[]).map(raw => {
        const entry = raw as { symbol?: unknown; name?: unknown }
        const parsed = parseManualBinding(typeof entry.symbol === 'string' ? entry.symbol : '')
        if (parsed === undefined) {
          return { ok: false, reason: 'not a resolvable symbol and not a manual address', name: '', address: 0, type: 'u32' as const }
        }
        const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : parsed.name
        return { ok: true, name, address: parsed.address, type: parsed.type }
      })
    }
    send(res, 200, { resolved })
    return
  }

  send(res, 404, { error: `unknown route ${path}` })
}

/**
 * Browser-trust fence.
 *
 * Mirrors the host gateway's rule: a loopback Host header is trusted, anything
 * else is not. Without this a page on another origin could reach the debug
 * routes through a bare `fetch`.
 */
function isTrusted(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host === '') return true   // non-browser client
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (bare === undefined) return false
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '::ffff:127.0.0.1'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    // A configuration document has no business being megabytes.
    if (size > 4 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function send(res: ServerResponseLike, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // The debug channel is live state: cached copies would be misleading.
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function uniqueId(label: string, taken: readonly string[]): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.includes(candidate)) return candidate
  }
}
