/**
 * Shared view-layer types for the waveform pane.
 *
 * Kept apart from `core/types.ts` because these describe how the plot is drawn,
 * not what the data means — a headless consumer of the series store never needs
 * them.
 */

/** The visible window of a plot: which time range, which value range. */
export interface Viewport {
  /** Left edge (oldest) in epoch milliseconds. */
  tMin: number
  /** Right edge (newest) in epoch milliseconds. */
  tMax: number
  /** Bottom edge on the value axis. */
  vMin: number
  /** Top edge on the value axis. */
  vMax: number
}

/** Identifiers for the two measurement cursors. */
export type CursorId = 'a' | 'b'

/** One placed cursor: a point on the plot, held as data coordinates. */
export interface CursorPoint {
  /** Timestamp, so the cursor stays on its sample when the window scrolls. */
  t: number
  /** Value at that timestamp. */
  v: number
}

/** Cursor state for the plot. */
export interface CursorState {
  /** Whether cursors are shown at all (the ruler toggle). */
  enabled: boolean
  a?: CursorPoint
  b?: CursorPoint
  /** Which cursor a drag is currently moving. */
  dragging?: CursorId
}

/** The drawable area inside the plot's margins, in CSS pixels. */
export interface PlotMetrics {
  left: number
  top: number
  width: number
  height: number
}

/** Result of a cursor-pair measurement, shown in the readout strip. */
export interface DeltaReadout {
  deltaTimeMs: number
  /** `1 / Δt`, in Hz — the usual reason to place two cursors. */
  frequencyHz: number
  /** Per-series value difference across the pair. */
  perSeries: { name: string; deltaV: number; vA: number; vB: number }[]
}
