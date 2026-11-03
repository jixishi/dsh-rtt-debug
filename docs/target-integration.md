# 目标端接入说明（Target Integration）—— dsh-rtt-debug

- **适用对象**：要把自己的目标板 / 固件接到 `dsh-rtt-debug` 插件的固件与硬件工程师
- **作者**：JiXieShi
- **对应需求**：**D23**（`spec.md:71`、`spec.md:115`）「提供芯片无关的《目标端接入说明》+ 参考 C 片段（不含特定芯片/工程）」
- **配套文档**：[`../README.md`](../README.md)（插件安装/配置/故障排查）
- **关联原则**：`spec.md` §0 的 **G1 通用性** / **G2 全可配置** / **G3 变量走独立通道** / **G4 日志须完整**；**D18**（不绑定任何芯片/固件/厂商）

> **一句话结论**：你只需要做两件事——**把日志写到 RTT up-channel 0**，**把变量按四种格式之一写到 RTT up-channel 1**；
> 通道号、端口、解析格式、缓冲区大小**全部可改**，插件不假设任何芯片、工具链或工程布局。

---

## 0. 本插件不绑定任何芯片 / 固件 / 厂商（D18 / G1）

这一节先讲，因为它是所有接入决定的前提。

| 断言 | 实测证据 |
|---|---|
| 插件源码与产物中**不存在**任何芯片名 / 厂商名 / 固件工程路径 | 对 `src/**` 与 `lib/**` 检索 `KF\|RS32F066\|rs32f066\|battery_bms\|fsv8023\|C:\Users\RUNIC\|润石` → **0 命中**（本项目实测，对应验收项 **A23** `spec.md:386`） |
| 插件**不自带** `openocd.cfg`，也**不硬编码**任何绝对路径 | `src/config.ts:42` 的 `configPath` 默认值就是**空字符串**；`src/openocd/manager.ts:83-87` 对相对路径按**会话工作区**解析 |
| 所有"看起来像某个板子"的默认值都是**行业通用默认值**，不是绑定 | `0x20000000` / `0x1000` / `SEGGER RTT` 是 SEGGER RTT 在 32 位 MCU 上的常见落点（`src/config.ts:183`，注释明写 "Generic default; override per target"）；channel 0=终端、channel 1=数据是 SEGGER 自身惯例（`src/config.ts:9-11` 注释） |
| 工具链不绑定 | `nm` 默认 `arm-none-eabi-nm` 但**可改**（`src/config.ts:100`）；`openocd` 默认走 PATH 但**可改**（`src/config.ts:44`） |
| 三个数据源可**独立启停** | `src/service.ts:184-186`；只想看日志就只开数据源 1（`spec.md:197`） |

**唯一被插件调用的外部工具是 `openocd`**（以及可选的 `nm`）。
其它任何调试器（J-Link 官方工具、pyOCD、DAPLink…）都不在通路上——因为**插件通过 OpenOCD 暴露的 TCP 端口与 TCL 端口取数**，与调试器品牌无关。
（本机实测：SEGGER 官方 `JLinkRTTLogger.exe` / `JLinkRTTClient.exe` **未安装**，插件仍可在仅装 OpenOCD 的机器上工作。）

---

## 1. 两条通道：日志通道 vs 变量通道（必须分开）

**这是本插件与"从日志里正则抠变量"方案的根本区别**（验收项 A8 / 决策 D19）。

```
目标固件（任意芯片）
  │
  ├─ RTT up-channel 0  ──▶  文本日志（printf 风格，人类可读）
  │
  └─ RTT up-channel 1  ──▶  结构化变量数据（4 种格式任选）
                             ↑
                        这两条是**独立的 RTT 环形缓冲**，互不挤占
```

| 维度 | 日志通道 | 变量通道 |
|---|---|---|
| 默认 RTT 通道号 | `0`（`src/config.ts:152`） | `1`（`src/config.ts:154`） |
| 默认 TCP 端口 | `9090`（`src/config.ts:156`） | `9091`（`src/config.ts:158`） |
| OpenOCD 侧命令 | `rtt server start 9090 0` | `rtt server start 9091 1` |
| 内容形态 | 任意文本行，可带 ANSI 颜色转义 | 由**解析器**决定的机器可读格式 |
| 完整性要求 | **不丢行**（D20/A16） | 允许丢帧（陈旧数据无意义） |
| 插件侧背压策略 | `pause`（宁可反压也不丢字节，`src/service.ts:220-226`） | `drop-oldest`（丢最旧，`src/service.ts:251-257`） |
| 插件侧解析 | `LineSplitter` → `AnsiDecoder` → `detectLevel`（`src/service.ts:229-239`） | `ParserRegistry` 里选一个 `VariableProvider`（`src/parsers/registry.ts:55-58`） |

**为什么必须分开**（不是洁癖，是三个可测的工程理由）：

1. **带宽与实时性冲突**：变量流可能 100 Hz 以上，若与日志混在一条通道里，日志会被变量数据挤成碎片。
2. **格式冲突**：日志是自由文本（给人看的），变量是结构化数据（给机器读的）。混在一起就只能靠正则猜，正则一改就脆。
3. **日志完整性可度量**：分开之后，"变量高频时日志是否丢行"才成为**可独立验证**的命题
   ——插件用 `LogStore.totalIngested`（`src/core/store.ts:205`）计数，与环形缓冲保留行数独立，可用 `log.total` 核对（`src/service.ts:400`）。

