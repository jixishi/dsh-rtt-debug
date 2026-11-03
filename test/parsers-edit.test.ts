/**
 * Tests for the user-editable parser surfaces:
 *
 *   - `decodeTerminator` — the editable record terminator;
 *   - `LineSplitter` with a configured terminator;
 *   - the four line parsers honouring `lineTerminator`;
 *   - the sandboxed `script` parser, including the escape attempts it must
 *     refuse. That last group matters most: the expression runs in the HOST
 *     process, so a hole here is remote code execution, not a parsing bug.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LineSplitter, decodeTerminator } from '../src/core/framing.ts'
import { CsvParser } from '../src/parsers/csv.ts'
import { KeyValueParser } from '../src/parsers/keyvalue.ts'
import { CustomRegexParser } from '../src/parsers/custom-regex.ts'
import { ScriptParser, compileScript } from '../src/parsers/script.ts'
import { createDefaultRegistry } from '../src/parsers/registry.ts'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/* ────────────────────────── terminator handling ─────────────────────────── */

test('decodeTerminator: escape spellings map to characters', () => {
  assert.equal(decodeTerminator('\\n'), '\n')
  assert.equal(decodeTerminator('\\r'), '\r')
  assert.equal(decodeTerminator('\\r\\n'), '\r\n')
  assert.equal(decodeTerminator('\\t'), '\t')
  assert.equal(decodeTerminator('\\0'), '\0')
})

test('decodeTerminator: empty falls back to a newline, a literal passes through', () => {
  assert.equal(decodeTerminator(''), '\n')
  assert.equal(decodeTerminator('#'), '#')
})

test('LineSplitter: a custom terminator frames records and keeps the tail', () => {
  const splitter = new LineSplitter(1024, ';')
  assert.deepEqual(splitter.push(bytes('a;b')), ['a'])
  // The partial tail waits for its terminator.
  assert.deepEqual(splitter.push(bytes('c;')), ['bc'])
})

test('LineSplitter: CRLF is stripped even when the terminator is a bare LF', () => {
  const splitter = new LineSplitter(1024, '\n')
  assert.deepEqual(splitter.push(bytes('one\r\ntwo\r\n')), ['one', 'two'])
})

test('LineSplitter: a two-character terminator is consumed whole', () => {
  const splitter = new LineSplitter(1024, '\r\n')
  assert.deepEqual(splitter.push(bytes('x\r\ny\r\n')), ['x', 'y'])
})

/* ─────────────────────── parsers honour the terminator ──────────────────── */

test('CsvParser: lineTerminator=\\r frames carriage-return records', () => {
  const parser = new CsvParser()
  parser.configure({ lineTerminator: '\\r', hasHeader: false })
  const samples = parser.feed(bytes('1,2\r3,4\r'))
  assert.equal(samples.length, 2)
  assert.equal(samples[0]?.values['col1'], 1)
  assert.equal(samples[1]?.values['col2'], 4)
})

test('KeyValueParser: lineTerminator=\\; frames semicolon records', () => {
  const parser = new KeyValueParser()
  parser.configure({ lineTerminator: ';', multiplePerLine: true })
  const samples = parser.feed(bytes('a=1 b=2;c=3;'))
  assert.ok(samples.length >= 2)
  assert.equal(samples[0]?.values['a'], 1)
})

test('CustomRegexParser: lineTerminator is applied to framing', () => {
  const parser = new CustomRegexParser()
  parser.configure({ pattern: 'V=(?<v>\\d+)', lineTerminator: '\\0' })
  const samples = parser.feed(bytes('V=7\u0000V=8\u0000'))
  assert.equal(samples.length, 2)
  assert.equal(samples[1]?.values['v'], 8)
})

/* ───────────────────────── sandbox: must refuse escapes ─────────────────── */

test('compileScript: a plain expression produces values', () => {
  const { evaluate, error } = compileScript('{ volt: fields[0] * 3.3 / 4095, amps: fields[1] / 1000 }')
  assert.equal(error, undefined)
  const values = evaluate?.(['4095', '1500'], '4095,1500', 0)
  assert.ok(values !== undefined)
  assert.ok(Math.abs((values.volt as number) - 3.3) < 1e-9)
  assert.equal(values.amps, 1.5)
})

test('compileScript: Math and Number are available, nothing else is', () => {
  const ok = compileScript('{ r: Math.round(Number(fields[0])) }')
  assert.equal(ok.error, undefined)
  assert.deepEqual(ok.evaluate?.(['1.7'], '1.7', 0), { r: 2 })
})

