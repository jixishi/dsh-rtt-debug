# 技术设计（design）—— DSH 侧边栏 RTT 日志 + 实时变量波形图插件

- **项目**：`dsh-rtt-debug`
- **工作目录**：`W:\dsh-plugins\dsh-rtt-debug`
- **作者**：JiXieShi
- **版本**：v1.0（阶段 1 方案设计）
- **上游**：`spec.md`（需求定稿，24 项决策 + A1–A24 验收）、`findings.md`（环境取证）

---

## 1. 设计目标与约束回顾

| 项 | 内容 |
|---|---|
| 核心目标 | 通用 RTT 调试面板：上波形（实时变量）+ 下日志，双流分离 |
| 通用性（D18/G1） | 不绑定芯片/固件/厂商；KF 仅验证样本 |
| 全可配（D18/G2） | 通道号、端口、地址、解析器、采样参数全部可配 |
| 双流分离（D19） | 变量走 RTT 独立通道 |
| 日志完整（D20） | 变量高频时日志不丢行 |
| 本期重点（D21） | 变量解析 + 日志解析 |

---

## 2. 进程与数据流总览（三数据源）

```
┌─ 目标板 ─────────────────────────────────────────────────────┐
│  用户固件（任意芯片）                                          │
│   ├─ SEGGER_RTT 通道 0 ──▶ 文本日志（printf 风格）              │
│   ├─ SEGGER_RTT 通道 1 ──▶ 变量数据（CSV / KV / 二进制）        │
│   └─ 全局变量内存 ────────▶ （由主机侧符号寻址直读）             │
└──────────────────────────┬───────────────────────────────────┘
                           │ SWD / JTAG
┌──────────────────────────┴───────────────────────────────────┐
│  openocd -f <用户指定 cfg>                                     │
│   ├─ rtt server start 9090 0   → 数据源 1：日志通道 TCP        │
│   ├─ rtt server start 9091 1   → 数据源 2：变量通道 TCP        │
│   └─ TCL 端口 6666             → 数据源 3：内存读取（mdw）      │
└───────┬────────────┬───────────────────┬─────────────────────┘
        │ TCP 9090   │ TCP 9091          │ TCP 6666 (TCL)
┌───────┴────────────┴───────────────────┴─────────────────────┐
│  DSH Host 半（Node, 通用）                                      │
│                                                                │
│  ┌────────────────┐  ┌──────────────────────┐  ┌───────────┐  │
│  │ LogLink        │  │ VariableLink         │  │ OcdReader │  │
│  │ · 独立 socket   │  │ · 独立 socket         │  │ · TCL 客户端│ │
│  │ · 字节流→行     │  │ · ParserRegistry     │  │ · 符号解析 │  │
│  │ · 无界接收缓冲  │  │   ├ CsvParser        │  │ · 周期轮询 │  │
│  │ · ANSI 解析     │  │   ├ KeyValueParser   │  │ · 类型解码 │  │
│  └───────┬────────┘  │   ├ BinaryFrameParser│  │ · 只读红线 │  │
│          │           │   └ CustomRegexParser│  └─────┬─────┘  │
│          │           └───────────┬──────────┘        │        │
│          │                 Sample[]                  │        │
│          │                       └────────┬──────────┘        │
│          │                                ▼                   │
│          │                 ┌──────────────────────────────┐   │
│          │                 │ SeriesStore                  │   │
│          │                 │ · 每变量环形缓冲（多源汇聚）    │   │
│          │                 └───────────┬──────────────────┘   │
│  ┌───────┴─────────────────────────────┴──────────────────┐   │
│  │ RttDebugService（会话态 + 路由 + WS 推送）               │   │
│  └───────┬────────────────────────────────────────────────┘   │
│          │ HTTP /api/rtt-debug/*   +   WS /api/rtt-debug/ws   │
└──────────┼────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────┐
│  DSH Client 半（浏览器）                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ <RttDebugPanel/>   （可复用核心视图，双入口共用）           │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │ WaveformCanvas  (手写 Canvas)                       │  │  │
│  │  │  axes · grid · crosshair · cursors · measure        │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │  │◀──── 可拖拽分隔条 ────▶│                              │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │ LogView (虚拟滚动 + 级别着色 + 过滤)                 │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│   入口 A: 原生右侧栏 tab   |   入口 B: better-sidebar 底部面板   │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Host 半设计

### 3.1 模块划分

```
src/
├── index.ts                    # Host 插件入口（cordis apply）
├── config.ts                   # 配置 schema（schemastery）+ DeviceProfile
├── openocd/
│   ├── manager.ts              # OpenOCD 进程生命周期
│   ├── locate.ts               # openocd 可执行文件定位（PATH / 显式路径）
│   ├── probe.ts                # 端口就绪探测 / 通道枚举
│   └── tcl.ts                  # TCL 客户端（connect / cmd / 响应分帧）
├── link/
│   ├── tcp-link.ts             # 通用 TCP 字节流连接（重连、背压、环形缓冲）
│   ├── log-link.ts             # 数据源 1：字节 → 行 → LogRecord
│   └── variable-link.ts        # 数据源 2：字节 → 帧 → Sample[]
├── parsers/                    # 数据源 2 的解析器
│   ├── registry.ts             # ParserRegistry（可注册/查询）
│   ├── types.ts                # VariableProvider 接口 + 描述符
│   ├── csv.ts                  # CSVParser（默认）
│   ├── keyvalue.ts             # KeyValueParser
│   ├── binary-frame.ts         # BinaryFrameParser
│   └── custom-regex.ts         # CustomRegexParser
├── ocd/                        # 数据源 3：OpenOCD 直读内存
│   ├── symbols.ts              # ELF 符号表解析（读 nm 输出 / 手填地址）
│   ├── types.ts                # 类型编解码（i8..f64 / bool / 端序）
│   ├── reader.ts               # 轮询调度 + mdw/mdh/mdb 批量读 + 只读保障
│   └── provider.ts             # 适配为 VariableProvider（与数据源 2 同构）
├── store/
│   ├── series-store.ts         # 每变量环形缓冲（多源汇聚）+ 保留窗口
│   └── log-store.ts            # 日志环形缓冲（行数上限）
├── service.ts                  # RttDebugService：会话态、编排、三源开关
└── routes.ts                   # HTTP + WebSocket 路由注册
```

### 3.2 OpenOCD 进程管理（D9 / D13 / D16）

**状态机**：
```
        ┌──────────┐
        │  IDLE    │◀────────────────────┐
        └────┬─────┘                     │
             │ start()                   │ stop()/dispose()
             ▼                           │
        ┌──────────┐  端口已监听   ┌──────┴─────┐
        │ PROBING  │─────────────▶│ ATTACHED   │
        └────┬─────┘              └──────┬─────┘
             │ spawn openocd            │
             ▼                          │
        ┌──────────┐  就绪       ┌──────┴─────┐
        │ SPAWNING │────────────▶│  RUNNING   │
        └────┬─────┘             └──────┬─────┘
             │ 失败/超时                 │ 进程退出
             ▼                          ▼
        ┌──────────┐              ┌──────────┐
        │  ERROR   │              │ CRASHED  │──▶ 可重试
        └──────────┘              └──────────┘