> **不分开行不行？** 行——但你就只能走 `custom-regex` 解析器，从日志行里抓数字。
> 代价是：任何日志格式微调都会让你的波形静默失效。**推荐做法：变量走独立通道。**

### 1.1 固件侧必须显式初始化第二条通道（最常见的"没数据但不报错"）

SEGGER RTT 的**上缓冲数组有多个槽位，但只有被初始化过的槽位才有缓冲区**。
以本机验证样本（`SEGGER_RTT_Conf.h:13`）为例：`SEGGER_RTT_MAX_NUM_UP_BUFFERS = 2`，而初始化器**只填了 index 0**：

```c
/* SEGGER_RTT.c 的初始化器 —— 只初始化 aUp[0] */
SEGGER_RTT_CB _SEGGER_RTT = {
  "SEGGER RTT",
  SEGGER_RTT_MAX_NUM_UP_BUFFERS,
  SEGGER_RTT_MAX_NUM_DOWN_BUFFERS,
  {
    { "Terminal", &_acUpBuffer[0], sizeof(_acUpBuffer), 0, 0, SEGGER_RTT_MODE_DEFAULT },
  },                    /* ← aUp[1] 缺失 → pBuffer = NULL, SizeOfBuffer = 0 */
  { ... }
};
```

而 `SEGGER_RTT_Write()` 对未初始化通道的行为是**静默返回 0**（不报错、不置错、不断言）：

```c
/* SEGGER_RTT.c:40-42 */
if (pRing->pBuffer == NULL || pRing->SizeOfBuffer == 0) {
  return 0;      /* ← 写进去了？没有。会知道吗？不会。 */
}
```

→ **症状**：波形区永远空白、日志正常、控制台无任何报错。**这是接入失败的第一大原因。**

**你在自己的工程里要做的是**：为 channel 1 准备好缓冲区并填进控制块（见 §4 参考片段 `rtt_init_channels()`），
或者在你自己的 `SEGGER_RTT_Conf.h` 里把初始化器补全。

> ⚠️ 本插件**不改你的固件**（`spec.md:394` 明确列为 Non-Goal），也不要求你用本机的 `SEGGER_RTT_Conf.h`。
> 上例只是拿本机验证样本说明机制——**你的 RTT 实现怎么写，由你决定**。

---

## 2. 变量通道的四种格式

解析器由配置项 `variables.parser.id` 选择（`src/config.ts:69`，默认 `csv`）。
四个内置解析器注册在 `src/parsers/registry.ts:55-58`；未知 id 会**明确报错**并列出可用 id，而不是静默产出空波形（`src/parsers/registry.ts:43-49`）。

| id | 帧边界（framing） | 典型场景 | 一行/一帧产出的样本数 |
|---|---|---|---|
| `csv`（**默认**） | **行**（`\n`，容许 `\r\n`） | 周期性打包打印若干标量 | **1 行 = 1 个样本**（多列同时到达） |
| `keyvalue` | **行** | 键值成对上报，字段到达时间不同 | **1 对 = 1 个样本**（同一行多对 → 多个样本） |
| `binary-frame` | **定长帧**，或**帧内长度字段** | 高带宽、高频率、要省字节 | 1 帧 = 1 个样本 |
| `custom-regex` | **行** | 你已经有一个非标准的文本协议 | 每个正则匹配 = 1 个样本 |

> **行边界的统一规则**（`src/core/framing.ts:35-54`）：`\n` 为界，紧邻的 `\r` 会被剥掉；
> 跨 TCP chunk 被切断的行会**保留尾部**等下一个 chunk 拼回来（多字节 UTF-8 也正确）。
> 尾部保留有上限（默认约 1 MiB），防止"永远不来换行"的源把内存吃光。

### 2.1 `csv`（默认）

**帧格式**：一行 = 一个样本。字段用 `,`（默认）/ `;` / `\t` / 空白分隔。
首行是否为表头由 `hasHeader` 决定，**默认 `'auto'`**：首行字段**全都不是数字**就当表头。

**示例 A —— 带表头（推荐）**

固件写：

```c
SEGGER_RTT_printf(1, "%u,%d,%u\n", vbat_mv, temp_c, flags);
```

通道上出现的字节：

```
volt,amps,temp\n12007,3,25\n12010,4,25\n
```

插件解析结果（实测原文，`ts` 为接收时刻）：

```json
[{"ts":1789731842490,"values":{"volt":12007,"amps":3,"temp":25}},
 {"ts":1789731842490,"values":{"volt":12010,"amps":4,"temp":25}}]
```

描述符（决定图例名和单位）：

```json
[{"name":"volt","kind":"number","source":"rttVar","index":0},
 {"name":"amps","kind":"number","source":"rttVar","index":1},
 {"name":"temp","kind":"number","source":"rttVar","index":2}]
```

**示例 B —— 没有表头**

字节 `1,2\n3,4\n` → 变量名按位置取 `col1`/`col2`：

