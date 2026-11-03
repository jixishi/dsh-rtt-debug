/**
 * Tests for the J-Link backend: the TELNET channel selector, the GDB remote
 * serial protocol codec, and the byte-level binding decoder.
 *
 * These three pieces are the whole contract with SEGGER's software, and each
 * fails silently when wrong: a malformed selector is forwarded to the target as
 * RTT input, a mis-framed RSP packet desynchronizes the stream, and a wrong byte
 * offset plots a real-looking number read from the wrong address.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { once } from 'node:events'

import { buildConfigString, JLinkTelnet } from '../src/jlink/telnet.ts'
import {
  RspClient,
  decodeMemoryReply,
  framePacket,
  isConsoleOutput,
  memoryReadBody,
  rspChecksum,
  unescapeRsp,
} from '../src/jlink/rsp.ts'
import { decodeBindingBytes, planReadBatches } from '../src/jlink/reader.ts'
import { JLinkManager } from '../src/jlink/manager.ts'
import { createDefaultProfile } from '../src/config.ts'
import type { SymbolBinding } from '../src/core/types.ts'

/* ────────────────────────── TELNET channel selector ─────────────────────── */

test('buildConfigString: channel-only selector matches SEGGER syntax', () => {
  assert.equal(buildConfigString(1), '$$SEGGER_TELNET_ConfigStr=RTTCh;1;$$')
})

test('buildConfigString: a search range rides the same string', () => {
  assert.equal(
    buildConfigString(0, { rttSearchRange: '0x20000000 0x1000' }),
    '$$SEGGER_TELNET_ConfigStr=RTTCh;0;SetRTTSearchRanges;0x20000000 0x1000;$$',
  )
})

test('buildConfigString: an explicit address wins over the range', () => {
  assert.equal(
    buildConfigString(2, { rttAddress: 0x2000_0000, rttSearchRange: '0x1000 0x100' }),
    '$$SEGGER_TELNET_ConfigStr=RTTCh;2;SetRTTAddr;0x20000000;$$',
  )
})

test('JLinkTelnet: the selector is the FIRST bytes written on connect', async () => {
  // J-Link honours the selector only inside the first 100 ms; a late one is
  // forwarded to the target as data. Pinning "first write" is what makes that
  // guarantee testable without a real probe.
  const received: Buffer[] = []
  const server = trackSockets(createServer((socket: Socket) => {
    socket.on('data', chunk => received.push(chunk))
  }))
  await listen(server)
  const port = portOf(server)

  const link = new JLinkTelnet({ host: '127.0.0.1', port, channel: 1, reconnect: false })
  link.connect()
  await waitFor(() => received.length > 0, 2000)
  const text = Buffer.concat(received).toString('latin1')
  assert.ok(text.startsWith('$$SEGGER_TELNET_ConfigStr=RTTCh;1;'), `got ${JSON.stringify(text)}`)

  link.dispose()
  await closeServer(server)
})

/* ────────────────────────────── RSP codec ───────────────────────────────── */

test('rspChecksum: sums the payload modulo 256', () => {
  // 'm0,4' = 0x6d + 0x30 + 0x2c + 0x34 = 0xfd
  assert.equal(rspChecksum('m0,4'), 'fd')
})

test('framePacket: wraps the payload with $ and a two-digit checksum', () => {
  assert.equal(framePacket('m0,4'), '$m0,4#fd')
})

test('memoryReadBody: addresses are unsigned hex, never negative', () => {
  assert.equal(memoryReadBody(0x2000_0000, 4), 'm20000000,4')
  // A 32-bit address read as a signed JS number must still serialize unsigned.
  assert.equal(memoryReadBody(0xffff_fff0, 16), 'mfffffff0,10')
})

test('decodeMemoryReply: hex pairs become bytes in order', () => {
  const bytes = decodeMemoryReply('0102feff')
  assert.deepEqual([...bytes], [0x01, 0x02, 0xfe, 0xff])
})

test('decodeMemoryReply: a target error is an exception, not zeroes', () => {
  assert.throws(() => decodeMemoryReply('E01'), /refused/)
})

test('decodeMemoryReply: odd or non-hex text is refused', () => {
  assert.throws(() => decodeMemoryReply('abc'), /malformed/)
  assert.throws(() => decodeMemoryReply('zzzz'), /malformed/)
})

test('unescapeRsp: } escapes XOR the following byte with 0x20', () => {
  // RSP binary escaping: `}` marks the next char as XOR 0x20.
  //   ';' = 0x3b → 0x3b ^ 0x20 = 0x1b (ESC)
  //   'B' = 0x42 → 0x42 ^ 0x20 = 0x62 ('b')
  // Getting the constant wrong here would silently mangle every escaped byte.
  assert.equal(unescapeRsp('a};'), 'a\u001b')
  assert.equal(unescapeRsp('a}B'), 'ab')
  assert.equal(unescapeRsp('plain'), 'plain')
})

