/**
 * Waveform renderer.
 *
 * A single-Y-axis time-series plot drawn on a 2-D canvas. Hand-written rather
 * than built on a charting library so the ruler, cursors and measurement
 * readout can be exactly what the spec asks for, and so the panel adds no
 * runtime dependency.
 *
 * Two design points worth stating:
 *
 *   - **Decimation to pixels.** A 10-minute window at 10 Hz is 6000 points per
 *     series; drawing each one wastes time and hides detail in overdraw. Each
 *     pixel column is reduced to its min/max envelope, which is what an
 *     oscilloscope shows and is stable as the window narrows.
 *   - **Layered redraw.** Grid+axes and series are drawn together, but the
 *     cursor overlay is a separate pass. Moving a cursor therefore never
 *     re-decimates the data.
 */

import type { CursorState, DeltaReadout, PlotMetrics, Viewport } from './plot-types.ts'
import type { Series } from '../core/store.ts'

/** Palette used for series, assigned by index and stable per series name. */
export const SERIES_COLORS = [
  '#4dabf7', '#ffd43b', '#69db7c', '#ff8787', '#b197fc',
  '#4dd4c4', '#ffa94d', '#f783ac', '#a9e34b', '#9775fa',
] as const

/** Colour for a series, derived from its position in the stable name list. */
export function colorFor(name: string, allNames: readonly string[]): string {
  const index = allNames.indexOf(name)
  const palette = SERIES_COLORS
  return palette[(index < 0 ? 0 : index) % palette.length] as string
}

/** Theme colours, read once per draw from CSS custom properties. */
export interface PlotTheme {
  background: string
  grid: string
  gridStrong: string
  axis: string
  text: string
  cursor: string
  crosshair: string
}

/** Resolve theme colors dynamically, responding to DSH's light/dark mode. */
export function resolvePlotTheme(): PlotTheme {
  const isDark = typeof document !== 'undefined'
    ? (document.body?.hasAttribute('data-ds-dark-theme')
       || document.documentElement?.getAttribute('data-theme') === 'dark'
       || document.documentElement?.classList.contains('dark')
       || window?.matchMedia?.('(prefers-color-scheme: dark)')?.matches)
    : true

  if (isDark) {
    return {
      background: 'transparent',
      grid: 'rgba(255,255,255,0.08)',
      gridStrong: 'rgba(255,255,255,0.2)',
      axis: 'rgba(255,255,255,0.45)',
      text: '#e2e8f0',
      cursor: '#ff922b',
      crosshair: 'rgba(255,255,255,0.6)',
    }
  }

  // Light theme: crisp dark slate text and dark grid lines against light background
  return {
    background: 'transparent',
    grid: 'rgba(0,0,0,0.08)',
    gridStrong: 'rgba(0,0,0,0.18)',
    axis: 'rgba(0,0,0,0.45)',
    text: '#1e293b',
    cursor: '#e8590c',
    crosshair: 'rgba(0,0,0,0.5)',
  }
}

export const DEFAULT_THEME: PlotTheme = {
  background: 'transparent',
  grid: 'rgba(255,255,255,0.1)',
  gridStrong: 'rgba(255,255,255,0.22)',
  axis: 'rgba(255,255,255,0.5)',
  text: '#e2e8f0',
  cursor: '#ff922b',
  crosshair: 'rgba(255,255,255,0.7)',
}

/** Left/bottom margins reserved for the axes' tick labels. */
const MARGIN = { left: 70, right: 14, top: 12, bottom: 28 }

/**
 * Compute the drawing area inside the canvas.
 * @returns sizes in CSS pixels (the caller scales the context for DPR).
 */
export function plotMetrics(width: number, height: number): PlotMetrics {
  return {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, width - MARGIN.left - MARGIN.right),
    height: Math.max(10, height - MARGIN.top - MARGIN.bottom),
  }
}

/**
 * Choose a "nice" tick step at or above a raw interval.
 *
 * Steps land on 1/2/5 × 10^n so labels read as round numbers, which is what
 * makes a ruler usable.
 */
export function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const normalized = rawStep / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return factor * magnitude
}

/** Tick values covering [min, max], at most `maxTicks` of them. */
export function ticksFor(min: number, max: number, maxTicks: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const step = niceStep((max - min) / Math.max(1, maxTicks))
  const first = Math.ceil(min / step) * step
  const out: number[] = []
  for (let value = first; value <= max + step * 1e-9; value += step) {
    out.push(Number(value.toFixed(12)))
    if (out.length > 512) break
  }
  return out
}