```json
[{"col1":1,"col2":2},{"col1":3,"col2":4}]
```

> `hasHeader: 'auto'` 的价值：`12007,3,25` 全数字 → 判为数据行（**不会把第一行样本吞掉**）；
> `volt,amps,temp` 全非数字 → 判为表头。判断逻辑见 `src/parsers/csv.ts:130-135`。

**示例 C —— 带单位后缀**

字节 `12007 mV,3,25\n` → 值 `12007`，描述符带上单位 `mV`：

```json
{"col1":12007,"col2":3,"col3":25}
[{"name":"col1","unit":"mV","kind":"number","source":"rttVar","index":0}, ...]
```

数字与单位之间**可以有空格也可以没有**（`12007mV` 同样识别）。

**配置项**（`src/parsers/csv.ts:16-34`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `delimiter` | `,` | 也可 `;` / `\t` / `" "`（空白串） |
| `hasHeader` | `'auto'` | `true` / `false` / `'auto'` |
| `columns` | 无 | 显式列名，**覆盖**表头文本 |
| `units` | 无 | 按位置给单位 |
| `maxColumns` | 无 | 只取前 N 列，挡住尾部垃圾 |

**非数字字段不会毒化整行**：`RUN,12007` 里 `RUN` 被跳过，`volt=12007` 仍然产出（`src/parsers/csv.ts:152-164`）。
但若**整行**都解析不出数字，该行不产出样本。

### 2.2 `keyvalue`

**帧格式**：一行含 0..N 个 `key=value` 或 `key: value`。
**关键差异**：**每一对产出它自己的样本**，所以只关心 `vbat` 的消费者不必等同一行里其它字段。
（依据与理由写在 `src/parsers/keyvalue.ts:117-120`。）

**示例**

固件写：

```c
SEGGER_RTT_printf(1, "vbat=%u mV chg=%s\n", vbat_mv, charging ? "true" : "false");
```

字节：

```
volt=12007 mV\namps=3\nrunning=true\n
```

实测解析结果（**注意每个键各成一个样本**）：

```json
[{"ts":1789731842492,"values":{"volt":12007}},
 {"ts":1789731842492,"values":{"amps":3}},
 {"ts":1789731842492,"values":{"running":true}}]
```

描述符（单位与布尔类型都被识别）：

```json
[{"name":"volt","kind":"number","source":"rttVar","index":0,"unit":"mV"},
 {"name":"amps","kind":"number","source":"rttVar","index":1},
 {"name":"running","kind":"bool","source":"rttVar","index":2}]
```

**布尔词表**：`true/on/yes/high` → `true`；`false/off/no/low` → `false`（大小写不敏感）。
布尔会先于数字匹配，所以 `fd=false` 不会被当成"数字解析失败"而丢掉（`src/parsers/keyvalue.ts:80-90`）。

**配置项**（`src/parsers/keyvalue.ts:17-22`）：`multiplePerLine`（默认 `true`）、`separator`（指定后另一种分隔符被排除）。

> **已知坑（已在实现里修掉，你的固件无需规避）**：`volt=12007 amps=3` 这种"空格分隔的多对"要求单位组必须**贪婪且不吞下一个键**
> ——否则 `amps` 会被当成 `volt` 的单位。实现用了双守卫（`src/parsers/keyvalue.ts:24-38` 有完整推导）。
> 贴写单位（`12007mV`）始终安全。

### 2.3 `binary-frame`

**帧格式**：两种任选其一。

| 方式 | 配置 | 帧边界来源 |
|---|---|---|
| 定长 | `frameLength: N` | 每 N 字节一帧 |
| 长度字段 | `lengthField: { offset, size: 1\|2\|4, includesHeader }` | 从帧内某偏移读长度（`includesHeader: false` 表示长度只算载荷，默认 `true`） |

**字节序**：`endianness: 'little'`（默认，Cortex-M 原生）/ `'big'`。
**字段布局必须显式声明**——解析器**不会**去猜 C 结构体布局（`src/parsers/binary-frame.ts:8-10` 说明了为什么猜不得）。

**示例 A —— 定长 + 小端**

固件把一个结构体按字节序原样写出：

```c
/* 目标结构：{uint16_t status; int16_t tempC; uint16_t voltMv;} —— 小端，共 6 字节 */
```

配置：

```json
{ "id": "binary-frame",
  "options": { "frameLength": 6,
               "fields": [ {"name":"status","type":"u16"},
                           {"name":"tempC","type":"i16"},
                           {"name":"voltMv","type":"u16","unit":"mV"} ] } }
```

帧字节（实测输入的十六进制原文）：`0x02 0x01 0xFE 0xFF 0xE7 0x2E`

实测解析结果：

```json
[{"status":258,"tempC":-2,"voltMv":12007}]
```

推导（可自行核对）：`0x0102`=258（u16 LE）、`0xFFFE`=-2（i16 LE）、`0x2EE7`=12007（u16 LE）。

**示例 B —— 帧内长度字段**

配置 `lengthField: { offset: 0, size: 1, includesHeader: true }`、字段 `v` 在 `offset: 1`，类型 `u16`。

帧字节：`0x03 0x02 0x01`（长度=3，含头；载荷 `0x0102`）

