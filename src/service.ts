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

import { EventEmitter } from 'node:events'
import { isAbsolute, resolve } from 'node:path'
import { LineSplitter } from './core/framing.ts'
import { AnsiDecoder, detectLevel } from './core/ansi.ts'
import { LogStore, SeriesStore } from './core/store.ts'
import { TcpLink, type LinkStatus } from './core/tcp-link.ts'
import { OpenOcdManager, type OpenOcdStatus } from './openocd/manager.ts'
import { JLinkManager, type JLinkStatus } from './jlink/manager.ts'
import { JLinkTelnet, type JLinkTelnetStatus } from './jlink/telnet.ts'
import { JLinkReader, type JLinkReaderStatus } from './jlink/reader.ts'
import { createDefaultRegistry, ParserRegistry } from './parsers/registry.ts'
import { OcdReader, type OcdReaderStatus } from './ocd/reader.ts'
import { bindingWidth } from './ocd/symbols.ts'
import type { LogRecord, Sample, SourceId, VariableDescriptor } from './core/types.ts'
import type { DeviceProfile, PluginConfig } from './config.ts'
import { activeProfileOf, createDefaultConfig, migrateConfig, validateConfig } from './config.ts'

/** One source's live status, as the UI sees it. */
export interface SourceState {
  id: SourceId
  enabled: boolean
  /** `idle` | `connecting` | `open` | `reconnecting` | `closed` | `error` */
  state: string
  detail?: string
  /** Lines (log) or samples (variables) received since the last clear. */
  received: number
}

/** The debug-backend status the panel header renders, whichever driver is live. */
export type BackendStatus = OpenOcdStatus | JLinkStatus

/** The whole panel state, pushed to the browser on change. */
export interface DebugState {
  /**
   * Status of whichever backend owns the debug connection.
   *
   * Kept under the historical `openocd` key so an older client keeps rendering
   * something; `driver` tells a new client which backend that status describes.
   */
  openocd: BackendStatus
  /** `openocd` | `jlink` — which backend the status above belongs to. */
  driver: 'openocd' | 'jlink'
  sources: SourceState[]
  log: {
    /** Lines currently retained in the ring. */
    retained: number
    /** Lines ever received — the completeness counter (A16). */
    total: number
  }
  series: {
    names: string[]
    /** Per-series point counts, keyed by name. */
    points: Record<string, number>
  }
  descriptors: VariableDescriptor[]
  profiles: { id: string; name: string }[]
  activeProfile: string
  /**
   * A J-Link-specific limitation observed at runtime, e.g. its RTT TELNET port
   * refusing a second simultaneous channel. Absent when nothing is wrong.
   */
  jlinkNotice?: string
}

export interface DebugServiceEvents {
  state: [state: DebugState]
  /** New log lines, batched for transport. */
  log: [records: LogRecord[]]
  /** New samples, batched for transport. */
  series: [samples: Sample[]]
  clear: [what: 'log' | 'series' | 'all']
}

/** How often batched log/series pushes leave the host. */
const FLUSH_INTERVAL_MS = 100

export class DebugService extends EventEmitter<DebugServiceEvents> {
  private config: PluginConfig = createDefaultConfig()
  private profile: DeviceProfile = activeProfileOf(this.config)
  private workspaceRoot: string

  private readonly logStore = new LogStore()
  private readonly seriesStore = new SeriesStore()
  private readonly registry: ParserRegistry = createDefaultRegistry()
  private readonly ocdReader: OcdReader | undefined
  private ocdReaderInstance?: OcdReader

  private openocd?: OpenOcdManager
  private jlinkManager?: JLinkManager
  private jlinkReaderInstance?: JLinkReader
  /** J-Link TELNET links, one per RTT channel (only when driver is `jlink`). */
  private jlinkLogLink?: JLinkTelnet
  private jlinkVariableLink?: JLinkTelnet
  /**
   * Set when J-Link closed one TELNET channel while another was alive.
   *
   * SEGGER does not document multi-client support on the RTT TELNET port, so
   * this records the observed verdict for the UI instead of retrying a channel
   * that cannot work.
   */
  private jlinkChannelConflict?: string
  private logLink?: TcpLink
  private variableLink?: TcpLink
  private readonly logSplitter = new LineSplitter()
  private readonly ansi = new AnsiDecoder()
  private provider = this.registry.create('csv')