/**
 * Default number of divisions across the time axis.
 *
 * A scope-style ruler reads best at a fixed, dense division count rather than
 * the four-to-six bands a value axis wants, so the default is deliberately
 * larger than a chart library would pick.
 */
export const DEFAULT_TIME_DIVISIONS = 50

/** Smallest division count the ruler accepts (one grid line per division). */
export const MIN_TIME_DIVISIONS = 2
/** Largest division count the ruler accepts, to keep labels legible. */
export const MAX_TIME_DIVISIONS = 200

/** Clamp a requested division count into the supported band. */
export function clampTimeDivisions(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIME_DIVISIONS
  return Math.min(MAX_TIME_DIVISIONS, Math.max(MIN_TIME_DIVISIONS, Math.round(value)))
}

/**
 * How many of the requested divisions can actually be *labelled* in this width.
 *
 * Fifty divisions is the default, but a narrow pane cannot print fifty labels.
 * Grid LINES are always drawn at the requested density (that is the point of a
 * scope ruler); only the LABELS thin out, every `stride`-th line, so the density
 * the user asked for is preserved without turning the axis into mush.
 *
 * @param metrics - the plot area, in CSS pixels.
 * @param divisions - requested divisions.
 * @param minLabelSpacingPx - least pixels between two printed labels.
 * @returns the label stride (1 = label every line).
 */
export function timeLabelStride(
  metrics: PlotMetrics,
  divisions: number,
  minLabelSpacingPx = 46,
): number {
  const count = clampTimeDivisions(divisions)
  const spacing = metrics.width / Math.max(1, count)
  if (spacing >= minLabelSpacingPx) return 1
  return Math.min(count, Math.ceil(minLabelSpacingPx / Math.max(1, spacing)))
}

/** Format a value compactly, using an SI-ish suffix for large/small numbers. */
export function formatValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  let text: string
  const clean = (n: number, maxDec = 2): string => {
    const s = n.toFixed(maxDec)
    return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
  }
  if (abs === 0) text = '0'
  else if (abs >= 1e9) text = `${clean(value / 1e9)}G`
  else if (abs >= 1e6) text = `${clean(value / 1e6)}M`
  else if (abs >= 1e3) text = `${clean(value / 1e3)}k`
  else if (abs >= 1) text = clean(value, abs >= 100 ? 0 : 2)
  else if (abs >= 1e-3) text = `${clean(value * 1e3)}m`
  else if (abs >= 1e-6) text = `${clean(value * 1e6)}µ`
  else text = value.toExponential(2)
  return unit === undefined ? text : `${text} ${unit}`
}

/** Format a duration for a time-axis label. */
export function formatTime(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 1000) return `${ms.toFixed(0)}ms`
  if (abs < 60_000) return `${(ms / 1000).toFixed(2)}s`
  if (abs < 3_600_000) {
    const totalSeconds = ms / 1000
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds - minutes * 60
    return `${minutes}m${seconds.toFixed(0)}s`
  }
  return `${(ms / 3_600_000).toFixed(2)}h`
}

/**
 * Reduce one series to a per-pixel min/max envelope.
 *
 * @param series - the series to decimate.
 * @param viewport - the visible time window.
 * @param metrics - the plot area, in CSS pixels.
 * @returns two arrays (minima and maxima) of `metrics.width` entries; `NaN`
 *   marks a column with no data, so gaps stay visible as gaps.
 */
export function decimateToPixels(
  series: Series,
  viewport: Viewport,
  metrics: PlotMetrics,
): { lows: Float64Array; highs: Float64Array; firstIndex: number } {
  const width = Math.max(1, Math.floor(metrics.width))
  const lows = new Float64Array(width).fill(Number.NaN)
  const highs = new Float64Array(width).fill(Number.NaN)
  const span = viewport.tMax - viewport.tMin
  if (span <= 0 || series.ts.length === 0) return { lows, highs, firstIndex: 0 }

  // Binary search for the first point inside the window.
  let low = 0
  let high = series.ts.length - 1
  let firstIndex = series.ts.length
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((series.ts[mid] as number) < viewport.tMin) low = mid + 1
    else {
      firstIndex = mid
      high = mid - 1
    }
  }

  for (let i = firstIndex; i < series.ts.length; i += 1) {
    const ts = series.ts[i] as number
    if (ts > viewport.tMax) break
    const raw = series.values[i]
    if (typeof raw === 'boolean') {
      const asNumber = raw ? 1 : 0
      const column = columnFor(ts, viewport, metrics)
      if (column < 0 || column >= width) continue
      mergeColumn(lows, highs, column, asNumber)
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const column = columnFor(ts, viewport, metrics)
    if (column < 0 || column >= width) continue
    mergeColumn(lows, highs, column, raw)
  }
  return { lows, highs, firstIndex }
}

