# 调研发现（findings）

> 本文件只记录**实测可复现的取证结果**与外部资料，不记录推测。
> 项目：DSH 侧边栏「RTT 日志 + 实时变量波形图」插件
> 工作目录：`W:\dsh-plugins\dsh-rtt-debug`
> 作者：JiXieShi
> 最后更新：初始调研

---

## 1. 需求原文（用户输入，逐字）

> 请实现侧边栏中的 RTT 日志和实时变量波形图功能。波形图需要支持标尺，并支持自定义添加图例，
> 也就是可选择指定变量；界面布局为上方波形图、下方 RTT 日志。请先对需求进行评估，并制定开发计划，
> 同时做好进度跟踪。对于上述需求及细节中缺失或不清楚的部分，请你补充确认；如有任何不清楚的地方，
> 请采用一问一答的方式向我提问。

**当前状态**：处于「需求评估 + 计划制定 + 提问确认」阶段，**尚未编写任何生产代码**。

---

## 2. 工作目录现状

| 项 | 实测值 | 取证命令 |
|---|---|---|
| 工作目录 | `W:\dsh-plugins\dsh-rtt-debug` | `Get-Location` |
| 目录内容 | **空**（0 个条目，递归计数 0） | `Get-ChildItem -Force -Recurse ... \| Measure-Object` |
| 是否 git 仓库 | 否（无 `.git`） | `Test-Path .\.git` |
| `W:\dsh-plugins` | 存放 6 个 `.tgz` 离线插件包 + `install.sh` + `README.md`，自身非 git 仓库 | `git -C W:\dsh-plugins status` → `not a git repository` |

结论：**本插件需从零开发**。

---

## 3. DSH 环境版本（可复现基线）

| 组件 | 版本 | 取证命令 |
|---|---|---|
| DSH | `0.1.5-rc.1` | `dsh --version` |
| Node.js | `v26.8.1` | `node --version` |
| pnpm | `11.21.0` | `pnpm --version` |
| Python | `3.7.9`（`C:\Users\RUNIC\AppData\Local\Programs\Python\Python37\python.exe`） | `python --version` |
| DSH_HOME | `C:\Users\RUNIC\.dsh` | `$env:DSH_HOME` |
| Web profile | `C:\Users\RUNIC\.dsh\profiles\web` | 目录存在性 |
| Web UI 地址 | `http://127.0.0.1:3080` | `$env:DSH_WEB_URL` |

安装的 profile bundles 见 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`（34 项，含
`dsh-better-sidebar`、`dsh-sentinel`、`dsh-file-review-tab`、`@nanmicoder/dsh-agent-teams` 等）。

---

## 4. 侧边栏集成 API（两条路径，已取证）

### 4.1 DSH 原生右侧栏 API（推荐主路径）

包位置：`C:\Users\RUNIC\.dsh\profiles\node_modules\@deepseek-ai\dsh-client-ui-sidebar-right\`
（同时存在于 `...\profiles\web\node_modules\...\dsh\node_modules\@deepseek-ai\` 下）

注册是**两阶段**（源：`lib/types/client/index.d.ts` 头注释逐字）：

> Tab types register in two stages: the type itself into `ctx.sidebarRightTabs`,
> its body into the keyed `sidebar.right.pane.tab` seat under the same kind.

关键类型（源：`lib/types/client/tab-registry.d.ts`）：

```ts
interface SidebarRightTabDefinition {
  readonly id: string           // 实现身份，唯一（包名最自然）；body/title 以此 id 注册
  readonly kind: string         // 类型判别符，openTab 按它点名
  readonly patterns?: readonly string[]   // 资源地址 glob；页面类型可省略
  readonly priority?: 'extension' | 'builtin' | 'fallback'  // 默认 extension
  readonly canOpen?: (address: string) => boolean
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightGuideEntry[]  // guide 页入口框
}
```

- 注册 API：`ctx.sidebarRightTabs.register(definition): () => void`
- 导航 API：`ctx.sidebarRight.openTab(kind, options?)` / `openResource(address, options?)`
- Body 注册槽（源：`contract/slots.d.ts`）：
  - `'sidebar.right.pane.tab'`（`kind: 'keyed'`, `scope: 'session'`，`inject: SidebarRightTabInjected`）
  - `'sidebar.right.pane.tab.title'`（可选，动态标题）
  - `'sidebar.right.tab.menu.item'`（list，tab 右键菜单项）
- 地址方案：`dsh-resource://...`；含 `:` 的 glob 匹配**整个**地址，否则匹配 URI 的 path。

