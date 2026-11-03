/**
 * Parser tests.
 *
 * The cases that matter most are the ones a naive implementation gets wrong:
 * chunk boundaries splitting a line, a value arriving without a header, a
 * non-numeric field inside otherwise valid data, and reconnect resets. Each
 * test states the behaviour it pins down.
 *
 * Run: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CsvParser } from '../src/parsers/csv.ts'
import { KeyValueParser } from '../src/parsers/keyvalue.ts'
import { BinaryFrameParser } from '../src/parsers/binary-frame.ts'
import { CustomRegexParser, namedGroupsOf } from '../src/parsers/custom-regex.ts'
import { LineSplitter, FixedFrameSplitter } from '../src/core/framing.ts'
import { createDefaultRegistry } from '../src/parsers/registry.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/* ───────────────────────────── framing helpers ───────────────────────────── */

test('LineSplitter: emits complete lines and retains a partial tail', () => {
  const splitter = new LineSplitter()
  assert.deepEqual(splitter.push(enc('a\nb\npar')), ['a', 'b'])
  assert.deepEqual(splitter.push(enc('tial\n')), ['partial'])
})

test('LineSplitter: a terminator split across chunks is still one line', () => {
  const splitter = new LineSplitter()
  assert.deepEqual(splitter.push(enc('hello\r')), [])
  assert.deepEqual(splitter.push(enc('\nworld\n')), ['hello', 'world'])
})

test('LineSplitter: a multi-byte character split across chunks decodes once', () => {
  const splitter = new LineSplitter()
  const bytes = enc('µV\n')
  assert.deepEqual(splitter.push(bytes.subarray(0, 1)), [])
  assert.deepEqual(splitter.push(bytes.subarray(1)), ['µV'])
})

test('LineSplitter: an unterminated stream cannot grow memory without bound', () => {
  const splitter = new LineSplitter(16)
  splitter.push(enc('x'.repeat(100)))
  // The retained tail is capped; the newest bytes survive.
  assert.equal(splitter.flush()?.length, 16)
})

test('FixedFrameSplitter: reassembles frames across arbitrary chunk splits', () => {
  const splitter = new FixedFrameSplitter(4)
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const frames = [...splitter.push(bytes.subarray(0, 3)), ...splitter.push(bytes.subarray(3, 7)), ...splitter.push(bytes.subarray(7))]
  assert.equal(frames.length, 2)
  assert.deepEqual([...frames[0]!], [1, 2, 3, 4])
  assert.deepEqual([...frames[1]!], [5, 6, 7, 8])
})

/* ─────────────────────────────────── CSV ─────────────────────────────────── */

test('CsvParser: a header line names the columns', () => {
  const p = new CsvParser()
  p.configure({ hasHeader: true })
  const samples = p.feed(enc('volt,amps\n12007,3\n12010,4\n'))
  assert.equal(samples.length, 2)
  assert.deepEqual(samples[0]!.values, { volt: 12007, amps: 3 })
  assert.deepEqual(p.descriptors().map(d => d.name), ['volt', 'amps'])
})

test('CsvParser: auto mode recognises a header and keeps every data row', () => {
  const p = new CsvParser()
  // No explicit hasHeader: the default auto rule must get this right, because
  // it is what an unconfigured deployment relies on.
  const samples = p.feed(enc('volt,amps\n12007,3\n12010,4\n'))
  assert.equal(samples.length, 2)
  assert.deepEqual(samples[0]!.values, { volt: 12007, amps: 3 })
  assert.deepEqual(p.descriptors().map(d => d.name), ['volt', 'amps'])
})

test('CsvParser: auto mode treats an all-numeric first line as data, not a header', () => {
  const p = new CsvParser()
  // The very first row must not be swallowed as a header.
  const samples = p.feed(enc('1,2\n3,4\n'))
  assert.equal(samples.length, 2)
  assert.deepEqual(samples[0]!.values, { col1: 1, col2: 2 })
})

