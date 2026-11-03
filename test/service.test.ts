/**
 * End-to-end integration tests for the host service.
 *
 * These run the real `DebugService` against mock TCP servers that stand in for
 * OpenOCD's RTT ports, so the whole chain is exercised without hardware:
 * socket → line/frame framing → parser → series store → state.
 *
 * The two properties worth this much setup are the ones a unit test cannot
 * show: that the log path loses nothing while the variable path is busy, and
 * that the three sources really do run independently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'

import { DebugService } from '../src/service.ts'
import { createDefaultProfile } from '../src/config.ts'
import type { DeviceProfile } from '../src/config.ts'

/** A TCP server that writes whatever a test hands it, to every client. */
interface MockPort {
  server: Server
  port: number
  sockets: Set<import('node:net').Socket>
  write(text: string): void
  /** Number of clients currently attached (used to await the link's connect). */
  clientCount(): number
  close(): Promise<void>
}

async function mockPort(): Promise<MockPort> {
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    sockets,
    write(text: string) {
      for (const socket of sockets) {
        // A socket can close between the set iteration and the write (the
        // service tears its link down on dispose); that is not a test failure.
        // `destroyed` is not enough: a peer that closed its half leaves the
        // socket alive but unwritable, and the write then throws EPIPE. Both
        // states mean "this mock client is gone", which is not a test failure.
        if (socket.destroyed || socket.writableEnded || !socket.writable) continue
        socket.write(text)
      }
    },
    clientCount() {
      return sockets.size
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * Wait until a predicate holds.
 *
 * TCP connect and the first poll cycle are asynchronous, so a test that wants
 * deterministic data must wait for the link to be up rather than sleeping a
 * guessed interval.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 4000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
}

/** Wait until every source the profile enables reports `open`. */
async function waitForSources(service: DebugService, ids: readonly string[]): Promise<void> {
  await waitFor(
    () => ids.every(id => service.state().sources.find(s => s.id === id)?.state === 'open'),
    4000,
    `sources ${ids.join(', ')} to open`,
  )
}

/** A profile wired to the mock ports, in attach mode so nothing is spawned. */
function profileFor(logPort: number, variablePort: number, overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  const profile = createDefaultProfile('test', 'Test')
  profile.openocd.mode = 'attach'
  profile.log.binding.port = logPort
  profile.variables.binding.port = variablePort
  return { ...profile, ...overrides }
}

function configFor(profile: DeviceProfile): { activeProfile: string; profiles: DeviceProfile[] } {
  return { activeProfile: profile.id, profiles: [profile] }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/* ────────────────────────────── three sources ─────────────────────────────── */

test('DebugService: attaches to existing servers and runs the log + variable sources', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profileFor(logPort.port, varPort.port)))

  try {
    await service.start()
    await waitForSources(service, ['log', 'rttVar'])

    const state = service.state()
    assert.equal(state.openocd.kind, 'attached')

    logPort.write('INFO: boot complete\n')
    varPort.write('volt,amps\n12007,3\n')
    await waitFor(() => service.snapshot().log.length >= 1, 4000, 'the log line to arrive')
    await waitFor(
      () => service.snapshot().series.some(s => s.name === 'volt'),
      4000,
      'the variable sample to arrive',
    )

    const snapshot = service.snapshot()
    assert.match(snapshot.log[0]?.text ?? '', /boot complete/)
    assert.equal(snapshot.series.find(s => s.name === 'volt')?.values[0], 12007)
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

test('DebugService: the OCD source runs from configuration with no RTT traffic at all', async () => {
  // Only a TCL port: this proves the third source is genuinely independent of
  // the two RTT channels rather than piggy-backing on them.
  const tcl = await mockPort()
  const logPort = await mockPort()
  const varPort = await mockPort()

  // A mock OpenOCD TCL server answering mdw with a fixed value.
  tcl.server.on('connection', socket => {
    socket.on('data', chunk => {
      const command = chunk.toString('latin1').replace(/\x1a.*$/s, '')
      if (command.startsWith('mdw')) socket.write('0x20000000: 00002ee0\n\x1a')
      else socket.write('\n\x1a')
    })
  })

  const profile = profileFor(logPort.port, varPort.port)
  profile.openocd.tclPort = tcl.port
  profile.log.enabled = false
  profile.variables.enabled = false
  profile.ocd.enabled = true
  profile.ocd.intervalMs = 20
  profile.ocd.verifyConsistency = false
  profile.ocd.variables = [{ source: 'manual', name: 'vdd', address: 0x20000000, type: 'u32' }]

  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profile))

  try {
    await service.start()
    await delay(150)
    const series = service.snapshot().series
    assert.equal(series.length, 1)
    assert.equal(series[0]?.name, 'vdd')
    assert.equal(series[0]?.values[0], 0x2ee0)
    assert.ok((series[0]?.ts.length ?? 0) >= 2, 'the reader should have polled more than once')
  } finally {
    await service.dispose()
    await tcl.close()
    await logPort.close()
    await varPort.close()
  }
})

