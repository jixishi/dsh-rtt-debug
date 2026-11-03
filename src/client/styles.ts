/**
 * Panel styles.
 *
 * Injected as a plain stylesheet string rather than imported as CSS: the client
 * bundle is a single factory function with no CSS pipeline behind it, so a
 * `import './panel.css'` would have nothing to resolve it.
 *
 * Every rule is scoped under `.rttd-root` so the panel cannot leak styles into
 * the host UI, and colours come from the host's theme tokens with fallbacks, so
 * the panel follows light/dark without its own theme switch.
 */

export const PANEL_CSS = `
.rttd-root {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, var(--dsw-alias-text-primary, #e9ecef));
  background: var(--dsw-alias-bg-base, transparent);
}

/* ── toolbars ─────────────────────────────────────────────────────────── */

.rttd-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2));
}

.rttd-toolbar-sub { background: var(--dsw-alias-bg-subtle, rgba(127,127,127,0.06)); }

.rttd-spacer { flex: 1 1 auto; }

.rttd-label { opacity: 0.7; }

.rttd-btn {
  font: inherit;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  color: inherit;
  background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.12));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
}
.rttd-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-strong, rgba(127,127,127,0.6)); }
.rttd-btn:disabled { opacity: 0.45; cursor: default; }
.rttd-btn-sm { padding: 1px 6px; font-size: 11px; }
.rttd-btn-active {
  background: var(--dsw-alias-accent, #4dabf7);
  border-color: var(--dsw-alias-accent, #4dabf7);
  color: #fff;
}

.rttd-status { font-weight: 600; }
.rttd-status-error { color: #ff6b6b; }
.rttd-status-running, .rttd-status-attached { color: #69db7c; }
.rttd-error {
  color: #ff6b6b;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rttd-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 11px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
  opacity: 0.75;
}
.rttd-chip-on { opacity: 1; border-color: var(--dsw-alias-accent, #4dabf7); }
.rttd-chip-off { opacity: 0.35; text-decoration: line-through; }
.rttd-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-text-secondary, #868e96);
}
.rttd-chip-on .rttd-dot { background: #69db7c; }

/* ── split layout ─────────────────────────────────────────────────────── */

.rttd-split {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.rttd-pane { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.rttd-pane-plot { flex: 0 0 auto; }
.rttd-pane-log { flex: 1 1 auto; }

.rttd-divider {
  flex: 0 0 auto;
  height: 6px;
  cursor: row-resize;
  background: var(--dsw-alias-bg-subtle, rgba(127,127,127,0.1));
  border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2));
  border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2));
}
.rttd-divider:hover { background: var(--dsw-alias-accent, #4dabf7); opacity: 0.5; }

/* ── plot ─────────────────────────────────────────────────────────────── */

.rttd-canvas-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.rttd-canvas { display: block; width: 100%; height: 100%; touch-action: none; }

.rttd-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 24px;
  opacity: 0.55;
  pointer-events: none;
}

.rttd-legend { display: flex; flex-wrap: wrap; gap: 4px; }

.rttd-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: inherit;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  cursor: pointer;
  color: inherit;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
  opacity: 0.5;
}
.rttd-legend-item.rttd-legend-on { opacity: 1; }
.rttd-swatch { width: 8px; height: 8px; border-radius: 2px; }

.rttd-picker {
  position: absolute;
  z-index: 5;
  margin-top: 22px;
  max-height: 40vh;
  overflow: auto;
  padding: 6px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-elevated, #2b2f36);
  border: 1px solid var(--dsw-alias-border-strong, rgba(127,127,127,0.5));
  box-shadow: 0 6px 20px rgba(0,0,0,0.35);
}
.rttd-picker-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; white-space: nowrap; }

/* ── readout strip ────────────────────────────────────────────────────── */

.rttd-readout {
  flex: 0 0 auto;
  max-height: 22%;
  overflow: auto;
  padding: 4px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2));
}
.rttd-readout-row { display: flex; gap: 8px; }
.rttd-readout-key { min-width: 88px; opacity: 0.7; }
.rttd-readout-val { white-space: pre; }
.rttd-readout-hint { opacity: 0.5; }

/* ── log ──────────────────────────────────────────────────────────────── */

.rttd-log-wrap { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }

.rttd-log {
  flex: 1 1 auto;
  overflow: auto;
  padding: 4px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
}

.rttd-log-line { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-word; }
.rttd-log-ts { opacity: 0.5; flex: 0 0 auto; }
.rttd-log-level { flex: 0 0 42px; opacity: 0.85; }
.rttd-log-text { flex: 1 1 auto; }

.rttd-log-level-error { color: #ff6b6b; }
.rttd-log-level-warn  { color: #ffd43b; }
.rttd-log-level-info  { color: #4dabf7; }
.rttd-log-level-debug { color: #868e96; }
.rttd-log-level-unknown { color: var(--dsw-alias-text-secondary, #adb5bd); }

.rttd-log-warn  { background: rgba(255, 212, 59, 0.07); }
.rttd-log-error { background: rgba(255, 107, 107, 0.1); }

.rttd-jump {
  position: absolute;
  right: 16px;
  bottom: 12px;
  font: inherit;
  padding: 4px 10px;
  border-radius: 12px;
  cursor: pointer;
  color: #fff;
  background: var(--dsw-alias-accent, #4dabf7);
  border: none;
  box-shadow: 0 2px 10px rgba(0,0,0,0.3);
}

.rttd-input {
  font: inherit;
  padding: 2px 6px;
  min-width: 140px;
  border-radius: 4px;
  color: inherit;
  background: var(--dsw-alias-bg-base, rgba(127,127,127,0.08));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
}

.rttd-check { display: inline-flex; align-items: center; gap: 3px; }
.rttd-counter { opacity: 0.7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ── variable-sources modal overlay (centered in pane) ─────────────────── */

.rttd-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}

.rttd-sources {
  position: relative;
  z-index: 51;
  width: min(560px, 92%);
  max-height: 80%;
  overflow: auto;
  padding: 14px 16px;
  border-radius: 8px;
  text-align: left;
  font-weight: 400;
  background: var(--dsw-alias-bg-elevated, #2b2f36);
  border: 1px solid var(--dsw-alias-border-strong, rgba(127,127,127,0.5));
  box-shadow: 0 12px 32px rgba(0,0,0,0.55);
}

.rttd-sources-title {
  font-weight: 600;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rttd-sources-section {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2));
}
.rttd-sources-section:first-of-type { margin-top: 0; border-top: none; padding-top: 0; }

.rttd-sources-heading { font-weight: 600; opacity: 0.85; margin-bottom: 4px; }

.rttd-sources-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 8px;
  align-items: center;
}

.rttd-sources-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 2px 0;
}

.rttd-sources-input {
  font: inherit;
  padding: 2px 6px;
  height: 26px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border-radius: 4px;
  color: inherit;
  background: var(--dsw-alias-bg-base, rgba(127,127,127,0.08));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
}
.rttd-sources-input-sm { width: 80px; }

.rttd-browse-btn {
  white-space: nowrap !important;
  flex: 0 0 auto !important;
  padding: 0 10px !important;
  height: 26px !important;
  line-height: 24px !important;
  font-size: 11px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-sizing: border-box !important;
  margin: 0 !important;
}

.rttd-sources-list {
  max-height: 24vh;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
  border-radius: 4px;
  padding: 2px 4px;
  margin-top: 4px;
}

.rttd-sources-symbol {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 88px 52px 60px;
  gap: 6px;
  align-items: center;
  padding: 1px 2px;
  white-space: nowrap;
}
.rttd-sources-symbol-name { overflow: hidden; text-overflow: ellipsis; }

.rttd-sources-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
.rttd-sources-table th, .rttd-sources-table td {
  text-align: left;
  padding: 2px 4px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.15));
  white-space: nowrap;
}
.rttd-sources-table th { opacity: 0.7; font-weight: 500; }
.rttd-sources-table td:first-child { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.rttd-sources-table td:last-child { text-align: right; }

.rttd-sources-note { opacity: 0.7; margin-top: 4px; }
.rttd-sources-hint { opacity: 0.55; }
.rttd-sources-error { color: #ff6b6b; margin-top: 4px; }
.rttd-sources-ok { color: #69db7c; margin-top: 4px; }
.rttd-sources-reasons { margin: 2px 0 0 14px; padding: 0; }
.rttd-sources-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.rttd-sources-actions { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rttd-sources-scope-info {
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--dsw-alias-bg-subtle, rgba(255,255,255,0.06));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.1));
  display: flex;
  align-items: center;
  gap: 6px;
}
.rttd-btn-primary {
  background: var(--dsw-alias-accent, #1971c2) !important;
  border-color: var(--dsw-alias-accent, #1971c2) !important;
  color: #fff !important;
  font-weight: 500;
}
.rttd-btn-primary:hover:not(:disabled) {
  background: #1864ab !important;
}

/* ── unit mode toggle (ms / Hz) ── */
.rttd-unit-selector {
  display: inline-flex;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
}
.rttd-unit-btn {
  font: inherit;
  font-size: 11px;
  padding: 1px 6px;
  border: none;
  background: var(--dsw-alias-bg-base, rgba(127,127,127,0.1));
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
}
.rttd-unit-btn:hover { opacity: 1; }
.rttd-unit-btn-active {
  background: var(--dsw-alias-accent, #4dabf7);
  color: #fff;
  opacity: 1;
  font-weight: 600;
}

/* ── driver tabs (OpenOCD / J-Link) ──
   A segmented control, not two loose buttons: the two backends are mutually
   exclusive answers to one question, and the underline reads as "the active
   one" without adding another border to an already dense drawer. */
.rttd-tabs {
  display: flex;
  gap: 2px;
  margin: 2px 0 6px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25));
}
.rttd-tab {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
  margin-bottom: -1px;
}
.rttd-tab:hover { opacity: 0.9; }
.rttd-tab-active {
  opacity: 1;
  font-weight: 600;
  border-bottom-color: var(--dsw-alias-accent, #4dabf7);
}

/* ── time-axis division input ── */
.rttd-divisions-input {
  width: 56px;
  text-align: center;
}

/* ── parser editor controls ── */
.rttd-sources-select {
  min-width: 110px;
  height: 22px;
  padding: 0 4px;
}
.rttd-sources-label {
  display: block;
  font-size: 11px;
  opacity: 0.75;
  margin-bottom: 3px;
}
/* The custom expression is code: monospace, and it must be able to wrap. */
.rttd-sources-textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  padding: 5px 6px;
  border-radius: 4px;
  resize: vertical;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3));
  background: var(--dsw-alias-bg-base, rgba(127,127,127,0.08));
  color: inherit;
}
.rttd-sources-textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-accent, #4dabf7);
}

/* ── file picker dialog ── */
.rttd-fp-modal {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(3px);
}
.rttd-fp-container {
  width: min(520px, 92%);
  max-height: 75%;
  background: var(--dsw-alias-bg-elevated, #24272e);
  border: 1px solid var(--dsw-alias-border-strong, rgba(127,127,127,0.5));
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 40px rgba(0,0,0,0.6);
  color: var(--dsw-alias-text-primary, #e9ecef);
}
.rttd-fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 13px;
}
.rttd-fp-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.rttd-fp-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: rgba(0,0,0,0.25);
  padding: 2px 6px;
  border-radius: 4px;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rttd-fp-candidates {
  margin-bottom: 8px;
  padding: 6px 8px;
  background: rgba(77, 171, 247, 0.1);
  border: 1px solid rgba(77, 171, 247, 0.3);
  border-radius: 6px;
}
.rttd-fp-candidates-title {
  font-size: 11px;
  font-weight: 600;
  color: #74c0fc;
  margin-bottom: 4px;
}
.rttd-fp-candidates-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.rttd-fp-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(77, 171, 247, 0.2);
  border: 1px solid rgba(77, 171, 247, 0.4);
  color: #a5d8ff;
  cursor: pointer;
  transition: all 0.15s ease;
}
.rttd-fp-chip:hover {
  background: var(--dsw-alias-accent, #4dabf7);
  color: #fff;
}
.rttd-fp-list {
  flex: 1 1 auto;
  min-height: 180px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25));
  border-radius: 4px;
  padding: 4px;
  background: rgba(0,0,0,0.15);
}
.rttd-fp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s;
}
.rttd-fp-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.rttd-fp-item-dir {
  color: #ffd43b;
  font-weight: 500;
}
.rttd-fp-item-file {
  color: inherit;
}
.rttd-fp-footer {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ── canvas panning indicator ── */
.rttd-canvas {
  cursor: grab;
}
.rttd-canvas:active {
  cursor: grabbing;
}
.rttd-jump-live {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 12px;
  background: #f59f00;
  border: 1px solid #d9480f;
  color: #fff;
  cursor: pointer;
  animation: rttd-pulse 2s infinite;
}
@keyframes rttd-pulse {
  0% { opacity: 0.9; }
  50% { opacity: 1; filter: brightness(1.2); }
  100% { opacity: 0.9; }
}

/* ── theme switching adaptations (light / dark mode) ── */
body[data-ds-dark-theme] .rttd-root {
  --dsw-alias-text-primary: #e9ecef;
  color: var(--dsw-alias-label-primary, #e9ecef);
}
body[data-ds-dark-theme] .rttd-sources,
body[data-ds-dark-theme] .rttd-fp-container {
  background: var(--dsw-alias-bg-layer-2, #26292e);
  color: var(--dsw-alias-label-primary, #f9fafb);
  border-color: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.18));
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65);
}
body[data-ds-dark-theme] .rttd-fp-item-dir {
  color: #ffd43b;
}

body:not([data-ds-dark-theme]) .rttd-root {
  --dsw-alias-text-primary: #0f1115;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-bg-base, #ffffff);
}
body:not([data-ds-dark-theme]) .rttd-toolbar {
  border-bottom-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
body:not([data-ds-dark-theme]) .rttd-toolbar-sub {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.03));
}
body:not([data-ds-dark-theme]) .rttd-sources,
body:not([data-ds-dark-theme]) .rttd-fp-container {
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #0f1115);
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.15));
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.15);
}
body:not([data-ds-dark-theme]) .rttd-modal-backdrop,
body:not([data-ds-dark-theme]) .rttd-fp-modal {
  background: rgba(0, 0, 0, 0.35);
}
body:not([data-ds-dark-theme]) .rttd-sources-input,
body:not([data-ds-dark-theme]) .rttd-input {
  background: var(--dsw-alias-bg-layer-1, #f4f5f6);
  color: var(--dsw-alias-label-primary, #0f1115);
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
}
body:not([data-ds-dark-theme]) .rttd-fp-path {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-primary, #0f1115);
}
body:not([data-ds-dark-theme]) .rttd-fp-list,
body:not([data-ds-dark-theme]) .rttd-sources-list {
  background: var(--dsw-alias-bg-layer-1, #fafafa);
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
}
body:not([data-ds-dark-theme]) .rttd-fp-item-dir {
  color: #d9480f;
}
body:not([data-ds-dark-theme]) .rttd-fp-item-file {
  color: #1e293b;
}
body:not([data-ds-dark-theme]) .rttd-fp-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
body:not([data-ds-dark-theme]) .rttd-btn {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.06));
  border-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
  color: var(--dsw-alias-label-primary, #0f1115);
}
body:not([data-ds-dark-theme]) .rttd-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.1));
  border-color: var(--dsw-alias-border-strong, rgba(0, 0, 0, 0.3));
}
body:not([data-ds-dark-theme]) .rttd-btn-active {
  background: var(--dsw-alias-accent, #1971c2);
  border-color: var(--dsw-alias-accent, #1971c2);
  color: #ffffff;
}
body:not([data-ds-dark-theme]) .rttd-divider {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.08));
  border-top-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-bottom-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
body:not([data-ds-dark-theme]) .rttd-readout {
  border-top-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-primary, #0f1115);
}
body:not([data-ds-dark-theme]) .rttd-sources-scope-info {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.04));
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-secondary, #475569);
}
body:not([data-ds-dark-theme]) .rttd-log-level-debug {
  color: #475569;
}
body:not([data-ds-dark-theme]) .rttd-log-level-unknown {
  color: #64748b;
}
`