/** Map a timestamp to its pixel column. */
function columnFor(ts: number, viewport: Viewport, metrics: PlotMetrics): number {
  const span = viewport.tMax - viewport.tMin
  if (span <= 0) return 0
  return Math.round(((ts - viewport.tMin) / span) * (metrics.width - 1))
}

function mergeColumn(lows: Float64Array, highs: Float64Array, column: number, value: number): void {
  const existingLow = lows[column] as number
  const existingHigh = highs[column] as number
  lows[column] = Number.isNaN(existingLow) ? value : Math.min(existingLow, value)
  highs[column] = Number.isNaN(existingHigh) ? value : Math.max(existingHigh, value)
}

/** Map a value to its y pixel (inside the plot area). */
export function valueToY(value: number, viewport: Viewport, metrics: PlotMetrics): number {
  const span = viewport.vMax - viewport.vMin
  if (span <= 0) return metrics.top + metrics.height / 2
  const ratio = (value - viewport.vMin) / span
  return metrics.top + metrics.height * (1 - ratio)
}

/** Map a timestamp to its x pixel (inside the plot area). */
export function timeToX(ts: number, viewport: Viewport, metrics: PlotMetrics): number {
  const span = viewport.tMax - viewport.tMin
  if (span <= 0) return metrics.left
  return metrics.left + ((ts - viewport.tMin) / span) * metrics.width
}

/** Inverse of `timeToX` — where a pixel column sits on the time axis. */
export function xToTime(x: number, viewport: Viewport, metrics: PlotMetrics): number {
  const ratio = (x - metrics.left) / metrics.width
  return viewport.tMin + ratio * (viewport.tMax - viewport.tMin)
}

/** Inverse of `valueToY`. */
export function yToValue(y: number, viewport: Viewport, metrics: PlotMetrics): number {
  const ratio = 1 - (y - metrics.top) / metrics.height
  return viewport.vMin + ratio * (viewport.vMax - viewport.vMin)
}

export interface DrawOptions {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  viewport: Viewport
  series: Series[]
  /** Series names that are currently visible. */
  visible: ReadonlySet<string>
  cursors: CursorState
  /** Pointer position in CSS pixels, when hovering. */
  pointer?: { x: number; y: number }
  theme?: PlotTheme
  /** Requested time-axis divisions (default {@link DEFAULT_TIME_DIVISIONS}). */
  timeDivisions?: number
}

/**
 * Render one frame.
 *
 * The caller is responsible for the device-pixel-ratio transform; everything
 * here works in CSS pixels.
 */