实测结果：`[{"v":258}]`

> **健壮性**：长度字段读出 0 或 >1 MiB 时，解析器**丢掉 1 字节重新同步**，而不是按那个长度去分配内存（`src/parsers/binary-frame.ts:124-129`）。

**示例 C —— magic 前缀**

```json
{ "id": "binary-frame",
  "options": { "frameLength": 4, "magic": "AA 55",
               "fields": [ {"name":"a","type":"u8"}, {"name":"b","type":"u8"} ] } }
```

| 输入帧 | 实测结果 |
|---|---|
| `0xAA 0x55 0x09 0x0A` | `[{"a":9,"b":10}]` |
| `0x00 0x55 0x09 0x0A` | `[]`（magic 不符，丢弃） |

`magic` 接受 `"AA 55"`、`"0xAA,0x55"`、`"aa55"`、`[0xAA,0x55]` 四种写法。
**声明了 magic 时，字段自动布局从 magic 之后开始**（`src/parsers/binary-frame.ts:150-152`）——这一点很容易写错。

**支持的类型**：`i8` `u8` `i16` `u16` `i32` `u32` `f32` `f64` `bool`（字节宽度见 `src/core/types.ts:114-116`）。

### 2.4 `custom-regex`

**帧格式**：行；每一行的每个正则匹配产出**一个样本**。

**命名捕获组 = 变量名**（`src/parsers/custom-regex.ts:5-14`）。所以"配置"就是那个正则本身，不需要再维护一张"组号 → 名字"的映射表。

**示例**

固件写：

```c
SEGGER_RTT_printf(1, "V=%dmV I=%dmA\n", vbat_mv, current_ma);
```

配置：

```json
{ "id": "custom-regex",
  "options": { "pattern": "V=(?<volt>\\d+)mV\\s+I=(?<amps>-?\\d+)mA" } }
```

字节 `V=12007mV I=15mA\n` → 实测结果：

```json
[{"volt":12007,"amps":15}]
```

描述符：`[{"name":"volt",...},{"name":"amps",...}]`

**值可以带后缀单位**：捕获组后紧跟的字母单位会被识别（`src/parsers/custom-regex.ts:81-83`）。

| 键 | 默认 | 说明 |
|---|---|---|
| `pattern` | 无 | 正则源；**未配置时不产出任何样本，也不抛错** |
| `flags` | `'g'` | 会自动补 `g` |
| `binarySafe` | — | 预留 |

> **未命名捕获组会被忽略**，而**不是**被按位置猜。理由：一个静默丢数据的正则比一个清楚的错误更糟（`src/parsers/custom-regex.ts:12-14`）。
> 用 `(?<name>…)` 命名组。
>
> **实测**（用真实 `CustomRegexParser`）：模式 `V=(\d+)mV I=(?<amps>-?\d+)mA` 里第一个组是**未命名**的，
> 喂 `V=12007mV I=15mA` 只产出 `[{"amps":15}]` —— **`volt` 静默消失**（描述符里也只有 `amps`）。
> 所以写模式时务必给**每一个**想画的量都加 `?<名字>`。

---

## 3. 缓冲核算与丢包（对应 `findings.md` 风险 **R7**）

**结论先行**：RTT 是**无背压**的单向环形缓冲。你的固件写得比主机读得快，**数据就会丢——而且是静默地丢**。
接入前必须按下面三步核算。

### 3.1 三种丢法（逐条对应源码行为）

以本机验证样本的 `SEGGER_RTT.c` 为例（**这是该实现的行为，你的实现请对照自己的源码核对**）：

| # | 触发条件 | 行为 | 源码位置 |
|---|---|---|---|
| 1 | 通道**未初始化**（`pBuffer == NULL` 或 `SizeOfBuffer == 0`） | **整次写入丢弃**：`return 0`，无任何错误迹象 | `SEGGER_RTT.c:40-42` |
| 2 | 可用空间 `avail == 0`（环满） | **整次写入丢弃**：`return 0` | `SEGGER_RTT.c:44-56` |
| 3 | `0 < avail < NumBytes` | **截断写入**：只写入 `avail` 字节 | `SEGGER_RTT.c:49-52` |

第 3 种最阴险：**截断发生在字节中途**。若被切掉的正好是行尾的 `\n`，
那一行会与**下一行粘成一行**，在 CSV 里表现为**列错位**（而不是明显的缺数据）。

**我在本项目的真解析器上复现了这个后果**（`csv` 解析器，无表头）：

```
--- A: 正常 ---
输入 "12007,3,25\n12010,4,25\n"
输出 [{"col1":12007,"col2":3,"col3":25},{"col1":12010,"col2":4,"col3":25}]

--- B: 写被截断，丢了 "\n"，下一行粘上来 ---
先输入 "12007,3,2"         → []                    （没有完整行，插件正确地保留尾部）
再输入 "512010,4,25\n"     → [{"col1":12007,"col2":3,"col3":2512010,"col4":4,"col5":25}]
                                 ↑ 6 个"变量"而不是 3 个，且 col3 是个假值 2512010
```

→ **看到图例里字段数突然变多 / 出现离谱的大数，第一反应应该是"RTT 缓冲满了导致行被截断"，而不是"插件解析错了"。**