test('isConsoleOutput: OK is a reply, not console output', () => {
  // The regression this pins: `OK` was skipped as console output, so
  // QStartNoAckMode's answer never arrived and connect() burned its timeout.
  assert.equal(isConsoleOutput('OK'), false)
  assert.equal(isConsoleOutput('O'), true)
  // Real console packets carry even-length hex.
  assert.equal(isConsoleOutput('4f4b,20626f6f74696e67'), false)
  assert.equal(isConsoleOutput('O48656c6c6f'), true)
  assert.equal(isConsoleOutput('m20000000,4'), false)
})

test('RspClient: reads memory over a stub, ignoring console output packets', async () => {
  // A stub that interleaves `O` console text with the reply — the exact shape
  // that would corrupt a naive parser. The console payload is HEX-ENCODED
  // (RSP's `O` form), which is what distinguishes it from an `OK` reply.
  const consolePacket = framePacket(`O${Buffer.from('booting\n').toString('hex')}`)
  const server = trackSockets(createServer((socket: Socket) => {
    socket.on('data', chunk => {
      const text = chunk.toString('latin1')
      if (text === '+' || text === '-') return
      const start = text.indexOf('$')
      const end = text.indexOf('#')
      if (start === -1 || end === -1) return
      const body = text.slice(start + 1, end)
      if (body === 'QStartNoAckMode') {
        socket.write(Buffer.from([0x2b])) // ack
        socket.write(framePacket('OK'))
        return
      }
      if (body.startsWith('m')) {
        socket.write(Buffer.from([0x2b]))
        // console output first, then the real answer
        socket.write(consolePacket)
        socket.write(framePacket('deadbeef'))
      }
    })
  }))
  await listen(server)
  const port = portOf(server)

  const client = new RspClient({ host: '127.0.0.1', port, timeoutMs: 2000 })
  await client.connect()
  assert.equal(client.ackMode, 'noack', 'QStartNoAckMode should be negotiated, not timed out')
  const bytes = await client.readMemory(0x2000_0000, 4)
  assert.deepEqual([...bytes], [0xde, 0xad, 0xbe, 0xef])

  client.close()
  await closeServer(server)
})

/* ───────────────────────── binding decode + batching ────────────────────── */

function binding(name: string, address: number, type: SymbolBinding['type'], size: number): SymbolBinding {
  return { name, address, type, size }
}

test('decodeBindingBytes: reads the value at its own byte offset', () => {
  // Two u32s back to back: reading the SECOND one must start at byte 4.
  const bytes = new Uint8Array([0x11, 0x11, 0x11, 0x11, 0x78, 0x56, 0x34, 0x12])
  const first = binding('a', 0x2000_0000, 'u32', 4)
  const second = binding('b', 0x2000_0004, 'u32', 4)
  assert.equal(decodeBindingBytes(bytes, 0, first), 0x11111111)
  assert.equal(decodeBindingBytes(bytes, 4, second), 0x12345678)
})

test('decodeBindingBytes: a u16 lands on a uint16 view, not the low bytes of a u32', () => {
  const bytes = new Uint8Array([0x34, 0x12, 0xff, 0xff])
  assert.equal(decodeBindingBytes(bytes, 0, binding('h', 0, 'u16', 2)), 0x1234)
})

test('decodeBindingBytes: big-endian reverses the byte order', () => {
  const be = { ...binding('b', 0, 'u32', 4), endianness: 'big' as const }
  assert.equal(decodeBindingBytes(new Uint8Array([0x12, 0x34, 0x56, 0x78]), 0, be), 0x12345678)
})

test('decodeBindingBytes: a short window throws instead of guessing', () => {
  assert.throws(() => decodeBindingBytes(new Uint8Array([1, 2]), 0, binding('x', 0, 'u32', 4)), /short/)
})

test('planReadBatches: adjacent bindings merge into one read', () => {
  const batches = planReadBatches([
    binding('a', 0x2000_0000, 'u32', 4),
    binding('b', 0x2000_0004, 'u32', 4),
  ], 64)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.base, 0x2000_0000)
  assert.equal(batches[0]?.length, 8)
})

test('planReadBatches: a wide gap starts a new read', () => {
  const batches = planReadBatches([
    binding('a', 0x2000_0000, 'u32', 4),
    binding('b', 0x2001_0000, 'u32', 4),
  ], 64)
  assert.equal(batches.length, 2)
})

/* ───────────────────────────── manager argv ─────────────────────────────── */

test('JLinkManager.buildArgs: the RTT TELNET port is passed as -RTTTelnetPort', () => {
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const args = manager.buildArgs({
    ...profile.jlink,
    device: 'STM32F407VG',
    targetInterface: 'SWD',
    speedKhz: 4000,
    gdbPort: 2331,
    rttTelnetPort: 19021,
    serial: '  ',
  })
  assert.deepEqual(args.slice(0, 6), ['-device', 'STM32F407VG', '-if', 'SWD', '-speed', '4000'])
  assert.ok(args.includes('-RTTTelnetPort'))
  assert.equal(args[args.indexOf('-RTTTelnetPort') + 1], '19021')
  assert.equal(args[args.indexOf('-port') + 1], '2331')
  // An empty serial must not produce a bare `-USB`.
  assert.equal(args.includes('-USB'), false)
})

