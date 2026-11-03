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

import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { probeTcp } from '../core/tcp-link.ts'
import type { DeviceProfile, JLinkConfig } from '../config.ts'

export type JLinkStatus =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'attached'; detail: string }
  | { kind: 'starting' }
  | { kind: 'running'; pid: number | undefined; attached: boolean }
  | { kind: 'error'; message: string; logTail?: string }

export interface JLinkManagerEvents {
  status: [status: JLinkStatus]
  /** Raw J-Link output lines, for diagnostics. */
  output: [line: string]
}

/** Cap on retained J-Link output, so a chatty process cannot grow memory. */
const LOG_TAIL_LINES = 200

/**
 * Candidate executable names, in the order a bare (PATH-less) config should
 * try them. JLinkGDBServerCL is preferred because it is the console build: it
 * writes to stdout and needs no window, which is what a spawned child wants.
 */
const DEFAULT_EXECUTABLES = ['JLinkGDBServerCL.exe', 'JLinkGDBServerCL', 'JLinkGDBServer.exe', 'JLinkGDBServer']

export class JLinkManager extends EventEmitter<JLinkManagerEvents> {
  private child?: ChildProcess
  private status: JLinkStatus = { kind: 'idle' }
  private readonly tail: string[] = []
  private disposed = false
  private stopping = false
  private workspaceRoot: string