### 3.2 核算三步（照做即可）

**第 1 步：量出"一行多少字节"**

```c
/* 让固件自己报一次，比估算可靠 */
int n = SEGGER_RTT_printf(1, "%u,%d,%u\n", vbat_mv, temp_c, flags);
```

**第 2 步：算"主机多久来读一次"能容忍的速率**

```
缓冲可持续时长(s) ≈ (SizeOfBuffer − 1) / (每行字节数 × 写入行频 Hz)
```

举例（**纯算术示例，不是对你的板子的建议**）：

| 每行字节 | 写入频率 | 每秒字节 | 缓冲 `1024 B` 可撑 |
|---|---|---|---|
| 12 B（`12007,3,25\n`） | 100 Hz | 1200 B/s | **≈ 0.85 s** |
| 12 B | 10 Hz | 120 B/s | ≈ 8.5 s |
| 36 B | 100 Hz | 3600 B/s | ≈ 0.28 s |
| 36 B | 10 Hz | 360 B/s | ≈ 2.8 s |

> `−1` 是因为环形缓冲的可用空间是 `size − 1`（`avail` 公式里那个减 1）。

**这意味着**：只要 OpenOCD 的 RTT 轮询晚到不足 1 秒（调试器拔掉、SWD 被别的工具抢占、目标在断点停住），
一个 1 KB 缓冲 + 100 Hz × 12 B 的流就会开始截断。

**第 3 步：选择对策（按优先级）**

| 优先级 | 对策 | 怎么做 |
|---|---|---|
| 1 | **降频** | 波形是给人看的，10 Hz 就够。把变量写入从 "每个控制周期" 改为 "每 N 个周期"。 |
| 2 | **缩短行** | 用 `binary-frame` 代替文本：同样是 `status/tempC/voltMv` 三个字段，文本是 `12007,3,25\n`（12 B），二进制是 **6 B**（示例 A）+ 可能的 magic。 |
| 3 | **加大缓冲** | 改 `BUFFER_SIZE_UP` / 为 channel 1 分配更大的缓冲。**代价是 RAM**——本机验证样本的芯片 SRAM 只有 4 KB 且 bss 已用约 92%，其 `SEGGER_RTT_Conf.h:18-26` 的注释明确写着"不可盲目加大此值"。**先看你的 RAM 余量。** |
| 4 | **降低单行长度** | 拆成多行短行（注意：每行仍有 `\n` 的开销，且 `keyvalue` 的多对分行会让同一逻辑帧的字段时间戳不同——这是 `keyvalue` 的**设计行为**，见 §2.2）。 |
| 5 | **不要用 `BLOCK_IF_FIFO_FULL`** | 它会让固件**阻塞**等待主机读取，在实时控制回路里等于把调试器变成了实时性依赖项。SEGGER 自己的默认值是 `NO_BLOCK_SKIP`（本机样本 `SEGGER_RTT_Conf.h:35`）。 |

### 3.3 怎么发现"正在丢"（可观测性）

**插件侧**（`GET /api/rtt-debug/state`）：

| 字段 | 含义 | 怎么用 |
|---|---|---|
| `log.total` | **累计接收行数**（独立于环形缓冲） | 与固件实际打印行数对照 → 验证日志完整性（A16） |
| `log.retained` | 当前保留行数 | 达到行数上限后不再增长属正常（`src/core/store.ts:247-250`） |
| `sources[].received` | 该源累计接收（行 / 样本） | 应与固件发送速率大致同阶 |
| `sources[].state` | `idle`/`connecting`/`open`/`reconnecting`/`closed` | 断连会显示成 `reconnecting` 并带 `attempt N, retrying in M ms`（`src/service.ts:412-421`） |

**最有效的土办法**：让固件把"自增序号"作为**第一个字段**写进变量通道。

```
seq,vbat,temp
1,12007,25
2,12010,25
3,12013,25
```

这样任何丢帧/粘连都**看得见**（序号不连续）。这条建议与插件无关，属于接入自检手段。

---

## 4. 参考 C 片段（芯片无关）

> **来源与验证口径**：以下片段**不含任何芯片名、厂商名或工程路径**。
> 我在本机用 **Arm GNU Toolchain 14.2.Rel1** 针对 **Cortex-M0+**（`-mcpu=cortex-m0plus -mthumb`）
> **实际编译并通过**（命令与结果见 §4.1）。片段依赖 **SEGGER RTT 的公开 API**
> （`SEGGER_RTT_Write` / `SEGGER_RTT_WriteString` / `SEGGER_RTT_printf`），任何提供同名声明的 RTT 实现都可替换。

### 4.1 参考片段（可直接拷进你的工程）

