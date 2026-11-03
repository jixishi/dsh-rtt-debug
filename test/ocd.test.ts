/**
 * Tests for the third data source: the OpenOCD memory reader.
 *
 * The interesting cases are the ones that would otherwise produce WRONG data
 * rather than no data: a torn multi-byte read, an unaligned narrow field, a
 * batching plan that merges across too large a gap, and the read-only guard
 * that must refuse a write command before it reaches the wire.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

import { assertReadOnly, OcdTcl, parseMemoryWords } from '../src/ocd/tcl.ts'
import { decodeBinding, planReadBatches, OcdReader } from '../src/ocd/reader.ts'
import {
  normalizeType,
  parseAddress,
  parseManualBinding,
  refineTypeFromName,
  typeForSize,
  listElfSymbols,
} from '../src/ocd/symbols.ts'
import type { SymbolBinding } from '../src/core/types.ts'

/* ─────────────────────────────── read-only guard ─────────────────────────── */

test('assertReadOnly: memory-display commands are permitted', () => {
  for (const cmd of ['mdw 0x20000000 4', 'mdh 0x20000000 2', 'mdb 0x20000000 1', 'reg pc', 'targets']) {
    assert.doesNotThrow(() => assertReadOnly(cmd), cmd)
  }
})

test('assertReadOnly: write commands are refused before reaching the wire', () => {
  for (const cmd of ['mww 0x20000000 0', 'mwb 0x1 2', 'flash write_image x', 'reset halt']) {
    assert.throws(() => assertReadOnly(cmd), /read-only|allowlist/, cmd)
  }
})

test('assertReadOnly: an unknown command is refused rather than forwarded', () => {
  assert.throws(() => assertReadOnly('some_new_command'), /not on the read-only allowlist/)
})

test('assertReadOnly: an empty command is refused', () => {
  assert.throws(() => assertReadOnly('   '), /empty/)
})

/* ───────────────────────────── memory-reply parsing ─────────────────────── */

test('parseMemoryWords: reads only the data after the colon', () => {
  // The leading address must NOT become a sample value.
  const words = parseMemoryWords('0x20000000: 000003f7 deadbeef \n')
  assert.deepEqual(words, [0x000003f7, 0xdeadbeef])
})

test('parseMemoryWords: merges multiple lines', () => {
  const words = parseMemoryWords('0x20000000: 00000001 00000002\n0x20000008: 00000003\n')
  assert.deepEqual(words, [1, 2, 3])
})

test('parseMemoryWords: an error reply yields no values', () => {
  assert.deepEqual(parseMemoryWords('Error: target not halted'), [])
})

/* ───────────────────────────────── batching ─────────────────────────────── */

test('planReadBatches: adjacent bindings merge into one read', () => {
  const bindings: SymbolBinding[] = [
    { name: 'a', address: 0x20000000, type: 'u32' },
    { name: 'b', address: 0x20000004, type: 'u32' },
    { name: 'c', address: 0x20000008, type: 'u32' },
  ]
  const batches = planReadBatches(bindings, 64)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.base, 0x20000000)
  assert.equal(batches[0]?.words, 3)
  assert.deepEqual(batches[0]?.members.map(m => m.offset), [0, 4, 8])
})

test('planReadBatches: a gap beyond the cap starts a new batch', () => {
  const bindings: SymbolBinding[] = [
    { name: 'a', address: 0x20000000, type: 'u32' },
    { name: 'far', address: 0x20001000, type: 'u32' },
  ]
  assert.equal(planReadBatches(bindings, 64).length, 2)
})

test('planReadBatches: batching disabled gives one read per binding', () => {
  const bindings: SymbolBinding[] = [
    { name: 'a', address: 0x20000000, type: 'u32' },
    { name: 'b', address: 0x20000004, type: 'u32' },
  ]
  assert.equal(planReadBatches(bindings, 0).length, 2)
})

test('planReadBatches: unsorted input still batches correctly', () => {
  const bindings: SymbolBinding[] = [
    { name: 'b', address: 0x20000004, type: 'u32' },
    { name: 'a', address: 0x20000000, type: 'u32' },
  ]
  const batches = planReadBatches(bindings, 64)
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.members[0]?.binding.name, 'a')
})

test('planReadBatches: an empty binding list makes no reads', () => {
  assert.deepEqual(planReadBatches([], 64), [])
})

/* ───────────────────────────── value decoding ───────────────────────────── */

test('decodeBinding: u32 from the first word', () => {
  assert.equal(decodeBinding([0x000003f7], 0, { name: 'v', address: 0, type: 'u32' }), 0x3f7)
})

