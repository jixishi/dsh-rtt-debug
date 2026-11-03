/**
 * Tests for the ANSI decoder, severity detection, and the two ring stores.
 *
 * The behaviours pinned down here are the ones that decide whether a long
 * session stays usable: style carried across lines, escapes never leaking into
 * the view, severity not mis-detected on ordinary text, and both rings dropping
 * OLD data while keeping their completeness counters intact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AnsiDecoder, detectLevel, spansToText } from '../src/core/ansi.ts'
import { LogStore, SeriesStore } from '../src/core/store.ts'

/* ─────────────────────────────── ANSI decoder ───────────────────────────── */

test('AnsiDecoder: a colour set on one line carries into the next', () => {
  const d = new AnsiDecoder()
  const first = d.push('\x1b[1;32mgreen line')
  assert.equal(spansToText(first), 'green line')
  assert.equal(first[0]?.color, 'green')
  assert.equal(first[0]?.bold, true)

  // No reset in between: the target set the colour once and kept printing.
  const second = d.push('still green')
  assert.equal(second[0]?.color, 'green')
})

test('AnsiDecoder: reset clears the carried style', () => {
  const d = new AnsiDecoder()
  d.push('\x1b[31mred')
  const after = d.push('\x1b[0mplain')
  assert.equal(after[0]?.color, undefined)
  assert.equal(after[0]?.text, 'plain')
})

test('AnsiDecoder: text before and after an escape produce separate spans', () => {
  const d = new AnsiDecoder()
  const spans = d.push('a\x1b[31mb\x1b[0mc')
  assert.equal(spansToText(spans), 'abc')
  assert.equal(spans.length, 3)
  assert.equal(spans[1]?.color, 'red')
})

test('AnsiDecoder: bright colours map to their own names', () => {
  const d = new AnsiDecoder()
  assert.equal(d.push('\x1b[96mcyan-ish')[0]?.color, 'brightCyan')
})

test('AnsiDecoder: a non-SGR escape is stripped, never rendered', () => {
  const d = new AnsiDecoder()
  const spans = d.push('a\x1b[2Jb')
  assert.equal(spansToText(spans), 'ab')
})

test('AnsiDecoder: an empty parameter list means reset', () => {
  const d = new AnsiDecoder()
  d.push('\x1b[31mred')
  assert.equal(d.push('\x1b[m')[0]?.color, undefined)
})

test('AnsiDecoder: reset() drops carried state for a fresh stream', () => {
  const d = new AnsiDecoder()
  d.push('\x1b[31mred')
  d.reset()
  assert.equal(d.push('plain')[0]?.color, undefined)
})

test('AnsiDecoder: background colours are ignored, text is untouched', () => {
  const d = new AnsiDecoder()
  const spans = d.push('\x1b[41mtext')
  assert.equal(spansToText(spans), 'text')
  assert.equal(spans[0]?.color, undefined)
})

/* ───────────────────────────── severity detection ───────────────────────── */

test('detectLevel: prefix markers win over later words', () => {
  assert.equal(detectLevel('INFO: error count 0'), 'info')
  assert.equal(detectLevel('ERROR: info sync failed'), 'error')
})

test('detectLevel: finds bracketed levels', () => {
  assert.equal(detectLevel('[WARN] low battery'), 'warn')
  assert.equal(detectLevel('[ERROR] bus fault'), 'error')
})

test('detectLevel: ordinary text stays unknown', () => {
  assert.equal(detectLevel('Volt=12007 mV'), 'unknown')
  // A word merely containing "err" must not match.
  assert.equal(detectLevel('terrain chart updated'), 'unknown')
})

test('detectLevel: recognises DEBUG and TRACE', () => {
  assert.equal(detectLevel('DBG: tick'), 'debug')
  assert.equal(detectLevel('trace: entry'), 'debug')
})

/* ──────────────────────────────── SeriesStore ───────────────────────────── */

test('SeriesStore: routes samples to one series per variable, in time order', () => {
  const store = new SeriesStore({ sampleRateHz: 0 })
  store.append([{ ts: 1000, values: { a: 1, b: 2 } }, { ts: 1001, values: { a: 3 } }])
  assert.deepEqual(store.get('a')?.values, [1, 3])
  assert.deepEqual(store.get('b')?.values, [2])
})

test('SeriesStore: booleans get a bool series', () => {
  const store = new SeriesStore({ sampleRateHz: 0 })
  store.append([{ ts: 1, values: { flag: true } }])
  assert.equal(store.get('flag')?.kind, 'bool')
})

test('SeriesStore: decimation keeps the newest value inside each interval', () => {
  const store = new SeriesStore({ sampleRateHz: 10 }) // 100 ms interval
  store.append([{ ts: 0, values: { a: 1 } }])
  store.append([{ ts: 50, values: { a: 2 } }])   // too soon — dropped
  store.append([{ ts: 100, values: { a: 3 } }])  // new interval — kept
  assert.deepEqual(store.get('a')?.values, [1, 3])
})