```c
/* ─────────────────────────────────────────────────────────────────────────
 * rtt_telemetry.c — 目标端最小接入示例（芯片无关）
 *
 * 约定：
 *   - RTT up-channel 0 → 文本日志（给人看）
 *   - RTT up-channel 1 → 结构化变量（本示例用 CSV；换成 keyvalue / 二进制同理）
 *
 * 你需要自备的只有 SEGGER RTT 的实现与其头文件。
 * ───────────────────────────────────────────────────────────────────────── */

#include <stdint.h>
#include "SEGGER_RTT.h"

/* 通道约定（与插件默认配置一致；若不一致，改插件的 profile 即可） */
#define RTT_CH_LOG   0u
#define RTT_CH_DATA  1u

/* ── 1. 让 channel 1 真正存在 ─────────────────────────────────────────────
 *
 * ⚠️ 这一步是接入成功的关键。很多 RTT 移植的初始化器只填了 aUp[0]，
 *    于是对 channel 1 的写入会被静默丢弃（返回 0，不报错）。
 *
 * 下面两条路任选其一：
 *   (a) 在你的 SEGGER_RTT_Conf.h / 初始化器里把 aUp[1] 补全（推荐，零运行时开销）；
 *   (b) 若你的实现允许在运行时指定缓冲区，就在这里注册一块静态 RAM。
 *
 * 本函数只是把 (b) 的形状写出来，具体字段名以你的 RTT 移植为准。
 * ──────────────────────────────────────────────────────────────────────── */

#if defined(RTT_USE_RUNTIME_CHANNEL_SETUP) && (RTT_USE_RUNTIME_CHANNEL_SETUP)
static char s_data_up_buffer[512];        /* 变量通道的环形缓冲：按 §3.2 核算后再定大小 */

void rtt_setup_data_channel(void)
{
  SEGGER_RTT_BUFFER_UP *p = &_SEGGER_RTT.aUp[RTT_CH_DATA];
  p->sName        = "Data";
  p->pBuffer      = s_data_up_buffer;
  p->SizeOfBuffer = (unsigned)sizeof(s_data_up_buffer);
  p->WrOff        = 0u;
  p->RdOff        = 0u;
  p->Flags        = SEGGER_RTT_MODE_NO_BLOCK_SKIP;   /* 满则丢，绝不阻塞实时回路 */
}
#endif /* RTT_USE_RUNTIME_CHANNEL_SETUP */

/* ── 2. 日志通道：普通文本，可带 ANSI 颜色 ──────────────────────────────── */

static void log_boot_banner(void)
{
  SEGGER_RTT_WriteString(RTT_CH_LOG, "boot ok\n");
}

static void log_warn(const char *what)
{
  /* RTT_CTRL_* 是 SEGGER 定义的 ANSI SGR 宏；插件会把它解析成颜色而不会显示原始转义字符 */
  SEGGER_RTT_WriteString(RTT_CH_LOG, RTT_CTRL_TEXT_BRIGHT_YELLOW "WARN " RTT_CTRL_RESET);
  SEGGER_RTT_WriteString(RTT_CH_LOG, what);
  SEGGER_RTT_WriteString(RTT_CH_LOG, "\n");
}

/* ── 3. 变量通道：四种格式各一个示例 ─────────────────────────────────────── */

/* 3a. CSV（插件默认解析器：csv）—— 首行可发一次表头，或让插件用 col1/col2… */
static void emit_csv(uint16_t vbat_mv, int16_t temp_c, uint16_t flags)
{
  (void)SEGGER_RTT_printf(RTT_CH_DATA, "%u,%d,%u\n",
                          (unsigned)vbat_mv, (int)temp_c, (unsigned)flags);
}

/* 3b. keyvalue（解析器：keyvalue）—— 每对产出独立样本 */
static void emit_keyvalue(uint16_t vbat_mv, int charging)
{
  (void)SEGGER_RTT_printf(RTT_CH_DATA, "vbat=%u mV chg=%s\n",
                          (unsigned)vbat_mv, charging ? "true" : "false");
}

/* 3c. binary-frame（解析器：binary-frame）
 *
 * 用 memcpy 逐字节拷贝，避免依赖编译器的结构体填充/对齐规则；
 * 字节序与插件配置的 endianness 必须一致（默认 little）。
 */
typedef struct {
  uint16_t status;
  int16_t  tempC;
  uint16_t voltMv;
} telemetry_frame_t;

static void emit_binary_frame(const telemetry_frame_t *f)
{
  static const uint8_t MAGIC[2] = { 0xAAu, 0x55u };   /* 可选：与插件 options.magic 对应 */
  uint8_t out[sizeof(MAGIC) + sizeof(telemetry_frame_t)];
  unsigned i;
  const uint8_t *src = (const uint8_t *)f;

  for (i = 0u; i < sizeof(MAGIC); i++) out[i] = MAGIC[i];
  for (i = 0u; i < sizeof(telemetry_frame_t); i++) out[sizeof(MAGIC) + i] = src[i];

  (void)SEGGER_RTT_Write(RTT_CH_DATA, out, (unsigned)sizeof(out));
}

/* 3d. custom-regex（解析器：custom-regex）
 *
 * 正则示例：V=(?<volt>\d+)mV\s+I=(?<amps>-?\d+)mA
 */
static void emit_regex_line(uint16_t vbat_mv, int16_t current_ma)
{
  (void)SEGGER_RTT_printf(RTT_CH_DATA, "V=%dmV I=%dmA\n", (int)vbat_mv, (int)current_ma);
}

/* ── 4. 主循环里的调用位置示意（不要真的写死频率：见 §3）──────────────── */

void rtt_telemetry_tick(uint32_t tick_ms, uint16_t vbat_mv, int16_t temp_c, uint16_t flags)
{
  telemetry_frame_t frame;

  /* 变量：10 Hz 就够了（对照插件默认 sampleRateHz = 10） */
  if ((tick_ms % 100u) == 0u) {
    emit_csv(vbat_mv, temp_c, flags);       /* 或 3b / 3c / 3d，任选一个 */
  }

  /* 日志：事件驱动，不要周期性刷 */
  if ((tick_ms % 1000u) == 0u) {
    log_warn("tick");
  }

  (void)frame;   /* 二进制示例的用法见 emit_binary_frame() */
}

void rtt_telemetry_init(void)
{
#if defined(RTT_USE_RUNTIME_CHANNEL_SETUP) && (RTT_USE_RUNTIME_CHANNEL_SETUP)
  rtt_setup_data_channel();
#endif
  log_boot_banner();
}
```

