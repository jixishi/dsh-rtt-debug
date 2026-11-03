/**
 * Plugin configuration.
 *
 * Every value here is a DEFAULT, never a constant: the plugin is generic
 * (spec §0 G1/G2), so a deployment points it at any RTT-capable target by
 * editing configuration rather than code. Nothing below names a chip, a vendor,
 * a firmware project or an absolute path.
 *
 * Defaults follow SEGGER's own convention — channel 0 is the terminal, so the
 * data channel starts at 1 — and the two RTT servers use consecutive ports.
 */

import type { ScalarType } from './core/types.ts'

/** One RTT server binding: which channel is exposed on which TCP port. */
export interface ChannelBinding {
  /** TCP port the OpenOCD RTT server listens on. */
  port: number
  /** RTT up-channel index to forward. */
  channel: number
  /** Start this server on OpenOCD launch. */
  enabled: boolean
}

/** How the plugin obtains its OpenOCD process. */
export type OpenOcdMode = 'auto' | 'attach'

/**
 * Which backend performs target-memory reads for direct variable sampling.
 *
 *   - `openocd` — the OpenOCD TCL port (the historical default);
 *   - `jlink`   — SEGGER's own J-Link software, with no OpenOCD involved:
 *                 memory reads go through the GDB remote serial protocol that
 *                 JLinkGDBServer speaks, and RTT channels arrive on J-Link's
 *                 TELNET port with a per-connection channel selector.
 *
 * The RTT *data* sources keep working the same way either way: they are plain
 * TCP streams, and this setting only decides who provides that TCP endpoint.
 */
export type MemoryDriver = 'openocd' | 'jlink'

/** SEGGER J-Link software configuration (used when `driver` is `jlink`). */
export interface JLinkConfig {
  /**
   * Path to `JLinkGDBServerCL.exe` (or `JLink.exe`).
   *
   * EMPTY BY DEFAULT: the plugin assumes no installation layout and no PATH
   * entry. A bare name is resolved through `PATH`; a full path is used as-is.
   */
  executable: string
  /**
   * `-device` value handed to J-Link (`STM32F407VG`, `Cortex-M4`, …).
   *
   * Free text on purpose: J-Link's device list is far larger than any enum this
   * plugin could ship, and an unknown name is reported by J-Link itself.
   */
  device: string
  /** `-if` value: SWD or JTAG. */
  targetInterface: 'SWD' | 'JTAG'
  /** `-speed` in kHz. `0` leaves J-Link's default alone. */
  speedKhz: number
  /** GDB server port (`-port`); the memory reader connects here. */
  gdbPort: number
  /** J-Link's RTT TELNET port (`-RTTTelnetPort`). */
  rttTelnetPort: number
  /** `-select usb=<serial>`: empty means the default probe. */
  serial: string
  /**
   * Leave the target RUNNING when the plugin connects.
   *
   * Default `true` because this is a live-data panel: a halted core stops
   * producing RTT, so the default debugger behaviour (halt on connect) would
   * make the waveform freeze the moment the panel attached. J-Link's own
   * `-nohalt` keeps the target executing and memory reads still work through
   * the probe's background access.
   */
  keepTargetRunning: boolean
  /** Spawn J-Link when nothing is listening; `false` attaches only. */
  autoStart: boolean
  /** Extra command-line arguments appended verbatim, in order. */
  extraArgs: string[]
  /** Milliseconds to wait for the GDB/TELNET ports after spawning. */
  startupTimeoutMs: number
}

/** OpenOCD process and RTT server configuration. */
export interface OpenOcdConfig {
  /**
   * `auto` spawns `openocd` when the ports are closed and attaches when they
   * are already open; `attach` never spawns (bring your own OpenOCD).
   */
  mode: OpenOcdMode
  /**
   * Path to `openocd.cfg`.
   *
   * EMPTY BY DEFAULT, and that is deliberate: the plugin ships no config file
   * and assumes no installation layout. The first run asks for it; the value is
   * then persisted here. Relative paths resolve against the session workspace.
   */
  configPath: string
  /** OpenOCD executable. Bare `openocd` resolves through `PATH`. */
  executable: string
  /** Extra `-c` commands appended verbatim, in order. */
  extraCommands: string[]
  /** `adapter speed` in kHz; `0` leaves the config file's value alone. */
  adapterSpeedKhz: number
  /** TCL port used by the memory reader. */
  tclPort: number
  /** Milliseconds to wait for the RTT ports after spawning OpenOCD. */
  startupTimeoutMs: number
  /** Restart OpenOCD automatically after an unexpected exit. */
  autoRestart: boolean
}