```

**模式**（`config.openocd.mode`）：
- `auto`（默认）：先探测端口；未监听则 spawn `openocd -f <cfg>`；已监听则 attach，**不重复启动**（避免 J-Link 争用）
- `attach`：只连端口，不 spawn

**cfg 解析（D13/D16，通用性关键）**：
- **不硬编码任何绝对路径**；
- 首次使用：UI 弹输入框由用户指定，存入插件设置（`pluginSettings`）；
- 支持**相对路径**（相对会话工作目录解析）与**名称匹配**（在会话工作目录树中按文件名查找，如 `**/openocd.cfg`，上限深度与结果数，避免全盘扫描）；
- 支持环境变量展开（`${VAR}`）。

**启动参数**由配置生成（不写死）：
```
openocd -f "<cfg>"
   -c "adapter speed <speed>"                     # 可选
   -c "rtt setup <searchAddr> <searchSize> \"<idString>\""
   -c "rtt start"
   -c "rtt server start <logPort> <logChannel>"
   -c "rtt server start <varPort> <varChannel>"
```

**就绪探测**：轮询 TCP 连接（默认 40 × 150 ms，可配），沿用已验证策略。

**通道枚举**：优先 `rtt channels`（TCL 端口，可配，默认 6666）；失败则回退「直接尝试连接配置的端口」。

### 3.3 TCP 链路（双向独立）

```ts
interface TcpLinkOptions {
  host: string
  port: number
  /** 接收缓冲上限（字节）。达到上限时的策略：'drop-oldest' | 'pause' */
  maxBufferedBytes: number
  overflowPolicy: 'drop-oldest' | 'pause'
  reconnect: { enabled: boolean; initialDelayMs: number; maxDelayMs: number; factor: number }
}