### 4.2 我在本机做过的验证（可复现）

**环境**

| 项 | 值 |
|---|---|
| 交叉编译器 | `arm-none-eabi-gcc.exe (Arm GNU Toolchain 14.2.Rel1 (Build arm-14.52)) 14.2.1 20241119` |
| 目标 | `-mcpu=cortex-m0plus -mthumb` |
| RTT 实现 | 本机验证样本的 `SEGGER_RTT.c` / `SEGGER_RTT_printf.c` / `SEGGER_RTT.h` / `SEGGER_RTT_Conf.h`（**仅作编译验证，不代表插件依赖它**） |

**命令与结果**

```powershell
# 编译（片段 + RTT 实现）—— 三个源文件全部 exit 0
arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -DDEBUG -I<inc> -c -o snippet.o snippet.c
arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -DDEBUG -I<inc> -c -o rtt.o     SEGGER_RTT.c
arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -DDEBUG -I<inc> -c -o printf.o  SEGGER_RTT_printf.c

# 链接（需 3 个 libc 垫片：memcpy/memset/strlen、vsnprintf、-lgcc 的 64 位除法例程）
arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -nostdlib -nostartfiles -T link.ld `
  -o snippet.elf snippet.o rtt.o printf.o libc_shim.o vsnprintf_shim.o -lgcc
# → link exit = 0
```

**§4.1 那段代码（从本文件里抽出来逐字编译，两个分支都测了）**

| 编译分支 | 编译 | 链接 | `text` / `data` / `bss` |
|---|---|---|---|
| 默认（`RTT_USE_RUNTIME_CHANNEL_SETUP` 未定义 → 走上文推荐的 (a) 路线） | exit 0（仅 3 条 `-Wall` 未用函数警告） | exit 0 | `2544 / 120 / 1040` |
| `-DRTT_USE_RUNTIME_CHANNEL_SETUP=1`（走运行时注册缓冲的 (b) 路线） | exit 0 | exit 0 | `2624 / 120 / 1552` |

上面"逐字编译"的取法：从本文件的 `c` 代码块里抽出 §4.1 那一块写成 `doc_snippet.c`，**不改一个字符**再编译。

**并且验证了"插件真的能从这类 ELF 里取到地址"**——用插件自己的符号解析正则（`src/ocd/symbols.ts:39-40`）
去匹配真实的 `arm-none-eabi-nm -S --defined-only` 输出：

```
20000000 00000078 D _SEGGER_RTT
20000078 00000200 b s_data_up_buffer        ← 开启 (b) 路线时，§4.1 里那块 512 B 缓冲
```

| 检查 | 结果 |
|---|---|
| `nm` 输出行匹配插件的 `NM_WITH_SIZE` 正则 | **28/30 行匹配**（2 行无 size 列，由 `NM_WITHOUT_SIZE` 兼容，`src/ocd/symbols.ts:126-128`） |
| 符号地址被正确解析 | `_SEGGER_RTT` @ `0x20000000`，`s_data_up_buffer` @ `0x20000078`（`00000200` = 512，与代码声明一致） |
| 手填地址语法可用 | `0x20000078:u16:tempC` 与 `tempC@0x20000078:u16` 两种写法都能解析（`src/ocd/symbols.ts:163-192`） |

> **这段验证证明的是**：片段是**真能编译链接的**、ELF 里**真有**这些符号、插件的符号解析**真能吃下**这份 `nm` 输出。
> **它不证明**你的目标板能跑通——那需要真实硬件（见 §5 与 §7）。

> ⚠️ **本机 `listElfSymbols()` 无法直接调起 `nm`**：沙箱禁止管道型子进程 stdio，`execFile` 报 `spawn EPERM`。
> 这是环境限制，不是插件缺陷——同样的调用在真实 DSH 宿主进程里没有这个限制
> （单测 `test/ocd.test.ts:237` 只断言"坏 nm 路径被明确报错"）。

---

## 5. 接入自检清单

按顺序做，每一步都有明确的"通过标准"：

| # | 检查 | 命令 / 做法 | 通过标准 |
|---|---|---|---|
| 1 | RTT 控制块能被找到 | 在 OpenOCD 里 `rtt setup <addr> <size> "<id>"` 然后 `rtt start` | 不报错。**注意这两条命令需要目标已 `init`**——本机无目标时实测它们会打印 `rtt` 用法并 exit 1 |
| 2 | 通道 1 真的存在 | `rtt server start 9091 1` | 输出 `Listening on port 9091 for rtt connections`。**本机实测该命令在无目标时也会成功监听**——所以"端口开了"**不等于**固件在写 |
| 3 | 端口可连 | `Test-NetConnection 127.0.0.1 -Port 9091` | `True` |
| 4 | 真的有数据 | 插件面板的波形区出现曲线 | 图例里有变量名 |
| 5 | 数据是**对**的 | 对照 §3.3 的 `seq` 自增序号 | 序号连续、无跳变 |
| 6 | 日志没丢 | 面板日志工具栏的「保留 X / 已收 Y」，与固件打印计数对照 | `已收` 等于固件实际打印行数（A16） |
| 7 | 断连可恢复 | 拔掉调试器再插回 | 状态显示 `reconnecting` 后回到 `open`（`src/service.ts:412-421`） |

**第 2 步的一个真实坑（本机实测）**：

```
$ openocd -c "rtt server start 39099 0" -c "shutdown"
Info : Listening on port 39099 for rtt connections
shutdown command invoked
```

—— **没有任何目标连接的情况下，RTT server 照样能起来并监听**。
所以"端口在监听"**只能证明 OpenOCD 起来了**，**不能证明**目标在写数据。
判断"固件在写"要靠第 4/5 步。

**另一个真实坑**：本机 OpenOCD 0.12.0 的**运行时** `help rtt` 只列出：

```
rtt server
  rtt server start <port> <channel>
  rtt server stop <port>
