/**
 * Tests for the settings split and the symbol roster.
 *
 * Two rules with real consequences:
 *
 *   1. **Tool paths are machine-wide, everything else is project-scoped.** A
 *      mistake here either asks every new project for the same three install
 *      paths again, or ships one developer's `C:\Program Files\...` into the
 *      repository.
 *   2. **Only GLOBAL data symbols are offered.** A file-local `static` is a
 *      private copy in one translation unit, so sampling it yields a value the
 *      running code never writes — a wrong number that looks right.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyToolPaths,
  createDefaultProfile,
  defaultToolPaths,
  extractToolPaths,
  stripToolPaths,
  validateConfig,
} from '../src/config.ts'
import type { PluginConfig } from '../src/config.ts'
import { isGlobalDataSymbol, listElfSymbols, parseNmOutput } from '../src/ocd/symbols.ts'

/* ───────────────────────────── tool-path layering ───────────────────────── */

function configWith(tools: { openocd?: string; jlink?: string; nm?: string }): PluginConfig {
  const profile = createDefaultProfile()
  if (tools.openocd !== undefined) profile.openocd.executable = tools.openocd
  if (tools.jlink !== undefined) profile.jlink.executable = tools.jlink
  if (tools.nm !== undefined) profile.ocd.nmPath = tools.nm
  return { activeProfile: 'default', profiles: [profile] }
}

test('extractToolPaths: pulls the three machine-wide locations from the active profile', () => {
  const config = configWith({
    openocd: 'C:/tools/openocd/openocd.exe',
    jlink: 'C:/Program Files/SEGGER/JLink/JLinkGDBServerCL.exe',
    nm: 'C:/arm/bin/arm-none-eabi-nm.exe',
  })
  assert.deepEqual(extractToolPaths(config), {
    openocdExecutable: 'C:/tools/openocd/openocd.exe',
    jlinkExecutable: 'C:/Program Files/SEGGER/JLink/JLinkGDBServerCL.exe',
    nmPath: 'C:/arm/bin/arm-none-eabi-nm.exe',
  })
})

test('stripToolPaths: the project layer carries generic defaults, not this machine’s paths', () => {
  const config = configWith({ openocd: 'D:/x/openocd.exe', jlink: 'D:/x/jlink.exe', nm: 'D:/x/nm.exe' })
  const stripped = stripToolPaths(config)
  const defaults = defaultToolPaths()
  // The absolute paths must NOT survive into a file that gets committed.
  assert.equal(stripped.profiles[0]?.openocd.executable, defaults.openocdExecutable)
  assert.equal(stripped.profiles[0]?.jlink.executable, defaults.jlinkExecutable)
  assert.equal(stripped.profiles[0]?.ocd.nmPath, defaults.nmPath)
  for (const value of [stripped.profiles[0]?.openocd.executable, stripped.profiles[0]?.jlink.executable, stripped.profiles[0]?.ocd.nmPath]) {
    assert.doesNotMatch(value ?? '', /^[A-Za-z]:[/\\]/, 'no drive-letter path may remain')
  }
})

test('stripToolPaths: the project layer keeps every target setting', () => {
  const profile = createDefaultProfile()
  profile.driver = 'jlink'
  profile.jlink.device = 'STM32F407VG'
  profile.jlink.speedKhz = 4000
  profile.openocd.configPath = 'mcu/openocd.cfg'
  profile.ocd.elfPath = 'build/fw.elf'
  profile.ocd.intervalMs = 20
  profile.ocd.variables = [{ source: 'manual', name: 'v', address: 0x2000_0000, type: 'u16' }]
  profile.variables.parser = { id: 'script', options: { expression: '{ a: fields[0] }' } }

  const stripped = stripToolPaths({ activeProfile: 'default', profiles: [profile] })
  const kept = stripped.profiles[0]!
  assert.equal(kept.driver, 'jlink')
  assert.equal(kept.jlink.device, 'STM32F407VG')
  assert.equal(kept.openocd.configPath, 'mcu/openocd.cfg')
  assert.equal(kept.ocd.elfPath, 'build/fw.elf')
  assert.equal(kept.ocd.intervalMs, 20)
  assert.equal(kept.ocd.variables.length, 1)
  assert.equal(kept.variables.parser.id, 'script')
})