/** RTT control block search parameters. */
export interface RttSearchConfig {
  /** Search base address. Generic default; override per target. */
  address: number
  /** Search window size in bytes. */
  size: number
  /** Control block identifier string. */
  idString: string
}

/** Variable-parser configuration for the RTT data channel. */
export interface ParserConfig {
  /** Registry id: `csv` | `keyvalue` | `binary-frame` | `custom-regex`. */
  id: string
  /** Parser-specific options (delimiter, fields, pattern…). */
  options: Record<string, unknown>
}

/** One memory binding for the OCD reader — either auto-resolved or manual. */
export interface OcdVariableConfig {
  /**
   * `symbol` resolves through the ELF symbol table; `manual` uses the literal
   * address below and needs no ELF at all.
   */
  source: 'symbol' | 'manual'
  /** Symbol name (for `symbol`) — the series is named after it. */
  symbol?: string
  /** Display name override; defaults to the symbol name. */
  name?: string
  /** Address for `manual` bindings, and the resolved address for `symbol`. */
  address?: number
  /** Scalar type. Required for `manual`; inferred for `symbol` when absent. */
  type?: ScalarType
  /** Engineering unit, for display only. */
  unit?: string
}

/** OCD reader (data source 3) configuration. */
export interface OcdConfig {
  enabled: boolean
  /** ELF file used to resolve symbol addresses. Empty = manual bindings only. */
  elfPath: string
  /** `nm` executable used to read the ELF. Bare name resolves via `PATH`. */
  nmPath: string
  /** Poll period in ms. */
  intervalMs: number
  /** Read each value twice and drop the sample when the two differ. */
  verifyConsistency: boolean
  /** Merge bindings within this many bytes into one memory read; 0 disables. */
  batchDistanceBytes: number
  /** The bindings to sample. */
  variables: OcdVariableConfig[]
}

/** Log channel configuration. */
export interface LogConfig {
  enabled: boolean
  /** Ring capacity in lines. */
  maxLines: number
}

/** Variable channel + series-store configuration. */
export interface VariableConfig {
  /** RTT data channel binding. */
  enabled: boolean
  /** Decimation rate applied to every series, in Hz. `0` keeps every sample. */
  sampleRateHz: number
  /** Series history window, in minutes. */
  retentionMinutes: number
  /** Hard per-series point cap. */
  maxPointsPerSeries: number
}

/** A complete, switchable configuration set. */
export interface DeviceProfile {
  id: string
  name: string
  /** Who owns the debug connection: OpenOCD (TCL) or J-Link (GDB + TELNET). */
  driver: MemoryDriver
  openocd: OpenOcdConfig
  jlink: JLinkConfig
  rtt: RttSearchConfig
  /** Channel 0 by convention: the terminal/log stream. */
  log: LogConfig & { binding: ChannelBinding }
  /** Channel 1 by convention: structured variable data. */
  variables: VariableConfig & { binding: ChannelBinding; parser: ParserConfig }
  ocd: OcdConfig
}

/** The plugin's top-level configuration document. */
export interface PluginConfig {
  /** Active profile id. */
  activeProfile: string
  /** Every saved profile. */
  profiles: DeviceProfile[]
}

/** The RTT channel that carries the human-readable log. */
export const DEFAULT_LOG_CHANNEL = 0
/** The RTT channel that carries structured variable data. */
export const DEFAULT_VARIABLE_CHANNEL = 1
/** Conventional port for the log RTT server. */
export const DEFAULT_LOG_PORT = 9090
/** Conventional port for the variable RTT server. */
export const DEFAULT_VARIABLE_PORT = 9091
/** Conventional OpenOCD TCL port. */
export const DEFAULT_TCL_PORT = 6666
/** Default GDB server port for the J-Link backend. */
export const DEFAULT_JLINK_GDB_PORT = 2331
/** Default J-Link RTT TELNET port (SEGGER's documented default). */
export const DEFAULT_JLINK_RTT_TELNET_PORT = 19021
/** A generic starting profile.
 *
 * Absolutely no chip-specific values: the address/size pair is merely the
 * common `.data`/`.bss` region on a 32-bit part, and the user is expected to
 * adjust all three RTT fields for their target.
 */