test('DebugService: disabling a source leaves it idle while the others run', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const profile = profileFor(logPort.port, varPort.port)
  profile.variables.enabled = false
  // The disabled port has no server behind it; the service must not need one.
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profile))
  profile.variables.binding.port = 1  // an unbound port
  service.setConfig(configFor(profile))

  try {
    await service.start()
    await waitForSources(service, ['log'])
    const sources = service.state().sources
    assert.equal(sources.find(s => s.id === 'log')?.state, 'open')
    assert.equal(sources.find(s => s.id === 'rttVar')?.state, 'idle')
    // The disabled source's port was never dialled.
    assert.equal(varPort.clientCount(), 0)
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

/* ───────────────────────── log completeness (A16) ────────────────────────── */

test('DebugService: no log line is lost while the variable channel floods', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profileFor(logPort.port, varPort.port)))

  const LINE_COUNT = 2000
  try {
    await service.start()
    await waitForSources(service, ['log', 'rttVar'])

    // Flood the variable channel first, then the log, then interleave — the
    // interleave is what would drop lines if the two shared a buffer.
    varPort.write('a,b\n' + Array.from({ length: 500 }, (_, i) => `${i},${i * 2}`).join('\n') + '\n')
    for (let i = 0; i < LINE_COUNT; i += 1) {
      varPort.write(`${i},${i}\n`)
      logPort.write(`LINE ${i}\n`)
    }
    await waitFor(
      () => service.state().log.total === LINE_COUNT,
      8000,
      `all ${LINE_COUNT} log lines to be received`,
    )

    const snapshot = service.snapshot()
    // The counter is authoritative — it counts every accepted line regardless
    // of what the ring retains (which is capped for display).
    assert.equal(service.state().log.total, LINE_COUNT)
    assert.equal(snapshot.total, LINE_COUNT)
    // Every line's content is intact and in order.
    const kept = service.snapshot().log
    assert.equal(kept.length, LINE_COUNT)
    assert.equal(kept[0]?.text, 'LINE 0')
    assert.equal(kept[kept.length - 1]?.text, `LINE ${LINE_COUNT - 1}`)
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

test('DebugService: the log ring trims for display while the completeness counter keeps counting', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const profile = profileFor(logPort.port, varPort.port)
  profile.log.maxLines = 10
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profile))

  try {
    await service.start()
    await waitForSources(service, ['log'])
    for (let i = 0; i < 50; i += 1) logPort.write(`line ${i}\n`)
    await waitFor(() => service.state().log.total === 50, 4000, 'all 50 lines to be received')

    const snapshot = service.snapshot()
    assert.equal(service.state().log.total, 50)      // nothing lost
    assert.equal(snapshot.log.length, 10)             // ring capped
    assert.equal(snapshot.log[9]?.text, 'line 49')    // newest retained
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

/* ─────────────────────────── parser integration ──────────────────────────── */

test('DebugService: the configured parser decides how the variable stream is read', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const profile = profileFor(logPort.port, varPort.port)
  profile.variables.parser = { id: 'keyvalue', options: {} }
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profile))

  try {
    await service.start()
    await waitForSources(service, ['rttVar'])
    varPort.write('vdd=3300\n')
    varPort.write('temp=25\n')
    await waitFor(
      () => service.snapshot().series.length === 2,
      4000,
      'both key/value variables to appear',
    )
    const names = service.snapshot().series.map(s => s.name).sort()
    assert.deepEqual(names, ['temp', 'vdd'])
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

test('DebugService: a malformed frame does not stop the stream', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profileFor(logPort.port, varPort.port)))

  try {
    await service.start()
    await waitForSources(service, ['rttVar'])
    varPort.write('volt,amps\n')
    varPort.write('not,a,number,row\n')   // yields no values, must not throw
    varPort.write('12007,3\n')            // still parsed afterwards
    await waitFor(
      () => service.snapshot().series.find(s => s.name === 'volt')?.values[0] === 12007,
      4000,
      'the valid row after the malformed one to be parsed',
    )
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

/* ──────────────────────────── logs and ANSI ─────────────────────────────── */

test('DebugService: RTT colour escapes are decoded, not shown as raw bytes', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profileFor(logPort.port, varPort.port)))

  try {
    await service.start()
    await waitForSources(service, ['log'])
    logPort.write('\x1b[1;32mOK: green line\x1b[0m\n')
    await waitFor(() => service.snapshot().log.length >= 1, 4000, 'the coloured line to arrive')
    const record = service.snapshot().log[0]
    assert.equal(record?.text, 'OK: green line')
    assert.equal(record?.spans[0]?.color, 'green')
    assert.equal(record?.level, 'info')
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

test('DebugService: clear() drops retained data but not the completeness counter', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profileFor(logPort.port, varPort.port)))

  try {
    await service.start()
    await waitForSources(service, ['log', 'rttVar'])
    logPort.write('one\ntwo\n')
    varPort.write('a\n1\n2\n')
    await waitFor(() => service.snapshot().log.length >= 2, 4000, 'two log lines to arrive')
    await waitFor(() => service.snapshot().series.length >= 1, 4000, 'the variable to appear')

    service.clear('all')
    const after = service.snapshot()
    assert.equal(after.log.length, 0)
    assert.equal(after.series.length, 0)
    // Clearing the view must not reset the evidence of what was received.
    assert.equal(service.state().log.total, 2)
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})

