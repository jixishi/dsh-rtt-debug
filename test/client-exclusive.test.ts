/**
 * The two sidebar surfaces are MUTUALLY EXCLUSIVE.
 *
 * A registered workbench tab is ALSO mirrored into DSH's native right sidebar by
 * better-sidebar itself, so a plugin that registers into both shows two
 * identically-named entries in one sidebar — the defect this file pins down.
 *
 * The test runs against `lib/client.js`, the bundle the host actually executes,
 * because the source is TSX (the Node test runner cannot import it directly).
 * The fake host models the one cordis behaviour the decision depends on:
 * `inject` fires when its services are present, and again when they appear later.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'client.js')

/** Load the bundle the way the shell does: register the factory, then run it. */
async function loadClientModule() {
  let factory
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration) { factory = registration.factory },
    },
  }
  const source = readFileSync(bundle, 'utf8')
  // The bundle is a closure that calls window.__ModuleLoader__.load(...).
  const run = new Function('window', 'document', 'require', source)
  const head = { appendChild() {}, removeChild() {} }
  const doc = {
    head,
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  }
  run(fakeWindow, doc, () => ({ createElement: () => null }))

  const g = globalThis
  const hadWindow = 'window' in g
  if (!hadWindow) g.window = fakeWindow
  try {
    return factory(() => ({ createElement: () => ({}) }))
  } finally {
    if (!hadWindow) delete g.window
  }
}

/**
 * Let the native seat's deliberate one-macrotask deferral run.
 *
 * `apply` claims the native surface on `setTimeout(..., 0)` so a workbench that
 * activates in the same tick can win the race; every assertion about which
 * surface registered therefore has to wait one tick.
 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

/** A fake cordis host: provides services and re-runs waiting injections. */
function makeHost() {
  const provided = new Map()
  const waiting = []
  const teardown = []
  const counts = { native: 0, workbench: 0 }

  const rerun = () => {
    for (const entry of [...waiting]) {
      if (entry.names.every(n => provided.has(n))) entry.callback(entry.injected)
    }
  }

  const provide = (name, value) => {
    provided.set(name, value)
    rerun()
  }

  const ctx = {
    get: name => provided.get(name),
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') teardown.push(disposer)
    },
    inject(names, callback) {
      const injected = {
        get: name => provided.get(name),
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') teardown.push(disposer)
        },
      }
      waiting.push({ names, callback, injected })
      rerun()
      return () => {}
    },
  }

  return {
    ctx,
    counts,
    provideNative() {
      provide('sidebarRightTabs', {
        register: () => {
          counts.native++
          return () => { counts.native-- }
        },
      })
      provide('slots', {
        register: () => () => {},
        inject: (_slot, callback) => (callback(), () => {}),
      })
    },
    provideWorkbench() {
      provide('betterSidebar', {
        registerTab: () => {
          counts.workbench++
          return () => { counts.workbench-- }
        },
      })
    },
  }
}

test('workbench present: only the workbench registers, the native seat stands down', async () => {
  const mod = await loadClientModule()
  const host = makeHost()
  host.provideNative()
  host.provideWorkbench()
  mod.apply(host.ctx)
  await settle()

  assert.equal(host.counts.workbench, 1, 'the workbench owns the tab')
  assert.equal(host.counts.native, 0, 'the native seat must NOT also register')
})

test('workbench absent: the native seat is used instead', async () => {
  const mod = await loadClientModule()
  const host = makeHost()
  host.provideNative()
  mod.apply(host.ctx)
  await settle()

  assert.equal(host.counts.workbench, 0)
  assert.equal(host.counts.native, 1, 'a standalone deployment still gets a tab')
})

test('workbench arriving late never produces a second tab', async () => {
  const mod = await loadClientModule()
  const host = makeHost()
  host.provideNative()
  mod.apply(host.ctx)
  await settle()
  assert.equal(host.counts.native, 1)

  host.provideWorkbench()
  await settle()
  assert.equal(host.counts.native + host.counts.workbench, 1,
    'exactly one tab exists after the workbench arrives late')
})

test('neither surface present: the plugin still activates without a tab', async () => {
  const mod = await loadClientModule()
  const host = makeHost()
  mod.apply(host.ctx)
  await settle()

  assert.equal(host.counts.native, 0)
  assert.equal(host.counts.workbench, 0)
})
