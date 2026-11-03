/**
 * The debug panel.
 *
 * Layout is the spec's: waveform on top, RTT log below, a draggable divider
 * between them, and a toolbar per pane. The same component serves both entry
 * points (the native right-sidebar tab and the sidebar workbench), so the two
 * surfaces can never drift apart.
 *
 * React comes from the shell's platform module table, so this file imports it
 * normally and the bundler leaves it external.
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  LiveSocket,
  type FsEntry,
  type OcdVariableView,
  type PluginConfigView,
  type ResolvedBinding,
  type Snapshot,
  type SymbolPreview,
} from './transport.ts'
import {
  MAX_TIME_DIVISIONS,
  MIN_TIME_DIVISIONS,
  colorFor,
  deltaBetween,
  drawPlot,
  formatTime,
  formatValue,
  measure,
  plotMetrics,
  valueAt,
  xToTime,
  yToValue,
} from './plot.ts'
import type { CursorId, CursorState, Viewport } from './plot-types.ts'
import { parseManualBindingDetailed } from '../ocd/binding-parse.ts'
import type { LogRecord } from '../core/types.ts'
import type { Series } from '../core/store.ts'
import type { DebugState } from '../service.ts'
import { t } from './locales.ts'

export interface RttDebugPanelProps {
  /** Session id, so the host can resolve the workspace root. */
  sessionId?: string
}

/** Window presets for the time axis, in minutes (500ms, 1s, 5s, 30s, 1m, 5m, 10m, 30m). */
const WINDOW_PRESETS = [500 / 60_000, 1 / 60, 5 / 60, 0.5, 1, 5, 10, 30] as const

/**
 * Zoom limits, in minutes.
 *
 * The old ceiling of 60 minutes clipped the wheel gesture at an arbitrary
 * point: the series store already retains far more than an hour, so the limit
 * made the last scrolled-to range unreachable rather than protecting anything.
 * The floor used to be 0.05 min (3 s), which is why zooming in "stopped" long
 * before individual samples were visible — at 10 Hz, 3 s is 30 points. It now
 * reaches 0.1 s, so a single sample period fills the pane when needed.
 */
const MIN_WINDOW_MINUTES = 0.1 / 60
const MAX_WINDOW_MINUTES = 24 * 60

/** Time-axis divisions: user-adjustable, defaulting to a scope-like 50. */
const DEFAULT_DIVISIONS = 50

/**
 * Parser ids the editor offers.
 *
 * Mirrors `createDefaultRegistry()` on the host. Kept as a literal here because
 * the client bundle must not import host modules (they reach `node:` builtins),
 * and a wrong id would fail loudly at save time rather than silently.
 */
const PARSER_IDS = ['csv', 'keyvalue', 'binary-frame', 'custom-regex', 'script'] as const

