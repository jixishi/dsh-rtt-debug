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

import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { probeTcp } from '../core/tcp-link.ts'
import type { DeviceProfile } from '../config.ts'

export type OpenOcdStatus =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'attached'; detail: string }
  | { kind: 'starting' }
  | { kind: 'running'; pid: number | undefined; attached: boolean }
  | { kind: 'error'; message: string; logTail?: string }

export interface OpenOcdManagerEvents {
  status: [status: OpenOcdStatus]
  /** Raw OpenOCD stderr/stdout lines, for diagnostics. */
  output: [line: string]
}

/** Cap on retained OpenOCD output, so a chatty process cannot grow memory. */
const LOG_TAIL_LINES = 200

export class OpenOcdManager extends EventEmitter<OpenOcdManagerEvents> {
  private child?: ChildProcess
  private status: OpenOcdStatus = { kind: 'idle' }
  private readonly tail: string[] = []
  private disposed = false
  private stopping = false
  /** Workspace root that relative config paths resolve against. */
  private workspaceRoot: string

  public constructor(workspaceRoot: string) {
    super()
    this.workspaceRoot = workspaceRoot
  }

  /** Keep the workspace root current (it changes when the session does). */
  public setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root
  }

  public getStatus(): OpenOcdStatus {
    return this.status
  }

  /** Recent OpenOCD output, oldest first — shown when startup fails. */
  public getLogTail(): string[] {
    return [...this.tail]
  }

  public get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Resolve a configured config path to an absolute one.
   *
   * A relative path is deliberately resolved against the workspace root rather
   * than the process CWD, so the same profile works regardless of where the
   * host process was launched.
   */
  public resolveConfigPath(configPath: string): string {
    const trimmed = configPath.trim()
    if (trimmed === '') return ''
    return isAbsolute(trimmed) ? trimmed : resolve(this.workspaceRoot, trimmed)
  }

  /**
   * Bring the toolchain up: attach to an existing OpenOCD, or spawn one.
   *
   * @returns the status reached; `error` carries the reason plus OpenOCD's own
   *   output, because "OpenOCD failed" alone is never actionable.
   */
  public async start(profile: DeviceProfile): Promise<OpenOcdStatus> {
    this.disposed = false
    this.stopping = false

    const logPort = profile.log.binding.port
    const varPort = profile.variables.binding.port

    this.setStatus({ kind: 'probing' })

    // Attach when the log server already answers: another OpenOCD owns the probe.
    const logOpen = profile.log.binding.enabled ? await probeTcp('127.0.0.1', logPort, 400) : false
    const tclOpen = await probeTcp('127.0.0.1', profile.openocd.tclPort, 400)
    if (logOpen || tclOpen) {
      const detail = logOpen
        ? `attached to an existing RTT server on port ${logPort}`
        : `attached to an existing OpenOCD on TCL port ${profile.openocd.tclPort}`
      const status: OpenOcdStatus = { kind: 'attached', detail }
      this.setStatus(status)
      return status
    }

    if (profile.openocd.mode === 'attach') {
      const status: OpenOcdStatus = {
        kind: 'error',
        message: `no OpenOCD is listening (checked port ${logPort} and TCL ${profile.openocd.tclPort}) and the profile is set to attach-only`,
      }
      this.setStatus(status)
      return status
    }

    const configPath = this.resolveConfigPath(profile.openocd.configPath)
    if (configPath === '') {
      const status: OpenOcdStatus = {
        kind: 'error',
        message: 'no OpenOCD config file configured — set one for this device profile',
      }
      this.setStatus(status)
      return status
    }
    try {
      await access(configPath)
    } catch {
      const status: OpenOcdStatus = { kind: 'error', message: `OpenOCD config file not found: ${configPath}` }
      this.setStatus(status)
      return status
    }

    const args = this.buildArgs(profile, configPath)
    this.setStatus({ kind: 'starting' })

    let child: ChildProcess
    try {
      child = spawn(profile.openocd.executable, args, { windowsHide: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status: OpenOcdStatus = {
        kind: 'error',
        message: `failed to launch "${profile.openocd.executable}": ${message}`,
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
      const reason = `OpenOCD exited (${signal !== null ? `signal ${signal}` : `code ${String(code)}`})`
      this.setStatus({ kind: 'error', message: reason, logTail: this.tail.join('\n') })
    })

    const ready = await this.waitForPorts(profile, profile.openocd.startupTimeoutMs)
    if (!ready) {
      const status: OpenOcdStatus = {
        kind: 'error',
        message: `OpenOCD did not open its RTT ports within ${profile.openocd.startupTimeoutMs} ms`,
        logTail: this.tail.join('\n'),
      }
      this.setStatus(status)
      // Leave the process alive for inspection; the caller decides to stop it.
      return status
    }

    const status: OpenOcdStatus = { kind: 'running', pid: child.pid, attached: false }
    this.setStatus(status)
    return status
  }

  /** Stop a spawned process. An attached external OpenOCD is left alone. */
  public async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      this.setStatus({ kind: 'idle' })
      return
    }
    await new Promise<void>(resolve => {
      const done = (): void => resolve()
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
   * Build the OpenOCD argument vector.
   *
   * The RTT setup and each enabled server are passed as `-c` commands so a
   * user's config file only has to describe the probe and target — the
   * plugin owns the RTT side, which is what makes the same config file usable
   * from a plain terminal session too.
   */
  public buildArgs(profile: DeviceProfile, configPath: string): string[] {
    const args = ['-f', configPath]
    const { openocd, rtt } = profile

    if (openocd.adapterSpeedKhz > 0) {
      args.push('-c', `adapter speed ${openocd.adapterSpeedKhz}`)
    }
    for (const extra of openocd.extraCommands) {
      const trimmed = extra.trim()
      if (trimmed !== '') args.push('-c', trimmed)
    }

    args.push('-c', `rtt setup ${hex(rtt.address)} ${hex(rtt.size)} "${rtt.idString}"`)
    args.push('-c', 'rtt start')

    if (profile.log.binding.enabled) {
      args.push('-c', `rtt server start ${profile.log.binding.port} ${profile.log.binding.channel}`)
    }
    if (profile.variables.binding.enabled) {
      args.push('-c', `rtt server start ${profile.variables.binding.port} ${profile.variables.binding.channel}`)
    }
    return args
  }

  /** Poll until every enabled RTT port accepts a connection. */
  private async waitForPorts(profile: DeviceProfile, timeoutMs: number): Promise<boolean> {
    const wanted: number[] = []
    if (profile.log.binding.enabled) wanted.push(profile.log.binding.port)
    if (profile.variables.binding.enabled) wanted.push(profile.variables.binding.port)
    if (wanted.length === 0) return true

    const deadline = Date.now() + timeoutMs
    // The child may die during startup; stop polling once it is gone.
    while (Date.now() < deadline) {
      if (this.child === undefined && this.status.kind !== 'starting') return false
      const results = await Promise.all(wanted.map(port => probeTcp('127.0.0.1', port, 200)))
      if (results.every(Boolean)) return true
      if (this.child === undefined) return false
      await delay(150)
    }
    return false
  }

  private setStatus(status: OpenOcdStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

/** `0x`-prefixed lowercase hex, the spelling OpenOCD accepts. */
function hex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