  private logReceived = 0
  private variableReceived = 0
  private pendingLog: LogRecord[] = []
  private pendingSamples: Sample[] = []
  private flushTimer?: NodeJS.Timeout
  private running = false

  public constructor(workspaceRoot: string) {
    super()
    this.workspaceRoot = workspaceRoot
    this.ocdReader = undefined
  }

  /* ────────────────────────────── configuration ───────────────────────────── */

  public getConfig(): PluginConfig {
    return structuredClone(this.config)
  }

  /**
   * Replace the configuration.
   * @throws when the document is malformed — an invalid profile is refused at
   *   the boundary instead of failing later inside a poll cycle.
   */
  public setConfig(config: PluginConfig): void {
    const problems = validateConfig(config)
    if (problems.length > 0) {
      throw new Error(`invalid configuration: ${problems.join('; ')}`)
    }
    const previousDriver = this.profile.driver
    this.config = structuredClone(config)
    this.profile = activeProfileOf(this.config)
    this.applyProfile()
    // Switching backends under a running session would leave one transport
    // half-open against the other's endpoints, so the driver change forces a
    // clean stop; the UI's Start button brings the new backend up.
    if (this.running && previousDriver !== this.profile.driver) {
      void this.stop()
      this.emitState()
      return
    }
    this.reconcileOcdReader()
    this.emitState()
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
  private reconcileOcdReader(): void {
    if (!this.running) return
    if (this.profile.driver === 'jlink') {
      const jreader = this.jlinkReaderInstance
      if (!this.profile.ocd.enabled) {
        if (jreader === undefined) return
        jreader.stop()
        this.jlinkReaderInstance = undefined
        return
      }
      if (jreader !== undefined) return
      void this.startJLinkReader().catch(() => {
        this.jlinkReaderInstance = undefined
        this.emitState()
      })
      return
    }
    const reader = this.ocdReaderInstance
    if (!this.profile.ocd.enabled) {
      if (reader === undefined) return
      reader.stop()
      this.ocdReaderInstance = undefined
      return
    }
    if (reader !== undefined) return
    // The connection is asynchronous and may fail (no target, wrong TCL port).
    // Failures must not escape into setConfig — which is synchronous and already
    // committed the configuration — so they are surfaced through the state only.
    void this.startOcd().catch(() => {
      this.ocdReaderInstance = undefined
      this.emitState()
    })
  }

  public setActiveProfile(id: string): void {
    const next = structuredClone(this.config)
    if (!next.profiles.some(p => p.id === id)) {
      throw new Error(`unknown device profile "${id}"`)
    }
    next.activeProfile = id
    this.setConfig(next)
  }

  /** The profile currently in force. */
  public getProfile(): DeviceProfile {
    return structuredClone(this.profile)
    return structuredClone(this.profile)
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root
    this.openocd?.setWorkspaceRoot(root)
    this.jlinkManager?.setWorkspaceRoot(root)
  }

  /** Read the current workspace root directory (session cwd, or process.cwd() fallback). */
  public getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  /**
   * Resolve a workspace-relative path (such as `elfPath`) against the current
   * workspace root, matching `OpenOcdManager.resolveConfigPath`.
   * Absolute paths are returned verbatim.
   */
  public resolveWorkspacePath(targetPath: string): string {
    const trimmed = targetPath.trim()
    if (trimmed === '') return ''
    return isAbsolute(trimmed) ? trimmed : resolve(this.workspaceRoot, trimmed)
  }

  /** Re-apply the active profile's limits and parser without a restart. */
  private applyProfile(): void {
    this.logStore.configure({ maxLines: this.profile.log.maxLines })
    this.seriesStore.configure({
      sampleRateHz: this.profile.variables.sampleRateHz,
      retentionMs: this.profile.variables.retentionMinutes * 60_000,
      maxPointsPerSeries: this.profile.variables.maxPointsPerSeries,
    })
    if (this.provider.id !== this.profile.variables.parser.id) {
      this.provider = this.registry.create(this.profile.variables.parser.id)
    }
    this.provider.configure(this.profile.variables.parser.options)
    this.ocdReaderInstance?.setBindings(this.computeOcdBindings())
  }

  /** Parser registry, so a caller can register an extra parser. */
  /** Start the enabled sources. Idempotent. */
  public async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.applyProfile()

    if (this.profile.driver === 'jlink') {
      await this.startJLinkBackend()
      return
    }
    await this.startOpenOcdBackend()
  }