function formatWindowPreset(minutes: number): string {
  const ms = Math.round(minutes * 60_000)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${minutes}m`
}

/** Pointer distance, in px, within which a click grabs an existing cursor. */
const CURSOR_GRAB_PX = 6

export function RttDebugPanel(props: RttDebugPanelProps): ReactNode {
  const { sessionId } = props

  const [state, setState] = useState<DebugState | undefined>(undefined)
  const [series, setSeries] = useState<Series[]>([])
  const [log, setLog] = useState<LogRecord[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [timeOffsetMs, setTimeOffsetMs] = useState<number>(0)
  const panRef = useRef<{ startX: number; startTimeOffset: number; active: boolean } | null>(null)
  const [logsConnected, setLogsConnected] = useState(false)
  const [seriesConnected, setSeriesConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const visible = useMemo(() => {
    const set = new Set<string>()
    for (const s of series) {
      if (!hidden.has(s.name)) set.add(s.name)
    }
    return set
  }, [series, hidden])

  /* pane sizing */
  const [splitRatio, setSplitRatio] = useState(0.58)
  const containerRef = useRef<HTMLDivElement | null>(null)

  /* ruler */
  const [cursors, setCursors] = useState<CursorState>({ enabled: false })
  const [windowMinutes, setWindowMinutes] = useState(1)
  const [autoScale, setAutoScale] = useState(true)
  /** Time-axis divisions — user-adjustable, 50 by default. */
  const [timeDivisions, setTimeDivisions] = useState<number>(DEFAULT_DIVISIONS)

  /* log view */
  const [filter, setFilter] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [follow, setFollow] = useState(true)
  const logRef = useRef<HTMLDivElement | null>(null)

  /* ─────────────────────────── initial snapshot ─────────────────────────── */

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    setState(snapshot.state)
    setSeries(snapshot.series)
    setLog(snapshot.log)
    setLogTotal(snapshot.total)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await api.snapshot(sessionId)
        if (!cancelled) applySnapshot(snapshot)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, applySnapshot])

  /* ───────────────────────────── live sockets ───────────────────────────── */

  useEffect(() => {
    const logSocket = new LiveSocket('/ws/log', sessionId, payload => {
      const message = payload as { type?: string; what?: string; records?: LogRecord[]; state?: DebugState }
      if (message.type === 'clear') {
        if (message.what === 'log' || message.what === 'all') {
          setLog([])
          setLogTotal(0)
        }
      } else if (message.type === 'log' && Array.isArray(message.records)) {
        setLog(previous => {
          const next = previous.concat(message.records as LogRecord[])
          // Mirror the host ring so a long session cannot grow the tab's memory.
          const cap = message.state?.log ? 0 : 0
          void cap
          return next.length > 20_000 ? next.slice(next.length - 20_000) : next
        })
        setLogTotal(previous => previous + (message.records?.length ?? 0))
      } else if (message.type === 'state' && message.state !== undefined) {
        setState(message.state)
      }
    }, setLogsConnected)

    const seriesSocket = new LiveSocket('/ws/series', sessionId, payload => {
      const message = payload as { type?: string; what?: string; samples?: { ts: number; values: Record<string, number | boolean> }[]; state?: DebugState }
      if (message.type === 'clear') {
        if (message.what === 'series' || message.what === 'all') {
          setSeries([])
          setTimeOffsetMs(0)
        }
      } else if (message.type === 'series' && Array.isArray(message.samples)) {
        setSeries(previous => mergeSamples(previous, message.samples as { ts: number; values: Record<string, number | boolean> }[]))
      } else if (message.type === 'state' && message.state !== undefined) {
        setState(message.state)
      }
    }, setSeriesConnected)

    return () => {
      logSocket.close()
      seriesSocket.close()
    }
  }, [sessionId])

  /* ────────────────────────────── commands ─────────────────────────────── */

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  const running = state?.openocd.kind === 'running' || state?.openocd.kind === 'attached'

  /* ────────────────────────────── filtering ────────────────────────────── */

  const filteredLog = useMemo(() => filterLog(log, filter, useRegex), [log, filter, useRegex])

  /* ───────────────────────────── follow behaviour ──────────────────────── */

  useEffect(() => {
    if (!follow) return
    const node = logRef.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
  }, [filteredLog, follow])

  /* ─────────────────────────────── plotting ────────────────────────────── */

  const viewport = useMemo<Viewport>(() => {
    const now = Date.now()
    const latestSampleTime = series.reduce((latest, entry) => {
      const last = entry.ts[entry.ts.length - 1]
      return typeof last === 'number' && last > latest ? last : latest
    }, now)
    const tMax = latestSampleTime - timeOffsetMs
    const tMin = tMax - windowMinutes * 60_000

    let vMin = Number.POSITIVE_INFINITY
    let vMax = Number.NEGATIVE_INFINITY
    for (const entry of series) {
      if (!visible.has(entry.name)) continue
      for (let i = entry.ts.length - 1; i >= 0; i -= 1) {
        const ts = entry.ts[i] as number
        if (ts < tMin) break
        if (ts > tMax) continue
        const raw = entry.values[i]
        const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        if (value < vMin) vMin = value
        if (value > vMax) vMax = value
      }
    }
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
      vMin = 0
      vMax = 1
    }
    if (vMax - vMin < 1e-12) {
      // A flat trace needs a synthetic band, or it would sit on an axis edge.
      const pad = Math.abs(vMax) > 1e-12 ? Math.abs(vMax) * 0.1 : 1
      vMin -= pad
      vMax += pad
    } else {
      const pad = (vMax - vMin) * 0.08
      vMin -= pad
      vMax += pad
    }
    return { tMin, tMax, vMin, vMax }
  }, [series, visible, windowMinutes, timeOffsetMs])

  /* ──────────────────────────── canvas plumbing ────────────────────────── */

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number } | undefined>(undefined)
  const [hoverTime, setHoverTime] = useState<number | undefined>(undefined)

  /* theme tracking: re-render canvas when light/dark theme switches */
  const [themeVersion, setThemeVersion] = useState(0)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const observer = new MutationObserver(() => {
      setThemeVersion(v => v + 1)
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'data-theme'] })
    if (document.documentElement) {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    }
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const parent = canvas.parentElement
    if (parent === null) return

    const render = (): void => {
      const rect = parent.getBoundingClientRect()
      const width = Math.max(80, Math.floor(rect.width))
      const height = Math.max(80, Math.floor(rect.height))
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
      }
      const ctx = canvas.getContext('2d')
      if (ctx === null) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawPlot({
        ctx,
        width,
        height,
        viewport,
        series,
        visible,
        cursors,
        timeDivisions,
        ...(pointer === undefined ? {} : { pointer }),
      })
    }

    render()
    const observer = new ResizeObserver(render)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [viewport, series, visible, cursors, pointer, themeVersion, timeDivisions])

  /* ──────────────────────────── cursor interaction ─────────────────────── */

  const metrics = useMemo(() => {
    const rect = canvasRef.current?.parentElement?.getBoundingClientRect()
    return plotMetrics(rect?.width ?? 600, rect?.height ?? 240)
  }, [canvasRef.current?.parentElement?.getBoundingClientRect().width, series])

  const pointerToPlot = useCallback((event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  /** Series value under a pixel position, for placing a cursor. */
  const valueUnderPointer = useCallback((x: number, y: number): { t: number; v: number } => {
    const time = xToTime(x, viewport, metrics)
    // Prefer the first visible series that has a sample there; otherwise fall
    // back to the pointer's own y, so a cursor can still be placed on a gap.
    for (const entry of series) {
      if (!visible.has(entry.name)) continue
      const value = valueAt(entry, time)
      if (value !== undefined) return { t: time, v: value }
    }
    return { t: time, v: yToValue(y, viewport, metrics) }
  }, [viewport, metrics, series, visible])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = pointerToPlot(event)
    if (cursors.enabled) {
      // Grab an existing cursor when the click lands near it, else place one.
      for (const id of ['a', 'b'] as CursorId[]) {
        const existing = id === 'a' ? cursors.a : cursors.b
        if (existing === undefined) continue
        const cursorX = metrics.left + ((existing.t - viewport.tMin) / Math.max(1, viewport.tMax - viewport.tMin)) * metrics.width
        if (Math.abs(cursorX - x) <= CURSOR_GRAB_PX) {
          setCursors(previous => ({ ...previous, dragging: id }))
          event.currentTarget.setPointerCapture(event.pointerId)
          return
        }
      }
      const point = valueUnderPointer(x, y)
      const target: CursorId = cursors.a === undefined ? 'a' : cursors.b === undefined ? 'b' : 'a'
      setCursors(previous => ({
        ...previous,
        [target]: point,
        dragging: target,
      }))
      event.currentTarget.setPointerCapture(event.pointerId)
    } else {
      panRef.current = { startX: event.clientX, startTimeOffset: timeOffsetMs, active: true }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }, [cursors, metrics, viewport, pointerToPlot, valueUnderPointer, timeOffsetMs])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = pointerToPlot(event)
    setPointer({ x, y })
    setHoverTime(xToTime(x, viewport, metrics))
    if (cursors.dragging !== undefined) {
      const point = valueUnderPointer(x, y)
      setCursors(previous => ({ ...previous, [previous.dragging as CursorId]: point }))
    } else if (panRef.current?.active) {
      const dx = event.clientX - panRef.current.startX
      const msPerPixel = (viewport.tMax - viewport.tMin) / Math.max(1, metrics.width)
      const dt = dx * msPerPixel
      // Dragging right moves view into the past (increases offset); left moves towards live
      const nextOffset = Math.max(0, panRef.current.startTimeOffset + dt)
      setTimeOffsetMs(nextOffset)
    }
  }, [cursors.dragging, pointerToPlot, viewport, metrics, valueUnderPointer])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.active) {
      panRef.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {}
    }
    setCursors(previous => ({ ...previous, dragging: undefined }))
  }, [])

  const onWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 1.25 : 0.8
    setWindowMinutes(prev => {
      const next = prev * factor
      return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.round(next * 10_000) / 10_000))
    })
  }, [])

  /* ───────────────────────────── split dragging ────────────────────────── */

  const onSplitPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const move = (moveEvent: PointerEvent): void => {
      const ratio = (moveEvent.clientY - rect.top) / rect.height
      setSplitRatio(Math.min(0.85, Math.max(0.15, ratio)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    event.preventDefault()
  }, [])

  /* ─────────────────────────────── readouts ───────────────────────────── */

  const delta = useMemo(() => deltaBetween(cursors, series, visible), [cursors, series, visible])

  const measurements = useMemo(() => {
    const tMin = cursors.a !== undefined && cursors.b !== undefined
      ? Math.min(cursors.a.t, cursors.b.t)
      : viewport.tMin
    const tMax = cursors.a !== undefined && cursors.b !== undefined
      ? Math.max(cursors.a.t, cursors.b.t)
      : viewport.tMax
    return series
      .filter(entry => visible.has(entry.name))
      .map(entry => ({ name: entry.name, unit: entry.unit, result: measure(entry, tMin, tMax) }))
  }, [series, visible, cursors, viewport])

  /* ───────────────────────────────── render ───────────────────────────── */

  const visibleNames = series.filter(entry => visible.has(entry.name)).map(entry => entry.name)
  const allNames = series.map(entry => entry.name)

  return createElement(
    'div',
    { className: 'rttd-root' },
    createElement(Toolbar, {
      state,
      busy,
      running,
      error,
      logsConnected,
      seriesConnected,
      onStart: () => void run(async () => { await api.start(sessionId); applySnapshot(await api.snapshot(sessionId)) }),
      onStop: () => void run(async () => { await api.stop(sessionId); applySnapshot(await api.snapshot(sessionId)) }),
      onClearAll: () => void run(async () => {
        setSeries([])
        setLog([])
        setLogTotal(0)
        setTimeOffsetMs(0)
        await api.clear('all', sessionId)
      }),
    }),
    state?.openocd.kind === 'error'
      ? createElement(
        'div',
        {
          className: 'rttd-alert rttd-alert-error',
          style: {
            padding: '4px 10px',
            background: 'rgba(255, 107, 107, 0.15)',
            borderBottom: '1px solid rgba(255, 107, 107, 0.35)',
            color: '#ff6b6b',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            lineHeight: '1.4',
            flex: '0 0 auto',
          },
        },
        createElement('span', { style: { fontWeight: 600 } },
          state.driver === 'jlink' ? '⚠️ J-Link:' : '⚠️ OpenOCD:'),
        createElement('span', null, state.openocd.message),
        state.openocd.message.includes('config file')
          ? createElement('span', { style: { opacity: 0.9, marginLeft: '4px' } }, t('status.notReadyPrompt'))
          : null,
      )
      : null,
    /* A J-Link limitation observed at runtime (multi-channel TELNET): the panel
       states it plainly rather than leaving a silently empty chart. */
    state?.jlinkNotice === undefined
      ? null
      : createElement(
        'div',
        {
          className: 'rttd-alert rttd-alert-warn',
          style: {
            padding: '4px 10px',
            background: 'rgba(255, 169, 77, 0.15)',
            borderBottom: '1px solid rgba(255, 169, 77, 0.35)',
            color: '#ffa94d',
            fontSize: '11px',
            lineHeight: '1.4',
            flex: '0 0 auto',
          },
        },
        createElement('span', { style: { fontWeight: 600 } }, '⚠️ '),
        createElement('span', null, state.jlinkNotice),
      ),
    createElement(
      'div',
      { className: 'rttd-split', ref: containerRef },
      createElement(
        'div',
        { className: 'rttd-pane rttd-pane-plot', style: { flexBasis: `${splitRatio * 100}%` } },
        createElement(WaveToolbar, {
          sessionId,
          state,
          windowMinutes,
          setWindowMinutes,
          timeDivisions,
          setTimeDivisions,
          cursorsEnabled: cursors.enabled,
          onToggleCursors: () => setCursors(previous => previous.enabled
            ? { enabled: false }
            : { enabled: true, a: previous.a, b: previous.b }),
          onClearCursors: () => setCursors(previous => ({ enabled: previous.enabled })),
          autoScale,
          setAutoScale,
          onClearSeries: () => void run(async () => {
            setSeries([])
            setTimeOffsetMs(0)
            await api.clear('series', sessionId)
          }),
          visibleNames,
          allNames,
          series,
          timeOffsetMs,
          onResetTimeOffset: () => setTimeOffsetMs(0),
          onToggleSeries: (name: string) => setHidden(previous => {
            const next = new Set(previous)
            if (next.has(name)) next.delete(name)
            else next.add(name)
            return next
          }),
        }),
        createElement(
          'div',
          { className: 'rttd-canvas-wrap' },
          createElement('canvas', {
            ref: canvasRef,
            className: 'rttd-canvas',
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onWheel,
            onDoubleClick: () => setTimeOffsetMs(0),
            onPointerLeave: () => {
              setPointer(undefined)
              setHoverTime(undefined)
            },
          }),
          series.length === 0
            ? createElement('div', { className: 'rttd-empty' }, t('plot.empty'))
            : null,
        ),
        createElement(ReadoutStrip, { measurements, delta, hoverTime, pointer, series, visible, viewport, metrics }),
      ),
      createElement('div', {
        className: 'rttd-divider',
        onPointerDown: onSplitPointerDown,
        role: 'separator',
        'aria-orientation': 'horizontal',
      }),
      createElement(
        'div',
        { className: 'rttd-pane rttd-pane-log' },
        createElement(LogToolbar, {
          filter,
          setFilter,
          useRegex,
          setUseRegex,
          follow,
          setFollow,
          retained: log.length,
          total: logTotal,
          onExport: () => {
            // Keep the existing query string so the host resolves the session.
            window.open(api.exportUrl(sessionId), '_blank')
          },
          onClearLog: () => void run(async () => {
            setLog([])
            setLogTotal(0)
            await api.clear('log', sessionId)
          }),
        }),
        createElement(LogList, { records: filteredLog, follow, logRef }),
      ),
    ),
  )
}

/* ────────────────────────────── sub-components ────────────────────────────── */

interface ToolbarProps {
  state: DebugState | undefined
  busy: boolean
  running: boolean
  error: string | undefined
  logsConnected: boolean
  seriesConnected: boolean
  onStart: () => void
  onStop: () => void
  onClearAll: () => void
}

function Toolbar(props: ToolbarProps): ReactNode {
  const { state, busy, running, error, logsConnected, seriesConnected } = props
  const backend = state?.openocd
  const backendName = state?.driver === 'jlink' ? 'J-Link' : 'OpenOCD'
  const statusText = backend === undefined
    ? t('status.loading')
    : backend.kind === 'running'
      ? t('status.running', { pid: backend.pid ?? '—', backend: backendName })
      : backend.kind === 'attached'
        ? t('status.attached', { backend: backendName })
        : backend.kind === 'error'
          ? t('status.error', { message: backend.message })
          : backend.kind === 'idle'
            ? t('status.idle')
            : backend.kind === 'probing'
              ? t('status.probing')
              : backend.kind === 'starting'
                ? t('status.starting')
                : '—'

  return createElement(
    'div',
    { className: 'rttd-toolbar' },
    createElement('span', { className: `rttd-status rttd-status-${backend?.kind ?? 'idle'}` }, statusText),
    createElement('span', { className: 'rttd-spacer' }),
    createElement(SourceChip, {
      key: 'log',
      source: state?.sources[0],
      label: t('source.log'),
      connected: logsConnected,
    }),
    createElement(SourceChip, {
      key: 'rttVar',
      source: state?.sources[1],
      label: t('source.rttVar'),
      connected: seriesConnected,
    }),
    createElement(SourceChip, {
      key: 'ocd',
      source: state?.sources[2],
      label: t('source.ocd'),
      connected: undefined,
    }),
    createElement('span', { className: 'rttd-spacer' }),
    createElement('button', {
      className: 'rttd-btn',
      disabled: busy || running,
      onClick: props.onStart,
      type: 'button',
    }, running ? t('btn.running') : t('btn.start')),
    createElement('button', {
      className: 'rttd-btn',
      disabled: busy || !running,
      onClick: props.onStop,
      type: 'button',
    }, t('btn.stop')),
    createElement('button', {
      className: 'rttd-btn',
      disabled: busy,
      onClick: props.onClearAll,
      type: 'button',
    }, t('btn.clearAll')),
    error === undefined ? null : createElement('span', { className: 'rttd-error', title: error }, error),
  )
}

/**
 * One source's live-status pill.
 *
 * A component (not a plain helper) so React reconciles it by position: the
 * three chips sit in a fixed order and must not be re-created on every render.
 */
function SourceChip(props: {
  source: { id: string; enabled: boolean; state: string; received: number; detail?: string } | undefined
  label: string
  connected: boolean | undefined
}): ReactNode {
  const { source, label, connected } = props
  const state = source?.state ?? 'idle'
  const on = connected ?? (state === 'open' || state === 'running')
  const title = source === undefined
    ? label
    : `${label}: ${state}${source.detail === undefined ? '' : ` — ${source.detail}`} (${source.received})`
  return createElement(
    'span',
    { className: `rttd-chip${on ? ' rttd-chip-on' : ''}${source?.enabled === false ? ' rttd-chip-off' : ''}`, title },
    createElement('span', { className: 'rttd-dot' }),
    label,
  )
}

interface WaveToolbarProps {
  sessionId: string | undefined
  state: DebugState | undefined
  windowMinutes: number
  setWindowMinutes: (value: number) => void
  /** Time-axis divisions (grid columns); defaults to 50. */
  timeDivisions: number
  setTimeDivisions: (value: number) => void
  cursorsEnabled: boolean
  onToggleCursors: () => void
  onClearCursors: () => void
  autoScale: boolean
  setAutoScale: (value: boolean) => void
  onClearSeries: () => void
  visibleNames: string[]
  allNames: string[]
  series: Series[]
  timeOffsetMs?: number
  onResetTimeOffset?: () => void
  onToggleSeries: (name: string) => void
}

function WaveToolbar(props: WaveToolbarProps): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [divInput, setDivInput] = useState<string>(String(props.timeDivisions))
  useEffect(() => { setDivInput(String(props.timeDivisions)) }, [props.timeDivisions])

  const commitDivisions = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) {
      setDivInput(String(props.timeDivisions))
      return
    }
    const clamped = Math.min(MAX_TIME_DIVISIONS, Math.max(MIN_TIME_DIVISIONS, parsed))
    props.setTimeDivisions(clamped)
    setDivInput(String(clamped))
  }

  return createElement(
    'div',
    { className: 'rttd-toolbar rttd-toolbar-sub' },
    createElement('span', { className: 'rttd-label' }, t('wave.window')),
    ...WINDOW_PRESETS.map(minutes => createElement('button', {
      key: minutes,
      type: 'button',
      className: `rttd-btn rttd-btn-sm${props.windowMinutes === minutes ? ' rttd-btn-active' : ''}`,
      onClick: () => props.setWindowMinutes(minutes),
    }, formatWindowPreset(minutes))),
    /* divisions: how many columns the time axis is split into */
    createElement('span', { className: 'rttd-label', title: t('wave.divisionsHint') }, t('wave.divisions')),
    createElement('input', {
      className: 'rttd-sources-input rttd-sources-input-sm rttd-divisions-input',
      type: 'number',
      min: String(MIN_TIME_DIVISIONS),
      max: String(MAX_TIME_DIVISIONS),
      step: '1',
      value: divInput,
      title: t('wave.divisionsHint'),
      onChange: event => setDivInput((event.target as HTMLInputElement).value),
      onBlur: event => commitDivisions((event.target as HTMLInputElement).value),
      onKeyDown: event => {
        if ((event as unknown as KeyboardEvent).key === 'Enter') commitDivisions((event.target as HTMLInputElement).value)
      },
    }),
    props.windowMinutes !== 1
      ? createElement('button', {
        type: 'button',
        className: 'rttd-btn rttd-btn-sm',
        title: t('wave.resetWindow'),
        onClick: () => props.setWindowMinutes(1),
      }, '1m')
      : null,
    props.timeOffsetMs && props.timeOffsetMs > 0
      ? createElement('button', {
        type: 'button',
        className: 'rttd-jump-live',
        onClick: props.onResetTimeOffset,
        title: t('sources.jumpLive'),
      }, '⏩ ' + t('sources.jumpLive'))
      : null,
    createElement('span', { className: 'rttd-spacer' }),
    createElement('button', {
      type: 'button',
      className: `rttd-btn rttd-btn-sm${props.cursorsEnabled ? ' rttd-btn-active' : ''}`,
      onClick: props.onToggleCursors,
      title: t('wave.cursorHint'),
    }, t('wave.cursor')),
    createElement('button', {
      type: 'button',
      className: 'rttd-btn rttd-btn-sm',
      onClick: props.onClearCursors,
      disabled: !props.cursorsEnabled,
    }, t('wave.cursorClear')),
    createElement('button', {
      type: 'button',
      className: `rttd-btn rttd-btn-sm${props.autoScale ? ' rttd-btn-active' : ''}`,
      onClick: () => props.setAutoScale(!props.autoScale),
    }, t('wave.autoscale')),
    createElement('span', { className: 'rttd-spacer' }),
    createElement('div', { className: 'rttd-legend' }, ...props.allNames.map(name => {
      const isVisible = props.visibleNames.includes(name)
      return createElement('button', {
        key: name,
        type: 'button',
        className: `rttd-legend-item${isVisible ? ' rttd-legend-on' : ' rttd-legend-off'}`,
        style: {
          borderColor: colorFor(name, props.allNames),
          opacity: isVisible ? 1 : 0.45,
          textDecoration: isVisible ? 'none' : 'line-through',
        },
        onClick: () => props.onToggleSeries(name),
        title: t('wave.toggleSeries', { name }),
      }, createElement('span', { className: 'rttd-swatch', style: { background: isVisible ? colorFor(name, props.allNames) : '#555' } }), name)
    })),
    createElement('button', {
      type: 'button',
      className: 'rttd-btn rttd-btn-sm',
      onClick: () => setPickerOpen(value => !value),
      disabled: props.allNames.length === 0,
    }, t('wave.pick', { count: props.visibleNames.length, total: props.allNames.length })),
    pickerOpen
      ? createElement(
        'div',
        { className: 'rttd-picker' },
        ...props.allNames.map(name => createElement('label', { key: name, className: 'rttd-picker-row' },
          createElement('input', {
            type: 'checkbox',
            checked: props.visibleNames.includes(name),
            onChange: () => props.onToggleSeries(name),
          }),
          name,
        )),
      )
      : null,
    createElement(VariableSources, {
      sessionId: props.sessionId,
      state: props.state,
    }),
    createElement('button', {
      type: 'button',
      className: 'rttd-btn rttd-btn-sm',
      onClick: props.onClearSeries,
    }, t('btn.clear')),
  )
}

/* ────────────────────────────── variable sources ─────────────────────────────── */

/** `0x…` hex, padded to 8 digits — the address format the table uses everywhere. */
function hexAddress(value: number | undefined): string {
  return value === undefined ? '—' : `0x${(value >>> 0).toString(16).padStart(8, '0')}`
}

/* ────────────────────────────── file picker modal ───────────────────────────── */

interface FilePickerModalProps {
  open: boolean
  targetField: 'configPath' | 'elfPath' | 'jlinkExe' | 'openocdExe'
  sessionId?: string
  onSelect: (path: string) => void
  onClose: () => void
}

function FilePickerModal(props: FilePickerModalProps): ReactNode {
  const { open, targetField, sessionId, onSelect, onClose } = props
  const [loading, setLoading] = useState(false)
  const [currentDir, setCurrentDir] = useState('')
  const [displayDir, setDisplayDir] = useState('.')
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [discovered, setDiscovered] = useState<{ path: string; relPath: string; name: string }[]>([])
  const [filter, setFilter] = useState('')

  // A program is a binary, not a config or an ELF, so the picker greys out
  // everything else and offers no discovery suggestions.
  const ext = targetField === 'configPath'
    ? '.cfg'
    : targetField === 'jlinkExe' || targetField === 'openocdExe'
      ? '.exe'
      : '.elf,.axf,.out'

  const loadDir = useCallback(async (dir: string) => {
    setLoading(true)
    try {
      const data = await api.listFiles(dir, ext, sessionId)
      setCurrentDir(data.currentDir)
      setDisplayDir(data.displayDir)
      setParentDir(data.parentDir)
      setEntries(data.entries)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [ext, sessionId])

  useEffect(() => {
    if (!open) return
    void loadDir('')
    // Discovery knows two shapes only (an OpenOCD config or a firmware ELF);
    // a program path is picked from the browser instead of being guessed, so no
    // suggestions are requested for it.
    if (targetField === 'jlinkExe' || targetField === 'openocdExe') {
      setDiscovered([])
      return
    }
    void (async () => {
      try {
        const disc = await api.discoverFiles(targetField === 'configPath' ? 'openocd' : 'elf', sessionId)
        setDiscovered(disc.files)
      } catch {}
    })()
  }, [open, targetField, sessionId, loadDir])

  if (!open) return null

  const filteredEntries = entries.filter(e => filter === '' || e.name.toLowerCase().includes(filter.toLowerCase()))

  return createElement(
    'div',
    {
      className: 'rttd-fp-modal',
      onClick: (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose()
      },
    },
    createElement(
      'div',
      { className: 'rttd-fp-container' },
      createElement(
        'div',
        { className: 'rttd-fp-header' },
        createElement('span', null,
          targetField === 'configPath'
            ? t('sources.pickerTitleCfg')
            : targetField === 'jlinkExe'
              ? t('driver.jlinkExecutable')
              : targetField === 'openocdExe'
                ? t('driver.openocdExecutable')
                : t('sources.pickerTitleElf')),
        createElement('button', {
          type: 'button',
          className: 'rttd-btn rttd-btn-sm',
          onClick: onClose,
          style: { padding: '0 6px', lineHeight: '18px' },
        }, '✕'),
      ),
      discovered.length === 0 ? null : createElement(
        'div',
        { className: 'rttd-fp-candidates' },
        createElement('div', { className: 'rttd-fp-candidates-title' }, t('sources.quickCandidates')),
        createElement(
          'div',
          { className: 'rttd-fp-candidates-list' },
          ...discovered.map(cand => createElement('button', {
            key: cand.path,
            type: 'button',
            className: 'rttd-fp-chip',
            title: cand.path,
            onClick: () => {
              onSelect(cand.relPath || cand.path)
              onClose()
            },
          }, cand.relPath || cand.name)),
        ),
      ),
      createElement(
        'div',
        { className: 'rttd-fp-nav' },
        createElement('button', {
          type: 'button',
          className: 'rttd-btn rttd-btn-sm',
          disabled: parentDir === null || loading,
          onClick: () => { if (parentDir !== null) void loadDir(parentDir) },
        }, '⬆ ' + t('sources.parentDir')),
        createElement('div', { className: 'rttd-fp-path', title: currentDir }, '📁 ' + displayDir),
        createElement('input', {
          className: 'rttd-sources-input',
          style: { width: '130px', padding: '1px 5px', fontSize: '11px' },
          placeholder: t('sources.filterFile'),
          value: filter,
          onChange: e => setFilter((e.target as HTMLInputElement).value),
        }),
      ),
      createElement(
        'div',
        { className: 'rttd-fp-list' },
        loading
          ? createElement('div', { style: { padding: '12px', textAlign: 'center', opacity: 0.6 } }, t('status.loading'))
          : filteredEntries.length === 0
            ? createElement('div', { style: { padding: '12px', textAlign: 'center', opacity: 0.5 } }, t('sources.emptyDir'))
            : filteredEntries.map(item => createElement(
              'div',
              {
                key: item.path,
                className: `rttd-fp-item ${item.isDirectory ? 'rttd-fp-item-dir' : 'rttd-fp-item-file'}`,
                onClick: () => {
                  if (item.isDirectory) {
                    void loadDir(item.path)
                  } else {
                    const chosen = displayDir === '.' ? item.name : `${displayDir}/${item.name}`.replace(/^\.\//, '')
                    onSelect(chosen)
                    onClose()
                  }
                },
              },
              createElement('span', null, `${item.isDirectory ? '📁 ' : '📄 '}${item.name}`),
              item.isDirectory ? null : createElement('span', { style: { opacity: 0.5, fontSize: '11px' } }, item.size ? `${(item.size / 1024).toFixed(1)} KB` : ''),
            )),
      ),
      createElement(
        'div',
        { className: 'rttd-fp-footer' },
        createElement('button', {
          type: 'button',
          className: 'rttd-btn rttd-btn-sm',
          onClick: onClose,
        }, t('btn.close')),
      ),
    ),
  )
}

interface VariableSourcesProps {
  sessionId: string | undefined
  /** Live host state; zone A reads `descriptors` and `series.names` from it. */
  state: DebugState | undefined
}

/**
 * The variable-sources seat.
 *
 * Two zones, deliberately asymmetric:
 *
 *   A. the RTT data channel is READ-ONLY — it reports what the parser found, and
 *      nothing here writes to it (that channel is configured by firmware, not by
 *      the panel);
 *   B. OCD direct reads are editable and save into the active device profile, so
 *      the host's next poll cycle samples what the user picked here.
 *
 * The config is read through `api.getConfig()` rather than any cached default:
 * `DebugState` carries live status, not profile settings, and seeding an editor
 * from hard-coded defaults would silently overwrite a user's real profile.
 */
function VariableSources(props: VariableSourcesProps): ReactNode {
  const { sessionId, state } = props
  const [open, setOpen] = useState(false)

  /* config (loaded on first open) */
  const [config, setConfig] = useState<PluginConfigView | undefined>(undefined)
  const [configError, setConfigError] = useState<string | undefined>(undefined)

  /* editable fields, seeded from the loaded config */
  const [enabled, setEnabled] = useState(false)
  /** Which backend performs the memory reads (the tab in this drawer). */
  const [driver, setDriver] = useState<'openocd' | 'jlink'>('openocd')
  const [configPath, setConfigPath] = useState('')
  /**
   * Machine-wide tool locations.
   *
   * These three are stored in the GLOBAL layer, not the workspace file: where a
   * program is installed is a fact about this computer, so repeating it per
   * project — or committing it to a repo — is wrong. The panel shows them
   * together with the project settings because that is where the user looks.
   */
  const [openocdExe, setOpenocdExe] = useState('openocd')
  const [elfPath, setElfPath] = useState('')
  const [nmPath, setNmPath] = useState('arm-none-eabi-nm')
  const [intervalText, setIntervalText] = useState('100')
  const [intervalMode, setIntervalMode] = useState<'ms' | 'hz'>('ms')
  const [pickerTarget, setPickerTarget] = useState<'configPath' | 'elfPath' | 'jlinkExe' | 'openocdExe' | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<'workspace' | 'global' | undefined>(undefined)

  /* J-Link fields */
  const [jlinkExe, setJlinkExe] = useState('')
  const [jlinkDevice, setJlinkDevice] = useState('')
  const [jlinkInterface, setJlinkInterface] = useState<'SWD' | 'JTAG'>('SWD')
  const [jlinkSpeed, setJlinkSpeed] = useState('0')
  const [jlinkGdbPort, setJlinkGdbPort] = useState('2331')
  const [jlinkTelnetPort, setJlinkTelnetPort] = useState('19021')
  const [jlinkSerial, setJlinkSerial] = useState('')
  const [jlinkAutoStart, setJlinkAutoStart] = useState(true)

  /* parser editing (RTT data channel) */
  const [parserId, setParserId] = useState('csv')
  const [parserDelimiter, setParserDelimiter] = useState(',')
  const [parserTerminator, setParserTerminator] = useState('\\n')
  const [parserExpression, setParserExpression] = useState('')
  const [parserPattern, setParserPattern] = useState('')
  const [parserFlags, setParserFlags] = useState('')
  const [parserSkipFirst, setParserSkipFirst] = useState(false)
  const [parserError, setParserError] = useState<string | undefined>(undefined)

  /* symbol browser */
  const [filter, setFilter] = useState('')
  const [symbols, setSymbols] = useState<SymbolPreview[] | undefined>(undefined)
  const [browsing, setBrowsing] = useState(false)
  const [picked, setPicked] = useState<Record<string, { name: string; address: number; type: string; size: number }>>({})

  /* manual entry + the configured list */
  const [manual, setManual] = useState('')
  const [manualUnit, setManualUnit] = useState('')
  const [manualBad, setManualBad] = useState<{ reason: 'empty' | 'unparsable' | 'unknown-type'; spelling?: string } | undefined>(undefined)
  const [rows, setRows] = useState<OcdVariableView[]>([])

  /* save feedback */
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([])

  const activeProfile = useMemo(() => {
    if (config === undefined) return undefined
    return config.profiles.find(entry => entry.id === config.activeProfile) ?? config.profiles[0]
  }, [config])

  /**
   * Build the parser option block for the SELECTED parser only.
   *
   * Sending every field unconditionally would leave a `csv` parser carrying a
   * stale `expression`, and a later switch to `script` would silently inherit
   * one the user had forgotten about. Options are therefore scoped by `id`.
   */
  const buildParserOptions = useCallback((): Record<string, unknown> => {
    const options: Record<string, unknown> = {}
    const terminator = parserTerminator.trim()
    if (terminator !== '' && terminator !== '\\n') options['lineTerminator'] = terminator
    if (parserId === 'csv') {
      if (parserDelimiter !== '') options['delimiter'] = parserDelimiter
    } else if (parserId === 'keyvalue' || parserId === 'script') {
      if (parserDelimiter !== '') options['delimiter'] = parserDelimiter
    }
    if (parserId === 'script') {
      options['expression'] = parserExpression
      options['skipFirstLine'] = parserSkipFirst
    }
    if (parserId === 'custom-regex') {
      if (parserPattern !== '') options['pattern'] = parserPattern
      if (parserFlags !== '') options['flags'] = parserFlags
    }
    return options
  }, [parserId, parserDelimiter, parserTerminator, parserExpression, parserPattern, parserFlags, parserSkipFirst])

  /** Syntax-check the expression locally so a typo is caught before saving. */
  useEffect(() => {
    if (parserId !== 'script') {
      setParserError(undefined)
      return
    }
    if (parserExpression.trim() === '') {
      setParserError(t('sources.parserError', { message: 'expression is empty' }))
      return
    }
    try {
      // The browser check is a smoke test only — the host compiles with its own
      // sandbox and remains the authority.
      void new Function('fields', 'line', 'index', 'Number', 'Math', `"use strict"; return (${parserExpression});`)
      setParserError(undefined)
    } catch (caught) {
      setParserError(t('sources.parserError', { message: caught instanceof Error ? caught.message : String(caught) }))
    }
  }, [parserId, parserExpression])

  const applyConfig = useCallback((loaded: PluginConfigView) => {
    setConfig(loaded)
    const profile = loaded.profiles.find(entry => entry.id === loaded.activeProfile) ?? loaded.profiles[0]
    const ocd = profile?.ocd
    setEnabled(ocd?.enabled === true)
    // A profile written before the J-Link backend existed has no `driver`, and
    // it was an OpenOCD profile — so the absent value means `openocd`, not a
    // fresh default that might silently switch the user's backend.
    setDriver(profile?.driver === 'jlink' ? 'jlink' : 'openocd')
    setConfigPath(profile?.openocd?.configPath ?? '')
    setOpenocdExe(profile?.openocd?.executable ?? 'openocd')
    const jlink = profile?.jlink
    setJlinkExe(jlink?.executable ?? '')
    setJlinkDevice(jlink?.device ?? '')
    setJlinkInterface(jlink?.targetInterface === 'JTAG' ? 'JTAG' : 'SWD')
    setJlinkSpeed(String(jlink?.speedKhz ?? 0))
    setJlinkGdbPort(String(jlink?.gdbPort ?? 2331))
    setJlinkTelnetPort(String(jlink?.rttTelnetPort ?? 19021))
    setJlinkSerial(jlink?.serial ?? '')
    setJlinkAutoStart(jlink?.autoStart !== false)
    setElfPath(ocd?.elfPath ?? '')
    setNmPath(ocd?.nmPath ?? 'arm-none-eabi-nm')
    // Parser settings: seed from the profile so editing shows the real values
    // rather than defaults that would silently overwrite a working parser.
    const parser = profile?.variables?.parser
    setParserId(parser?.id ?? 'csv')
    const options = (parser?.options ?? {}) as Record<string, unknown>
    setParserDelimiter(typeof options['delimiter'] === 'string' ? options['delimiter'] : ',')
    setParserTerminator(typeof options['lineTerminator'] === 'string' ? options['lineTerminator'] : '\\n')
    setParserExpression(typeof options['expression'] === 'string' ? options['expression'] : '')
    setParserPattern(typeof options['pattern'] === 'string' ? options['pattern'] : '')
    setParserFlags(typeof options['flags'] === 'string' ? options['flags'] : '')
    setParserSkipFirst(options['skipFirstLine'] === true)
    const ms = ocd?.intervalMs ?? 100
    if (intervalMode === 'hz') {
      setIntervalText(String(Math.round((1000 / ms) * 100) / 100))
    } else {
      setIntervalText(String(ms))
    }
    setRows(Array.isArray(ocd?.variables) ? ocd.variables : [])
  }, [intervalMode])

  const toggleIntervalMode = (newMode: 'ms' | 'hz') => {
    if (newMode === intervalMode) return
    const num = parseFloat(intervalText)
    if (Number.isFinite(num) && num > 0) {
      if (newMode === 'hz') {
        const hz = Math.round((1000 / num) * 100) / 100
        setIntervalText(String(hz))
      } else {
        const ms = Math.round((1000 / num) * 100) / 100
        setIntervalText(String(ms))
      }
    }
    setIntervalMode(newMode)
  }

  const intervalConversionText = useMemo(() => {
    const num = parseFloat(intervalText)
    if (!Number.isFinite(num) || num <= 0) return ''
    if (intervalMode === 'ms') {
      const hz = Math.round((1000 / num) * 100) / 100
      const formattedHz = hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz} Hz`
      return t('sources.freqHint', { freq: formattedHz })
    } else {
      const ms = Math.round((1000 / num) * 100) / 100
      return t('sources.periodHint', { ms })
    }
  }, [intervalText, intervalMode])

  /** Read the REAL configuration; never seed the editor from a local default. */
  const load = useCallback(async () => {
    setConfigError(undefined)
    try {
      applyConfig(await api.getConfig(sessionId) as PluginConfigView)
    } catch (caught) {
      setConfigError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [sessionId, applyConfig])

  // Load the first time the user opens the overlay, and keep it fresh each open.
  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const browse = useCallback(async () => {
    setBrowsing(true)
    setSaveError(undefined)
    try {
      // Empty nm keeps the transport's own default (arm-none-eabi-nm).
      const result = await api.symbols(elfPath, nmPath.trim() === '' ? '' : nmPath, filter, sessionId)
      setSymbols(result.symbols)
    } catch (caught) {
      setSymbols(undefined)
      setSaveError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBrowsing(false)
    }
  }, [elfPath, nmPath, filter, sessionId])

  const addManual = useCallback(() => {
    // The shared parser reports WHY it refused. An unrecognised TYPE must be
    // surfaced rather than defaulted: storing `u32` for a misspelt `uint16` makes
    // the reader decode a 16-bit quantity at 32 bits — wrong numbers, no symptom.
    // The offending token is echoed back so the user can see exactly what was
    // rejected (their own text, so no new copy is involved).
    const parsed = parseManualBindingDetailed(manual)
    if (!parsed.ok) {
      setManualBad({ reason: parsed.reason, spelling: parsed.spelling })
      return
    }
    setManualBad(undefined)
    setManual('')
    setManualUnit('')
    setRows(previous => [...previous, {
      source: 'manual',
      name: parsed.binding.name,
      address: parsed.binding.address,
      type: parsed.binding.type,
      ...(manualUnit.trim() === '' ? {} : { unit: manualUnit.trim() }),
    }])
  }, [manual, manualUnit])

  /**
   * Resolve, merge and persist.
   *
   * Unresolved entries are reported, never written: the host silently skips a
   * binding with no address (`src/service.ts:284`), so persisting `ok:false`
   * with the `address: 0` that came back would give the user a variable that
   * looks configured and quietly samples the wrong memory.
   */
  const save = useCallback(async (target: 'workspace' | 'global' = 'workspace') => {
    setBusy(true)
    setSaved(undefined)
    setSavedTarget(undefined)
    setSaveError(undefined)
    setSkipped([])
    try {
      const base = (config ?? await api.getConfig(sessionId)) as PluginConfigView
      const profileId = base.activeProfile
      const profile = base.profiles.find(entry => entry.id === profileId) ?? base.profiles[0]
      if (profile === undefined) throw new Error('configuration holds no device profiles')

      const checked: OcdVariableView[] = Object.values(picked).map(entry => ({
        source: 'symbol' as const,
        symbol: entry.name,
        name: entry.name,
        type: entry.type,
      }))
      // Manual rows already carry a concrete address; symbol rows need the ELF.
      const manualRows = rows.filter(row => row.source === 'manual')
      // Symbol rows (newly ticked + previously saved) all go through resolution.
      const toResolve: OcdVariableView[] = [...checked, ...rows.filter(row => row.source === 'symbol')]

      let resolved: ResolvedBinding[] = []
      if (toResolve.length > 0) {
        const answer = await api.ocdVars(elfPath, toResolve, sessionId)
        resolved = answer.resolved
      }

      const failed: { name: string; reason: string }[] = []
      const merged: OcdVariableView[] = []
      for (const [index, entry] of toResolve.entries()) {
        const answer = resolved[index]
        if (answer === undefined || answer.ok !== true) {
          failed.push({
            name: entry.name ?? entry.symbol ?? `#${index + 1}`,
            reason: answer?.reason ?? 'not resolved (no answer from the host)',
          })
          continue
        }
        merged.push({
          source: 'symbol',
          symbol: entry.symbol,
          name: answer.name,
          address: answer.address,
          type: answer.type,
          ...(entry.unit === undefined ? {} : { unit: entry.unit }),
        })
      }
      // Manual bindings resolved locally; their addresses are already concrete.
      for (const row of manualRows) {
        if (typeof row.address !== 'number') {
          failed.push({ name: row.name ?? '(manual)', reason: 'missing address' })
          continue
        }
        merged.push(row)
      }

      const rawInterval = parseFloat(intervalText)
      const computedIntervalMs = intervalMode === 'ms'
        ? rawInterval
        : (Number.isFinite(rawInterval) && rawInterval > 0 ? 1000 / rawInterval : 100)
      const finalIntervalMs = Number.isFinite(computedIntervalMs) && computedIntervalMs > 0
        ? computedIntervalMs
        : 100

      const next: PluginConfigView = {
        ...base,
        profiles: base.profiles.map(entry => entry.id !== profileId ? entry : {
          ...entry,
          driver,
          openocd: {
            ...entry.openocd,
            configPath: configPath.trim(),
            // Machine-wide: stored in the global layer, shown here.
            executable: openocdExe.trim() === '' ? 'openocd' : openocdExe.trim(),
          },
          jlink: {
            executable: jlinkExe.trim(),
            device: jlinkDevice.trim(),
            targetInterface: jlinkInterface,
            speedKhz: Math.max(0, Math.round(Number(jlinkSpeed) || 0)),
            gdbPort: Math.max(1, Math.round(Number(jlinkGdbPort) || 2331)),
            rttTelnetPort: Math.max(1, Math.round(Number(jlinkTelnetPort) || 19021)),
            serial: jlinkSerial.trim(),
            autoStart: jlinkAutoStart,
            extraArgs: entry.jlink?.extraArgs ?? [],
            startupTimeoutMs: entry.jlink?.startupTimeoutMs ?? 8000,
          },
          ocd: {
            enabled,
            elfPath: elfPath.trim(),
            nmPath: nmPath.trim(),
            intervalMs: finalIntervalMs,
            variables: merged,
          },
          /* Parser settings travel with the same save: the RTT data channel's
             framing is a property of the TARGET, so it belongs to the project,
             not to this machine. */
          variables: {
            ...entry.variables,
            parser: {
              id: parserId,
              options: buildParserOptions(),
            },
          },
        }),
      }

      await api.setConfig(next, sessionId, target)
      // Re-read so the editor shows what the host actually stored. The host
      // also reports whether the change reached persistent settings; a failure
      // there is surfaced rather than presented as a clean save.
      const stored = await api.getConfig(sessionId) as PluginConfigView & { persisted?: boolean; persistError?: string }
      applyConfig(stored)
      setPicked({})
      setSkipped(failed)
      if (stored.persisted === false) {
        setSaveError(stored.persistError ?? t('sources.persistFailed'))
        return
      }
      const profName = (stored.profiles.find(entry => entry.id === stored.activeProfile) ?? profile).name ?? profileId
      setSaved(profName)
      setSavedTarget(target)
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [config, sessionId, picked, rows, elfPath, configPath, nmPath, intervalText, intervalMode, enabled, applyConfig,
    driver, openocdExe, jlinkExe, jlinkDevice, jlinkInterface, jlinkSpeed, jlinkGdbPort, jlinkTelnetPort, jlinkSerial, jlinkAutoStart])

  /* zone A: read-only view of the RTT data channel */
  const rttDescriptors = useMemo(
    () => (state?.descriptors ?? []).filter(descriptor => descriptor.source === 'rttVar'),
    [state],
  )
  // Fallback is the host's OWN series roster (state.series.names), not the live
  // `series` prop: the roster is present from the first snapshot, so the zone is
  // populated while the parser has not yet published descriptors.
  const rttNames = rttDescriptors.length > 0
    ? rttDescriptors.map(descriptor => descriptor.name)
    : (state?.series.names ?? [])
  const usingFallback = rttDescriptors.length === 0 && rttNames.length > 0

  const symbolRows = symbols === undefined ? [] : symbols
  const selectedCount = Object.keys(picked).length

  return createElement(
    'span',
    null,
    createElement('button', {
      type: 'button',
      className: `rttd-btn rttd-btn-sm${open ? ' rttd-btn-active' : ''}`,
      onClick: () => setOpen(value => !value),
      title: t('sources.title'),
    }, t('sources.open')),
    !open ? null : createElement(
      'div',
      {
        className: 'rttd-modal-backdrop',
        onClick: (event: React.MouseEvent) => {
          if (event.target === event.currentTarget) setOpen(false)
        },
      },
      createElement(
        'div',
        { className: 'rttd-sources' },
        createElement(
          'div',
          { className: 'rttd-sources-title' },
          createElement('span', null, t('sources.title')),
          createElement('span', { className: 'rttd-spacer' }),
          createElement('button', {
            type: 'button',
            className: 'rttd-btn rttd-btn-sm',
            onClick: () => setOpen(false),
            title: t('btn.close'),
            style: { padding: '0 6px', lineHeight: '18px' },
          }, '✕'),
        ),

      /* ── zone A: read-only ── */
      createElement(
        'div',
        { className: 'rttd-sources-section' },
        createElement('div', { className: 'rttd-sources-heading' }, t('sources.rttSection')),
        createElement(
          'div',
          { className: 'rttd-sources-row' },
          createElement('span', { className: 'rttd-label' }, t('sources.parser')),
          createElement('span', { className: 'rttd-sources-mono' }, parserId ?? '—'),
        ),
        rttNames.length === 0
          ? createElement('div', { className: 'rttd-sources-note' }, t('sources.rttNone'))
          : createElement(
            'div',
            { className: 'rttd-sources-row' },
            ...rttNames.map(name => createElement('span', {
              key: name,
              className: 'rttd-chip rttd-chip-on',
            }, createElement('span', { className: 'rttd-dot' }), name)),
          ),
        usingFallback
          ? createElement('div', { className: 'rttd-sources-hint' }, t('sources.rttFallbackHint'))
          : null,

        /* ── parser editor ──
           Framing is a property of the TARGET's output, so these fields are
           project-scoped and travel with the workspace. */
        createElement('div', { className: 'rttd-sources-heading', style: { marginTop: '8px' } },
          t('sources.parserSection')),
        createElement(
          'div',
          { className: 'rttd-sources-row' },
          createElement('span', { className: 'rttd-label' }, t('sources.parserId')),
          createElement(
            'select',
            {
              className: 'rttd-sources-input rttd-sources-select',
              value: parserId,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setParserId(event.target.value),
            },
            ...PARSER_IDS.map(id => createElement('option', { key: id, value: id }, id)),
          ),
          createElement('span', { className: 'rttd-label', title: t('sources.parserTerminatorHint') }, t('sources.parserTerminator')),
          createElement('input', {
            className: 'rttd-sources-input rttd-sources-input-sm',
            value: parserTerminator,
            placeholder: '\\n',
            title: t('sources.parserTerminatorHint'),
            onChange: event => setParserTerminator((event.target as HTMLInputElement).value),
          }),
        ),

        parserId === 'custom-regex'
          ? createElement(
            'div',
            { className: 'rttd-sources-row' },
            createElement('span', { className: 'rttd-label', title: t('sources.parserPatternHint') }, t('sources.parserPattern')),
            createElement('input', {
              className: 'rttd-sources-input',
              style: { flex: '1 1 auto' },
              value: parserPattern,
              placeholder: 'DATA: V=(?<volt>\\d+)',
              onChange: event => setParserPattern((event.target as HTMLInputElement).value),
            }),
            createElement('span', { className: 'rttd-label' }, t('sources.parserFlags')),
            createElement('input', {
              className: 'rttd-sources-input rttd-sources-input-sm',
              value: parserFlags,
              placeholder: 'g',
              onChange: event => setParserFlags((event.target as HTMLInputElement).value),
            }),
          )
          : null,

        parserId === 'script'
          ? createElement(
            'div',
            { style: { marginTop: '4px' } },
            createElement('div', { className: 'rttd-sources-label', title: t('sources.parserExpressionHint') },
              t('sources.parserExpression')),
            createElement('textarea', {
              className: 'rttd-sources-textarea',
              rows: 3,
              spellCheck: false,
              value: parserExpression,
              placeholder: '{ volt: fields[0] * 3.3 / 4095, amps: fields[1] / 1000 }',
              onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setParserExpression(event.target.value),
            }),
            createElement(
              'label',
              { className: 'rttd-check' },
              createElement('input', {
                type: 'checkbox',
                checked: parserSkipFirst,
                onChange: event => setParserSkipFirst((event.target as HTMLInputElement).checked),
              }),
              t('sources.parserSkipFirst'),
            ),
            createElement('div', { className: 'rttd-sources-hint' }, t('sources.parserSandboxNote')),
            parserError === undefined ? null : createElement('div', { className: 'rttd-sources-error' }, parserError),
          )
          : null,

        parserId === 'custom-regex'
          ? null
          : createElement(
            'div',
            { className: 'rttd-sources-row' },
            createElement('span', { className: 'rttd-label', title: t('sources.parserDelimiterHint') }, t('sources.parserDelimiter')),
            createElement('input', {
              className: 'rttd-sources-input rttd-sources-input-sm',
              value: parserDelimiter,
              placeholder: ',',
              title: t('sources.parserDelimiterHint'),
              onChange: event => setParserDelimiter((event.target as HTMLInputElement).value),
            }),
          ),
      ),

      /* ── zone B: editable ── */
      createElement(
        'div',
        { className: 'rttd-sources-section' },
        createElement('div', { className: 'rttd-sources-heading' }, t('sources.ocdSection')),

        /* driver tabs: which backend performs the memory reads */
        createElement(
          'div',
          { className: 'rttd-tabs', title: t('driver.hint') },
          createElement('button', {
            type: 'button',
            className: `rttd-tab${driver === 'openocd' ? ' rttd-tab-active' : ''}`,
            onClick: () => setDriver('openocd'),
          }, t('driver.tabOpenocd')),
          createElement('button', {
            type: 'button',
            className: `rttd-tab${driver === 'jlink' ? ' rttd-tab-active' : ''}`,
            onClick: () => setDriver('jlink'),
          }, t('driver.tabJlink')),
        ),

        configError === undefined ? null : createElement(
          'div',
          { className: 'rttd-sources-error' },
          t('sources.loadFailed', { message: configError }),
        ),

        createElement(
          'label',
          { className: 'rttd-check' },
          createElement('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: event => setEnabled((event.target as HTMLInputElement).checked),
          }),
          t('sources.enabled'),
        ),

        createElement(
          'div',
          { className: 'rttd-sources-grid' },
          /* Backend-specific endpoints. Both drivers share the ELF/nm/interval
             rows below, because symbol resolution and poll timing are transport
             independent — only who answers the memory reads changes. */
          driver === 'openocd'
            ? createElement('span', { className: 'rttd-label', title: t('sources.configPathHint') }, t('sources.configPath'))
            : createElement('span', { className: 'rttd-label', title: t('driver.jlinkExecutableHint') }, t('driver.jlinkExecutable')),
          driver === 'openocd'
            ? createElement(
              'div',
              { style: { display: 'flex', gap: '6px', width: '100%', alignItems: 'center' } },
              createElement('input', {
                className: 'rttd-sources-input',
                style: { flex: '1 1 auto' },
                value: configPath,
                placeholder: '如 mcu/openocd.cfg 或完整路径',
                onChange: event => setConfigPath((event.target as HTMLInputElement).value),
              }),
              createElement('button', {
                type: 'button',
                className: 'rttd-btn rttd-browse-btn',
                onClick: () => setPickerTarget('configPath'),
              }, t('sources.browseFile')),
            )
            : createElement(
              'div',
              { style: { display: 'flex', gap: '6px', width: '100%', alignItems: 'center' } },
              createElement('input', {
                className: 'rttd-sources-input',
                style: { flex: '1 1 auto' },
                value: jlinkExe,
                placeholder: 'C:\\Program Files\\SEGGER\\JLink\\JLinkGDBServerCL.exe',
                onChange: event => setJlinkExe((event.target as HTMLInputElement).value),
              }),
              createElement('button', {
                type: 'button',
                className: 'rttd-btn rttd-browse-btn',
                onClick: () => setPickerTarget('jlinkExe'),
              }, t('sources.browseFile')),
            ),

          /* OpenOCD's PROGRAM path — machine-wide, unlike the .cfg above it. */
          driver === 'openocd' ? createElement(
            'span',
            { className: 'rttd-label', title: t('driver.openocdExecutableHint') },
            t('driver.openocdExecutable'),
          ) : null,
          driver === 'openocd' ? createElement(
            'div',
            { style: { display: 'flex', gap: '6px', width: '100%', alignItems: 'center' } },
            createElement('input', {
              className: 'rttd-sources-input',
              style: { flex: '1 1 auto' },
              value: openocdExe,
              placeholder: 'openocd',
              onChange: event => setOpenocdExe((event.target as HTMLInputElement).value),
            }),
            createElement('button', {
              type: 'button',
              className: 'rttd-btn rttd-browse-btn',
              onClick: () => setPickerTarget('openocdExe'),
            }, t('sources.browseFile')),
          ) : null,

          /* J-Link-only rows: device, interface, speed, ports, probe, autostart */
          driver !== 'jlink' ? null : createElement('span', { className: 'rttd-label', title: t('driver.jlinkDeviceHint') }, t('driver.jlinkDevice')),
          driver !== 'jlink' ? null : createElement(
            'div',
            { style: { display: 'flex', gap: '6px', width: '100%', alignItems: 'center' } },
            createElement('input', {
              className: 'rttd-sources-input',
              style: { flex: '1 1 auto' },
              value: jlinkDevice,
              placeholder: 'STM32F407VG',
              onChange: event => setJlinkDevice((event.target as HTMLInputElement).value),
            }),
            createElement(
              'span',
              { className: 'rttd-unit-selector' },
              createElement('button', {
                type: 'button',
                className: `rttd-unit-btn${jlinkInterface === 'SWD' ? ' rttd-unit-btn-active' : ''}`,
                onClick: () => setJlinkInterface('SWD'),
              }, 'SWD'),
              createElement('button', {
                type: 'button',
                className: `rttd-unit-btn${jlinkInterface === 'JTAG' ? ' rttd-unit-btn-active' : ''}`,
                onClick: () => setJlinkInterface('JTAG'),
              }, 'JTAG'),
            ),
          ),
          driver !== 'jlink' ? null : createElement('span', { className: 'rttd-label' }, t('driver.jlinkSpeed')),
          driver !== 'jlink' ? null : createElement(
            'span',
            { className: 'rttd-sources-row' },
            createElement('input', {
              className: 'rttd-sources-input rttd-sources-input-sm',
              type: 'number',
              min: '0',
              step: '1',
              value: jlinkSpeed,
              onChange: event => setJlinkSpeed((event.target as HTMLInputElement).value),
            }),
            createElement('span', { className: 'rttd-label' }, 'kHz'),
          ),
          driver !== 'jlink' ? null : createElement('span', { className: 'rttd-label' }, t('driver.jlinkGdbPort')),
          driver !== 'jlink' ? null : createElement(
            'span',
            { className: 'rttd-sources-row' },
            createElement('input', {
              className: 'rttd-sources-input rttd-sources-input-sm',
              type: 'number',
              min: '1',
              max: '65535',
              value: jlinkGdbPort,
              onChange: event => setJlinkGdbPort((event.target as HTMLInputElement).value),
            }),
            createElement('span', { className: 'rttd-label', title: t('driver.jlinkRttTelnetHint') }, t('driver.jlinkRttTelnetPort')),
            createElement('input', {
              className: 'rttd-sources-input rttd-sources-input-sm',
              type: 'number',
              min: '1',
              max: '65535',
              value: jlinkTelnetPort,
              onChange: event => setJlinkTelnetPort((event.target as HTMLInputElement).value),
            }),
          ),
          driver !== 'jlink' ? null : createElement('span', { className: 'rttd-label', title: t('driver.jlinkSerialHint') }, t('driver.jlinkSerial')),
          driver !== 'jlink' ? null : createElement(
            'span',
            { className: 'rttd-sources-row' },
            createElement('input', {
              className: 'rttd-sources-input',
              style: { width: '200px' },
              value: jlinkSerial,
              placeholder: '—',
              onChange: event => setJlinkSerial((event.target as HTMLInputElement).value),
            }),
            createElement(
              'label',
              { className: 'rttd-check', title: t('driver.jlinkAutoStartHint') },
              createElement('input', {
                type: 'checkbox',
                checked: jlinkAutoStart,
                onChange: event => setJlinkAutoStart((event.target as HTMLInputElement).checked),
              }),
              t('driver.jlinkAutoStart'),
            ),
          ),
          driver !== 'jlink' ? null : createElement(
            'div',
            { className: 'rttd-sources-hint', style: { gridColumn: '1 / -1' } },
            t('driver.jlinkChannels'),
          ),

          createElement('span', { className: 'rttd-label', title: t('sources.elfPathHint') }, t('sources.elfPath')),
          createElement(
            'div',
            { style: { display: 'flex', gap: '6px', width: '100%', alignItems: 'center' } },
            createElement('input', {
              className: 'rttd-sources-input',
              style: { flex: '1 1 auto' },
              value: elfPath,
              placeholder: '/path/to/firmware.elf',
              onChange: event => setElfPath((event.target as HTMLInputElement).value),
            }),
            createElement('button', {
              type: 'button',
              className: 'rttd-btn rttd-browse-btn',
              onClick: () => setPickerTarget('elfPath'),
            }, t('sources.browseFile')),
          ),
          createElement('span', { className: 'rttd-label', title: t('sources.nmPathHint') }, t('sources.nmPath')),
          createElement('input', {
            className: 'rttd-sources-input',
            value: nmPath,
            placeholder: 'arm-none-eabi-nm',
            onChange: event => setNmPath((event.target as HTMLInputElement).value),
          }),
          createElement('span', { className: 'rttd-label' }, t('sources.interval')),
          createElement(
            'span',
            { className: 'rttd-sources-row' },
            createElement('input', {
              className: 'rttd-sources-input rttd-sources-input-sm',
              type: 'number',
              step: 'any',
              min: '0.001',
              value: intervalText,
              onChange: event => setIntervalText((event.target as HTMLInputElement).value),
            }),
            createElement(
              'span',
              { className: 'rttd-unit-selector' },
              createElement('button', {
                type: 'button',
                className: `rttd-unit-btn${intervalMode === 'ms' ? ' rttd-unit-btn-active' : ''}`,
                onClick: () => toggleIntervalMode('ms'),
              }, 'ms'),
              createElement('button', {
                type: 'button',
                className: `rttd-unit-btn${intervalMode === 'hz' ? ' rttd-unit-btn-active' : ''}`,
                onClick: () => toggleIntervalMode('hz'),
              }, 'Hz'),
            ),
            createElement('span', { className: 'rttd-sources-hint' }, intervalConversionText),
          ),
        ),

        /* symbol browser */
        createElement(
          'div',
          { className: 'rttd-sources-row', style: { marginTop: '6px' } },
          createElement('span', { className: 'rttd-label' }, t('sources.filter')),
          createElement('input', {
            className: 'rttd-sources-input',
            style: { width: '180px' },
            value: filter,
            placeholder: t('sources.filterPlaceholder'),
            onChange: event => setFilter((event.target as HTMLInputElement).value),
          }),
          createElement('button', {
            type: 'button',
            className: 'rttd-btn rttd-btn-sm',
            disabled: browsing || elfPath.trim() === '',
            title: elfPath.trim() === '' ? t('sources.browseHint') : undefined,
            onClick: () => void browse(),
          }, browsing ? t('sources.browsing') : t('sources.browse')),
          symbols === undefined ? null : createElement(
            'span',
            { className: 'rttd-sources-hint' },
            symbols.length === 0 ? t('sources.browseEmpty') : t('sources.browseCount', { count: symbols.length }),
          ),
        ),
        symbolRows.length === 0 ? null : createElement(
          'div',
          { className: 'rttd-sources-list' },
          ...symbolRows.map(symbol => createElement(
            'label',
            { key: `${symbol.name}@${symbol.address}`, className: 'rttd-sources-symbol' },
            createElement('input', {
              type: 'checkbox',
              checked: picked[symbol.name] !== undefined,
              onChange: () => setPicked(previous => {
                const next = { ...previous }
                if (next[symbol.name] !== undefined) delete next[symbol.name]
                else next[symbol.name] = { name: symbol.name, address: symbol.address, type: symbol.inferredType, size: symbol.size }
                return next
              }),
            }),
            createElement('span', { className: 'rttd-sources-symbol-name', title: symbol.name }, symbol.name),
            createElement('span', { className: 'rttd-sources-mono' }, hexAddress(symbol.address)),
            createElement('span', { className: 'rttd-sources-mono' }, String(symbol.size)),
            createElement('span', {}, symbol.inferredType),
          )),
        ),

        /* manual entry */
        createElement(
          'div',
          { className: 'rttd-sources-row', style: { marginTop: '6px' } },
          createElement('span', { className: 'rttd-label', title: t('sources.manualHint') }, t('sources.manualLabel')),
          createElement('input', {
            className: 'rttd-sources-input',
            style: { width: '260px' },
            value: manual,
            placeholder: t('sources.manualPlaceholder'),
            onChange: event => {
              setManual((event.target as HTMLInputElement).value)
              setManualBad(undefined)
            },
          }),
          createElement('span', { className: 'rttd-label' }, t('sources.unit')),
          createElement('input', {
            className: 'rttd-sources-input rttd-sources-input-sm',
            value: manualUnit,
            placeholder: t('sources.unitPlaceholder'),
            onChange: event => setManualUnit((event.target as HTMLInputElement).value),
          }),
          createElement('button', {
            type: 'button',
            className: 'rttd-btn rttd-btn-sm',
            onClick: addManual,
          }, t('sources.add')),
        ),
        manualBad === undefined ? null : createElement(
          'div',
          { className: 'rttd-sources-error' },
          // Keep the existing copy AND echo the rejected token, so an unrecognised
          // type spelling is visibly distinguishable from a malformed line
          // ("nonsense" / "uint16" appears verbatim in the message). The token is
          // the user's own text, rendered in a monospace span.
          manualBad.reason === 'unknown-type' && manualBad.spelling !== undefined
            ? createElement(
              'span',
              null,
              t('sources.manualBad'),
              ' ',
              createElement('code', { className: 'rttd-sources-mono' }, manualBad.spelling),
            )
            : t('sources.manualBad'),
        ),

        /* configured list */
        createElement('div', { className: 'rttd-sources-heading', style: { marginTop: '8px' } },
          t('sources.configured', { count: rows.length })),
        rows.length === 0
          ? createElement('div', { className: 'rttd-sources-note' }, t('sources.configuredEmpty'))
          : createElement(
            'table',
            { className: 'rttd-sources-table' },
            createElement('thead', null, createElement('tr', null,
              createElement('th', null, t('sources.columnName')),
              createElement('th', null, t('sources.columnAddress')),
              createElement('th', null, t('sources.columnType')),
              createElement('th', null, t('sources.columnUnit')),
              createElement('th', null, ''),
            )),
            createElement('tbody', null, ...rows.map((row, index) => createElement(
              'tr',
              { key: `${row.name ?? row.symbol ?? index}@${row.address ?? index}` },
              createElement('td', { title: row.symbol ?? row.name }, row.name ?? row.symbol ?? '—'),
              createElement('td', { className: 'rttd-sources-mono' }, hexAddress(row.address)),
              createElement('td', { className: 'rttd-sources-mono' }, row.type ?? 'u32'),
              createElement('td', null, createElement('input', {
                className: 'rttd-sources-input',
                style: { width: '70px', padding: '1px 5px', fontSize: '11px', height: '22px' },
                value: row.unit ?? '',
                placeholder: '如 mV / ℃',
                onChange: event => {
                  const val = (event.target as HTMLInputElement).value
                  setRows(previous => previous.map((r, i) => i !== index ? r : {
                    ...r,
                    unit: val.trim() === '' ? undefined : val,
                  }))
                },
              })),
              createElement('td', null, createElement('button', {
                type: 'button',
                className: 'rttd-btn rttd-btn-sm',
                onClick: () => setRows(previous => previous.filter((_, i) => i !== index)),
              }, t('sources.remove'))),
            ))),
          ),

        /* status + save */
        skipped.length === 0 ? null : createElement(
          'div',
          { className: 'rttd-sources-error' },
          t('sources.unresolved'),
          createElement('ul', { className: 'rttd-sources-reasons' },
            ...skipped.map(entry => createElement('li', { key: entry.name }, t('sources.unresolvedItem', {
              name: entry.name,
              reason: entry.reason,
            }))),
          ),
        ),
        createElement(
          'div',
          { className: 'rttd-sources-scope-info' },
          t('sources.scopeWorkspace'),
        ),
        saved === undefined ? null : createElement(
          'div',
          { className: 'rttd-sources-ok' },
          t('sources.savedWorkspace', { path: '.dsh/rtt-debug.json' }),
        ),
        saveError === undefined ? null : createElement(
          'div',
          { className: 'rttd-sources-error' },
          t('sources.saveFailed', { message: saveError }),
        ),

        createElement(
          'div',
          { className: 'rttd-sources-actions' },
          createElement('button', {
            type: 'button',
            className: 'rttd-btn rttd-btn-sm rttd-btn-primary',
            disabled: busy,
            onClick: () => void save('workspace'),
            title: t('sources.saveWorkspaceHint'),
          }, busy ? t('sources.saving') : t('sources.saveWorkspace')),
          createElement('button', {
            type: 'button',
            className: 'rttd-btn rttd-btn-sm',
            disabled: busy,
            onClick: () => void load(),
          }, t('sources.reload')),
          createElement('button', {
            type: 'button',
            className: 'rttd-btn rttd-btn-sm',
            onClick: () => setOpen(false),
          }, t('btn.close')),
          selectedCount === 0 ? null : createElement(
            'span',
            { className: 'rttd-sources-hint' },
            t('sources.browseCount', { count: selectedCount }),
          ),
        ),

        createElement('div', { className: 'rttd-sources-note' }, t('sources.needRestartHint')),
        createElement('div', { className: 'rttd-sources-hint' }, t('sources.keepRunningNote')),
        createElement('div', { className: 'rttd-sources-hint' }, t('sources.toolScopeHint')),
      ),
    ),
    pickerTarget === undefined ? null : createElement(FilePickerModal, {
      open: true,
      targetField: pickerTarget,
      sessionId,
      onSelect: (chosenPath: string) => {
        if (pickerTarget === 'configPath') setConfigPath(chosenPath)
        else if (pickerTarget === 'jlinkExe') setJlinkExe(chosenPath)
        else if (pickerTarget === 'openocdExe') setOpenocdExe(chosenPath)
        else if (pickerTarget === 'elfPath') setElfPath(chosenPath)
        setPickerTarget(undefined)
      },
      onClose: () => setPickerTarget(undefined),
    }),
  ),
)
}

interface ReadoutStripProps {
  measurements: { name: string; unit?: string; result: ReturnType<typeof measure> }[]
  delta: ReturnType<typeof deltaBetween>
  hoverTime: number | undefined
  pointer: { x: number; y: number } | undefined
  series: Series[]
  visible: Set<string>
  viewport: Viewport
  metrics: ReturnType<typeof plotMetrics>
}

function ReadoutStrip(props: ReadoutStripProps): ReactNode {
  const { measurements, delta, hoverTime, pointer, series, visible, viewport, metrics } = props

  const hoverReadings = useMemo(() => {
    if (hoverTime === undefined) return []
    return series
      .filter(entry => visible.has(entry.name))
      .map(entry => ({ name: entry.name, unit: entry.unit, value: valueAt(entry, hoverTime) }))
      .filter((row): row is { name: string; unit: string | undefined; value: number } => row.value !== undefined)
  }, [hoverTime, series, visible])

  // Built as an explicit array rather than inline spreads, so the argument
  // nesting stays readable and countable when rows are added.
  const rows: ReactNode[] = []

  if (delta !== undefined) {
    rows.push(createElement('div', { key: '__delta', className: 'rttd-readout-row' },
      createElement('span', { className: 'rttd-readout-key' }, t('readout.delta')),
      createElement('span', { className: 'rttd-readout-val' },
        `Δt=${formatTime(delta.deltaTimeMs)} · 1/Δt=${delta.frequencyHz.toFixed(2)} Hz`,
      ),
    ))
    for (const row of delta.perSeries) {
      rows.push(createElement('div', { key: `__d_${row.name}`, className: 'rttd-readout-row' },
        createElement('span', { className: 'rttd-readout-key' }, row.name),
        createElement('span', { className: 'rttd-readout-val' }, `ΔV=${formatValue(row.deltaV)}`),
      ))
    }
  }

  if (hoverReadings.length > 0) {
    rows.push(createElement('div', { key: '__hover', className: 'rttd-readout-row' },
      createElement('span', { className: 'rttd-readout-key' }, t('readout.hover')),
      createElement('span', { className: 'rttd-readout-val' },
        hoverReadings.map(row => `${row.name}=${formatValue(row.value, row.unit)}`).join('  '),
      ),
    ))
  }

  for (const row of measurements) {
    const cells = [
      `min=${formatValue(row.result.min ?? Number.NaN)}`,
      `max=${formatValue(row.result.max ?? Number.NaN)}`,
      `Vpp=${formatValue(row.result.peakToPeak ?? Number.NaN)}`,
      `mean=${formatValue(row.result.mean ?? Number.NaN)}`,
      row.result.frequencyHz === undefined ? 'f=—' : `f=${row.result.frequencyHz.toFixed(2)}Hz`,
      row.result.riseTimeMs === undefined ? 'tr=—' : `tr=${formatTime(row.result.riseTimeMs)}`,
    ]
    rows.push(createElement('div', { key: `__m_${row.name}`, className: 'rttd-readout-row' },
      createElement('span', { className: 'rttd-readout-key' }, row.name),
      createElement('span', { className: 'rttd-readout-val' }, cells.join('  ')),
    ))
  }

  if (pointer !== undefined && pointer.x >= metrics.left && hoverTime !== undefined) {
    rows.push(createElement('div', { key: '__hint', className: 'rttd-readout-hint' },
      `t=${formatTime(hoverTime - viewport.tMax)}`,
    ))
  }

  return createElement('div', { className: 'rttd-readout' }, ...rows)
}

interface LogToolbarProps {
  filter: string
  setFilter: (value: string) => void
  useRegex: boolean
  setUseRegex: (value: boolean) => void
  follow: boolean
  setFollow: (value: boolean) => void
  retained: number
  total: number
  onExport: () => void
  onClearLog: () => void
}

function LogToolbar(props: LogToolbarProps): ReactNode {
  return createElement(
    'div',
    { className: 'rttd-toolbar rttd-toolbar-sub' },
    createElement('input', {
      className: 'rttd-input',
      value: props.filter,
      placeholder: t('log.filterPlaceholder'),
      onChange: event => props.setFilter((event.target as HTMLInputElement).value),
    }),
    createElement('label', { className: 'rttd-check' },
      createElement('input', {
        type: 'checkbox',
        checked: props.useRegex,
        onChange: event => props.setUseRegex((event.target as HTMLInputElement).checked),
      }),
      t('log.regex'),
    ),
    createElement('label', { className: 'rttd-check' },
      createElement('input', {
        type: 'checkbox',
        checked: props.follow,
        onChange: event => props.setFollow((event.target as HTMLInputElement).checked),
      }),
      t('log.follow'),
    ),
    createElement('span', { className: 'rttd-spacer' }),
    createElement('span', {
      className: 'rttd-counter',
      title: t('log.completenessHint'),
    }, t('log.counters', { retained: props.retained, total: props.total })),
    createElement('button', { className: 'rttd-btn rttd-btn-sm', type: 'button', onClick: props.onExport }, t('log.export')),
    createElement('button', { className: 'rttd-btn rttd-btn-sm', type: 'button', onClick: props.onClearLog }, t('btn.clear')),
  )
}

interface LogListProps {
  records: LogRecord[]
  follow: boolean
  logRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Scrollable log body.
 *
 * Renders plain rows rather than a virtualised list: the host ring caps the
 * line count (5000 by default), and windowing that many simple rows costs more
 * in complexity than it saves in layout.
 */
function LogList(props: LogListProps): ReactNode {
  const [jumpVisible, setJumpVisible] = useState(false)

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
    setJumpVisible(!atBottom)
  }, [])

  return createElement(
    'div',
    { className: 'rttd-log-wrap' },
    createElement(
      'div',
      { className: 'rttd-log', ref: props.logRef, onScroll },
      ...props.records.map(record => createElement('div', {
        key: record.seq,
        className: `rttd-log-line rttd-log-${record.level}`,
      },
        createElement('span', { className: 'rttd-log-ts' }, new Date(record.ts).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(record.ts % 1000).padStart(3, '0')),
        createElement('span', { className: `rttd-log-level rttd-log-level-${record.level}` }, record.level.toUpperCase()),
        createElement('span', { className: 'rttd-log-text' },
          ...(record.spans.length === 0
            ? [record.text]
            : record.spans.map((span, index) => createElement('span', {
              key: index,
              style: {
                color: ansiColorToCss(span.color),
                fontWeight: span.bold === true ? 600 : undefined,
                fontStyle: span.italic === true ? 'italic' : undefined,
                textDecoration: span.underline === true ? 'underline' : undefined,
              },
            }, span.text))),
        ),
      )),
    ),
    jumpVisible
      ? createElement('button', {
        className: 'rttd-jump',
        type: 'button',
        onClick: () => {
          const node = props.logRef.current
          if (node !== null) node.scrollTop = node.scrollHeight
        },
      }, t('log.jumpToLatest'))
      : null,
  )
}

/* ──────────────────────────────── helpers ────────────────────────────────── */

/** Merge incoming samples into the existing series, creating new ones as needed. */
export function mergeSamples(
  current: Series[],
  samples: readonly { ts: number; values: Record<string, number | boolean> }[],
  capPerSeries = 100_000,
): Series[] {
  if (samples.length === 0) return current
  const byName = new Map(current.map(entry => [entry.name, entry]))
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample.values)) {
      let entry = byName.get(name)
      if (entry === undefined) {
        entry = { name, kind: typeof value === 'boolean' ? 'bool' : 'number', ts: [], values: [] }
        byName.set(name, entry)
        current = current.concat(entry)
      }
      entry.ts.push(sample.ts)
      entry.values.push(value)
    }
  }
  for (const entry of byName.values()) {
    if (entry.ts.length > capPerSeries) {
      const drop = entry.ts.length - capPerSeries
      entry.ts.splice(0, drop)
      entry.values.splice(0, drop)
    }
  }
  return current
}