/* ────────────────────────── configuration handling ───────────────────────── */

test('DebugService: an invalid configuration is refused at the boundary', () => {
  const service = new DebugService(process.cwd())
  const profile = createDefaultProfile()
  // Same channel for both streams: they would be indistinguishable.
  profile.variables.binding.channel = profile.log.binding.channel
  assert.throws(
    () => service.setConfig(configFor(profile)),
    /different RTT channels/,
  )
})

test('DebugService: an invalid OcD binding is refused', () => {
  const service = new DebugService(process.cwd())
  const profile = createDefaultProfile()
  profile.ocd.variables = [{ source: 'symbol' }]   // no symbol name
  assert.throws(() => service.setConfig(configFor(profile)), /symbol is required/)
})

test('DebugService: switching profiles re-applies sampling limits', () => {
  const service = new DebugService(process.cwd())
  const a = createDefaultProfile('a', 'A')
  const b = createDefaultProfile('b', 'B')
  b.variables.sampleRateHz = 1
  b.log.maxLines = 7
  service.setConfig({ activeProfile: 'a', profiles: [a, b] })
  assert.equal(service.getProfile().id, 'a')

  service.setActiveProfile('b')
  const active = service.getProfile()
  assert.equal(active.id, 'b')
  assert.equal(active.log.maxLines, 7)

  service.clear('all')
  const limits = (service as unknown as { logStore: { getOptions(): { maxLines: number } } }).logStore.getOptions()
  assert.equal(limits.maxLines, 7)
  assert.equal(limits.maxLines, 7)
})

test('DebugService: an unconfigured profile reports a clear error instead of spawning', async () => {
  const service = new DebugService(process.cwd())
  const profile = createDefaultProfile('t', 'T')  // mode auto, empty configPath
  profile.openocd.tclPort = 39999
  profile.log.binding.port = 39998
  profile.variables.binding.port = 39997
  service.setConfig(configFor(profile))
  try {
    await service.start()
    const status = service.state().openocd
    assert.equal(status.kind, 'error')
    assert.match(status.kind === 'error' ? status.message : '', /no OpenOCD config file configured/)
  } finally {
    await service.dispose()
  }
})

test('DebugService: exportLog writes the retained lines with timestamps and levels', async () => {
  const logPort = await mockPort()
  const varPort = await mockPort()
  const service = new DebugService(process.cwd())
  service.setConfig(configFor(profileFor(logPort.port, varPort.port)))

  try {
    await service.start()
    // The link connects asynchronously; writing before the socket exists would
    // send the line to nobody. Every other mock-port test waits here first.
    await waitForSources(service, ['log'])
    logPort.write('WARN: watch out\n')
    await waitFor(() => service.snapshot().log.length >= 1, 4000, 'the WARN line to arrive')
    const text = service.exportLog()
    assert.match(text, /\[WARN\] WARN: watch out/)
  } finally {
    await service.dispose()
    await logPort.close()
    await varPort.close()
  }
})