export function createDefaultProfile(id = 'default', name = 'Default'): DeviceProfile {
  return {
    id,
    name,
    driver: 'openocd',
    openocd: {
      mode: 'auto',
      configPath: '',
      executable: 'openocd',
      extraCommands: [],
      adapterSpeedKhz: 0,
      tclPort: DEFAULT_TCL_PORT,
      startupTimeoutMs: 6000,
      autoRestart: true,
    },
    jlink: {
      // No assumed installation path: the first run asks for it, exactly like
      // the OpenOCD config path. A tool present on PATH still works.
      executable: '',
      device: '',
      targetInterface: 'SWD',
      speedKhz: 0,
      gdbPort: DEFAULT_JLINK_GDB_PORT,
      rttTelnetPort: DEFAULT_JLINK_RTT_TELNET_PORT,
      serial: '',
      keepTargetRunning: true,
      autoStart: true,
      extraArgs: [],
      startupTimeoutMs: 8000,
    },
    rtt: { address: 0x2000_0000, size: 0x1000, idString: 'SEGGER RTT' },
    log: {
      enabled: true,
      maxLines: 5000,
      binding: { port: DEFAULT_LOG_PORT, channel: DEFAULT_LOG_CHANNEL, enabled: true },
    },
    variables: {
      enabled: true,
      sampleRateHz: 10,
      retentionMinutes: 10,
      maxPointsPerSeries: 100_000,
      binding: { port: DEFAULT_VARIABLE_PORT, channel: DEFAULT_VARIABLE_CHANNEL, enabled: true },
      parser: { id: 'csv', options: {} },
    },
    ocd: {
      enabled: false,
      elfPath: '',
      nmPath: 'arm-none-eabi-nm',
      intervalMs: 100,
      verifyConsistency: true,
      batchDistanceBytes: 64,
      variables: [],
    },
  }
}

export function createDefaultConfig(): PluginConfig {
  return { activeProfile: 'default', profiles: [createDefaultProfile()] }
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
export function migrateConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const doc = raw as Record<string, unknown>
  const profiles = doc['profiles']
  if (!Array.isArray(profiles)) return raw
  const fresh = createDefaultProfile()
  for (const entry of profiles) {
    if (typeof entry !== 'object' || entry === null) continue
    const profile = entry as Record<string, unknown>
    if (profile['driver'] !== 'openocd' && profile['driver'] !== 'jlink') {
      profile['driver'] = fresh.driver
    }
    if (typeof profile['jlink'] !== 'object' || profile['jlink'] === null) {
      profile['jlink'] = structuredClone(fresh.jlink)
    } else {
      // A partially written block (an older beta, a hand-edited file) must not
      // leave holes that later reads would treat as `undefined` settings.
      const jlink = profile['jlink'] as Record<string, unknown>
      for (const [key, value] of Object.entries(fresh.jlink)) {
        if (jlink[key] === undefined) jlink[key] = structuredClone(value)
      }
    }
  }
  return doc
}

/**
 * Deep-clone a profile (profiles are edited through copies before saving).
 */
export function cloneProfile(profile: DeviceProfile): DeviceProfile {
  return structuredClone(profile)
}

/**
 * Find the active profile, falling back to the first one.
 * @throws when the configuration holds no profiles at all.
 */
export function activeProfileOf(config: PluginConfig): DeviceProfile {
  const found = config.profiles.find(p => p.id === config.activeProfile)
  if (found !== undefined) return found
  const first = config.profiles[0]
  if (first === undefined) throw new Error('configuration holds no device profiles')
  return first
}

