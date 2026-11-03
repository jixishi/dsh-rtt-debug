---
name: rtt-debug
description: "Inspect, configure, and control the dsh-rtt-debug embedded debugging plugin via HTTP API. Use when the user or AI needs to configure observed variables (memory reads via OpenOCD or the SEGGER J-Link driver, plus the RTT data channel), switch the debug backend (openocd | jlink), select RTT parsers (CSV, KeyValue, Binary, Regex), start/stop sampling, clear waveforms or logs, or auto-discover firmware ELF/OpenOCD config files."
---

# RTT Debug Plugin (`dsh-rtt-debug`) AI Operation Guide

The `dsh-rtt-debug` plugin provides embedded target debugging with three independent, parallel data sources:
1. **RTT Log Channel (Source 1)**: RTT up-channel 0, lossless ring-buffered text log with ANSI color and log-level detection.
2. **RTT Data Channel (Source 2)**: RTT up-channel 1, structured real-time variable stream actively pushed by firmware, parsed by one of four pluggable parsers (`csv`, `keyvalue`, `binary-frame`, `custom-regex`).
3. **Variable Direct Read (Source 3)**: Host-driven periodic memory sampling, reading RAM addresses directly without firmware collaboration. Two interchangeable backends (see §2).

Base API URL: `http://127.0.0.1:<DSH Web port>/api/rtt-debug` (the port varies; read it from `DSH_WEB_URL`).
Pass `?sessionId=<sessionId>` to ensure workspace-relative paths resolve against the active session.

---

## 0. Choosing the debug backend (`driver`)

Each device profile has a `driver` field: `"openocd"` (default) or `"jlink"`. It decides who owns the debug
connection and therefore how each source is reached:

| | `driver: "openocd"` | `driver: "jlink"` |
|---|---|---|
| RTT log + data channels | OpenOCD `rtt server start <port> <channel>` → TCP per channel (default 9090 / 9091) | SEGGER TELNET port (default **19021**); **one connection per channel**, channel chosen by `$$SEGGER_TELNET_ConfigStr=RTTCh;<n>;$$` sent within 100 ms of connecting |
| Variable direct read | OpenOCD TCL port (default 6666), `mdw`/`mdh`/`mdb` | **GDB remote serial protocol** (default 2331), raw `m<addr>,<len>` packets |

`GET /state` reports which backend is live in the `driver` field, and `openocd` holds that backend's status
(the key name is historical; with `driver: "jlink"` it carries the J-Link status).

### 0.1 Configuring the J-Link backend

```http
POST /api/rtt-debug/config?sessionId=<sessionId>
Content-Type: application/json

{
  "config": {
    "activeProfile": "default",
    "profiles": [{
      "id": "default",
      "name": "Default",
      "driver": "jlink",
      "jlink": {
        "executable": "C:/Program Files/SEGGER/JLink/JLinkGDBServerCL.exe",
        "device": "STM32F407VG",
        "targetInterface": "SWD",
        "speedKhz": 4000,
        "gdbPort": 2331,
        "rttTelnetPort": 19021,
        "serial": "",
        "keepTargetRunning": true,
        "autoStart": true,
        "extraArgs": [],
        "startupTimeoutMs": 8000
      }
    }]
  }
}
```

Field notes that prevent real failures:

- **`executable`** — empty means "look on PATH". Leaving it empty on a machine without the SEGGER pack now
  produces an actionable error naming the candidates; it does not fall through to an opaque `spawn EPERM`.
- **`serial`** — becomes `-USB <serial>`. Do **not** use `-select usb=<serial>` (not a GDB Server option) or
  `-SelectEmuBySN` (explicitly rejected by GDB Server).
- **`keepTargetRunning`** — default `true`, which passes `-nohalt -noir`. **Keep it true for live data**: a
  debugger that halts the core on connect also stops the firmware from producing RTT, so the waveform freezes.
- **Do not** try to pass an RTT search range as a launch flag on the J-Link path: `-RTTSearchRanges` belongs to
  JLinkRTTLogger / J-Scope and GDB Server rejects it. The plugin sends the profile's `rtt.address` + `rtt.size`
  as `SetRTTSearchRanges` inside the per-connection TELNET config string instead.
- **Persistence**: on DSH 0.2.x the save writes this entry's config into the active profile's
  `cordis.patch.yml`. A save is only durable when the response reports `"persisted": true`; when it is `false`,
  read `persistError` — do not assume the configuration survived.

### 0.2 Reader limitation the plugin reports honestly

SEGGER does not document whether its RTT TELNET port accepts several simultaneous clients. If a channel
connects and is then closed **without ever delivering a byte** while the other channel is still open, the plugin
stops retrying that channel and sets `state.jlinkNotice` explaining that this J-Link appears to serve one TELNET
channel at a time. Treat that field as the authoritative answer instead of retrying blindly.

---

## 1. Data Source 2: RTT Data Channel (`rttVar`) Protocol & Configuration

Unlike direct memory polling, the RTT Data Channel receives variable frames actively transmitted by the target firmware.

