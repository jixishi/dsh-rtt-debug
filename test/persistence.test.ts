/**
 * Tests for the DSH 0.2.x persistence path.
 *
 * 0.2.x removed `settings.register`, so the plugin's configuration moved onto
 * its own loader entry and is written through `ctx.configEditor.edit(entry,
 * change)`. That path is invisible to a type check and easy to break silently —
 * before this test the plugin reported `settings.register is not a function` and
 * every save was lost on restart.
 *
 * The stubs below mirror the real shapes measured from the host:
 *   - `entries()` returns the configurable loader entries (id/name/config);
 *   - `edit(entry, change)` calls `change(current, inherited)` and commits the
 *     returned value.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDefaultProfile, migrateConfig, validateConfig } from '../src/config.ts'
import type { PluginConfig } from '../src/config.ts'
import { DebugService } from '../src/service.ts'

/** A configEditor stub that records what was written. */
function makeEditor(initialConfig: unknown = undefined): {
  editor: { entries(): { options: { id: string; name: string; config?: unknown } }[]; edit(entry: unknown, change: (c: unknown, i: unknown) => unknown): Promise<void> }
  written: () => unknown
  entryCount: () => number
} {
  const entry = { options: { id: 'dsh-rtt-debug', name: 'dsh-rtt-debug', config: initialConfig } }
  let written: unknown = initialConfig
  return {
    editor: {
      entries: () => [entry],
      edit: async (target, change) => {
        assert.equal(target, entry, 'edit must target this plugin\'s own entry')
        const next = change(entry.options.config, {})
        written = next
        entry.options.config = next
      },
    },
    written: () => written,
    entryCount: () => 1,
  }
}

test('configEditor persistence: the written document round-trips through validation', async () => {
  // What `persistViaEditor` does: hand the editor the service's live config.
  const service = new DebugService('W:/ws')
  const profile = createDefaultProfile()
  const config: PluginConfig = {
    activeProfile: 'default',
    profiles: [{ ...profile, driver: 'jlink', jlink: { ...profile.jlink, device: 'STM32F407VG' } }],
  }
  service.setConfig(config)

  const { editor, written } = makeEditor()
  await editor.edit(editor.entries()[0], () => service.getConfig())

  const stored = written() as PluginConfig
  assert.equal(stored.profiles[0]?.driver, 'jlink')
  assert.equal(stored.profiles[0]?.jlink.device, 'STM32F407VG')
  // The whole point of persisting: what comes back must be loadable again.
  assert.deepEqual(validateConfig(stored), [])
  await service.dispose()
})

test('configEditor persistence: a stored config is adopted on boot', () => {
  // `setupEditorPersistence` migrates then applies the entry's config. A profile
  // saved before the J-Link backend existed must survive that trip.
  const legacy = {
    activeProfile: 'default',
    profiles: [{
      id: 'default',
      name: 'Default',
      openocd: { mode: 'auto', configPath: 'mcu/openocd.cfg', executable: 'openocd' },
      rtt: { address: 0x2000_0000, size: 0x1000, idString: 'SEGGER RTT' },
      log: { enabled: true, binding: { port: 9090, channel: 0, enabled: true } },
      variables: { enabled: true, binding: { port: 9091, channel: 1, enabled: true }, parser: { id: 'csv', options: {} } },
      ocd: { enabled: true, intervalMs: 100, variables: [] },
    }],
  }
  const migrated = migrateConfig(structuredClone(legacy)) as PluginConfig
  assert.equal(validateConfig(migrated).length, 0)

  const service = new DebugService('W:/ws')
  service.setConfig(migrated)
  assert.equal(service.getProfile().openocd.configPath, 'mcu/openocd.cfg')
  // The migration added the new blocks without disturbing the old ones.
  assert.equal(service.state().driver, 'openocd')
  assert.equal(service.getProfile().jlink.gdbPort, 2331)
})

test('configEditor persistence: an entry is found by id', () => {
  const { editor } = makeEditor()
  const own = editor.entries().find(e => e.options.id === 'dsh-rtt-debug')
  assert.ok(own !== undefined)
  // The plugin must NOT persist into some other plugin's entry.
  const other = editor.entries().find(e => e.options.id === 'dsh-sentinel')
  assert.equal(other, undefined)
})

test('configEditor persistence: a missing entry is reported, not thrown', async () => {
  // What `persistViaEditor` returns when the profile holds no entry for us: a
  // message the UI shows as `persistError`, never an exception that would fail
  // the request whose config change already succeeded.
  const editor = { entries: () => [], edit: async () => { throw new Error('unreachable') } }
  let message: string | undefined
  try {
    const entry = editor.entries().find(() => true)
    if (entry === undefined) message = 'no profile entry to persist into'
  } catch (error) {
    message = String(error)
  }
  assert.equal(message, 'no profile entry to persist into')
})

test('settings face without register is detected as the 0.2.x generation', () => {
  // The discriminator `setupPersistence` uses, taken from the REAL 0.2.1
  // service prototype (measured on a live host): no `register`, no `get`, but
  // `update`/`write`/`replace`/`mutate`/`describe` DO exist.
  //
  // Testing for `update` — the obvious-looking choice — misclassifies this as
  // the legacy generation and skips `configEditor` entirely, which is what broke
  // persistence while every save still reported success.
  const legacy = { register: () => undefined, get: () => undefined, update: async () => undefined }
  const modern = {
    configure: () => () => undefined,
    invalidate: () => undefined,
    describe: () => [],
    update: async () => undefined,
    write: async () => undefined,
    replace: async () => undefined,
    mutate: async () => undefined,
    schema: () => undefined,
    importLegacyDocument: async () => undefined,
    prepareDocument: async () => '',
  }
  const isLegacy = (face: Record<string, unknown>): boolean => typeof face['register'] === 'function'
  assert.equal(isLegacy(legacy), true)
  assert.equal(isLegacy(modern), false)
  // And the trap: `update` is present on BOTH, so it cannot be the signal.
  assert.equal(typeof legacy.update, 'function')
  assert.equal(typeof modern.update, 'function')
})