/**
 * Where a given configuration field belongs when a setting is saved.
 *
 * This plugin's settings split along a real axis, not an arbitrary one:
 *
 *   - **TOOL PATHS ARE MACHINE-WIDE.** Where `openocd`, `JLinkGDBServerCL.exe`
 *     and `arm-none-eabi-nm` are installed is a property of THIS COMPUTER, not of
 *     the project. Storing them per workspace would make every new project ask
 *     for the same three paths again, and committing them into a repository would
 *     ship one developer's `C:\Program Files\...` to everyone else.
 *   - **EVERYTHING ELSE IS PROJECT-SCOPED.** Channel numbers, ports, the probe
 *     speed, the ELF, the watched variables, the parser: these describe a
 *     TARGET, and a repository is exactly the right place for them — they should
 *     travel with the code and be shareable with teammates.
 *
 * So a save writes BOTH layers at once: the tool-path subset to the global
 * profile patch, the remainder to `.dsh/rtt-debug.json` in the workspace.
 */

/** Key of a tool-path field, named so the two layers can be recombined later. */
export type ToolPathKey = 'openocdExecutable' | 'jlinkExecutable' | 'nmPath'

/** Machine-wide tool locations, lifted out of the per-project document. */
export interface ToolPaths {
  /** OpenOCD executable; bare `openocd` resolves through PATH. */
  openocdExecutable: string
  /** JLinkGDBServerCL.exe path; empty resolves through PATH. */
  jlinkExecutable: string
  /** `nm` executable used to read the ELF symbol table. */
  nmPath: string
}

/** The default tool locations, taken from the generic profile. */
export function defaultToolPaths(): ToolPaths {
  const profile = createDefaultProfile()
  return {
    openocdExecutable: profile.openocd.executable,
    jlinkExecutable: profile.jlink.executable,
    nmPath: profile.ocd.nmPath,
  }
}

/**
 * Extract the machine-wide tool paths from a configuration document.
 *
 * Reads from the active profile, because that is where the user edited them.
 */