/** Apply the toolbar's filter to the log ring. */
export function filterLog(records: readonly LogRecord[], filter: string, useRegex: boolean): LogRecord[] {
  const needle = filter.trim()
  if (needle === '') return records as LogRecord[]
  if (useRegex) {
    let regex: RegExp
    try {
      regex = new RegExp(needle, 'i')
    } catch {
      // An in-progress pattern must not blank the view while it is typed.
      return records as LogRecord[]
    }
    return records.filter(record => regex.test(record.text))
  }
  const lower = needle.toLowerCase()
  return records.filter(record => record.text.toLowerCase().includes(lower))
}

/** Map a decoded ANSI colour name onto a readable CSS colour. */
export function ansiColorToCss(color: string | undefined): string | undefined {
  if (color === undefined) return undefined
  const table: Record<string, string> = {
    black: '#3b3f46', red: '#ff6b6b', green: '#69db7c', yellow: '#ffd43b',
    blue: '#4dabf7', magenta: '#da77f2', cyan: '#3bc9db', white: '#e9ecef',
    brightBlack: '#868e96', brightRed: '#ff8787', brightGreen: '#8ce99a',
    brightYellow: '#ffe066', brightBlue: '#74c0fc', brightMagenta: '#e599f7',
    brightCyan: '#66d9e8', brightWhite: '#f8f9fa',
  }
  return table[color]
}