> `priority: 'extension'` 是默认值，且是「外部插件」最高优先级档，可覆盖 builtin kind。

### 4.2 dsh-better-sidebar 旧 API（兼容路径，已在装）

包位置：`C:\Users\RUNIC\.dsh\profiles\web\node_modules\dsh-better-sidebar`（v0.19.1）

- 服务：`ctx.betterSidebar.registerTab(descriptor)` / `registerFileViewer(...)`
- 描述符：`TabDescriptor`（源：`lib/types/client/service.d.ts`）
- `inject = ['slots', 'sessions', 'locale', 'modules', 'connection']`（client 半）
- ⚠️ README §「已适配 DSH 原生侧边栏 API」明确：v0.19.0 起**每个 tab 类型注册成原生 tab**，
  插件不再自绘右侧面板。→ 新插件应直接对齐桥接层，或走原生 API。

参考实现（同为第三方插件、已在本机安装）：`dsh-file-review-tab@0.5.0`
- `package.json` 声明 `dsh.client.inject` 含 `dsh-better-sidebar`
- `dsh.bundle.patch` → `cordis.patch.yml` 里 `insert` 一行 `{ id: file-review-tab, name: 'dsh-file-review-tab' }`

### 4.3 插件包结构与构建工具链

> ⚠️ **2026-10 修正**：早期结论「npm registry 不可达、禁止引入新依赖」**是错的**。
> 真实原因是 **npm 默认缓存目录在沙箱外**（`C:\Users\RUNIC\scoop\persist\nodejs\cache`），
> 导致 `EPERM: operation not permitted, open '..._cacache\tmp\***'`。
> 用户提示「npm可以构建」后复测，改用**工作区内缓存目录**即完全正常。

| 事实 | 实测（修正后） | 取证命令 |
|---|---|---|
| npm registry 可达 | ✅ **PONG 899ms** | `npm ping` |
| registry 地址 | `https://registry.npmjs.org/` | `npm config get registry` |
| proxy / https-proxy | 均为 `null`（不需要代理） | `npm config get proxy` |
| 默认缓存目录 | ⛔ 沙箱拒绝写：`EPERM ... _cacache\tmp\***` | `npm view tsdown`（默认 cache） |
| **工作区缓存目录** | ✅ **可用** | `npm view tsdown version --cache W:\...\.npm-cache` → `0.23.0` |
| `tsdown` 最新版 | `0.23.0` | 同上 |
| `esbuild` 最新版 | `0.28.2` | `npm view esbuild version --cache ...` |
| 本机已有工具链 | `tsdown`/`tsc`/`esbuild`/`typescript` 仍**未安装**于 web profile | `Test-Path node_modules/{...}` |

> **修正后的影响**：
> 1. **可以引入构建期依赖**（devDependencies），如 `tsdown` / `esbuild` / `typescript`；
> 2. **仍建议运行时零依赖**（波形图手写 Canvas 的决定保持有效——那本就是为了体积与可控性）；
> 3. 安装时**必须显式指定工作区内的 cache/store 目录**，否则触发沙箱 EPERM；
>    或为项目配置 `.npmrc`（`cache=W:\dsh-plugins\dsh-rtt-debug\.npm-cache`）。

### 4.4 Client 半的构建产物契约（✅ 已取证）

源：`@deepseek-ai/dsh-client-modules`（`lib/types/client/manifest.d.ts` + `README.md`）

**客户端插件包的声明方式**（`package.json`）：
```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",           // 必需
    "inject": [ "..." ],         // 信息性包名依赖（非 cordis 注入）
    "immediately": false,        // 可省略；phase-one 注册屏障
    "external": [ "..." ]        // 超出基线模块表的精确请求
  }
}
```