export function drawPlot(options: DrawOptions): void {
  const { ctx, width, height, viewport, series, visible, cursors, pointer } = options
  const theme = options.theme ?? resolvePlotTheme()
  const metrics = plotMetrics(width, height)

  ctx.clearRect(0, 0, width, height)
  if (theme.background !== 'transparent') {
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, width, height)
  }

  drawGrid(ctx, metrics, viewport, theme, options.timeDivisions)
  drawSeries(ctx, metrics, viewport, series, visible, theme)
  drawCursors(ctx, metrics, viewport, cursors, theme)
  if (pointer !== undefined) drawCrosshair(ctx, metrics, viewport, pointer, series, visible, theme)
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  metrics: PlotMetrics,
  viewport: Viewport,
  theme: PlotTheme,
  timeDivisions?: number,
): void {
  const divisions = clampTimeDivisions(timeDivisions ?? DEFAULT_TIME_DIVISIONS)
  // Equal spacing is what makes a scope ruler readable: the window is split
  // into exactly `divisions` columns, so zooming changes the LABELS, not the
  // number of columns.
  const span = viewport.tMax - viewport.tMin
  const step = span > 0 ? span / divisions : 0
  const xTicks: number[] = []
  for (let i = 0; i <= divisions && step > 0; i += 1) {
    xTicks.push(viewport.tMin + step * i)
    if (xTicks.length > 512) break
  }
  const yTicks = ticksFor(viewport.vMin, viewport.vMax, 6)
  const labelStride = timeLabelStride(metrics, divisions)

  ctx.save()
  ctx.lineWidth = 1
  ctx.font = '500 12px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillStyle = theme.text
  ctx.strokeStyle = theme.grid

  // Horizontal grid + y labels
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const value of yTicks) {
    const y = Math.round(valueToY(value, viewport, metrics)) + 0.5
    if (y < metrics.top || y > metrics.top + metrics.height) continue
    ctx.beginPath()
    ctx.moveTo(metrics.left, y)
    ctx.lineTo(metrics.left + metrics.width, y)
    ctx.stroke()
    ctx.fillText(formatValue(value), metrics.left - 8, y)
  }

  // Vertical grid + x labels
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const [index, ts] of xTicks.entries()) {
    // Thin the labels, never the lines: a 50-division ruler on a narrow pane
    // keeps its 50 columns but prints every `labelStride`-th one.
    if (index % labelStride !== 0) continue
    const x = Math.round(timeToX(ts, viewport, metrics)) + 0.5
    if (x < metrics.left || x > metrics.left + metrics.width) continue
    ctx.beginPath()
    ctx.moveTo(x, metrics.top)
    ctx.lineTo(x, metrics.top + metrics.height)
    ctx.stroke()
    // Label with the offset from the window start: for a live feed the absolute
    // epoch is noise, while "how long ago" is what a user reads off a ruler.
    ctx.fillText(formatTime(ts - viewport.tMax), x, metrics.top + metrics.height + 8)
  }

  // Axis frame
  ctx.strokeStyle = theme.axis
  ctx.beginPath()
  ctx.moveTo(metrics.left + 0.5, metrics.top)
  ctx.lineTo(metrics.left + 0.5, metrics.top + metrics.height + 0.5)
  ctx.lineTo(metrics.left + metrics.width, metrics.top + metrics.height + 0.5)
  ctx.stroke()
  ctx.restore()
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  metrics: PlotMetrics,
  viewport: Viewport,
  series: Series[],
  visible: ReadonlySet<string>,
  theme: PlotTheme,
): void {
  const names = series.map(s => s.name)
  ctx.save()
  // Clip so a value outside the window cannot draw over the axis labels.
  ctx.beginPath()
  ctx.rect(metrics.left, metrics.top, metrics.width, metrics.height)
  ctx.clip()

  const GAP_THRESHOLD_MS = 5000

  for (const entry of series) {
    if (!visible.has(entry.name)) continue
    const len = entry.ts.length
    if (len === 0) continue

    const strokeColor = colorFor(entry.name, names)
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 1.8
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    // Binary search to find start/end points around the viewport
    let start = 0
    let end = len - 1
    let l = 0, r = len - 1
    while (l <= r) {
      const mid = (l + r) >> 1
      if ((entry.ts[mid] as number) < viewport.tMin) {
        start = mid
        l = mid + 1
      } else {
        r = mid - 1
      }
    }
    l = 0; r = len - 1
    while (l <= r) {
      const mid = (l + r) >> 1
      if ((entry.ts[mid] as number) > viewport.tMax) {
        end = mid
        r = mid - 1
      } else {
        l = mid + 1
      }
    }

    const visibleCount = Math.max(0, end - start + 1)

    // When points are sparse (e.g. zoomed in to 6s/30s or low frequency sampling),
    // connect consecutive sample points with direct lines so the waveform is smooth
    // and never disappears into disjoint pixel dots.
    if (visibleCount <= metrics.width * 2) {
      ctx.beginPath()
      let drawing = false
      let lastTs = 0
      const pointsToDraw: [number, number][] = []

      for (let i = start; i <= end; i += 1) {
        const ts = entry.ts[i] as number
        const raw = entry.values[i]
        const val = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          drawing = false
          continue
        }
        const x = timeToX(ts, viewport, metrics)
        const y = valueToY(val, viewport, metrics)

        if (drawing && (ts - lastTs > GAP_THRESHOLD_MS)) {
          drawing = false
        }

        if (!drawing) {
          ctx.moveTo(x, y)
          drawing = true
        } else {
          ctx.lineTo(x, y)
        }
        lastTs = ts
        pointsToDraw.push([x, y])
      }
      ctx.stroke()

      // When zoomed in close, draw crisp point markers so individual samples are prominent
      if (pointsToDraw.length <= 120) {
        ctx.fillStyle = strokeColor
        for (const [px, py] of pointsToDraw) {
          if (px >= metrics.left - 4 && px <= metrics.left + metrics.width + 4) {
            ctx.beginPath()
            ctx.arc(px, py, 3, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    } else {
      // Dense points: decimate to pixel columns
      const { lows, highs } = decimateToPixels(entry, viewport, metrics)
      ctx.beginPath()
      let lastCol = -1

      for (let column = 0; column < lows.length; column += 1) {
        const low = lows[column] as number
        if (Number.isNaN(low)) continue
        const high = highs[column] as number
        const x = metrics.left + column
        const yHigh = valueToY(high, viewport, metrics)
        const yLow = valueToY(low, viewport, metrics)

        if (lastCol === -1) {
          ctx.moveTo(x, yHigh)
        } else {
          const tCol = xToTime(x, viewport, metrics)
          const tLast = xToTime(metrics.left + lastCol, viewport, metrics)
          if (tCol - tLast > GAP_THRESHOLD_MS) {
            ctx.moveTo(x, yHigh)
          } else {
            ctx.lineTo(x, yHigh)
          }
        }
        if (yLow !== yHigh) ctx.lineTo(x, yLow)
        lastCol = column
      }
      ctx.stroke()
    }
  }
  ctx.restore()
  void theme
}

function drawCursors(
  ctx: CanvasRenderingContext2D,
  metrics: PlotMetrics,
  viewport: Viewport,
  cursors: CursorState,
  theme: PlotTheme,
): void {
  // Cursor positions arrive as timestamps so they stay pinned to the data when
  // the window scrolls.
  const drawn: { x: number; label: string; cursor: { t: number; v: number } }[] = []
  const columns = ['A', 'B'] as const
  for (const column of columns) {
    const cursor = column === 'A' ? cursors.a : cursors.b
    if (cursor === undefined) continue
    const x = timeToX(cursor.t, viewport, metrics)
    if (x < metrics.left || x > metrics.left + metrics.width) continue
    drawn.push({ x, label: column, cursor })
  }
  if (drawn.length === 0) return

  ctx.save()
  ctx.strokeStyle = theme.cursor
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  for (const { x, label, cursor } of drawn) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, metrics.top)
    ctx.lineTo(x + 0.5, metrics.top + metrics.height)
    ctx.stroke()

    ctx.setLineDash([])
    const y = valueToY(cursor.v, viewport, metrics)
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fillStyle = theme.cursor
    ctx.fill()

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = theme.cursor
    ctx.fillText(label, x, metrics.top - 1)
    ctx.setLineDash([4, 3])
  }
  ctx.restore()
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  metrics: PlotMetrics,
  viewport: Viewport,
  pointer: { x: number; y: number },
  series: Series[],
  visible: ReadonlySet<string>,
  theme: PlotTheme,
): void {
  if (pointer.x < metrics.left || pointer.x > metrics.left + metrics.width) return
  if (pointer.y < metrics.top || pointer.y > metrics.top + metrics.height) return

  ctx.save()
  ctx.strokeStyle = theme.crosshair
  ctx.lineWidth = 1
  ctx.setLineDash([2, 3])
  ctx.beginPath()
  ctx.moveTo(Math.round(pointer.x) + 0.5, metrics.top)
  ctx.lineTo(Math.round(pointer.x) + 0.5, metrics.top + metrics.height)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(metrics.left, Math.round(pointer.y) + 0.5)
  ctx.lineTo(metrics.left + metrics.width, Math.round(pointer.y) + 0.5)
  ctx.stroke()

  // Mark each visible series at the hovered time, so the readout has a
  // visual anchor rather than only a number.
  ctx.setLineDash([])
  const t = xToTime(pointer.x, viewport, metrics)
  const names = series.map(s => s.name)
  for (const entry of series) {
    if (!visible.has(entry.name)) continue
    const value = valueAt(entry, t)
    if (value === undefined) continue
    const y = valueToY(value, viewport, metrics)
    ctx.beginPath()
    ctx.arc(pointer.x, y, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = colorFor(entry.name, names)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * Value of a series at (or immediately before) a timestamp.
 *
 * @returns `undefined` when the series has no point at or before `t`, so the
 *   readout shows a dash instead of the nearest future value.
 */
export function valueAt(series: Series, t: number): number | undefined {
  const { ts, values } = series
  if (ts.length === 0) return undefined
  let low = 0
  let high = ts.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((ts[mid] as number) <= t) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (found < 0) return undefined
  const raw = values[found]
  if (typeof raw === 'boolean') return raw ? 1 : 0
  return typeof raw === 'number' ? raw : undefined
}

/* ─────────────────────────────── measurements ─────────────────────────────── */

/**
 * Measurement across a cursor pair.
 *
 * The value delta is only meaningful for series that have a sample at or before
 * each cursor; series without one are omitted rather than filled in.
 *
 * @returns `undefined` unless both cursors are placed.
 */
export function deltaBetween(
  cursors: CursorState,
  series: readonly Series[],
  visible: ReadonlySet<string>,
): DeltaReadout | undefined {
  const { a, b } = cursors
  if (a === undefined || b === undefined) return undefined
  const deltaTimeMs = Math.abs(b.t - a.t)
  const perSeries: DeltaReadout['perSeries'] = []
  for (const entry of series) {
    if (!visible.has(entry.name)) continue
    const vA = valueAt(entry, a.t)
    const vB = valueAt(entry, b.t)
    if (vA === undefined || vB === undefined) continue
    perSeries.push({ name: entry.name, deltaV: vB - vA, vA, vB })
  }
  return {
    deltaTimeMs,
    // 1/Δt is what a user reads off two cursors on a repeating waveform.
    frequencyHz: deltaTimeMs > 0 ? 1000 / deltaTimeMs : Number.POSITIVE_INFINITY,
    perSeries,
  }
}

export interface Measurements {
  /** Number of samples inside the window. */
  count: number
  min?: number
  max?: number
  peakToPeak?: number
  mean?: number
  /** Estimate from the median rising-edge interval, in Hz. */
  frequencyHz?: number
  /** 10 %→90 % rise time, in the same units as the time axis (ms). */
  riseTimeMs?: number
  /** Sample interval, in ms. */
  periodMs?: number
}

/**
 * Compute the readout for one series over a time window.
 *
 * Every figure is derived from the samples actually inside `[tMin, tMax]`
 * (the cursor pair when both are placed, otherwise the visible window), so the
 * numbers always describe what is on screen.
 *
 * Frequency and rise time examine the series against its own midpoint: that is
 * the standard way to read a waveform with an arbitrary DC offset, and it
 * degrades to "no value" rather than a wrong one when the trace is flat.
 */
export function measure(series: Series, tMin: number, tMax: number): Measurements {
  const { ts, values } = series
  const inside: number[] = []
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as number
    if (t < tMin) continue
    if (t > tMax) break
    const raw = values[i]
    if (typeof raw === 'boolean') inside.push(raw ? 1 : 0)
    else if (typeof raw === 'number' && Number.isFinite(raw)) inside.push(raw)
  }
  if (inside.length === 0) return { count: 0 }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  for (const value of inside) {
    if (value < min) min = value
    if (value > max) max = value
    sum += value
  }
  const result: Measurements = {
    count: inside.length,
    min,
    max,
    peakToPeak: max - min,
    mean: sum / inside.length,
  }

  if (inside.length >= 4) {
    const midpoint = (min + max) / 2
    const span = max - min
    const crossings: number[] = []
    for (let i = 1; i < inside.length; i += 1) {
      const previous = inside[i - 1] as number
      const current = inside[i] as number
      // Rising edge through the midpoint.
      if (previous < midpoint && current >= midpoint) crossings.push(i)
    }
    if (crossings.length >= 2) {
      const intervals: number[] = []
      for (let i = 1; i < crossings.length; i += 1) {
        intervals.push((crossings[i] as number) - (crossings[i - 1] as number))
      }
      intervals.sort((a, b) => a - b)
      const median = intervals[Math.floor(intervals.length / 2)] as number
      if (median > 0) {
        result.periodMs = median
        result.frequencyHz = 1000 / median
      }
    }
    if (span > 0) {
      // 10 %→90 % across each rising edge, then the median.
      const lowGate = min + span * 0.1
      const highGate = min + span * 0.9
      const rises: number[] = []
      let lowAt = -1
      for (let i = 0; i < inside.length; i += 1) {
        const value = inside[i] as number
        if (lowAt < 0 && value <= lowGate) lowAt = i
        else if (lowAt >= 0 && value >= highGate) {
          rises.push(i - lowAt)
          lowAt = -1
        }
      }
      if (rises.length > 0) {
        rises.sort((a, b) => a - b)
        result.riseTimeMs = rises[Math.floor(rises.length / 2)] as number
      }
    }
  }
  return result
}