> ⚠️ The `csv` parser treats a first line whose fields are ALL non-numeric as a **header**. A stream that starts
> with `temp=21.5,volt=3.31` is therefore read as two columns named `temp=21.5` / `volt=3.31` and yields **no
> samples**. Emit a real header (`temp,volt`) or use the `keyvalue` parser for `key=value` lines.

### 1.1 Parsers (four built in, plus the script escape hatch)
The active parser is selected by `variables.parser.id` in the profile:

| Parser ID | Framing | Firmware Output Example | Description |
|---|---|---|---|
| `csv` (default) | Line (`\n` / `\r\n`) | `12007,3,25\n` or `volt,amps\n12007,3\n` | Comma/tab/space delimited numbers. Supports optional header (`hasHeader: 'auto'`), custom `delimiter`, column names, and inline units (`12007 mV,3 A`). |
| `keyvalue` | Line (`\n`) | `volt=12007 mV amps=3 running=true\n` | `key=value` or `key: value` pairs. Each pair yields an independent sample. Booleans (`true/false/on/off/high/low`) automatically map to boolean curves. |
| `binary-frame` | Fixed size or length field | Packed binary bytes (e.g. C struct) | High-speed binary telemetry. Requires `options.frameLength` or `options.lengthField`, `endianness` (`little`/`big`), and `options.fields` definitions (`u8`, `u16`, `i16`, `u32`, `i32`, `f32`, `f64`, `bool`). |
| `custom-regex` | Line regex match | e.g. `DATA: V=(?<volt>\d+) I=(?<amps>\d+)` | Regex with named capture groups mapping to series names. Unnamed groups are ignored. |
| `script` | Line | any text | **User expression** per record, see §1.3. |

### 1.2 Editable framing (all line parsers)

| Option | Field | Values |
|---|---|---|
| Delimiter | `delimiter` | `,` (default), `;`, `\t`, or a space (whitespace runs) |
| Record terminator | `lineTerminator` | `\n` (default), `\r`, `\r\n`, `\t`, `\0`, or a literal character |

The terminator is genuinely configurable: `decodeTerminator` turns the escape
spelling into real characters, and a CR immediately before the terminator is
still stripped so both `\n` and `\r\n` streams frame correctly.

### 1.3 The `script` parser — an expression, not a script

```json
{ "id": "script", "options": {
    "delimiter": ",",
    "lineTerminator": "\\n",
    "skipFirstLine": true,
    "expression": "{ volt: fields[0] * 3.3 / 4095, amps: fields[1] / 1000 }"
} }
```

Available names: `fields`, `line`, `index`, `Number`, `Math`. The expression must
evaluate to an object; each numeric/boolean property becomes one series.

**Security boundary — do not try to work around it.** This runs in the host
process, so the compiler accepts a closed grammar only: a character allow-list,
then a deny-list (`constructor`, `prototype`, `require`, `import`, `process`,
`globalThis`, `this`, `eval`, `Function`, arrow functions, `;` statement lists),
then per-identifier validation. Twelve real escape attempts are pinned as
must-refuse in `test/parsers-edit.test.ts`. There is no file or network access,
and no way to reach a global object. A record that throws is skipped; the stream
continues.

### 1.4 Configuring the RTT Data Parser via API
To switch or configure the RTT data parser, submit a patch to `/config`:

```http
POST /api/rtt-debug/config?sessionId=<sessionId>
Content-Type: application/json

{
  "config": {
    "profiles": [
      {
        "id": "default",
        "variables": {
          "enabled": true,
          "binding": { "port": 9091, "channel": 1, "enabled": true },
          "parser": {
            "id": "csv",
            "options": {
              "delimiter": ",",
              "hasHeader": "auto"
            }
          }
        }
      }
    ]
  },
  "target": "workspace"
}
```

---

## 2. Data Source 3: Variable Direct Read (`ocd`)

Host-side periodic memory polling. Which transport is used depends on the profile's `driver` (see §0):
OpenOCD's TCL port, or J-Link's GDB server. **The configuration shape is identical either way** — only who
answers the reads changes, because symbol resolution and poll timing are transport-independent.

### 2.1 Read Current Variables & Configuration
```http
GET /api/rtt-debug/variables?sessionId=<sessionId>
```

**Response Example:**
```json
{
  "enabled": true,
  "configPath": "mcu/openocd.cfg",
  "elfPath": "build/firmware.elf",
  "nmPath": "arm-none-eabi-nm",
  "intervalMs": 20,
  "variables": [
    { "name": "g_sys_tick_ms", "address": 536870912, "type": "u32" },
    { "name": "VoltMv", "address": 536870916, "type": "u16", "unit": "mV" }
  ],
  "configScope": "workspace",
  "workspaceFile": ".dsh/rtt-debug.json"
}
```