**bundle 格式**（源：已装插件 `dsh-sentinel/lib/client.js` 实测）：
```js
window.__ModuleLoader__.load({
  id: "dsh-sentinel",                       // = 包名，须与 boot graph 行一致
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ... 模块体（含 CSS 注入等副作用，materialize 时执行）...
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

**关键契约**（逐字取源）：
- 执行 bundle **只注册工厂**；模块体副作用（含 CSS 注入）在 **materialization** 时才跑。
- `require` 是同步的，解析顺序：**platform seed → 已 materialize 记录 → boot graph 行 → 已注册工厂**；否则**抛错**。
- **require 环是致命的**（factory 形式 CJS 无法给出部分导出）。
- 基线模块表（`PLATFORM_MODULES`）由 shell 种入：**React、Cordis、静态 UI 库**。
  `dsh.client.external` 只加**非基线**请求。
- `<id>/client` 与裸包名解析到**同一份导出**。
- HMR 走 `invalidate(id, rev)` + `prefetch(id)`。

**主机构建要求**（逐字取源）：
> The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js`
> before launch; a missing bundle fails activation **loudly** with one build instruction and a
> package/path list.

→ ✅ **结论：可以正常用 `tsdown` 构建 `lib/client.js`**（构建期依赖可安装），
无需手写 bundle。这解除了早期的 R1/C3 约束。

---

## 5. RTT 数据链路（端到端已取证）

### 5.1 目标板与固件

| 项 | 值 | 取证 |
|---|---|---|
| 芯片 | 润石 RS32F066（Cortex-M0+） | `KF/doc/RS32F066_Datasheet.pdf`、`mcu/openocd.cfg` |
| 固件工程 | `C:\Users\RUNIC\Desktop\KF`（`mcu/` 为构建目录） | 目录列表 |
| RTT 实现 | SEGGER RTT，`mcu/RTT/SEGGER_RTT.{c,h}`、`SEGGER_RTT_printf.c`、`SEGGER_RTT_Conf.h` | 文件存在 |
| Up/Down buffer 数 | 各 2 | `SEGGER_RTT_MAX_NUM_UP_BUFFERS (2)` |
| Channel 0 上缓冲 | **1024 B** | `BUFFER_SIZE_UP (1024)` |
| 默认模式 | `SEGGER_RTT_MODE_NO_BLOCK_SKIP`（满则丢） | `SEGGER_RTT_MODE_DEFAULT` |
| RTT 控制块搜索区 | `0x20000000`，长度 `0x1000`，标识串 `{SEGGER RTT}` | `mcu/openocd.cfg` 的 `rtt setup 0x20000000 0x1000 {SEGGER RTT}` |
| RTT 控制块符号 | `_SEGGER_RTT`（`aUp[0].WrOff/RdOff` 在 `SEGGER_RTT_Init` 中可见） | `SEGGER_RTT.c` |
| **实际初始化的通道数** | **仅 `aUp[0]`**（"Terminal"）；`aUp[1]` 未初始化 → `pBuffer=NULL`、`SizeOfBuffer=0` | `SEGGER_RTT.c:15-25`（初始化器只填 index 0） |
| 写未初始化通道的行为 | **静默丢弃**：`SEGGER_RTT_Write` 在 `pRing->pBuffer == NULL \|\| SizeOfBuffer == 0` 时 `return 0` | `SEGGER_RTT.c:40-42` |

### 5.1.1 OpenOCD 侧多通道能力（关键取证 ✅）

`openocd.exe` 二进制字符串表（`Select-String -Encoding UTF8`）中可见以下命令注册项：

| 命令 | 签名 | 用途 |
|---|---|---|
| `rtt setup` | `<address> <size> <ID>` | 搜索 RTT 控制块 |
| `rtt start` / `rtt stop` | — | 启停 RTT |
| `rtt polling_interval` | `[interval]` | 轮询间隔（ms） |
| `rtt channels` / `channellist` | — | **列出可用通道**（`Up-channels:` / `Down-channels:` / `%u: %s %u %u`） |
| `rtt server start` | `<port> <channel>` | **按「端口 + 通道」启动 RTT 服务器** |
| `rtt server stop` | `<port>` | 停止某端口的服务器 |

`help rtt` 运行时输出（同一进程内）：

```
rtt
      RTT (command valid any time)
  rtt server
        RTT server (command valid any time)
    rtt server start <port> <channel>
          Start a RTT server (command valid any time)
    rtt server stop <port>
          Stop a RTT server (command valid any time)
```

