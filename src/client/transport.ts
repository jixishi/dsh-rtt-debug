/**
 * Client transport: REST calls plus the two WebSocket subscriptions.
 *
 * REST is used for commands and for the initial snapshot; the two sockets carry
 * live data. Log records and samples arrive on SEPARATE sockets so a burst of
 * samples cannot delay log lines (the browser delivers in order per socket).
 */

import type { LogRecord, VariableDescriptor } from '../core/types.ts'
import type { Series } from '../core/store.ts'
import type { DebugState } from '../service.ts'

const BASE = '/api/rtt-debug'

export interface Snapshot {
  log: LogRecord[]
  total: number
  series: Series[]
  state: DebugState
}async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  const payload = text === '' ? undefined : JSON.parse(text)
  if (!response.ok) {
    const message = (payload as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

/** Session-scoped query suffix, so the host can resolve the workspace root. */
function scope(sessionId: string | undefined): string {
  return sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
}

export const api = {
  snapshot: (sessionId?: string): Promise<Snapshot> =>
    request<Snapshot>(`/snapshot${scope(sessionId)}`),

  start: (sessionId?: string): Promise<DebugState> =>
    request<DebugState>(`/start${scope(sessionId)}`, { method: 'POST', body: '{}' }),

  stop: (sessionId?: string): Promise<DebugState> =>
    request<DebugState>(`/stop${scope(sessionId)}`, { method: 'POST', body: '{}' }),

  clear: (what: 'log' | 'series' | 'all', sessionId?: string): Promise<DebugState> =>
    request<DebugState>(`/clear${scope(sessionId)}`, { method: 'POST', body: JSON.stringify({ what }) }),

  getConfig: (sessionId?: string): Promise<unknown> =>
    request<unknown>(`/config${scope(sessionId)}`, { method: 'POST', body: '{}' }),

  setConfig: (config: unknown, sessionId?: string, target?: 'workspace' | 'global'): Promise<unknown> =>
    request<unknown>(`/config${scope(sessionId)}`, {
      method: 'POST',
      body: JSON.stringify({ config, ...(target ? { target } : {}) }),
    }),

  setProfile: (profileId: string, sessionId?: string): Promise<unknown> =>
    request<unknown>(`/config${scope(sessionId)}`, { method: 'POST', body: JSON.stringify({ profileId }) }),

  addProfile: (name: string, sessionId?: string): Promise<unknown> =>
    request<unknown>(`/profiles/add${scope(sessionId)}`, { method: 'POST', body: JSON.stringify({ name }) }),

  listFiles: (dir?: string, ext?: string, sessionId?: string): Promise<FsListResponse> => {
    const q = new URLSearchParams()
    if (dir !== undefined && dir !== '') q.set('dir', dir)
    if (ext !== undefined && ext !== '') q.set('ext', ext)
    if (sessionId !== undefined && sessionId !== '') q.set('sessionId', sessionId)
    const qs = q.toString()
    return request<FsListResponse>(`/fs/list${qs ? `?${qs}` : ''}`)
  },

  discoverFiles: (type: 'openocd' | 'elf' | 'all', sessionId?: string): Promise<FsDiscoverResponse> => {
    const q = new URLSearchParams({ type })
    if (sessionId !== undefined && sessionId !== '') q.set('sessionId', sessionId)
    return request<FsDiscoverResponse>(`/fs/discover?${q.toString()}`)
  },

  /** Resolve an ELF's symbols for the OCD reader's variable picker. */
  symbols: (elfPath: string, nmPath: string, filter: string, sessionId?: string): Promise<{ symbols: SymbolPreview[] }> =>
    request<{ symbols: SymbolPreview[] }>(`/symbols${scope(sessionId)}`, {
      method: 'POST',
      body: JSON.stringify({ elfPath, nmPath, filter }),
    }),

  ocdVars: (elfPath: string, variables: unknown[], sessionId?: string): Promise<{ resolved: ResolvedBinding[] }> =>
    request<{ resolved: ResolvedBinding[] }>(`/ocd-vars${scope(sessionId)}`, {
      method: 'POST',
      body: JSON.stringify({ elfPath, variables }),
    }),

  exportUrl: (sessionId?: string): string => `${BASE}/export${scope(sessionId)}`,
}

export interface SymbolPreview {
  name: string
  address: number
  size: number
  nmType: string
  inferredType: string
}

export interface ResolvedBinding {
  ok: boolean
  name: string
  address: number
  type: string
  reason?: string
}

/* ────────────────────────── configuration view types ────────────────────────── */

/**
 * Structural view of the OCD half of one device profile.
 *
 * Declared locally (NOT imported from `../config.ts`) on purpose: the client
 * bundle is built for the browser, and `src/config.ts` is a host module whose
 * import graph reaches `node:` builtins through `src/ocd/symbols.ts`. A plain
 * `import type` is erased at build time and would be safe, but keeping the shape
 * local makes the boundary explicit and survives any future value import.
 * Only the fields this UI reads and writes are modelled.
 */
export interface OcdProfileView {
  enabled: boolean
  /** ELF path; relative paths resolve against the session workspace root. */
  elfPath: string
  /** `nm` executable; bare names resolve through `PATH`. */
  nmPath: string
  intervalMs: number
  variables?: OcdVariableView[]
}

/** One configured OCD binding, as the profile stores it. */
export interface OcdVariableView {
  source: 'symbol' | 'manual'
  symbol?: string
  name?: string
  address?: number
  type?: string
  unit?: string
}

/** J-Link backend settings, as the profile stores them. */
export interface JLinkProfileView {
  /** Path to JLinkGDBServerCL.exe; empty resolves through PATH. */
  executable: string
  /** `-device` value. */
  device: string
  targetInterface: 'SWD' | 'JTAG'
  /** `-speed` in kHz; 0 leaves J-Link's default. */
  speedKhz: number
  /** GDB server port used by the memory reader. */
  gdbPort: number
  /** J-Link's RTT TELNET port; both RTT channels connect here. */
  rttTelnetPort: number
  /** `-select usb=<serial>`; empty means the default probe. */
  serial: string
  /** Spawn J-Link when nothing is listening. */
  autoStart: boolean
  extraArgs: string[]
  startupTimeoutMs: number
}

/** The subset of a device profile this panel needs. */
export interface DeviceProfileView {
  id: string
  name?: string
  /**
   * Which backend owns the debug connection.
   *
   * Optional because a profile saved by an older release has no such field;
   * the panel treats a missing value as `openocd`, which is what those
   * profiles actually used.
   */
  driver?: 'openocd' | 'jlink'
  /** `configPath` and `executable` are the two OpenOCD program settings. */
  openocd?: { configPath?: string; executable?: string }
  jlink?: JLinkProfileView
  ocd?: OcdProfileView
  /** Read-only here: the RTT data channel's parser, shown in the sources panel. */
  variables?: { parser?: { id?: string; options?: Record<string, unknown> } }
}

/** The subset of the plugin configuration this panel needs. */
export interface PluginConfigView {
  activeProfile: string
  profiles: DeviceProfileView[]
  /**
   * Which layers the last save touched.
   *
   * `'both'` is the normal state: tool paths (machine-wide) go to the global
   * layer and everything else to the workspace file.
   */
  configScope?: 'workspace' | 'global' | 'both'
  workspaceFile?: string
}

export interface FsEntry {
  name: string
  isDirectory: boolean
  size?: number
  ext?: string
  path: string
}

export interface FsListResponse {
  currentDir: string
  displayDir: string
  parentDir: string | null
  isRoot: boolean
  entries: FsEntry[]
}

export interface FsDiscoverResponse {
  root: string
  files: { path: string; relPath: string; name: string }[]
}

/**
 * A reconnecting socket.
 *
 * The panel keeps working while the host restarts: the socket retries with
 * backoff and reports its connection state so the toolbar can show it.
 */
export class LiveSocket {
  private socket?: WebSocket
  private closed = false
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private readonly url: string
  private readonly onMessage: (payload: unknown) => void
  private readonly onState: (connected: boolean) => void

  public constructor(
    path: string,
    sessionId: string | undefined,
    onMessage: (payload: unknown) => void,
    onState: (connected: boolean) => void,
  ) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
    this.url = `${proto}//${location.host}${BASE}${path}${query}`
    this.onMessage = onMessage
    this.onState = onState
    this.open()
  }

  private open(): void {
    if (this.closed) return
    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.onState(true)
    }
    socket.onmessage = event => {
      try {
        this.onMessage(JSON.parse(String(event.data)))
      } catch {
        // A malformed frame is ignored; the stream continues.
      }
    }
    socket.onclose = () => {
      this.onState(false)
      this.schedule()
    }
    socket.onerror = () => {
      // `close` always follows; retry is handled there.
    }
  }

  private schedule(): void {
    if (this.closed) return
    this.attempt += 1
    const delay = Math.min(500 * Math.pow(1.8, this.attempt - 1), 10_000)
    this.timer = setTimeout(() => this.open(), delay)
  }

  public close(): void {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.socket?.close()
    this.socket = undefined
  }
}

/** Re-exported so the view layer has one import for its data vocabulary. */
export type { DebugState, LogRecord, Series, VariableDescriptor }