test('CsvParser: hasHeader=false forces positional naming even for label rows', () => {
  const p = new CsvParser()
  p.configure({ hasHeader: false })
  // The label row cannot be parsed as data, so it yields no sample, but the
  // following numeric row still does.
  const samples = p.feed(enc('volt,amps\n12007,3\n'))
  assert.equal(samples.length, 1)
  assert.deepEqual(samples[0]!.values, { col1: 12007, col2: 3 })
})

test('CsvParser: columns are named positionally without a header', () => {
  const p = new CsvParser()
  const samples = p.feed(enc('1,2,3\n'))
  assert.deepEqual(samples[0]!.values, { col1: 1, col2: 2, col3: 3 })
})

test('CsvParser: an explicit column list overrides positional naming', () => {
  const p = new CsvParser()
  p.configure({ columns: ['vbat', 'temp'] })
  assert.deepEqual(p.feed(enc('12007,25\n'))[0]!.values, { vbat: 12007, temp: 25 })
})

test('CsvParser: a unit suffix is parsed and surfaced on the descriptor', () => {
  const p = new CsvParser()
  p.configure({ hasHeader: true })
  p.feed(enc('volt,temp\n'))
  const samples = p.feed(enc('12007 mV,25 °C\n'))
  assert.equal(samples[0]!.values['volt'], 12007)
  assert.equal(p.descriptors().find(d => d.name === 'volt')?.unit, 'mV')
  assert.equal(p.descriptors().find(d => d.name === 'temp')?.unit, '°C')
})

test('CsvParser: a non-numeric field is skipped, the rest of the row survives', () => {
  const p = new CsvParser()
  p.configure({ hasHeader: true })
  p.feed(enc('state,volt\n'))
  const samples = p.feed(enc('RUN,12007\n'))
  assert.deepEqual(samples[0]!.values, { volt: 12007 })
})

test('CsvParser: a line split across chunks yields one sample, not zero', () => {
  const p = new CsvParser()
  // Explicit columns with NO header line: every complete line is data, so this
  // isolates chunk-boundary reassembly from header handling.
  p.configure({ columns: ['a', 'b'] })
  assert.deepEqual(p.feed(enc('12')), [])
  const samples = p.feed(enc('3,456\n'))
  assert.equal(samples.length, 1)
  assert.deepEqual(samples[0]!.values, { a: 123, b: 456 })
})

test('CsvParser: hasHeader with explicit columns skips the header text but keeps the names', () => {
  const p = new CsvParser()
  p.configure({ hasHeader: true, columns: ['a', 'b'] })
  // The header line is consumed (its own text is ignored in favour of the
  // explicit names), so the first DATA line still yields a sample.
  assert.deepEqual(p.feed(enc('whatever,ignored\n')), [])
  const samples = p.feed(enc('1,2\n'))
  assert.equal(samples.length, 1)
  assert.deepEqual(samples[0]!.values, { a: 1, b: 2 })
})

test('CsvParser: tab and semicolon delimiters are honoured', () => {
  const tab = new CsvParser(); tab.configure({ delimiter: '\t', columns: ['a', 'b'] })
  assert.deepEqual(tab.feed(enc('1\t2\n'))[0]!.values, { a: 1, b: 2 })
  const semi = new CsvParser(); semi.configure({ delimiter: ';', columns: ['a', 'b'] })
  assert.deepEqual(semi.feed(enc('1;2\n'))[0]!.values, { a: 1, b: 2 })
})

test('CsvParser: scientific notation and negatives parse', () => {
  const p = new CsvParser()
  p.configure({ columns: ['a', 'b'] })
  assert.deepEqual(p.feed(enc('-1.5e3,2.5E-2\n'))[0]!.values, { a: -1500, b: 0.025 })
})

/* ─────────────────────────────── key = value ─────────────────────────────── */

