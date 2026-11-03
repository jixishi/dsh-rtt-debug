// Verify the built bundles: the host half must export the plugin contract, and
// the client half must register a lazy factory with the shell's module loader.
// Paths resolve from this file's own location, so the check can be run from
// anywhere (the project root is one level up from _recover/).
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
const checks = [
  ['host exports name', mod.name === 'dsh-rtt-debug', String(mod.name)],
  ['host exports apply()', typeof mod.apply === 'function', typeof mod.apply],
  ['host declares inject[]', Array.isArray(mod.inject), JSON.stringify(mod.inject)],
]

const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const idMatch = /id:\s*["']([^"']+)["']/.exec(client)
checks.push(['client registers via __ModuleLoader__', client.includes('__ModuleLoader__.load')])
checks.push(['client factory id is the package', idMatch?.[1] === 'dsh-rtt-debug', String(idMatch?.[1])])
checks.push(['client exported as factory', client.includes('factory:')])

let failed = 0
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!ok) failed++
}
console.log(failed === 0 ? '\nall bundle checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