> ✅ **结论：OpenOCD 原生支持「每通道独立 TCP 端口」**——`rtt server start 9090 0` 服务日志通道，
> `rtt server start 9091 1` 服务变量通道。这正是「变量走 RTT 独立通道」所需的机制，
> **无需自研 RTT 内存解析**即可实现双流分离。

### 5.2 现有主机侧 RTT 通路

- `KF\rtt.bat` → `python mcu\rtt_view.py [--reset]`
- `mcu\rtt_view.py`：若 `127.0.0.1:9090` 未开，则 `subprocess.Popen(["openocd", "-f", openocd.cfg])`，
  轮询 RTT 端口就绪（最多 40 次 × 0.15 s），然后连 `127.0.0.1:9090` **明文流**读日志；
  TCL 端口 `6666` 用于 `reset run` / `rtt setup` / `rtt start`（分隔符 `\x1a`）。
- `mcu\openocd.cfg` 关键行：`source [find interface/jlink.cfg]`; `transport select swd`;
  `adapter speed 1000`; TAP ID `0x0bc11477`; `-work-area-phys 0x20000000 -work-area-size 0x1000`;
  `reset_config none`; `init`; `sleep 200`; `rtt setup ...`; `rtt start`; `rtt server start 9090 0`。

### 5.3 实测工具可用性

| 工具 | 状态 | 取证 |
|---|---|---|
| `openocd` | ✅ `0.12.0`（2023-01-14），shim `C:\Users\RUNIC\scoop\shims\openocd.exe`，脚本根 `C:\Users\RUNIC\scoop\apps\openocd\0.12.0\share\openocd\scripts` | `openocd --version` |
| `openocd` 的 `interface/jlink.cfg` | ✅ 可解析 | `openocd -c "echo [find interface/jlink.cfg]"` |
| `JLink.exe`（SEGGER） | ❌ **未安装**（PATH 上命中的是 JDK 的 `jlink.exe`，非 SEGGER） | `Get-Command JLink.exe` → `...jdk-21.0.9.10-hotspot\bin\jlink.exe` |
| `JLinkRTTLogger.exe` / `JLinkRTTClient.exe` | ❌ 未找到 | `Get-Command` MISS |
| `pyocd` | ❌ 未安装 | `Get-Command` MISS |
| Python | ✅ 3.7.9 | `python --version` |
| ARM 工具链 | ✅ `arm-none-eabi-{nm,objdump,readelf,size,gdb}.exe` @ `C:\Program Files (x86)\Arm GNU Toolchain arm-none-eabi\14.2 rel1\bin` | `Get-ChildItem` |
| 当前 RTT 端口 9090 / TCL 6666 | ❌ 均未监听 | `Test-NetConnection` = `False` |
| 当前 OpenOCD/JLink 进程 | ❌ 无 | `Get-Process` |
| USB 上的 J-Link 设备 | ⚠️ **无法探测**（沙箱限制，非「不存在」） | `Get-PnpDevice -PresentOnly` 全量仅返回 **1** 个设备、`-Class USB` 返回空表 → 枚举能力被沙箱限制，**不能据此判定硬件不在场** |

> **影响**：波形图若要读**变量**（而非仅解析日志文本），当前缺少 J-Link 官方工具；
> 可行路径是 **OpenOCD 内存读（`mdw`/`mdh`）** 或 **ELF 符号表 + RTT 控制块间接寻址**。
> 这直接决定「变量波形图」的实现方案选型（见待确认问题）。

### 5.4 固件现有日志形态（决定波形数据从哪来）

- 启动横幅：`SEGGER_RTT_WriteString(0, ...)`（`app/main.c:58-67`）
- 分级日志宏：`RTT_INFO` / `RTT_WARN` / `RTT_ERROR`（`bsp/log.h`、`LOGI/LOGW/LOGE`）
- 60 秒心跳（`app/main.c`，`#ifdef DEBUG`）—— **含数值，是天然的数据源**：
  ```
  HB: Volt=%u mV, Cycles=%lu, Partial=%u, Dischg=%lus, Rest=%lus,
      MaxDis=%lus, MaxRest=%lus, OC=%lu, OVP=%lu, UVP=%lu, Ext=%u, FD=%d, Sleep=%lums
  ```