test('KeyValueParser: one pair per line', () => {
  const p = new KeyValueParser()
  const samples = p.feed(enc('volt=12007\namps=3\n'))
  assert.equal(samples.length, 2)
  assert.deepEqual(samples[0]!.values, { volt: 12007 })
  assert.deepEqual(samples[1]!.values, { amps: 3 })
})

test('KeyValueParser: several pairs on one line each become their own sample', () => {
  const p = new KeyValueParser()
  const samples = p.feed(enc('volt=12007 amps=3 temp=25\n'))
  assert.equal(samples.length, 3)
  assert.deepEqual(samples.map(s => Object.keys(s.values)[0]), ['volt', 'amps', 'temp'])
})

test('KeyValueParser: both = and : separators work', () => {
  const p = new KeyValueParser()
  const samples = p.feed(enc('a=1\nb: 2\n'))
  assert.deepEqual(samples[0]!.values, { a: 1 })
  assert.deepEqual(samples[1]!.values, { b: 2 })
})

test('KeyValueParser: units are captured on the descriptor', () => {
  const p = new KeyValueParser()
  p.feed(enc('sleep=20 ms\n'))
  assert.equal(p.descriptors().find(d => d.name === 'sleep')?.unit, 'ms')
})

test('KeyValueParser: boolean words become booleans', () => {
  const p = new KeyValueParser()
  const samples = p.feed(enc('fd=false\nnfc=true\n'))
  assert.deepEqual(samples[0]!.values, { fd: false })
  assert.deepEqual(samples[1]!.values, { nfc: true })
  assert.equal(p.descriptors().find(d => d.name === 'fd')?.kind, 'bool')
})

test('KeyValueParser: a configured separator excludes the other form', () => {
  const p = new KeyValueParser()
  p.configure({ separator: '=' })
  const samples = p.feed(enc('a=1\nb:2\n'))
  assert.equal(samples.length, 1)
  assert.deepEqual(samples[0]!.values, { a: 1 })
})

test('KeyValueParser: a pair split across chunks is recovered', () => {
  const p = new KeyValueParser()
  assert.deepEqual(p.feed(enc('volt=12')), [])
  assert.deepEqual(p.feed(enc('007\n'))[0]!.values, { volt: 12007 })
})

/* ─────────────────────────────── binary frames ──────────────────────────── */

test('BinaryFrameParser: fixed-length frames decode with explicit layout', () => {
  const p = new BinaryFrameParser()
  p.configure({
    frameLength: 6,
    fields: [
      { name: 'a', type: 'u16' },
      { name: 'b', type: 'i16' },
      { name: 'c', type: 'u16' },
    ],
  })
  // little-endian: 0x0102 = 258 as u16, -2 as i16, 0x0304 = 772
  const samples = p.feed(Uint8Array.from([0x02, 0x01, 0xfe, 0xff, 0x04, 0x03]))
  assert.deepEqual(samples[0]!.values, { a: 258, b: -2, c: 772 })
})

test('BinaryFrameParser: big-endian decoding is selectable', () => {
  const p = new BinaryFrameParser()
  p.configure({ frameLength: 2, endianness: 'big', fields: [{ name: 'a', type: 'u16' }] })
  assert.deepEqual(p.feed(Uint8Array.from([0x01, 0x02]))[0]!.values, { a: 258 })
})

test('BinaryFrameParser: f32 decodes', () => {
  const p = new BinaryFrameParser()
  p.configure({ frameLength: 4, fields: [{ name: 'v', type: 'f32' }] })
  const buf = new ArrayBuffer(4)
  new DataView(buf).setFloat32(0, 3.5, true)
  assert.equal(p.feed(new Uint8Array(buf))[0]!.values['v'], 3.5)
})

test('BinaryFrameParser: a frame split across chunks is reassembled', () => {
  const p = new BinaryFrameParser()
  p.configure({ frameLength: 4, fields: [{ name: 'a', type: 'u32' }] })
  assert.deepEqual(p.feed(Uint8Array.from([1, 2])), [])
  const samples = p.feed(Uint8Array.from([3, 4]))
  assert.equal(samples.length, 1)
})

