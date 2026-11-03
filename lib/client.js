// dsh-rtt-debug — browser half.
// Registers a factory with the shell module table; nothing executes until
// the tab is first opened (materialization), which is the lazy-CJS contract.
window.__ModuleLoader__.load({
	id: "dsh-rtt-debug",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/client/transport.ts
		const BASE = "/api/rtt-debug";
		async function request(path, init) {
			const response = await fetch(`${BASE}${path}`, {
				...init,
				headers: {
					"content-type": "application/json",
					...init?.headers ?? {}
				}
			});
			const text = await response.text();
			const payload = text === "" ? void 0 : JSON.parse(text);
			if (!response.ok) {
				const message = payload?.error ?? `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}
		/** Session-scoped query suffix, so the host can resolve the workspace root. */
		function scope(sessionId) {
			return sessionId === void 0 ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
		}
		const api = {
			snapshot: (sessionId) => request(`/snapshot${scope(sessionId)}`),
			start: (sessionId) => request(`/start${scope(sessionId)}`, {
				method: "POST",
				body: "{}"
			}),
			stop: (sessionId) => request(`/stop${scope(sessionId)}`, {
				method: "POST",
				body: "{}"
			}),
			clear: (what, sessionId) => request(`/clear${scope(sessionId)}`, {
				method: "POST",
				body: JSON.stringify({ what })
			}),
			getConfig: (sessionId) => request(`/config${scope(sessionId)}`, {
				method: "POST",
				body: "{}"
			}),
			setConfig: (config, sessionId, target) => request(`/config${scope(sessionId)}`, {
				method: "POST",
				body: JSON.stringify({
					config,
					...target ? { target } : {}
				})
			}),
			setProfile: (profileId, sessionId) => request(`/config${scope(sessionId)}`, {
				method: "POST",
				body: JSON.stringify({ profileId })
			}),
			addProfile: (name, sessionId) => request(`/profiles/add${scope(sessionId)}`, {
				method: "POST",
				body: JSON.stringify({ name })
			}),
			listFiles: (dir, ext, sessionId) => {
				const q = new URLSearchParams();
				if (dir !== void 0 && dir !== "") q.set("dir", dir);
				if (ext !== void 0 && ext !== "") q.set("ext", ext);
				if (sessionId !== void 0 && sessionId !== "") q.set("sessionId", sessionId);
				const qs = q.toString();
				return request(`/fs/list${qs ? `?${qs}` : ""}`);
			},
			discoverFiles: (type, sessionId) => {
				const q = new URLSearchParams({ type });
				if (sessionId !== void 0 && sessionId !== "") q.set("sessionId", sessionId);
				return request(`/fs/discover?${q.toString()}`);
			},
			/** Resolve an ELF's symbols for the OCD reader's variable picker. */
			symbols: (elfPath, nmPath, filter, sessionId) => request(`/symbols${scope(sessionId)}`, {
				method: "POST",
				body: JSON.stringify({
					elfPath,
					nmPath,
					filter
				})
			}),
			ocdVars: (elfPath, variables, sessionId) => request(`/ocd-vars${scope(sessionId)}`, {
				method: "POST",
				body: JSON.stringify({
					elfPath,
					variables
				})
			}),
			exportUrl: (sessionId) => `${BASE}/export${scope(sessionId)}`
		};
		/**
		* A reconnecting socket.
		*
		* The panel keeps working while the host restarts: the socket retries with
		* backoff and reports its connection state so the toolbar can show it.
		*/
		var LiveSocket = class {
			socket;
			closed = false;
			attempt = 0;
			timer;
			url;
			onMessage;
			onState;
			constructor(path, sessionId, onMessage, onState) {
				const proto = location.protocol === "https:" ? "wss:" : "ws:";
				const query = sessionId === void 0 ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
				this.url = `${proto}//${location.host}${BASE}${path}${query}`;
				this.onMessage = onMessage;
				this.onState = onState;
				this.open();
			}
			open() {
				if (this.closed) return;
				const socket = new WebSocket(this.url);
				this.socket = socket;
				socket.onopen = () => {
					this.attempt = 0;
					this.onState(true);
				};
				socket.onmessage = (event) => {
					try {
						this.onMessage(JSON.parse(String(event.data)));
					} catch {}
				};
				socket.onclose = () => {
					this.onState(false);
					this.schedule();
				};
				socket.onerror = () => {};
			}
			schedule() {
				if (this.closed) return;
				this.attempt += 1;
				const delay = Math.min(500 * Math.pow(1.8, this.attempt - 1), 1e4);
				this.timer = setTimeout(() => this.open(), delay);
			}
			close() {
				this.closed = true;
				if (this.timer !== void 0) clearTimeout(this.timer);
				this.socket?.close();
				this.socket = void 0;
			}
		};
		// src/client/plot.ts
		/** Palette used for series, assigned by index and stable per series name. */
		const SERIES_COLORS = [
			"#4dabf7",
			"#ffd43b",
			"#69db7c",
			"#ff8787",
			"#b197fc",
			"#4dd4c4",
			"#ffa94d",
			"#f783ac",
			"#a9e34b",
			"#9775fa"
		];
		/** Colour for a series, derived from its position in the stable name list. */
		function colorFor(name, allNames) {
			const index = allNames.indexOf(name);
			const palette = SERIES_COLORS;
			return palette[(index < 0 ? 0 : index) % palette.length];
		}
		/** Resolve theme colors dynamically, responding to DSH's light/dark mode. */
		function resolvePlotTheme() {
			if (typeof document !== "undefined" ? document.body?.hasAttribute("data-ds-dark-theme") || document.documentElement?.getAttribute("data-theme") === "dark" || document.documentElement?.classList.contains("dark") || window?.matchMedia?.("(prefers-color-scheme: dark)")?.matches : true) return {
				background: "transparent",
				grid: "rgba(255,255,255,0.08)",
				gridStrong: "rgba(255,255,255,0.2)",
				axis: "rgba(255,255,255,0.45)",
				text: "#e2e8f0",
				cursor: "#ff922b",
				crosshair: "rgba(255,255,255,0.6)"
			};
			return {
				background: "transparent",
				grid: "rgba(0,0,0,0.08)",
				gridStrong: "rgba(0,0,0,0.18)",
				axis: "rgba(0,0,0,0.45)",
				text: "#1e293b",
				cursor: "#e8590c",
				crosshair: "rgba(0,0,0,0.5)"
			};
		}
		/** Left/bottom margins reserved for the axes' tick labels. */
		const MARGIN = {
			left: 70,
			right: 14,
			top: 12,
			bottom: 28
		};
		/**
		* Compute the drawing area inside the canvas.
		* @returns sizes in CSS pixels (the caller scales the context for DPR).
		*/
		function plotMetrics(width, height) {
			return {
				left: MARGIN.left,
				top: MARGIN.top,
				width: Math.max(10, width - MARGIN.left - MARGIN.right),
				height: Math.max(10, height - MARGIN.top - MARGIN.bottom)
			};
		}
		/**
		* Choose a "nice" tick step at or above a raw interval.
		*
		* Steps land on 1/2/5 × 10^n so labels read as round numbers, which is what
		* makes a ruler usable.
		*/
		function niceStep(rawStep) {
			if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
			const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
			const normalized = rawStep / magnitude;
			return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
		}
		/** Tick values covering [min, max], at most `maxTicks` of them. */
		function ticksFor(min, max, maxTicks) {
			if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
			const step = niceStep((max - min) / Math.max(1, maxTicks));
			const first = Math.ceil(min / step) * step;
			const out = [];
			for (let value = first; value <= max + step * 1e-9; value += step) {
				out.push(Number(value.toFixed(12)));
				if (out.length > 512) break;
			}
			return out;
		}
		/** Clamp a requested division count into the supported band. */
		function clampTimeDivisions(value) {
			if (!Number.isFinite(value)) return 50;
			return Math.min(200, Math.max(2, Math.round(value)));
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
		function timeLabelStride(metrics, divisions, minLabelSpacingPx = 46) {
			const count = clampTimeDivisions(divisions);
			const spacing = metrics.width / Math.max(1, count);
			if (spacing >= minLabelSpacingPx) return 1;
			return Math.min(count, Math.ceil(minLabelSpacingPx / Math.max(1, spacing)));
		}
		/** Format a value compactly, using an SI-ish suffix for large/small numbers. */
		function formatValue(value, unit) {
			if (!Number.isFinite(value)) return "—";
			const abs = Math.abs(value);
			let text;
			const clean = (n, maxDec = 2) => {
				return n.toFixed(maxDec).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
			};
			if (abs === 0) text = "0";
			else if (abs >= 1e9) text = `${clean(value / 1e9)}G`;
			else if (abs >= 1e6) text = `${clean(value / 1e6)}M`;
			else if (abs >= 1e3) text = `${clean(value / 1e3)}k`;
			else if (abs >= 1) text = clean(value, abs >= 100 ? 0 : 2);
			else if (abs >= .001) text = `${clean(value * 1e3)}m`;
			else if (abs >= 1e-6) text = `${clean(value * 1e6)}µ`;
			else text = value.toExponential(2);
			return unit === void 0 ? text : `${text} ${unit}`;
		}
		/** Format a duration for a time-axis label. */
		function formatTime(ms) {
			const abs = Math.abs(ms);
			if (abs < 1e3) return `${ms.toFixed(0)}ms`;
			if (abs < 6e4) return `${(ms / 1e3).toFixed(2)}s`;
			if (abs < 36e5) {
				const totalSeconds = ms / 1e3;
				const minutes = Math.floor(totalSeconds / 60);
				return `${minutes}m${(totalSeconds - minutes * 60).toFixed(0)}s`;
			}
			return `${(ms / 36e5).toFixed(2)}h`;
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
		function decimateToPixels(series, viewport, metrics) {
			const width = Math.max(1, Math.floor(metrics.width));
			const lows = new Float64Array(width).fill(NaN);
			const highs = new Float64Array(width).fill(NaN);
			if (viewport.tMax - viewport.tMin <= 0 || series.ts.length === 0) return {
				lows,
				highs,
				firstIndex: 0
			};
			let low = 0;
			let high = series.ts.length - 1;
			let firstIndex = series.ts.length;
			while (low <= high) {
				const mid = low + high >> 1;
				if (series.ts[mid] < viewport.tMin) low = mid + 1;
				else {
					firstIndex = mid;
					high = mid - 1;
				}
			}
			for (let i = firstIndex; i < series.ts.length; i += 1) {
				const ts = series.ts[i];
				if (ts > viewport.tMax) break;
				const raw = series.values[i];
				if (typeof raw === "boolean") {
					const asNumber = raw ? 1 : 0;
					const column = columnFor(ts, viewport, metrics);
					if (column < 0 || column >= width) continue;
					mergeColumn(lows, highs, column, asNumber);
					continue;
				}
				if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
				const column = columnFor(ts, viewport, metrics);
				if (column < 0 || column >= width) continue;
				mergeColumn(lows, highs, column, raw);
			}
			return {
				lows,
				highs,
				firstIndex
			};
		}
		/** Map a timestamp to its pixel column. */
		function columnFor(ts, viewport, metrics) {
			const span = viewport.tMax - viewport.tMin;
			if (span <= 0) return 0;
			return Math.round((ts - viewport.tMin) / span * (metrics.width - 1));
		}
		function mergeColumn(lows, highs, column, value) {
			const existingLow = lows[column];
			const existingHigh = highs[column];
			lows[column] = Number.isNaN(existingLow) ? value : Math.min(existingLow, value);
			highs[column] = Number.isNaN(existingHigh) ? value : Math.max(existingHigh, value);
		}
		/** Map a value to its y pixel (inside the plot area). */
		function valueToY(value, viewport, metrics) {
			const span = viewport.vMax - viewport.vMin;
			if (span <= 0) return metrics.top + metrics.height / 2;
			const ratio = (value - viewport.vMin) / span;
			return metrics.top + metrics.height * (1 - ratio);
		}
		/** Map a timestamp to its x pixel (inside the plot area). */
		function timeToX(ts, viewport, metrics) {
			const span = viewport.tMax - viewport.tMin;
			if (span <= 0) return metrics.left;
			return metrics.left + (ts - viewport.tMin) / span * metrics.width;
		}
		/** Inverse of `timeToX` — where a pixel column sits on the time axis. */
		function xToTime(x, viewport, metrics) {
			const ratio = (x - metrics.left) / metrics.width;
			return viewport.tMin + ratio * (viewport.tMax - viewport.tMin);
		}
		/** Inverse of `valueToY`. */
		function yToValue(y, viewport, metrics) {
			const ratio = 1 - (y - metrics.top) / metrics.height;
			return viewport.vMin + ratio * (viewport.vMax - viewport.vMin);
		}
		/**
		* Render one frame.
		*
		* The caller is responsible for the device-pixel-ratio transform; everything
		* here works in CSS pixels.
		*/
		function drawPlot(options) {
			const { ctx, width, height, viewport, series, visible, cursors, pointer } = options;
			const theme = options.theme ?? resolvePlotTheme();
			const metrics = plotMetrics(width, height);
			ctx.clearRect(0, 0, width, height);
			if (theme.background !== "transparent") {
				ctx.fillStyle = theme.background;
				ctx.fillRect(0, 0, width, height);
			}
			drawGrid(ctx, metrics, viewport, theme, options.timeDivisions);
			drawSeries(ctx, metrics, viewport, series, visible, theme);
			drawCursors(ctx, metrics, viewport, cursors, theme);
			if (pointer !== void 0) drawCrosshair(ctx, metrics, viewport, pointer, series, visible, theme);
		}
		function drawGrid(ctx, metrics, viewport, theme, timeDivisions) {
			const divisions = clampTimeDivisions(timeDivisions ?? 50);
			const span = viewport.tMax - viewport.tMin;
			const step = span > 0 ? span / divisions : 0;
			const xTicks = [];
			for (let i = 0; i <= divisions && step > 0; i += 1) {
				xTicks.push(viewport.tMin + step * i);
				if (xTicks.length > 512) break;
			}
			const yTicks = ticksFor(viewport.vMin, viewport.vMax, 6);
			const labelStride = timeLabelStride(metrics, divisions);
			ctx.save();
			ctx.lineWidth = 1;
			ctx.font = "500 12px ui-monospace, SFMono-Regular, Menlo, monospace";
			ctx.fillStyle = theme.text;
			ctx.strokeStyle = theme.grid;
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			for (const value of yTicks) {
				const y = Math.round(valueToY(value, viewport, metrics)) + .5;
				if (y < metrics.top || y > metrics.top + metrics.height) continue;
				ctx.beginPath();
				ctx.moveTo(metrics.left, y);
				ctx.lineTo(metrics.left + metrics.width, y);
				ctx.stroke();
				ctx.fillText(formatValue(value), metrics.left - 8, y);
			}
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			for (const [index, ts] of xTicks.entries()) {
				if (index % labelStride !== 0) continue;
				const x = Math.round(timeToX(ts, viewport, metrics)) + .5;
				if (x < metrics.left || x > metrics.left + metrics.width) continue;
				ctx.beginPath();
				ctx.moveTo(x, metrics.top);
				ctx.lineTo(x, metrics.top + metrics.height);
				ctx.stroke();
				ctx.fillText(formatTime(ts - viewport.tMax), x, metrics.top + metrics.height + 8);
			}
			ctx.strokeStyle = theme.axis;
			ctx.beginPath();
			ctx.moveTo(metrics.left + .5, metrics.top);
			ctx.lineTo(metrics.left + .5, metrics.top + metrics.height + .5);
			ctx.lineTo(metrics.left + metrics.width, metrics.top + metrics.height + .5);
			ctx.stroke();
			ctx.restore();
		}
		function drawSeries(ctx, metrics, viewport, series, visible, theme) {
			const names = series.map((s) => s.name);
			ctx.save();
			ctx.beginPath();
			ctx.rect(metrics.left, metrics.top, metrics.width, metrics.height);
			ctx.clip();
			const GAP_THRESHOLD_MS = 5e3;
			for (const entry of series) {
				if (!visible.has(entry.name)) continue;
				const len = entry.ts.length;
				if (len === 0) continue;
				const strokeColor = colorFor(entry.name, names);
				ctx.strokeStyle = strokeColor;
				ctx.lineWidth = 1.8;
				ctx.lineJoin = "round";
				ctx.lineCap = "round";
				let start = 0;
				let end = len - 1;
				let l = 0, r = len - 1;
				while (l <= r) {
					const mid = l + r >> 1;
					if (entry.ts[mid] < viewport.tMin) {
						start = mid;
						l = mid + 1;
					} else r = mid - 1;
				}
				l = 0;
				r = len - 1;
				while (l <= r) {
					const mid = l + r >> 1;
					if (entry.ts[mid] > viewport.tMax) {
						end = mid;
						r = mid - 1;
					} else l = mid + 1;
				}
				if (Math.max(0, end - start + 1) <= metrics.width * 2) {
					ctx.beginPath();
					let drawing = false;
					let lastTs = 0;
					const pointsToDraw = [];
					for (let i = start; i <= end; i += 1) {
						const ts = entry.ts[i];
						const raw = entry.values[i];
						const val = typeof raw === "boolean" ? raw ? 1 : 0 : raw;
						if (typeof val !== "number" || !Number.isFinite(val)) {
							drawing = false;
							continue;
						}
						const x = timeToX(ts, viewport, metrics);
						const y = valueToY(val, viewport, metrics);
						if (drawing && ts - lastTs > GAP_THRESHOLD_MS) drawing = false;
						if (!drawing) {
							ctx.moveTo(x, y);
							drawing = true;
						} else ctx.lineTo(x, y);
						lastTs = ts;
						pointsToDraw.push([x, y]);
					}
					ctx.stroke();
					if (pointsToDraw.length <= 120) {
						ctx.fillStyle = strokeColor;
						for (const [px, py] of pointsToDraw) if (px >= metrics.left - 4 && px <= metrics.left + metrics.width + 4) {
							ctx.beginPath();
							ctx.arc(px, py, 3, 0, Math.PI * 2);
							ctx.fill();
						}
					}
				} else {
					const { lows, highs } = decimateToPixels(entry, viewport, metrics);
					ctx.beginPath();
					let lastCol = -1;
					for (let column = 0; column < lows.length; column += 1) {
						const low = lows[column];
						if (Number.isNaN(low)) continue;
						const high = highs[column];
						const x = metrics.left + column;
						const yHigh = valueToY(high, viewport, metrics);
						const yLow = valueToY(low, viewport, metrics);
						if (lastCol === -1) ctx.moveTo(x, yHigh);
						else if (xToTime(x, viewport, metrics) - xToTime(metrics.left + lastCol, viewport, metrics) > GAP_THRESHOLD_MS) ctx.moveTo(x, yHigh);
						else ctx.lineTo(x, yHigh);
						if (yLow !== yHigh) ctx.lineTo(x, yLow);
						lastCol = column;
					}
					ctx.stroke();
				}
			}
			ctx.restore();
		}
		function drawCursors(ctx, metrics, viewport, cursors, theme) {
			const drawn = [];
			for (const column of ["A", "B"]) {
				const cursor = column === "A" ? cursors.a : cursors.b;
				if (cursor === void 0) continue;
				const x = timeToX(cursor.t, viewport, metrics);
				if (x < metrics.left || x > metrics.left + metrics.width) continue;
				drawn.push({
					x,
					label: column,
					cursor
				});
			}
			if (drawn.length === 0) return;
			ctx.save();
			ctx.strokeStyle = theme.cursor;
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			for (const { x, label, cursor } of drawn) {
				ctx.beginPath();
				ctx.moveTo(x + .5, metrics.top);
				ctx.lineTo(x + .5, metrics.top + metrics.height);
				ctx.stroke();
				ctx.setLineDash([]);
				const y = valueToY(cursor.v, viewport, metrics);
				ctx.beginPath();
				ctx.arc(x, y, 3, 0, Math.PI * 2);
				ctx.fillStyle = theme.cursor;
				ctx.fill();
				ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
				ctx.textAlign = "center";
				ctx.textBaseline = "bottom";
				ctx.fillStyle = theme.cursor;
				ctx.fillText(label, x, metrics.top - 1);
				ctx.setLineDash([4, 3]);
			}
			ctx.restore();
		}
		function drawCrosshair(ctx, metrics, viewport, pointer, series, visible, theme) {
			if (pointer.x < metrics.left || pointer.x > metrics.left + metrics.width) return;
			if (pointer.y < metrics.top || pointer.y > metrics.top + metrics.height) return;
			ctx.save();
			ctx.strokeStyle = theme.crosshair;
			ctx.lineWidth = 1;
			ctx.setLineDash([2, 3]);
			ctx.beginPath();
			ctx.moveTo(Math.round(pointer.x) + .5, metrics.top);
			ctx.lineTo(Math.round(pointer.x) + .5, metrics.top + metrics.height);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(metrics.left, Math.round(pointer.y) + .5);
			ctx.lineTo(metrics.left + metrics.width, Math.round(pointer.y) + .5);
			ctx.stroke();
			ctx.setLineDash([]);
			const t = xToTime(pointer.x, viewport, metrics);
			const names = series.map((s) => s.name);
			for (const entry of series) {
				if (!visible.has(entry.name)) continue;
				const value = valueAt(entry, t);
				if (value === void 0) continue;
				const y = valueToY(value, viewport, metrics);
				ctx.beginPath();
				ctx.arc(pointer.x, y, 2.5, 0, Math.PI * 2);
				ctx.fillStyle = colorFor(entry.name, names);
				ctx.fill();
			}
			ctx.restore();
		}
		/**
		* Value of a series at (or immediately before) a timestamp.
		*
		* @returns `undefined` when the series has no point at or before `t`, so the
		*   readout shows a dash instead of the nearest future value.
		*/
		function valueAt(series, t) {
			const { ts, values } = series;
			if (ts.length === 0) return void 0;
			let low = 0;
			let high = ts.length - 1;
			let found = -1;
			while (low <= high) {
				const mid = low + high >> 1;
				if (ts[mid] <= t) {
					found = mid;
					low = mid + 1;
				} else high = mid - 1;
			}
			if (found < 0) return void 0;
			const raw = values[found];
			if (typeof raw === "boolean") return raw ? 1 : 0;
			return typeof raw === "number" ? raw : void 0;
		}
		/**
		* Measurement across a cursor pair.
		*
		* The value delta is only meaningful for series that have a sample at or before
		* each cursor; series without one are omitted rather than filled in.
		*
		* @returns `undefined` unless both cursors are placed.
		*/
		function deltaBetween(cursors, series, visible) {
			const { a, b } = cursors;
			if (a === void 0 || b === void 0) return void 0;
			const deltaTimeMs = Math.abs(b.t - a.t);
			const perSeries = [];
			for (const entry of series) {
				if (!visible.has(entry.name)) continue;
				const vA = valueAt(entry, a.t);
				const vB = valueAt(entry, b.t);
				if (vA === void 0 || vB === void 0) continue;
				perSeries.push({
					name: entry.name,
					deltaV: vB - vA,
					vA,
					vB
				});
			}
			return {
				deltaTimeMs,
				frequencyHz: deltaTimeMs > 0 ? 1e3 / deltaTimeMs : Number.POSITIVE_INFINITY,
				perSeries
			};
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
		function measure(series, tMin, tMax) {
			const { ts, values } = series;
			const inside = [];
			for (let i = 0; i < ts.length; i += 1) {
				const t = ts[i];
				if (t < tMin) continue;
				if (t > tMax) break;
				const raw = values[i];
				if (typeof raw === "boolean") inside.push(raw ? 1 : 0);
				else if (typeof raw === "number" && Number.isFinite(raw)) inside.push(raw);
			}
			if (inside.length === 0) return { count: 0 };
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			let sum = 0;
			for (const value of inside) {
				if (value < min) min = value;
				if (value > max) max = value;
				sum += value;
			}
			const result = {
				count: inside.length,
				min,
				max,
				peakToPeak: max - min,
				mean: sum / inside.length
			};
			if (inside.length >= 4) {
				const midpoint = (min + max) / 2;
				const span = max - min;
				const crossings = [];
				for (let i = 1; i < inside.length; i += 1) {
					const previous = inside[i - 1];
					const current = inside[i];
					if (previous < midpoint && current >= midpoint) crossings.push(i);
				}
				if (crossings.length >= 2) {
					const intervals = [];
					for (let i = 1; i < crossings.length; i += 1) intervals.push(crossings[i] - crossings[i - 1]);
					intervals.sort((a, b) => a - b);
					const median = intervals[Math.floor(intervals.length / 2)];
					if (median > 0) {
						result.periodMs = median;
						result.frequencyHz = 1e3 / median;
					}
				}
				if (span > 0) {
					const lowGate = min + span * .1;
					const highGate = min + span * .9;
					const rises = [];
					let lowAt = -1;
					for (let i = 0; i < inside.length; i += 1) {
						const value = inside[i];
						if (lowAt < 0 && value <= lowGate) lowAt = i;
						else if (lowAt >= 0 && value >= highGate) {
							rises.push(i - lowAt);
							lowAt = -1;
						}
					}
					if (rises.length > 0) {
						rises.sort((a, b) => a - b);
						result.riseTimeMs = rises[Math.floor(rises.length / 2)];
					}
				}
			}
			return result;
		}
		// src/ocd/binding-parse.ts
		/** Canonical scalar spellings, accepted verbatim. */
		const DIRECT_TYPES = [
			"i8",
			"u8",
			"i16",
			"u16",
			"i32",
			"u32",
			"f32",
			"f64",
			"bool"
		];
		/**
		* Common C spellings mapped onto the scalar vocabulary.
		*
		* This table is the contract for what a user may type. An absent entry is an
		* ERROR, never a silent default: guessing `u32` for an unrecognised spelling is
		* how a 16-bit quantity ends up decoded at 32 bits, swallowing the neighbouring
		* two bytes with no visible symptom.
		*/
		const TYPE_ALIASES = {
			int8: "i8",
			uint8: "u8",
			char: "i8",
			byte: "u8",
			int16: "i16",
			uint16: "u16",
			short: "i16",
			ushort: "u16",
			int32: "i32",
			uint32: "u32",
			int: "i32",
			unsigned: "u32",
			long: "i32",
			ulong: "u32",
			float: "f32",
			double: "f64",
			boolean: "bool",
			flag: "bool"
		};
		/** `0x20000000` / `0x2000_0000` / `536870912` all accepted. */
		function parseAddress(text) {
			const trimmed = text.trim().replace(/_/g, "");
			if (trimmed === "") return void 0;
			const value = /^0[xX]/.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
			return Number.isNaN(value) || value < 0 ? void 0 : value >>> 0;
		}
		/**
		* Normalise a type spelling; accepts `uint16`, `int16_t`, `u16`, `float`.
		*
		* @param text - the raw spelling, or undefined when the field was omitted.
		* @returns the scalar type, or undefined when the spelling is not recognised.
		*   Callers must treat undefined as "refuse this input", not as "use a default"
		*   — except where the omitted-type shorthand applies (see `parseManualBinding`).
		*/
		function normalizeType(text) {
			if (text === void 0) return void 0;
			const raw = text.trim().toLowerCase().replace(/^std::/, "").replace(/_t$/, "");
			for (const type of DIRECT_TYPES) if (raw === type) return type;
			return TYPE_ALIASES[raw];
		}
		/**
		* Parse one manual binding, reporting WHY it was refused.
		*
		* The panel needs the reason so it can tell the user their type spelling is
		* wrong instead of silently storing a different width. The host's plain
		* `parseManualBinding` keeps its `undefined`-on-failure contract.
		*
		* @param text - the raw field contents.
		* @returns the binding, or a reason the input was refused.
		*/
		function parseManualBindingDetailed(text) {
			const trimmed = text.trim().replace(/^[`'"]|[`'"]$/g, "");
			if (trimmed === "") return {
				ok: false,
				reason: "empty"
			};
			const atForm = /^([A-Za-z_][A-Za-z0-9_.\-[\]$]*)\s*@\s*([^:\s]+)(?::\s*([A-Za-z0-9_]+))?$/.exec(trimmed);
			if (atForm !== null) {
				const address = parseAddress(atForm[2] ?? "");
				if (address === void 0) return {
					ok: false,
					reason: "unparsable"
				};
				const spelling = atForm[3];
				if (spelling === void 0) return {
					ok: true,
					binding: {
						name: atForm[1],
						address,
						type: "u32"
					}
				};
				const type = normalizeType(spelling);
				if (type === void 0) return {
					ok: false,
					reason: "unknown-type",
					spelling
				};
				return {
					ok: true,
					binding: {
						name: atForm[1],
						address,
						type
					}
				};
			}
			const parts = trimmed.split(":").map((part) => part.trim());
			if (parts.length >= 2) {
				const address = parseAddress(parts[0] ?? "");
				if (address === void 0) return {
					ok: false,
					reason: "unparsable"
				};
				if (parts.length >= 3) {
					const spelling = parts[1];
					const name = parts[2];
					if (name === void 0 || name === "") return {
						ok: false,
						reason: "unparsable"
					};
					const type = normalizeType(spelling);
					if (type === void 0) return {
						ok: false,
						reason: "unknown-type",
						spelling
					};
					return {
						ok: true,
						binding: {
							name,
							address,
							type
						}
					};
				}
				const name = parts[1];
				if (name === void 0 || name === "") return {
					ok: false,
					reason: "unparsable"
				};
				return {
					ok: true,
					binding: {
						name,
						address,
						type: "u32"
					}
				};
			}
			return {
				ok: false,
				reason: "unparsable"
			};
		}
		// src/client/locales.ts
		const ZH = {
			"tab.title": "RTT 调试",
			"tab.description": "实时变量波形（上方）与完整 RTT 日志（下方）；三路数据源可独立启停。",
			"status.loading": "加载中…",
			"status.running": "{backend} 运行中（pid {pid}）",
			"status.attached": "已连接现有 {backend}",
			"status.error": "错误：{message}",
			"status.notReadyPrompt": "（提示：请先在终端启动调试后端，或在「变量源」中完成配置）",
			"status.idle": "未启动",
			"status.probing": "探测中…",
			"status.starting": "启动中…",
			"source.log": "RTT 日志",
			"source.rttVar": "RTT 数据通道",
			"source.ocd": "变量直读",
			"btn.start": "启动",
			"btn.stop": "停止",
			"btn.running": "运行中",
			"btn.clear": "清空",
			"btn.clearAll": "全部清空",
			"btn.close": "关闭",
			"wave.window": "时间窗",
			"wave.cursor": "标尺",
			"wave.cursorClear": "清除标尺",
			"wave.cursorHint": "开启后单击放置游标 A/B；拖动可移动，读数显示 Δt / ΔV / 1÷Δt",
			"wave.autoscale": "自动量程",
			"wave.toggleSeries": "显示/隐藏 {name}",
			"wave.pick": "选择变量（{count}/{total}）",
			"wave.empty": "暂无变量数据。启动数据源后，勾选变量即可看到曲线。",
			"plot.empty": "暂无变量数据。启动数据源后，勾选变量即可看到曲线。",
			"readout.delta": "游标测量",
			"readout.hover": "悬停",
			"log.filterPlaceholder": "过滤关键字…",
			"log.regex": "正则",
			"log.follow": "自动跟随",
			"log.export": "导出",
			"log.jumpToLatest": "回到最新",
			"log.counters": "保留 {retained} / 已收 {total}",
			"log.completenessHint": "「已收」为累计接收行数，独立于环形缓冲，可用于核对日志完整性。",
			"sources.open": "变量源",
			"sources.title": "变量源",
			"sources.rttSection": "RTT 数据通道（只读）",
			"sources.parser": "解析器",
			"sources.parserSection": "解析器（可编辑）",
			"sources.parserId": "类型",
			"sources.parserDelimiter": "分隔符",
			"sources.parserDelimiterHint": "字段分隔符，如 , ; 制表符 \\t 或空格（空格按连续空白切分）。",
			"sources.parserTerminator": "换行标识",
			"sources.parserTerminatorHint": "记录结束符。支持 \\n（默认）、\\r、\\r\\n、\\t、\\0，或直接填一个字符。",
			"sources.parserExpression": "自定义解析表达式",
			"sources.parserExpressionHint": "对每条记录求值，返回一个对象即为变量。可用：fields（已切分的字段数组）、line（原始记录）、index（序号）、Number、Math。",
			"sources.parserSkipFirst": "跳过首行（表头）",
			"sources.parserPattern": "正则",
			"sources.parserPatternHint": "行正则，具名捕获组即变量名。未命名组会被忽略。",
			"sources.parserFlags": "正则标志",
			"sources.parserHasHeader": "首行是表头",
			"sources.parserSave": "保存解析器",
			"sources.parserSaved": "解析器已保存",
			"sources.parserError": "解析器报错：{message}",
			"sources.parserSandboxNote": "自定义表达式在宿主进程内运行，仅允许纯计算：无 require / process / 全局对象，无法访问文件或网络。",
			"sources.rttNone": "尚未发现变量。启动数据源后此处会列出已解析的变量名。",
			"sources.rttFallbackHint": "以下名称来自已收到的曲线数据（解析器尚未回报描述符）。",
			"sources.ocdSection": "OCD 直读（可编辑）",
			"sources.enabled": "启用变量直读",
			"sources.configPath": "OpenOCD 配置",
			"sources.configPathHint": "OpenOCD 配置文件路径（如 openocd.cfg）。未启动时按此配置拉起；若已有 OpenOCD 运行则自动连接。",
			"sources.elfPath": "ELF 路径",
			"sources.elfPathHint": "相对路径按宿主进程的工作目录（CWD）解析——本项不做工作区解析，如需指向当前会话的工作区请使用绝对路径。",
			"sources.nmPath": "nm 路径",
			"sources.nmPathHint": "留空则按 transport 默认值（arm-none-eabi-nm）取符号。",
			"sources.interval": "轮询间隔",
			"sources.intervalUnit": "ms",
			"sources.filter": "筛选",
			"sources.filterPlaceholder": "符号名关键字…",
			"sources.browse": "浏览符号",
			"sources.browsing": "读取中…",
			"sources.browseEmpty": "未找到匹配的符号。",
			"sources.browseHint": "需要先填写 ELF 路径。",
			"sources.browseCount": "找到 {count} 个符号",
			"sources.manualLabel": "手填地址",
			"sources.manualPlaceholder": "如 0x20000000:u16:VoltMv 或 VoltMv@0x20000000:u16",
			"sources.manualHint": "两种写法都支持；类型可省略（默认 u32）。",
			"sources.unit": "单位",
			"sources.unitPlaceholder": "如 mV",
			"sources.add": "添加",
			"sources.manualBad": "无法解析该写法，请检查地址与类型。",
			"sources.configured": "已配置变量（{count}）",
			"sources.configuredEmpty": "尚未配置变量。勾选符号或手填地址后添加。",
			"sources.columnName": "名称",
			"sources.columnAddress": "地址",
			"sources.columnType": "类型",
			"sources.columnUnit": "单位",
			"sources.remove": "移除",
			"sources.save": "保存到当前 Profile",
			"sources.saving": "保存中…",
			"sources.saved": "已保存到 Profile「{name}」，并已持久化。",
			"sources.reload": "重新读取配置",
			"sources.loadFailed": "读取配置失败：{message}",
			"sources.saveFailed": "保存失败：{message}",
			"sources.persistFailed": "配置已生效，但写入持久化设置失败；宿主重启后可能丢失。",
			"sources.unresolved": "以下条目未解析成功，已跳过（不会写入配置）：",
			"sources.unresolvedItem": "{name}：{reason}",
			"sources.needRestartHint": "生效方式：数据源已在运行时，保存会即时按新变量重建 OCD 采样（关闭开关则立即停止直读）；数据源未运行时，保存的变量将在下次 [启动] 时生效。",
			"sources.keepRunningNote": "OCD 直读需要 OpenOCD TCL 端口可达；连接失败会在上方状态栏报错，不会静默。",
			"sources.saveWorkspace": "保存到工作区 (.dsh)",
			"sources.saveWorkspaceHint": "保存到当前工作区的 .dsh/rtt-debug.json（随当前项目管理与版本化）",
			"sources.saveGlobal": "保存到全局设置",
			"sources.saveGlobalHint": "保存到宿主全局设置（~/.dsh/settings.yaml，所有项目共享）",
			"sources.savedWorkspace": "已成功保存至工作区「{path}」",
			"sources.savedGlobal": "已成功保存至全局设置（~/.dsh）",
			"sources.scopeWorkspace": "📁 当前配置：工作区 (.dsh/rtt-debug.json)",
			"sources.scopeGlobal": "🌐 当前配置：全局设置 (~/.dsh)",
			"sources.browseFile": "浏览…",
			"sources.pickerTitleCfg": "选择 OpenOCD 配置文件 (*.cfg)",
			"sources.pickerTitleElf": "选择固件 ELF 文件 (*.elf, *.axf, *.out)",
			"sources.quickCandidates": "推荐候选（点击直接填入）：",
			"sources.parentDir": "返回上一级",
			"sources.emptyDir": "当前目录无匹配文件",
			"sources.filterFile": "过滤文件名…",
			"sources.jumpLive": "回到最新 (Live)",
			"sources.freqHint": "对应频率：{freq}",
			"sources.periodHint": "对应周期：{ms} ms",
			"sources.intervalUnitHz": "Hz",
			"sources.unitModeMs": "毫秒 (ms)",
			"sources.unitModeHz": "频率 (Hz)",
			"wave.divisions": "分度",
			"wave.divisionsHint": "时间轴网格列数（默认 50）。列线始终按该密度绘制；标签过密时自动隔一显示。",
			"wave.resetWindow": "恢复 1 分钟时间窗",
			"wave.zoomLimitHint": "滚轮缩放范围：{min} … {max}",
			"driver.tabOpenocd": "OpenOCD",
			"driver.tabJlink": "J-Link 驱动",
			"driver.hint": "变量直读通道：选择由 OpenOCD 还是 J-Link 官方驱动承担内存读取。",
			"driver.jlinkTitle": "J-Link 官方驱动（无需 OpenOCD）",
			"driver.jlinkExecutable": "J-Link 可执行文件",
			"driver.jlinkExecutableHint": "JLinkGDBServerCL.exe 或 JLink.exe 的完整路径；留空则从 PATH 查找。**属于本机**：存全局配置。",
			"driver.openocdExecutable": "OpenOCD 程序",
			"driver.openocdExecutableHint": "OpenOCD 可执行文件（openocd.exe）的完整路径；留空则用 PATH 里的 openocd。**属于本机**：存全局配置，不写入工作区。",
			"driver.jlinkDevice": "目标器件",
			"driver.jlinkDeviceHint": "传给 J-Link 的 -device 值，例如 STM32F407VG、Cortex-M4。",
			"driver.jlinkInterface": "调试接口",
			"driver.jlinkSpeed": "接口速率 (kHz)",
			"driver.jlinkGdbPort": "GDB 端口",
			"driver.jlinkRttTelnetPort": "RTT Telnet 端口",
			"driver.jlinkRttTelnetHint": "J-Link 的 RTT TELNET 通道端口（默认 19021）。每条 RTT 通道各占一条连接。",
			"driver.jlinkSerial": "探针序列号",
			"driver.jlinkSerialHint": "可选：多探针时指定 -select usb=<serial>。留空表示默认探针。",
			"driver.jlinkAutoStart": "由插件启动 J-Link",
			"driver.jlinkAutoStartHint": "关闭时插件只连接已在运行的 J-Link 软件（attach 模式）。",
			"driver.jlinkChannels": "RTT 通道使用 TELNET 直连，内存读取走 GDB 协议。",
			"sources.toolScopeHint": "程序路径（OpenOCD / J-Link / nm）存全局配置；其余设置存工作区 .dsh/rtt-debug.json。"
		};
		const EN = {
			"tab.title": "RTT Debug",
			"tab.description": "Live variable waveform (top) and the complete RTT log (bottom); three independently switchable data sources.",
			"status.loading": "Loading…",
			"status.running": "{backend} running (pid {pid})",
			"status.attached": "Attached to an existing {backend}",
			"status.error": "Error: {message}",
			"status.notReadyPrompt": " (hint: start the debug backend in a terminal, or finish configuring it in Variable Sources)",
			"status.idle": "Not started",
			"status.probing": "Probing…",
			"status.starting": "Starting…",
			"source.log": "RTT log",
			"source.rttVar": "RTT data channel",
			"source.ocd": "Variable reads",
			"btn.start": "Start",
			"btn.stop": "Stop",
			"btn.running": "Running",
			"btn.clear": "Clear",
			"btn.clearAll": "Clear all",
			"btn.close": "Close",
			"wave.window": "Window",
			"wave.cursor": "Ruler",
			"wave.cursorClear": "Clear ruler",
			"wave.cursorHint": "Click to place cursor A/B; drag to move. Shows Δt / ΔV / 1÷Δt.",
			"wave.autoscale": "Autoscale",
			"wave.toggleSeries": "Show/hide {name}",
			"wave.pick": "Variables ({count}/{total})",
			"wave.empty": "No variable data yet. Start a source, then tick a variable to plot it.",
			"plot.empty": "No variable data yet. Start a source, then tick a variable to plot it.",
			"readout.delta": "Cursor",
			"readout.hover": "Hover",
			"log.filterPlaceholder": "Filter…",
			"log.regex": "regex",
			"log.follow": "Follow",
			"log.export": "Export",
			"log.jumpToLatest": "Jump to latest",
			"log.counters": "{retained} kept / {total} received",
			"log.completenessHint": "“received” counts every line ever accepted, independent of the ring buffer — use it to verify log completeness.",
			"sources.open": "Sources",
			"sources.title": "Variable sources",
			"sources.rttSection": "RTT data channel (read-only)",
			"sources.parser": "Parser",
			"sources.parserSection": "Parser (editable)",
			"sources.parserId": "Type",
			"sources.parserDelimiter": "Delimiter",
			"sources.parserDelimiterHint": "Field separator: , ; tab (\\t) or a space (whitespace runs).",
			"sources.parserTerminator": "Record terminator",
			"sources.parserTerminatorHint": "Ends a record. Supports \\n (default), \\r, \\r\\n, \\t, \\0, or a literal character.",
			"sources.parserExpression": "Custom parse expression",
			"sources.parserExpressionHint": "Evaluated per record; return an object to produce variables. Available: fields (split array), line (raw record), index, Number, Math.",
			"sources.parserSkipFirst": "Skip first line (header)",
			"sources.parserPattern": "Pattern",
			"sources.parserPatternHint": "Line regex; named capture groups become variable names. Unnamed groups are ignored.",
			"sources.parserFlags": "Flags",
			"sources.parserHasHeader": "First line is a header",
			"sources.parserSave": "Save parser",
			"sources.parserSaved": "Parser saved",
			"sources.parserError": "Parser error: {message}",
			"sources.parserSandboxNote": "The custom expression runs in the host process and permits pure computation only: no require / process / globals, no file or network access.",
			"sources.rttNone": "No variables discovered yet. Start a source and the parsed names appear here.",
			"sources.rttFallbackHint": "These names come from the series already received (the parser has not reported descriptors yet).",
			"sources.ocdSection": "Variable reads (editable)",
			"sources.enabled": "Enable variable reads",
			"sources.configPath": "OpenOCD config",
			"sources.configPathHint": "Path to OpenOCD config file (e.g. openocd.cfg). Used when spawning OpenOCD; attaches automatically if already running. **Project-scoped**: saved with the workspace.",
			"sources.elfPath": "ELF path",
			"sources.elfPathHint": "A relative path resolves against the current session workspace root (falls back to host process CWD when no session is attached).",
			"sources.nmPath": "nm path",
			"sources.nmPathHint": "Empty uses the default (arm-none-eabi-nm). **Machine-wide**: saved in the global config, never in the workspace file.",
			"sources.toolScopeHint": "Program paths (OpenOCD / J-Link / nm) live in the global config; everything else is saved to the workspace’s .dsh/rtt-debug.json.",
			"sources.interval": "Poll interval",
			"sources.intervalUnit": "ms",
			"sources.filter": "Filter",
			"sources.filterPlaceholder": "symbol name contains…",
			"sources.browse": "Browse symbols",
			"sources.browsing": "Reading…",
			"sources.browseEmpty": "No matching symbols.",
			"sources.browseHint": "Set an ELF path first.",
			"sources.browseCount": "{count} symbols found",
			"sources.manualLabel": "Manual address",
			"sources.manualPlaceholder": "e.g. 0x20000000:u16:VoltMv or VoltMv@0x20000000:u16",
			"sources.manualHint": "Both spellings work; the type may be omitted (defaults to u32).",
			"sources.unit": "Unit",
			"sources.unitPlaceholder": "e.g. mV",
			"sources.add": "Add",
			"sources.manualBad": "Could not parse that spelling — check the address and type.",
			"sources.configured": "Configured variables ({count})",
			"sources.configuredEmpty": "Nothing configured yet. Tick a symbol or enter a manual address.",
			"sources.columnName": "Name",
			"sources.columnAddress": "Address",
			"sources.columnType": "Type",
			"sources.columnUnit": "Unit",
			"sources.remove": "Remove",
			"sources.save": "Save to current profile",
			"sources.saving": "Saving…",
			"sources.saved": "Saved to profile “{name}” and persisted.",
			"sources.reload": "Reload config",
			"sources.loadFailed": "Could not read the configuration: {message}",
			"sources.saveFailed": "Save failed: {message}",
			"sources.persistFailed": "Applied, but writing to persistent settings failed — it may be lost across a host restart.",
			"sources.unresolved": "These entries did not resolve and were skipped (not written to the config):",
			"sources.unresolvedItem": "{name}: {reason}",
			"sources.needRestartHint": "How it takes effect: with a source already running, saving re-binds the OCD sampling immediately (switching the toggle off stops the reads at once). While stopped, the saved variables take effect on the next [Start].",
			"sources.keepRunningNote": "OCD reads need a reachable OpenOCD TCL port; a failed connection is reported in the status line above rather than failing silently.",
			"sources.saveWorkspace": "Save to workspace (.dsh)",
			"sources.saveWorkspaceHint": "Save to current workspace .dsh/rtt-debug.json (recommended)",
			"sources.saveGlobal": "Save to global settings",
			"sources.saveGlobalHint": "Save to host global settings (~/.dsh/settings.yaml)",
			"sources.savedWorkspace": "Successfully saved to workspace “{path}”",
			"sources.savedGlobal": "Successfully saved to global settings (~/.dsh)",
			"sources.scopeWorkspace": "📁 Current config: Workspace (.dsh/rtt-debug.json)",
			"sources.scopeGlobal": "🌐 Current config: Global (~/.dsh)",
			"sources.browseFile": "Browse…",
			"sources.pickerTitleCfg": "Select OpenOCD config file (*.cfg)",
			"sources.pickerTitleElf": "Select firmware ELF file (*.elf, *.axf, *.out)",
			"sources.quickCandidates": "Quick suggestions (click to select):",
			"sources.parentDir": "Up",
			"sources.emptyDir": "No matching files in directory",
			"sources.filterFile": "Filter files…",
			"sources.jumpLive": "Jump to live",
			"sources.freqHint": "Equivalent: {freq}",
			"sources.periodHint": "Equivalent: {ms} ms",
			"sources.intervalUnitHz": "Hz",
			"sources.unitModeMs": "ms",
			"sources.unitModeHz": "Hz",
			"wave.divisions": "Div",
			"wave.divisionsHint": "Grid columns along the time axis (default 50). Lines always follow that density; labels thin out automatically when space is short.",
			"wave.resetWindow": "Back to a 1-minute window",
			"wave.zoomLimitHint": "Wheel zoom range: {min} … {max}",
			"driver.tabOpenocd": "OpenOCD",
			"driver.tabJlink": "J-Link driver",
			"driver.hint": "Which backend performs the memory reads for direct variable sampling.",
			"driver.jlinkTitle": "SEGGER J-Link driver (no OpenOCD)",
			"driver.jlinkExecutable": "J-Link executable",
			"driver.jlinkExecutableHint": "Full path to JLinkGDBServerCL.exe or JLink.exe; empty means look it up on PATH. **Machine-wide**: saved in the global config.",
			"driver.openocdExecutable": "OpenOCD program",
			"driver.openocdExecutableHint": "Full path to openocd.exe; empty uses openocd from PATH. **Machine-wide**: saved in the global config, never in the workspace file.",
			"driver.jlinkDevice": "Target device",
			"driver.jlinkDeviceHint": "The -device value for J-Link, e.g. STM32F407VG or Cortex-M4.",
			"driver.jlinkInterface": "Target interface",
			"driver.jlinkSpeed": "Interface speed (kHz)",
			"driver.jlinkGdbPort": "GDB port",
			"driver.jlinkRttTelnetPort": "RTT Telnet port",
			"driver.jlinkRttTelnetHint": "The J-Link RTT TELNET port (default 19021). Each RTT channel takes its own connection.",
			"driver.jlinkSerial": "Probe serial",
			"driver.jlinkSerialHint": "Optional: pick one probe with -select usb=<serial>. Empty means the default probe.",
			"driver.jlinkAutoStart": "Plugin starts J-Link",
			"driver.jlinkAutoStartHint": "When off, the plugin only attaches to already-running J-Link software.",
			"driver.jlinkChannels": "RTT channels use the TELNET port directly; memory reads use the GDB protocol."
		};
		let activeLanguage;
		/** Resolve the panel language: host locale when known, else the browser's. */
		function resolveLanguage() {
			if (activeLanguage !== void 0) return activeLanguage;
			if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) return "zh";
			return "en";
		}
		/**
		* Pin the language explicitly (used when the host locale service is reachable).
		* @param language - BCP-47 tag; anything not starting with `zh` selects English.
		*/
		function setLanguage(language) {
			activeLanguage = language === void 0 ? void 0 : language.toLowerCase().startsWith("zh") ? "zh" : "en";
		}
		const DICTIONARIES = {
			zh: ZH,
			en: EN
		};
		/**
		* Look up a string.
		* @param key - message key.
		* @param params - values substituted into `{name}` placeholders.
		*/
		function t(key, params) {
			let text = DICTIONARIES[resolveLanguage()][key] ?? ZH[key] ?? key;
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
			return text;
		}
		// src/client/panel.tsx
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
		/** Window presets for the time axis, in minutes (500ms, 1s, 5s, 30s, 1m, 5m, 10m, 30m). */
		const WINDOW_PRESETS = [
			500 / 6e4,
			1 / 60,
			5 / 60,
			.5,
			1,
			5,
			10,
			30
		];
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
		const MIN_WINDOW_MINUTES = .1 / 60;
		const MAX_WINDOW_MINUTES = 1440;
		/** Time-axis divisions: user-adjustable, defaulting to a scope-like 50. */
		const DEFAULT_DIVISIONS = 50;
		/**
		* Parser ids the editor offers.
		*
		* Mirrors `createDefaultRegistry()` on the host. Kept as a literal here because
		* the client bundle must not import host modules (they reach `node:` builtins),
		* and a wrong id would fail loudly at save time rather than silently.
		*/
		const PARSER_IDS = [
			"csv",
			"keyvalue",
			"binary-frame",
			"custom-regex",
			"script"
		];
		function formatWindowPreset(minutes) {
			const ms = Math.round(minutes * 6e4);
			if (ms < 1e3) return `${ms}ms`;
			if (ms < 6e4) return `${Math.round(ms / 1e3)}s`;
			return `${minutes}m`;
		}
		/** Pointer distance, in px, within which a click grabs an existing cursor. */
		const CURSOR_GRAB_PX = 6;
		function RttDebugPanel(props) {
			const { sessionId } = props;
			const [state, setState] = (0, react.useState)(void 0);
			const [series, setSeries] = (0, react.useState)([]);
			const [log, setLog] = (0, react.useState)([]);
			const [logTotal, setLogTotal] = (0, react.useState)(0);
			const [hidden, setHidden] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [timeOffsetMs, setTimeOffsetMs] = (0, react.useState)(0);
			const panRef = (0, react.useRef)(null);
			const [logsConnected, setLogsConnected] = (0, react.useState)(false);
			const [seriesConnected, setSeriesConnected] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const visible = (0, react.useMemo)(() => {
				const set = /* @__PURE__ */ new Set();
				for (const s of series) if (!hidden.has(s.name)) set.add(s.name);
				return set;
			}, [series, hidden]);
			const [splitRatio, setSplitRatio] = (0, react.useState)(.58);
			const containerRef = (0, react.useRef)(null);
			const [cursors, setCursors] = (0, react.useState)({ enabled: false });
			const [windowMinutes, setWindowMinutes] = (0, react.useState)(1);
			const [autoScale, setAutoScale] = (0, react.useState)(true);
			/** Time-axis divisions — user-adjustable, 50 by default. */
			const [timeDivisions, setTimeDivisions] = (0, react.useState)(DEFAULT_DIVISIONS);
			const [filter, setFilter] = (0, react.useState)("");
			const [useRegex, setUseRegex] = (0, react.useState)(false);
			const [follow, setFollow] = (0, react.useState)(true);
			const logRef = (0, react.useRef)(null);
			const applySnapshot = (0, react.useCallback)((snapshot) => {
				setState(snapshot.state);
				setSeries(snapshot.series);
				setLog(snapshot.log);
				setLogTotal(snapshot.total);
			}, []);
			(0, react.useEffect)(() => {
				let cancelled = false;
				(async () => {
					try {
						const snapshot = await api.snapshot(sessionId);
						if (!cancelled) applySnapshot(snapshot);
					} catch (caught) {
						if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [sessionId, applySnapshot]);
			(0, react.useEffect)(() => {
				const logSocket = new LiveSocket("/ws/log", sessionId, (payload) => {
					const message = payload;
					if (message.type === "clear") {
						if (message.what === "log" || message.what === "all") {
							setLog([]);
							setLogTotal(0);
						}
					} else if (message.type === "log" && Array.isArray(message.records)) {
						setLog((previous) => {
							const next = previous.concat(message.records);
							message.state?.log;
							return next.length > 2e4 ? next.slice(next.length - 2e4) : next;
						});
						setLogTotal((previous) => previous + (message.records?.length ?? 0));
					} else if (message.type === "state" && message.state !== void 0) setState(message.state);
				}, setLogsConnected);
				const seriesSocket = new LiveSocket("/ws/series", sessionId, (payload) => {
					const message = payload;
					if (message.type === "clear") {
						if (message.what === "series" || message.what === "all") {
							setSeries([]);
							setTimeOffsetMs(0);
						}
					} else if (message.type === "series" && Array.isArray(message.samples)) setSeries((previous) => mergeSamples(previous, message.samples));
					else if (message.type === "state" && message.state !== void 0) setState(message.state);
				}, setSeriesConnected);
				return () => {
					logSocket.close();
					seriesSocket.close();
				};
			}, [sessionId]);
			const run = (0, react.useCallback)(async (action) => {
				setBusy(true);
				setError(void 0);
				try {
					await action();
				} catch (caught) {
					setError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy(false);
				}
			}, []);
			const running = state?.openocd.kind === "running" || state?.openocd.kind === "attached";
			const filteredLog = (0, react.useMemo)(() => filterLog(log, filter, useRegex), [
				log,
				filter,
				useRegex
			]);
			(0, react.useEffect)(() => {
				if (!follow) return;
				const node = logRef.current;
				if (node === null) return;
				node.scrollTop = node.scrollHeight;
			}, [filteredLog, follow]);
			const viewport = (0, react.useMemo)(() => {
				const now = Date.now();
				const tMax = series.reduce((latest, entry) => {
					const last = entry.ts[entry.ts.length - 1];
					return typeof last === "number" && last > latest ? last : latest;
				}, now) - timeOffsetMs;
				const tMin = tMax - windowMinutes * 6e4;
				let vMin = Number.POSITIVE_INFINITY;
				let vMax = Number.NEGATIVE_INFINITY;
				for (const entry of series) {
					if (!visible.has(entry.name)) continue;
					for (let i = entry.ts.length - 1; i >= 0; i -= 1) {
						const ts = entry.ts[i];
						if (ts < tMin) break;
						if (ts > tMax) continue;
						const raw = entry.values[i];
						const value = typeof raw === "boolean" ? raw ? 1 : 0 : raw;
						if (typeof value !== "number" || !Number.isFinite(value)) continue;
						if (value < vMin) vMin = value;
						if (value > vMax) vMax = value;
					}
				}
				if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
					vMin = 0;
					vMax = 1;
				}
				if (vMax - vMin < 1e-12) {
					const pad = Math.abs(vMax) > 1e-12 ? Math.abs(vMax) * .1 : 1;
					vMin -= pad;
					vMax += pad;
				} else {
					const pad = (vMax - vMin) * .08;
					vMin -= pad;
					vMax += pad;
				}
				return {
					tMin,
					tMax,
					vMin,
					vMax
				};
			}, [
				series,
				visible,
				windowMinutes,
				timeOffsetMs
			]);
			const canvasRef = (0, react.useRef)(null);
			const [pointer, setPointer] = (0, react.useState)(void 0);
			const [hoverTime, setHoverTime] = (0, react.useState)(void 0);
			const [themeVersion, setThemeVersion] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				const observer = new MutationObserver(() => {
					setThemeVersion((v) => v + 1);
				});
				observer.observe(document.body, {
					attributes: true,
					attributeFilter: [
						"data-ds-dark-theme",
						"class",
						"data-theme"
					]
				});
				if (document.documentElement) observer.observe(document.documentElement, {
					attributes: true,
					attributeFilter: ["data-theme", "class"]
				});
				return () => observer.disconnect();
			}, []);
			(0, react.useEffect)(() => {
				const canvas = canvasRef.current;
				if (canvas === null) return;
				const parent = canvas.parentElement;
				if (parent === null) return;
				const render = () => {
					const rect = parent.getBoundingClientRect();
					const width = Math.max(80, Math.floor(rect.width));
					const height = Math.max(80, Math.floor(rect.height));
					const dpr = window.devicePixelRatio || 1;
					if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
						canvas.width = width * dpr;
						canvas.height = height * dpr;
						canvas.style.width = `${width}px`;
						canvas.style.height = `${height}px`;
					}
					const ctx = canvas.getContext("2d");
					if (ctx === null) return;
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
					drawPlot({
						ctx,
						width,
						height,
						viewport,
						series,
						visible,
						cursors,
						timeDivisions,
						...pointer === void 0 ? {} : { pointer }
					});
				};
				render();
				const observer = new ResizeObserver(render);
				observer.observe(parent);
				return () => observer.disconnect();
			}, [
				viewport,
				series,
				visible,
				cursors,
				pointer,
				themeVersion,
				timeDivisions
			]);
			const metrics = (0, react.useMemo)(() => {
				const rect = canvasRef.current?.parentElement?.getBoundingClientRect();
				return plotMetrics(rect?.width ?? 600, rect?.height ?? 240);
			}, [canvasRef.current?.parentElement?.getBoundingClientRect().width, series]);
			const pointerToPlot = (0, react.useCallback)((event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				return {
					x: event.clientX - rect.left,
					y: event.clientY - rect.top
				};
			}, []);
			/** Series value under a pixel position, for placing a cursor. */
			const valueUnderPointer = (0, react.useCallback)((x, y) => {
				const time = xToTime(x, viewport, metrics);
				for (const entry of series) {
					if (!visible.has(entry.name)) continue;
					const value = valueAt(entry, time);
					if (value !== void 0) return {
						t: time,
						v: value
					};
				}
				return {
					t: time,
					v: yToValue(y, viewport, metrics)
				};
			}, [
				viewport,
				metrics,
				series,
				visible
			]);
			const onPointerDown = (0, react.useCallback)((event) => {
				const { x, y } = pointerToPlot(event);
				if (cursors.enabled) {
					for (const id of ["a", "b"]) {
						const existing = id === "a" ? cursors.a : cursors.b;
						if (existing === void 0) continue;
						const cursorX = metrics.left + (existing.t - viewport.tMin) / Math.max(1, viewport.tMax - viewport.tMin) * metrics.width;
						if (Math.abs(cursorX - x) <= CURSOR_GRAB_PX) {
							setCursors((previous) => ({
								...previous,
								dragging: id
							}));
							event.currentTarget.setPointerCapture(event.pointerId);
							return;
						}
					}
					const point = valueUnderPointer(x, y);
					const target = cursors.a === void 0 ? "a" : cursors.b === void 0 ? "b" : "a";
					setCursors((previous) => ({
						...previous,
						[target]: point,
						dragging: target
					}));
					event.currentTarget.setPointerCapture(event.pointerId);
				} else {
					panRef.current = {
						startX: event.clientX,
						startTimeOffset: timeOffsetMs,
						active: true
					};
					event.currentTarget.setPointerCapture(event.pointerId);
				}
			}, [
				cursors,
				metrics,
				viewport,
				pointerToPlot,
				valueUnderPointer,
				timeOffsetMs
			]);
			const onPointerMove = (0, react.useCallback)((event) => {
				const { x, y } = pointerToPlot(event);
				setPointer({
					x,
					y
				});
				setHoverTime(xToTime(x, viewport, metrics));
				if (cursors.dragging !== void 0) {
					const point = valueUnderPointer(x, y);
					setCursors((previous) => ({
						...previous,
						[previous.dragging]: point
					}));
				} else if (panRef.current?.active) {
					const dt = (event.clientX - panRef.current.startX) * ((viewport.tMax - viewport.tMin) / Math.max(1, metrics.width));
					const nextOffset = Math.max(0, panRef.current.startTimeOffset + dt);
					setTimeOffsetMs(nextOffset);
				}
			}, [
				cursors.dragging,
				pointerToPlot,
				viewport,
				metrics,
				valueUnderPointer
			]);
			const onPointerUp = (0, react.useCallback)((event) => {
				if (panRef.current?.active) {
					panRef.current = null;
					try {
						event.currentTarget.releasePointerCapture(event.pointerId);
					} catch {}
				}
				setCursors((previous) => ({
					...previous,
					dragging: void 0
				}));
			}, []);
			const onWheel = (0, react.useCallback)((event) => {
				event.preventDefault();
				const factor = event.deltaY > 0 ? 1.25 : .8;
				setWindowMinutes((prev) => {
					const next = prev * factor;
					return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, Math.round(next * 1e4) / 1e4));
				});
			}, []);
			const onSplitPointerDown = (0, react.useCallback)((event) => {
				const container = containerRef.current;
				if (container === null) return;
				const rect = container.getBoundingClientRect();
				const move = (moveEvent) => {
					const ratio = (moveEvent.clientY - rect.top) / rect.height;
					setSplitRatio(Math.min(.85, Math.max(.15, ratio)));
				};
				const up = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
				event.preventDefault();
			}, []);
			const delta = (0, react.useMemo)(() => deltaBetween(cursors, series, visible), [
				cursors,
				series,
				visible
			]);
			const measurements = (0, react.useMemo)(() => {
				const tMin = cursors.a !== void 0 && cursors.b !== void 0 ? Math.min(cursors.a.t, cursors.b.t) : viewport.tMin;
				const tMax = cursors.a !== void 0 && cursors.b !== void 0 ? Math.max(cursors.a.t, cursors.b.t) : viewport.tMax;
				return series.filter((entry) => visible.has(entry.name)).map((entry) => ({
					name: entry.name,
					unit: entry.unit,
					result: measure(entry, tMin, tMax)
				}));
			}, [
				series,
				visible,
				cursors,
				viewport
			]);
			const visibleNames = series.filter((entry) => visible.has(entry.name)).map((entry) => entry.name);
			const allNames = series.map((entry) => entry.name);
			return (0, react.createElement)("div", { className: "rttd-root" }, (0, react.createElement)(Toolbar, {
				state,
				busy,
				running,
				error,
				logsConnected,
				seriesConnected,
				onStart: () => void run(async () => {
					await api.start(sessionId);
					applySnapshot(await api.snapshot(sessionId));
				}),
				onStop: () => void run(async () => {
					await api.stop(sessionId);
					applySnapshot(await api.snapshot(sessionId));
				}),
				onClearAll: () => void run(async () => {
					setSeries([]);
					setLog([]);
					setLogTotal(0);
					setTimeOffsetMs(0);
					await api.clear("all", sessionId);
				})
			}), state?.openocd.kind === "error" ? (0, react.createElement)("div", {
				className: "rttd-alert rttd-alert-error",
				style: {
					padding: "4px 10px",
					background: "rgba(255, 107, 107, 0.15)",
					borderBottom: "1px solid rgba(255, 107, 107, 0.35)",
					color: "#ff6b6b",
					display: "flex",
					alignItems: "center",
					gap: "6px",
					fontSize: "11px",
					lineHeight: "1.4",
					flex: "0 0 auto"
				}
			}, (0, react.createElement)("span", { style: { fontWeight: 600 } }, state.driver === "jlink" ? "⚠️ J-Link:" : "⚠️ OpenOCD:"), (0, react.createElement)("span", null, state.openocd.message), state.openocd.message.includes("config file") ? (0, react.createElement)("span", { style: {
				opacity: .9,
				marginLeft: "4px"
			} }, t("status.notReadyPrompt")) : null) : null, state?.jlinkNotice === void 0 ? null : (0, react.createElement)("div", {
				className: "rttd-alert rttd-alert-warn",
				style: {
					padding: "4px 10px",
					background: "rgba(255, 169, 77, 0.15)",
					borderBottom: "1px solid rgba(255, 169, 77, 0.35)",
					color: "#ffa94d",
					fontSize: "11px",
					lineHeight: "1.4",
					flex: "0 0 auto"
				}
			}, (0, react.createElement)("span", { style: { fontWeight: 600 } }, "⚠️ "), (0, react.createElement)("span", null, state.jlinkNotice)), (0, react.createElement)("div", {
				className: "rttd-split",
				ref: containerRef
			}, (0, react.createElement)("div", {
				className: "rttd-pane rttd-pane-plot",
				style: { flexBasis: `${splitRatio * 100}%` }
			}, (0, react.createElement)(WaveToolbar, {
				sessionId,
				state,
				windowMinutes,
				setWindowMinutes,
				timeDivisions,
				setTimeDivisions,
				cursorsEnabled: cursors.enabled,
				onToggleCursors: () => setCursors((previous) => previous.enabled ? { enabled: false } : {
					enabled: true,
					a: previous.a,
					b: previous.b
				}),
				onClearCursors: () => setCursors((previous) => ({ enabled: previous.enabled })),
				autoScale,
				setAutoScale,
				onClearSeries: () => void run(async () => {
					setSeries([]);
					setTimeOffsetMs(0);
					await api.clear("series", sessionId);
				}),
				visibleNames,
				allNames,
				series,
				timeOffsetMs,
				onResetTimeOffset: () => setTimeOffsetMs(0),
				onToggleSeries: (name) => setHidden((previous) => {
					const next = new Set(previous);
					if (next.has(name)) next.delete(name);
					else next.add(name);
					return next;
				})
			}), (0, react.createElement)("div", { className: "rttd-canvas-wrap" }, (0, react.createElement)("canvas", {
				ref: canvasRef,
				className: "rttd-canvas",
				onPointerDown,
				onPointerMove,
				onPointerUp,
				onWheel,
				onDoubleClick: () => setTimeOffsetMs(0),
				onPointerLeave: () => {
					setPointer(void 0);
					setHoverTime(void 0);
				}
			}), series.length === 0 ? (0, react.createElement)("div", { className: "rttd-empty" }, t("plot.empty")) : null), (0, react.createElement)(ReadoutStrip, {
				measurements,
				delta,
				hoverTime,
				pointer,
				series,
				visible,
				viewport,
				metrics
			})), (0, react.createElement)("div", {
				className: "rttd-divider",
				onPointerDown: onSplitPointerDown,
				role: "separator",
				"aria-orientation": "horizontal"
			}), (0, react.createElement)("div", { className: "rttd-pane rttd-pane-log" }, (0, react.createElement)(LogToolbar, {
				filter,
				setFilter,
				useRegex,
				setUseRegex,
				follow,
				setFollow,
				retained: log.length,
				total: logTotal,
				onExport: () => {
					window.open(api.exportUrl(sessionId), "_blank");
				},
				onClearLog: () => void run(async () => {
					setLog([]);
					setLogTotal(0);
					await api.clear("log", sessionId);
				})
			}), (0, react.createElement)(LogList, {
				records: filteredLog,
				follow,
				logRef
			}))));
		}
		function Toolbar(props) {
			const { state, busy, running, error, logsConnected, seriesConnected } = props;
			const backend = state?.openocd;
			const backendName = state?.driver === "jlink" ? "J-Link" : "OpenOCD";
			const statusText = backend === void 0 ? t("status.loading") : backend.kind === "running" ? t("status.running", {
				pid: backend.pid ?? "—",
				backend: backendName
			}) : backend.kind === "attached" ? t("status.attached", { backend: backendName }) : backend.kind === "error" ? t("status.error", { message: backend.message }) : backend.kind === "idle" ? t("status.idle") : backend.kind === "probing" ? t("status.probing") : backend.kind === "starting" ? t("status.starting") : "—";
			return (0, react.createElement)("div", { className: "rttd-toolbar" }, (0, react.createElement)("span", { className: `rttd-status rttd-status-${backend?.kind ?? "idle"}` }, statusText), (0, react.createElement)("span", { className: "rttd-spacer" }), (0, react.createElement)(SourceChip, {
				key: "log",
				source: state?.sources[0],
				label: t("source.log"),
				connected: logsConnected
			}), (0, react.createElement)(SourceChip, {
				key: "rttVar",
				source: state?.sources[1],
				label: t("source.rttVar"),
				connected: seriesConnected
			}), (0, react.createElement)(SourceChip, {
				key: "ocd",
				source: state?.sources[2],
				label: t("source.ocd"),
				connected: void 0
			}), (0, react.createElement)("span", { className: "rttd-spacer" }), (0, react.createElement)("button", {
				className: "rttd-btn",
				disabled: busy || running,
				onClick: props.onStart,
				type: "button"
			}, running ? t("btn.running") : t("btn.start")), (0, react.createElement)("button", {
				className: "rttd-btn",
				disabled: busy || !running,
				onClick: props.onStop,
				type: "button"
			}, t("btn.stop")), (0, react.createElement)("button", {
				className: "rttd-btn",
				disabled: busy,
				onClick: props.onClearAll,
				type: "button"
			}, t("btn.clearAll")), error === void 0 ? null : (0, react.createElement)("span", {
				className: "rttd-error",
				title: error
			}, error));
		}
		/**
		* One source's live-status pill.
		*
		* A component (not a plain helper) so React reconciles it by position: the
		* three chips sit in a fixed order and must not be re-created on every render.
		*/
		function SourceChip(props) {
			const { source, label, connected } = props;
			const state = source?.state ?? "idle";
			const on = connected ?? (state === "open" || state === "running");
			const title = source === void 0 ? label : `${label}: ${state}${source.detail === void 0 ? "" : ` — ${source.detail}`} (${source.received})`;
			return (0, react.createElement)("span", {
				className: `rttd-chip${on ? " rttd-chip-on" : ""}${source?.enabled === false ? " rttd-chip-off" : ""}`,
				title
			}, (0, react.createElement)("span", { className: "rttd-dot" }), label);
		}
		function WaveToolbar(props) {
			const [pickerOpen, setPickerOpen] = (0, react.useState)(false);
			const [divInput, setDivInput] = (0, react.useState)(String(props.timeDivisions));
			(0, react.useEffect)(() => {
				setDivInput(String(props.timeDivisions));
			}, [props.timeDivisions]);
			const commitDivisions = (raw) => {
				const parsed = Number.parseInt(raw, 10);
				if (!Number.isFinite(parsed)) {
					setDivInput(String(props.timeDivisions));
					return;
				}
				const clamped = Math.min(200, Math.max(2, parsed));
				props.setTimeDivisions(clamped);
				setDivInput(String(clamped));
			};
			return (0, react.createElement)("div", { className: "rttd-toolbar rttd-toolbar-sub" }, (0, react.createElement)("span", { className: "rttd-label" }, t("wave.window")), ...WINDOW_PRESETS.map((minutes) => (0, react.createElement)("button", {
				key: minutes,
				type: "button",
				className: `rttd-btn rttd-btn-sm${props.windowMinutes === minutes ? " rttd-btn-active" : ""}`,
				onClick: () => props.setWindowMinutes(minutes)
			}, formatWindowPreset(minutes))), (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("wave.divisionsHint")
			}, t("wave.divisions")), (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm rttd-divisions-input",
				type: "number",
				min: String(2),
				max: String(200),
				step: "1",
				value: divInput,
				title: t("wave.divisionsHint"),
				onChange: (event) => setDivInput(event.target.value),
				onBlur: (event) => commitDivisions(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") commitDivisions(event.target.value);
				}
			}), props.windowMinutes !== 1 ? (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				title: t("wave.resetWindow"),
				onClick: () => props.setWindowMinutes(1)
			}, "1m") : null, props.timeOffsetMs && props.timeOffsetMs > 0 ? (0, react.createElement)("button", {
				type: "button",
				className: "rttd-jump-live",
				onClick: props.onResetTimeOffset,
				title: t("sources.jumpLive")
			}, "⏩ " + t("sources.jumpLive")) : null, (0, react.createElement)("span", { className: "rttd-spacer" }), (0, react.createElement)("button", {
				type: "button",
				className: `rttd-btn rttd-btn-sm${props.cursorsEnabled ? " rttd-btn-active" : ""}`,
				onClick: props.onToggleCursors,
				title: t("wave.cursorHint")
			}, t("wave.cursor")), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: props.onClearCursors,
				disabled: !props.cursorsEnabled
			}, t("wave.cursorClear")), (0, react.createElement)("button", {
				type: "button",
				className: `rttd-btn rttd-btn-sm${props.autoScale ? " rttd-btn-active" : ""}`,
				onClick: () => props.setAutoScale(!props.autoScale)
			}, t("wave.autoscale")), (0, react.createElement)("span", { className: "rttd-spacer" }), (0, react.createElement)("div", { className: "rttd-legend" }, ...props.allNames.map((name) => {
				const isVisible = props.visibleNames.includes(name);
				return (0, react.createElement)("button", {
					key: name,
					type: "button",
					className: `rttd-legend-item${isVisible ? " rttd-legend-on" : " rttd-legend-off"}`,
					style: {
						borderColor: colorFor(name, props.allNames),
						opacity: isVisible ? 1 : .45,
						textDecoration: isVisible ? "none" : "line-through"
					},
					onClick: () => props.onToggleSeries(name),
					title: t("wave.toggleSeries", { name })
				}, (0, react.createElement)("span", {
					className: "rttd-swatch",
					style: { background: isVisible ? colorFor(name, props.allNames) : "#555" }
				}), name);
			})), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: () => setPickerOpen((value) => !value),
				disabled: props.allNames.length === 0
			}, t("wave.pick", {
				count: props.visibleNames.length,
				total: props.allNames.length
			})), pickerOpen ? (0, react.createElement)("div", { className: "rttd-picker" }, ...props.allNames.map((name) => (0, react.createElement)("label", {
				key: name,
				className: "rttd-picker-row"
			}, (0, react.createElement)("input", {
				type: "checkbox",
				checked: props.visibleNames.includes(name),
				onChange: () => props.onToggleSeries(name)
			}), name))) : null, (0, react.createElement)(VariableSources, {
				sessionId: props.sessionId,
				state: props.state
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: props.onClearSeries
			}, t("btn.clear")));
		}
		/** `0x…` hex, padded to 8 digits — the address format the table uses everywhere. */
		function hexAddress(value) {
			return value === void 0 ? "—" : `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
		}
		function FilePickerModal(props) {
			const { open, targetField, sessionId, onSelect, onClose } = props;
			const [loading, setLoading] = (0, react.useState)(false);
			const [currentDir, setCurrentDir] = (0, react.useState)("");
			const [displayDir, setDisplayDir] = (0, react.useState)(".");
			const [parentDir, setParentDir] = (0, react.useState)(null);
			const [entries, setEntries] = (0, react.useState)([]);
			const [discovered, setDiscovered] = (0, react.useState)([]);
			const [filter, setFilter] = (0, react.useState)("");
			const ext = targetField === "configPath" ? ".cfg" : targetField === "jlinkExe" || targetField === "openocdExe" ? ".exe" : ".elf,.axf,.out";
			const loadDir = (0, react.useCallback)(async (dir) => {
				setLoading(true);
				try {
					const data = await api.listFiles(dir, ext, sessionId);
					setCurrentDir(data.currentDir);
					setDisplayDir(data.displayDir);
					setParentDir(data.parentDir);
					setEntries(data.entries);
				} catch (e) {
					console.error(e);
				} finally {
					setLoading(false);
				}
			}, [ext, sessionId]);
			(0, react.useEffect)(() => {
				if (!open) return;
				loadDir("");
				if (targetField === "jlinkExe" || targetField === "openocdExe") {
					setDiscovered([]);
					return;
				}
				(async () => {
					try {
						const disc = await api.discoverFiles(targetField === "configPath" ? "openocd" : "elf", sessionId);
						setDiscovered(disc.files);
					} catch {}
				})();
			}, [
				open,
				targetField,
				sessionId,
				loadDir
			]);
			if (!open) return null;
			const filteredEntries = entries.filter((e) => filter === "" || e.name.toLowerCase().includes(filter.toLowerCase()));
			return (0, react.createElement)("div", {
				className: "rttd-fp-modal",
				onClick: (e) => {
					if (e.target === e.currentTarget) onClose();
				}
			}, (0, react.createElement)("div", { className: "rttd-fp-container" }, (0, react.createElement)("div", { className: "rttd-fp-header" }, (0, react.createElement)("span", null, targetField === "configPath" ? t("sources.pickerTitleCfg") : targetField === "jlinkExe" ? t("driver.jlinkExecutable") : targetField === "openocdExe" ? t("driver.openocdExecutable") : t("sources.pickerTitleElf")), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: onClose,
				style: {
					padding: "0 6px",
					lineHeight: "18px"
				}
			}, "✕")), discovered.length === 0 ? null : (0, react.createElement)("div", { className: "rttd-fp-candidates" }, (0, react.createElement)("div", { className: "rttd-fp-candidates-title" }, t("sources.quickCandidates")), (0, react.createElement)("div", { className: "rttd-fp-candidates-list" }, ...discovered.map((cand) => (0, react.createElement)("button", {
				key: cand.path,
				type: "button",
				className: "rttd-fp-chip",
				title: cand.path,
				onClick: () => {
					onSelect(cand.relPath || cand.path);
					onClose();
				}
			}, cand.relPath || cand.name)))), (0, react.createElement)("div", { className: "rttd-fp-nav" }, (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				disabled: parentDir === null || loading,
				onClick: () => {
					if (parentDir !== null) loadDir(parentDir);
				}
			}, "⬆ " + t("sources.parentDir")), (0, react.createElement)("div", {
				className: "rttd-fp-path",
				title: currentDir
			}, "📁 " + displayDir), (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: {
					width: "130px",
					padding: "1px 5px",
					fontSize: "11px"
				},
				placeholder: t("sources.filterFile"),
				value: filter,
				onChange: (e) => setFilter(e.target.value)
			})), (0, react.createElement)("div", { className: "rttd-fp-list" }, loading ? (0, react.createElement)("div", { style: {
				padding: "12px",
				textAlign: "center",
				opacity: .6
			} }, t("status.loading")) : filteredEntries.length === 0 ? (0, react.createElement)("div", { style: {
				padding: "12px",
				textAlign: "center",
				opacity: .5
			} }, t("sources.emptyDir")) : filteredEntries.map((item) => (0, react.createElement)("div", {
				key: item.path,
				className: `rttd-fp-item ${item.isDirectory ? "rttd-fp-item-dir" : "rttd-fp-item-file"}`,
				onClick: () => {
					if (item.isDirectory) loadDir(item.path);
					else {
						const chosen = displayDir === "." ? item.name : `${displayDir}/${item.name}`.replace(/^\.\//, "");
						onSelect(chosen);
						onClose();
					}
				}
			}, (0, react.createElement)("span", null, `${item.isDirectory ? "📁 " : "📄 "}${item.name}`), item.isDirectory ? null : (0, react.createElement)("span", { style: {
				opacity: .5,
				fontSize: "11px"
			} }, item.size ? `${(item.size / 1024).toFixed(1)} KB` : "")))), (0, react.createElement)("div", { className: "rttd-fp-footer" }, (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: onClose
			}, t("btn.close")))));
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
		function VariableSources(props) {
			const { sessionId, state } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [config, setConfig] = (0, react.useState)(void 0);
			const [configError, setConfigError] = (0, react.useState)(void 0);
			const [enabled, setEnabled] = (0, react.useState)(false);
			/** Which backend performs the memory reads (the tab in this drawer). */
			const [driver, setDriver] = (0, react.useState)("openocd");
			const [configPath, setConfigPath] = (0, react.useState)("");
			/**
			* Machine-wide tool locations.
			*
			* These three are stored in the GLOBAL layer, not the workspace file: where a
			* program is installed is a fact about this computer, so repeating it per
			* project — or committing it to a repo — is wrong. The panel shows them
			* together with the project settings because that is where the user looks.
			*/
			const [openocdExe, setOpenocdExe] = (0, react.useState)("openocd");
			const [elfPath, setElfPath] = (0, react.useState)("");
			const [nmPath, setNmPath] = (0, react.useState)("arm-none-eabi-nm");
			const [intervalText, setIntervalText] = (0, react.useState)("100");
			const [intervalMode, setIntervalMode] = (0, react.useState)("ms");
			const [pickerTarget, setPickerTarget] = (0, react.useState)(void 0);
			const [savedTarget, setSavedTarget] = (0, react.useState)(void 0);
			const [jlinkExe, setJlinkExe] = (0, react.useState)("");
			const [jlinkDevice, setJlinkDevice] = (0, react.useState)("");
			const [jlinkInterface, setJlinkInterface] = (0, react.useState)("SWD");
			const [jlinkSpeed, setJlinkSpeed] = (0, react.useState)("0");
			const [jlinkGdbPort, setJlinkGdbPort] = (0, react.useState)("2331");
			const [jlinkTelnetPort, setJlinkTelnetPort] = (0, react.useState)("19021");
			const [jlinkSerial, setJlinkSerial] = (0, react.useState)("");
			const [jlinkAutoStart, setJlinkAutoStart] = (0, react.useState)(true);
			const [parserId, setParserId] = (0, react.useState)("csv");
			const [parserDelimiter, setParserDelimiter] = (0, react.useState)(",");
			const [parserTerminator, setParserTerminator] = (0, react.useState)("\\n");
			const [parserExpression, setParserExpression] = (0, react.useState)("");
			const [parserPattern, setParserPattern] = (0, react.useState)("");
			const [parserFlags, setParserFlags] = (0, react.useState)("");
			const [parserSkipFirst, setParserSkipFirst] = (0, react.useState)(false);
			const [parserError, setParserError] = (0, react.useState)(void 0);
			const [filter, setFilter] = (0, react.useState)("");
			const [symbols, setSymbols] = (0, react.useState)(void 0);
			const [browsing, setBrowsing] = (0, react.useState)(false);
			const [picked, setPicked] = (0, react.useState)({});
			const [manual, setManual] = (0, react.useState)("");
			const [manualUnit, setManualUnit] = (0, react.useState)("");
			const [manualBad, setManualBad] = (0, react.useState)(void 0);
			const [rows, setRows] = (0, react.useState)([]);
			const [busy, setBusy] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(void 0);
			const [saveError, setSaveError] = (0, react.useState)(void 0);
			const [skipped, setSkipped] = (0, react.useState)([]);
			(0, react.useMemo)(() => {
				if (config === void 0) return void 0;
				return config.profiles.find((entry) => entry.id === config.activeProfile) ?? config.profiles[0];
			}, [config]);
			/**
			* Build the parser option block for the SELECTED parser only.
			*
			* Sending every field unconditionally would leave a `csv` parser carrying a
			* stale `expression`, and a later switch to `script` would silently inherit
			* one the user had forgotten about. Options are therefore scoped by `id`.
			*/
			const buildParserOptions = (0, react.useCallback)(() => {
				const options = {};
				const terminator = parserTerminator.trim();
				if (terminator !== "" && terminator !== "\\n") options["lineTerminator"] = terminator;
				if (parserId === "csv") {
					if (parserDelimiter !== "") options["delimiter"] = parserDelimiter;
				} else if (parserId === "keyvalue" || parserId === "script") {
					if (parserDelimiter !== "") options["delimiter"] = parserDelimiter;
				}
				if (parserId === "script") {
					options["expression"] = parserExpression;
					options["skipFirstLine"] = parserSkipFirst;
				}
				if (parserId === "custom-regex") {
					if (parserPattern !== "") options["pattern"] = parserPattern;
					if (parserFlags !== "") options["flags"] = parserFlags;
				}
				return options;
			}, [
				parserId,
				parserDelimiter,
				parserTerminator,
				parserExpression,
				parserPattern,
				parserFlags,
				parserSkipFirst
			]);
			/** Syntax-check the expression locally so a typo is caught before saving. */
			(0, react.useEffect)(() => {
				if (parserId !== "script") {
					setParserError(void 0);
					return;
				}
				if (parserExpression.trim() === "") {
					setParserError(t("sources.parserError", { message: "expression is empty" }));
					return;
				}
				try {
					new Function("fields", "line", "index", "Number", "Math", `"use strict"; return (${parserExpression});`);
					setParserError(void 0);
				} catch (caught) {
					setParserError(t("sources.parserError", { message: caught instanceof Error ? caught.message : String(caught) }));
				}
			}, [parserId, parserExpression]);
			const applyConfig = (0, react.useCallback)((loaded) => {
				setConfig(loaded);
				const profile = loaded.profiles.find((entry) => entry.id === loaded.activeProfile) ?? loaded.profiles[0];
				const ocd = profile?.ocd;
				setEnabled(ocd?.enabled === true);
				setDriver(profile?.driver === "jlink" ? "jlink" : "openocd");
				setConfigPath(profile?.openocd?.configPath ?? "");
				setOpenocdExe(profile?.openocd?.executable ?? "openocd");
				const jlink = profile?.jlink;
				setJlinkExe(jlink?.executable ?? "");
				setJlinkDevice(jlink?.device ?? "");
				setJlinkInterface(jlink?.targetInterface === "JTAG" ? "JTAG" : "SWD");
				setJlinkSpeed(String(jlink?.speedKhz ?? 0));
				setJlinkGdbPort(String(jlink?.gdbPort ?? 2331));
				setJlinkTelnetPort(String(jlink?.rttTelnetPort ?? 19021));
				setJlinkSerial(jlink?.serial ?? "");
				setJlinkAutoStart(jlink?.autoStart !== false);
				setElfPath(ocd?.elfPath ?? "");
				setNmPath(ocd?.nmPath ?? "arm-none-eabi-nm");
				const parser = profile?.variables?.parser;
				setParserId(parser?.id ?? "csv");
				const options = parser?.options ?? {};
				setParserDelimiter(typeof options["delimiter"] === "string" ? options["delimiter"] : ",");
				setParserTerminator(typeof options["lineTerminator"] === "string" ? options["lineTerminator"] : "\\n");
				setParserExpression(typeof options["expression"] === "string" ? options["expression"] : "");
				setParserPattern(typeof options["pattern"] === "string" ? options["pattern"] : "");
				setParserFlags(typeof options["flags"] === "string" ? options["flags"] : "");
				setParserSkipFirst(options["skipFirstLine"] === true);
				const ms = ocd?.intervalMs ?? 100;
				if (intervalMode === "hz") setIntervalText(String(Math.round(1e3 / ms * 100) / 100));
				else setIntervalText(String(ms));
				setRows(Array.isArray(ocd?.variables) ? ocd.variables : []);
			}, [intervalMode]);
			const toggleIntervalMode = (newMode) => {
				if (newMode === intervalMode) return;
				const num = parseFloat(intervalText);
				if (Number.isFinite(num) && num > 0) {
					if (newMode === "hz") {
						const hz = Math.round(1e3 / num * 100) / 100;
						setIntervalText(String(hz));
					} else {
						const ms = Math.round(1e3 / num * 100) / 100;
						setIntervalText(String(ms));
					}
				}
				setIntervalMode(newMode);
			};
			const intervalConversionText = (0, react.useMemo)(() => {
				const num = parseFloat(intervalText);
				if (!Number.isFinite(num) || num <= 0) return "";
				if (intervalMode === "ms") {
					const hz = Math.round(1e3 / num * 100) / 100;
					return t("sources.freqHint", { freq: hz >= 1e3 ? `${(hz / 1e3).toFixed(2)} kHz` : `${hz} Hz` });
				} else return t("sources.periodHint", { ms: Math.round(1e3 / num * 100) / 100 });
			}, [intervalText, intervalMode]);
			/** Read the REAL configuration; never seed the editor from a local default. */
			const load = (0, react.useCallback)(async () => {
				setConfigError(void 0);
				try {
					applyConfig(await api.getConfig(sessionId));
				} catch (caught) {
					setConfigError(caught instanceof Error ? caught.message : String(caught));
				}
			}, [sessionId, applyConfig]);
			(0, react.useEffect)(() => {
				if (!open) return;
				load();
			}, [open, load]);
			const browse = (0, react.useCallback)(async () => {
				setBrowsing(true);
				setSaveError(void 0);
				try {
					const result = await api.symbols(elfPath, nmPath.trim() === "" ? "" : nmPath, filter, sessionId);
					setSymbols(result.symbols);
				} catch (caught) {
					setSymbols(void 0);
					setSaveError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBrowsing(false);
				}
			}, [
				elfPath,
				nmPath,
				filter,
				sessionId
			]);
			const addManual = (0, react.useCallback)(() => {
				const parsed = parseManualBindingDetailed(manual);
				if (!parsed.ok) {
					setManualBad({
						reason: parsed.reason,
						spelling: parsed.spelling
					});
					return;
				}
				setManualBad(void 0);
				setManual("");
				setManualUnit("");
				setRows((previous) => [...previous, {
					source: "manual",
					name: parsed.binding.name,
					address: parsed.binding.address,
					type: parsed.binding.type,
					...manualUnit.trim() === "" ? {} : { unit: manualUnit.trim() }
				}]);
			}, [manual, manualUnit]);
			/**
			* Resolve, merge and persist.
			*
			* Unresolved entries are reported, never written: the host silently skips a
			* binding with no address (`src/service.ts:284`), so persisting `ok:false`
			* with the `address: 0` that came back would give the user a variable that
			* looks configured and quietly samples the wrong memory.
			*/
			const save = (0, react.useCallback)(async (target = "workspace") => {
				setBusy(true);
				setSaved(void 0);
				setSavedTarget(void 0);
				setSaveError(void 0);
				setSkipped([]);
				try {
					const base = config ?? await api.getConfig(sessionId);
					const profileId = base.activeProfile;
					const profile = base.profiles.find((entry) => entry.id === profileId) ?? base.profiles[0];
					if (profile === void 0) throw new Error("configuration holds no device profiles");
					const checked = Object.values(picked).map((entry) => ({
						source: "symbol",
						symbol: entry.name,
						name: entry.name,
						type: entry.type
					}));
					const manualRows = rows.filter((row) => row.source === "manual");
					const toResolve = [...checked, ...rows.filter((row) => row.source === "symbol")];
					let resolved = [];
					if (toResolve.length > 0) resolved = (await api.ocdVars(elfPath, toResolve, sessionId)).resolved;
					const failed = [];
					const merged = [];
					for (const [index, entry] of toResolve.entries()) {
						const answer = resolved[index];
						if (answer === void 0 || answer.ok !== true) {
							failed.push({
								name: entry.name ?? entry.symbol ?? `#${index + 1}`,
								reason: answer?.reason ?? "not resolved (no answer from the host)"
							});
							continue;
						}
						merged.push({
							source: "symbol",
							symbol: entry.symbol,
							name: answer.name,
							address: answer.address,
							type: answer.type,
							...entry.unit === void 0 ? {} : { unit: entry.unit }
						});
					}
					for (const row of manualRows) {
						if (typeof row.address !== "number") {
							failed.push({
								name: row.name ?? "(manual)",
								reason: "missing address"
							});
							continue;
						}
						merged.push(row);
					}
					const rawInterval = parseFloat(intervalText);
					const computedIntervalMs = intervalMode === "ms" ? rawInterval : Number.isFinite(rawInterval) && rawInterval > 0 ? 1e3 / rawInterval : 100;
					const finalIntervalMs = Number.isFinite(computedIntervalMs) && computedIntervalMs > 0 ? computedIntervalMs : 100;
					const next = {
						...base,
						profiles: base.profiles.map((entry) => entry.id !== profileId ? entry : {
							...entry,
							driver,
							openocd: {
								...entry.openocd,
								configPath: configPath.trim(),
								executable: openocdExe.trim() === "" ? "openocd" : openocdExe.trim()
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
								startupTimeoutMs: entry.jlink?.startupTimeoutMs ?? 8e3
							},
							ocd: {
								enabled,
								elfPath: elfPath.trim(),
								nmPath: nmPath.trim(),
								intervalMs: finalIntervalMs,
								variables: merged
							},
							variables: {
								...entry.variables,
								parser: {
									id: parserId,
									options: buildParserOptions()
								}
							}
						})
					};
					await api.setConfig(next, sessionId, target);
					const stored = await api.getConfig(sessionId);
					applyConfig(stored);
					setPicked({});
					setSkipped(failed);
					if (stored.persisted === false) {
						setSaveError(stored.persistError ?? t("sources.persistFailed"));
						return;
					}
					const profName = (stored.profiles.find((entry) => entry.id === stored.activeProfile) ?? profile).name ?? profileId;
					setSaved(profName);
					setSavedTarget(target);
				} catch (caught) {
					setSaveError(caught instanceof Error ? caught.message : String(caught));
				} finally {
					setBusy(false);
				}
			}, [
				config,
				sessionId,
				picked,
				rows,
				elfPath,
				configPath,
				nmPath,
				intervalText,
				intervalMode,
				enabled,
				applyConfig,
				driver,
				openocdExe,
				jlinkExe,
				jlinkDevice,
				jlinkInterface,
				jlinkSpeed,
				jlinkGdbPort,
				jlinkTelnetPort,
				jlinkSerial,
				jlinkAutoStart
			]);
			const rttDescriptors = (0, react.useMemo)(() => (state?.descriptors ?? []).filter((descriptor) => descriptor.source === "rttVar"), [state]);
			const rttNames = rttDescriptors.length > 0 ? rttDescriptors.map((descriptor) => descriptor.name) : state?.series.names ?? [];
			const usingFallback = rttDescriptors.length === 0 && rttNames.length > 0;
			const symbolRows = symbols === void 0 ? [] : symbols;
			const selectedCount = Object.keys(picked).length;
			return (0, react.createElement)("span", null, (0, react.createElement)("button", {
				type: "button",
				className: `rttd-btn rttd-btn-sm${open ? " rttd-btn-active" : ""}`,
				onClick: () => setOpen((value) => !value),
				title: t("sources.title")
			}, t("sources.open")), !open ? null : (0, react.createElement)("div", {
				className: "rttd-modal-backdrop",
				onClick: (event) => {
					if (event.target === event.currentTarget) setOpen(false);
				}
			}, (0, react.createElement)("div", { className: "rttd-sources" }, (0, react.createElement)("div", { className: "rttd-sources-title" }, (0, react.createElement)("span", null, t("sources.title")), (0, react.createElement)("span", { className: "rttd-spacer" }), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: () => setOpen(false),
				title: t("btn.close"),
				style: {
					padding: "0 6px",
					lineHeight: "18px"
				}
			}, "✕")), (0, react.createElement)("div", { className: "rttd-sources-section" }, (0, react.createElement)("div", { className: "rttd-sources-heading" }, t("sources.rttSection")), (0, react.createElement)("div", { className: "rttd-sources-row" }, (0, react.createElement)("span", { className: "rttd-label" }, t("sources.parser")), (0, react.createElement)("span", { className: "rttd-sources-mono" }, parserId ?? "—")), rttNames.length === 0 ? (0, react.createElement)("div", { className: "rttd-sources-note" }, t("sources.rttNone")) : (0, react.createElement)("div", { className: "rttd-sources-row" }, ...rttNames.map((name) => (0, react.createElement)("span", {
				key: name,
				className: "rttd-chip rttd-chip-on"
			}, (0, react.createElement)("span", { className: "rttd-dot" }), name))), usingFallback ? (0, react.createElement)("div", { className: "rttd-sources-hint" }, t("sources.rttFallbackHint")) : null, (0, react.createElement)("div", {
				className: "rttd-sources-heading",
				style: { marginTop: "8px" }
			}, t("sources.parserSection")), (0, react.createElement)("div", { className: "rttd-sources-row" }, (0, react.createElement)("span", { className: "rttd-label" }, t("sources.parserId")), (0, react.createElement)("select", {
				className: "rttd-sources-input rttd-sources-select",
				value: parserId,
				onChange: (event) => setParserId(event.target.value)
			}, ...PARSER_IDS.map((id) => (0, react.createElement)("option", {
				key: id,
				value: id
			}, id))), (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.parserTerminatorHint")
			}, t("sources.parserTerminator")), (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				value: parserTerminator,
				placeholder: "\\n",
				title: t("sources.parserTerminatorHint"),
				onChange: (event) => setParserTerminator(event.target.value)
			})), parserId === "custom-regex" ? (0, react.createElement)("div", { className: "rttd-sources-row" }, (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.parserPatternHint")
			}, t("sources.parserPattern")), (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { flex: "1 1 auto" },
				value: parserPattern,
				placeholder: "DATA: V=(?<volt>\\d+)",
				onChange: (event) => setParserPattern(event.target.value)
			}), (0, react.createElement)("span", { className: "rttd-label" }, t("sources.parserFlags")), (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				value: parserFlags,
				placeholder: "g",
				onChange: (event) => setParserFlags(event.target.value)
			})) : null, parserId === "script" ? (0, react.createElement)("div", { style: { marginTop: "4px" } }, (0, react.createElement)("div", {
				className: "rttd-sources-label",
				title: t("sources.parserExpressionHint")
			}, t("sources.parserExpression")), (0, react.createElement)("textarea", {
				className: "rttd-sources-textarea",
				rows: 3,
				spellCheck: false,
				value: parserExpression,
				placeholder: "{ volt: fields[0] * 3.3 / 4095, amps: fields[1] / 1000 }",
				onChange: (event) => setParserExpression(event.target.value)
			}), (0, react.createElement)("label", { className: "rttd-check" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: parserSkipFirst,
				onChange: (event) => setParserSkipFirst(event.target.checked)
			}), t("sources.parserSkipFirst")), (0, react.createElement)("div", { className: "rttd-sources-hint" }, t("sources.parserSandboxNote")), parserError === void 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-error" }, parserError)) : null, parserId === "custom-regex" ? null : (0, react.createElement)("div", { className: "rttd-sources-row" }, (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.parserDelimiterHint")
			}, t("sources.parserDelimiter")), (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				value: parserDelimiter,
				placeholder: ",",
				title: t("sources.parserDelimiterHint"),
				onChange: (event) => setParserDelimiter(event.target.value)
			}))), (0, react.createElement)("div", { className: "rttd-sources-section" }, (0, react.createElement)("div", { className: "rttd-sources-heading" }, t("sources.ocdSection")), (0, react.createElement)("div", {
				className: "rttd-tabs",
				title: t("driver.hint")
			}, (0, react.createElement)("button", {
				type: "button",
				className: `rttd-tab${driver === "openocd" ? " rttd-tab-active" : ""}`,
				onClick: () => setDriver("openocd")
			}, t("driver.tabOpenocd")), (0, react.createElement)("button", {
				type: "button",
				className: `rttd-tab${driver === "jlink" ? " rttd-tab-active" : ""}`,
				onClick: () => setDriver("jlink")
			}, t("driver.tabJlink"))), configError === void 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-error" }, t("sources.loadFailed", { message: configError })), (0, react.createElement)("label", { className: "rttd-check" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: enabled,
				onChange: (event) => setEnabled(event.target.checked)
			}), t("sources.enabled")), (0, react.createElement)("div", { className: "rttd-sources-grid" }, driver === "openocd" ? (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.configPathHint")
			}, t("sources.configPath")) : (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("driver.jlinkExecutableHint")
			}, t("driver.jlinkExecutable")), driver === "openocd" ? (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "6px",
				width: "100%",
				alignItems: "center"
			} }, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { flex: "1 1 auto" },
				value: configPath,
				placeholder: "如 mcu/openocd.cfg 或完整路径",
				onChange: (event) => setConfigPath(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-browse-btn",
				onClick: () => setPickerTarget("configPath")
			}, t("sources.browseFile"))) : (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "6px",
				width: "100%",
				alignItems: "center"
			} }, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { flex: "1 1 auto" },
				value: jlinkExe,
				placeholder: "C:\\Program Files\\SEGGER\\JLink\\JLinkGDBServerCL.exe",
				onChange: (event) => setJlinkExe(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-browse-btn",
				onClick: () => setPickerTarget("jlinkExe")
			}, t("sources.browseFile"))), driver === "openocd" ? (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("driver.openocdExecutableHint")
			}, t("driver.openocdExecutable")) : null, driver === "openocd" ? (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "6px",
				width: "100%",
				alignItems: "center"
			} }, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { flex: "1 1 auto" },
				value: openocdExe,
				placeholder: "openocd",
				onChange: (event) => setOpenocdExe(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-browse-btn",
				onClick: () => setPickerTarget("openocdExe")
			}, t("sources.browseFile"))) : null, driver !== "jlink" ? null : (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("driver.jlinkDeviceHint")
			}, t("driver.jlinkDevice")), driver !== "jlink" ? null : (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "6px",
				width: "100%",
				alignItems: "center"
			} }, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { flex: "1 1 auto" },
				value: jlinkDevice,
				placeholder: "STM32F407VG",
				onChange: (event) => setJlinkDevice(event.target.value)
			}), (0, react.createElement)("span", { className: "rttd-unit-selector" }, (0, react.createElement)("button", {
				type: "button",
				className: `rttd-unit-btn${jlinkInterface === "SWD" ? " rttd-unit-btn-active" : ""}`,
				onClick: () => setJlinkInterface("SWD")
			}, "SWD"), (0, react.createElement)("button", {
				type: "button",
				className: `rttd-unit-btn${jlinkInterface === "JTAG" ? " rttd-unit-btn-active" : ""}`,
				onClick: () => setJlinkInterface("JTAG")
			}, "JTAG"))), driver !== "jlink" ? null : (0, react.createElement)("span", { className: "rttd-label" }, t("driver.jlinkSpeed")), driver !== "jlink" ? null : (0, react.createElement)("span", { className: "rttd-sources-row" }, (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				type: "number",
				min: "0",
				step: "1",
				value: jlinkSpeed,
				onChange: (event) => setJlinkSpeed(event.target.value)
			}), (0, react.createElement)("span", { className: "rttd-label" }, "kHz")), driver !== "jlink" ? null : (0, react.createElement)("span", { className: "rttd-label" }, t("driver.jlinkGdbPort")), driver !== "jlink" ? null : (0, react.createElement)("span", { className: "rttd-sources-row" }, (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				type: "number",
				min: "1",
				max: "65535",
				value: jlinkGdbPort,
				onChange: (event) => setJlinkGdbPort(event.target.value)
			}), (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("driver.jlinkRttTelnetHint")
			}, t("driver.jlinkRttTelnetPort")), (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				type: "number",
				min: "1",
				max: "65535",
				value: jlinkTelnetPort,
				onChange: (event) => setJlinkTelnetPort(event.target.value)
			})), driver !== "jlink" ? null : (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("driver.jlinkSerialHint")
			}, t("driver.jlinkSerial")), driver !== "jlink" ? null : (0, react.createElement)("span", { className: "rttd-sources-row" }, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { width: "200px" },
				value: jlinkSerial,
				placeholder: "—",
				onChange: (event) => setJlinkSerial(event.target.value)
			}), (0, react.createElement)("label", {
				className: "rttd-check",
				title: t("driver.jlinkAutoStartHint")
			}, (0, react.createElement)("input", {
				type: "checkbox",
				checked: jlinkAutoStart,
				onChange: (event) => setJlinkAutoStart(event.target.checked)
			}), t("driver.jlinkAutoStart"))), driver !== "jlink" ? null : (0, react.createElement)("div", {
				className: "rttd-sources-hint",
				style: { gridColumn: "1 / -1" }
			}, t("driver.jlinkChannels")), (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.elfPathHint")
			}, t("sources.elfPath")), (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "6px",
				width: "100%",
				alignItems: "center"
			} }, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { flex: "1 1 auto" },
				value: elfPath,
				placeholder: "/path/to/firmware.elf",
				onChange: (event) => setElfPath(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-browse-btn",
				onClick: () => setPickerTarget("elfPath")
			}, t("sources.browseFile"))), (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.nmPathHint")
			}, t("sources.nmPath")), (0, react.createElement)("input", {
				className: "rttd-sources-input",
				value: nmPath,
				placeholder: "arm-none-eabi-nm",
				onChange: (event) => setNmPath(event.target.value)
			}), (0, react.createElement)("span", { className: "rttd-label" }, t("sources.interval")), (0, react.createElement)("span", { className: "rttd-sources-row" }, (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				type: "number",
				step: "any",
				min: "0.001",
				value: intervalText,
				onChange: (event) => setIntervalText(event.target.value)
			}), (0, react.createElement)("span", { className: "rttd-unit-selector" }, (0, react.createElement)("button", {
				type: "button",
				className: `rttd-unit-btn${intervalMode === "ms" ? " rttd-unit-btn-active" : ""}`,
				onClick: () => toggleIntervalMode("ms")
			}, "ms"), (0, react.createElement)("button", {
				type: "button",
				className: `rttd-unit-btn${intervalMode === "hz" ? " rttd-unit-btn-active" : ""}`,
				onClick: () => toggleIntervalMode("hz")
			}, "Hz")), (0, react.createElement)("span", { className: "rttd-sources-hint" }, intervalConversionText))), (0, react.createElement)("div", {
				className: "rttd-sources-row",
				style: { marginTop: "6px" }
			}, (0, react.createElement)("span", { className: "rttd-label" }, t("sources.filter")), (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { width: "180px" },
				value: filter,
				placeholder: t("sources.filterPlaceholder"),
				onChange: (event) => setFilter(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				disabled: browsing || elfPath.trim() === "",
				title: elfPath.trim() === "" ? t("sources.browseHint") : void 0,
				onClick: () => void browse()
			}, browsing ? t("sources.browsing") : t("sources.browse")), symbols === void 0 ? null : (0, react.createElement)("span", { className: "rttd-sources-hint" }, symbols.length === 0 ? t("sources.browseEmpty") : t("sources.browseCount", { count: symbols.length }))), symbolRows.length === 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-list" }, ...symbolRows.map((symbol) => (0, react.createElement)("label", {
				key: `${symbol.name}@${symbol.address}`,
				className: "rttd-sources-symbol"
			}, (0, react.createElement)("input", {
				type: "checkbox",
				checked: picked[symbol.name] !== void 0,
				onChange: () => setPicked((previous) => {
					const next = { ...previous };
					if (next[symbol.name] !== void 0) delete next[symbol.name];
					else next[symbol.name] = {
						name: symbol.name,
						address: symbol.address,
						type: symbol.inferredType,
						size: symbol.size
					};
					return next;
				})
			}), (0, react.createElement)("span", {
				className: "rttd-sources-symbol-name",
				title: symbol.name
			}, symbol.name), (0, react.createElement)("span", { className: "rttd-sources-mono" }, hexAddress(symbol.address)), (0, react.createElement)("span", { className: "rttd-sources-mono" }, String(symbol.size)), (0, react.createElement)("span", {}, symbol.inferredType)))), (0, react.createElement)("div", {
				className: "rttd-sources-row",
				style: { marginTop: "6px" }
			}, (0, react.createElement)("span", {
				className: "rttd-label",
				title: t("sources.manualHint")
			}, t("sources.manualLabel")), (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: { width: "260px" },
				value: manual,
				placeholder: t("sources.manualPlaceholder"),
				onChange: (event) => {
					setManual(event.target.value);
					setManualBad(void 0);
				}
			}), (0, react.createElement)("span", { className: "rttd-label" }, t("sources.unit")), (0, react.createElement)("input", {
				className: "rttd-sources-input rttd-sources-input-sm",
				value: manualUnit,
				placeholder: t("sources.unitPlaceholder"),
				onChange: (event) => setManualUnit(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: addManual
			}, t("sources.add"))), manualBad === void 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-error" }, manualBad.reason === "unknown-type" && manualBad.spelling !== void 0 ? (0, react.createElement)("span", null, t("sources.manualBad"), " ", (0, react.createElement)("code", { className: "rttd-sources-mono" }, manualBad.spelling)) : t("sources.manualBad")), (0, react.createElement)("div", {
				className: "rttd-sources-heading",
				style: { marginTop: "8px" }
			}, t("sources.configured", { count: rows.length })), rows.length === 0 ? (0, react.createElement)("div", { className: "rttd-sources-note" }, t("sources.configuredEmpty")) : (0, react.createElement)("table", { className: "rttd-sources-table" }, (0, react.createElement)("thead", null, (0, react.createElement)("tr", null, (0, react.createElement)("th", null, t("sources.columnName")), (0, react.createElement)("th", null, t("sources.columnAddress")), (0, react.createElement)("th", null, t("sources.columnType")), (0, react.createElement)("th", null, t("sources.columnUnit")), (0, react.createElement)("th", null, ""))), (0, react.createElement)("tbody", null, ...rows.map((row, index) => (0, react.createElement)("tr", { key: `${row.name ?? row.symbol ?? index}@${row.address ?? index}` }, (0, react.createElement)("td", { title: row.symbol ?? row.name }, row.name ?? row.symbol ?? "—"), (0, react.createElement)("td", { className: "rttd-sources-mono" }, hexAddress(row.address)), (0, react.createElement)("td", { className: "rttd-sources-mono" }, row.type ?? "u32"), (0, react.createElement)("td", null, (0, react.createElement)("input", {
				className: "rttd-sources-input",
				style: {
					width: "70px",
					padding: "1px 5px",
					fontSize: "11px",
					height: "22px"
				},
				value: row.unit ?? "",
				placeholder: "如 mV / ℃",
				onChange: (event) => {
					const val = event.target.value;
					setRows((previous) => previous.map((r, i) => i !== index ? r : {
						...r,
						unit: val.trim() === "" ? void 0 : val
					}));
				}
			})), (0, react.createElement)("td", null, (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: () => setRows((previous) => previous.filter((_, i) => i !== index))
			}, t("sources.remove"))))))), skipped.length === 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-error" }, t("sources.unresolved"), (0, react.createElement)("ul", { className: "rttd-sources-reasons" }, ...skipped.map((entry) => (0, react.createElement)("li", { key: entry.name }, t("sources.unresolvedItem", {
				name: entry.name,
				reason: entry.reason
			}))))), (0, react.createElement)("div", { className: "rttd-sources-scope-info" }, t("sources.scopeWorkspace")), saved === void 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-ok" }, t("sources.savedWorkspace", { path: ".dsh/rtt-debug.json" })), saveError === void 0 ? null : (0, react.createElement)("div", { className: "rttd-sources-error" }, t("sources.saveFailed", { message: saveError })), (0, react.createElement)("div", { className: "rttd-sources-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm rttd-btn-primary",
				disabled: busy,
				onClick: () => void save("workspace"),
				title: t("sources.saveWorkspaceHint")
			}, busy ? t("sources.saving") : t("sources.saveWorkspace")), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				disabled: busy,
				onClick: () => void load()
			}, t("sources.reload")), (0, react.createElement)("button", {
				type: "button",
				className: "rttd-btn rttd-btn-sm",
				onClick: () => setOpen(false)
			}, t("btn.close")), selectedCount === 0 ? null : (0, react.createElement)("span", { className: "rttd-sources-hint" }, t("sources.browseCount", { count: selectedCount }))), (0, react.createElement)("div", { className: "rttd-sources-note" }, t("sources.needRestartHint")), (0, react.createElement)("div", { className: "rttd-sources-hint" }, t("sources.keepRunningNote")), (0, react.createElement)("div", { className: "rttd-sources-hint" }, t("sources.toolScopeHint")))), pickerTarget === void 0 ? null : (0, react.createElement)(FilePickerModal, {
				open: true,
				targetField: pickerTarget,
				sessionId,
				onSelect: (chosenPath) => {
					if (pickerTarget === "configPath") setConfigPath(chosenPath);
					else if (pickerTarget === "jlinkExe") setJlinkExe(chosenPath);
					else if (pickerTarget === "openocdExe") setOpenocdExe(chosenPath);
					else if (pickerTarget === "elfPath") setElfPath(chosenPath);
					setPickerTarget(void 0);
				},
				onClose: () => setPickerTarget(void 0)
			})));
		}
		function ReadoutStrip(props) {
			const { measurements, delta, hoverTime, pointer, series, visible, viewport, metrics } = props;
			const hoverReadings = (0, react.useMemo)(() => {
				if (hoverTime === void 0) return [];
				return series.filter((entry) => visible.has(entry.name)).map((entry) => ({
					name: entry.name,
					unit: entry.unit,
					value: valueAt(entry, hoverTime)
				})).filter((row) => row.value !== void 0);
			}, [
				hoverTime,
				series,
				visible
			]);
			const rows = [];
			if (delta !== void 0) {
				rows.push((0, react.createElement)("div", {
					key: "__delta",
					className: "rttd-readout-row"
				}, (0, react.createElement)("span", { className: "rttd-readout-key" }, t("readout.delta")), (0, react.createElement)("span", { className: "rttd-readout-val" }, `Δt=${formatTime(delta.deltaTimeMs)} · 1/Δt=${delta.frequencyHz.toFixed(2)} Hz`)));
				for (const row of delta.perSeries) rows.push((0, react.createElement)("div", {
					key: `__d_${row.name}`,
					className: "rttd-readout-row"
				}, (0, react.createElement)("span", { className: "rttd-readout-key" }, row.name), (0, react.createElement)("span", { className: "rttd-readout-val" }, `ΔV=${formatValue(row.deltaV)}`)));
			}
			if (hoverReadings.length > 0) rows.push((0, react.createElement)("div", {
				key: "__hover",
				className: "rttd-readout-row"
			}, (0, react.createElement)("span", { className: "rttd-readout-key" }, t("readout.hover")), (0, react.createElement)("span", { className: "rttd-readout-val" }, hoverReadings.map((row) => `${row.name}=${formatValue(row.value, row.unit)}`).join("  "))));
			for (const row of measurements) {
				const cells = [
					`min=${formatValue(row.result.min ?? NaN)}`,
					`max=${formatValue(row.result.max ?? NaN)}`,
					`Vpp=${formatValue(row.result.peakToPeak ?? NaN)}`,
					`mean=${formatValue(row.result.mean ?? NaN)}`,
					row.result.frequencyHz === void 0 ? "f=—" : `f=${row.result.frequencyHz.toFixed(2)}Hz`,
					row.result.riseTimeMs === void 0 ? "tr=—" : `tr=${formatTime(row.result.riseTimeMs)}`
				];
				rows.push((0, react.createElement)("div", {
					key: `__m_${row.name}`,
					className: "rttd-readout-row"
				}, (0, react.createElement)("span", { className: "rttd-readout-key" }, row.name), (0, react.createElement)("span", { className: "rttd-readout-val" }, cells.join("  "))));
			}
			if (pointer !== void 0 && pointer.x >= metrics.left && hoverTime !== void 0) rows.push((0, react.createElement)("div", {
				key: "__hint",
				className: "rttd-readout-hint"
			}, `t=${formatTime(hoverTime - viewport.tMax)}`));
			return (0, react.createElement)("div", { className: "rttd-readout" }, ...rows);
		}
		function LogToolbar(props) {
			return (0, react.createElement)("div", { className: "rttd-toolbar rttd-toolbar-sub" }, (0, react.createElement)("input", {
				className: "rttd-input",
				value: props.filter,
				placeholder: t("log.filterPlaceholder"),
				onChange: (event) => props.setFilter(event.target.value)
			}), (0, react.createElement)("label", { className: "rttd-check" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: props.useRegex,
				onChange: (event) => props.setUseRegex(event.target.checked)
			}), t("log.regex")), (0, react.createElement)("label", { className: "rttd-check" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: props.follow,
				onChange: (event) => props.setFollow(event.target.checked)
			}), t("log.follow")), (0, react.createElement)("span", { className: "rttd-spacer" }), (0, react.createElement)("span", {
				className: "rttd-counter",
				title: t("log.completenessHint")
			}, t("log.counters", {
				retained: props.retained,
				total: props.total
			})), (0, react.createElement)("button", {
				className: "rttd-btn rttd-btn-sm",
				type: "button",
				onClick: props.onExport
			}, t("log.export")), (0, react.createElement)("button", {
				className: "rttd-btn rttd-btn-sm",
				type: "button",
				onClick: props.onClearLog
			}, t("btn.clear")));
		}
		/**
		* Scrollable log body.
		*
		* Renders plain rows rather than a virtualised list: the host ring caps the
		* line count (5000 by default), and windowing that many simple rows costs more
		* in complexity than it saves in layout.
		*/
		function LogList(props) {
			const [jumpVisible, setJumpVisible] = (0, react.useState)(false);
			const onScroll = (0, react.useCallback)((event) => {
				const node = event.currentTarget;
				const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
				setJumpVisible(!atBottom);
			}, []);
			return (0, react.createElement)("div", { className: "rttd-log-wrap" }, (0, react.createElement)("div", {
				className: "rttd-log",
				ref: props.logRef,
				onScroll
			}, ...props.records.map((record) => (0, react.createElement)("div", {
				key: record.seq,
				className: `rttd-log-line rttd-log-${record.level}`
			}, (0, react.createElement)("span", { className: "rttd-log-ts" }, new Date(record.ts).toLocaleTimeString(void 0, { hour12: false }) + "." + String(record.ts % 1e3).padStart(3, "0")), (0, react.createElement)("span", { className: `rttd-log-level rttd-log-level-${record.level}` }, record.level.toUpperCase()), (0, react.createElement)("span", { className: "rttd-log-text" }, ...record.spans.length === 0 ? [record.text] : record.spans.map((span, index) => (0, react.createElement)("span", {
				key: index,
				style: {
					color: ansiColorToCss(span.color),
					fontWeight: span.bold === true ? 600 : void 0,
					fontStyle: span.italic === true ? "italic" : void 0,
					textDecoration: span.underline === true ? "underline" : void 0
				}
			}, span.text)))))), jumpVisible ? (0, react.createElement)("button", {
				className: "rttd-jump",
				type: "button",
				onClick: () => {
					const node = props.logRef.current;
					if (node !== null) node.scrollTop = node.scrollHeight;
				}
			}, t("log.jumpToLatest")) : null);
		}
		/** Merge incoming samples into the existing series, creating new ones as needed. */
		function mergeSamples(current, samples, capPerSeries = 1e5) {
			if (samples.length === 0) return current;
			const byName = new Map(current.map((entry) => [entry.name, entry]));
			for (const sample of samples) for (const [name, value] of Object.entries(sample.values)) {
				let entry = byName.get(name);
				if (entry === void 0) {
					entry = {
						name,
						kind: typeof value === "boolean" ? "bool" : "number",
						ts: [],
						values: []
					};
					byName.set(name, entry);
					current = current.concat(entry);
				}
				entry.ts.push(sample.ts);
				entry.values.push(value);
			}
			for (const entry of byName.values()) if (entry.ts.length > capPerSeries) {
				const drop = entry.ts.length - capPerSeries;
				entry.ts.splice(0, drop);
				entry.values.splice(0, drop);
			}
			return current;
		}
		/** Apply the toolbar's filter to the log ring. */
		function filterLog(records, filter, useRegex) {
			const needle = filter.trim();
			if (needle === "") return records;
			if (useRegex) {
				let regex;
				try {
					regex = new RegExp(needle, "i");
				} catch {
					return records;
				}
				return records.filter((record) => regex.test(record.text));
			}
			const lower = needle.toLowerCase();
			return records.filter((record) => record.text.toLowerCase().includes(lower));
		}
		/** Map a decoded ANSI colour name onto a readable CSS colour. */
		function ansiColorToCss(color) {
			if (color === void 0) return void 0;
			return {
				black: "#3b3f46",
				red: "#ff6b6b",
				green: "#69db7c",
				yellow: "#ffd43b",
				blue: "#4dabf7",
				magenta: "#da77f2",
				cyan: "#3bc9db",
				white: "#e9ecef",
				brightBlack: "#868e96",
				brightRed: "#ff8787",
				brightGreen: "#8ce99a",
				brightYellow: "#ffe066",
				brightBlue: "#74c0fc",
				brightMagenta: "#e599f7",
				brightCyan: "#66d9e8",
				brightWhite: "#f8f9fa"
			}[color];
		}
		// src/client/styles.ts
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
		const PANEL_CSS = `
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
`;
		// src/client/index.tsx
		/**
		* Client half entry: register the panel as a sidebar page.
		*
		* The spec asks for the SAME view on two surfaces (D3), so this module does
		* both registrations against one component:
		*
		*   - the **native right sidebar** (`ctx.sidebarRightTabs` + the keyed
		*     `sidebar.right.pane.tab` slot) — stage one declares the tab TYPE, stage
		*     two supplies its BODY under the same id;
		*   - the **sidebar workbench** (`ctx.betterSidebar.registerTab`) when that
		*     plugin is installed.
		*
		* Neither registration is required: if only one host is present the other is
		* skipped, so the plugin degrades instead of failing to activate.
		*/
		const name = "dsh-rtt-debug";
		/** Tab kind used by the native sidebar and by the workbench registration. */
		const KIND = "rtt-debug";
		/** Implementation id — also the key the body slot registers under. */
		const IMPL_ID = "dsh-rtt-debug";
		/**
		* Inject the stylesheet once per document.
		*
		* A `<style data-plugin>` element is used so the host's HMR teardown can find
		* and remove it, matching how built-in client plugins inject their CSS.
		*/
		function injectStyles() {
			const marker = "dsh-rtt-debug/styles";
			if (document.querySelector(`style[data-plugin="${marker}"]`) !== null) return () => {};
			const style = document.createElement("style");
			style.setAttribute("data-plugin", marker);
			style.textContent = PANEL_CSS;
			document.head.appendChild(style);
			return () => style.remove();
		}
		/** Read the host's active language, when a locale service is reachable. */
		function syncLanguage(ctx) {
			const locale = ctx.get?.("locale");
			const active = locale?.active ?? locale?.get?.();
			setLanguage(typeof active === "string" ? active : void 0);
		}
		function apply(ctx) {
			const disposers = [];
			syncLanguage(ctx);
			disposers.push(injectStyles());
			const panel = (sessionId) => (0, react.createElement)(RttDebugPanel, sessionId === void 0 ? {} : { sessionId });
			ctx.inject?.(["sidebarRightTabs"], (injected) => {
				const tabs = injected.get("sidebarRightTabs");
				if (tabs === void 0) return;
				const slots = injected.get("slots");
				if (slots === void 0) return;
				const disposeType = tabs.register({
					id: IMPL_ID,
					kind: KIND,
					priority: "extension",
					title: () => t("tab.title"),
					guide: [{
						order: 40,
						title: () => t("tab.title"),
						description: () => t("tab.description")
					}]
				});
				const body = slots.inject("sidebar.right.pane.tab", () => slots.register({
					name: "sidebar.right.pane.tab",
					key: IMPL_ID,
					inject: () => ({})
				}, (props) => panel(props.tab?.id)));
				injected.effect(() => () => {
					body();
					disposeType();
				}, "dsh-rtt-debug: native sidebar tab");
			});
			ctx.inject?.(["betterSidebar"], (injected) => {
				const workbench = injected.get("betterSidebar");
				if (workbench === void 0) return;
				injected.effect(() => workbench.registerTab({
					id: `${IMPL_ID}:panel`,
					title: () => t("tab.title"),
					description: () => t("tab.description"),
					order: 70,
					single: true,
					component: () => panel()
				}), "dsh-rtt-debug: workbench tab");
			});
			ctx.effect(() => () => {
				for (const dispose of disposers) dispose();
			}, "dsh-rtt-debug: client registrations");
		}
		exports.RttDebugPanel = RttDebugPanel;
		exports.TAB_KIND = KIND;
		exports.apply = apply;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map