export function extractToolPaths(config: PluginConfig): ToolPaths {
  let profile: DeviceProfile
  try {
    profile = activeProfileOf(config)
  } catch {
    return defaultToolPaths()
  }
  return {
    openocdExecutable: profile.openocd.executable,
    jlinkExecutable: profile.jlink.executable,
    nmPath: profile.ocd.nmPath,
  }
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
export function applyToolPaths(config: PluginConfig, paths: Partial<ToolPaths> | undefined): PluginConfig {
  const next = structuredClone(config)
  const resolved = { ...defaultToolPaths(), ...(paths ?? {}) }
  for (const profile of next.profiles) {
    profile.openocd.executable = resolved.openocdExecutable
    profile.jlink.executable = resolved.jlinkExecutable
    profile.ocd.nmPath = resolved.nmPath
  }
  return next
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
export function stripToolPaths(config: PluginConfig): PluginConfig {
  const next = structuredClone(config)
  const defaults = defaultToolPaths()
  for (const profile of next.profiles) {
    profile.openocd.executable = defaults.openocdExecutable
    profile.jlink.executable = defaults.jlinkExecutable
    profile.ocd.nmPath = defaults.nmPath
  }
  return next
}

/**
 * Validate a configuration document. *
 * Called on every load and on every update so a malformed profile (impossible
 * port, mismatched channel roles) is rejected at the boundary rather than
 * producing a confusing runtime failure later.
 *
 * @returns a list of human-readable problems; empty means valid.
 */
export function validateConfig(config: unknown): string[] {
  const problems: string[] = []
  if (typeof config !== 'object' || config === null) return ['configuration must be an object']
  const rec = config as Record<string, unknown>
  const profiles = rec['profiles']
  if (!Array.isArray(profiles) || profiles.length === 0) {
    problems.push('profiles must be a non-empty array')
    return problems
  }
  const seenIds = new Set<string>()
  for (const [i, raw] of profiles.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      problems.push(`profiles[${i}] must be an object`)
      continue
    }
    const p = raw as Record<string, unknown>
    const id = p['id']
    if (typeof id !== 'string' || id === '') problems.push(`profiles[${i}].id must be a non-empty string`)
    else if (seenIds.has(id)) problems.push(`profiles[${i}].id "${id}" is duplicated`)
    else seenIds.add(id)

    const log = p['log'] as Record<string, unknown> | undefined
    const vars = p['variables'] as Record<string, unknown> | undefined
    const logBinding = log?.['binding'] as Record<string, unknown> | undefined
    const varBinding = vars?.['binding'] as Record<string, unknown> | undefined

    for (const [label, binding] of [['log', logBinding], ['variables', varBinding]] as const) {
      if (binding === undefined) {
        problems.push(`profiles[${i}].${label}.binding is required`)
        continue
      }
      const port = binding['port']
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push(`profiles[${i}].${label}.binding.port must be an integer in 1..65535`)
      }
      const channel = binding['channel']
      if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0) {
        problems.push(`profiles[${i}].${label}.binding.channel must be a non-negative integer`)
      }
    }

    if (logBinding !== undefined && varBinding !== undefined) {
      if (logBinding['port'] === varBinding['port']) {
        problems.push(`profiles[${i}]: log and variables must not share a TCP port`)
      }
      if (logBinding['channel'] === varBinding['channel']) {
        // The two streams must be separable; one channel cannot serve both.
        problems.push(`profiles[${i}]: log and variables must use different RTT channels`)
      }
    }

    const ocd = p['ocd'] as Record<string, unknown> | undefined
    const interval = ocd?.['intervalMs']
    if (ocd !== undefined && (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0)) {
      problems.push(`profiles[${i}].ocd.intervalMs must be a positive number`)
    }

    /* J-Link backend: only validated when it is the selected driver. */
    const driver = p['driver']
    if (driver !== undefined && driver !== 'openocd' && driver !== 'jlink') {
      problems.push(`profiles[${i}].driver must be "openocd" or "jlink"`)
    }
    const jlink = p['jlink'] as Record<string, unknown> | undefined
    if (driver === 'jlink' || jlink !== undefined) {
      if (jlink === undefined) {
        problems.push(`profiles[${i}].jlink is required when driver is "jlink"`)
      } else {
        const gdbPort = jlink['gdbPort']
        if (typeof gdbPort !== 'number' || !Number.isInteger(gdbPort) || gdbPort < 1 || gdbPort > 65535) {
          problems.push(`profiles[${i}].jlink.gdbPort must be an integer in 1..65535`)
        }
        const telnetPort = jlink['rttTelnetPort']
        if (typeof telnetPort !== 'number' || !Number.isInteger(telnetPort) || telnetPort < 1 || telnetPort > 65535) {
          problems.push(`profiles[${i}].jlink.rttTelnetPort must be an integer in 1..65535`)
        }
        if (gdbPort === telnetPort) {
          problems.push(`profiles[${i}].jlink: the GDB port and the RTT TELNET port must differ`)
        }
        const iface = jlink['targetInterface']
        if (iface !== undefined && iface !== 'SWD' && iface !== 'JTAG') {
          problems.push(`profiles[${i}].jlink.targetInterface must be "SWD" or "JTAG"`)
        }
        const speed = jlink['speedKhz']
        if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0)) {
          problems.push(`profiles[${i}].jlink.speedKhz must be zero or a positive number`)
        }
        const args = jlink['extraArgs']
        if (args !== undefined && (!Array.isArray(args) || args.some(a => typeof a !== 'string'))) {
          problems.push(`profiles[${i}].jlink.extraArgs must be an array of strings`)
        }
      }
      // OpenOCD's config file is meaningless for this driver, so it is only
      // required when OpenOCD actually owns the connection.
      if (driver === 'jlink' && typeof jlink?.['device'] === 'string' && (jlink['device'] as string).trim() === '') {
        problems.push(`profiles[${i}].jlink.device is required when driver is "jlink"`)
      }
    }

    const variables = ocd?.['variables']
    if (ocd !== undefined && variables !== undefined) {
      if (!Array.isArray(variables)) {
        problems.push(`profiles[${i}].ocd.variables must be an array`)
      } else {
        for (const [j, v] of variables.entries()) {
          if (typeof v !== 'object' || v === null) {
            problems.push(`profiles[${i}].ocd.variables[${j}] must be an object`)
            continue
          }
          const entry = v as Record<string, unknown>
          const source = entry['source']
          if (source !== 'symbol' && source !== 'manual') {
            problems.push(`profiles[${i}].ocd.variables[${j}].source must be "symbol" or "manual"`)
          }
          if (source === 'symbol' && typeof entry['symbol'] !== 'string') {
            problems.push(`profiles[${i}].ocd.variables[${j}].symbol is required for source "symbol"`)
          }
          if (source === 'manual' && typeof entry['address'] !== 'number') {
            problems.push(`profiles[${i}].ocd.variables[${j}].address is required for source "manual"`)
          }
        }
      }
    }
  }
  return problems
}