/*
 * Endianness fixtures, worked out byte-by-byte.
 *
 * `mdw` returns a 32-bit number, and the target's bytes map onto it
 * little-endian: word 0x11223344 is memory bytes [44, 33, 22, 11]. A value at
 * byte offset N therefore starts at byte lane N, NOT at the low byte — which
 * is exactly the bug these tests exist to catch.
 */

test('decodeBinding: an unaligned u16 comes from the right byte lane', () => {
  // word 0x11223344 → memory [44, 33, 22, 11]; offset 1 → bytes 33, 22 → 0x2233
  assert.equal(decodeBinding([0x11223344], 1, { name: 'v', address: 0, type: 'u16' }), 0x2233)
})

test('decodeBinding: a u8 at offset 3 is the top byte', () => {
  // memory [44, 33, 22, 11] → byte 3 is 0x11
  assert.equal(decodeBinding([0x11223344], 3, { name: 'v', address: 0, type: 'u8' }), 0x11)
})

test('decodeBinding: a value straddling two words is reassembled', () => {
  // Target bytes for 0xDDCCBBAA are [AA, BB, CC, DD]; placing them at byte
  // offset 2 means word0 supplies lanes 2..3 and word1 supplies lanes 0..1.
  // word0 lane2=AA, lane3=BB → 0xBBAA0000 ; word1 lane0=CC, lane1=DD → 0x0000DDCC
  const words = [0xbbaa0000, 0x0000ddcc]
  assert.equal(decodeBinding(words, 2, { name: 'v', address: 0, type: 'u32' }), 0xddccbbaa)
})

test('decodeBinding: a straddling big-endian value reverses correctly', () => {
  // Same physical bytes, read as BE: [AA, BB, CC, DD] → 0xAABBCCDD
  assert.equal(
    decodeBinding([0xbbaa0000, 0x0000ddcc], 2, { name: 'v', address: 0, type: 'u32', endianness: 'big' }),
    0xaabbccdd,
  )
})

test('decodeBinding: signed types sign-extend', () => {
  assert.equal(decodeBinding([0xffffffff], 0, { name: 'v', address: 0, type: 'i32' }), -1)
  assert.equal(decodeBinding([0x0000fffe], 0, { name: 'v', address: 0, type: 'i16' }), -2)
})

test('decodeBinding: bool is nonzero-based', () => {
  assert.equal(decodeBinding([0x00000001], 0, { name: 'v', address: 0, type: 'bool' }), true)
  assert.equal(decodeBinding([0x00000000], 0, { name: 'v', address: 0, type: 'bool' }), false)
})

test('decodeBinding: big-endian is honoured', () => {
  assert.equal(
    decodeBinding([0x01020304], 0, { name: 'v', address: 0, type: 'u32', endianness: 'big' }),
    0x04030201,
  )
})

test('decodeBinding: a short read throws instead of returning a partial value', () => {
  assert.throws(() => decodeBinding([], 0, { name: 'v', address: 0, type: 'u32' }), /came up short/)
})

/* ─────────────────────────────── symbol parsing ─────────────────────────── */

test('parseAddress: hex, decimal and underscore separators', () => {
  assert.equal(parseAddress('0x20000000'), 0x20000000)
  assert.equal(parseAddress('0x2000_0000'), 0x20000000)
  assert.equal(parseAddress('536870912'), 536870912)
  assert.equal(parseAddress('nope'), undefined)
})

test('parseManualBinding: address:type:name', () => {
  assert.deepEqual(parseManualBinding('0x20000000:u16:VoltMv'), {
    name: 'VoltMv', address: 0x20000000, type: 'u16',
  })
})

test('parseManualBinding: name@address:type', () => {
  assert.deepEqual(parseManualBinding('VoltMv@0x20000000:u16'), {
    name: 'VoltMv', address: 0x20000000, type: 'u16',
  })
})

test('parseManualBinding: a missing type defaults to u32', () => {
  assert.deepEqual(parseManualBinding('0x20000000:VoltMv'), {
    name: 'VoltMv', address: 0x20000000, type: 'u32',
  })
})

test('parseManualBinding: junk is rejected rather than guessed at', () => {
  assert.equal(parseManualBinding(''), undefined)
  assert.equal(parseManualBinding('just-a-name'), undefined)
})

test('normalizeType: common C spellings map onto scalar types', () => {
  assert.equal(normalizeType('uint16_t'), 'u16')
  assert.equal(normalizeType('int32'), 'i32')
  assert.equal(normalizeType('float'), 'f32')
  assert.equal(normalizeType('double'), 'f64')
  assert.equal(normalizeType('bool'), 'bool')
  assert.equal(normalizeType('nonsense'), undefined)
})