  public constructor(workspaceRoot: string) {
    super()
    this.workspaceRoot = workspaceRoot
  }

  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root
  }

  public getStatus(): JLinkStatus {
    return this.status
  }

  public getLogTail(): string[] {
    return [...this.tail]
  }

  public get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Resolve the configured executable.
   *
   * A relative path resolves against the workspace root, like OpenOCD's config
   * path, so a profile can ship `tools/JLinkGDBServerCL.exe`. An empty value
   * yields the first {@link DEFAULT_EXECUTABLES} candidate.
   */
  public resolveExecutable(executable: string): string {
    const trimmed = executable.trim()
    if (trimmed === '') return DEFAULT_EXECUTABLES[0] as string
    return isAbsolute(trimmed) ? trimmed : resolve(this.workspaceRoot, trimmed)
  }

  /**
   * Bring the toolchain up: attach to an existing J-Link, or spawn one.
   *
   * @returns the status reached; `error` carries the reason plus J-Link's own
   *   output, because "J-Link failed" alone is never actionable.
   */
  public async start(profile: DeviceProfile): Promise<JLinkStatus> {
    this.disposed = false
    this.stopping = false

    const { jlink } = profile
    const gdbPort = jlink.gdbPort
    const telnetPort = jlink.rttTelnetPort

    this.setStatus({ kind: 'probing' })

    // Attach when either J-Link endpoint already answers: another J-Link (or
    // J-Link RTT Viewer) already owns the probe.
    const gdbOpen = await probeTcp('127.0.0.1', gdbPort, 400)
    const telnetOpen = await probeTcp('127.0.0.1', telnetPort, 400)
    if (gdbOpen || telnetOpen) {
      const detail = gdbOpen
        ? `attached to an existing J-Link GDB server on port ${gdbPort}`
        : `attached to an existing J-Link RTT TELNET channel on port ${telnetPort}`
      const status: JLinkStatus = { kind: 'attached', detail }
      this.setStatus(status)
      return status
    }

    if (!jlink.autoStart) {
      const status: JLinkStatus = {
        kind: 'error',
        message: `no J-Link is listening (checked GDB port ${gdbPort} and RTT TELNET port ${telnetPort}) and the profile is attach-only`,
      }
      this.setStatus(status)
      return status
    }

    if (jlink.device.trim() === '') {
      const status: JLinkStatus = {
        kind: 'error',
        message: 'no J-Link target device configured — set one for this device profile',
      }
      this.setStatus(status)
      return status
    }

    const executable = this.resolveExecutable(jlink.executable)
    // Verify the launcher BEFORE spawning, and always — not only for an
    // explicit path. An empty config means "find it on PATH", so a missing
    // J-Link would otherwise surface as a bare `spawn EPERM/ENOENT` from the
    // OS, which names no cause and no fix. `resolveOnPath` reports the
    // difference between "not installed" and "installed but not runnable".
    const resolved = await this.resolveOnPath(executable)
    if (resolved === undefined) {
      const tried = jlink.executable.trim() === '' ? DEFAULT_EXECUTABLES.join(', ') : executable
      const status: JLinkStatus = {
        kind: 'error',
        message: `J-Link software not found (tried ${tried}). Set the JLinkGDBServerCL.exe path in Variable Sources, or install the SEGGER J-Link Software Pack.`,
      }
      this.setStatus(status)
      return status
    }

    const args = this.buildArgs(jlink)
    this.setStatus({ kind: 'starting' })

    let child: ChildProcess
    try {
      child = spawn(resolved, args, { windowsHide: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status: JLinkStatus = {
        kind: 'error',
        message: `failed to launch "${resolved}": ${message}`,
      }
      this.setStatus(status)
      return status
    }
    this.child = child
    this.tail.length = 0

    const capture = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const trimmed = line.trimEnd()
        if (trimmed === '') continue
        this.tail.push(trimmed)
        if (this.tail.length > LOG_TAIL_LINES) this.tail.shift()
        this.emit('output', trimmed)
      }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    child.on('error', (error: Error) => {
      this.setStatus({ kind: 'error', message: error.message, logTail: this.tail.join('\n') })
    })

    child.on('exit', (code, signal) => {
      this.child = undefined
      if (this.disposed || this.stopping) {
        this.setStatus({ kind: 'idle' })
        return
      }
      const reason = `J-Link exited (${signal !== null ? `signal ${signal}` : `code ${String(code)}`})`
      this.setStatus({ kind: 'error', message: reason, logTail: this.tail.join('\n') })
    })

    const ready = await this.waitForPorts(jlink, jlink.startupTimeoutMs)
    if (!ready) {
      const status: JLinkStatus = {
        kind: 'error',
        message: `J-Link did not open its GDB and RTT ports within ${jlink.startupTimeoutMs} ms`,
        logTail: this.tail.join('\n'),
      }
      this.setStatus(status)
      // Leave the process alive for inspection; the caller decides to stop it.
      return status
    }

    const status: JLinkStatus = { kind: 'running', pid: child.pid, attached: false }
    this.setStatus(status)
    return status
  }

  /** Stop a spawned process. An attached external J-Link is left alone. */
  public async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      this.setStatus({ kind: 'idle' })
      return
    }
    await new Promise<void>(resolvePromise => {
      const done = (): void => resolvePromise()
      child.once('exit', done)
      try {
        child.kill()
      } catch {
        done()
      }
      // Never hang the caller on a wedged process.
      setTimeout(done, 3000).unref?.()
    })
    this.setStatus({ kind: 'idle' })
  }

  /** Permanently release: stop the process and refuse further restarts. */
  public async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
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
  public buildArgs(jlink: JLinkConfig): string[] {
    const args: string[] = []

    args.push('-device', jlink.device.trim())
    args.push('-if', jlink.targetInterface)
    if (jlink.speedKhz > 0) args.push('-speed', String(jlink.speedKhz))
    args.push('-port', String(jlink.gdbPort))
    args.push('-RTTTelnetPort', String(jlink.rttTelnetPort))
    if (jlink.serial.trim() !== '') {
      // Documented form (V8.24+): `-USB <SerialNo / Nickname>`.
      args.push('-USB', jlink.serial.trim())
    }
    // Keep the target running: a halted core stops emitting RTT.
    if (jlink.keepTargetRunning !== false) {
      args.push('-nohalt')
      // `-noir` skips the initial register read, which is what makes GDB halt
      // the core on connect.
      args.push('-noir')
    }
    // Console behaviour: no window, no per-session log files, no GUI chatter.
    args.push('-nogui')
    args.push('-silent')
    args.push('-nologtofile')

    for (const extra of jlink.extraArgs) {
      const trimmed = extra.trim()
      if (trimmed !== '') args.push(trimmed)
    }
    return args
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
  private async resolveOnPath(executable: string): Promise<string | undefined> {
    const candidates = executable.trim() === '' ? DEFAULT_EXECUTABLES : [executable]
    const pathDirs = (process.env['PATH'] ?? '').split(delimiter).filter(dir => dir !== '')
    for (const candidate of candidates) {
      if (isAbsolute(candidate)) {
        try {
          await access(candidate)
          return candidate
        } catch {
          continue
        }
      }
      for (const dir of pathDirs) {
        const full = resolve(dir, candidate)
        try {
          await access(full)
          return full
        } catch {
          // Next candidate.
        }
      }
      // Windows also honours PATHEXT-style names given without an extension.
      if (!/\.[A-Za-z0-9]+$/.test(candidate)) {
        for (const ext of ['.exe', '.cmd', '.bat']) {
          for (const dir of pathDirs) {
            const full = resolve(dir, candidate + ext)
            try {
              await access(full)
              return full
            } catch {
              // Next candidate.
            }
          }
        }
      }
    }
    return undefined
  }

  /** Poll until both the GDB and the RTT TELNET ports accept a connection. */
  private async waitForPorts(jlink: JLinkConfig, timeoutMs: number): Promise<boolean> {
    const wanted = [jlink.gdbPort, jlink.rttTelnetPort]
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.child === undefined && this.status.kind !== 'starting') return false
      const results = await Promise.all(wanted.map(port => probeTcp('127.0.0.1', port, 200)))
      if (results.every(Boolean)) return true
      if (this.child === undefined) return false
      await delay(150)
    }
    return false
  }

  private setStatus(status: JLinkStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