class TcpLink extends EventEmitter {
  connect(): Promise<void>
  close(): void
  on('data', (chunk: Buffer) => void)
  on('state', (s: LinkState) => void)
  on('error', (e: Error) => void)
}
```

**关键点（D20 日志完整性）**：
- **日志链路接收侧不做解析节流**：`data` 事件只做「追加到接收缓冲」这一件事，解析在下一个 microtask/批处理中做；
- 接收缓冲**不设丢弃**（或设置为远大于行数上限的上限），只有**渲染层/存储层**才应用行数上限；
- 变量链路独立 socket，**不共享**日志链路的缓冲与解析线程。

### 3.4 解析器体系（D22）

```ts
/** 变量描述符（供 UI 图例列表） */
interface VariableDescriptor {
  name: string          // 显示名（可由配置映射）
  unit?: string         // 单位（可选，从数据或配置获得）
  index: number         // 在该帧中的位置
  type: 'number' | 'bool' | 'text'
}

/** 变量数据源：与具体芯片/固件无关（通用性 G1） */
interface VariableProvider {
  readonly id: string
  /** 配置解析器（列映射、分隔符、字节序等） */
  configure(options: Record<string, unknown>): void
  /** 流式解析：字节 → 样本；内部处理跨 chunk 的半帧 */
  feed(chunk: Buffer): Sample[]
  /** 已知变量清单（首帧或表头后可用） */
  descriptors(): VariableDescriptor[]
  reset(): void
}