### 2.2 Configure Observed Variables (AI One-Shot Injection)
```http
POST /api/rtt-debug/variables?sessionId=<sessionId>
Content-Type: application/json

{
  "variables": [
    "g_sys_tick_ms",
    "g_bms_cache",
    "VoltMv@0x20000000:u16",
    "0x20000004:u32:CurrentMa",
    { "name": "tempC", "address": "0x20000008", "type": "i16", "unit": "℃" }
  ],
  "intervalMs": 10,
  "enabled": true,
  "target": "workspace"
}
```

**Variable Format Guidelines:**
- **Bare symbol names** (`"g_sys_tick_ms"`): Auto-resolved from `elfPath` via `nm`. Symbol types are inferred using `resolveSymbolType` (preserving signedness like `_i16` and float `f*`).
- **Manual Form A** (`name@address:type`): `"VoltMv@0x20000000:u16"`.
- **Manual Form B** (`address:type:name`): `"0x20000000:u16:VoltMv"`.
- **Structured Object**: `{ "name": "tempC", "address": "0x20000008", "type": "i16", "unit": "℃" }`.
- **Sampling Interval (`intervalMs`)**: Supports positive floating point numbers (e.g. `0.5`, `2.5`, `10`, `100`).
- **Persistence**: one save writes BOTH layers — the three tool paths
  (`openocdExecutable`, `jlinkExecutable`, `nmPath`) go to the GLOBAL config
  because they describe this machine; everything else goes to the workspace's
  `.dsh/rtt-debug.json` because it describes the target. `target` is accepted for
  compatibility but no longer selects one layer: neither layer is skipped, so a
  half-saved change cannot happen. Check `persisted` / `persistError`.

> **Symbol roster is globals-only.** `/symbols` lists GLOBAL data symbols: `nm`
> prints uppercase letters (`B`/`D`/`G`/`R`/`S`) for globals and lowercase for
> file-local `static`. A `static` is a private copy in one translation unit, so
> sampling it usually reads a value the running code never writes. Pass
> `{"globalsOnly": false}` to inspect statics deliberately.

---

## 3. Real-Time Sampling & Buffer Control APIs

### 3.1 Start Sampling
Activates enabled links (OpenOCD, RTT Log 9090, RTT Data 9091, OCD polling):
```http
POST /api/rtt-debug/start?sessionId=<sessionId>
Content-Type: application/json

{}
```

### 3.2 Stop Sampling
```http
POST /api/rtt-debug/stop?sessionId=<sessionId>
Content-Type: application/json

{}
```

### 3.3 Clear Waveform & Log Buffers
Clears in-memory data and emits a real-time WebSocket reset event to the frontend:
```http
POST /api/rtt-debug/clear?sessionId=<sessionId>
Content-Type: application/json

{ "what": "all" }
```
- `what`: `"all"` (waveform series + log buffer), `"series"` (waveform series only), or `"log"` (RTT log buffer only).

### 3.4 State & Snapshot Inspection
- `GET /api/rtt-debug/state?sessionId=<sessionId>`: Live status of the active backend, RTT log link, RTT data link, and the memory reader. Also reports `driver` (`openocd` | `jlink`) and, when a J-Link limitation was observed, `jlinkNotice`.
- `GET /api/rtt-debug/snapshot?sessionId=<sessionId>`: Full snapshot including all ingested series points, descriptors, and log lines.
- `GET /api/rtt-debug/export?sessionId=<sessionId>`: Raw text export of retained RTT log lines.

> **Waveform view controls** are client-side and not part of the HTTP API: the time-axis division count
> (default 50, range 2–200) is a toolbar input, and wheel zoom spans 0.1 s … 24 h.

---

## 4. Workspace File Discovery APIs

AI agents can discover target binaries and OpenOCD scripts in the workspace:
```http
GET /api/rtt-debug/fs/discover?type=openocd&sessionId=<sessionId>
GET /api/rtt-debug/fs/discover?type=elf&sessionId=<sessionId>
```
- `openocd`: Discovers `*.cfg` files.
- `elf`: Discovers `*.elf`, `*.axf`, `*.out` files.

---

## 5. Typical Workflow Example (AI Automation Script)

```python
import requests

BASE = "http://127.0.0.1:3080/api/rtt-debug"

# 1. Discover firmware ELF & OpenOCD config in workspace
files = requests.get(f"{BASE}/fs/discover?type=all").json()["files"]
elf_file = next((f["relPath"] for f in files if f["name"].endswith(".elf")), "build/firmware.elf")
cfg_file = next((f["relPath"] for f in files if f["name"].endswith(".cfg")), "mcu/openocd.cfg")

# 2. Configure OCD variables and sampling interval (save to workspace .dsh)
requests.post(f"{BASE}/variables", json={
    "configPath": cfg_file,
    "elfPath": elf_file,
    "variables": ["g_sys_tick_ms", "g_bms_cache", "0x20000000:u16:VoltMv"],
    "intervalMs": 10,
    "enabled": True,
    "target": "workspace"
})

# 3. Start sampling
requests.post(f"{BASE}/start")

# 4. Check live state
state = requests.get(f"{BASE}/state").json()
print("OpenOCD status:", state["openocd"]["kind"])
print("Active series:", [s["id"] for s in state["sources"]])
```