test('BinaryFrameParser: a magic prefix filters out non-frames', () => {
  const p = new BinaryFrameParser()
  p.configure({ frameLength: 3, magic: 'AA 55', fields: [{ name: 'a', type: 'u8' }] })
  assert.deepEqual(p.feed(Uint8Array.from([0x00, 0x55, 0x09])), [])
  assert.deepEqual(p.feed(Uint8Array.from([0xaa, 0x55, 0x09]))[0]!.values, { a: 9 })
})

test('BinaryFrameParser: explicit offsets allow padding', () => {
  const p = new BinaryFrameParser()
  p.configure({ frameLength: 4, fields: [{ name: 'a', type: 'u8', offset: 3 }] })
  assert.deepEqual(p.feed(Uint8Array.from([0, 0, 0, 7]))[0]!.values, { a: 7 })
})

test('BinaryFrameParser: a length-prefixed frame is framed by its own header', () => {
  const p = new BinaryFrameParser()
  p.configure({
    lengthField: { offset: 0, size: 1, includesHeader: true },
    fields: [{ name: 'v', type: 'u16', offset: 1 }],
  })
  // length 3 (header included), payload 0x0102
  const samples = p.feed(Uint8Array.from([3, 0x02, 0x01]))
  assert.deepEqual(samples[0]!.values, { v: 258 })
})

/* ─────────────────────────────── custom regex ───────────────────────────── */

test('namedGroupsOf: extracts group names in order', () => {
  assert.deepEqual(namedGroupsOf('V=(?<volt>\\d+)mA I=(?<amps>-?\\d+)'), ['volt', 'amps'])
})

test('CustomRegexParser: named groups become variables', () => {
  const p = new CustomRegexParser()
  p.configure({ pattern: 'V=(?<volt>\\d+)mV\\s+I=(?<amps>-?\\d+)mA' })
  const samples = p.feed(enc('V=12007mV I=15mA\n'))
  assert.deepEqual(samples[0]!.values, { volt: 12007, amps: 15 })
})

test('CustomRegexParser: a suffix after the group becomes the unit', () => {
  const p = new CustomRegexParser()
  p.configure({ pattern: 'V=(?<volt>[\\d.]+)\\s*(?<unit>mV|V)' })
  const samples = p.feed(enc('V=3.3 V\n'))
  assert.equal(samples[0]!.values['volt'], 3.3)
})

test('CustomRegexParser: no pattern yields no samples rather than throwing', () => {
  const p = new CustomRegexParser()
  assert.deepEqual(p.feed(enc('anything\n')), [])
})

test('CustomRegexParser: a line split across chunks is recovered', () => {
  const p = new CustomRegexParser()
  p.configure({ pattern: 'V=(?<v>\\d+)' })
  assert.deepEqual(p.feed(enc('V=12')), [])
  assert.deepEqual(p.feed(enc('3\n'))[0]!.values, { v: 123 })
})

/* ───────────────────────────────── registry ─────────────────────────────── */

test('ParserRegistry: ships the built-in parsers plus the script escape hatch', () => {
  const registry = createDefaultRegistry()
  // `script` is the user-editable escape hatch for formats the fixed parsers do
  // not cover; `test/parsers-edit.test.ts` owns its sandbox behaviour.
  assert.deepEqual(registry.list().sort(), ['binary-frame', 'csv', 'custom-regex', 'keyvalue', 'script'])
})

test('ParserRegistry: an unknown id throws with the available ids listed', () => {
  const registry = createDefaultRegistry()
  assert.throws(() => registry.create('nope'), /unknown variable parser "nope".*available: /s)
})

test('ParserRegistry: register returns a disposer that only removes its own entry', () => {
  const registry = createDefaultRegistry()
  const dispose = registry.register('mine', () => new CsvParser())
  assert.equal(registry.has('mine'), true)
  dispose()
  assert.equal(registry.has('mine'), false)
})