- ADC 饱和告警（`bsp/bsp_adc.c:207`）：`ADC SATURATED! raw=%lu/%lu (Vref=%u mV, %s) ...`
- 电池采样：`bsp_adc_read_battery_mv()`（`bsp_adc.c:185`）→ `battery_bms_step_100ms(real_vbat_mv)`
  （`app/main.c` 主循环，100 ms 节拍，LPTMR 硬件驱动或软件回退）
- 当前固件**没有** RTT 向上通道 1 的二进制/浮点变量流（仅 channel 0 文本），
  也没有 SEGGER 的 `SEGGER_RTT_Write` 结构化数据帧。

### 5.5 可用的变量数据载体

| 载体 | 位置 | 说明 |
|---|---|---|
| `g_bms` 全局（`battery_bms_t`） | `app/battery_bms.h:195` | 含 `header`(56 B) + `cycle_cache[32]` + `uvp_events[16]` + `ovp_events[16]` |
| `battery_bms_get_header()` | `app/battery_bms.h:210` | 返回 `const battery_bms_header_t*` |
| `g_lowpower_probe_request` | `bsp/bsp_lowpower.h:62` | `volatile uint32_t` |
| ELF 符号表 | `mcu/build/fsv8023_firmware.elf`（223 840 B）+ `.map`（293 307 B） | 可经 `arm-none-eabi-nm` 取符号地址 |
| 现存 ELF 变体 | `build/`、`build-rel/`、`build_backup/{baseline_main_0b739b9,lptmr_tick_v1,timefix_v1}.*` | 多版本可对照 |

---

## 6. 关键风险清单（按严重度）

| # | 风险 | 证据 | 影响 |
|---|---|---|---|
| ~~R1~~ | ~~**无法安装新依赖**~~ **已解除** | §4.3 修正：registry 可达，仅需工作区 cache | 构建期依赖可安装（`tsdown`/`esbuild`/`typescript`） |
| R2 | **J-Link 官方工具缺失** | §5.3 | 若走 JLinkRTTLogger 方案则不可行，须改走 OpenOCD |
| R3 | 变量读取需固件侧配合写独立通道 | §5.1/§5.5 | 本期不改固件 → 需提供接入文档供用户自行集成 |
| R4 | 硬件当前未连接（9090 未监听、`Get-PnpDevice` 受限） | §5.3 | 无法端到端真机验收；需用户配合上电 |
| R5 | 目标固件需自行集成变量通道 | §5.4 | 插件需附《目标端接入说明》+ 参考 C 片段（D23） |
| R6 | 单 tab 内上下分栏（上波形/下日志）与原生 Tab 模型 | §4.1 | 原生 tab 是「一个 kind 一个 body」，需在 body 内自行分栏；已确认可行 |
| R7 | RTT 上缓冲默认可配且为 NO_BLOCK_SKIP | §5.1 | 高频变量采样易丢数据；采样率需可配 + 接入文档提示缓冲核算 |
| R8 | npm 默认缓存目录被沙箱拒绝 | §4.3 | 安装/构建**必须**显式指定工作区内 cache，否则 EPERM |
| R9 | `Get-PnpDevice` 在沙箱下枚举受限 | §5.3 | Agent 无法自动探测调试器是否插着 → 联调需用户确认上电 |

---

## 7. 待确认问题（已向用户提出，采用一问一答）

见 `progress.md` §待确认 与对话正文。核心分歧点：
1. 「实时变量」的数据来源（日志解析 / 读内存 / 改固件加 RTT 通道）；
2. 目标硬件是否常连、可否配合联调；
3. 面板形态（原生右侧栏 tab vs better-sidebar 下方面板）；
4. 波形图技术栈（手写 Canvas/SVG vs 复用已装 `d3@7.9.0`）；
5. 「标尺」的确切语义（刻度尺 / 游标测量 / 两者）；
6. 「自定义添加图例」的交互（点选变量列表 vs 手输表达式）；
7. 采样/刷新率与数据保留窗口；
8. 交付形态（本地插件 vs 可发布 npm 包）与署名。