test('applyToolPaths: the global layer wins over a stale copy in the project file', () => {
  // A repository may still hold whatever paths an earlier save wrote; this
  // machine's install is the truth.
  const project = configWith({ openocd: 'C:/old/openocd.exe', jlink: '', nm: 'arm-none-eabi-nm' })
  const applied = applyToolPaths(project, {
    openocdExecutable: 'C:/new/openocd.exe',
    jlinkExecutable: 'C:/new/JLinkGDBServerCL.exe',
    nmPath: 'C:/new/nm.exe',
  })
  assert.equal(applied.profiles[0]?.openocd.executable, 'C:/new/openocd.exe')
  assert.equal(applied.profiles[0]?.jlink.executable, 'C:/new/JLinkGDBServerCL.exe')
  assert.equal(applied.profiles[0]?.ocd.nmPath, 'C:/new/nm.exe')
  // The input must not be mutated: the caller may still hold the old value.
  assert.equal(project.profiles[0]?.openocd.executable, 'C:/old/openocd.exe')
})

test('applyToolPaths: missing entries fall back to the generic defaults', () => {
  const applied = applyToolPaths(createDefaultConfigLike(), {})
  const defaults = defaultToolPaths()
  assert.equal(applied.profiles[0]?.openocd.executable, defaults.openocdExecutable)
  assert.equal(applied.profiles[0]?.jlink.executable, defaults.jlinkExecutable)
})

test('layering round-trip: strip then apply reproduces a valid, complete document', () => {
  const original = configWith({ openocd: 'C:/x/openocd.exe', jlink: 'C:/x/jl.exe', nm: 'C:/x/nm.exe' })
  const project = stripToolPaths(original)
  // The project file alone must still validate — it is read back on its own.
  assert.deepEqual(validateConfig(project), [])
  const recombined = applyToolPaths(project, extractToolPaths(original))
  assert.deepEqual(extractToolPaths(recombined), extractToolPaths(original))
})

function createDefaultConfigLike(): PluginConfig {
  return { activeProfile: 'default', profiles: [createDefaultProfile()] }
}

/* ─────────────────────────── symbol roster filter ───────────────────────── */

test('isGlobalDataSymbol: uppercase data letters are global, lowercase are static', () => {
  for (const letter of ['B', 'D', 'G', 'R', 'S']) {
    assert.equal(isGlobalDataSymbol(letter), true, `${letter} is global data`)
  }
  for (const letter of ['b', 'd', 'g', 'r', 's']) {
    assert.equal(isGlobalDataSymbol(letter), false, `${letter} is file-local`)
  }
  // Text and undefined symbols are not samplable data at all.
  for (const letter of ['T', 't', 'U', '?']) {
    assert.equal(isGlobalDataSymbol(letter), false, `${letter} is not data`)
  }
})

test('parseNmOutput: real nm output keeps globals and drops statics by default', () => {
  // Exactly what `nm -S --defined-only` prints, including one static per section.
  const output = [
    '20000000 00000004 B g_counter',
    '20000004 00000004 b s_private_counter',
    '20000008 00000002 D g_level',
    '2000000a 00000002 d s_private_level',
    '2000000c 00000004 R g_table',
    '20000010 00000004 r s_private_table',
    '08000000 00000010 T g_function',
  ].join('\n')

  const globals = parseNmOutput(output)
  assert.deepEqual(globals.map(s => s.name).sort(), ['g_counter', 'g_level', 'g_table'])
  // Addresses and sizes still decode for the survivors.
  const counter = globals.find(s => s.name === 'g_counter')
  assert.equal(counter?.address, 0x2000_0000)
  assert.equal(counter?.size, 4)

  // The escape hatch still exists for deliberately inspecting statics.
  const all = parseNmOutput(output, { globalsOnly: false })
  assert.deepEqual(all.map(s => s.name).sort(),
    ['g_counter', 'g_level', 'g_table', 's_private_counter', 's_private_level', 's_private_table'])
})

test('parseNmOutput: text symbols are never offered', () => {
  // A function address is a legitimate global, but sampling it as a value is
  // meaningless — the roster is for data only.
  const globals = parseNmOutput('08000000 00000010 T g_function')
  assert.deepEqual(globals, [])
})

test('parseNmOutput: the filter composes with the global-only rule', () => {
  const output = ['20000000 00000004 B g_counter', '20000004 00000004 b s_counter'].join('\n')
  // Both match the filter by name, but only the global may survive.
  assert.deepEqual(parseNmOutput(output, { filter: 'counter' }).map(s => s.name), ['g_counter'])
})

test('parseNmOutput: an nm build without the size column is still accepted', () => {
  const globals = parseNmOutput('20000000 B g_counter')
  assert.equal(globals.length, 1)
  assert.equal(globals[0]?.name, 'g_counter')
  assert.equal(globals[0]?.size, 0)
})

test('listElfSymbols: an explicit nm path must exist, and the error names it', async () => {
  // A bad tool path must be reported rather than silently yielding no symbols.
  await assert.rejects(
    () => listElfSymbols('fw.elf', 'definitely-not-a-real-nm-binary'),
    /failed to read symbols from "fw\.elf" via "definitely-not-a-real-nm-binary"/,
  )
})