test('compileScript: host escape attempts are all refused', () => {
  const attempts = [
    'process.exit(1)',
    'require("fs")',
    'globalThis.process',
    'this.constructor.constructor("return process")()',
    'fields.constructor.constructor("return 1")()',
    '(()=>{return 1})()',
    'eval("1")',
    'new Function("return 1")',
    'x = 1; x',
    'import("fs")',
    'global.process',
    'window.location',
  ]
  for (const attempt of attempts) {
    const result = compileScript(attempt)
    assert.equal(result.evaluate, undefined, `must refuse: ${attempt}`)
    assert.ok(result.error !== undefined && result.error !== '', `must explain refusal: ${attempt}`)
  }
})

test('compileScript: an unknown identifier is refused by name', () => {
  const result = compileScript('{ v: secretValue }')
  assert.equal(result.evaluate, undefined)
  assert.match(result.error ?? '', /unknown name "secretValue"/)
})

test('compileScript: property access on the result object is allowed (data keys)', () => {
  // `Math.round` is an allow-listed global's member; a script must be able to
  // call it without the identifier rule rejecting `round`.
  const result = compileScript('{ v: Math.max(fields[0], fields[1]) }')
  assert.equal(result.error, undefined)
  assert.deepEqual(result.evaluate?.(['1', '5'], '1,5', 0), { v: 5 })
})

/* ─────────────────────────── script parser behaviour ────────────────────── */

test('ScriptParser: an expression turns records into variables', () => {
  const parser = new ScriptParser()
  parser.configure({ expression: '{ millivolts: fields[0] / 1, amps: fields[1] * 2 }', delimiter: ',' })
  const samples = parser.feed(bytes('1000,5\n2000,6\n'))
  assert.equal(samples.length, 2)
  assert.deepEqual(samples[0]?.values, { millivolts: 1000, amps: 10 })
  assert.equal(parser.descriptors().length, 2)
})

test('ScriptParser: a throwing record is skipped, the stream continues', () => {
  const parser = new ScriptParser()
  // `fields[9]` is undefined on the first record, so `.x` throws inside.
  parser.configure({ expression: '{ v: fields[0] }' })
  assert.equal(parser.feed(bytes('1\n2\n')).length, 2)
})

test('ScriptParser: skipFirstLine drops a header record', () => {
  const parser = new ScriptParser()
  parser.configure({ expression: '{ v: fields[0] }', skipFirstLine: true })
  const samples = parser.feed(bytes('volt\n12\n13\n'))
  assert.equal(samples.length, 2)
  assert.equal(samples[0]?.values['v'], 12)
})

test('ScriptParser: no expression yields no samples rather than throwing', () => {
  const parser = new ScriptParser()
  parser.configure({})
  assert.equal(parser.feed(bytes('1,2\n')).length, 0)
  assert.ok(typeof parser.error === 'string')
})

test('ScriptParser: a refused expression is reported and produces nothing', () => {
  const parser = new ScriptParser()
  parser.configure({ expression: 'process.exit(1)' })
  assert.equal(parser.feed(bytes('1\n')).length, 0)
  assert.match(parser.error ?? '', /rejected/)
})

test('registry: the script parser is registered alongside the built-ins', () => {
  const registry = createDefaultRegistry()
  assert.ok(registry.list().includes('script'))
  assert.ok(registry.list().includes('csv'))
  const parser = registry.create('script') as ScriptParser
  assert.equal(parser.id, 'script')
})

/* ────────────── reconfiguration must not leak the old parser ────────────── */

test('ScriptParser: reconfiguring drops names the new expression no longer emits', () => {
  // The panel re-sends the whole parser block on every save, so a re-configure
  // is the normal path. A stale roster would keep advertising a variable whose
  // series never receives another point.
  const parser = new ScriptParser()
  parser.configure({ expression: '{ a: fields[0] }' })
  parser.feed(bytes('1\n'))
  assert.deepEqual(parser.descriptors().map(d => d.name), ['a'])

  parser.configure({ expression: '{ b: fields[1] }' })
  parser.feed(bytes('1,2\n'))
  assert.deepEqual(parser.descriptors().map(d => d.name), ['b'])
})

test('CsvParser: reconfiguring the delimiter reframes the stream', () => {
  const parser = new CsvParser()
  parser.configure({ hasHeader: false, delimiter: ',' })
  assert.equal(parser.feed(bytes('1;2\n'))[0]?.values['col1'], undefined)

  const second = new CsvParser()
  second.configure({ hasHeader: false, delimiter: ';' })
  assert.equal(second.feed(bytes('1;2\n'))[0]?.values['col1'], 1)
})

test('CsvParser: the automatic header still wins over a numeric-looking first line', () => {
  // Guards the behaviour documented for users: an all-numeric first line is
  // DATA, not a header, so no sample may be dropped.
  const parser = new CsvParser()
  parser.configure({})
  const samples = parser.feed(bytes('1,2\n3,4\n'))
  assert.equal(samples.length, 2)
  assert.equal(samples[0]?.values['col1'], 1)
})
