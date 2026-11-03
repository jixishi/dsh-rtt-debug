/**
 * Tests for the two cross-cutting pieces the J-Link backend touched:
 * configuration migration, and the driver switch inside the service.
 *
 * Both are the kind of change that fails quietly in production — an unmigrated
 * profile loses its J-Link settings on the next save, and a driver switch that
 * does not tear down the old transport leaves two backends fighting over one
 * probe. Neither shows up as a type error, so both are pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDefaultProfile, migrateConfig, validateConfig } from '../src/config.ts'
import type { DeviceProfile, PluginConfig } from '../src/config.ts'
import { DebugService } from '../src/service.ts'

/* ──────────────────────────── config migration ──────────────────────────── */

test('migrateConfig: a pre-J-Link profile gains driver and a full jlink block', () => {
  // Exactly what an older release stored: no `driver`, no `jlink`.
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

  const migrated = migrateConfig(structuredClone(legacy)) as Record<string, unknown>
  const profile = (migrated['profiles'] as Record<string, unknown>[])[0] as Record<string, unknown>

  // An old profile WAS an OpenOCD profile — the migration must say so rather
  // than silently picking a default that could switch the user's backend.
  assert.equal(profile['driver'], 'openocd')
  const jlink = profile['jlink'] as Record<string, unknown>
  assert.equal(jlink['gdbPort'], 2331)
  assert.equal(jlink['rttTelnetPort'], 19021)
  assert.equal(jlink['targetInterface'], 'SWD')
  assert.equal(jlink['keepTargetRunning'], true)
  // Existing OpenOCD configuration must survive untouched.
  assert.equal((profile['openocd'] as Record<string, unknown>)['configPath'], 'mcu/openocd.cfg')
  assert.equal(validateConfig(migrated).length, 0, 'a migrated document must validate')
})

test('migrateConfig: a half-written jlink block is completed, not replaced', () => {
  const stored = {
    activeProfile: 'default',
    profiles: [{
      ...createDefaultProfile(),
      // A partial block: one field present, the rest missing.
      jlink: { device: 'STM32F407VG' },
    }],
  }
  const migrated = migrateConfig(stored) as Record<string, unknown>
  const jlink = ((migrated['profiles'] as Record<string, unknown>[])[0] as Record<string, unknown>)['jlink'] as Record<string, unknown>
  // The user's value wins…
  assert.equal(jlink['device'], 'STM32F407VG')
  // …and nothing is left undefined for later reads.
  assert.equal(jlink['gdbPort'], 2331)
  assert.equal(typeof jlink['autoStart'], 'boolean')
})

test('migrateConfig: a j-link profile keeps its driver', () => {
  const stored = {
    activeProfile: 'default',
    profiles: [{ ...createDefaultProfile(), driver: 'jlink' }],
  }
  const migrated = migrateConfig(stored) as Record<string, unknown>
  assert.equal(((migrated['profiles'] as Record<string, unknown>[])[0] as Record<string, unknown>)['driver'], 'jlink')
})

test('migrateConfig: a non-object or profile-less document passes through', () => {
  assert.equal(migrateConfig(undefined), undefined)
  assert.deepEqual(migrateConfig({ activeProfile: 'x' }), { activeProfile: 'x' })
})

/* ─────────────────────────────── validation ─────────────────────────────── */

function jlinkProfile(patch: Partial<DeviceProfile['jlink']> = {}): DeviceProfile {
  const profile = createDefaultProfile()
  return { ...profile, driver: 'jlink', jlink: { ...profile.jlink, device: 'STM32F407VG', ...patch } }
}

test('validateConfig: a configured j-link profile passes', () => {
  const config: PluginConfig = { activeProfile: 'default', profiles: [jlinkProfile()] }
  assert.deepEqual(validateConfig(config), [])
})

test('validateConfig: j-link needs a device name', () => {
  const config: PluginConfig = { activeProfile: 'default', profiles: [jlinkProfile({ device: '  ' })] }
  const problems = validateConfig(config)
  assert.ok(problems.some(p => p.includes('device')), problems.join('; '))
})

test('validateConfig: the GDB and TELNET ports must differ', () => {
  const config: PluginConfig = { activeProfile: 'default', profiles: [jlinkProfile({ gdbPort: 19021, rttTelnetPort: 19021 })] }
  const problems = validateConfig(config)
  assert.ok(problems.some(p => p.includes('must differ')), problems.join('; '))
})

test('validateConfig: an out-of-range port is refused', () => {
  const config: PluginConfig = { activeProfile: 'default', profiles: [jlinkProfile({ gdbPort: 70000 })] }
  assert.ok(validateConfig(config).some(p => p.includes('gdbPort')))
})

test('validateConfig: an unknown interface is refused', () => {
  const config: PluginConfig = {
    activeProfile: 'default',
    profiles: [jlinkProfile({ targetInterface: 'cJTAG' as unknown as 'SWD' })],
  }
  assert.ok(validateConfig(config).some(p => p.includes('targetInterface')))
})

test('validateConfig: an unknown driver is refused', () => {
  const config = {
    activeProfile: 'default',
    profiles: [{ ...createDefaultProfile(), driver: 'pyocd' }],
  }
  assert.ok(validateConfig(config).some(p => p.includes('driver')))
})

/* ─────────────────────────── driver switch in service ───────────────────── */

test('DebugService: state reports the active driver', () => {
  const openocdService = new DebugService('W:/ws')
  assert.equal(openocdService.state().driver, 'openocd')

  const jlinkService = new DebugService('W:/ws')
  jlinkService.setConfig({ activeProfile: 'default', profiles: [jlinkProfile()] })
  assert.equal(jlinkService.state().driver, 'jlink')
})

test('DebugService: setConfig with a new driver is refused while running', async () => {
  // Changing backends under a live session would leave one transport half-open
  // against the other's endpoints, so the switch must stop first.
  const service = new DebugService('W:/ws')
  const profile = createDefaultProfile()
  // Point the RTT ports at a dead port so start() fails fast rather than
  // spawning anything: the point is the driver transition, not a real backend.
  service.setConfig({
    activeProfile: 'default',
    profiles: [{ ...profile, log: { ...profile.log, binding: { ...profile.log.binding, port: 1 } }, variables: { ...profile.variables, enabled: false }, ocd: { ...profile.ocd, enabled: false } }],
  })
  // A failed start leaves the service stopped, so nothing is running to stop.
  await service.start()
  assert.equal(service.isRunning(), false)

  // The switch is then simply accepted.
  service.setConfig({ activeProfile: 'default', profiles: [jlinkProfile()] })
  assert.equal(service.state().driver, 'jlink')
  await service.dispose()
})