test('SeriesStore: decimation can be disabled', () => {
  const store = new SeriesStore({ sampleRateHz: 0 })
  store.append([{ ts: 0, values: { a: 1 } }, { ts: 1, values: { a: 2 } }])
  assert.deepEqual(store.get('a')?.values, [1, 2])
})

test('SeriesStore: the per-series point cap drops the OLDEST points', () => {
  const store = new SeriesStore({ sampleRateHz: 0, maxPointsPerSeries: 3, retentionMs: 1e9 })
  for (let i = 0; i < 5; i += 1) store.append([{ ts: i, values: { a: i } }])
  assert.deepEqual(store.get('a')?.values, [2, 3, 4])
})

test('SeriesStore: the retention window is anchored to the newest SAMPLE, not the wall clock', () => {
  const store = new SeriesStore({ sampleRateHz: 0, retentionMs: 100, maxPointsPerSeries: 1e6 })
  store.append([{ ts: 0, values: { a: 0 } }])
  store.append([{ ts: 500, values: { a: 5 } }])
  // The 0 ms point is 500 ms behind the newest sample — outside the 100 ms window.
  assert.deepEqual(store.get('a')?.values, [5])
})

test('SeriesStore: samples stamped with target uptime are NOT discarded', () => {
  // A target stamping uptime milliseconds shares no epoch with Date.now(); a
  // wall-clock-anchored window would wipe every point the moment it landed.
  const store = new SeriesStore({ sampleRateHz: 0, retentionMs: 1000, maxPointsPerSeries: 1e6 })
  for (let i = 0; i < 5; i += 1) store.append([{ ts: i * 10, values: { a: i } }])
  assert.equal(store.get('a')?.values.length, 5)
})

test('SeriesStore: shrinking the cap via configure trims immediately', () => {
  const store = new SeriesStore({ sampleRateHz: 0, maxPointsPerSeries: 100, retentionMs: 1e9 })
  for (let i = 0; i < 10; i += 1) store.append([{ ts: i, values: { a: i } }])
  store.configure({ maxPointsPerSeries: 2 })
  assert.deepEqual(store.get('a')?.values, [8, 9])
})

test('SeriesStore: clear() drops everything', () => {
  const store = new SeriesStore()
  store.append([{ ts: 1, values: { a: 1 } }])
  store.clear()
  assert.deepEqual(store.names(), [])
})

test('SeriesStore: setMeta attaches a discovered unit', () => {
  const store = new SeriesStore({ sampleRateHz: 0 })
  store.append([{ ts: 1, values: { a: 1 } }])
  store.setMeta('a', { unit: 'mV' })
  assert.equal(store.get('a')?.unit, 'mV')
})

/* ────────────────────────────────── LogStore ─────────────────────────────── */

const rec = (ts: number, text: string): { ts: number; text: string; spans: { text: string }[]; level: 'info' } =>
  ({ ts, text, spans: [{ text }], level: 'info' })

test('LogStore: assigns increasing sequence numbers', () => {
  const store = new LogStore()
  assert.equal(store.push(rec(1, 'a')).seq, 1)
  assert.equal(store.push(rec(2, 'b')).seq, 2)
})

test('LogStore: capacity drops the oldest lines but counts every line ingested', () => {
  const store = new LogStore({ maxLines: 3 })
  for (let i = 1; i <= 5; i += 1) store.push(rec(i, `line ${i}`))
  assert.deepEqual(store.entries().map(l => l.text), ['line 3', 'line 4', 'line 5'])
  // The completeness counter is independent of what the ring retains (A16).
  assert.equal(store.totalIngested, 5)
})

test('LogStore: shrinking the capacity via configure trims immediately', () => {
  const store = new LogStore({ maxLines: 10 })
  for (let i = 1; i <= 6; i += 1) store.push(rec(i, `l${i}`))
  store.configure({ maxLines: 2 })
  assert.deepEqual(store.entries().map(l => l.text), ['l5', 'l6'])
})

test('LogStore: clear() keeps the counters, reset() restarts the session', () => {
  const store = new LogStore()
  store.push(rec(1, 'a'))
  store.clear()
  assert.equal(store.entries().length, 0)
  assert.equal(store.totalIngested, 1)
  assert.equal(store.nextSequence, 2)

  store.reset()
  assert.equal(store.totalIngested, 0)
  assert.equal(store.nextSequence, 1)
})

test('LogStore: toText renders timestamp, level and text', () => {
  const store = new LogStore()
  store.push(rec(1000, 'hello'))
  const text = store.toText(ts => `t=${ts}`)
  assert.equal(text, 't=1000 [INFO] hello')
})
