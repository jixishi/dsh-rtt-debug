import { defineConfig } from 'tsdown'

/**
 * Two faces, two bundles — the standard DSH plugin shape:
 *
 *   lib/index.js   host half   — plain Node ESM, loaded by the profile's cordis tree
 *   lib/client.js  browser half — the `window.__ModuleLoader__.load({id, factory})`
 *                  registration consumed by `@deepseek-ai/dsh-client-modules`
 *
 * The client half is built as CJS and wrapped in the loader's factory closure:
 * that is the documented lazy-CJS contract (executing the script only REGISTERS
 * a factory; module bodies run at materialization, when the shell hands the
 * factory its `require`). Building it as IIFE instead would tree-shake the whole
 * body away, because an IIFE has no export consumer.
 *
 * React is deliberately left external in the client bundle: the shell seeds a
 * frozen platform module table (React, cordis, the static UI libraries) and the
 * factory's `require` resolves against it. Bundling React would duplicate the
 * runtime and break hooks across the two copies.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: false,
    // Node builtins and any future @deepseek-ai/* import stay external; the host
    // side must not ship a second copy of the harness runtime.
    deps: { neverBundle: [/^@deepseek-ai\//, /^node:/] },
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime', /^@deepseek-ai\//] },
    outExtensions: () => ({ js: '.js' }),
    outputOptions: {
      // Wrapping the CJS body in the registration closure is what turns a plain
      // module into a lazily-materialized plugin bundle. `module`/`exports` are
      // declared by the intro because the factory receives neither — only
      // `require` — while the CJS body assigns to `exports`.
      banner: [
        '// dsh-rtt-debug — browser half.',
        '// Registers a factory with the shell module table; nothing executes until',
        '// the tab is first opened (materialization), which is the lazy-CJS contract.',
        'window.__ModuleLoader__.load({',
        '  id: "dsh-rtt-debug",',
        '  factory: (require) => {',
        '    var module = { exports: {} };',
        '    var exports = module.exports;',
      ].join('\n'),
      footer: '    return module.exports;\n  }\n});',
    },
  },
])