test('refineTypeFromName: a width suffix overrides the section guess', () => {
  assert.equal(refineTypeFromName('counter_u16', 'u32'), 'u16')
  assert.equal(refineTypeFromName('delta_i8', 'u32'), 'i8')
  assert.equal(refineTypeFromName('gain_f32', 'u32'), 'f32')
})

test('refineTypeFromName: boolean-shaped names become bool', () => {
  assert.equal(refineTypeFromName('isReady', 'u32'), 'bool')
  assert.equal(refineTypeFromName('hasFault', 'u32'), 'bool')
})

test('refineTypeFromName: an unrecognised name keeps the fallback', () => {
  assert.equal(refineTypeFromName('voltage', 'u16'), 'u16')
})

test('typeForSize: symbol size becomes a concrete width', () => {
  assert.equal(typeForSize(1, 'u32'), 'u8')
  assert.equal(typeForSize(2, 'u32'), 'u16')
  assert.equal(typeForSize(4, 'f32'), 'f32')
  assert.equal(typeForSize(4, 'u32'), 'u32')
  assert.equal(typeForSize(8, 'u32'), 'f64')
  assert.equal(typeForSize(0, 'u16'), 'u16')
})

test('listElfSymbols: a bad nm path is reported, not silently empty', async () => {
  await assert.rejects(
    () => listElfSymbols('C:/definitely/missing.elf', 'arm-none-eabi-nm'),
    /failed to read symbols/,
  )
})

/* ────────────────────────────── TCL integration ─────────────────────────── */

test('OcdTcl: talks the 0x1A protocol and refuses a write command', async () => {
  // A miniature OpenOCD TCL server: echoes a canned mdw reply per command.
  const server = createServer(socket => {
    socket.on('data', chunk => {
      const command = chunk.toString('latin1').replace(/\x1a.*$/s, '')
      if (command.startsWith('mdw')) {
        socket.write('0x20000000: 000003f7 0000002a\n\x1a')
      } else {
        socket.write(`\n\x1a`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const tcl = new OcdTcl({ host: '127.0.0.1', port, timeoutMs: 2000 })
  try {
    await tcl.connect()
    assert.deepEqual(await tcl.readWords(0x20000000, 2), [0x3f7, 0x2a])
    // The guard runs before the socket write, so the server never sees it.
    await assert.rejects(() => tcl.cmd('mww 0x20000000 0'), /read-only/)
  } finally {
    tcl.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('OcdReader: batches a struct into one poll and emits one sample set', async () => {
  const server = createServer(socket => {
    socket.on('data', chunk => {
      const command = chunk.toString('latin1').replace(/\x1a.*$/s, '')
      if (command.startsWith('mdw')) socket.write('0x20000000: 000003f7 0000002a\n\x1a')
      else socket.write('\n\x1a')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const reader = new OcdReader({ host: '127.0.0.1', port, verifyConsistency: false, batchDistanceBytes: 64 })
  reader.setBindings([
    { name: 'volt', address: 0x20000000, type: 'u32' },
    { name: 'amps', address: 0x20000004, type: 'u32' },
  ])
  const seen: Record<string, number | boolean>[] = []
  reader.on('samples', samples => {
    for (const s of samples) seen.push(s.values)
  })
  try {
    await reader.start()
    await reader.tick()
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { volt: 0x3f7, amps: 0x2a })
  } finally {
    reader.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('OcdReader: a value that changes between the two reads is dropped as torn', async () => {
  // Each mdw reply alternates, so verifyConsistency always sees a mismatch.
  let call = 0
  const server = createServer(socket => {
    socket.on('data', chunk => {
      const command = chunk.toString('latin1').replace(/\x1a.*$/s, '')
      if (command.startsWith('mdw')) {
        call += 1
        socket.write(`0x20000000: 0000000${call}\n\x1a`)
      } else socket.write('\n\x1a')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const reader = new OcdReader({ host: '127.0.0.1', port, verifyConsistency: true })
  reader.setBindings([{ name: 'unstable', address: 0x20000000, type: 'u32' }])
  const seen: Record<string, number | boolean>[] = []
  reader.on('samples', samples => {
    for (const s of samples) seen.push(s.values)
  })
  try {
    await reader.start()
    await reader.tick()
    // A torn read must produce NO sample rather than a wrong one.
    assert.deepEqual(seen, [])
    const status = reader.status()
    assert.equal(status.kind, 'running')
    assert.equal(status.kind === 'running' ? status.tornDropped : -1, 1)
  } finally {
    reader.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