  /**
   * Bring up OpenOCD and the two TCP links it provides.
   *
   * OpenOCD forwards each RTT channel on its own `rtt server start` port, so the
   * two sources are two ports on the same host.
   */
  private async startOpenOcdBackend(): Promise<void> {
    if (this.openocd === undefined) {
      this.openocd = new OpenOcdManager(this.workspaceRoot)
      this.openocd.on('status', () => this.emitState())
    }

    const status = await this.openocd.start(this.profile)
    this.emitState()
    if (status.kind === 'error') {
      // The RTT sources cannot work without a backend, but the failure is
      // reported rather than thrown so the UI can show it.
      this.running = false
      return
    }

    if (this.profile.log.enabled) this.openLogLink()
    if (this.profile.variables.enabled) this.openVariableLink()
    if (this.profile.ocd.enabled) await this.startOcd()

    this.startFlusher()
    this.emitState()
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
  private async startJLinkBackend(): Promise<void> {
    this.jlinkChannelConflict = undefined
    if (this.jlinkManager === undefined) {
      this.jlinkManager = new JLinkManager(this.workspaceRoot)
      this.jlinkManager.on('status', () => this.emitState())
    }

    const status = await this.jlinkManager.start(this.profile)
    this.emitState()
    if (status.kind === 'error') {
      this.running = false
      return
    }

    if (this.profile.log.enabled) this.openJLinkLogLink()
    if (this.profile.variables.enabled) this.openJLinkVariableLink()
    if (this.profile.ocd.enabled) await this.startJLinkReader()

    this.startFlusher()
    this.emitState()
  }

  /** Stop every source but keep backend process ownership intact. */
  public async stop(): Promise<void> {
    this.running = false
    this.stopFlusher()
    this.logLink?.dispose()
    this.logLink = undefined
    this.variableLink?.dispose()
    this.variableLink = undefined
    this.jlinkLogLink?.dispose()
    this.jlinkLogLink = undefined
    this.jlinkVariableLink?.dispose()
    this.jlinkVariableLink = undefined
    this.ocdReaderInstance?.stop()
    this.ocdReaderInstance = undefined
    this.jlinkReaderInstance?.stop()
    this.jlinkReaderInstance = undefined
    await this.openocd?.stop()
    await this.jlinkManager?.stop()
    this.emitState()
  }

  /** Release everything, including the backend process this plugin spawned. */
  public async dispose(): Promise<void> {
    await this.stop()
    this.openocd?.removeAllListeners()
    this.openocd = undefined
    this.jlinkManager?.removeAllListeners()
    this.jlinkManager = undefined
  }

  public isRunning(): boolean {
    return this.running
  }

  /* ───────────────────────────── source: RTT log ──────────────────────────── */

  private openLogLink(): void {
    const link = new TcpLink({
      host: '127.0.0.1',
      port: this.profile.log.binding.port,
      // The log path must not lose bytes (D20/A16): pause the socket instead.
      overflowPolicy: 'pause',
      maxBufferedBytes: 16 * 1024 * 1024,
    })
    this.logLink = link

    link.on('data', (chunk: Buffer) => {
      // Synchronous end-to-end: decode, classify, store. Nothing awaits, so a
      // slow browser cannot cause a dropped line.
      for (const raw of this.logSplitter.push(chunk)) {
        const spans = this.ansi.push(raw)
        const text = spans.map(s => s.text).join('')
        const record = this.logStore.push({ ts: Date.now(), text, spans, level: detectLevel(text) })
        this.pendingLog.push(record)
        this.logReceived += 1
      }
    })
    link.on('status', (status: LinkStatus) => {
      if (status.kind === 'open') this.ansi.reset()
      this.emitState()
    })
    link.on('error', () => this.emitState())
    link.connect()
  }

  /* ───────────────────── source: RTT data channel ────────────────────────── */

  private openVariableLink(): void {
    const link = new TcpLink({
      host: '127.0.0.1',
      port: this.profile.variables.binding.port,
      // Variable frames are stale-able: dropping the oldest beats stalling.
      overflowPolicy: 'drop-oldest',
      maxBufferedBytes: 4 * 1024 * 1024,
    })
    this.variableLink = link

    link.on('data', (chunk: Buffer) => {
      let samples: Sample[]
      try {
        samples = this.provider.feed(chunk)
      } catch {
        // A malformed frame must not kill the stream; the next chunk recovers.
        return
      }
      if (samples.length === 0) return
      this.variableReceived += samples.length
      this.ingest(samples)
    })
    link.on('status', () => this.emitState())
    link.on('error', () => this.emitState())
    link.connect()
  }

  /* ────────────────── source: RTT log, via J-Link TELNET ─────────────────── */

  /**
   * Open the log channel through J-Link's TELNET port.
   *
   * No `drop-oldest` policy exists here: `JLinkTelnet` does not buffer on the
   * plugin side at all — the socket handler decodes lines synchronously — so a
   * slow consumer pauses the socket through the kernel rather than losing a
   * line, which is the same guarantee the OpenOCD path makes.
   */
  private openJLinkLogLink(): void {
    const link = new JLinkTelnet({
      host: '127.0.0.1',
      port: this.profile.jlink.rttTelnetPort,
      channel: this.profile.log.binding.channel,
      ...this.jlinkRttSearchOptions(),
    })
    this.jlinkLogLink = link

    link.on('data', (chunk: Buffer) => {
      // Synchronous end-to-end: decode, classify, store. Nothing awaits, so a
      // slow browser cannot cause a dropped line.
      for (const raw of this.logSplitter.push(chunk)) {
        const spans = this.ansi.push(raw)
        const text = spans.map(s => s.text).join('')
        const record = this.logStore.push({ ts: Date.now(), text, spans, level: detectLevel(text) })
        this.pendingLog.push(record)
        this.logReceived += 1
      }
    })
    link.on('status', (status: JLinkTelnetStatus) => {
      if (status.kind === 'open') this.ansi.reset()
      this.emitState()
    })
    link.on('error', () => this.emitState())
    link.on('dropped', info => this.noteJLinkDrop(info, 'log'))
    link.connect()
  }

  /* ──────────────── source: RTT data channel, via J-Link TELNET ──────────── */

  private openJLinkVariableLink(): void {
    const link = new JLinkTelnet({
      host: '127.0.0.1',
      port: this.profile.jlink.rttTelnetPort,
      channel: this.profile.variables.binding.channel,
      ...this.jlinkRttSearchOptions(),
    })
    this.jlinkVariableLink = link

    link.on('data', (chunk: Buffer) => {
      let samples: Sample[]
      try {
        samples = this.provider.feed(chunk)
      } catch {
        // A malformed frame must not kill the stream; the next chunk recovers.
        return
      }
      if (samples.length === 0) return
      this.variableReceived += samples.length
      this.ingest(samples)
    })
    link.on('status', () => this.emitState())
    link.on('error', () => this.emitState())
    link.on('dropped', info => this.noteJLinkDrop(info, 'variables'))
    link.connect()
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
  private noteJLinkDrop(info: { channel: number; hadData: boolean }, which: 'log' | 'variables'): void {
    if (info.hadData) return
    const other = which === 'log' ? this.jlinkVariableLink : this.jlinkLogLink
    const otherAlive = other?.getStatus().kind === 'open'
    if (!otherAlive) return

    this.jlinkChannelConflict = `channel ${info.channel}: J-Link closed the connection without sending data, while the other RTT channel is connected. This J-Link appears to serve one TELNET channel at a time.`
    if (which === 'variables') {
      this.jlinkVariableLink?.close('J-Link refused a second RTT channel')
      this.jlinkVariableLink = undefined
    } else {
      this.jlinkLogLink?.close('J-Link refused a second RTT channel')
      this.jlinkLogLink = undefined
    }
    this.emitState()
  }

  /**
   * The control-block selector shared by both J-Link TELNET links.
   *
   * The profile carries a search address AND a size, which is exactly what
   * SEGGER's `SetRTTSearchRanges` wants as one `"<start> <size>"` string, so the
   * configured range is forwarded rather than silently falling back to J-Link's
   * default search.
   */
  private jlinkRttSearchOptions(): { rttAddress?: number; rttSearchRange?: string } {
    const { rtt } = this.profile
    if (rtt.address > 0 && rtt.size > 0) {
      const start = `0x${(rtt.address >>> 0).toString(16)}`
      const size = `0x${(rtt.size >>> 0).toString(16)}`
      return { rttSearchRange: `${start} ${size}` }
    }
    return {}
  }

  /* ─────────────────────── source: OCD memory reader ─────────────────────── */

  private computeOcdBindings(): { name: string; address: number; type: import('./core/types.ts').ScalarType; unit?: string }[] {
    const out: { name: string; address: number; type: import('./core/types.ts').ScalarType; unit?: string }[] = []
    for (const entry of this.profile.ocd.variables) {
      if (entry.source === 'symbol') {
        if (entry.address === undefined) continue  // unresolved symbol
        const name = entry.name ?? entry.symbol ?? `0x${(entry.address >>> 0).toString(16)}`
        const binding = { name, address: entry.address, type: entry.type ?? 'u32' }
        out.push(entry.unit === undefined ? binding : { ...binding, unit: entry.unit })
        continue
      }
      if (entry.address === undefined) continue
      const name = entry.name ?? `0x${(entry.address >>> 0).toString(16)}`
      const binding = { name, address: entry.address, type: entry.type ?? 'u32' }
      out.push(entry.unit === undefined ? binding : { ...binding, unit: entry.unit })
    }
    return out
  }

  private async startOcd(): Promise<void> {
    const bindings = this.computeOcdBindings()
    if (bindings.length === 0) return
    const reader = new OcdReader({
      host: '127.0.0.1',
      port: this.profile.openocd.tclPort,
      intervalMs: this.profile.ocd.intervalMs,
      verifyConsistency: this.profile.ocd.verifyConsistency,
      batchDistanceBytes: this.profile.ocd.batchDistanceBytes,
    })
    reader.setBindings(bindings)
    reader.on('samples', (samples: Sample[]) => {
      this.variableReceived += samples.length
      this.ingest(samples)
    })
    reader.on('status', () => this.emitState())
    reader.on('error', () => this.emitState())
    this.ocdReaderInstance = reader
    await reader.start()
  }

  /** The OCD reader's status, when it is running. */
  public getOcdStatus(): OcdReaderStatus | undefined {
    return this.ocdReaderInstance?.status()
  }

  /** The J-Link memory reader's status, when it is running. */
  public getJLinkReaderStatus(): JLinkReaderStatus | undefined {
    return this.jlinkReaderInstance?.status()
  }

  /* ─────────────────── source: J-Link memory reader (GDB RSP) ─────────────── */

  private async startJLinkReader(): Promise<void> {
    const bindings = this.computeOcdBindings()
    if (bindings.length === 0) return
    const reader = new JLinkReader({
      host: '127.0.0.1',
      port: this.profile.jlink.gdbPort,
      intervalMs: this.profile.ocd.intervalMs,
      verifyConsistency: this.profile.ocd.verifyConsistency,
      batchDistanceBytes: this.profile.ocd.batchDistanceBytes,
    })
    reader.setBindings(bindings)
    reader.on('samples', (samples: Sample[]) => {
      this.variableReceived += samples.length
      this.ingest(samples)
    })
    reader.on('status', () => this.emitState())
    reader.on('error', () => this.emitState())
    this.jlinkReaderInstance = reader
    await reader.start()
  }

  /* ─────────────────────────────── ingest path ────────────────────────────── */

  /** Route samples into the series store and the transport batch. */
  private ingest(samples: Sample[]): void {
    this.seriesStore.append(samples)
    this.pendingSamples.push(...samples)
    // Units discovered by a parser ride along on the descriptors.
    for (const descriptor of this.provider.descriptors()) {
      this.seriesStore.setMeta(descriptor.name, {
        kind: descriptor.kind,
        ...(descriptor.unit === undefined ? {} : { unit: descriptor.unit }),
      })
    }
  }

  private startFlusher(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref?.()
  }

  private stopFlusher(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  /** Push whatever accumulated since the last tick. */
  public flush(): void {
    if (this.pendingLog.length > 0) {
      const batch = this.pendingLog
      this.pendingLog = []
      this.emit('log', batch)
    }
    if (this.pendingSamples.length > 0) {
      const batch = this.pendingSamples
      this.pendingSamples = []
      this.emit('series', batch)
    }
    this.emitState()
  }

  /* ───────────────────────────────── reading ──────────────────────────────── */

  /** Everything retained, for a browser that just opened the panel. */
  public snapshot(): { log: LogRecord[]; total: number; series: ReturnType<SeriesStore['all']>; state: DebugState } {
    return {
      log: this.logStore.entries(),
      total: this.logStore.totalIngested,
      series: this.seriesStore.all(),
      state: this.state(),
    }
  }

  /** Status of whichever backend owns the connection. */
  private backendStatus(): BackendStatus {
    if (this.profile.driver === 'jlink') {
      return this.jlinkManager?.getStatus() ?? { kind: 'idle' }
    }
    return this.openocd?.getStatus() ?? { kind: 'idle' }
  }

  public state(): DebugState {
    const series = this.seriesStore.all()
    const points: Record<string, number> = {}
    for (const s of series) points[s.name] = s.ts.length
    const descriptors: VariableDescriptor[] = [...this.provider.descriptors()]
    for (const s of series) {
      if (!descriptors.some(d => d.name === s.name)) {
        descriptors.push({
          name: s.name,
          kind: s.kind,
          source: 'ocd',
          ...(s.unit === undefined ? {} : { unit: s.unit }),
        })
      } else if (s.unit !== undefined) {
        const found = descriptors.find(d => d.name === s.name)
        if (found !== undefined && found.unit === undefined) found.unit = s.unit
      }
    }
    return {
      openocd: this.backendStatus(),
      driver: this.profile.driver,
      sources: this.sourceStates(),
      log: { retained: this.logStore.entries().length, total: this.logStore.totalIngested },
      series: { names: series.map(s => s.name), points },
      descriptors,
      profiles: this.config.profiles.map(p => ({ id: p.id, name: p.name })),
      activeProfile: this.profile.id,
      ...(this.jlinkChannelConflict === undefined ? {} : { jlinkNotice: this.jlinkChannelConflict }),
    }
  }

  private sourceStates(): SourceState[] {
    // `TcpLink` reports connection state through `status` and failures through
    // its `error` event, so an error becomes a `closed`/`reconnecting` state
    // plus a recorded detail rather than its own kind.
    const linkState = (link: TcpLink | undefined): { state: string; detail?: string } => {
      const status = link?.getStatus()
      if (status === undefined) return { state: 'idle' }
      if (status.kind === 'closed') {
        return { state: 'closed', detail: status.reason }
      }
      if (status.kind === 'reconnecting') {
        return { state: 'reconnecting', detail: `attempt ${status.attempt}, retrying in ${status.delayMs} ms` }
      }
      return { state: status.kind }
    }

    const log = linkState(this.logLink)
    const variables = linkState(this.variableLink)

    return [
      {
        id: 'log',
        enabled: this.profile.log.enabled,
        state: log.state,
        ...(log.detail === undefined ? {} : { detail: log.detail }),
        received: this.logReceived,
      },
      {
        id: 'rttVar',
        enabled: this.profile.variables.enabled,
        state: variables.state,
        ...(variables.detail === undefined ? {} : { detail: variables.detail }),
        received: this.variableReceived,
      },
      {
        id: 'ocd',
        enabled: this.profile.ocd.enabled,
        state: this.ocdReaderInstance === undefined ? 'idle' : this.ocdReaderInstance.status().kind,
        received: this.ocdSampleCount,
      },
    ]
  }

  private ocdSampleCount = 0

  private getOcdSampleCount(): number {
    return this.ocdSampleCount
  }

  /* ────────────────────────────────── control ─────────────────────────────── */
  /* ────────────────────────────────── control ─────────────────────────────── */

  /** Clear retained data; the completeness counters keep counting (A16). */
  public clear(what: 'log' | 'series' | 'all'): void {
    if (what === 'log' || what === 'all') {
      this.logStore.clear()
      this.logSplitter.reset()
    }
    if (what === 'series' || what === 'all') {
      this.seriesStore.clear()
    }
    this.emit('clear', what)
    this.emitState()
  }

  /** Export retained log lines as text. */
  public exportLog(): string {
    return this.logStore.toText(ts => new Date(ts).toISOString())
  }

  private emitState(): void {
    this.emit('state', this.state())
  }
}

/** Byte width helper re-exported so the routes layer can size bindings. */
export { bindingWidth }

/** Validate a config document without applying it (used by the routes layer). */
export function checkConfig(config: unknown): string[] {
  return validateConfig(config)
}