interface Sample {
  ts: number            // 主机接收时间戳（ms），或数据自带时间戳
  values: Record<string, number | boolean>
}
```

**四种内置解析器**：

| id | 说明 | 关键配置 |
|---|---|---|
| `csv`（默认） | 分隔符（`,`/`\t`/`;`）+ 可选表头行 + 列名/列序映射 | `delimiter`、`hasHeader`、`columns[]`、`lineEnding` |
| `keyvalue` | 每行 `k=v` 或 `k:v`，多对同行或每行一对 | `separator`、`onePairPerLine`、`unitSuffix`（如 `12007 mV` 解析出单位） |
| `binary-frame` | 定长帧或带长度字段；支持 LE/BE | `frameLength` 或 `lengthField{offset,size}`、`endianness`、`fieldLayout[]`（type: i8/u8/i16/u16/i32/u32/f32/f64） |
| `custom-regex` | 用户正则 + 命名捕获组 | `pattern`、`groupMap{}` |

**跨 chunk 边界处理**：所有解析器内部维护 `pending: Buffer`，未完整帧保留待下个 chunk 拼接（对日志链路同理保留不完整行）。

### 3.5 数据存储

**SeriesStore**（每变量环形缓冲）：
```ts
interface SeriesStoreOptions {
  retentionMs: number       // 保留窗口（默认 10 min）
  maxPointsPerSeries: number // 硬上限（默认 100000）
  sampleRateHz: number      // 抽取率（默认 10 Hz）
}
```
- 抽取策略：按 `sampleRateHz` 对样本降采样（保留最后一个值，或 min/max 包络——可配）；
- 裁剪：双条件（时间 OR 点数），超出即从头部丢弃。

**LogStore**（行环形缓冲）：
```ts
interface LogStoreOptions { maxLines: number }  // 默认 5000
```
- 只保留最近 N 行；超限从头部丢弃；
- 同时维护「总接收行数」计数，便于**完整性校验**（A16：对照固件实际打印行数）。

### 3.6 ANSI / RTT 颜色解析

SEGGER RTT 用 ANSI SGR 序列表达颜色（如 `\x1b[0m` 重置、`\x1b[1;32m` 亮绿）。
- 解析为「文本片段 + 样式」数组，前端按样式渲染；
- 同时维护「当前样式状态」，跨行沿用（RTT 常见用法是设一次色、多行沿用）；
- 未被支持的 SGR 序列安全忽略（不显示原始转义字符）。

### 3.7 路由契约

**HTTP**（`/api/rtt-debug/...`，`kind: 'prefix'`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rtt-debug/state` | 当前状态：OpenOCD/三链路状态、通道、变量清单、计数 |
| POST | `/api/rtt-debug/start` | 启动（body: `{ profileId?, sources?: ('log'\|'rttVar'\|'ocd')[] }`） |
| POST | `/api/rtt-debug/stop` | 停止 |
| POST | `/api/rtt-debug/clear` | 清空日志/序列（body: `{ what: 'log' \| 'series' \| 'all' }`） |
| POST | `/api/rtt-debug/config` | 读写配置/profile |
| POST | `/api/rtt-debug/export-log` | 导出日志（返回文本或写文件） |
| POST | `/api/rtt-debug/channels` | 探测可用 RTT 通道 |
| POST | `/api/rtt-debug/symbols` | **解析 ELF 符号表**（body: `{ elfPath, filter? }`）→ 返回符号清单供选择 |
| POST | `/api/rtt-debug/ocd-var` | **增删改 OCD 变量绑定**（body: `{ action, binding }`） |

**WebSocket**（`registerUpgrade`）：

| 路径 | 方向 | 载荷 |
|---|---|---|
| `/api/rtt-debug/ws/log` | Host→Client | 批量日志行（含样式、时间戳） |
| `/api/rtt-debug/ws/series` | Host→Client | 批量样本（变量名 → 值数组） |
| `/api/rtt-debug/ws`（合并可选） | 双向 | 单连接多路复用（若需要控制回传） |

**推送策略**：批量化 + 节流（默认 10 Hz 刷新，即 100 ms 一帧），避免高频小包；
日志行与样本分开推送（不同 WS 路径），互不阻塞。

### 3.8 数据源 3：OCD 变量读取（D25/D26）

**3.8.1 TCL 客户端**

OpenOCD TCL 端口（默认 6666）协议：发送命令 + `\x1a`（0x1A）终止符，响应同样以 `\x1a` 结束。
（已在 `KF/test/_probe_readonly.py` 的 `Tcl` 类验证可用）

```ts
class OcdTcl {
  connect(host: string, port: number): Promise<void>
  /** 发送命令并等待 \x1a 终止的响应 */
  cmd(command: string, timeoutMs?: number): Promise<string>
  close(): void
}
```

**3.8.2 符号解析**

两种寻址方式（D26），二选一或混用：

| 方式 | 来源 | 说明 |
|---|---|---|
| `elf` | `arm-none-eabi-nm -S --defined-only <elf>` | 解析 `地址 大小 类型 名称`；类型字母 → 数据类型映射（`B/b`=.bss/.data, `D/d`, `R/r` 等） |
| `manual` | 用户手填 | 形如 `0x20000000:u16:VoltValue`（地址:类型:名称），无 ELF 时使用 |

- **ELF 路径由用户配置**（通用性 G1，禁止硬编码）；
- `nm` 可执行文件同样可配（默认 PATH 查找 `arm-none-eabi-nm`）；
- 符号解析失败 → 明确报错，不静默。

**3.8.3 类型编解码**

```ts
type ScalarType = 'i8'|'u8'|'i16'|'u16'|'i32'|'u32'|'f32'|'f64'|'bool'

interface SymbolBinding {
  name: string
  address: number
  type: ScalarType
  endianness?: 'little' | 'big'   // 默认 little
}
```

**3.8.4 轮询与批量读**

- 周期可配（默认 10 Hz），与数据源 2 的采样率**独立配置**；
- **批量读优化**：将地址连续（或间隔 < 阈值）的符号合并为一次 `mdw <addr> <count>` 读，减少 TCL 往返；
- **撕裂读防护**（可选开关，默认开）：对多字节变量连读两次，值一致才采纳；不一致则标记该样本可疑；
- **读取指令选择**：按最小对齐宽度选 `mdb`(byte) / `mdh`(half) / `mdw`(word)。

**3.8.5 安全红线（只读）**

> ⚠️ **数据源 3 绝不写目标内存**。所有命令必须通过**白名单校验**：
> 仅允许 `mdw` / `mdh` / `mdb` / `reg`（可选，只读寄存器）/ `halt` 的**读侧**子集。
> 明确**禁止** `mww` / `mwh` / `mwb` / `flash write` / `reset`（除非用户显式点击复位按钮，且与采样解耦）。

实现：所有 TCL 命令经 `assertReadOnly(cmd)` 校验，非法命令直接抛错并记录审计日志。

**3.8.6 与 RTT 共存**

OpenOCD 同一进程内同时提供 RTT server（9090/9091）与 TCL（6666），三路并行无冲突。
唯一共享资源是 SWD 物理链路 —— OpenOCD 已在内部串行化，无需插件介入。

---

## 4. Client 半设计

### 4.1 产物与声明（C8/C9）

`package.json`：
```jsonc
{
  "name": "dsh-rtt-debug",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [ "dsh-better-sidebar" ],   // 入口 B 需要；入口 A 用原生 API
      "external": []                         // 仅用基线模块表（React/Cordis）
    }
  }
}
```

构建：`tsdown`（可安装，见 findings §4.3）产出 `lib/index.js`（Host）+ `lib/client.js`（Client，`window.__ModuleLoader__.load` 格式）。

### 4.2 双入口（D3）

**入口 A —— 原生右侧栏 tab（两阶段注册，C4）**：
```ts
// 阶段 1：类型
ctx.sidebarRightTabs.register({
  id: 'dsh-rtt-debug',
  kind: 'rtt-debug',
  title: () => t('tab.title'),
  guide: [{ order: 10, title: () => t('guide.title'), description: () => t('guide.desc') }],
})

// 阶段 2：body
ctx.slots.register('sidebar.right.pane.tab', 'dsh-rtt-debug', () => <RttDebugPanel ctx={ctx} />)
```

**入口 B —— better-sidebar 底部面板**：
```ts
ctx.betterSidebar.registerTab({
  id: 'dsh-rtt-debug:panel',
  title: () => t('tab.title'),
  order: 70,
  single: true,
  component: () => <RttDebugPanel ctx={ctx} />,
})
```

> 两个入口**共用** `<RttDebugPanel/>`（D3 核心要求）。

### 4.3 组件树

```
<RttDebugPanel/>                       # 顶层：布局 + 状态编排
├── <Toolbar/>                         # 运行/暂停/清空 · 连接状态 · 设置
├── <WaveformPane/>                    # 上：波形
│   ├── <WaveformCanvas/>              #   手写 Canvas（曲线 + 坐标轴 + 游标 + 准星）
│   ├── <LegendBar/>                   #   图例（显隐开关 + 当前值 + 颜色）
│   └── <MeasureReadout/>              #   自动测量（Vpp/均值/频率/上升时间）
│   └── <LegendPicker/>                #   变量选择弹层（勾选 + 自定义规则）
├── <SplitHandle/>                     # 可拖拽分隔条（D10）
└── <LogPane/>                         # 下：日志
    ├── <LogToolbar/>                  #   过滤 + 自动跟随 + 级别 + 导出
    └── <LogView/>                     #   虚拟滚动列表
```

### 4.4 WaveformCanvas 设计（D4/D5/D17）

**渲染分层**（Canvas 2D，一次 rAF 内分层绘制）：
1. 背景 + 网格线
2. 坐标轴 + 刻度 + 单位标签
3. 数据曲线（每变量一条）
4. 游标 + 准星 + 数值浮标（叠加层）
5. （测量结果画在 HTML 层，避免遮挡）

**关键数据结构**：
```ts
interface Viewport {
  tMin: number; tMax: number       // 时间窗
  vMin: number; vMax: number       // 值域（单 Y 轴，D17）
  autoScale: boolean               // 自动量程
}

interface CursorState {
  enabled: boolean
  a?: { t: number; v: number }     // 游标 A
  b?: { t: number; v: number }     // 游标 B
}
```

**性能**：
- 曲线抽样：视口内点数超过画布宽度 × 2 时做**像素级聚合**（每像素取 min/max），保证千级点流畅；
- 增量重绘：仅数据变化时重绘数据层，交互（准星）只重绘叠加层；
- DPR 适配：`canvas.width = cssW * devicePixelRatio`。

**坐标系映射**：`x = (t - tMin) / (tMax - tMin) * plotW`，`y = plotH - (v - vMin)/(vMax - vMin) * plotH`。

### 4.5 自动测量算法（D5）

| 指标 | 算法 |
|---|---|
| 峰峰值 Vpp | `max - min`（视口或游标区间内） |
| 均值 mean | 算术平均（视口或游标区间内） |
| 频率 freq | 过中值点的**上升沿间隔**中位数取倒数；样本不足时返回 `—` |
| 上升时间 rise | 10%→90% 跨越时间；取多个上升沿的中位数 |

> 全部基于**游标区间**（若游标启用）或**当前视口**（未启用），并在 UI 上明示计算区间。

### 4.6 国际化（D15）

```ts
const zh = { 'tab.title': 'RTT 调试', ... }
const en = { 'tab.title': 'RTT Debug', ... }
```
- 优先接入宿主 `ctx.locale`（若可用）；否则回退 `navigator.language` 判断；
- 注册的 `title` / `description` 用**函数形式**，语言切换时自动重取（契约要求：thunked copy 每次使用重新读取）。

---

## 5. 通用性实现要点（D18，硬性）

| 要求 | 实现 |
|---|---|
| 无芯片名/厂商名 | 代码与默认配置中不出现任何具体芯片/厂商标识；仅测试与文档提及验证样本 |
| 无绝对路径 | cfg 路径、openocd 可执行文件路径**均由用户配置**；默认仅用 PATH 查找 `openocd` |
| 通道/端口可配 | `channels.log.{port,channel}`、`channels.variables.{port,channel}` 全可配 |
| RTT 参数可配 | `searchAddr` / `searchSize` / `idString` 全可配（默认取通用值） |
| 解析器可插拔 | `ParserRegistry` 注册表；四种内置 + 支持后续扩展 |
| Device Profile | 上述所有项的整体快照，可保存/切换/导入导出 |
| 配置持久化 | 存于插件自身设置（`pluginSettings`），不写 `~/.dsh` 组成文件 |

---

## 6. 错误处理与降级

| 场景 | 行为 |
|---|---|
| `openocd` 不在 PATH | 状态 `ERROR` + 明确提示「请安装 OpenOCD 或在设置中指定路径」 |
| cfg 未配置/不存在 | 状态 `ERROR` + 提示「请指定 openocd.cfg」 |
| 端口被占用（非 OpenOCD） | 状态 `ERROR` + 提示端口冲突 |
| OpenOCD 启动超时 | 状态 `ERROR` + 展示 OpenOCD stderr 尾部（截断保护） |
| 链路断开（板子掉电） | 状态降级为 `DISCONNECTED` + 自动重连（指数退避） |
| 通道不存在 | 提示「目标未提供该 RTT 通道」+ 展示 `rtt channels` 结果 |
| 解析器报错（坏帧） | 计数错误帧 + 跳过该帧 + 展示最近一条错误（不中断流） |
| 变量通道无数据 | 波形区显示空态提示（不报错） |

---

## 7. 安全边界

| 项 | 约束 |
|---|---|
| 命令执行 | spawn `openocd` 时用 **argv 数组**（不经 shell），路径参数不拼 shell 字符串 |
| 路由防护 | 沿用宿主网关的**浏览器信任栅栏**（Host 头 loopback / trustedHosts），与 better-sidebar 一致 |
| 工作区约束 | 读取的本地文件（cfg）限定在用户显式指定 / 会话工作目录内 |
| 导入 Profile | 校验 schema，拒绝非法字段；不执行 profile 中的任何代码 |
| 日志导出 | 路径限定工作目录，文件名过滤非法字符 |
| 不触碰 | `~/.dsh` 下 composition / settings / mcp.json 一律不写 |

---

## 8. 测试策略

| 层 | 内容 |
|---|---|
| 单元测试 | 四个解析器（含**跨 chunk 边界**、坏帧、空帧）、ANSI 解析、抽取与裁剪、自动测量算法 |
| 契约测试 | 路由请求/响应 schema；WS 消息格式 |
| 集成测试 | 用**本地 TCP mock server** 模拟 OpenOCD 的两个 RTT 端口（无需硬件），验证端到端数据流 |
| 回归测试 | 通用性审计：grep 代码库确认无芯片名/绝对路径（对应 A23） |
| 真机联调 | 用户上电后，按 D14 由 Agent 自行拉链路；先验证日志，再验证变量通道（需目标固件已集成变量输出） |

> **重要**：因为「变量通道需目标固件侧配合」，集成测试用 mock 保证主机侧可独立验证；
> 真机上的变量数据依赖用户固件是否已按 D23 文档集成。

---

## 9. 批次 1 的落地清单（对应 spec §8）

- [ ] 项目骨架：`package.json` / `tsconfig.json` / `tsdown.config.ts` / `cordis.patch.yml`
- [ ] Host：`OpenOcdManager`（auto/attach、cfg 解析、就绪探测、崩溃重连）
- [ ] Host：`TcpLink` + `LogLink` + `VariableLink`
- [ ] Host：`ParserRegistry` + 4 解析器
- [ ] Host：`SeriesStore` + `LogStore`
- [ ] Host：路由（HTTP + 2 条 WS）
- [ ] Client：原生 tab 注册（单入口）+ `<RttDebugPanel/>`
- [ ] Client：`WaveformCanvas`（轴/网格/曲线/单 Y 轴自动量程）
- [ ] Client：`LogView`（虚拟滚动 + 级别着色）+ `LogToolbar`（基础）
- [ ] Client：`LegendBar` + `LegendPicker`（勾选 + 自定义规则）
- [ ] Client：可拖拽分隔条
- [ ] 测试 + 验收（A2–A3、A8–A9、A11、A15、A17–A18、A20、A22）

---

## 10. 开放问题（进入编码前需确认）

| # | 问题 | 影响 |
|---|---|---|
| O1 | 构建工具选型：`tsdown`（DSH 生态惯例）vs `esbuild` 直接调用 | 影响脚手架与构建脚本；建议 `tsdown` 与生态一致 |
| O2 | 依赖安装方式：项目本地 `devDependencies` + 工作区 cache | 需确认是否允许在工作目录初始化 `package.json` 并安装 devDeps |
| O3 | 是否本轮即建 git 仓库（D8 选了「本地目录 + link 安装」，未含 git） | 影响是否提交历史 |
| O4 | 变量通道的**默认**通道号：`1`（0 留给日志）是否符合预期 | 影响开箱可用性 |