```

而 `rtt setup` / `rtt start` / `rtt channels` / `rtt polling_interval` 在**无目标附着**时会退化成打印同样的用法并**返回 exit 1**
（本机逐个实测）。它们的命令字符串确实在二进制里（`Up-channels:` / `channellist` 各 1 处命中）。
→ **不要用"无目标时 `rtt setup` 失败"来判断插件配置错了**——先接上目标再判。

---

## 6. 与本插件解耦的接入方式（不装插件也能验证）

如果你只想先确认固件侧写对了，**不需要**装插件。用 `openocd` 自带能力就能看：

```powershell
# 终端 A：起 OpenOCD 并把两个通道各暴露成 TCP 端口
openocd -f <你的 openocd.cfg> `
  -c "rtt setup 0x20000000 0x1000 `"SEGGER RTT`"" `
  -c "rtt start" `
  -c "rtt server start 9090 0" `
  -c "rtt server start 9091 1"

# 终端 B：直接看通道 1 的原始字节（插件看到的就是这个流）
#   PowerShell 里最简单的做法：
$c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 9091)
$s = $c.GetStream(); $buf = New-Object byte[] 4096
while ($true) { $n = $s.Read($buf, 0, $buf.Length); if ($n -le 0) { break }
  [Console]::Write([System.Text.Encoding]::ASCII.GetString($buf, 0, $n)) }
```

插件做的正是这件事，只是把字节流喂给**解析器**并画成波形（`src/service.ts:250-275`）。
**先确认这个原始流长什么样，再决定用哪个解析器**——这是最省时间的顺序。

---

## 7. 待确认项（本机无法验证，不写结论）

| # | 项 | 为什么不能在本机确认 | 需要什么 |
|---|---|---|---|
| 1 | 你的 RTT 移植里 channel 1 的具体初始化方式 | 本机只有验证样本的 `SEGGER_RTT.c`，不是你的 | 你的 RTT 源文件（或它是否支持运行时指定缓冲） |
| 2 | 真实目标上的丢包率与最大可持续速率 | 无调试器、无目标（`Test-NetConnection 9090/9091/6666` 全 `False`） | 上电的目标 + 调试器 |
| 3 | `rtt channels` / `rtt polling_interval` 在附着目标后的实际输出 | 本机无目标，二者都退化为打印用法并 exit 1 | 一次带目标的 OpenOCD 会话 |
| 4 | 波形/标尺的**像素级外观**是否符合预期 | 本机无头浏览器不可用（mojo 拒绝访问），无 puppeteer/playwright | 一台能看到页面的机器 |
| 5 | `binary-frame` 的字段布局是否与你目标编译器的结构体一致 | 依赖你的编译器填充/对齐设置 | 你的 `telemetry_frame_t` 实际 `sizeof`（建议用 `memcpy` 逐字节拷贝，如 §4.1 的 3c） |
| 6 | **OCD 变量读取的真机端到端**（`nm` 解析 → `mdw` 读 → 波形出数） | 无目标、TCL 端口 6666 未监听 | 上电的目标；本机只验证了「符号能解析 + 正则能匹配」（§4.2），**未**验证真机读取 |

> 本清单与 `../README.md` §7.2、`../coordination/acceptance.md` §4 的 N1–N10 一致：**不把"无法验证"写成"通过"**。

---

**作者**：JiXieShi
**需求依据**：`spec.md` D23 / G1–G4 / A8 / A9 / A16 / A23；`findings.md` §5.1（RTT 控制块与缓冲）、§6 风险 R7
**验证资产**：`../coordination/acceptance.md`（判定契约）、`../coordination/verify.md`（隔离实例端到端验证）