test('JLinkManager.buildArgs: a probe serial uses the documented -USB form', () => {
  // `-select usb=<serial>` is NOT a GDB Server option; `-SelectEmuBySN` is
  // rejected by it. The documented spelling (V8.24+) is `-USB <SerialNo>`.
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const args = manager.buildArgs({ ...profile.jlink, device: 'Cortex-M4', serial: ' 59701234 ' })
  assert.equal(args[args.indexOf('-USB') + 1], '59701234')
  assert.equal(args.includes('-select'), false)
})

test('JLinkManager.buildArgs: the target is left running by default', () => {
  // A halted core stops emitting RTT, so `-nohalt -noir` is what keeps a live
  // waveform alive after the panel attaches.
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const args = manager.buildArgs({ ...profile.jlink, device: 'Cortex-M4' })
  assert.ok(args.includes('-nohalt'))
  assert.ok(args.includes('-noir'))
})

test('JLinkManager.buildArgs: keepTargetRunning=false restores halt-on-connect', () => {
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const args = manager.buildArgs({ ...profile.jlink, device: 'Cortex-M4', keepTargetRunning: false })
  assert.equal(args.includes('-nohalt'), false)
  assert.equal(args.includes('-noir'), false)
})

test('JLinkManager.buildArgs: J-Link never gets -RTTSearchRanges', () => {
  // That option belongs to JLinkRTTLogger / J-Scope; GDB Server rejects it, so
  // the search range must travel in the TELNET config string instead.
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const args = manager.buildArgs({ ...profile.jlink, device: 'Cortex-M4' })
  assert.equal(args.includes('-RTTSearchRanges'), false)
})

/* ───────────────────── missing J-Link must be actionable ────────────────── */

test('JLinkManager.start: a missing J-Link reports what was tried, not spawn EPERM', async () => {
  // The real-world failure on a machine without SEGGER software: surface a
  // message naming the choice, instead of an opaque OS error from spawn().
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const status = await manager.start({
    ...profile,
    driver: 'jlink',
    jlink: {
      ...profile.jlink,
      // A path that certainly does not exist, and no PATH lookup to rescue it.
      executable: 'W:/definitely/not/here/JLinkGDBServerCL.exe',
      device: 'Cortex-M4',
    },
    // Ensure the attach probe cannot short-circuit on a live port.
    log: { ...profile.log, binding: { ...profile.log.binding, port: 1 } },
  })
  assert.equal(status.kind, 'error')
  const message = status.kind === 'error' ? status.message : ''
  assert.match(message, /J-Link software not found/)
  assert.match(message, /Variable Sources|SEGGER J-Link Software Pack/)
  // The unhelpful OS-level wording must not be what the user sees.
  assert.doesNotMatch(message, /EPERM|ENOENT/)
})

test('JLinkManager.start: an empty device is refused before anything spawns', async () => {
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const status = await manager.start({
    ...profile,
    driver: 'jlink',
    jlink: { ...profile.jlink, executable: '', device: '   ' },
    log: { ...profile.log, binding: { ...profile.log.binding, port: 1 } },
  })
  assert.equal(status.kind, 'error')
  assert.match(status.kind === 'error' ? status.message : '', /target device/)
})

test('JLinkManager.start: attach-only refuses when nothing listens, naming both ports', async () => {
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const status = await manager.start({
    ...profile,
    driver: 'jlink',
    jlink: { ...profile.jlink, device: 'Cortex-M4', autoStart: false, gdbPort: 2, rttTelnetPort: 3 },
  })
  assert.equal(status.kind, 'error')
  const message = status.kind === 'error' ? status.message : ''
  assert.match(message, /attach-only/)
  assert.match(message, /2/)
  assert.match(message, /3/)
})

test('JLinkManager.buildArgs: speed 0 omits -speed so J-Link keeps its default', () => {
  const manager = new JLinkManager('W:/ws')
  const profile = createDefaultProfile()
  const args = manager.buildArgs({ ...profile.jlink, device: 'Cortex-M4', speedKhz: 0 })
  assert.equal(args.includes('-speed'), false)
})

/* ──────────────────────────────── helpers ───────────────────────────────── */

function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => undefined)
}

function portOf(server: Server): number {
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
    // `close` fires only after live connections end; destroy them explicitly so
    // a finished test cannot keep the process alive.
    for (const socket of openSockets(server)) socket.destroy()
  })
}


/**
 * Wrap a server so its accepted sockets are destroyed before the server closes.
 *
 * `server.close()` alone stops listening but keeps the process alive while any
 * accepted connection is still open, which made the whole test file hang instead
 * of failing. Tracking the sockets is what lets a test end deterministically.
 */
function trackSockets(server: Server): Server {
  const sockets = new Set<Socket>()
  socketRegistry.set(server, sockets)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return server
}

/** The socket set a tracked server keeps, so `closeServer` can drain it. */
const socketRegistry = new WeakMap<Server, Set<Socket>>()

function openSockets(server: Server): Socket[] {
  return [...(socketRegistry.get(server) ?? [])]
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not met in time')
}
