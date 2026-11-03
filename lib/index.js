import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
// src/core/ws.ts
/**
* Minimal RFC 6455 WebSocket server.
*
* The plugin streams two live feeds to the browser and needs nothing beyond the
* handshake, text frames, ping/pong and close — so it implements those directly
* instead of taking a dependency. That keeps the host half dependency-free
* (spec C1/C3 context: no runtime dependency is installed for this plugin).
*
* Deliberately NOT implemented, because nothing here needs them: extensions
* (`permessage-deflate`), subprotocols, fragmented message reassembly beyond
* continuation frames, and client-side masking (a server never masks).
*/
/** The fixed GUID from RFC 6455 §1.3. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Opcodes this server understands. */
const OP_CONTINUATION = 0;
const OP_TEXT = 1;
const OP_BINARY = 2;
const OP_CLOSE = 8;
const OP_PING = 9;
const OP_PONG = 10;
/** Refuse absurd frames rather than allocating for them. */
const MAX_PAYLOAD_BYTES = 4194304;
/**
* One upgraded socket.
*
* Incoming frames are parsed incrementally: a frame may arrive split across
* several TCP reads, so a byte buffer is retained until a whole frame is
* available.
*/
var ServerWebSocket = class {
	socket;
	buffer = Buffer.alloc(0);
	state = 0;
	closeListeners = [];
	errorListeners = [];
	messageListeners = [];
	constructor(socket) {
		this.socket = socket;
		socket.on("data", (chunk) => this.onData(chunk));
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => this.markClosed());
		this.state = 1;
	}
	get readyState() {
		return this.state;
	}
	on(event, listener) {
		if (event === "close") this.closeListeners.push(listener);
		else if (event === "error") this.errorListeners.push(listener);
		else this.messageListeners.push(listener);
	}
	/** Send a text frame (never masked — this is the server side). */
	send(data) {
		if (this.state !== 1) return;
		this.writeFrame(OP_TEXT, Buffer.from(data, "utf8"));
	}
	ping() {
		if (this.state !== 1) return;
		this.writeFrame(OP_PING, Buffer.alloc(0));
	}
	/** Send a close frame and end the socket. */
	close() {
		if (this.state === 3 || this.state === 2) return;
		this.state = 2;
		try {
			this.writeFrame(OP_CLOSE, Buffer.alloc(0));
		} catch {}
		this.socket.end();
		this.markClosed();
	}
	writeFrame(opcode, payload) {
		const length = payload.length;
		let header;
		if (length < 126) {
			header = Buffer.alloc(2);
			header[1] = length;
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		header[0] = 128 | opcode;
		this.socket.write(Buffer.concat([header, payload]));
	}
	onData(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const frame = this.readFrame();
			if (frame === void 0) return;
			const { opcode, payload } = frame;
			if (opcode === OP_CLOSE) {
				this.close();
				return;
			}
			if (opcode === OP_PING) {
				this.writeFrame(OP_PONG, payload);
				continue;
			}
			if (opcode === OP_PONG) continue;
			if (opcode === OP_TEXT || opcode === OP_BINARY || opcode === OP_CONTINUATION) {
				const text = payload.toString("utf8");
				for (const listener of this.messageListeners) listener(text);
			}
		}
	}
	/**
	* Try to pull one complete frame off the buffer.
	* @returns the frame, or `undefined` when more bytes are needed.
	* @throws when the frame violates the protocol.
	*/
	readFrame() {
		if (this.buffer.length < 2) return void 0;
		const first = this.buffer[0];
		const second = this.buffer[1];
		const opcode = first & 15;
		const masked = (second & 128) !== 0;
		let length = second & 127;
		let offset = 2;
		if (length === 126) {
			if (this.buffer.length < offset + 2) return void 0;
			length = this.buffer.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (this.buffer.length < offset + 8) return void 0;
			const big = this.buffer.readBigUInt64BE(offset);
			if (big > BigInt(MAX_PAYLOAD_BYTES)) throw new Error("websocket frame too large");
			length = Number(big);
			offset += 8;
		}
		if (length > MAX_PAYLOAD_BYTES) throw new Error("websocket frame too large");
		let maskKey;
		if (masked) {
			if (this.buffer.length < offset + 4) return void 0;
			maskKey = this.buffer.subarray(offset, offset + 4);
			offset += 4;
		} else if (opcode !== OP_CLOSE) throw new Error("client frame is not masked");
		if (this.buffer.length < offset + length) return void 0;
		const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
		if (maskKey !== void 0) for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i] ^ maskKey[i % 4];
		this.buffer = this.buffer.subarray(offset + length);
		return {
			opcode,
			payload
		};
	}
	fail(error) {
		for (const listener of this.errorListeners) listener(error);
		this.markClosed();
	}
	markClosed() {
		if (this.state === 3) return;
		this.state = 3;
		for (const listener of this.closeListeners) listener();
	}
};
/**
* Complete the WebSocket handshake over an upgraded socket.
*
* @returns the live socket, or `undefined` when the request is not a valid
*   WebSocket upgrade (the caller should then destroy the socket).
*/
function acceptWebSocket(req, socket) {
	const key = req.headers["sec-websocket-key"];
	if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" || key === "") return;
	const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r\n\r
`);
	return new ServerWebSocket(socket);
}
// src/core/framing.ts
/**
* Line/word framing helpers shared by every streaming parser.
*
* Chunk boundaries are the single most common source of parser bugs: a TCP
* read can split a line anywhere, including between the CR and LF of one
* terminator. These helpers keep the partial tail so the next `feed` completes
* it, and they cap the retained tail so a source that never emits a terminator
* cannot grow memory without bound.
*/
/** Retained-tail cap when no terminator ever arrives (~1 MiB of pending text). */
const DEFAULT_MAX_PENDING = 1 << 20;
/**
* Turn a user-typed terminator into the character(s) it names.
*
* A settings field is a text box, so the user cannot type a real newline. Two
* spellings are therefore accepted, and both are what people actually write:
*
*   - escape sequences: `\n`, `\r`, `\r\n`, `\t`, `\0`, `\\`
*   - a literal single character, which is what a paste produces
*
* Anything unrecognised is returned verbatim, so a genuinely odd delimiter
* still works instead of silently becoming `\n`.
*
* @param raw - the user's text.
* @returns the terminator string (never empty).
*/
function decodeTerminator(raw) {
	if (raw === "") return "\n";
	const ESCAPES = {
		"\\n": "\n",
		"\\r": "\r",
		"\\t": "	",
		"\\0": "\0",
		"\\s": " ",
		"\\\\": "\\"
	};
	const direct = ESCAPES[raw];
	if (direct !== void 0) return direct;
	const expanded = raw.replace(/\\([nrt0s\\])/g, (_match, ch) => ESCAPES[`\\${ch}`] ?? ch);
	return expanded === "" ? "\n" : expanded;
}
/**
* Accumulates bytes and emits complete lines.
*
* Decoding runs on the joined buffer, so a multi-byte UTF-8 sequence split
* across two chunks is decoded correctly. Line ending is stripped and both
* `\n` and `\r\n` are accepted.
*/
var LineSplitter = class {
	decoder = new TextDecoder("utf-8");
	pending = "";
	maxPending;
	/**
	* Record terminator.
	*
	* `\n` is the default because that is what almost every firmware prints, but
	* a target may frame records with `\r`, `\0`, or any other single character —
	* so the terminator is data, not a constant. A CR immediately before the
	* terminator is still stripped, which is what makes `\r\n` work whether the
	* terminator is configured as `\n` or as `\r\n`-collapsed `\r`.
	*/
	terminator;
	/**
	* @param maxPending - retained-tail cap in characters.
	* @param terminator - record terminator (default `'\n'`).
	*/
	constructor(maxPending = DEFAULT_MAX_PENDING, terminator = "\n") {
		this.maxPending = maxPending;
		this.terminator = terminator;
	}
	/** Change the terminator (safe mid-stream; the pending tail is kept). */
	setTerminator(terminator) {
		this.terminator = terminator === "" ? "\n" : terminator;
	}
	getTerminator() {
		return this.terminator;
	}
	/**
	* Feed one raw chunk.
	* @param chunk - bytes as they arrived.
	* @returns every complete line the chunk completed, terminator stripped.
	*/
	push(chunk) {
		if (chunk.length > 0) this.pending += this.decoder.decode(chunk, { stream: true });
		const out = [];
		let start = 0;
		for (;;) {
			const nl = this.pending.indexOf(this.terminator, start);
			if (nl === -1) break;
			let end = nl;
			if (end > start && this.pending.charCodeAt(end - 1) === 13) end -= 1;
			out.push(this.pending.slice(start, end));
			start = nl + this.terminator.length;
		}
		this.pending = start === 0 ? this.pending : this.pending.slice(start);
		if (this.pending.length > this.maxPending) this.pending = this.pending.slice(this.pending.length - this.maxPending);
		return out;
	}
	/** Flush any decoder holdover and return the unterminated tail, if any. */
	flush() {
		const rest = this.pending + this.decoder.decode();
		this.decoder = new TextDecoder("utf-8");
		this.pending = "";
		return rest === "" ? void 0 : rest;
	}
	reset() {
		this.decoder = new TextDecoder("utf-8");
		this.pending = "";
	}
};
/**
* Splits a byte stream into fixed-size frames.
*
* Used by the binary variable parser: a target streaming raw structs has no
* line terminator at all, so framing comes from the declared frame length.
*/
var FixedFrameSplitter = class {
	pending = /* @__PURE__ */ new Uint8Array(0);
	frameLength;
	/**
	* @param frameLength - bytes per frame; must be a positive integer.
	*/
	constructor(frameLength) {
		if (!Number.isInteger(frameLength) || frameLength <= 0) throw new RangeError(`frameLength must be a positive integer, got ${String(frameLength)}`);
		this.frameLength = frameLength;
	}
	/** Resize the frame length (drops any partial frame). */
	setFrameLength(frameLength) {
		if (!Number.isInteger(frameLength) || frameLength <= 0) throw new RangeError(`frameLength must be a positive integer, got ${String(frameLength)}`);
		this.frameLength = frameLength;
	}
	/** @returns each complete frame the chunk completed. */
	push(chunk) {
		const merged = new Uint8Array(this.pending.length + chunk.length);
		merged.set(this.pending, 0);
		merged.set(chunk, this.pending.length);
		const count = Math.floor(merged.length / this.frameLength);
		const out = [];
		for (let i = 0; i < count; i += 1) {
			const at = i * this.frameLength;
			out.push(merged.subarray(at, at + this.frameLength));
		}
		this.pending = merged.subarray(count * this.frameLength);
		return out;
	}
	reset() {
		this.pending = /* @__PURE__ */ new Uint8Array(0);
	}
};
// src/core/ansi.ts
/** The 8 base SGR foreground codes plus their bright counterparts. */
const FG_CODES = {
	30: "black",
	31: "red",
	32: "green",
	33: "yellow",
	34: "blue",
	35: "magenta",
	36: "cyan",
	37: "white",
	90: "brightBlack",
	91: "brightRed",
	92: "brightGreen",
	93: "brightYellow",
	94: "brightBlue",
	95: "brightMagenta",
	96: "brightCyan",
	97: "brightWhite"
};
/** Matches one SGR escape; other escape families are matched for stripping. */
const SGR = /\x1b\[([0-9;]*)m/g;
/** Any other CSI/FE escape sequence that must not reach the view as text. */
const OTHER_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
/**
* Stateful SGR decoder: `push` one line's raw text, get styled spans back,
* with the style state carried into the next line.
*/
var AnsiDecoder = class {
	style = {};
	/** Current style (what a newly started line inherits). */
	current() {
		return { ...this.style };
	}
	/** Drop carried state — used on reconnect so a new stream starts clean. */
	reset() {
		this.style = {};
	}
	/**
	* Decode one line.
	* @param raw - line text, possibly containing escape sequences.
	* @returns the display spans; concatenating their `text` gives the clean line
	*   text, so callers never need a second pass to strip escapes.
	*/
	push(raw) {
		const spans = [];
		let cursor = 0;
		SGR.lastIndex = 0;
		for (const match of raw.matchAll(SGR)) {
			const at = match.index;
			if (at > cursor) this.emit(spans, raw.slice(cursor, at));
			this.applySgr(match[1] ?? "");
			cursor = at + match[0].length;
		}
		if (cursor < raw.length) this.emit(spans, stripOtherEscapes(raw.slice(cursor)));
		return spans;
	}
	emit(spans, text) {
		if (text === "") return;
		const span = { text };
		if (this.style.color !== void 0) span.color = this.style.color;
		if (this.style.bold === true) span.bold = true;
		if (this.style.underline === true) span.underline = true;
		if (this.style.italic === true) span.italic = true;
		spans.push(span);
	}
	/** Apply one SGR parameter list to the running style. */
	applySgr(params) {
		const codes = params === "" ? [0] : params.split(";").map((p) => p === "" ? 0 : Number.parseInt(p, 10));
		for (const code of codes) {
			if (Number.isNaN(code)) continue;
			if (code === 0) {
				this.style = {};
				continue;
			}
			if (code === 1) {
				this.style.bold = true;
				continue;
			}
			if (code === 3) {
				this.style.italic = true;
				continue;
			}
			if (code === 4) {
				this.style.underline = true;
				continue;
			}
			if (code === 22) {
				delete this.style.bold;
				continue;
			}
			if (code === 23) {
				delete this.style.italic;
				continue;
			}
			if (code === 24) {
				delete this.style.underline;
				continue;
			}
			if (code === 39) {
				delete this.style.color;
				continue;
			}
			const color = FG_CODES[code];
			if (color !== void 0) this.style.color = color;
		}
	}
};
/** Removes non-SGR escape sequences so they never render as literal text. */
function stripOtherEscapes(text) {
	OTHER_ESCAPE.lastIndex = 0;
	return text.replace(OTHER_ESCAPE, "");
}
/**
* Word-level severity detection.
*
* Deliberately conservative: matching a bare `E` or a stray `error` inside a
* symbol name would mis-colour ordinary lines, so only unambiguous
* bracketed/prefixed level markers and standalone keywords count.
*
* `ok`/`success`/`done` map to `info` rather than a level of their own: they
* mark an ordinary successful line, which is exactly what `info` means in a
* log view, and giving them a separate colour would imply a severity the log
* does not have.
*/
const LEVEL_PATTERNS = [
	{
		level: "error",
		re: /(?:^|[\s[(<])(?:error|err|fatal|fail(?:ed|ure)?)(?:[\s\])>:]|$)/i
	},
	{
		level: "warn",
		re: /(?:^|[\s[(<])(?:warn(?:ing)?|wrn)(?:[\s\])>:]|$)/i
	},
	{
		level: "debug",
		re: /(?:^|[\s[(<])(?:dbg|debug|trace|verbose)(?:[\s\])>:]|$)/i
	},
	{
		level: "info",
		re: /(?:^|[\s[(<])(?:info|inf|notice|ok|success|done)(?:[\s\])>:]|$)/i
	}
];
/**
* Classify a line's severity.
*
* Order matters: a line reading "INFO: error count 0" is an INFO line about an
* error counter, while "ERROR: info sync failed" is an error — the FIRST
* marker in the line wins, which is how loggers prefix their levels.
*/
function detectLevel(text) {
	let bestAt = Number.POSITIVE_INFINITY;
	let best = "unknown";
	for (const { level, re } of LEVEL_PATTERNS) {
		const m = re.exec(text);
		if (m === null) continue;
		const at = m.index + (m[0].length - m[0].trimStart().length);
		if (at < bestAt) {
			bestAt = at;
			best = level;
		}
	}
	return best;
}
// src/core/store.ts
const DEFAULT_SERIES_OPTIONS = {
	retentionMs: 6e5,
	maxPointsPerSeries: 1e5,
	sampleRateHz: 10
};
/**
* Per-variable ring buffers with time- and size-based trimming.
*
* Decimation keeps the most recent value in each interval: for a waveform the
* newest reading is the truthful one, and averaging would invent values the
* target never produced.
*/
var SeriesStore = class {
	series = /* @__PURE__ */ new Map();
	options;
	/** Last accepted timestamp per series, for decimation. */
	lastAccepted = /* @__PURE__ */ new Map();
	/**
	* Newest timestamp ever appended.
	*
	* Trimming is relative to THIS, not to the wall clock: a source may stamp its
	* own samples (target uptime in milliseconds is the usual choice), and those
	* numbers share no epoch with `Date.now()`. Anchoring the retention window to
	* the newest sample keeps the window meaningful for both stamped and
	* host-timestamped sources instead of silently discarding every point.
	*/
	newestTs = Number.NEGATIVE_INFINITY;
	constructor(options = {}) {
		this.options = {
			...DEFAULT_SERIES_OPTIONS,
			...options
		};
	}
	/** Apply new limits; trims every series immediately so a shrink takes effect. */
	configure(options) {
		this.options = {
			...this.options,
			...options
		};
		for (const s of this.series.values()) this.trim(s);
	}
	getOptions() {
		return { ...this.options };
	}
	/** Series names, in first-seen order. */
	names() {
		return [...this.series.keys()];
	}
	get(name) {
		return this.series.get(name);
	}
	all() {
		return [...this.series.values()];
	}
	/**
	* Append samples.
	* @param samples - samples from any source; each is routed to its own series.
	* @returns the number of points actually stored (after decimation).
	*/
	append(samples) {
		let stored = 0;
		for (const sample of samples) {
			if (Number.isFinite(sample.ts) && sample.ts > this.newestTs) this.newestTs = sample.ts;
			for (const [name, value] of Object.entries(sample.values)) {
				if (!this.accept(name, sample.ts)) continue;
				const series = this.ensure(name, typeof value === "boolean" ? "bool" : "number");
				series.ts.push(sample.ts);
				series.values.push(value);
				this.lastAccepted.set(name, sample.ts);
				stored += 1;
			}
		}
		for (const s of this.series.values()) this.trim(s);
		return stored;
	}
	/** Attach/refresh unit metadata discovered by a parser. */
	setMeta(name, meta) {
		const series = this.series.get(name);
		if (series === void 0) return;
		if (meta.unit !== void 0) series.unit = meta.unit;
		if (meta.kind !== void 0) series.kind = meta.kind;
	}
	/** Drop every series. */
	clear() {
		this.series.clear();
		this.lastAccepted.clear();
		this.newestTs = Number.NEGATIVE_INFINITY;
	}
	ensure(name, kind) {
		const existing = this.series.get(name);
		if (existing !== void 0) return existing;
		const created = {
			name,
			kind,
			ts: [],
			values: []
		};
		this.series.set(name, created);
		return created;
	}
	/** Whether a sample for `name` passes the decimation gate. */
	accept(name, ts) {
		const rate = this.options.sampleRateHz;
		if (rate <= 0) return true;
		const previous = this.lastAccepted.get(name);
		if (previous === void 0) return true;
		return ts - previous >= 1e3 / rate;
	}
	/** Enforce both limits, oldest first. */
	trim(series) {
		const newest = this.newestTs;
		const cutoff = Number.isFinite(newest) ? newest - this.options.retentionMs : Number.NEGATIVE_INFINITY;
		let drop = 0;
		while (drop < series.ts.length && (series.ts[drop] ?? Number.POSITIVE_INFINITY) < cutoff) drop += 1;
		const sizeOverflow = series.ts.length - drop - this.options.maxPointsPerSeries;
		if (sizeOverflow > 0) drop += sizeOverflow;
		if (drop <= 0) return;
		series.ts.splice(0, drop);
		series.values.splice(0, drop);
	}
};
const DEFAULT_LOG_OPTIONS = { maxLines: 5e3 };
/**
* Fixed-capacity log ring.
*
* `seq` keeps increasing after the ring wraps, and `totalIngested` never
* decreases: those two counters are what let the view prove "no line was
* dropped" (spec A16) instead of merely hoping so — the received count is
* independent of what the ring retains.
*/
var LogStore = class {
	lines = [];
	nextSeq = 1;
	total = 0;
	options;
	constructor(options = {}) {
		this.options = {
			...DEFAULT_LOG_OPTIONS,
			...options
		};
	}
	configure(options) {
		this.options = {
			...this.options,
			...options
		};
		this.enforceCapacity();
	}
	getOptions() {
		return { ...this.options };
	}
	/** Total lines ever accepted (survives trimming; the completeness counter). */
	get totalIngested() {
		return this.total;
	}
	/** Sequence number the next accepted line will receive. */
	get nextSequence() {
		return this.nextSeq;
	}
	/** Currently retained lines, oldest first. */
	entries() {
		return this.lines;
	}
	push(record) {
		const full = {
			...record,
			seq: this.nextSeq
		};
		this.nextSeq += 1;
		this.total += 1;
		this.lines.push(full);
		this.enforceCapacity();
		return full;
	}
	/** Drop retained lines but keep the counters (so completeness stays provable). */
	clear() {
		this.lines = [];
	}
	/** Reset counters as well — a fresh session, not a cleared view. */
	reset() {
		this.lines = [];
		this.nextSeq = 1;
		this.total = 0;
	}
	/** Serialize for export, oldest first. */
	toText(formatTimestamp) {
		return this.lines.map((line) => `${formatTimestamp(line.ts)} [${line.level.toUpperCase()}] ${line.text}`).join("\n");
	}
	enforceCapacity() {
		const overflow = this.lines.length - this.options.maxLines;
		if (overflow > 0) this.lines.splice(0, overflow);
	}
};
// src/core/tcp-link.ts
/**
* Reconnecting TCP byte-stream link.
*
* One instance per stream (log channel, variable channel). The two links never
* share a socket, a buffer or a timer — that separation is what keeps a burst
* on the variable channel from delaying log lines (spec D20/A16).
*
* Backpressure policy is per-instance because the two streams want opposite
* answers: the log link must never drop bytes, while the variable link may
* discard stale frames when a consumer falls behind.
*/
var TcpLink = class extends EventEmitter {
	socket;
	status = { kind: "idle" };
	/** Bytes received but not yet consumed by a `data` listener. */
	buffered = [];
	bufferedBytes = 0;
	retryTimer;
	attempt = 0;
	disposed = false;
	paused = false;
	options;
	constructor(options) {
		super();
		this.options = {
			overflowPolicy: "pause",
			maxBufferedBytes: 8388608,
			reconnect: true,
			initialDelayMs: 500,
			maxDelayMs: 1e4,
			backoffFactor: 1.8,
			connectTimeoutMs: 5e3,
			...options
		};
	}
	getStatus() {
		return this.status;
	}
	/** Bytes currently held awaiting delivery (diagnostics + A16 evidence). */
	get bufferedLength() {
		return this.bufferedBytes;
	}
	/** Open the socket (idempotent while connected/connecting). */
	connect() {
		if (this.disposed) return;
		if (this.socket !== void 0) return;
		this.clearRetry();
		this.setStatus({ kind: "connecting" });
		this.openSocket();
	}
	/** Close permanently: no reconnect, no further events. */
	dispose() {
		this.disposed = true;
		this.clearRetry();
		const socket = this.socket;
		this.socket = void 0;
		if (socket !== void 0) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.setStatus({
			kind: "closed",
			reason: "disposed"
		});
	}
	/** Close the current socket but allow an explicit `connect()` later. */
	close(reason = "closed by caller") {
		this.clearRetry();
		const socket = this.socket;
		this.socket = void 0;
		if (socket !== void 0) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.setStatus({
			kind: "closed",
			reason
		});
	}
	openSocket() {
		const socket = connect({
			host: this.options.host,
			port: this.options.port
		});
		this.socket = socket;
		socket.setNoDelay(true);
		const timeout = setTimeout(() => {
			if (this.socket === socket && this.status.kind !== "open") socket.destroy(/* @__PURE__ */ new Error(`connect timeout after ${this.options.connectTimeoutMs} ms`));
		}, this.options.connectTimeoutMs);
		socket.on("connect", () => {
			clearTimeout(timeout);
			this.attempt = 0;
			this.setStatus({ kind: "open" });
			this.paused = false;
			socket.resume();
		});
		socket.on("data", (chunk) => {
			this.accept(chunk);
		});
		socket.on("error", (error) => {
			clearTimeout(timeout);
			this.emit("error", error);
		});
		socket.on("close", () => {
			clearTimeout(timeout);
			if (this.socket !== socket) return;
			this.socket = void 0;
			this.scheduleRetry();
		});
	}
	/** Buffer an incoming chunk and deliver what the consumer can take. */
	accept(chunk) {
		if (chunk.length === 0) return;
		this.buffered.push(chunk);
		this.bufferedBytes += chunk.length;
		if (this.bufferedBytes > this.options.maxBufferedBytes) {
			if (this.options.overflowPolicy === "drop-oldest") this.dropOldest();
			else this.pauseSocket();
		}
		this.drain();
	}
	/** Discard the oldest buffered bytes until under the ceiling. */
	dropOldest() {
		let excess = this.bufferedBytes - this.options.maxBufferedBytes;
		while (excess > 0 && this.buffered.length > 0) {
			const head = this.buffered[0];
			if (head.length <= excess) {
				this.buffered.shift();
				this.bufferedBytes -= head.length;
				excess -= head.length;
			} else {
				this.buffered[0] = head.subarray(excess);
				this.bufferedBytes -= excess;
				excess = 0;
			}
		}
	}
	pauseSocket() {
		if (this.paused) return;
		this.paused = true;
		this.socket?.pause();
	}
	/** Hand buffered bytes to listeners, honouring a listener that pauses us. */
	drain() {
		while (this.buffered.length > 0) {
			const hadListener = this.listenerCount("data") > 0;
			const chunk = this.buffered[0];
			this.emit("data", chunk);
			if (!hadListener) return;
			if (this.paused) return;
			this.buffered.shift();
			this.bufferedBytes -= chunk.length;
		}
		if (this.bufferedBytes === 0 && this.paused) {
			this.paused = false;
			this.socket?.resume();
		}
		if (this.bufferedBytes < this.options.maxBufferedBytes / 2 && this.paused) {
			this.paused = false;
			this.socket?.resume();
		}
	}
	/** Ask the link to stop delivering until `resume()` (consumer backpressure). */
	pause() {
		this.paused = true;
	}
	resume() {
		this.paused = false;
		this.drain();
		this.socket?.resume();
	}
	scheduleRetry() {
		if (this.disposed) {
			this.setStatus({
				kind: "closed",
				reason: "disposed"
			});
			return;
		}
		if (!this.options.reconnect) {
			this.setStatus({
				kind: "closed",
				reason: "connection closed"
			});
			return;
		}
		this.attempt += 1;
		const raw = this.options.initialDelayMs * Math.pow(this.options.backoffFactor, this.attempt - 1);
		const delayMs = Math.min(Math.round(raw), this.options.maxDelayMs);
		this.setStatus({
			kind: "reconnecting",
			attempt: this.attempt,
			delayMs
		});
		this.retryTimer = setTimeout(() => {
			this.retryTimer = void 0;
			if (this.disposed || this.socket !== void 0) return;
			this.setStatus({ kind: "connecting" });
			this.openSocket();
		}, delayMs);
	}
	clearRetry() {
		if (this.retryTimer !== void 0) {
			clearTimeout(this.retryTimer);
			this.retryTimer = void 0;
		}
	}
	setStatus(status) {
		this.status = status;
		this.emit("status", status);
	}
};
/**
* Probe a TCP endpoint once.
* @returns true when the port accepted a connection.
*/
function probeTcp(host, port, timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = connect({
			host,
			port
		});
		let settled = false;
		const done = (ok) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs);
		socket.on("connect", () => done(true));
		socket.on("timeout", () => done(false));
		socket.on("error", () => done(false));
	});
}
// src/openocd/manager.ts
/**
* OpenOCD process lifecycle.
*
* Owns the one process all three data sources depend on: it spawns OpenOCD
* (unless one is already listening), configures the two RTT servers plus the
* TCL port, waits for readiness, and restarts on an unexpected exit.
*
* Two decisions worth stating:
*
*   - **Attach before spawn.** Starting a second OpenOCD against the same
*     debug probe fails in confusing ways (the adapter is already claimed).
*     Probing the ports first turns "already running" from an error into the
*     normal case.
*   - **argv, never a shell.** The config path and executable come from user
*     configuration, so they are passed as an argument vector. A shell would
*     turn a path containing a space or a quote into a command-injection
*     surface (spec §7).
*/
/** Cap on retained OpenOCD output, so a chatty process cannot grow memory. */
const LOG_TAIL_LINES$1 = 200;
var OpenOcdManager = class extends EventEmitter {
	child;
	status = { kind: "idle" };
	tail = [];
	disposed = false;
	stopping = false;
	/** Workspace root that relative config paths resolve against. */
	workspaceRoot;
	constructor(workspaceRoot) {
		super();
		this.workspaceRoot = workspaceRoot;
	}
	/** Keep the workspace root current (it changes when the session does). */
	setWorkspaceRoot(root) {
		this.workspaceRoot = root;
	}
	getStatus() {
		return this.status;
	}
	/** Recent OpenOCD output, oldest first — shown when startup fails. */
	getLogTail() {
		return [...this.tail];
	}
	get pid() {
		return this.child?.pid;
	}
	/**
	* Resolve a configured config path to an absolute one.
	*
	* A relative path is deliberately resolved against the workspace root rather
	* than the process CWD, so the same profile works regardless of where the
	* host process was launched.
	*/
	resolveConfigPath(configPath) {
		const trimmed = configPath.trim();
		if (trimmed === "") return "";
		return isAbsolute(trimmed) ? trimmed : resolve(this.workspaceRoot, trimmed);
	}
	/**
	* Bring the toolchain up: attach to an existing OpenOCD, or spawn one.
	*
	* @returns the status reached; `error` carries the reason plus OpenOCD's own
	*   output, because "OpenOCD failed" alone is never actionable.
	*/
	async start(profile) {
		this.disposed = false;
		this.stopping = false;
		const logPort = profile.log.binding.port;
		profile.variables.binding.port;
		this.setStatus({ kind: "probing" });
		const logOpen = profile.log.binding.enabled ? await probeTcp("127.0.0.1", logPort, 400) : false;
		const tclOpen = await probeTcp("127.0.0.1", profile.openocd.tclPort, 400);
		if (logOpen || tclOpen) {
			const status = {
				kind: "attached",
				detail: logOpen ? `attached to an existing RTT server on port ${logPort}` : `attached to an existing OpenOCD on TCL port ${profile.openocd.tclPort}`
			};
			this.setStatus(status);
			return status;
		}
		if (profile.openocd.mode === "attach") {
			const status = {
				kind: "error",
				message: `no OpenOCD is listening (checked port ${logPort} and TCL ${profile.openocd.tclPort}) and the profile is set to attach-only`
			};
			this.setStatus(status);
			return status;
		}
		const configPath = this.resolveConfigPath(profile.openocd.configPath);
		if (configPath === "") {
			const status = {
				kind: "error",
				message: "no OpenOCD config file configured — set one for this device profile"
			};
			this.setStatus(status);
			return status;
		}
		try {
			await access(configPath);
		} catch {
			const status = {
				kind: "error",
				message: `OpenOCD config file not found: ${configPath}`
			};
			this.setStatus(status);
			return status;
		}
		const args = this.buildArgs(profile, configPath);
		this.setStatus({ kind: "starting" });
		let child;
		try {
			child = spawn(profile.openocd.executable, args, { windowsHide: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = {
				kind: "error",
				message: `failed to launch "${profile.openocd.executable}": ${message}`
			};
			this.setStatus(status);
			return status;
		}
		this.child = child;
		this.tail.length = 0;
		const capture = (chunk) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				const trimmed = line.trimEnd();
				if (trimmed === "") continue;
				this.tail.push(trimmed);
				if (this.tail.length > LOG_TAIL_LINES$1) this.tail.shift();
				this.emit("output", trimmed);
			}
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.on("error", (error) => {
			this.setStatus({
				kind: "error",
				message: error.message,
				logTail: this.tail.join("\n")
			});
		});
		child.on("exit", (code, signal) => {
			this.child = void 0;
			if (this.disposed || this.stopping) {
				this.setStatus({ kind: "idle" });
				return;
			}
			const reason = `OpenOCD exited (${signal !== null ? `signal ${signal}` : `code ${String(code)}`})`;
			this.setStatus({
				kind: "error",
				message: reason,
				logTail: this.tail.join("\n")
			});
		});
		if (!await this.waitForPorts(profile, profile.openocd.startupTimeoutMs)) {
			const status = {
				kind: "error",
				message: `OpenOCD did not open its RTT ports within ${profile.openocd.startupTimeoutMs} ms`,
				logTail: this.tail.join("\n")
			};
			this.setStatus(status);
			return status;
		}
		const status = {
			kind: "running",
			pid: child.pid,
			attached: false
		};
		this.setStatus(status);
		return status;
	}
	/** Stop a spawned process. An attached external OpenOCD is left alone. */
	async stop() {
		this.stopping = true;
		const child = this.child;
		this.child = void 0;
		if (child === void 0) {
			this.setStatus({ kind: "idle" });
			return;
		}
		await new Promise((resolve) => {
			const done = () => resolve();
			child.once("exit", done);
			try {
				child.kill();
			} catch {
				done();
			}
			setTimeout(done, 3e3).unref?.();
		});
		this.setStatus({ kind: "idle" });
	}
	/** Permanently release: stop the process and refuse further restarts. */
	async dispose() {
		this.disposed = true;
		await this.stop();
	}
	/**
	* Build the OpenOCD argument vector.
	*
	* The RTT setup and each enabled server are passed as `-c` commands so a
	* user's config file only has to describe the probe and target — the
	* plugin owns the RTT side, which is what makes the same config file usable
	* from a plain terminal session too.
	*/
	buildArgs(profile, configPath) {
		const args = ["-f", configPath];
		const { openocd, rtt } = profile;
		if (openocd.adapterSpeedKhz > 0) args.push("-c", `adapter speed ${openocd.adapterSpeedKhz}`);
		for (const extra of openocd.extraCommands) {
			const trimmed = extra.trim();
			if (trimmed !== "") args.push("-c", trimmed);
		}
		args.push("-c", `rtt setup ${hex$1(rtt.address)} ${hex$1(rtt.size)} "${rtt.idString}"`);
		args.push("-c", "rtt start");
		if (profile.log.binding.enabled) args.push("-c", `rtt server start ${profile.log.binding.port} ${profile.log.binding.channel}`);
		if (profile.variables.binding.enabled) args.push("-c", `rtt server start ${profile.variables.binding.port} ${profile.variables.binding.channel}`);
		return args;
	}
	/** Poll until every enabled RTT port accepts a connection. */
	async waitForPorts(profile, timeoutMs) {
		const wanted = [];
		if (profile.log.binding.enabled) wanted.push(profile.log.binding.port);
		if (profile.variables.binding.enabled) wanted.push(profile.variables.binding.port);
		if (wanted.length === 0) return true;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.child === void 0 && this.status.kind !== "starting") return false;
			if ((await Promise.all(wanted.map((port) => probeTcp("127.0.0.1", port, 200)))).every(Boolean)) return true;
			if (this.child === void 0) return false;
			await delay$1(150);
		}
		return false;
	}
	setStatus(status) {
		this.status = status;
		this.emit("status", status);
	}
};
/** `0x`-prefixed lowercase hex, the spelling OpenOCD accepts. */
function hex$1(value) {
	return `0x${(value >>> 0).toString(16)}`;
}
function delay$1(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
// src/jlink/manager.ts
/**
* J-Link process lifecycle (the `driver: 'jlink'` counterpart of the OpenOCD
* manager).
*
* Owns the one SEGGER process the J-Link backend needs:
*
*     JLinkGDBServerCL.exe -device <mcu> -if SWD -speed <khz>
*                          -port <gdb> -RTTTelnetPort <telnet>
*                          [-select usb=<serial>] -nogui -silent
*
* Two deliberate choices, mirroring the OpenOCD manager:
*
*   - **Attach before spawn.** A second J-Link process on the same probe makes
*     the adapter busy in confusing ways, so the ports are probed first and
*     "already running" is the normal case rather than an error.
*   - **argv, never a shell.** Every value comes from user configuration; a
*     shell would turn a device name containing a space into an injection
*     surface (spec §7).
*
* J-Link has no `openocd.cfg` equivalent, so there is nothing to validate on
* disk: the required input is the device name and, when it is not on PATH, the
* executable path.
*/
/** Cap on retained J-Link output, so a chatty process cannot grow memory. */
const LOG_TAIL_LINES = 200;
/**
* Candidate executable names, in the order a bare (PATH-less) config should
* try them. JLinkGDBServerCL is preferred because it is the console build: it
* writes to stdout and needs no window, which is what a spawned child wants.
*/
const DEFAULT_EXECUTABLES = [
	"JLinkGDBServerCL.exe",
	"JLinkGDBServerCL",
	"JLinkGDBServer.exe",
	"JLinkGDBServer"
];
var JLinkManager = class extends EventEmitter {
	child;
	status = { kind: "idle" };
	tail = [];
	disposed = false;
	stopping = false;
	workspaceRoot;
	constructor(workspaceRoot) {
		super();
		this.workspaceRoot = workspaceRoot;
	}
	setWorkspaceRoot(root) {
		this.workspaceRoot = root;
	}
	getStatus() {
		return this.status;
	}
	getLogTail() {
		return [...this.tail];
	}
	get pid() {
		return this.child?.pid;
	}
	/**
	* Resolve the configured executable.
	*
	* A relative path resolves against the workspace root, like OpenOCD's config
	* path, so a profile can ship `tools/JLinkGDBServerCL.exe`. An empty value
	* yields the first {@link DEFAULT_EXECUTABLES} candidate.
	*/
	resolveExecutable(executable) {
		const trimmed = executable.trim();
		if (trimmed === "") return DEFAULT_EXECUTABLES[0];
		return isAbsolute(trimmed) ? trimmed : resolve(this.workspaceRoot, trimmed);
	}
	/**
	* Bring the toolchain up: attach to an existing J-Link, or spawn one.
	*
	* @returns the status reached; `error` carries the reason plus J-Link's own
	*   output, because "J-Link failed" alone is never actionable.
	*/
	async start(profile) {
		this.disposed = false;
		this.stopping = false;
		const { jlink } = profile;
		const gdbPort = jlink.gdbPort;
		const telnetPort = jlink.rttTelnetPort;
		this.setStatus({ kind: "probing" });
		const gdbOpen = await probeTcp("127.0.0.1", gdbPort, 400);
		const telnetOpen = await probeTcp("127.0.0.1", telnetPort, 400);
		if (gdbOpen || telnetOpen) {
			const status = {
				kind: "attached",
				detail: gdbOpen ? `attached to an existing J-Link GDB server on port ${gdbPort}` : `attached to an existing J-Link RTT TELNET channel on port ${telnetPort}`
			};
			this.setStatus(status);
			return status;
		}
		if (!jlink.autoStart) {
			const status = {
				kind: "error",
				message: `no J-Link is listening (checked GDB port ${gdbPort} and RTT TELNET port ${telnetPort}) and the profile is attach-only`
			};
			this.setStatus(status);
			return status;
		}
		if (jlink.device.trim() === "") {
			const status = {
				kind: "error",
				message: "no J-Link target device configured — set one for this device profile"
			};
			this.setStatus(status);
			return status;
		}
		const executable = this.resolveExecutable(jlink.executable);
		const resolved = await this.resolveOnPath(executable);
		if (resolved === void 0) {
			const status = {
				kind: "error",
				message: `J-Link software not found (tried ${jlink.executable.trim() === "" ? DEFAULT_EXECUTABLES.join(", ") : executable}). Set the JLinkGDBServerCL.exe path in Variable Sources, or install the SEGGER J-Link Software Pack.`
			};
			this.setStatus(status);
			return status;
		}
		const args = this.buildArgs(jlink);
		this.setStatus({ kind: "starting" });
		let child;
		try {
			child = spawn(resolved, args, { windowsHide: true });
		} catch (error) {
			const status = {
				kind: "error",
				message: `failed to launch "${resolved}": ${error instanceof Error ? error.message : String(error)}`
			};
			this.setStatus(status);
			return status;
		}
		this.child = child;
		this.tail.length = 0;
		const capture = (chunk) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				const trimmed = line.trimEnd();
				if (trimmed === "") continue;
				this.tail.push(trimmed);
				if (this.tail.length > LOG_TAIL_LINES) this.tail.shift();
				this.emit("output", trimmed);
			}
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.on("error", (error) => {
			this.setStatus({
				kind: "error",
				message: error.message,
				logTail: this.tail.join("\n")
			});
		});
		child.on("exit", (code, signal) => {
			this.child = void 0;
			if (this.disposed || this.stopping) {
				this.setStatus({ kind: "idle" });
				return;
			}
			const reason = `J-Link exited (${signal !== null ? `signal ${signal}` : `code ${String(code)}`})`;
			this.setStatus({
				kind: "error",
				message: reason,
				logTail: this.tail.join("\n")
			});
		});
		if (!await this.waitForPorts(jlink, jlink.startupTimeoutMs)) {
			const status = {
				kind: "error",
				message: `J-Link did not open its GDB and RTT ports within ${jlink.startupTimeoutMs} ms`,
				logTail: this.tail.join("\n")
			};
			this.setStatus(status);
			return status;
		}
		const status = {
			kind: "running",
			pid: child.pid,
			attached: false
		};
		this.setStatus(status);
		return status;
	}
	/** Stop a spawned process. An attached external J-Link is left alone. */
	async stop() {
		this.stopping = true;
		const child = this.child;
		this.child = void 0;
		if (child === void 0) {
			this.setStatus({ kind: "idle" });
			return;
		}
		await new Promise((resolvePromise) => {
			const done = () => resolvePromise();
			child.once("exit", done);
			try {
				child.kill();
			} catch {
				done();
			}
			setTimeout(done, 3e3).unref?.();
		});
		this.setStatus({ kind: "idle" });
	}
	/** Permanently release: stop the process and refuse further restarts. */
	async dispose() {
		this.disposed = true;
		await this.stop();
	}
	/**
	* Build the J-Link argument vector.
	*
	* Option spellings are the documented ones, which are easy to get wrong:
	*
	*   - `-USB <serial>` selects a probe. `-select usb=<serial>` — the spelling
	*     the older OpenOCD-wrapper habit suggests — is NOT a GDB Server option;
	*     `-SelectEmuBySN` is explicitly rejected by it.
	*   - `-RTTTelnetPort <port>` both starts the TELNET server and pins its port.
	*   - `-nohalt`/`-noir` keep the target executing. Without them the debugger's
	*     connect sequence halts the core, which stops the firmware from producing
	*     the very RTT data this panel exists to show.
	*
	* The RTT control-block address is NOT passed here: JLinkGDBServer has no
	* `-RTTSearchRanges` option (that belongs to JLinkRTTLogger and J-Scope), so
	* the range rides the per-connection TELNET config string instead.
	*/
	buildArgs(jlink) {
		const args = [];
		args.push("-device", jlink.device.trim());
		args.push("-if", jlink.targetInterface);
		if (jlink.speedKhz > 0) args.push("-speed", String(jlink.speedKhz));
		args.push("-port", String(jlink.gdbPort));
		args.push("-RTTTelnetPort", String(jlink.rttTelnetPort));
		if (jlink.serial.trim() !== "") args.push("-USB", jlink.serial.trim());
		if (jlink.keepTargetRunning !== false) {
			args.push("-nohalt");
			args.push("-noir");
		}
		args.push("-nogui");
		args.push("-silent");
		args.push("-nologtofile");
		for (const extra of jlink.extraArgs) {
			const trimmed = extra.trim();
			if (trimmed !== "") args.push(trimmed);
		}
		return args;
	}
	/**
	* Find a runnable launcher.
	*
	* An explicit path must exist. A bare name (the default when nothing is
	* configured) is tried against `PATH` plus the documented executable names,
	* because a user who installed the SEGGER pack should not have to type the
	* full path — but a user who has NOT installed it deserves a message naming
	* the choice instead of an opaque `spawn EPERM`.
	*
	* @returns the absolute path to run, or undefined when nothing was found.
	*/
	async resolveOnPath(executable) {
		const candidates = executable.trim() === "" ? DEFAULT_EXECUTABLES : [executable];
		const pathDirs = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
		for (const candidate of candidates) {
			if (isAbsolute(candidate)) try {
				await access(candidate);
				return candidate;
			} catch {
				continue;
			}
			for (const dir of pathDirs) {
				const full = resolve(dir, candidate);
				try {
					await access(full);
					return full;
				} catch {}
			}
			if (!/\.[A-Za-z0-9]+$/.test(candidate)) for (const ext of [
				".exe",
				".cmd",
				".bat"
			]) for (const dir of pathDirs) {
				const full = resolve(dir, candidate + ext);
				try {
					await access(full);
					return full;
				} catch {}
			}
		}
	}
	/** Poll until both the GDB and the RTT TELNET ports accept a connection. */
	async waitForPorts(jlink, timeoutMs) {
		const wanted = [jlink.gdbPort, jlink.rttTelnetPort];
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.child === void 0 && this.status.kind !== "starting") return false;
			if ((await Promise.all(wanted.map((port) => probeTcp("127.0.0.1", port, 200)))).every(Boolean)) return true;
			if (this.child === void 0) return false;
			await delay(150);
		}
		return false;
	}
	setStatus(status) {
		this.status = status;
		this.emit("status", status);
	}
};
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
// src/jlink/telnet.ts
/**
* SEGGER J-Link TELNET channel client.
*
* J-Link exposes RTT through a "TELNET-like" port (19021 by default). One
* connection carries ONE RTT up-channel, chosen by a config string the client
* must send within the first 100 ms of the connection — after that window the
* same bytes are forwarded to the target as plain RTT input, so a late selector
* silently becomes data. That deadline is why {@link JLinkTelnet.connect}
* writes the selector immediately on `connect`, before wiring up buffering.
*
* The selector syntax (SEGGER knowledge base, "J-Link RTT TELNET Channel"):
*
*     $$SEGGER_TELNET_ConfigStr=RTTCh;1;SetRTTAddr;0x20000000;$$
*
* Commands are `;`-separated and the whole string is `$$`-delimited. Sending it
* is optional — without one the connection defaults to channel 0 — which is why
* a channel-0 link works even when the selector is rejected.
*
* Unlike OpenOCD's `rtt server start <port> <channel>`, J-Link gives one port
* for every channel, so the two data sources are two connections to the same
* port rather than two ports.
*/
/**
* Build the SEGGER TELNET config string for one channel.
*
* Exported because the exact framing is the whole contract with J-Link and a
* test pins it: `$$` delimiters, `;`-separated `Name;Value` pairs, a trailing
* `;` before the closing `$$`.
*
* @param channel - RTT up-channel index.
* @param options - optional control-block address / search range.
*/
function buildConfigString(channel, options = {}) {
	const parts = [`RTTCh;${channel}`];
	if (options.rttAddress !== void 0) parts.push(`SetRTTAddr;0x${(options.rttAddress >>> 0).toString(16)}`);
	else if (options.rttSearchRange !== void 0 && options.rttSearchRange.trim() !== "") parts.push(`SetRTTSearchRanges;${options.rttSearchRange.trim()}`);
	return `$$SEGGER_TELNET_ConfigStr=${parts.join(";")};$$`;
}
var JLinkTelnet = class extends EventEmitter {
	socket;
	status = { kind: "idle" };
	retryTimer;
	attempt = 0;
	disposed = false;
	options;
	/** Whether any RTT byte has arrived since the connection opened. */
	sawData = false;
	constructor(options) {
		super();
		this.options = {
			connectTimeoutMs: 5e3,
			reconnect: true,
			initialDelayMs: 500,
			maxDelayMs: 1e4,
			...options
		};
	}
	getStatus() {
		return this.status;
	}
	/** Open the connection (idempotent while connected/connecting). */
	connect() {
		if (this.disposed) return;
		if (this.socket !== void 0) return;
		this.clearRetry();
		this.setStatus({ kind: "connecting" });
		this.openSocket();
	}
	/** Close permanently: no reconnect, no further events. */
	dispose() {
		this.disposed = true;
		this.clearRetry();
		const socket = this.socket;
		this.socket = void 0;
		if (socket !== void 0) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.setStatus({
			kind: "closed",
			reason: "disposed"
		});
	}
	close(reason = "closed by caller") {
		this.clearRetry();
		const socket = this.socket;
		this.socket = void 0;
		if (socket !== void 0) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.setStatus({
			kind: "closed",
			reason
		});
	}
	openSocket() {
		const socket = connect({
			host: this.options.host,
			port: this.options.port
		});
		this.socket = socket;
		socket.setNoDelay(true);
		const timeout = setTimeout(() => {
			if (this.socket === socket && this.status.kind !== "open") socket.destroy(/* @__PURE__ */ new Error(`connect timeout after ${this.options.connectTimeoutMs ?? 5e3} ms`));
		}, this.options.connectTimeoutMs ?? 5e3);
		socket.on("connect", () => {
			clearTimeout(timeout);
			this.attempt = 0;
			const selector = buildConfigString(this.options.channel, {
				...this.options.rttAddress === void 0 ? {} : { rttAddress: this.options.rttAddress },
				...this.options.rttSearchRange === void 0 ? {} : { rttSearchRange: this.options.rttSearchRange }
			});
			this.emit("dropped", {
				channel: this.options.channel,
				hadData: this.sawData
			});
			socket.write(selector);
			this.setStatus({
				kind: "open",
				channel: this.options.channel,
				ack: "sent"
			});
		});
		this.sawData = false;
		socket.on("data", (chunk) => {
			if (chunk.length > 0) this.sawData = true;
			this.emit("data", chunk);
		});
		socket.on("error", (error) => {
			clearTimeout(timeout);
			this.emit("error", error);
		});
		socket.on("close", () => {
			clearTimeout(timeout);
			if (this.socket !== socket) return;
			this.socket = void 0;
			this.scheduleRetry();
		});
	}
	scheduleRetry() {
		if (this.disposed) {
			this.setStatus({
				kind: "closed",
				reason: "disposed"
			});
			return;
		}
		if (this.options.reconnect === false) {
			this.setStatus({
				kind: "closed",
				reason: "connection closed"
			});
			return;
		}
		this.attempt += 1;
		const raw = (this.options.initialDelayMs ?? 500) * Math.pow(1.8, this.attempt - 1);
		const delayMs = Math.min(Math.round(raw), this.options.maxDelayMs ?? 1e4);
		this.setStatus({
			kind: "reconnecting",
			attempt: this.attempt,
			delayMs
		});
		this.retryTimer = setTimeout(() => {
			this.retryTimer = void 0;
			if (this.disposed || this.socket !== void 0) return;
			this.setStatus({ kind: "connecting" });
			this.openSocket();
		}, delayMs);
	}
	clearRetry() {
		if (this.retryTimer !== void 0) {
			clearTimeout(this.retryTimer);
			this.retryTimer = void 0;
		}
	}
	setStatus(status) {
		this.status = status;
		this.emit("status", status);
	}
};
// src/core/types.ts
/** Byte width of a scalar type. */
const SCALAR_BYTES = {
	i8: 1,
	u8: 1,
	i16: 2,
	u16: 2,
	i32: 4,
	u32: 4,
	f32: 4,
	f64: 8,
	bool: 1
};
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
* Parse one manual binding: `name@address:type`, `address:type:name`, or
* `0x20000000:u16:VoltMv`.
*
* Both orders are accepted because both read naturally, and requiring one would
* mean users hit a parse error for writing the other.
*
* The two-part shorthand `0x20000000:VoltMv` deliberately defaults to `u32`: the
* type is simply absent there, which is a documented convenience, and it is
* pinned by `test/ocd.test.ts`. That is different from an UNRECOGNISED type,
* which is refused (`unknown-type`) rather than defaulted.
*
* @param text - the raw field contents.
* @returns the binding, or undefined when the spelling cannot be parsed.
*/
function parseManualBinding(text) {
	const result = parseManualBindingDetailed(text);
	return result.ok ? result.binding : void 0;
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
/**
* Turn a symbol's byte width into a concrete scalar type (WIDTH-ONLY).
*
* Kept for compatibility: it is what `test/ocd.test.ts` pins and what the
* `/symbols` listing used before this task. It maps a size to its natural width
* and preserves the fallback when it is a valid width or the size is unknown. New
* call sites that need to reconcile a NAME inference should prefer
* `resolveSymbolType`.
*
* @param size - symbol size in bytes as `nm` reported it (0 when unknown).
* @param fallback - the type to keep when the size gives no guidance.
if (size === 2) return nameType === 'u16' || nameType === 'i16' ? nameType : 'u16'
if (size === 4) return nameType === 'i32' || nameType === 'f32' ? nameType : 'u32'
if (size === 8) return nameType === 'f64' ? nameType : 'f64'
return nameType
}

/**
* Turn a symbol's byte width into a concrete scalar type (WIDTH-ONLY).
*
* Kept for compatibility: it is what `test/ocd.test.ts` pins and what the
* `/symbols` listing used before this task. It maps a size to its natural width
* and preserves the fallback when it is a valid width or the size is unknown. New
* call sites that need to reconcile a NAME inference should prefer
* `resolveSymbolType`.
*
* @param size - symbol size in bytes as `nm` reported it (0 when unknown).
* @param fallback - the type to keep when the size gives no guidance.
*/
function typeForSize(size, fallback) {
	if (size === 1) return "u8";
	if (size === 2) return "u16";
	if (size === 4) return fallback === "f32" || fallback === "i32" ? fallback : "u32";
	if (size === 8) return "f64";
	return fallback;
}
// src/ocd/symbols.ts
/**
* ELF symbol resolution for the OCD memory reader.
*
* The reader needs `name → address + size + signedness`. Two ways in:
*
*   1. An ELF file, read through `arm-none-eabi-nm` (or any `nm` compatible with
*      the target's object format). Portable across toolchains, and it is the
*      symbol table the linker actually produced.
*   2. Manual bindings (`0x20000005f0:u16:VoltMv`), for when no ELF is at hand.
*
* Nothing here hardcodes a toolchain path or a symbol name: both arrive from
* configuration, which is what keeps the plugin generic (spec G1).
*/
const execFileAsync = promisify(execFile);
/**
* `nm -S` emits: `<address> <size> <type> <name>`.
*
* Older/limited `nm` builds omit the size column, so both shapes are accepted —
* a missing size is not fatal, the caller supplies a width instead.
*/
const NM_WITH_SIZE = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/;
const NM_WITHOUT_SIZE = /^([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/;
/**
* Map an `nm` type letter to a scalar type.
*
* The letter states the symbol's SECTION, not its C type, so this can only ever
* be a guess — it decides a default width, and the user overrides it when the
* real type differs. (Global vs file-local is a separate question, answered by
* {@link isGlobalDataSymbol}.)
*/
function inferFromNmType(nmType) {
	switch (nmType.toUpperCase()) {
		case "B":
		case "D":
		case "C":
		case "G":
		case "S": return "u32";
		case "R":
		case "T":
		case "W":
		case "V": return "u32";
		default: return "u32";
	}
}
/**
* Refine a guess using the symbol's name.
*
* C type information is gone by link time, but names are conventionally typed
* (`_u8`, `IsReady`, `voltageMv`). Only unambiguous suffixes are honoured;
* an unrecognised name keeps the width guess.
*
* The signedness prefix accepts every spelling seen in practice — `u16`,
* `i16`, `s16`, `int16`, `uint16` — because omitting `i` would silently
* widen a signed field to unsigned and flip every negative reading.
*/
function refineTypeFromName(name, fallback) {
	const m = /_(u?int|[uis])?(8|16|32|64|f32|f64)$/i.exec(name);
	if (m !== null) {
		const kind = (m[1] ?? "").toLowerCase();
		const width = m[2]?.toLowerCase();
		if (width === "f32") return "f32";
		if (width === "f64") return "f64";
		const signed = kind === "s" || kind === "i" || kind === "int";
		if (width === "8") return signed ? "i8" : "u8";
		if (width === "16") return signed ? "i16" : "u16";
		if (width === "32") return signed ? "i32" : "u32";
	}
	if (/^(is|has|was|should)[A-Z_]/.test(name) || /Flag$/i.test(name)) return "bool";
	if (/^(f|d)[A-Z]/.test(name)) return "f32";
	return fallback;
}
/**
* Whether an `nm` type letter denotes a GLOBAL (externally visible) data symbol.
*
* Uppercase = global, lowercase = file-local (`static`). Non-data letters
* (`T`/`t` text, `U` undefined) are rejected here too, so the caller gets "is
* this samplable global data" in one question rather than two.
*
* @param nmType - the single type letter `nm` printed.
*/
function isGlobalDataSymbol(nmType) {
	return /[BDGSR]/.test(nmType);
}
/**
* Parse `nm` output into symbols.
*
* Split out from {@link listElfSymbols} so the filtering rules — which are the
* part with real consequences — can be tested without a toolchain on the box,
* and so a future `nm` variant only needs a new parser rather than a second
* spawn path.
*
* @param stdout - raw `nm -S --defined-only` output.
* @param options - filter / limit / globals-only rules.
*/
function parseNmOutput(stdout, options = {}) {
	const out = [];
	const limit = options.limit ?? 5e3;
	const filter = options.filter?.toLowerCase();
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const withSize = NM_WITH_SIZE.exec(trimmed);
		const withoutSize = withSize === null ? NM_WITHOUT_SIZE.exec(trimmed) : null;
		if (withSize === null && withoutSize === null) continue;
		const address = Number.parseInt((withSize ?? withoutSize)?.[1] ?? "", 16);
		if (Number.isNaN(address)) continue;
		const size = withSize !== null ? Number.parseInt(withSize[2] ?? "0", 16) : 0;
		const nmType = withSize !== null ? withSize[3] ?? "?" : withoutSize?.[2] ?? "?";
		const name = withSize !== null ? withSize[4] ?? "" : withoutSize?.[3] ?? "";
		if (name === "") continue;
		if (!/[bBdDgGsSrR]/.test(nmType)) continue;
		if ((options.globalsOnly ?? true) && !isGlobalDataSymbol(nmType)) continue;
		if (filter !== void 0 && !name.toLowerCase().includes(filter)) continue;
		const inferred = refineTypeFromName(name, inferFromNmType(nmType));
		out.push({
			name,
			address,
			size,
			nmType,
			inferredType: inferred
		});
		if (out.length >= limit) break;
	}
	return out;
}
/**
* List the data symbols of an ELF using `nm`.
*
* @param elfPath - path to the ELF file (user-supplied; never hardcoded).
* @param nmPath - `nm` executable to run; defaults to `arm-none-eabi-nm`.
* @throws when `nm` is missing or the ELF cannot be read, so a bad path is
*   reported instead of silently producing an empty symbol list.
*/
async function listElfSymbols(elfPath, nmPath = "arm-none-eabi-nm", options = {}) {
	let stdout;
	try {
		stdout = (await execFileAsync(nmPath, [
			"-S",
			"--defined-only",
			elfPath
		], {
			maxBuffer: 67108864,
			windowsHide: true
		})).stdout;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to read symbols from "${elfPath}" via "${nmPath}": ${message}`);
	}
	return parseNmOutput(stdout, options);
}
/** Byte width for a binding (used for batching neighbouring reads). */
function bindingWidth(binding) {
	return SCALAR_BYTES[binding.type];
}
// src/jlink/rsp.ts
/**
* GDB Remote Serial Protocol client — the memory-read transport for the
* J-Link backend.
*
* Why this and not the J-Link SDK: the free J-Link software already speaks RSP
* on its GDB port, and `m<addr>,<len>` is the one packet this reader needs.
* That keeps the plugin free of a native DLL binding (no `koffi`, no ABI
* guessing, no second copy of the harness runtime) while still going straight
* to SEGGER's own driver instead of through OpenOCD.
*
* Two protocol details drive the implementation:
*
*   - **Acknowledgements.** Classic RSP ack/Nak's every packet. We start in ack
*     mode for compatibility, then ask for `QStartNoAckMode`: one round trip
*     less per sample, and the host stops waiting on us. A server that refuses
*     the request keeps working in ack mode — the client tracks which mode is
*     live rather than assuming.
*   - **Asynchronous output.** The stub may interleave `O<text>` console
*     packets with a reply. They are consumed and ignored; treating one as the
*     answer would corrupt a read.
*
* The client is READ-ONLY by construction: it exposes `readMemory` and the two
* link-management packets, and refuses to send anything else (spec §3.8.5).
*/
/** RSP control bytes. */
const PACKET_START = 36;
const PACKET_END = 35;
const ACK = 43;
const NAK = 45;
/**
* Compute an RSP packet checksum: the low byte of the byte sum.
* @param body - packet payload, without `$` and `#xx`.
*/
function rspChecksum(body) {
	let sum = 0;
	for (let i = 0; i < body.length; i += 1) sum = sum + body.charCodeAt(i) & 255;
	return sum.toString(16).padStart(2, "0");
}
/** Frame a payload into a complete wire packet. */
function framePacket(body) {
	return `$${body}#${rspChecksum(body)}`;
}
/**
* Whether a reply payload is an asynchronous console-output packet.
*
* `O` followed by hex-encoded text is the RSP console-output form. The check has
* to look at the PAYLOAD, not just the first character, because `OK` — the reply
* to link-management requests such as `QStartNoAckMode` — shares that letter:
*
*   - `O` alone                    → an empty console line (still a console packet)
*   - `O` + even-length hex        → console text, skip it
*   - `OK` / `O<anything else>`    → a normal reply, must NOT be skipped
*
* Getting this wrong is not cosmetic: swallowing `OK` leaves the client waiting
* for a reply that already arrived, so the request times out and the whole
* connection degrades to ack mode.
*/
function isConsoleOutput(payload) {
	if (!payload.startsWith("O")) return false;
	const rest = payload.slice(1);
	if (rest.length === 0) return true;
	return rest.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(rest);
}
/**
* Undo RSP binary escaping (`}` followed by the byte XOR 0x20).
*
* Replies to `m` are plain hex text, but console-output packets can carry
* escaped bytes, so the parser unescapes uniformly instead of relying on the
* reply kind.
*/
function unescapeRsp(payload) {
	if (!payload.includes("}")) return payload;
	const out = [];
	for (let i = 0; i < payload.length; i += 1) {
		const ch = payload[i];
		if (ch === "}" && i + 1 < payload.length) {
			out.push(String.fromCharCode(payload.charCodeAt(i + 1) & 255 ^ 32));
			i += 1;
			continue;
		}
		out.push(ch);
	}
	return out.join("");
}
/**
* Encode a memory read as an `m` packet body.
*
* Addresses are sent as unsigned hex: a negative JS number would otherwise
* serialize as `-1`, which no stub accepts.
*/
function memoryReadBody(address, length) {
	return `m${(address >>> 0).toString(16)},${Math.max(0, Math.trunc(length)).toString(16)}`;
}
/**
* Decode an `m` reply into bytes.
*
* @throws when the stub answered with an error (`E NN`) or with text that is
*   not an even-length hex string — a silent zero-fill would plot a lie.
*/
function decodeMemoryReply(payload) {
	if (payload.startsWith("E") && payload.length <= 4) throw new Error(`target refused the memory read (${payload})`);
	if (payload.length === 0) return /* @__PURE__ */ new Uint8Array(0);
	if (payload.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(payload)) throw new Error(`malformed memory reply: ${JSON.stringify(payload.slice(0, 32))}`);
	const out = new Uint8Array(payload.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(payload.slice(i * 2, i * 2 + 2), 16);
	return out;
}
var RspClient = class extends EventEmitter {
	socket;
	/**
	* Unparsed wire bytes.
	*
	* Typed as `Buffer<ArrayBufferLike>` because `subarray`/`concat` widen the
	* backing store; pinning it to `Buffer<ArrayBuffer>` makes every slice a type
	* error under `@types/node` 24.
	*/
	buffer = Buffer.alloc(0);
	pending;
	options;
	timeoutMs;
	closed = true;
	/** Whether the stub agreed to `QStartNoAckMode`. */
	noAck = false;
	constructor(options) {
		super();
		this.options = options;
		this.timeoutMs = options.timeoutMs ?? 5e3;
	}
	get connected() {
		return this.socket !== void 0 && !this.closed;
	}
	get ackMode() {
		return this.noAck ? "noack" : "ack";
	}
	/** Open the connection and negotiate no-ack mode. */
	async connect() {
		await new Promise((resolve, reject) => {
			const socket = connect({
				host: this.options.host,
				port: this.options.port
			});
			const timer = setTimeout(() => {
				socket.removeAllListeners();
				socket.destroy();
				reject(/* @__PURE__ */ new Error(`GDB connect timeout after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			socket.once("error", (error) => {
				clearTimeout(timer);
				socket.removeAllListeners();
				socket.destroy();
				reject(error);
			});
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.setNoDelay(true);
				this.socket = socket;
				this.closed = false;
				socket.on("data", (chunk) => this.onData(chunk));
				socket.on("error", (error) => this.emit("error", error));
				socket.on("close", () => {
					this.closed = true;
					this.socket = void 0;
					this.failPending(/* @__PURE__ */ new Error("GDB connection closed"));
					this.emit("close");
				});
				resolve();
			});
		});
		if (this.options.noAckMode === false) return;
		try {
			if (await this.cmd("QStartNoAckMode") === "OK") this.noAck = true;
		} catch {
			this.noAck = false;
		}
	}
	close() {
		const socket = this.socket;
		this.socket = void 0;
		this.closed = true;
		if (socket !== void 0) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.failPending(/* @__PURE__ */ new Error("GDB client closed"));
	}
	/** Send one packet and await the reply payload. */
	cmd(body) {
		const socket = this.socket;
		if (socket === void 0) throw new Error("GDB client is not connected");
		if (this.pending !== void 0) throw new Error("GDB client already has a request in flight");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = void 0;
				reject(/* @__PURE__ */ new Error(`GDB request timed out: ${body.slice(0, 32)}`));
			}, this.timeoutMs);
			this.pending = {
				resolve,
				reject,
				timer
			};
			socket.write(framePacket(body));
		});
	}
	/**
	* Read target memory.
	* @returns exactly `length` bytes, or fewer when the stub truncates at the
	*   end of a readable region (the caller decides whether that is a gap).
	*/
	async readMemory(address, length) {
		if (length <= 0) return /* @__PURE__ */ new Uint8Array(0);
		return decodeMemoryReply(await this.cmd(memoryReadBody(address, length)));
	}
	onData(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const start = this.buffer.indexOf(PACKET_START);
			if (start === -1) {
				this.buffer = Buffer.alloc(0);
				return;
			}
			if (start > 0) this.buffer = this.buffer.subarray(start);
			const end = this.buffer.indexOf(PACKET_END);
			if (end === -1) return;
			if (this.buffer.length < end + 3) return;
			const body = this.buffer.subarray(1, end).toString("latin1");
			const checksum = this.buffer.subarray(end + 1, end + 3).toString("latin1").toLowerCase();
			this.buffer = this.buffer.subarray(end + 3);
			const valid = checksum === rspChecksum(body);
			if (!this.noAck) this.socket?.write(Buffer.from([valid ? ACK : NAK]));
			if (!valid) continue;
			if (isConsoleOutput(body)) continue;
			if (body.startsWith("%")) continue;
			const pending = this.pending;
			if (pending === void 0) continue;
			this.pending = void 0;
			clearTimeout(pending.timer);
			pending.resolve(unescapeRsp(body));
		}
	}
	failPending(error) {
		const pending = this.pending;
		if (pending === void 0) return;
		this.pending = void 0;
		clearTimeout(pending.timer);
		pending.reject(error);
	}
};
// src/jlink/reader.ts
/**
* J-Link memory reader — the `driver: 'jlink'` counterpart of `OcdReader`.
*
* Same contract (poll a set of address bindings, verify coherence, batch nearby
* reads), different transport: instead of OpenOCD's TCL `mdw`, this reads
* target memory over the GDB remote serial protocol served by JLinkGDBServer.
*
* Batching is expressed directly in bytes rather than words: RSP's `m` packet
* takes a byte count, so a run of nearby bindings becomes one exact-length read
* instead of a word-rounded one. That is strictly less traffic than the TCL
* path for narrow values.
*
* Coherence keeps the same policy as the OpenOCD reader: `verifyConsistency`
* reads twice and turns a value that moved between the two reads into a gap,
* because a torn sample is worse than a missing one.
*/
/**
* Group bindings into as few memory reads as possible.
*
* Batches are formed over ascending addresses and closed when the gap to the
* next binding exceeds `maxDistance` — merging across a huge gap would read far
* more memory than the variables actually need.
*/
function planReadBatches$1(bindings, maxDistance) {
	if (bindings.length === 0) return [];
	const sorted = [...bindings].sort((a, b) => a.address - b.address);
	const batches = [];
	let current;
	let currentEnd = 0;
	for (const binding of sorted) {
		const width = bindingWidth(binding);
		const start = binding.address;
		const end = start + width;
		const gap = start - currentEnd;
		if (current !== void 0 && maxDistance > 0 && gap <= maxDistance) {
			current.members.push({
				binding,
				offset: start - current.base
			});
			currentEnd = Math.max(currentEnd, end);
			current.length = currentEnd - current.base;
			continue;
		}
		current = {
			base: start,
			length: width,
			members: [{
				binding,
				offset: 0
			}]
		};
		currentEnd = end;
		batches.push(current);
	}
	return batches;
}
/**
* Extract one value from a raw byte window.
*
* Bytes arrive little-endian from the target (Cortex-M native); a binding
* marked `big` reverses them. Takes the value from its own byte offset, so a
* `u8` at an unaligned address decodes correctly.
*/
function decodeBindingBytes(bytes, offsetBytes, binding) {
	const width = bindingWidth(binding);
	if (offsetBytes < 0 || offsetBytes + width > bytes.length) throw new Error(`read came up short for "${binding.name}"`);
	const slice = new Uint8Array(bytes.subarray(offsetBytes, offsetBytes + width));
	if (binding.endianness === "big") slice.reverse();
	return readValue$1(new DataView(slice.buffer, slice.byteOffset, slice.byteLength), binding.type);
}
function readValue$1(view, type) {
	switch (type) {
		case "i8": return view.getInt8(0);
		case "u8": return view.getUint8(0);
		case "i16": return view.getInt16(0, true);
		case "u16": return view.getUint16(0, true);
		case "i32": return view.getInt32(0, true);
		case "u32": return view.getUint32(0, true);
		case "f32": return view.getFloat32(0, true);
		case "f64": return view.getFloat64(0, true);
		case "bool": return view.getUint8(0) !== 0;
	}
}
/**
* Poll a set of memory bindings over J-Link's GDB server and emit samples.
*
* Emits one `samples` event per poll cycle containing every binding read
* successfully, so a failed or torn binding becomes a gap in its own series
* rather than a hole in the whole cycle.
*/
var JLinkReader = class extends EventEmitter {
	options;
	rsp;
	timer;
	bindings = [];
	running = false;
	busy = false;
	polls = 0;
	failures = 0;
	tornDropped = 0;
	constructor(options) {
		super();
		this.options = {
			intervalMs: 100,
			verifyConsistency: true,
			batchDistanceBytes: 64,
			commandTimeoutMs: 5e3,
			...options
		};
	}
	status() {
		if (this.rsp === void 0 || !this.running) return { kind: "idle" };
		return {
			kind: "running",
			polls: this.polls,
			failures: this.failures,
			tornDropped: this.tornDropped
		};
	}
	/** Replace the binding set (safe while running). */
	setBindings(bindings) {
		this.bindings = [...bindings];
	}
	getBindings() {
		return [...this.bindings];
	}
	/** The negotiated acknowledgement mode, for diagnostics. */
	get ackMode() {
		return this.rsp?.ackMode;
	}
	/** Connect the GDB session and begin polling. */
	async start() {
		if (this.running) return;
		const rsp = new RspClient({
			host: this.options.host,
			port: this.options.port,
			timeoutMs: this.options.commandTimeoutMs
		});
		await rsp.connect();
		rsp.on("error", (error) => this.emit("error", error));
		this.rsp = rsp;
		this.running = true;
		this.polls = 0;
		this.failures = 0;
		this.tornDropped = 0;
		this.schedule();
		this.emit("status", this.status());
	}
	/** Stop polling and close the GDB session. */
	stop() {
		this.running = false;
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		this.rsp?.close();
		this.rsp = void 0;
		this.emit("status", this.status());
	}
	schedule() {
		if (!this.running) return;
		const delay = Math.max(1, Math.round(this.options.intervalMs));
		this.timer = setTimeout(() => {
			this.tick().finally(() => this.schedule());
		}, delay);
	}
	/**
	* One poll cycle.
	*
	* Re-entrancy is guarded: a slow cycle skips its next slot instead of
	* stacking up requests the target cannot answer any faster.
	*/
	async tick() {
		if (this.busy) return;
		const rsp = this.rsp;
		if (rsp === void 0 || this.bindings.length === 0) return;
		this.busy = true;
		try {
			const values = await this.readAll(rsp);
			this.polls += 1;
			if (Object.keys(values).length > 0) this.emit("samples", [{
				ts: Date.now(),
				values
			}]);
			this.emit("status", this.status());
		} catch (error) {
			this.failures += 1;
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit("error", err);
			this.emit("status", {
				kind: "error",
				message: err.message
			});
		} finally {
			this.busy = false;
		}
	}
	/** Read every binding, honouring batching and the consistency check. */
	async readAll(rsp) {
		const batches = planReadBatches$1(this.bindings, this.options.batchDistanceBytes);
		const values = {};
		for (const batch of batches) {
			const first = await rsp.readMemory(batch.base, batch.length);
			let second;
			if (this.options.verifyConsistency) second = await rsp.readMemory(batch.base, batch.length);
			for (const member of batch.members) try {
				const value = decodeBindingBytes(first, member.offset, member.binding);
				if (second !== void 0) {
					if (!sameValue$1(value, decodeBindingBytes(second, member.offset, member.binding))) {
						this.tornDropped += 1;
						continue;
					}
				}
				values[member.binding.name] = value;
			} catch {
				this.failures += 1;
			}
		}
		return values;
	}
};
/** NaN-aware equality (a float read that stays NaN is stable, not torn). */
function sameValue$1(a, b) {
	if (typeof a === "boolean" || typeof b === "boolean") return a === b;
	if (Number.isNaN(a) && Number.isNaN(b)) return true;
	return a === b;
}
// src/parsers/csv.ts
/**
* CSV variable parser — the default for the RTT data channel.
*
* Handles the common "NumericColumn,AnotherColumn,..." streaming shape,
* optionally preceded by one header line naming the columns. Also accepts
* whitespace/semicolon/tab delimiters, because firmware authors pick whatever
* their printf habits suggest.
*
* Fractional numbers with an optional unit suffix are accepted
* (`12007 mV`, `3.3V`, `-12.5`), which keeps a target from having to strip
* units before writing to the channel.
*/
/** `-1.5e3`, `12007 mV`, `3,3` are not accepted — one number, optional unit. */
const NUMBER_WITH_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµΩ%°/][A-Za-zµΩ%°/0-9]*)?$/;
/** Splits one line on the configured delimiter. */
function splitLine(line, delimiter) {
	if (delimiter === " ") return line.trim().split(/\s+/);
	return line.split(delimiter).map((field) => field.trim());
}
/**
* Parses one numeric field into a value plus an optional unit.
* @returns `undefined` when the field is not a number (e.g. a label).
*/
function parseField(raw) {
	const text = raw.trim();
	if (text === "") return void 0;
	const m = NUMBER_WITH_UNIT.exec(text);
	if (m === null) return void 0;
	const value = Number(m[1]);
	if (Number.isNaN(value)) return void 0;
	return m[2] === void 0 ? { value } : {
		value,
		unit: m[2]
	};
}
var CsvParser = class {
	id = "csv";
	delimiter = ",";
	headerMode = "auto";
	explicitColumns;
	explicitUnits;
	maxColumns = Number.POSITIVE_INFINITY;
	lines = new LineSplitter();
	names = [];
	units = [];
	/** Whether the first data-bearing line has already been classified. */
	firstLineSeen = false;
	descriptorsCache = [];
	configure(options) {
		if (typeof options["delimiter"] === "string" && options["delimiter"] !== "") this.delimiter = options["delimiter"];
		if (typeof options["lineTerminator"] === "string" && options["lineTerminator"] !== "") this.lines.setTerminator(decodeTerminator(options["lineTerminator"]));
		const header = options["hasHeader"];
		if (typeof header === "boolean" || header === "auto") this.headerMode = header;
		if (Array.isArray(options["columns"])) this.explicitColumns = options["columns"].filter((c) => typeof c === "string");
		if (Array.isArray(options["units"])) this.explicitUnits = options["units"].filter((u) => typeof u === "string");
		if (typeof options["maxColumns"] === "number" && options["maxColumns"] > 0) this.maxColumns = Math.floor(options["maxColumns"]);
	}
	feed(chunk) {
		const out = [];
		for (const line of this.lines.push(chunk)) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			if (!this.firstLineSeen) {
				this.firstLineSeen = true;
				const fields = splitLine(trimmed, this.delimiter);
				if (this.isHeaderLine(fields)) {
					this.names = this.explicitColumns ?? fields;
					this.units = this.explicitUnits ?? [];
					this.refreshDescriptors();
					continue;
				}
				this.names = this.explicitColumns ?? Array.from({ length: Math.min(fields.length, this.maxColumns) }, (_, i) => `col${i + 1}`);
				this.units = this.explicitUnits ?? [];
				this.refreshDescriptors();
			}
			const sample = this.parseDataLine(trimmed);
			if (sample !== void 0) out.push(sample);
		}
		return out;
	}
	/**
	* Decide whether the first line names the columns.
	*
	* `auto` calls it a header when NO field parses as a number — a data row with
	* every field numeric is by far the common case, so the two are cleanly
	* separable, and a row of pure labels was never going to yield samples.
	*/
	isHeaderLine(fields) {
		if (this.headerMode === true) return true;
		if (this.headerMode === false) return false;
		if (fields.length === 0) return false;
		return fields.every((field) => parseField(field) === void 0);
	}
	parseDataLine(line) {
		const fields = splitLine(line, this.delimiter);
		if (fields.length === 0) return void 0;
		if (this.names.length === 0) {
			const width = Math.min(fields.length, this.maxColumns);
			this.names = this.explicitColumns ?? Array.from({ length: width }, (_, i) => `col${i + 1}`);
			this.units = this.explicitUnits ?? [];
			this.refreshDescriptors();
		}
		const values = {};
		const limit = Math.min(fields.length, this.names.length, this.maxColumns);
		for (let i = 0; i < limit; i += 1) {
			const parsed = parseField(fields[i] ?? "");
			if (parsed === void 0) continue;
			const name = this.names[i];
			if (name === void 0) continue;
			values[name] = parsed.value;
			if (parsed.unit !== void 0 && this.units[i] === void 0) {
				this.units[i] = parsed.unit;
				this.refreshDescriptors();
			}
		}
		if (Object.keys(values).length === 0) return void 0;
		return {
			ts: Date.now(),
			values
		};
	}
	refreshDescriptors() {
		this.descriptorsCache = this.names.map((name, i) => {
			const unit = this.units[i];
			return unit === void 0 ? {
				name,
				kind: "number",
				source: "rttVar",
				index: i
			} : {
				name,
				unit,
				kind: "number",
				source: "rttVar",
				index: i
			};
		});
	}
	descriptors() {
		return this.descriptorsCache;
	}
	reset() {
		this.lines.reset();
		this.names = [];
		this.units = [];
		this.firstLineSeen = false;
		this.descriptorsCache = [];
	}
};
// src/parsers/keyvalue.ts
/**
* `key=value` variable parser for the RTT data channel.
*
* Accepts one pair per line (`Volt=12007`) and several pairs per line
* (`Volt=12007 Cycles=3`), with `=` or `:` as the separator, optional
* surrounding whitespace, and an optional unit suffix on the value.
*
* Unlike the CSV parser — where a row is one sample — each *pair* here is its
* own sample timestamped when it was parsed. That matches how firmware tends
* to emit key/value streams: fields become available at different times, and a
* consumer reading only `Volt` should not be forced to wait for the slower
* fields of the same logical group.
*/
/**
* `name=12007 mV`, `name: 3`, `flag=true`, `12007mV`.
*
* The unit group needs two guards, and leaving either out silently eats the
* NEXT pair's key: `volt=12007 amps=3` would otherwise parse `amps` as volt's
* unit and lose the `amps` pair entirely.
*
*   (?![A-Za-z0-9µΩ%°/])  the candidate token must be maximal — without it the
*                         engine backtracks to `amp` and accepts that instead
*   (?!\s*[:=])           and it must not be followed by a pair separator
*
* Units written flush against the number (`12007mV`) always survive, so a
* target that omits the space is unaffected.
*/
const PAIR = /([A-Za-z_][A-Za-z0-9_.\-[\]$]*)\s*[:=]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµΩ%°/][A-Za-zµΩ%°/0-9]*)?(?![A-Za-z0-9µΩ%°/])(?!\s*[:=])/g;
/** Boolean spellings a target may print. */
const TRUE_WORDS = /* @__PURE__ */ new Set([
	"true",
	"on",
	"yes",
	"high"
]);
const FALSE_WORDS = /* @__PURE__ */ new Set([
	"false",
	"off",
	"no",
	"low"
]);
const BOOL_PAIR = /([A-Za-z_][A-Za-z0-9_.\-[\]$]*)\s*[:=]\s*(true|false|on|off|yes|no|high|low)\b/gi;
var KeyValueParser = class {
	id = "keyvalue";
	multiplePerLine = true;
	separator;
	lines = new LineSplitter();
	units = /* @__PURE__ */ new Map();
	kinds = /* @__PURE__ */ new Map();
	order = [];
	descriptorsCache = [];
	configure(options) {
		if (typeof options["multiplePerLine"] === "boolean") this.multiplePerLine = options["multiplePerLine"];
		if (typeof options["separator"] === "string" && options["separator"] !== "") this.separator = options["separator"];
		if (typeof options["lineTerminator"] === "string" && options["lineTerminator"] !== "") this.lines.setTerminator(decodeTerminator(options["lineTerminator"]));
	}
	feed(chunk) {
		const out = [];
		for (const line of this.lines.push(chunk)) {
			if (line.trim() === "") continue;
			out.push(...this.parseLine(line));
		}
		return out;
	}
	parseLine(line) {
		const values = {};
		const unitsSeen = {};
		for (const m of line.matchAll(BOOL_PAIR)) {
			const name = m[1];
			const word = m[2]?.toLowerCase();
			if (name === void 0 || word === void 0) continue;
			const value = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : void 0;
			if (value === void 0) continue;
			values[name] = value;
			this.kinds.set(name, "bool");
			this.noteName(name);
		}
		const pattern = new RegExp(PAIR.source, PAIR.flags);
		for (const m of line.matchAll(pattern)) {
			const name = m[1];
			if (name === void 0) continue;
			if (this.separator !== void 0) {
				if (!m[0].slice(name.length).trimStart().startsWith(this.separator)) continue;
			}
			const value = Number(m[2]);
			if (Number.isNaN(value)) continue;
			values[name] = value;
			const unit = m[3];
			if (unit !== void 0 && !unitsSeen[name]) {
				unitsSeen[name] = unit;
				this.units.set(name, unit);
			}
			this.kinds.set(name, "number");
			this.noteName(name);
			if (!this.multiplePerLine) break;
		}
		if (Object.keys(values).length === 0) return [];
		this.refreshDescriptors();
		const ts = Date.now();
		return Object.entries(values).map(([name, value]) => ({
			ts,
			values: { [name]: value }
		}));
	}
	noteName(name) {
		if (!this.order.includes(name)) this.order.push(name);
	}
	refreshDescriptors() {
		this.descriptorsCache = this.order.map((name, index) => {
			const unit = this.units.get(name);
			const base = {
				name,
				kind: this.kinds.get(name) ?? "number",
				source: "rttVar",
				index
			};
			return unit === void 0 ? base : {
				...base,
				unit
			};
		});
	}
	descriptors() {
		return this.descriptorsCache;
	}
	reset() {
		this.lines.reset();
		this.units.clear();
		this.kinds.clear();
		this.order = [];
		this.descriptorsCache = [];
	}
};
// src/parsers/binary-frame.ts
/**
* Binary-frame variable parser for the RTT data channel.
*
* For targets that stream packed structs rather than text. Framing is either a
* fixed frame length, or a length field inside the frame (useful when the
* target sends variable payload sizes).
*
* The field layout is declared explicitly — a parser cannot guess a C struct
* layout, and inferring one would silently mis-decode every field after the
* first mismatch. Both endiannesses are supported; little is the default.
*/
/** Reads one scalar out of a DataView with explicit endianness. */
function readScalar(view, offset, type, little) {
	switch (type) {
		case "i8": return view.getInt8(offset);
		case "u8": return view.getUint8(offset);
		case "i16": return view.getInt16(offset, little);
		case "u16": return view.getUint16(offset, little);
		case "i32": return view.getInt32(offset, little);
		case "u32": return view.getUint32(offset, little);
		case "f32": return view.getFloat32(offset, little);
		case "f64": return view.getFloat64(offset, little);
		case "bool": return view.getUint8(offset) !== 0;
	}
}
var BinaryFrameParser = class {
	id = "binary-frame";
	frames = new FixedFrameSplitter(4);
	lengthField;
	little = true;
	fields = [];
	magic;
	growable = /* @__PURE__ */ new Uint8Array(0);
	descriptorsCache = [];
	configure(options) {
		if (typeof options["endianness"] === "string") this.little = options["endianness"] !== "big";
		if (Array.isArray(options["fields"])) this.fields = options["fields"].filter((f) => {
			if (typeof f !== "object" || f === null) return false;
			const rec = f;
			return typeof rec["name"] === "string" && typeof rec["type"] === "string" && rec["type"] in SCALAR_BYTES;
		});
		if (options["magic"] !== void 0) this.magic = normalizeMagic(options["magic"]);
		const lf = options["lengthField"];
		if (typeof lf === "object" && lf !== null) {
			const rec = lf;
			const size = rec["size"];
			const offset = rec["offset"];
			if (typeof offset === "number" && (size === 1 || size === 2 || size === 4)) this.lengthField = {
				offset,
				size,
				includesHeader: rec["includesHeader"] !== false
			};
		}
		if (typeof options["frameLength"] === "number" && options["frameLength"] > 0) this.frames.setFrameLength(Math.floor(options["frameLength"]));
		this.refreshDescriptors();
	}
	feed(chunk) {
		if (this.lengthField !== void 0) return this.feedLengthPrefixed(chunk);
		const out = [];
		for (const frame of this.frames.push(chunk)) {
			const sample = this.decode(frame);
			if (sample !== void 0) out.push(sample);
		}
		return out;
	}
	feedLengthPrefixed(chunk) {
		const lf = this.lengthField;
		if (lf === void 0) return [];
		const merged = new Uint8Array(this.growable.length + chunk.length);
		merged.set(this.growable, 0);
		merged.set(chunk, this.growable.length);
		this.growable = merged;
		const out = [];
		for (;;) {
			const headerBytes = lf.offset + lf.size;
			if (this.growable.length < headerBytes) break;
			const view = new DataView(this.growable.buffer, this.growable.byteOffset, this.growable.byteLength);
			let declared;
			if (lf.size === 1) declared = view.getUint8(lf.offset);
			else if (lf.size === 2) declared = view.getUint16(lf.offset, this.little);
			else declared = view.getUint32(lf.offset, this.little);
			const total = lf.includesHeader ? declared : declared + headerBytes;
			if (total <= 0 || total > 1 << 20) {
				this.growable = this.growable.subarray(1);
				continue;
			}
			if (this.growable.length < total) break;
			const frame = this.growable.subarray(0, total);
			const sample = this.decode(frame);
			if (sample !== void 0) out.push(sample);
			this.growable = this.growable.subarray(total);
		}
		this.growable = new Uint8Array(this.growable);
		return out;
	}
	decode(frame) {
		if (this.magic !== void 0) {
			if (frame.length < this.magic.length) return void 0;
			for (let i = 0; i < this.magic.length; i += 1) if (frame[i] !== this.magic[i]) return void 0;
		}
		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		const values = {};
		let auto = this.magic?.length ?? 0;
		for (const field of this.fields) {
			const width = SCALAR_BYTES[field.type];
			let offset = field.offset;
			if (offset === void 0) offset = auto;
			auto = offset + width;
			if (offset + width > frame.length) return void 0;
			values[field.name] = readScalar(view, offset, field.type, this.little);
		}
		if (Object.keys(values).length === 0) return void 0;
		return {
			ts: Date.now(),
			values
		};
	}
	refreshDescriptors() {
		this.descriptorsCache = this.fields.map((field, index) => {
			const kind = field.type === "bool" ? "bool" : "number";
			const base = {
				name: field.name,
				kind,
				source: "rttVar",
				index
			};
			return field.unit === void 0 ? base : {
				...base,
				unit: field.unit
			};
		});
	}
	descriptors() {
		return this.descriptorsCache;
	}
	reset() {
		this.frames.reset();
		this.growable = /* @__PURE__ */ new Uint8Array(0);
	}
};
/**
* Accepts `"AA 55"`, `"0xAA,0x55"`, `"aa55"`, or `[0xAA, 0x55]` as a magic prefix.
*
* Bare two-digit hex is the common way people write a magic word, so a token
* that is exactly two hex digits is read as hex rather than decimal — reading
* `"AA"` as decimal yields NaN and would silently disable the filter, which is
* the one failure mode a magic check must never have.
*/
function normalizeMagic(raw) {
	const toByte = (token) => {
		const text = token.trim();
		if (text === "") return void 0;
		if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
			const n = Number.parseInt(text.slice(2), 16);
			return Number.isNaN(n) ? void 0 : n & 255;
		}
		if (/^[0-9a-fA-F]{2}$/.test(text)) return Number.parseInt(text, 16) & 255;
		if (/^\d{1,3}$/.test(text)) {
			const n = Number.parseInt(text, 10);
			return n > 255 ? void 0 : n;
		}
		if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
			const first = Number.parseInt(text.slice(0, 2), 16);
			return Number.isNaN(first) ? void 0 : first & 255;
		}
	};
	if (typeof raw === "string") {
		const compact = raw.trim();
		if (/^[0-9a-fA-F]+$/.test(compact) && compact.length > 2 && compact.length % 2 === 0) {
			const bytes = [];
			for (let i = 0; i < compact.length; i += 2) bytes.push(Number.parseInt(compact.slice(i, i + 2), 16) & 255);
			return bytes.length === 0 ? void 0 : Uint8Array.from(bytes);
		}
		const parsed = compact.split(/[\s,]+/).filter(Boolean).map(toByte).filter((b) => b !== void 0);
		return parsed.length === 0 ? void 0 : Uint8Array.from(parsed);
	}
	if (Array.isArray(raw)) {
		const clean = raw.filter((b) => typeof b === "number").map((b) => b & 255);
		return clean.length === 0 ? void 0 : Uint8Array.from(clean);
	}
}
// src/parsers/custom-regex.ts
/**
* Custom-regex variable parser for the RTT data channel.
*
* The escape hatch for targets whose output is neither CSV, key/value, nor a
* packed struct: a log-style line carrying embedded measurements, a vendor
* protocol string, anything a user can describe with one pattern.
*
* Named capture groups become the variable names, so the pattern itself is the
* configuration — there is no separate group-to-name table to keep in sync:
*
*   pattern: /V=(?<volt>\d+)mV\s+I=(?<amps>-?\d+)mA/
*
* Unnamed groups would have to be addressed positionally and are rejected,
* because a pattern that silently drops its data is worse than a clear error.
*/
/** Extracts `?<name>` group names from a pattern source. */
function namedGroupsOf(source) {
	const names = [];
	for (const m of source.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) if (m[1] !== void 0) names.push(m[1]);
	return names;
}
var CustomRegexParser = class {
	id = "custom-regex";
	source;
	flags = "g";
	regex;
	lines = new LineSplitter();
	units = /* @__PURE__ */ new Map();
	order = [];
	descriptorsCache = [];
	configure(options) {
		if (typeof options["pattern"] === "string") this.source = options["pattern"];
		if (typeof options["flags"] === "string" && options["flags"] !== "") this.flags = options["flags"];
		if (typeof options["lineTerminator"] === "string" && options["lineTerminator"] !== "") this.lines.setTerminator(decodeTerminator(options["lineTerminator"]));
		if (this.source !== void 0) {
			this.regex = new RegExp(this.source, this.flags.includes("g") ? this.flags : `${this.flags}g`);
			for (const name of namedGroupsOf(this.source)) if (!this.order.includes(name)) this.order.push(name);
			this.refreshDescriptors();
		}
	}
	feed(chunk) {
		const regex = this.regex;
		if (regex === void 0) return [];
		const out = [];
		for (const line of this.lines.push(chunk)) {
			regex.lastIndex = 0;
			for (const m of line.matchAll(regex)) {
				const groups = m.groups;
				if (groups === void 0) continue;
				const values = {};
				for (const name of this.order) {
					const raw = groups[name];
					if (raw === void 0) continue;
					const parsed = parseValue(raw);
					if (parsed === void 0) continue;
					values[name] = parsed.value;
					if (parsed.unit !== void 0 && !this.units.has(name)) this.units.set(name, parsed.unit);
				}
				if (Object.keys(values).length > 0) out.push({
					ts: Date.now(),
					values
				});
			}
		}
		if (out.length > 0) this.refreshDescriptors();
		return out;
	}
	refreshDescriptors() {
		this.descriptorsCache = this.order.map((name, index) => {
			const unit = this.units.get(name);
			const base = {
				name,
				kind: "number",
				source: "rttVar",
				index
			};
			return unit === void 0 ? base : {
				...base,
				unit
			};
		});
	}
	/** Group names this parser will emit (empty until a pattern is configured). */
	groupNames() {
		return [...this.order];
	}
	descriptors() {
		return this.descriptorsCache;
	}
	reset() {
		this.lines.reset();
	}
};
/** Captured text → number, boolean, or (with a suffix) number plus unit. */
function parseValue(raw) {
	const text = raw.trim();
	if (text === "") return void 0;
	const lower = text.toLowerCase();
	if ([
		"true",
		"on",
		"yes",
		"high"
	].includes(lower)) return { value: true };
	if ([
		"false",
		"off",
		"no",
		"low"
	].includes(lower)) return { value: false };
	const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµΩ%°/][A-Za-zµΩ%°/0-9]*)?$/.exec(text);
	if (m === null) return void 0;
	const value = Number(m[1]);
	if (Number.isNaN(value)) return void 0;
	return m[2] === void 0 ? { value } : {
		value,
		unit: m[2]
	};
}
// src/parsers/script.ts
/**
* Script parser — a user-defined record → variables transform.
*
* WHY THIS IS AN EXPRESSION, NOT A SCRIPT: this runs in the HOST process, next
* to the user's shell and their source tree. `new Function` on arbitrary text
* would be remote code execution with the plugin as the delivery vehicle — one
* pasted "parser" and the machine is gone. So the user writes an EXPRESSION that
* maps the already-split fields of one record to a value map, and nothing else:
*
*     { volt: fields[0] * 3.3 / 4095, amps: fields[1] / 1000 }
*
* That covers every real "my format is slightly different" case — scaling,
* combining columns, renaming, unit conversion, conditional booleans — while
* remaining a pure function of the record. There is no `require`, no `process`,
* no `globalThis`: the compiler below accepts a closed set of syntax and rejects
* everything else, so `fields`, `line`, `index` and numeric literals are the
* entire available universe.
*
* Compiled once per configuration change, and a throw during evaluation is
* contained per record (one bad line must not kill the stream).
*/
/**
* Names an expression may reference.
*
* Deliberately tiny: there is no path from here to the host process.
*/
const ALLOWED_IDENTIFIERS = /* @__PURE__ */ new Set([
	"fields",
	"line",
	"index",
	"Number",
	"Math",
	"true",
	"false",
	"null",
	"undefined"
]);
/**
* Whether an identifier sits in an object-key position (`{ key: value }`).
*
* Decided from BOTH sides so a name cannot be smuggled into value position: the
* text before must end at an object boundary (`{` opening or `,` separating),
* and the text after must begin with the key's colon. A ternary `cond ? a : b`
* therefore does NOT qualify — its `a` is preceded by `?`, not by `{` or `,`.
*
* @param before - expression text preceding the identifier.
* @param after - expression text following the identifier.
*/
function isObjectKey(before, after) {
	if (!/^\s*:/.test(after)) return false;
	const trimmed = before.replace(/\s+$/, "");
	if (trimmed === "") return false;
	const last = trimmed[trimmed.length - 1];
	return last === "{" || last === ",";
}
/**
* Reject anything that could escape the sandbox BEFORE the expression is ever
* compiled.
*
* This is a deny-list on top of a small allow-list (`ALLOWED_IDENTIFIERS`): each
* banned form is one that reaches host capability even without a global object
* — `constructor` walks to `Function`, the others name the runtime directly.
*/
const FORBIDDEN_PATTERNS = [
	{
		pattern: /\bconstructor\b/,
		reason: "\"constructor\" can reach the Function object"
	},
	{
		pattern: /\bprototype\b/,
		reason: "\"prototype\" can reach the Function object"
	},
	{
		pattern: /\brequire\b/,
		reason: "\"require\" would load host modules"
	},
	{
		pattern: /\bimport\b/,
		reason: "\"import\" would load host modules"
	},
	{
		pattern: /\bprocess\b/,
		reason: "\"process\" would expose the host process"
	},
	{
		pattern: /\bglobalThis\b/,
		reason: "\"globalThis\" would expose the global object"
	},
	{
		pattern: /\bglobal\b/,
		reason: "\"global\" would expose the global object"
	},
	{
		pattern: /\bwindow\b/,
		reason: "\"window\" would expose the global object"
	},
	{
		pattern: /\beval\b/,
		reason: "\"eval\" would defeat this check"
	},
	{
		pattern: /\bFunction\b/,
		reason: "\"Function\" would compile arbitrary code"
	},
	{
		pattern: /\bthis\b/,
		reason: "\"this\" would escape the sandbox"
	},
	{
		pattern: /\bawait\b/,
		reason: "async syntax is not supported"
	},
	{
		pattern: /\byield\b/,
		reason: "generator syntax is not supported"
	},
	{
		pattern: /=>/,
		reason: "function syntax is not supported"
	},
	{
		pattern: /\bfunction\b/,
		reason: "function syntax is not supported"
	},
	{
		pattern: /;/,
		reason: "a single expression is expected, not a statement list"
	},
	{
		pattern: /[{}][^{}]*[{}][^{}]*\breturn\b/,
		reason: "statements are not supported"
	}
];
/**
* Characters an expression may contain, after the deny-list passes.
*
* Deliberately includes the object literal braces and colon, because the result
* IS an object; it excludes backticks (template literals) and backslashes.
*/
const ALLOWED_CHARS = /^[\s0-9A-Za-z_$.,:+\-*/%()<>!=&|?'"[\]{}\u00b0\u2103]+$/;
/**
* Compile a user expression into an evaluator.
*
* @param source - the expression text.
* @returns either an evaluator or an `error` explaining the rejection.
*/
function compileScript(source) {
	const text = source.trim();
	if (text === "") return { error: "expression is empty" };
	if (!ALLOWED_CHARS.test(text)) return { error: "expression contains characters that are not allowed" };
	for (const { pattern, reason } of FORBIDDEN_PATTERNS) if (pattern.test(text)) return { error: `rejected: ${reason}` };
	const withoutStrings = text.replace(/'[^']*'|"[^"]*"/g, "''");
	for (const match of withoutStrings.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
		const name = match[0];
		const at = match.index ?? 0;
		if (ALLOWED_IDENTIFIERS.has(name)) continue;
		const before = withoutStrings.slice(0, at);
		const after = withoutStrings.slice(at + name.length);
		if (/[.]\s*$/.test(before)) continue;
		if (isObjectKey(before, after)) continue;
		return { error: `unknown name "${name}"; available: fields, line, index, Number, Math` };
	}
	let compiled;
	try {
		compiled = new Function("fields", "line", "index", "Number", "Math", `"use strict"; return (${text});`);
	} catch (error) {
		return { error: `expression does not compile: ${error instanceof Error ? error.message : String(error)}` };
	}
	const invoke = compiled;
	return { evaluate: (fields, line, index) => {
		let raw;
		try {
			raw = invoke(fields, line, index, Number, Math);
		} catch {
			return;
		}
		if (typeof raw !== "object" || raw === null) return void 0;
		const values = {};
		for (const [key, value] of Object.entries(raw)) if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
		else if (typeof value === "boolean") values[key] = value;
		else if (typeof value === "string") {
			const parsed = Number.parseFloat(value);
			if (Number.isFinite(parsed)) values[key] = parsed;
		}
		return Object.keys(values).length === 0 ? void 0 : values;
	} };
}
var ScriptParser = class {
	id = "script";
	lines = new LineSplitter();
	delimiter = ",";
	skipFirstLine = false;
	evaluate;
	compileError;
	index = 0;
	skipped = false;
	names = [];
	descriptorsCache = [];
	/** The last compile error, surfaced so the UI can show why nothing parses. */
	get error() {
		return this.compileError;
	}
	configure(options) {
		if (typeof options["delimiter"] === "string" && options["delimiter"] !== "") this.delimiter = options["delimiter"];
		else this.delimiter = ",";
		this.skipFirstLine = options["skipFirstLine"] === true;
		if (typeof options["lineTerminator"] === "string" && options["lineTerminator"] !== "") this.lines.setTerminator(decodeTerminator(options["lineTerminator"]));
		const result = compileScript(typeof options["expression"] === "string" ? options["expression"] : "");
		this.evaluate = result.evaluate;
		this.compileError = result.error;
		this.names = [];
		this.descriptorsCache = [];
		this.index = 0;
		this.skipped = false;
	}
	feed(chunk) {
		const evaluate = this.evaluate;
		if (evaluate === void 0) return [];
		const out = [];
		for (const line of this.lines.push(chunk)) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			if (this.skipFirstLine && !this.skipped) {
				this.skipped = true;
				continue;
			}
			const values = evaluate(this.delimiter === " " ? trimmed.split(/\s+/) : trimmed.split(this.delimiter).map((f) => f.trim()), trimmed, this.index);
			this.index += 1;
			if (values === void 0) continue;
			for (const name of Object.keys(values)) if (!this.names.includes(name)) {
				this.names.push(name);
				this.refreshDescriptors();
			}
			out.push({
				ts: Date.now(),
				values
			});
		}
		return out;
	}
	descriptors() {
		return this.descriptorsCache;
	}
	/** Drop buffered text and the record counter (stream restart). */
	reset() {
		this.lines.reset();
		this.index = 0;
		this.skipped = false;
	}
	refreshDescriptors() {
		this.descriptorsCache = this.names.map((name, index) => ({
			name,
			kind: "number",
			source: "rttVar",
			index
		}));
	}
};
// src/parsers/registry.ts
var ParserRegistry = class {
	factories = /* @__PURE__ */ new Map();
	/** @returns the disposer removing the registration. */
	register(id, factory) {
		this.factories.set(id, factory);
		return () => {
			if (this.factories.get(id) === factory) this.factories.delete(id);
		};
	}
	/** @returns true when an id is available. */
	has(id) {
		return this.factories.has(id);
	}
	/** Registered ids, in insertion order. */
	list() {
		return [...this.factories.keys()];
	}
	/**
	* Instantiate a provider by id.
	* @throws when the id is unknown — a misconfigured profile must fail loudly
	*   instead of silently producing an empty waveform.
	*/
	create(id) {
		const factory = this.factories.get(id);
		if (factory === void 0) throw new Error(`unknown variable parser "${id}"; available: ${this.list().join(", ") || "(none)"}`);
		return factory();
	}
};
/** A registry with the built-in parsers installed. */
function createDefaultRegistry() {
	const registry = new ParserRegistry();
	registry.register("csv", () => new CsvParser());
	registry.register("keyvalue", () => new KeyValueParser());
	registry.register("binary-frame", () => new BinaryFrameParser());
	registry.register("custom-regex", () => new CustomRegexParser());
	registry.register("script", () => new ScriptParser());
	return registry;
}
// src/ocd/tcl.ts
/**
* OpenOCD TCL client.
*
* OpenOCD's TCL port speaks a simple line protocol: a command terminated by the
* 0x1A byte, and a response that ends with the same byte. That is the transport
* the third data source uses to read target memory — no firmware cooperation
* needed, unlike the two RTT channels.
*
* The client is intentionally READ-ONLY. It exposes exactly one write-capable
* command (`halt`, needed so a running target's memory can be sampled
* coherently) and rejects everything else, because a debug panel that can
* silently mutate a target is a liability (spec §3.8.5).
*/
/** The TCL protocol's message terminator. */
const TCL_TERMINATOR = 26;
/**
* Commands this client will forward to OpenOCD.
*
* Anything absent is refused before it reaches the wire. Read commands are
* `mdb`/`mdh`/`mdw` (byte/half/word memory display) plus the inspection
* helpers; `halt` is permitted because sampling a running target yields torn
* reads, and stopping the core is the standard, reversible way to avoid that.
*/
const ALLOWED_READ_COMMANDS = /* @__PURE__ */ new Set([
	"mdb",
	"mdh",
	"mdw",
	"reg",
	"halt",
	"resume",
	"targets",
	"echo"
]);
/** Refuse anything that writes, erases or resets. Listed for error messages. */
const FORBIDDEN_COMMANDS = /* @__PURE__ */ new Set([
	"mwb",
	"mwh",
	"mww",
	"flash",
	"reset",
	"shutdown",
	"exit",
	"bp",
	"rbp",
	"wp",
	"rwp",
	"load_image"
]);
/**
* Parse a command's first word and decide whether it is safe.
* @throws when the command is not on the read-only allowlist.
*/
function assertReadOnly(command) {
	const first = command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	if (first === "") throw new Error("empty OpenOCD command");
	if (ALLOWED_READ_COMMANDS.has(first)) return;
	if (FORBIDDEN_COMMANDS.has(first)) throw new Error(`refusing write-capable OpenOCD command "${first}" — this reader is read-only`);
	throw new Error(`OpenOCD command "${first}" is not on the read-only allowlist`);
}
var OcdTcl = class extends EventEmitter {
	socket;
	pending;
	buffer = "";
	options;
	timeoutMs;
	closed = true;
	constructor(options) {
		super();
		this.options = options;
		this.timeoutMs = options.timeoutMs ?? 5e3;
	}
	get connected() {
		return this.socket !== void 0 && !this.closed;
	}
	/** Open the TCL connection. @throws when the port refuses or times out. */
	connect() {
		return new Promise((resolve, reject) => {
			const socket = connect({
				host: this.options.host,
				port: this.options.port
			});
			const onError = (error) => {
				socket.removeAllListeners();
				socket.destroy();
				reject(error);
			};
			const timer = setTimeout(() => {
				onError(/* @__PURE__ */ new Error(`OpenOCD TCL connect timeout after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			socket.once("error", (error) => {
				clearTimeout(timer);
				onError(error);
			});
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.setNoDelay(true);
				this.socket = socket;
				this.closed = false;
				socket.on("data", (chunk) => this.onData(chunk));
				socket.on("error", (error) => this.emit("error", error));
				socket.on("close", () => {
					this.closed = true;
					this.socket = void 0;
					this.failPending(/* @__PURE__ */ new Error("OpenOCD TCL connection closed"));
					this.emit("close");
				});
				resolve();
			});
		});
	}
	close() {
		const socket = this.socket;
		this.socket = void 0;
		this.closed = true;
		if (socket !== void 0) {
			socket.removeAllListeners();
			socket.destroy();
		}
		this.failPending(/* @__PURE__ */ new Error("OpenOCD TCL client closed"));
	}
	/**
	* Send one command and await its response.
	* @throws when the command is not read-only, or the response times out.
	*/
	async cmd(command) {
		assertReadOnly(command);
		const socket = this.socket;
		if (socket === void 0) throw new Error("OpenOCD TCL is not connected");
		if (this.pending !== void 0) throw new Error("OpenOCD TCL already has a command in flight");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = void 0;
				reject(/* @__PURE__ */ new Error(`OpenOCD TCL command timed out: ${command}`));
			}, this.timeoutMs);
			this.pending = {
				resolve,
				reject,
				timer
			};
			socket.write(`${command}\x1a`);
		});
	}
	/**
	* Read `count` 32-bit words starting at `address`.
	* @returns the decoded words, in address order.
	*/
	async readWords(address, count) {
		return parseMemoryWords(await this.cmd(`mdw ${hex(address)} ${count}`));
	}
	/**
	* Read `count` 16-bit halfwords starting at `address`.
	* @returns address-ordered values, widened to numbers.
	*/
	async readHalfwords(address, count) {
		return parseMemoryWords(await this.cmd(`mdh ${hex(address)} ${count}`));
	}
	/**
	* Read `count` bytes starting at `address`.
	* @returns address-ordered byte values.
	*/
	async readBytes(address, count) {
		return parseMemoryWords(await this.cmd(`mdb ${hex(address)} ${count}`));
	}
	/** List the channels/targets OpenOCD currently knows, for diagnostics. */
	async targets() {
		return this.cmd("targets");
	}
	onData(chunk) {
		this.buffer += chunk.toString("latin1");
		for (;;) {
			const at = this.buffer.indexOf(String.fromCharCode(TCL_TERMINATOR));
			if (at === -1) break;
			const payload = this.buffer.slice(0, at);
			this.buffer = this.buffer.slice(at + 1);
			const pending = this.pending;
			if (pending !== void 0) {
				this.pending = void 0;
				clearTimeout(pending.timer);
				pending.resolve(payload);
			}
		}
	}
	failPending(error) {
		const pending = this.pending;
		if (pending === void 0) return;
		this.pending = void 0;
		clearTimeout(pending.timer);
		pending.reject(error);
	}
};
/** `0x`-prefixed lowercase hex, the form OpenOCD accepts. */
function hex(address) {
	return `0x${(address >>> 0).toString(16)}`;
}
/**
* Parse OpenOCD's `md*` output.
*
* The reply is one or more lines of `0xADDR: 00112233 44556677 …`, so only the
* hex tokens after the colon are values — the leading address must not be
* mistaken for data.
*/
function parseMemoryWords(reply) {
	const out = [];
	for (const line of reply.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		for (const token of line.slice(colon + 1).trim().split(/\s+/)) {
			if (token === "") continue;
			const value = Number.parseInt(token, 16);
			if (!Number.isNaN(value)) out.push(value);
		}
	}
	return out;
}
// src/ocd/reader.ts
/**
* OCD memory reader: the third data source.
*
* Samples configured target-memory locations through OpenOCD's TCL interface.
* Unlike the RTT channels this needs no cooperation from the firmware at all —
* which is exactly why it exists (a variable can be watched on a target that
* was never instrumented for it).
*
* Two properties shape the implementation:
*
*   - **Coherence.** A target that keeps running can update a multi-byte
*     variable between the bytes of one read, yielding a value that never
*     existed. `verifyConsistency` reads twice and rejects the sample when the
*     two differ, so a torn value becomes a gap instead of a lie.
*   - **Round-trip cost.** Every TCL command is a network round trip. Bindings
*     that live near each other are merged into one `mdw` and sliced locally,
*     which turns N round trips into one for the common case of a struct.
*/
/**
* Group bindings into as few `mdw` reads as possible.
*
* Everything is read as 32-bit words because that is the cheapest OpenOCD
* primitive; narrower values are sliced out of the word afterwards. Batches are
* formed over ascending addresses and closed when the gap to the next binding
* exceeds `maxDistance` — merging across a huge gap would read far more memory
* than the variables actually need.
*/
function planReadBatches(bindings, maxDistance) {
	if (bindings.length === 0) return [];
	const sorted = [...bindings].sort((a, b) => a.address - b.address);
	const batches = [];
	let current;
	let currentEnd = 0;
	for (const binding of sorted) {
		const width = bindingWidth(binding);
		const start = binding.address;
		const end = start + width;
		const gap = start - currentEnd;
		if (current !== void 0 && maxDistance > 0 && gap <= maxDistance) {
			const offset = start - current.base;
			current.members.push({
				binding,
				offset
			});
			currentEnd = Math.max(currentEnd, end);
			current.words = Math.ceil((currentEnd - current.base) / 4);
			continue;
		}
		current = {
			base: start,
			words: Math.ceil(width / 4),
			members: [{
				binding,
				offset: 0
			}]
		};
		currentEnd = end;
		batches.push(current);
	}
	return batches;
}
/**
* Extract one value from a word array.
*
* `bytes` are assembled little-endian by default (Cortex-M native); a binding
* marked `big` reverses them. Narrower-than-word values are taken from the
* correct byte lane rather than always from the low bytes, so a `u8` at an
* unaligned address decodes correctly.
*/
function decodeBinding(words, offsetBytes, binding) {
	const width = bindingWidth(binding);
	const wordIndex = Math.floor(offsetBytes / 4);
	const lane = offsetBytes % 4;
	const first = words[wordIndex];
	if (first === void 0) throw new Error(`read came up short for "${binding.name}"`);
	const second = words[wordIndex + 1];
	const bytes = new Uint8Array(width);
	for (let i = 0; i < width; i += 1) {
		const absoluteLane = lane + i;
		const word = absoluteLane < 4 ? first : second;
		if (word === void 0) throw new Error(`read came up short for "${binding.name}"`);
		bytes[i] = word >>> absoluteLane % 4 * 8 & 255;
	}
	if (binding.endianness === "big") bytes.reverse();
	return readValue(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), binding.type);
}
function readValue(view, type) {
	switch (type) {
		case "i8": return view.getInt8(0);
		case "u8": return view.getUint8(0);
		case "i16": return view.getInt16(0, true);
		case "u16": return view.getUint16(0, true);
		case "i32": return view.getInt32(0, true);
		case "u32": return view.getUint32(0, true);
		case "f32": return view.getFloat32(0, true);
		case "f64": return view.getFloat64(0, true);
		case "bool": return view.getUint8(0) !== 0;
	}
}
/**
* Poll a set of memory bindings and emit samples.
*
* Emits one `samples` event per poll cycle containing every binding that was
* read successfully, so a failed or torn binding becomes a gap in its own
* series rather than a hole in the whole cycle.
*/
var OcdReader = class extends EventEmitter {
	options;
	tcl;
	timer;
	bindings = [];
	running = false;
	busy = false;
	polls = 0;
	failures = 0;
	tornDropped = 0;
	constructor(options) {
		super();
		this.options = {
			intervalMs: 100,
			verifyConsistency: true,
			batchDistanceBytes: 64,
			commandTimeoutMs: 5e3,
			...options
		};
	}
	status() {
		if (this.tcl === void 0) return { kind: "idle" };
		if (!this.running) return { kind: "idle" };
		return {
			kind: "running",
			polls: this.polls,
			failures: this.failures,
			tornDropped: this.tornDropped
		};
	}
	/** Replace the binding set (safe while running). */
	setBindings(bindings) {
		this.bindings = [...bindings];
	}
	getBindings() {
		return [...this.bindings];
	}
	/** Connect the TCL session and begin polling. */
	async start() {
		if (this.running) return;
		const tcl = new OcdTcl({
			host: this.options.host,
			port: this.options.port,
			timeoutMs: this.options.commandTimeoutMs
		});
		await tcl.connect();
		this.tcl = tcl;
		this.running = true;
		this.polls = 0;
		this.failures = 0;
		this.tornDropped = 0;
		this.schedule();
		this.emit("status", this.status());
	}
	/** Stop polling and close the TCL session. */
	stop() {
		this.running = false;
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		this.tcl?.close();
		this.tcl = void 0;
		this.emit("status", this.status());
	}
	schedule() {
		if (!this.running) return;
		const delay = Math.max(1, Math.round(this.options.intervalMs ?? 100));
		this.timer = setTimeout(() => {
			this.tick().finally(() => this.schedule());
		}, delay);
	}
	/**
	* One poll cycle.
	*
	* Re-entrancy is guarded: a slow cycle skips its next slot instead of
	* stacking up requests the target cannot answer any faster.
	*/
	async tick() {
		if (this.busy) return;
		const tcl = this.tcl;
		if (tcl === void 0 || this.bindings.length === 0) return;
		this.busy = true;
		try {
			const values = await this.readAll(tcl);
			this.polls += 1;
			if (Object.keys(values).length > 0) this.emit("samples", [{
				ts: Date.now(),
				values
			}]);
			this.emit("status", this.status());
		} catch (error) {
			this.failures += 1;
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit("error", err);
			this.emit("status", {
				kind: "error",
				message: err.message
			});
		} finally {
			this.busy = false;
		}
	}
	/** Read every binding, honouring batching and the consistency check. */
	async readAll(tcl) {
		const batches = planReadBatches(this.bindings, this.options.batchDistanceBytes);
		const values = {};
		for (const batch of batches) {
			const first = await tcl.readWords(batch.base, batch.words);
			let second;
			if (this.options.verifyConsistency) second = await tcl.readWords(batch.base, batch.words);
			for (const member of batch.members) try {
				const value = decodeBinding(first, member.offset, member.binding);
				if (second !== void 0) {
					if (!sameValue(value, decodeBinding(second, member.offset, member.binding))) {
						this.tornDropped += 1;
						continue;
					}
				}
				values[member.binding.name] = value;
			} catch {
				this.failures += 1;
			}
		}
		return values;
	}
};
/** NaN-aware equality (a float read that stays NaN is stable, not torn). */
function sameValue(a, b) {
	if (typeof a === "boolean" || typeof b === "boolean") return a === b;
	if (Number.isNaN(a) && Number.isNaN(b)) return true;
	return a === b;
}
/** Conventional port for the log RTT server. */
const DEFAULT_LOG_PORT = 9090;
/** Conventional port for the variable RTT server. */
const DEFAULT_VARIABLE_PORT = 9091;
/** Conventional OpenOCD TCL port. */
const DEFAULT_TCL_PORT = 6666;
/** Default GDB server port for the J-Link backend. */
const DEFAULT_JLINK_GDB_PORT = 2331;
/** Default J-Link RTT TELNET port (SEGGER's documented default). */
const DEFAULT_JLINK_RTT_TELNET_PORT = 19021;
/** A generic starting profile.
*
* Absolutely no chip-specific values: the address/size pair is merely the
* common `.data`/`.bss` region on a 32-bit part, and the user is expected to
* adjust all three RTT fields for their target.
*/
function createDefaultProfile(id = "default", name = "Default") {
	return {
		id,
		name,
		driver: "openocd",
		openocd: {
			mode: "auto",
			configPath: "",
			executable: "openocd",
			extraCommands: [],
			adapterSpeedKhz: 0,
			tclPort: DEFAULT_TCL_PORT,
			startupTimeoutMs: 6e3,
			autoRestart: true
		},
		jlink: {
			executable: "",
			device: "",
			targetInterface: "SWD",
			speedKhz: 0,
			gdbPort: DEFAULT_JLINK_GDB_PORT,
			rttTelnetPort: DEFAULT_JLINK_RTT_TELNET_PORT,
			serial: "",
			keepTargetRunning: true,
			autoStart: true,
			extraArgs: [],
			startupTimeoutMs: 8e3
		},
		rtt: {
			address: 536870912,
			size: 4096,
			idString: "SEGGER RTT"
		},
		log: {
			enabled: true,
			maxLines: 5e3,
			binding: {
				port: DEFAULT_LOG_PORT,
				channel: 0,
				enabled: true
			}
		},
		variables: {
			enabled: true,
			sampleRateHz: 10,
			retentionMinutes: 10,
			maxPointsPerSeries: 1e5,
			binding: {
				port: DEFAULT_VARIABLE_PORT,
				channel: 1,
				enabled: true
			},
			parser: {
				id: "csv",
				options: {}
			}
		},
		ocd: {
			enabled: false,
			elfPath: "",
			nmPath: "arm-none-eabi-nm",
			intervalMs: 100,
			verifyConsistency: true,
			batchDistanceBytes: 64,
			variables: []
		}
	};
}
function createDefaultConfig() {
	return {
		activeProfile: "default",
		profiles: [createDefaultProfile()]
	};
}
/**
* Upgrade a configuration document written by an older release.
*
* Profiles persisted before the J-Link backend existed carry neither `driver`
* nor `jlink`. Seeding them here — rather than defaulting at every read site —
* keeps a saved profile self-describing and makes the migration happen exactly
* once, on load, without discarding anything the user configured.
*
* @param raw - whatever was stored, trusted only as `unknown`.
* @returns the same document with the new fields filled in.
*/
function migrateConfig(raw) {
	if (typeof raw !== "object" || raw === null) return raw;
	const doc = raw;
	const profiles = doc["profiles"];
	if (!Array.isArray(profiles)) return raw;
	const fresh = createDefaultProfile();
	for (const entry of profiles) {
		if (typeof entry !== "object" || entry === null) continue;
		const profile = entry;
		if (profile["driver"] !== "openocd" && profile["driver"] !== "jlink") profile["driver"] = fresh.driver;
		if (typeof profile["jlink"] !== "object" || profile["jlink"] === null) profile["jlink"] = structuredClone(fresh.jlink);
		else {
			const jlink = profile["jlink"];
			for (const [key, value] of Object.entries(fresh.jlink)) if (jlink[key] === void 0) jlink[key] = structuredClone(value);
		}
	}
	return doc;
}
/**
* Find the active profile, falling back to the first one.
* @throws when the configuration holds no profiles at all.
*/
function activeProfileOf(config) {
	const found = config.profiles.find((p) => p.id === config.activeProfile);
	if (found !== void 0) return found;
	const first = config.profiles[0];
	if (first === void 0) throw new Error("configuration holds no device profiles");
	return first;
}
/** The default tool locations, taken from the generic profile. */
function defaultToolPaths() {
	const profile = createDefaultProfile();
	return {
		openocdExecutable: profile.openocd.executable,
		jlinkExecutable: profile.jlink.executable,
		nmPath: profile.ocd.nmPath
	};
}
/**
* Extract the machine-wide tool paths from a configuration document.
*
* Reads from the active profile, because that is where the user edited them.
*/
function extractToolPaths(config) {
	let profile;
	try {
		profile = activeProfileOf(config);
	} catch {
		return defaultToolPaths();
	}
	return {
		openocdExecutable: profile.openocd.executable,
		jlinkExecutable: profile.jlink.executable,
		nmPath: profile.ocd.nmPath
	};
}
/**
* Apply machine-wide tool paths from the global layer onto a configuration.
*
* The global layer always wins for these three fields: they are not part of the
* project, so a stale value left in a repository's `.dsh/rtt-debug.json` must
* not override the paths this machine actually has.
*
* @returns a new document; the input is not mutated.
*/
function applyToolPaths(config, paths) {
	const next = structuredClone(config);
	const resolved = {
		...defaultToolPaths(),
		...paths ?? {}
	};
	for (const profile of next.profiles) {
		profile.openocd.executable = resolved.openocdExecutable;
		profile.jlink.executable = resolved.jlinkExecutable;
		profile.ocd.nmPath = resolved.nmPath;
	}
	return next;
}
/**
* Restore the machine-wide fields to their generic defaults.
*
* Used when writing the PROJECT layer: the workspace document should describe
* the target only, so the three tool locations — which belong to the computer —
* are reset to the generic defaults rather than left at this machine's absolute
* paths. Writing them back to defaults (not deleting them) keeps the file a
* complete, self-validating `PluginConfig` that reads sensibly on its own.
*/
function stripToolPaths(config) {
	const next = structuredClone(config);
	const defaults = defaultToolPaths();
	for (const profile of next.profiles) {
		profile.openocd.executable = defaults.openocdExecutable;
		profile.jlink.executable = defaults.jlinkExecutable;
		profile.ocd.nmPath = defaults.nmPath;
	}
	return next;
}
/**
* Validate a configuration document. *
* Called on every load and on every update so a malformed profile (impossible
* port, mismatched channel roles) is rejected at the boundary rather than
* producing a confusing runtime failure later.
*
* @returns a list of human-readable problems; empty means valid.
*/
function validateConfig(config) {
	const problems = [];
	if (typeof config !== "object" || config === null) return ["configuration must be an object"];
	const profiles = config["profiles"];
	if (!Array.isArray(profiles) || profiles.length === 0) {
		problems.push("profiles must be a non-empty array");
		return problems;
	}
	const seenIds = /* @__PURE__ */ new Set();
	for (const [i, raw] of profiles.entries()) {
		if (typeof raw !== "object" || raw === null) {
			problems.push(`profiles[${i}] must be an object`);
			continue;
		}
		const p = raw;
		const id = p["id"];
		if (typeof id !== "string" || id === "") problems.push(`profiles[${i}].id must be a non-empty string`);
		else if (seenIds.has(id)) problems.push(`profiles[${i}].id "${id}" is duplicated`);
		else seenIds.add(id);
		const log = p["log"];
		const vars = p["variables"];
		const logBinding = log?.["binding"];
		const varBinding = vars?.["binding"];
		for (const [label, binding] of [["log", logBinding], ["variables", varBinding]]) {
			if (binding === void 0) {
				problems.push(`profiles[${i}].${label}.binding is required`);
				continue;
			}
			const port = binding["port"];
			if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) problems.push(`profiles[${i}].${label}.binding.port must be an integer in 1..65535`);
			const channel = binding["channel"];
			if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 0) problems.push(`profiles[${i}].${label}.binding.channel must be a non-negative integer`);
		}
		if (logBinding !== void 0 && varBinding !== void 0) {
			if (logBinding["port"] === varBinding["port"]) problems.push(`profiles[${i}]: log and variables must not share a TCP port`);
			if (logBinding["channel"] === varBinding["channel"]) problems.push(`profiles[${i}]: log and variables must use different RTT channels`);
		}
		const ocd = p["ocd"];
		const interval = ocd?.["intervalMs"];
		if (ocd !== void 0 && (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0)) problems.push(`profiles[${i}].ocd.intervalMs must be a positive number`);
		const driver = p["driver"];
		if (driver !== void 0 && driver !== "openocd" && driver !== "jlink") problems.push(`profiles[${i}].driver must be "openocd" or "jlink"`);
		const jlink = p["jlink"];
		if (driver === "jlink" || jlink !== void 0) {
			if (jlink === void 0) problems.push(`profiles[${i}].jlink is required when driver is "jlink"`);
			else {
				const gdbPort = jlink["gdbPort"];
				if (typeof gdbPort !== "number" || !Number.isInteger(gdbPort) || gdbPort < 1 || gdbPort > 65535) problems.push(`profiles[${i}].jlink.gdbPort must be an integer in 1..65535`);
				const telnetPort = jlink["rttTelnetPort"];
				if (typeof telnetPort !== "number" || !Number.isInteger(telnetPort) || telnetPort < 1 || telnetPort > 65535) problems.push(`profiles[${i}].jlink.rttTelnetPort must be an integer in 1..65535`);
				if (gdbPort === telnetPort) problems.push(`profiles[${i}].jlink: the GDB port and the RTT TELNET port must differ`);
				const iface = jlink["targetInterface"];
				if (iface !== void 0 && iface !== "SWD" && iface !== "JTAG") problems.push(`profiles[${i}].jlink.targetInterface must be "SWD" or "JTAG"`);
				const speed = jlink["speedKhz"];
				if (speed !== void 0 && (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0)) problems.push(`profiles[${i}].jlink.speedKhz must be zero or a positive number`);
				const args = jlink["extraArgs"];
				if (args !== void 0 && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) problems.push(`profiles[${i}].jlink.extraArgs must be an array of strings`);
			}
			if (driver === "jlink" && typeof jlink?.["device"] === "string" && jlink["device"].trim() === "") problems.push(`profiles[${i}].jlink.device is required when driver is "jlink"`);
		}
		const variables = ocd?.["variables"];
		if (ocd !== void 0 && variables !== void 0) {
			if (!Array.isArray(variables)) problems.push(`profiles[${i}].ocd.variables must be an array`);
			else for (const [j, v] of variables.entries()) {
				if (typeof v !== "object" || v === null) {
					problems.push(`profiles[${i}].ocd.variables[${j}] must be an object`);
					continue;
				}
				const entry = v;
				const source = entry["source"];
				if (source !== "symbol" && source !== "manual") problems.push(`profiles[${i}].ocd.variables[${j}].source must be "symbol" or "manual"`);
				if (source === "symbol" && typeof entry["symbol"] !== "string") problems.push(`profiles[${i}].ocd.variables[${j}].symbol is required for source "symbol"`);
				if (source === "manual" && typeof entry["address"] !== "number") problems.push(`profiles[${i}].ocd.variables[${j}].address is required for source "manual"`);
			}
		}
	}
	return problems;
}
// src/service.ts
/**
* The plugin's host-side service: owns the three data sources and the state the
* browser reads.
*
* Source lifecycle is deliberately independent (spec G2): any subset can run,
* so a user can watch only the log, only RTT variables, only memory variables,
* or any combination. Nothing here assumes the others are up.
*
* The log path carries the spec's completeness requirement (D20/A16): bytes are
* decoded to lines and pushed into the ring synchronously, with no awaiting in
* between, so a slow consumer cannot cause a dropped line. The received-count
* counter is what makes that claim checkable rather than aspirational.
*/
/** How often batched log/series pushes leave the host. */
const FLUSH_INTERVAL_MS = 100;
var DebugService = class extends EventEmitter {
	config = createDefaultConfig();
	profile = activeProfileOf(this.config);
	workspaceRoot;
	logStore = new LogStore();
	seriesStore = new SeriesStore();
	registry = createDefaultRegistry();
	ocdReader;
	ocdReaderInstance;
	openocd;
	jlinkManager;
	jlinkReaderInstance;
	/** J-Link TELNET links, one per RTT channel (only when driver is `jlink`). */
	jlinkLogLink;
	jlinkVariableLink;
	/**
	* Set when J-Link closed one TELNET channel while another was alive.
	*
	* SEGGER does not document multi-client support on the RTT TELNET port, so
	* this records the observed verdict for the UI instead of retrying a channel
	* that cannot work.
	*/
	jlinkChannelConflict;
	logLink;
	variableLink;
	logSplitter = new LineSplitter();
	ansi = new AnsiDecoder();
	provider = this.registry.create("csv");
	logReceived = 0;
	variableReceived = 0;
	pendingLog = [];
	pendingSamples = [];
	flushTimer;
	running = false;
	constructor(workspaceRoot) {
		super();
		this.workspaceRoot = workspaceRoot;
		this.ocdReader = void 0;
	}
	getConfig() {
		return structuredClone(this.config);
	}
	/**
	* Replace the configuration.
	* @throws when the document is malformed — an invalid profile is refused at
	*   the boundary instead of failing later inside a poll cycle.
	*/
	setConfig(config) {
		const problems = validateConfig(config);
		if (problems.length > 0) throw new Error(`invalid configuration: ${problems.join("; ")}`);
		const previousDriver = this.profile.driver;
		this.config = structuredClone(config);
		this.profile = activeProfileOf(this.config);
		this.applyProfile();
		if (this.running && previousDriver !== this.profile.driver) {
			this.stop();
			this.emitState();
			return;
		}
		this.reconcileOcdReader();
		this.emitState();
	}
	/**
	* Bring the OCD reader in line with `ocd.enabled` while the service is running.
	*
	* `applyProfile()` only refreshes the bindings of a reader that ALREADY exists,
	* so flipping `ocd.enabled` from false to true after a run had started used to
	* change nothing observable — the user's new variables looked saved but were
	* never sampled. This closes that path:
	*
	*   - enabled + no reader  → start one now, so the saved bindings take effect;
	*   - disabled + a reader  → stop it, so the switch really switches off;
	*   - enabled + a reader   → nothing to do (applyProfile already re-bound it).
	*
	* It is a no-op while stopped: `start()` owns the initial reader lifecycle, and
	* that is also the state in which the UI tells the user to press Start.
	*/
	reconcileOcdReader() {
		if (!this.running) return;
		if (this.profile.driver === "jlink") {
			const jreader = this.jlinkReaderInstance;
			if (!this.profile.ocd.enabled) {
				if (jreader === void 0) return;
				jreader.stop();
				this.jlinkReaderInstance = void 0;
				return;
			}
			if (jreader !== void 0) return;
			this.startJLinkReader().catch(() => {
				this.jlinkReaderInstance = void 0;
				this.emitState();
			});
			return;
		}
		const reader = this.ocdReaderInstance;
		if (!this.profile.ocd.enabled) {
			if (reader === void 0) return;
			reader.stop();
			this.ocdReaderInstance = void 0;
			return;
		}
		if (reader !== void 0) return;
		this.startOcd().catch(() => {
			this.ocdReaderInstance = void 0;
			this.emitState();
		});
	}
	setActiveProfile(id) {
		const next = structuredClone(this.config);
		if (!next.profiles.some((p) => p.id === id)) throw new Error(`unknown device profile "${id}"`);
		next.activeProfile = id;
		this.setConfig(next);
	}
	/** The profile currently in force. */
	getProfile() {
		return structuredClone(this.profile);
	}
	setWorkspaceRoot(root) {
		this.workspaceRoot = root;
		this.openocd?.setWorkspaceRoot(root);
		this.jlinkManager?.setWorkspaceRoot(root);
	}
	/** Read the current workspace root directory (session cwd, or process.cwd() fallback). */
	getWorkspaceRoot() {
		return this.workspaceRoot;
	}
	/**
	* Resolve a workspace-relative path (such as `elfPath`) against the current
	* workspace root, matching `OpenOcdManager.resolveConfigPath`.
	* Absolute paths are returned verbatim.
	*/
	resolveWorkspacePath(targetPath) {
		const trimmed = targetPath.trim();
		if (trimmed === "") return "";
		return isAbsolute(trimmed) ? trimmed : resolve(this.workspaceRoot, trimmed);
	}
	/** Re-apply the active profile's limits and parser without a restart. */
	applyProfile() {
		this.logStore.configure({ maxLines: this.profile.log.maxLines });
		this.seriesStore.configure({
			sampleRateHz: this.profile.variables.sampleRateHz,
			retentionMs: this.profile.variables.retentionMinutes * 6e4,
			maxPointsPerSeries: this.profile.variables.maxPointsPerSeries
		});
		if (this.provider.id !== this.profile.variables.parser.id) this.provider = this.registry.create(this.profile.variables.parser.id);
		this.provider.configure(this.profile.variables.parser.options);
		this.ocdReaderInstance?.setBindings(this.computeOcdBindings());
	}
	/** Parser registry, so a caller can register an extra parser. */
	/** Start the enabled sources. Idempotent. */
	async start() {
		if (this.running) return;
		this.running = true;
		this.applyProfile();
		if (this.profile.driver === "jlink") {
			await this.startJLinkBackend();
			return;
		}
		await this.startOpenOcdBackend();
	}
	/**
	* Bring up OpenOCD and the two TCP links it provides.
	*
	* OpenOCD forwards each RTT channel on its own `rtt server start` port, so the
	* two sources are two ports on the same host.
	*/
	async startOpenOcdBackend() {
		if (this.openocd === void 0) {
			this.openocd = new OpenOcdManager(this.workspaceRoot);
			this.openocd.on("status", () => this.emitState());
		}
		const status = await this.openocd.start(this.profile);
		this.emitState();
		if (status.kind === "error") {
			this.running = false;
			return;
		}
		if (this.profile.log.enabled) this.openLogLink();
		if (this.profile.variables.enabled) this.openVariableLink();
		if (this.profile.ocd.enabled) await this.startOcd();
		this.startFlusher();
		this.emitState();
	}
	/**
	* Bring up SEGGER's J-Link software and the transports it provides.
	*
	* The shape differs from OpenOCD in one important way: J-Link gives ONE
	* TELNET port for every RTT channel, so the two sources are two CONNECTIONS to
	* the same port, each selecting its channel with the `$$SEGGER_TELNET_
	* ConfigStr$$` selector. Memory reads do not use the TELNET port at all —
	* they go through the GDB server.
	*/
	async startJLinkBackend() {
		this.jlinkChannelConflict = void 0;
		if (this.jlinkManager === void 0) {
			this.jlinkManager = new JLinkManager(this.workspaceRoot);
			this.jlinkManager.on("status", () => this.emitState());
		}
		const status = await this.jlinkManager.start(this.profile);
		this.emitState();
		if (status.kind === "error") {
			this.running = false;
			return;
		}
		if (this.profile.log.enabled) this.openJLinkLogLink();
		if (this.profile.variables.enabled) this.openJLinkVariableLink();
		if (this.profile.ocd.enabled) await this.startJLinkReader();
		this.startFlusher();
		this.emitState();
	}
	/** Stop every source but keep backend process ownership intact. */
	async stop() {
		this.running = false;
		this.stopFlusher();
		this.logLink?.dispose();
		this.logLink = void 0;
		this.variableLink?.dispose();
		this.variableLink = void 0;
		this.jlinkLogLink?.dispose();
		this.jlinkLogLink = void 0;
		this.jlinkVariableLink?.dispose();
		this.jlinkVariableLink = void 0;
		this.ocdReaderInstance?.stop();
		this.ocdReaderInstance = void 0;
		this.jlinkReaderInstance?.stop();
		this.jlinkReaderInstance = void 0;
		await this.openocd?.stop();
		await this.jlinkManager?.stop();
		this.emitState();
	}
	/** Release everything, including the backend process this plugin spawned. */
	async dispose() {
		await this.stop();
		this.openocd?.removeAllListeners();
		this.openocd = void 0;
		this.jlinkManager?.removeAllListeners();
		this.jlinkManager = void 0;
	}
	isRunning() {
		return this.running;
	}
	openLogLink() {
		const link = new TcpLink({
			host: "127.0.0.1",
			port: this.profile.log.binding.port,
			overflowPolicy: "pause",
			maxBufferedBytes: 16777216
		});
		this.logLink = link;
		link.on("data", (chunk) => {
			for (const raw of this.logSplitter.push(chunk)) {
				const spans = this.ansi.push(raw);
				const text = spans.map((s) => s.text).join("");
				const record = this.logStore.push({
					ts: Date.now(),
					text,
					spans,
					level: detectLevel(text)
				});
				this.pendingLog.push(record);
				this.logReceived += 1;
			}
		});
		link.on("status", (status) => {
			if (status.kind === "open") this.ansi.reset();
			this.emitState();
		});
		link.on("error", () => this.emitState());
		link.connect();
	}
	openVariableLink() {
		const link = new TcpLink({
			host: "127.0.0.1",
			port: this.profile.variables.binding.port,
			overflowPolicy: "drop-oldest",
			maxBufferedBytes: 4194304
		});
		this.variableLink = link;
		link.on("data", (chunk) => {
			let samples;
			try {
				samples = this.provider.feed(chunk);
			} catch {
				return;
			}
			if (samples.length === 0) return;
			this.variableReceived += samples.length;
			this.ingest(samples);
		});
		link.on("status", () => this.emitState());
		link.on("error", () => this.emitState());
		link.connect();
	}
	/**
	* Open the log channel through J-Link's TELNET port.
	*
	* No `drop-oldest` policy exists here: `JLinkTelnet` does not buffer on the
	* plugin side at all — the socket handler decodes lines synchronously — so a
	* slow consumer pauses the socket through the kernel rather than losing a
	* line, which is the same guarantee the OpenOCD path makes.
	*/
	openJLinkLogLink() {
		const link = new JLinkTelnet({
			host: "127.0.0.1",
			port: this.profile.jlink.rttTelnetPort,
			channel: this.profile.log.binding.channel,
			...this.jlinkRttSearchOptions()
		});
		this.jlinkLogLink = link;
		link.on("data", (chunk) => {
			for (const raw of this.logSplitter.push(chunk)) {
				const spans = this.ansi.push(raw);
				const text = spans.map((s) => s.text).join("");
				const record = this.logStore.push({
					ts: Date.now(),
					text,
					spans,
					level: detectLevel(text)
				});
				this.pendingLog.push(record);
				this.logReceived += 1;
			}
		});
		link.on("status", (status) => {
			if (status.kind === "open") this.ansi.reset();
			this.emitState();
		});
		link.on("error", () => this.emitState());
		link.on("dropped", (info) => this.noteJLinkDrop(info, "log"));
		link.connect();
	}
	openJLinkVariableLink() {
		const link = new JLinkTelnet({
			host: "127.0.0.1",
			port: this.profile.jlink.rttTelnetPort,
			channel: this.profile.variables.binding.channel,
			...this.jlinkRttSearchOptions()
		});
		this.jlinkVariableLink = link;
		link.on("data", (chunk) => {
			let samples;
			try {
				samples = this.provider.feed(chunk);
			} catch {
				return;
			}
			if (samples.length === 0) return;
			this.variableReceived += samples.length;
			this.ingest(samples);
		});
		link.on("status", () => this.emitState());
		link.on("error", () => this.emitState());
		link.on("dropped", (info) => this.noteJLinkDrop(info, "variables"));
		link.connect();
	}
	/**
	* Interpret a dropped J-Link TELNET connection honestly.
	*
	* SEGGER does not document whether its RTT TELNET port accepts several
	* simultaneous clients, and the two official forum answers on multi-channel
	* access predate the per-connection `RTTCh` selector. So the failure modes are
	* real and must be distinguishable at the UI:
	*
	*   - a channel that connected, then dropped WITHOUT ever delivering a byte —
	*     while another channel on the same port is alive — is the signature of
	*     "this J-Link accepts one TELNET client at a time". Retrying is useless
	*     and hides the cause, so the channel is stopped and the reason recorded;
	*   - anything else (a byte was seen, or the log channel is also down) is an
	*     ordinary network/backend event and stays on the automatic retry path.
	*/
	noteJLinkDrop(info, which) {
		if (info.hadData) return;
		if (!((which === "log" ? this.jlinkVariableLink : this.jlinkLogLink)?.getStatus().kind === "open")) return;
		this.jlinkChannelConflict = `channel ${info.channel}: J-Link closed the connection without sending data, while the other RTT channel is connected. This J-Link appears to serve one TELNET channel at a time.`;
		if (which === "variables") {
			this.jlinkVariableLink?.close("J-Link refused a second RTT channel");
			this.jlinkVariableLink = void 0;
		} else {
			this.jlinkLogLink?.close("J-Link refused a second RTT channel");
			this.jlinkLogLink = void 0;
		}
		this.emitState();
	}
	/**
	* The control-block selector shared by both J-Link TELNET links.
	*
	* The profile carries a search address AND a size, which is exactly what
	* SEGGER's `SetRTTSearchRanges` wants as one `"<start> <size>"` string, so the
	* configured range is forwarded rather than silently falling back to J-Link's
	* default search.
	*/
	jlinkRttSearchOptions() {
		const { rtt } = this.profile;
		if (rtt.address > 0 && rtt.size > 0) return { rttSearchRange: `${`0x${(rtt.address >>> 0).toString(16)}`} ${`0x${(rtt.size >>> 0).toString(16)}`}` };
		return {};
	}
	computeOcdBindings() {
		const out = [];
		for (const entry of this.profile.ocd.variables) {
			if (entry.source === "symbol") {
				if (entry.address === void 0) continue;
				const binding = {
					name: entry.name ?? entry.symbol ?? `0x${(entry.address >>> 0).toString(16)}`,
					address: entry.address,
					type: entry.type ?? "u32"
				};
				out.push(entry.unit === void 0 ? binding : {
					...binding,
					unit: entry.unit
				});
				continue;
			}
			if (entry.address === void 0) continue;
			const binding = {
				name: entry.name ?? `0x${(entry.address >>> 0).toString(16)}`,
				address: entry.address,
				type: entry.type ?? "u32"
			};
			out.push(entry.unit === void 0 ? binding : {
				...binding,
				unit: entry.unit
			});
		}
		return out;
	}
	async startOcd() {
		const bindings = this.computeOcdBindings();
		if (bindings.length === 0) return;
		const reader = new OcdReader({
			host: "127.0.0.1",
			port: this.profile.openocd.tclPort,
			intervalMs: this.profile.ocd.intervalMs,
			verifyConsistency: this.profile.ocd.verifyConsistency,
			batchDistanceBytes: this.profile.ocd.batchDistanceBytes
		});
		reader.setBindings(bindings);
		reader.on("samples", (samples) => {
			this.variableReceived += samples.length;
			this.ingest(samples);
		});
		reader.on("status", () => this.emitState());
		reader.on("error", () => this.emitState());
		this.ocdReaderInstance = reader;
		await reader.start();
	}
	/** The OCD reader's status, when it is running. */
	getOcdStatus() {
		return this.ocdReaderInstance?.status();
	}
	/** The J-Link memory reader's status, when it is running. */
	getJLinkReaderStatus() {
		return this.jlinkReaderInstance?.status();
	}
	async startJLinkReader() {
		const bindings = this.computeOcdBindings();
		if (bindings.length === 0) return;
		const reader = new JLinkReader({
			host: "127.0.0.1",
			port: this.profile.jlink.gdbPort,
			intervalMs: this.profile.ocd.intervalMs,
			verifyConsistency: this.profile.ocd.verifyConsistency,
			batchDistanceBytes: this.profile.ocd.batchDistanceBytes
		});
		reader.setBindings(bindings);
		reader.on("samples", (samples) => {
			this.variableReceived += samples.length;
			this.ingest(samples);
		});
		reader.on("status", () => this.emitState());
		reader.on("error", () => this.emitState());
		this.jlinkReaderInstance = reader;
		await reader.start();
	}
	/** Route samples into the series store and the transport batch. */
	ingest(samples) {
		this.seriesStore.append(samples);
		this.pendingSamples.push(...samples);
		for (const descriptor of this.provider.descriptors()) this.seriesStore.setMeta(descriptor.name, {
			kind: descriptor.kind,
			...descriptor.unit === void 0 ? {} : { unit: descriptor.unit }
		});
	}
	startFlusher() {
		if (this.flushTimer !== void 0) return;
		this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
		this.flushTimer.unref?.();
	}
	stopFlusher() {
		if (this.flushTimer !== void 0) {
			clearInterval(this.flushTimer);
			this.flushTimer = void 0;
		}
	}
	/** Push whatever accumulated since the last tick. */
	flush() {
		if (this.pendingLog.length > 0) {
			const batch = this.pendingLog;
			this.pendingLog = [];
			this.emit("log", batch);
		}
		if (this.pendingSamples.length > 0) {
			const batch = this.pendingSamples;
			this.pendingSamples = [];
			this.emit("series", batch);
		}
		this.emitState();
	}
	/** Everything retained, for a browser that just opened the panel. */
	snapshot() {
		return {
			log: this.logStore.entries(),
			total: this.logStore.totalIngested,
			series: this.seriesStore.all(),
			state: this.state()
		};
	}
	/** Status of whichever backend owns the connection. */
	backendStatus() {
		if (this.profile.driver === "jlink") return this.jlinkManager?.getStatus() ?? { kind: "idle" };
		return this.openocd?.getStatus() ?? { kind: "idle" };
	}
	state() {
		const series = this.seriesStore.all();
		const points = {};
		for (const s of series) points[s.name] = s.ts.length;
		const descriptors = [...this.provider.descriptors()];
		for (const s of series) if (!descriptors.some((d) => d.name === s.name)) descriptors.push({
			name: s.name,
			kind: s.kind,
			source: "ocd",
			...s.unit === void 0 ? {} : { unit: s.unit }
		});
		else if (s.unit !== void 0) {
			const found = descriptors.find((d) => d.name === s.name);
			if (found !== void 0 && found.unit === void 0) found.unit = s.unit;
		}
		return {
			openocd: this.backendStatus(),
			driver: this.profile.driver,
			sources: this.sourceStates(),
			log: {
				retained: this.logStore.entries().length,
				total: this.logStore.totalIngested
			},
			series: {
				names: series.map((s) => s.name),
				points
			},
			descriptors,
			profiles: this.config.profiles.map((p) => ({
				id: p.id,
				name: p.name
			})),
			activeProfile: this.profile.id,
			...this.jlinkChannelConflict === void 0 ? {} : { jlinkNotice: this.jlinkChannelConflict }
		};
	}
	sourceStates() {
		const linkState = (link) => {
			const status = link?.getStatus();
			if (status === void 0) return { state: "idle" };
			if (status.kind === "closed") return {
				state: "closed",
				detail: status.reason
			};
			if (status.kind === "reconnecting") return {
				state: "reconnecting",
				detail: `attempt ${status.attempt}, retrying in ${status.delayMs} ms`
			};
			return { state: status.kind };
		};
		const log = linkState(this.logLink);
		const variables = linkState(this.variableLink);
		return [
			{
				id: "log",
				enabled: this.profile.log.enabled,
				state: log.state,
				...log.detail === void 0 ? {} : { detail: log.detail },
				received: this.logReceived
			},
			{
				id: "rttVar",
				enabled: this.profile.variables.enabled,
				state: variables.state,
				...variables.detail === void 0 ? {} : { detail: variables.detail },
				received: this.variableReceived
			},
			{
				id: "ocd",
				enabled: this.profile.ocd.enabled,
				state: this.ocdReaderInstance === void 0 ? "idle" : this.ocdReaderInstance.status().kind,
				received: this.ocdSampleCount
			}
		];
	}
	ocdSampleCount = 0;
	getOcdSampleCount() {
		return this.ocdSampleCount;
	}
	/** Clear retained data; the completeness counters keep counting (A16). */
	clear(what) {
		if (what === "log" || what === "all") {
			this.logStore.clear();
			this.logSplitter.reset();
		}
		if (what === "series" || what === "all") this.seriesStore.clear();
		this.emit("clear", what);
		this.emitState();
	}
	/** Export retained log lines as text. */
	exportLog() {
		return this.logStore.toText((ts) => new Date(ts).toISOString());
	}
	emitState() {
		this.emit("state", this.state());
	}
};
/** Validate a config document without applying it (used by the routes layer). */
function checkConfig(config) {
	return validateConfig(config);
}
// src/index.ts
const name = "dsh-rtt-debug";
/**
* This plugin's own loader-entry id, which is also how the profile patch keys
* its configuration (`- id: dsh-rtt-debug`). `configEditor` addresses the entry
* by this id, so persistence depends on the two staying in sync.
*/
const PLUGIN_ID = name;
/** Services this plugin needs before it can mount. */
const inject = ["webServer", "sessions"];
/** Route prefix, kept in one place so the client and host cannot drift. */
const ROUTE_PREFIX = "/api/rtt-debug";
/** Config namespace used with the settings face, when one is installed. */
const SETTINGS_NAMESPACE = "dsh-rtt-debug";
function apply(ctx) {
	const service = new DebugService(process.cwd());
	/**
	* A registration failure that leaves persistence unusable.
	*
	* Kept separate from `settingsRef` so `/config` can report "the change is live
	* but will not survive a restart" rather than reporting a clean save. Set only
	* by a non-recoverable `register` failure.
	*/
	let settingsError;
	/**
	* Resolves once the stored configuration has either been applied or been found
	* to be unavailable.
	*
	* The routes are registered synchronously inside the effect below, but the
	* stored configuration is applied from the injecting body, which runs later.
	* Measured: on a fresh boot a `/config` request can arrive in that window and
	* is then served the DEFAULTS (`intervalMs: 100`, empty `elfPath`). That is
	* indistinguishable from persistence being broken, and the t14 restart check
	* reads exactly once — so the window has to be closed rather than raced.
	*
	* Resolved on every exit path (service present, service absent, timeout) so a
	* request can never wait forever on it.
	*/
	let persistenceReady = () => {};
	const ready = new Promise((resolve) => {
		persistenceReady = resolve;
	});
	const readyDeadline = setTimeout(persistenceReady, 1e3);
	const releaseReady = () => {
		clearTimeout(readyDeadline);
		persistenceReady();
	};
	ctx.effect(() => {
		const disposers = [];
		/**
		* Write the live configuration through whichever backend this host provides.
		*
		* One function for every call site — the immediate `/config` write and the
		* teardown flush — so the two can never drift onto different backends.
		*/
		const persistNow = async () => {
			switch (persistence.kind) {
				case "editor": return persistViaEditor(persistence.editor, service);
				case "settings": return persistConfig(persistence.settings, service);
				default: return settingsError ?? "no configuration persistence is available on this host (neither configEditor nor settings.update)";
			}
		};
		disposers.push(ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: async (req, res) => {
				if (!isTrusted(req)) return send(res, 403, { error: "forbidden" });
				try {
					await handleRoute(ctx, service, persistNow, () => settingsError, ready, req, res);
				} catch (error) {
					send(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		}));
		const logSockets = /* @__PURE__ */ new Set();
		const seriesSockets = /* @__PURE__ */ new Set();
		const broadcast = (set, payload) => {
			if (set.size === 0) return;
			const text = JSON.stringify(payload);
			for (const socket of set) if (socket.readyState === 1) socket.send(text);
		};
		const onLog = (records) => broadcast(logSockets, {
			type: "log",
			records
		});
		const onSeries = (samples) => broadcast(seriesSockets, {
			type: "series",
			samples
		});
		const onState = (state) => {
			broadcast(logSockets, {
				type: "state",
				state
			});
			broadcast(seriesSockets, {
				type: "state",
				state
			});
		};
		const onClear = (what) => {
			broadcast(logSockets, {
				type: "clear",
				what
			});
			broadcast(seriesSockets, {
				type: "clear",
				what
			});
		};
		service.on("log", onLog);
		service.on("series", onSeries);
		service.on("state", onState);
		service.on("clear", onClear);
		disposers.push(() => {
			service.off("log", onLog);
			service.off("series", onSeries);
			service.off("state", onState);
			service.off("clear", onClear);
		});
		const attach = (set, req, socket, head) => {
			if (!isTrusted(req)) {
				socket.destroy();
				return;
			}
			const ws = acceptWebSocket(req, socket);
			if (ws === void 0) {
				socket.destroy();
				return;
			}
			set.add(ws);
			ws.send(JSON.stringify({
				type: "state",
				state: service.state()
			}));
			const heartbeat = setInterval(() => ws.ping(), 3e4);
			heartbeat.unref?.();
			ws.on("close", () => {
				clearInterval(heartbeat);
				set.delete(ws);
			});
			ws.on("error", () => {
				clearInterval(heartbeat);
				set.delete(ws);
			});
		};
		disposers.push(ctx.webServer.registerUpgrade({
			path: `${ROUTE_PREFIX}/ws/log`,
			handler: (req, socket, head) => attach(logSockets, req, socket, head)
		}));
		disposers.push(ctx.webServer.registerUpgrade({
			path: `${ROUTE_PREFIX}/ws/series`,
			handler: (req, socket, head) => attach(seriesSockets, req, socket, head)
		}));
		let persistence = { kind: "none" };
		/**
		* Whether this settings face is the 0.1.x generation.
		*
		* The discriminator is `register` ALONE. `update` is NOT a signal: 0.2.x
		* still exposes `update`/`write` for editing a plugin's own volatile Config,
		* so testing for it made this file mistake the newer service for the older
		* one and skip `configEditor` entirely — which is exactly how configuration
		* stopped being persisted while every call still reported success.
		*/
		const isLegacySettings = (face) => typeof face.register === "function";
		const setupPersistence = (settings, child) => {
			if (!isLegacySettings(settings)) {
				if (persistence.kind === "none") settingsError = void 0;
				return;
			}
			try {
				settings.register?.(SETTINGS_NAMESPACE, resolveStoredConfig);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("already registered")) {
					settingsError = message;
					return;
				}
			}
			persistence = {
				kind: "settings",
				settings
			};
			const saved = readStoredConfig(settings);
			if (saved !== void 0) try {
				service.setConfig(saved);
			} catch {}
			child.effect(() => {
				return () => persistConfig(settings, service);
			}, "dsh-rtt-debug: persist settings on teardown");
		};
		/**
		* DSH 0.2.x persistence: bind to `configEditor` and adopt this entry's
		* Config as the live configuration.
		*
		* The entry is identified by the plugin's own id, which is what the profile
		* patch keys it under (see `cordis.patch.yml`: `- id: dsh-rtt-debug`).
		*/
		const setupEditorPersistence = (editor) => {
			persistence = {
				kind: "editor",
				editor
			};
			try {
				const entry = findOwnEntry(editor);
				if (entry === void 0) return;
				const configured = migrateConfig(entry.options.config);
				if (configured !== void 0 && checkConfig(configured).length === 0) try {
					service.setConfig(configured);
				} catch {}
			} catch {}
		};
		const injected = ctx.inject;
		if (typeof injected === "function") {
			injected.call(ctx, ["configEditor"], (child) => {
				const editor = child.get("configEditor");
				if (editor === void 0) return;
				setupEditorPersistence(editor);
				releaseReady();
				child.effect(() => () => persistViaEditor(editor, service), "dsh-rtt-debug: persist config on teardown");
			});
			injected.call(ctx, ["settings"], (child) => {
				const settings = child.get("settings");
				try {
					if (settings !== void 0) setupPersistence(settings, child);
				} finally {
					releaseReady();
				}
			});
		} else {
			const settings = ctx.get("settings");
			if (settings !== void 0) setupPersistence(settings, ctx);
			releaseReady();
		}
		disposers.push(() => {
			service.dispose();
		});
		return () => {
			const ordered = [...disposers].reverse();
			let task;
			for (const dispose of ordered) task = task === void 0 ? Promise.resolve(dispose()).catch(() => void 0) : task.then(() => dispose()).catch(() => void 0);
			return task;
		};
	}, "dsh-rtt-debug: host routes");
}
/**
* Resolve this plugin's namespace value from the merged settings layer.
*
* Passed to `settings.register` and called by the provider with the composition
* base merged under the user's stored section. It must therefore tolerate
* anything the document may hold: an invalid or partial stored section falls back
* to the defaults rather than throwing, because a throw here fails the
* registration itself (and with it every later write).
*
* @param value - the merged layer; `{}` when nothing has been stored yet.
* @returns a configuration this plugin can run with, or undefined when the
*   stored document has no usable shape.
*/
function resolveStoredConfig(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const stored = value;
	if (stored.profiles === void 0 && stored.activeProfile === void 0) return void 0;
	const migrated = migrateConfig(value);
	return checkConfig(migrated).length === 0 ? migrated : void 0;
}
Object.assign(resolveStoredConfig, {
	type: "object",
	dict: {},
	toJSON: () => ({
		uid: 0,
		refs: { "0": {
			type: "object",
			meta: { default: {} },
			dict: {}
		} }
	})
});
/**
* Read this namespace's stored configuration through the real `get(ns)` seam.
*
* @param settings - the registered settings face.
* @returns the stored configuration, or undefined when nothing usable is stored.
*/
function readStoredConfig(settings) {
	if (typeof settings.get !== "function") return void 0;
	try {
		return resolveStoredConfig(settings.get(SETTINGS_NAMESPACE));
	} catch {
		return;
	}
}
/**
* Write the service's current configuration through to the settings face.
*
* Shared by the immediate `/config` write path and the teardown disposer so the
* two cannot drift. Two arguments, never one object: the real seam treats the
* first parameter as the namespace itself. A missing settings service is not an
* error: the plugin runs without one, and then configuration simply lives for the
* process lifetime.
*
* @param settings - the registered settings face, when one is present.
* @param service - the service whose configuration is persisted.
* @returns undefined on success (or when no settings face exists), else the
*   failure message — persistence must never fail a request whose configuration
*   change already succeeded in memory.
*/
async function persistConfig(settings, service) {
	if (settings === void 0) return void 0;
	if (typeof settings.update !== "function") return void 0;
	try {
		await settings.update(SETTINGS_NAMESPACE, service.getConfig());
		return;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
/** This plugin's own loader entry, as `configEditor` addresses it. */
function findOwnEntry(editor) {
	try {
		return editor.entries().find((entry) => entry.options.id === PLUGIN_ID || entry.options.name === PLUGIN_ID);
	} catch {
		return;
	}
}
/**
* Persist the live configuration through DSH 0.2.x's `configEditor`.
*
* `edit` is given a change function, not a value: the editor reconciles the
* current and inherited layers itself and validates the complete candidate, so
* returning the whole configuration is both the documented and the safe form —
* it cannot lose a field it did not know about, because it replaces the entry's
* section wholesale with what the service actually holds.
*
* @returns undefined on success, else the failure message. Persistence must
*   never fail a request whose configuration change already succeeded in memory.
*/
async function persistViaEditor(editor, service) {
	try {
		const entry = findOwnEntry(editor);
		if (entry === void 0) return `no profile entry "${PLUGIN_ID}" to persist into`;
		const config = service.getConfig();
		await editor.edit(entry, () => config);
		return;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
const WORKSPACE_CONFIG_REL = ".dsh/rtt-debug.json";
/**
* Read configuration saved specifically to this workspace (.dsh/rtt-debug.json).
* Allows project-level configuration to travel with the repository/session.
*/
async function readWorkspaceConfig(workspaceRoot) {
	try {
		const fullPath = join(workspaceRoot, WORKSPACE_CONFIG_REL);
		const text = await readFile(fullPath, "utf8");
		const migrated = migrateConfig(JSON.parse(text));
		if (checkConfig(migrated).length === 0) return migrated;
	} catch {}
}
/**
* Write the PROJECT layer: the workspace's `.dsh/rtt-debug.json`.
*
* Tool paths are pulled back to their generic defaults here — see `ToolPaths`.
* They are machine-wide facts living in the global layer, so a copy in the
* repository would be both redundant and actively harmful (it would ship one
* developer's absolute install paths to everyone).
*/
async function writeWorkspaceConfig(workspaceRoot, config) {
	try {
		const fullPath = join(workspaceRoot, WORKSPACE_CONFIG_REL);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, JSON.stringify(stripToolPaths(config), null, 2), "utf8");
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* Read the MACHINE-WIDE tool paths.
*
* They live in the plugin's global layer — on DSH 0.2.x that is this entry's
* `config` in the active profile patch, on 0.1.x it is the settings namespace.
* The caller passes the currently live configuration, which already holds
* whatever either layer supplied, so this only needs to identify the subset.
*/
function readToolPaths(config) {
	return extractToolPaths(config);
}
/**
* Scan workspace (and user desktop fallback) for candidate files (*.cfg, *.elf, etc.).
*/
async function discoverWorkspaceFiles(root, type) {
	const exts = type === "openocd" ? [".cfg"] : type === "elf" ? [
		".elf",
		".axf",
		".out"
	] : [
		".cfg",
		".elf",
		".axf",
		".out"
	];
	const results = [];
	const seen = /* @__PURE__ */ new Set();
	async function scan(dir, depth) {
		if (depth > 4) return;
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".") && entry.name !== ".dsh") continue;
				if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".verify") continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) await scan(full, depth + 1);
				else if (entry.isFile()) {
					const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop().toLowerCase() : "";
					if (exts.includes(ext) && !seen.has(full)) {
						seen.add(full);
						const rel = relative(root, full).replace(/\\/g, "/");
						results.push({
							path: full,
							relPath: rel,
							name: entry.name
						});
					}
				}
			}
		} catch {}
	}
	await scan(root, 0);
	return results;
}
/**
* Handle one request under the route prefix.
*
* @param ctx - plugin context (sessions, for the workspace root).
* @param service - the debug service backing every route.
* @param persistence - writes the live configuration to whichever backend this
*   host generation provides (DSH 0.2.x `configEditor`, or 0.1.x settings).
*   Passed as a function rather than a captured face because the backend appears
*   and disappears with the services' lifecycle, so a captured value would go
*   stale.
* @param settingsError - a registration failure that makes persistence unusable,
*   or undefined. Reported so a change is never presented as durable when it is
*   not.
* @param persistenceReady - resolves once the stored configuration has been
*   applied or found unavailable. Every read waits on it so a request that lands
*   during startup cannot be served the defaults (see `apply`).
* @param req - incoming request.
* @param res - response to write.
*/
async function handleRoute(ctx, service, persistence, settingsError, persistenceReady, req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname.slice(14);
	const method = (req.method ?? "GET").toUpperCase();
	await persistenceReady;
	const sessionId = url.searchParams.get("sessionId");
	if (sessionId !== null) {
		const cwd = ctx.sessions.get(sessionId)?.header.cwd;
		if (cwd !== void 0 && cwd !== "") service.setWorkspaceRoot(cwd);
		else service.setWorkspaceRoot(process.cwd());
	} else service.setWorkspaceRoot(process.cwd());
	if (method === "GET" && path === "/state") {
		send(res, 200, service.state());
		return;
	}
	if (method === "GET" && path === "/snapshot") {
		send(res, 200, service.snapshot());
		return;
	}
	if (method === "GET" && path === "/export") {
		const text = service.exportLog();
		res.statusCode = 200;
		res.setHeader("content-type", "text/plain; charset=utf-8");
		res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`rtt-log-${stamp()}.txt`)}`);
		res.end(text);
		return;
	}
	if (method === "GET" && path === "/fs/discover") {
		const type = url.searchParams.get("type") ?? "all";
		const root = service.getWorkspaceRoot();
		send(res, 200, {
			root,
			files: await discoverWorkspaceFiles(root, type)
		});
		return;
	}
	if (method === "GET" && path === "/fs/list") {
		const reqDir = url.searchParams.get("dir") ?? "";
		const extFilter = url.searchParams.get("ext")?.toLowerCase().split(",").filter(Boolean) ?? [];
		const root = service.getWorkspaceRoot();
		const targetDir = reqDir === "" ? root : isAbsolute(reqDir) ? reqDir : resolve(root, reqDir);
		try {
			const dirents = await readdir(targetDir, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (d.name.startsWith(".") && d.name !== ".dsh") continue;
				if (d.name === "node_modules") continue;
				const fullPath = join(targetDir, d.name);
				if (d.isDirectory()) entries.push({
					name: d.name,
					isDirectory: true,
					path: fullPath
				});
				else {
					const ext = d.name.includes(".") ? "." + d.name.split(".").pop().toLowerCase() : "";
					if (extFilter.length > 0 && !extFilter.includes(ext)) continue;
					let size = 0;
					try {
						size = (await stat(fullPath)).size;
					} catch {}
					entries.push({
						name: d.name,
						isDirectory: false,
						size,
						ext,
						path: fullPath
					});
				}
			}
			entries.sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			const isRoot = resolve(targetDir) === resolve(root);
			const parentDir = isRoot ? null : resolve(targetDir, "..");
			const relPath = relative(root, targetDir).replace(/\\/g, "/");
			send(res, 200, {
				currentDir: targetDir,
				displayDir: relPath === "" ? "." : relPath,
				parentDir,
				isRoot,
				entries
			});
		} catch (error) {
			send(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (method === "GET" && path === "/variables") {
		const config = service.getConfig();
		const active = config.profiles.find((p) => p.id === config.activeProfile) ?? config.profiles[0];
		const hasWorkspace = await readWorkspaceConfig(service.getWorkspaceRoot()) !== void 0;
		send(res, 200, {
			enabled: active?.ocd.enabled ?? false,
			configPath: active?.openocd.configPath ?? "",
			openocdExecutable: active?.openocd.executable ?? "openocd",
			jlinkExecutable: active?.jlink.executable ?? "",
			elfPath: active?.ocd.elfPath ?? "",
			nmPath: active?.ocd.nmPath ?? "arm-none-eabi-nm",
			intervalMs: active?.ocd.intervalMs ?? 100,
			variables: active?.ocd.variables ?? [],
			configScope: hasWorkspace ? "workspace" : "global",
			workspaceFile: hasWorkspace ? WORKSPACE_CONFIG_REL : void 0
		});
		return;
	}
	if (method !== "POST") return send(res, 405, { error: "method not allowed" });
	const body = await readJson(req);
	if (path === "/variables") {
		const input = body;
		if (input === void 0 || typeof input !== "object") return send(res, 400, { error: "request body must be an object" });
		const config = service.getConfig();
		const profileId = config.activeProfile;
		const profile = config.profiles.find((p) => p.id === profileId) ?? config.profiles[0];
		if (profile === void 0) return send(res, 500, { error: "no active profile" });
		if (typeof input.configPath === "string") profile.openocd.configPath = input.configPath.trim();
		if (typeof input.openocdExecutable === "string") profile.openocd.executable = input.openocdExecutable.trim() === "" ? "openocd" : input.openocdExecutable.trim();
		if (typeof input.jlinkExecutable === "string") profile.jlink.executable = input.jlinkExecutable.trim();
		if (typeof input.nmPath === "string") profile.ocd.nmPath = input.nmPath.trim() === "" ? "arm-none-eabi-nm" : input.nmPath.trim();
		if (typeof input.elfPath === "string") profile.ocd.elfPath = input.elfPath.trim();
		if (typeof input.enabled === "boolean") profile.ocd.enabled = input.enabled;
		if (typeof input.intervalMs === "number" && Number.isFinite(input.intervalMs) && input.intervalMs > 0) profile.ocd.intervalMs = input.intervalMs;
		if (Array.isArray(input.variables)) {
			const resolvedVariables = [];
			const effectiveElfPath = profile.ocd.elfPath;
			let elfSymbols;
			for (const item of input.variables) if (typeof item === "string") {
				const manual = parseManualBinding(item);
				if (manual !== void 0) {
					resolvedVariables.push({
						source: "manual",
						name: manual.name,
						address: manual.address,
						type: manual.type
					});
					continue;
				}
				const symName = item.trim();
				if (symName === "") continue;
				if (effectiveElfPath !== "") {
					if (elfSymbols === void 0) {
						const realElf = service.resolveWorkspacePath(effectiveElfPath);
						try {
							elfSymbols = await listElfSymbols(realElf, profile.ocd.nmPath);
						} catch {}
					}
					const found = elfSymbols?.find((s) => s.name === symName);
					if (found !== void 0) {
						const type = found.size > 0 ? typeForSize(found.size, found.inferredType) : found.inferredType;
						resolvedVariables.push({
							source: "symbol",
							symbol: found.name,
							name: found.name,
							address: found.address,
							type
						});
						continue;
					}
				}
				resolvedVariables.push({
					source: "symbol",
					symbol: symName,
					name: symName,
					address: 0,
					type: "u32"
				});
			} else if (typeof item === "object" && item !== null) {
				const obj = item;
				const name = typeof obj.name === "string" ? obj.name : typeof obj.symbol === "string" ? obj.symbol : "var";
				const rawAddr = obj.address;
				let address = 0;
				if (typeof rawAddr === "number") address = rawAddr >>> 0;
				else if (typeof rawAddr === "string") address = parseAddress(rawAddr) ?? 0;
				const type = typeof obj.type === "string" ? normalizeType(obj.type) ?? "u32" : "u32";
				const unit = typeof obj.unit === "string" && obj.unit.trim() !== "" ? obj.unit.trim() : void 0;
				const source = obj.source === "manual" || obj.source === void 0 && address > 0 && typeof obj.symbol !== "string" ? "manual" : "symbol";
				resolvedVariables.push({
					source,
					...typeof obj.symbol === "string" ? { symbol: obj.symbol } : {},
					name,
					address,
					type,
					...unit ? { unit } : {}
				});
			}
			profile.ocd.variables = resolvedVariables;
		}
		service.setConfig(config);
		const workspaceRoot = service.getWorkspaceRoot();
		const persistError = await persistence();
		const resW = await writeWorkspaceConfig(workspaceRoot, config);
		const reported = persistError ?? (resW.ok ? void 0 : resW.error);
		send(res, 200, {
			ok: true,
			count: profile.ocd.variables.length,
			variables: profile.ocd.variables,
			enabled: profile.ocd.enabled,
			intervalMs: profile.ocd.intervalMs,
			configPath: profile.openocd.configPath,
			openocdExecutable: profile.openocd.executable,
			jlinkExecutable: profile.jlink.executable,
			elfPath: profile.ocd.elfPath,
			nmPath: profile.ocd.nmPath,
			persisted: reported === void 0,
			configScope: "both",
			workspaceFile: WORKSPACE_CONFIG_REL,
			...reported ? { persistError: reported } : {}
		});
		return;
	}
	if (path === "/start") {
		await service.start();
		send(res, 200, service.state());
		return;
	}
	if (path === "/stop") {
		await service.stop();
		send(res, 200, service.state());
		return;
	}
	if (path === "/clear") {
		const what = body?.what;
		if (what !== "log" && what !== "series" && what !== "all") return send(res, 400, { error: "what must be \"log\", \"series\" or \"all\"" });
		service.clear(what);
		send(res, 200, service.state());
		return;
	}
	if (path === "/config") {
		const patch = body;
		const workspaceRoot = service.getWorkspaceRoot();
		const workspaceCfg = await readWorkspaceConfig(workspaceRoot);
		const hasWorkspaceConfig = workspaceCfg !== void 0;
		let changed = false;
		if (patch?.profileId !== void 0) {
			if (typeof patch.profileId !== "string") return send(res, 400, { error: "profileId must be a string" });
			service.setActiveProfile(patch.profileId);
			changed = true;
		}
		if (patch?.config !== void 0) {
			const problems = checkConfig(patch.config);
			if (problems.length > 0) return send(res, 400, { error: problems.join("; ") });
			service.setConfig(patch.config);
			changed = true;
		}
		const config = service.getConfig();
		if (!changed) {
			if (hasWorkspaceConfig && workspaceCfg !== void 0) service.setConfig(applyToolPaths(workspaceCfg, readToolPaths(service.getConfig())));
			send(res, 200, {
				...service.getConfig(),
				configScope: hasWorkspaceConfig ? "workspace" : "global",
				workspaceFile: hasWorkspaceConfig ? WORKSPACE_CONFIG_REL : void 0
			});
			return;
		}
		const persistError = await persistence();
		const resW = await writeWorkspaceConfig(workspaceRoot, config);
		const reported = persistError ?? settingsError() ?? (resW.ok ? void 0 : resW.error);
		send(res, 200, reported === void 0 ? {
			...config,
			persisted: true,
			configScope: "both",
			workspaceFile: WORKSPACE_CONFIG_REL
		} : {
			...config,
			persisted: false,
			persistError: reported,
			configScope: "both",
			workspaceFile: WORKSPACE_CONFIG_REL
		});
		return;
	}
	if (path === "/profiles") {
		const config = service.getConfig();
		send(res, 200, {
			profiles: config.profiles,
			activeProfile: config.activeProfile
		});
		return;
	}
	if (path === "/profiles/add") {
		const label = body?.name;
		if (typeof label !== "string" || label.trim() === "") return send(res, 400, { error: "name must be a non-empty string" });
		const config = service.getConfig();
		const id = uniqueId(label, config.profiles.map((p) => p.id));
		config.profiles.push(createDefaultProfile(id, label.trim()));
		service.setConfig(config);
		const addedError = await persistence();
		const added = service.getConfig();
		send(res, 200, addedError === void 0 ? added : {
			...added,
			persisted: false,
			persistError: addedError
		});
		return;
	}
	if (path === "/symbols") {
		const params = body;
		if (typeof params?.elfPath !== "string" || params.elfPath.trim() === "") return send(res, 400, { error: "elfPath must be a non-empty string" });
		const rawElfPath = params.elfPath.trim();
		const elfPath = service.resolveWorkspacePath(rawElfPath);
		const nmPath = typeof params.nmPath === "string" && params.nmPath.trim() !== "" ? params.nmPath.trim() : "arm-none-eabi-nm";
		let symbols;
		try {
			symbols = await listElfSymbols(elfPath, nmPath, {
				globalsOnly: params.globalsOnly !== false,
				...typeof params.filter === "string" && params.filter !== "" ? { filter: params.filter } : {}
			});
		} catch (error) {
			return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		send(res, 200, { symbols });
		return;
	}
	if (path === "/ocd-vars") {
		const params = body;
		if (!Array.isArray(params?.variables)) return send(res, 400, { error: "variables must be an array" });
		const rawElfPath = typeof params.elfPath === "string" ? params.elfPath.trim() : "";
		const elfPath = rawElfPath !== "" ? service.resolveWorkspacePath(rawElfPath) : "";
		let resolved = [];
		if (elfPath !== "") {
			let symbols;
			try {
				symbols = await listElfSymbols(elfPath);
			} catch (error) {
				return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			const byName = new Map(symbols.map((s) => [s.name, s]));
			resolved = params.variables.map((raw) => {
				const entry = raw;
				const symbolName = typeof entry.symbol === "string" ? entry.symbol : "";
				const found = byName.get(symbolName);
				if (found === void 0) return {
					ok: false,
					reason: `symbol "${symbolName}" not found in ${elfPath}`,
					name: symbolName,
					address: 0,
					type: "u32"
				};
				const type = found.size > 0 ? typeForSize(found.size, found.inferredType) : found.inferredType;
				return {
					ok: true,
					name: typeof entry.name === "string" && entry.name !== "" ? entry.name : found.name,
					address: found.address,
					type
				};
			});
		} else resolved = params.variables.map((raw) => {
			const entry = raw;
			const parsed = parseManualBinding(typeof entry.symbol === "string" ? entry.symbol : "");
			if (parsed === void 0) return {
				ok: false,
				reason: "not a resolvable symbol and not a manual address",
				name: "",
				address: 0,
				type: "u32"
			};
			return {
				ok: true,
				name: typeof entry.name === "string" && entry.name !== "" ? entry.name : parsed.name,
				address: parsed.address,
				type: parsed.type
			};
		});
		send(res, 200, { resolved });
		return;
	}
	send(res, 404, { error: `unknown route ${path}` });
}
/**
* Browser-trust fence.
*
* Mirrors the host gateway's rule: a loopback Host header is trusted, anything
* else is not. Without this a page on another origin could reach the debug
* routes through a bare `fetch`.
*/
function isTrusted(req) {
	const host = req.headers.host;
	if (host === void 0 || host === "") return true;
	const bare = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	if (bare === void 0) return false;
	return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "::ffff:127.0.0.1";
}
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk;
		size += buf.length;
		if (size > 4194304) throw new Error("request body too large");
		chunks.push(buf);
	}
	if (chunks.length === 0) return void 0;
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return void 0;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("request body is not valid JSON");
	}
}
function send(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}
function stamp() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
function uniqueId(label, taken) {
	const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
	if (!taken.includes(base)) return base;
	for (let i = 2;; i += 1) {
		const candidate = `${base}-${i}`;
		if (!taken.includes(candidate)) return candidate;
	}
}
export { DebugService, ROUTE_PREFIX, apply, inject, name };

//# sourceMappingURL=index.js.map