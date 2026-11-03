# 进度日志（progress）

- **项目**：DSH 侧边栏 RTT 日志 + 实时变量波形图插件（`dsh-rtt-debug`）
- **工作目录**：`W:\dsh-plugins\dsh-rtt-debug`
- **作者**：JiXieShi

---

## 会话 #1 —— 需求评估与计划制定

**目标**：评估需求可行性、制定开发计划、提出待确认问题
**状态**：✅ 评估与计划完成；⏳ 等待用户裁决 D1–D8

### 已完成动作（按时间顺序）

| # | 动作 | 命令/证据 | 结论 |
|---|---|---|---|
| 1 | 加载规划技能 | `skill(planning-with-files-zh)` | 采用 `task_plan.md` + `findings.md` + `progress.md` 三文件法 |
| 2 | 勘察工作目录 | `Get-ChildItem -Force -Recurse W:\dsh-plugins\dsh-rtt-debug` → 0 项 | 目录为空，需从零开发 |
| 3 | 确认 DSH 环境 | `$env:DSH_*`、`dsh --version` | DSH 0.1.5-rc.1；DSH_HOME=`C:\Users\RUNIC\.dsh`；Web=`http://127.0.0.1:3080` |
| 4 | 读取 profile 配置 | `~/.dsh/profiles/web/package.json` | 34 项 bundles，含 `dsh-better-sidebar`/`dsh-sentinel`/`dsh-file-review-tab` |
| 5 | 勘察 better-sidebar API | `dsh-better-sidebar/lib/types/client/service.d.ts` | `ctx.betterSidebar.registerTab(descriptor)`；`inject` 列表已取证 |
| 6 | 勘察原生侧边栏 API | `@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/*.d.ts` | 两阶段注册：`ctx.sidebarRightTabs.register()` + `sidebar.right.pane.tab` 槽 |
| 7 | 对比第三方插件实现 | `dsh-file-review-tab/package.json` + `cordis.patch.yml` | 确认插件包结构范式（`dsh.bundle.patch` + `dsh.client.inject`） |
| 8 | 勘察 RTT 固件侧 | `mcu/RTT/SEGGER_RTT_Conf.h`、`mcu/openocd.cfg` | 上缓冲 1024 B；控制块搜索 `0x20000000+0x1000`，标识 `{SEGGER RTT}` |
| 9 | 勘察主机侧 RTT 脚本 | `mcu/rtt_view.py`、`KF/rtt.bat` | 复用 OpenOCD，RTT 端口 9090（明文流）、TCL 6666（`\x1a` 结尾） |
| 10 | 勘察固件日志形态 | `app/main.c` 心跳、`bsp/bsp_adc.c` 告警 | 60 s 心跳含 13 个数值字段，是天然数据源 |
| 11 | 勘察调试工具可用性 | `Get-Command`、`Test-NetConnection`、`Get-Process`、`Get-PnpDevice` | OpenOCD ✅；SEGGER JLink 工具 ❌；9090/6666 未监听；无 J-Link 设备 |
| 12 | 勘察构建工具链 | `Test-Path node_modules/{tsdown,tsc,esbuild,typescript}` | **全部缺失** |
| 13 | 测试网络 | `Invoke-WebRequest`（npmjs / npmmirror / 7890 代理） | **全部失败** → 硬约束：零新依赖 |
| 14 | 勘察图表库 | `Test-Path node_modules/{echarts,uplot,chart.js,...}` | 仅 `d3@7.9.0` 可用 |
| 15 | 勘察变量载体 | `app/battery_bms.h:195`、`bsp/bsp_lowpower.h:62` | `g_bms`、`g_lowpower_probe_request`；ELF+map 可用于符号解析 |
| 16 | 落盘 findings | `write findings.md` | 7 类风险 R1–R7，8 项待确认 |
| 17 | 落盘计划 | `write task_plan.md` | 阶段 0–5 + 决策门 D1–D8 + 4 项已遇问题 |

### 测试结果

| 测试 | 命令 | 结果 |
|---|---|---|
| OpenOCD 可用性 | `openocd --version` | ✅ `0.12.0 (2023-01-14)` |
| OpenOCD J-Link 配置可解析 | `openocd -c "echo [find interface/jlink.cfg]"` | ✅ 返回脚本绝对路径 |
| RTT 端口连通 | `Test-NetConnection 127.0.0.1 -Port 9090` | ❌ `False`（未监听） |
| TCL 端口连通 | `Test-NetConnection 127.0.0.1 -Port 6666` | ❌ `False`（未监听） |
| npm registry（直连） | `Invoke-WebRequest https://registry.npmjs.org/tsdown` | ❌ SSL connection could not be established |
| npm registry（镜像） | `Invoke-WebRequest https://registry.npmmirror.com/tsdown` | ❌ SSL connection could not be established |
| npm registry（代理 7890） | `Invoke-WebRequest -Proxy http://127.0.0.1:7890` | ❌ 目标计算机积极拒绝 |
| ARM 工具链 | `Get-ChildItem "...Arm GNU Toolchain...\bin"` | ✅ `nm/objdump/readelf/size/gdb` 均在 |

### 创建/修改的文件

| 文件 | 说明 |
|---|---|
| `W:\dsh-plugins\dsh-rtt-debug\findings.md` | 新建：调研取证记录 |
| `W:\dsh-plugins\dsh-rtt-debug\task_plan.md` | 新建：任务计划与决策门 |
| `W:\dsh-plugins\dsh-rtt-debug\progress.md` | 新建：本文件 |

### 本次未做（明确边界）

- ❌ **未编写任何插件代码**（阶段 0 未完成，等用户裁决）
- ❌ **未安装任何依赖**（网络不可达，且违反「不确定先问」约定）
- ❌ **未改动 `~/.dsh` 下任何 DSH 配置**
- ❌ **未改动 KF 固件**
- ❌ **未启动/重启任何用户服务**（遵守协作约定：服务由用户自行启停）

---

## 待确认（阻塞项，采用一问一答）

> 详见对话正文的问题清单。以下为回填区。

| ID | 问题 | 用户答复 | 时间 |
|---|---|---|---|
| D1 | 实时变量数据来源 | ~~D. 先 A（RTT 日志文本解析）~~ → **⚠️ 已修正：变量走 RTT 独立通道** | 会话 #1 |
| D2 | 目标硬件可用性 | **A. 能常连，可随时配合联调**（KF/RS32F066 仅作验证样本） | 会话 #1 |
| D3 | 面板宿主形态 | **C. 两者都要** —— 核心视图做成可复用组件，同时注册「原生右侧栏 tab」与「better-sidebar 底部面板」 | 会话 #1 |
| D4 | 波形图技术栈 | **A. 手写 Canvas 渲染（零依赖）** | 会话 #2 |
| D5 | 「标尺」语义 | **C. 刻度轴 + 悬停准星 + 可拖动双游标 + 自动测量** | 会话 #2 |
| D6 | 「添加图例」交互 | **B. 变量列表勾选 + 自定义解析规则** | 会话 #2 |
| D7 | 采样率与保留窗口 | **C. 可配置（UI 设置项）** | 会话 #2 |
| D8 | 交付形态与署名 | **A. 本地开发目录 + link 安装** | 会话 #2 |
| D9 | OpenOCD 进程管理 | **C. 两种模式可切换（默认自动）** | 会话 #2 |
| D10 | 上下分栏交互 | **A. 可拖拽分隔条 + 波形区工具栏** | 会话 #3 |
| D11 | 日志视图能力 | **A+B+C+D+E 全选**（级别着色/过滤/自动跟随/导出/行数上限） | 会话 #3 |
| D12 | 变量发现规则 | ~~A. 自动识别 key=value~~ → **⚠️ 已修正：由变量通道解析器产出** | 会话 #3 |
| D13 | openocd.cfg 归属 | **不自带；首次由用户指定并记住** | 会话 #3 |
| D14 | 联调方式 | **A. Agent 自行拉起链路验证** | 会话 #3 |
| D15 | 界面语言 | **B. 中英双语，跟随 DSH** | 会话 #3 |
| D16 | cfg 发现规则 | **C. 首次指定并记住；用相对/可配置名称匹配，禁止硬编码绝对路径（须通用）** | 会话 #3 |
| D17 | 多变量 Y 轴 | **单 Y 轴 + 变量可点选切换显示** | 会话 #3 |
| **D18** | **通用性** | **通用插件**，不绑定 KF/RS32F066；所有功能与配置均可变 | 会话 #4（用户修正） |
| **D19** | **变量通道** | 变量走 **RTT 独立通道** | 会话 #4（用户修正） |
| **D20** | **日志完整性** | 日志须**完整**，变量采集不影响日志 | 会话 #4（用户修正） |
| **D21** | **本期重点** | **变量解析 + 日志解析** | 会话 #4 |
| **D22** | 变量通道默认格式 | **D. 四种解析器全支持（CSV/keyvalue/binary/custom），默认 CSV** | 会话 #5 |
| **D23** | 固件侧接入参考 | **A. 芯片无关接入文档 + 参考 C 片段** | 会话 #5 |
| **D24** | 交付批次 | **C. 分三批，每批可独立验收** | 会话 #5 |

---

## 会话 #4 —— 用户修正（架构级）

**用户原话（逐字）**：
1. 「实时变量要完整的RTT日志 变量 rtt独立通道」
2. 「当前插件是通用插件不是只给前面KF做的」
3. 「当前插件是通用插件，并非只为前文提到的 KF 设计，因此其所有功能与配置均不是固定不变的」
4. 「当前主要做变量和日志解析」

**影响**：推翻 D1「日志文本解析变量」的初版设计，改为**双流分离**架构。

### 本会话关键取证 ✅

| 动作 | 命令 | 结论 |
|---|---|---|
| 验证 OpenOCD 多通道能力 | `Select-String openocd.exe -Pattern 'channellist\|rtt find'` | 命中 `rtt channels` / `channellist` / `Up-channels:` / `%u: %s %u %u` |
| 验证按通道起服务 | 同上 | 命中 `rtt server start <port> <channel>` 签名 |
| 运行时命令表 | `openocd -c "help rtt"` | 输出 `rtt server start <port> <channel>` / `rtt server stop <port>` |
| 固件侧通道现状 | 读 `mcu/RTT/SEGGER_RTT.c` | **仅 `aUp[0]` 初始化**；`aUp[1]` 未初始化 → `pBuffer=NULL`、`SizeOfBuffer=0` |
| 写未初始化通道行为 | 同上 :40-42 | **静默丢弃**（`return 0`），不报错 |

> ✅ **可行性结论**：OpenOCD 原生支持「每通道独立 TCP 端口」，双流分离无需自研 RTT 内存解析。

### 落盘更新

| 文件 | 更新 |
|---|---|
| `spec.md` | 升级 v1.1；新增 §0 通用性定位（G1–G5）、§3.2.1 双流分离、§3.2.2 通用性要求、§8 三批交付 |
| `findings.md` | 新增 §5.1.1 OpenOCD 多通道能力取证 |
| `task_plan.md` | 新增 D18–D24；阶段 0 标注修正 |
| `progress.md` | 本会话记录 + 决策回填 |

---

## 会话 #5 —— 阶段 1 设计 + 阶段 2 编码启动

**用户追加修正**：
1. 「npm可以构建」→ 推翻早期「网络不可达」结论（实为 npm 缓存目录在沙箱外）
2. 「是三数据来源哦 rtt日志 rtt数据通道 ocd变量读取」→ 新增数据源 3

### 关键取证 ✅

| 动作 | 命令 | 结论 |
|---|---|---|
| npm 连通性复测 | `npm ping` | ✅ **PONG 899ms** —— registry 完全可达 |
| npm 失败真因 | `npm view tsdown`（默认 cache） | ⛔ `EPERM ... _cacache\tmp\***`（沙箱外目录） |
| 修正方案 | `npm view tsdown version --cache <工作区>` | ✅ `0.23.0` |
| Client 半产物契约 | 读 `dsh-client-modules/lib/types/client/manifest.d.ts` | `window.__ModuleLoader__.load({id, factory})` 惰性 CJS |
| 平台基线模块 | `dsh-client-modules/README.md` | React / Cordis / 静态 UI 库；其余须声明 `dsh.client.external` |
| 主机 webServer 契约 | `dsh-host-webserver/lib/types/index.d.ts` | `register({kind, path, handler})` + `registerUpgrade` |
| `dsh.client` schema | `dsh-package-manifest/lib/types/types.d.ts` | `platform` 必需；`inject`/`immediately`/`external` 可选 |
| 数据源 3 参考实现 | `KF/test/_probe_readonly.py` | TCL `mdw` 读内存范式（`\x1a` 终止）可直接复用 |
| tsdown 配置 API | tsdown.dev 官方文档（guide/hooks/output-format） | `defineConfig` 支持数组；`format: ['iife']`；`outputOptions` 透传 rolldown |

### 落盘产物

| 文件 | 说明 |
|---|---|
| `spec.md` | 升级 v1.1 → 新增 D25/D26（三数据源）+ A9b；§3.2.1 重写为三路数据源 |
| `design.md` | **新建** v1.0：三数据源架构、TCL 客户端、OCD reader（符号解析/类型解码/轮询/只读红线）、双入口、组件树、路由契约、错误处理、测试策略 |
| `package.json` | 新建：`dsh.bundle.patch` + `dsh.client{platform:'web'}` |
| `.npmrc` / `.npmrc.pnpm` | 新建：cache/store 指向工作区内（绕开沙箱 EPERM） |
| `tsconfig.json` / `tsdown.config.ts` | 新建：双半构建（Host ESM + Client IIFE 包装） |
| `src/core/types.ts` | 新建：三源共享词汇（Sample/Provider/LogRecord/ScalarType…） |
| `src/core/framing.ts` | 新建：`LineSplitter` / `FixedFrameSplitter`（跨 chunk 边界） |
| `src/core/ansi.ts` | 新建：`AnsiDecoder`（跨行保留样式）+ `detectLevel` |
| `src/core/store.ts` | 新建：`SeriesStore` / `LogStore` |
| `src/parsers/{csv,keyvalue,binary-frame,custom-regex,registry}.ts` | 新建：4 解析器 + 注册表 |
| `test/{parsers,core}.test.ts` | 新建：63 个测试用例 |

### 测试结果

```
node --test --test-isolation=none test/parsers.test.ts   → tests 36 / pass 36 / fail 0
node --test --test-isolation=none test/core.test.ts      → tests 27 / pass 27 / fail 0
```

### 测试发现的真实缺陷（已修复）

| # | 缺陷 | 症状 | 修复 |
|---|---|---|---|
| B1 | `KeyValueParser` 单位组贪婪吞掉下一个键 | `volt=12007 amps=3` 只解析出 1 个 pair（`amps` 被当成 `volt` 的单位） | 加 `(?![A-Za-z0-9µΩ%°/])(?!\s*[:=])` 双守卫；贴写单位仍安全 |
| B2 | `BinaryFrameParser` magic 之后 auto 偏移仍从 0 起算 | 带 magic 前缀的帧字段错位，采样丢失 | `auto` 初始化为 `magic.length` |
| B3 | `normalizeMagic` 把裸两位十六进制按十进制解析 | `"AA 55"` → NaN → 静默禁用 magic 过滤 | 两位 hex 明确按 16 进制；支持 `aa55` 连写/`0x`/数组 |
| B4 | `SeriesStore` 裁剪锚定 `Date.now()` | 目标自带时间戳（如 uptime ms）的样本**落地即被清空** | 改为锚定「最新样本时间戳」`newestTs` |

> B4 是设计级缺陷：doc 明说「数据源自带时间戳可选采用」，但实现只兼容主机时间戳。
> 由测试 `samples stamped with target uptime are NOT discarded` 捕获。

### 环境问题与对策

| # | 问题 | 对策 |
|---|---|---|
| E1 | `node --test test/` 报 `spawn EPERM` | 沙箱禁止管道 stdio 的子进程 → 改用 `--test-isolation=none` |
| E2 | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（参数属性） | Node strip-only 模式不支持 `constructor(private x)` → 改为显式字段赋值 |

---

## 会话 #6 —— 阶段 2/3/4 实现（批次 1）

**交付**：三数据源主机侧 + 面板客户端侧全部实现，115 测试全绿，构建通过，已提交。

### 落盘产物（29 个源文件 + 4 个测试）

| 层 | 文件 | 职责 |
|---|---|---|
| 核心 | `src/core/types.ts` | 三源共享词汇 |
| | `src/core/framing.ts` | `LineSplitter` / `FixedFrameSplitter`（跨 chunk） |
| | `src/core/ansi.ts` | `AnsiDecoder`（跨行保留样式）+ `detectLevel` |
| | `src/core/store.ts` | `SeriesStore` / `LogStore`（完整性计数器） |
| | `src/core/tcp-link.ts` | 重连 TCP + 每流背压策略 + `probeTcp` |
| | `src/core/ws.ts` | **手写 RFC 6455**（零运行时依赖） |
| 解析 | `src/parsers/{csv,keyvalue,binary-frame,custom-regex,registry}.ts` | 4 解析器 + 可扩展注册表 |
| 数据源 3 | `src/ocd/tcl.ts` | TCL 客户端 + **只读白名单** |
| | `src/ocd/symbols.ts` | ELF/`nm` 解析 + 手填地址 + 类型推断 |
| | `src/ocd/reader.ts` | 批量读 + 撕裂读防护 + 值解码 |
| 进程 | `src/openocd/manager.ts` | attach-优先-spawn、就绪探测、重启、argv 安全 |
| 编排 | `src/config.ts` | DeviceProfile + 校验 |
| | `src/service.ts` | 三源编排、flush、状态、导出 |
| | `src/index.ts` | HTTP + 2×WS 路由 + 信任栅栏 |
| 客户端 | `src/client/transport.ts` | REST + 双 WS 重连 |
| | `src/client/plot.ts` | Canvas 渲染/标尺/游标/测量/抽取 |
| | `src/client/panel.tsx` | 面板布局与交互 |
| | `src/client/styles.ts` | 命名空间样式 |
| | `src/client/locales.ts` | 中英双语 |
| | `src/client/index.tsx` | 双入口注册 |
| 测试 | `test/{parsers,core,ocd,service}.test.ts` | 115 用例 |

### 测试结果（全绿）

```
parsers.test.ts  → tests 39 / pass 39 / fail 0
core.test.ts     → tests 27 / pass 27 / fail 0
ocd.test.ts      → tests 35 / pass 35 / fail 0
service.test.ts  → tests 14 / pass 14 / fail 0   ← mock TCP 端到端 + 日志完整性压测
tsc --noEmit     → 零错误
tsdown           → lib/index.js (102 KB ESM) + lib/client.js (63 KB 惰性 CJS)
git commit 06e73fd，作者 JiXieShi <lydxh935227514@gmail.com>
```

### 本轮修复的真实缺陷（由测试捕获）

| # | 缺陷 | 症状 | 修复 |
|---|---|---|---|
| B5 | tsdown client 用 IIFE 格式 | 产物 **0.04 kB**（整包被 tree-shake 掉，无导出消费者） | 改 CJS + loader 包裹；React 保持 external |
| B6 | tsdown 产物文件名错 | 产出 `index.mjs` / `client.iife.js`，与 `package.json` 声明的 `lib/client.js` 不符 | `outExtensions: () => ({ js: '.js' })` |
| B7 | `CsvParser` 默认 `hasHeader:false` | `volt,amps` 首行被当数据 → 列名为 `col1/col2`，与"通用开箱即用"矛盾 | 默认改 `'auto'`：首行字段全非数字即视为表头 |
| B8 | `detectLevel` 不识别 `OK:` | 成功行判为 `unknown`、无着色 | `ok/success/done` 归入 `info` |
| B9 | 集成测试无同步点 | `start()` 返回时链路未 open，写入丢失 → 假失败 | 新增 `waitFor` / `waitForSources` 轮询断言 |
| B10 | `mockPort.write` 写已销毁 socket | `This socket has been ended by the other party` | 跳过 `socket.destroyed` |

> B5/B6 是构建契约缺陷：产物名与格式都必须精确匹配 `dsh-client-modules` 的加载契约，
> 否则插件在宿主侧**激活失败或完全不执行**（IIFE 静默为空，最难查）。

### 关键契约取证（避免臆测）

| 契约 | 来源 | 结论 |
|---|---|---|
| 客户端模块格式 | `dsh-client-modules/lib/types/client/manifest.d.ts` | `window.__ModuleLoader__.load({id, factory})`，工厂惰性物化 |
| 平台模块表 | 同上 README | React / Cordis / 静态 UI 库；超出者须声明 `external` |
| 槽注册签名 | `dsh-better-sidebar/src/client/native/index.ts:157` | `ctx.slots.inject(slot, () => ctx.slots.register({name,key,inject}, Body))` |
| **注册时序陷阱** | 同上 :128-135（原注释） | 必须 `ctx.inject(['sidebarRightTabs'])` 等服务；在 slot 声明回调里注册会**永久失败** |
| 主机路由 | `dsh-host-webserver/lib/types/index.d.ts` | `register({kind,path,handler})` + `registerUpgrade({path,handler})` |
| `dsh.client` schema | `dsh-package-manifest/lib/types/types.d.ts` | `platform` 必填 |
| tsdown 配置 | tsdown.dev 官方文档 | `deps.neverBundle`（`external` 已废弃）、`format`/`outExtensions` |

---

## 会话 #7 —— 缺陷修复与隔离验证，并补齐交付文档

**目标**：修复插件在 Cordis 守卫下的加载缺陷；补齐 `README.md` 与《目标端接入说明》（D23）；全程记录取证与可复现步骤。
**状态**：✅ 缺陷已修复并经**隔离实例**端到端验证通过；📄 文档已交付；⚠️ 仍有 **1 项未满足（仅 A24）** + **14 项本机不可验证（含 A1）**。

> 三态计数（**会话 #7 当时的口径**，与 README §0/§7.4、`task_plan.md` 阶段 5 一致）：
> **已满足 10 / 未满足 1（仅 A24）/ 本机不可验证 14（含 A1）= 25 条**（含 `spec.md:372` 另列的 A9b）。
> A1 的归类依据见 `coordination/integration.md` §6.4（由 t1 的「未满足」再分类为「本机不可验证」，队长裁定采纳）——
> **限定语：注册代码与降级路径已验证、页面可见性未验证**（A1 判据要求「两个入口均可打开」，而本机无可用浏览器）。
> ⚠️ **该口径已被会话 #8（t15）更新为「已满足 9 / 未满足 1 / 本机不可验证 15」**——A9b 因真机出数未验证而移出「已满足」。
> **以会话 #8 与 README §7.4 的口径为准**；此处保留原文以显示演进过程。

> 本节为**追加记录**，会话 #1–#6 的内容原样保留。

### 7.1 本轮修复的三个真实缺陷（全部有根因 + 实测证据）

| # | 缺陷 | 根因 | 修法 | 涉及文件 |
|---|---|---|---|---|
| **1** | `cannot get property "betterSidebar" without inject`（加载失败，两入口全废） | `src/client/index.tsx` 裸读 `ctx.betterSidebar`。Cordis 的 Proxy `get` 对未在 `inject` 声明的服务抛错；`betterSidebar` 由**兄弟 fiber**（`dsh-better-sidebar`）提供，**装不装该插件裸读都必抛** | `ctx.inject?.(['betterSidebar'], injected => injected.get('betterSidebar'))` + 判空 | `src/client/index.tsx` |
| **2** | effect owner 归属错误 → 服务 flap 时**槽重复 key** | 入口 A 的注册 disposer 挂在**外层 `ctx`** 上，服务消失时未释放 → 重现时重复注册 | 改挂 `injected.effect(...)`（等待中的子 fiber） | `src/client/index.tsx` |
| **3** | 面板拿不到 sessionId → cfg 相对路径回落 `process.cwd()`（F3） | 入口 A 读了**从不存在的 prop**：该 seat 以 `renderSlot(seat, {}, …)` 分发，owner props 恒 `{}`，`props.tab` 永远 undefined。入口 B 同类：better-sidebar 传 `scope={sessionId,cwd}`，原 `component: () => panel()` 丢弃之 | A：从槽的 `inject` face 取（`inject: (sessionId) => ({ sessionId })`）；B：`panel(props?.scope?.sessionId)` | `src/client/index.tsx` |

**被排除的错误修法（务必不要采用）**：把 `betterSidebar` 改成**硬 `inject: ['betterSidebar']`**。
本机复测：服务缺失时 `apply` **根本不执行**、fiber 停在 `PENDING`：

```
{"label":"hard-inject-missing","applyRan":false,"fiberState":0,"stateName":"PENDING"}
{"label":"soft-inject-missing","applyRan":true, "fiberState":2,"stateName":"ACTIVE"}
```

→ 硬 inject 直接违反决策 **D3「双入口、缺失即降级」**。

**两处措辞澄清（由本轮实测与双方评审裁定，勿沿用旧说法）**：

1. **`sessionId` 确实是框架 standard prop**，不是"只能从 inject 来"：
   ui-session 的 `BUILTIN_SOURCE` 声明 `props: ['sessionId']`，渲染器 `renderEntry` 把
   `{ …kit, …injected, …slotInjected.props, …ownerProps }` 一起展开 → **两条等价通道**。
   准确表述是：**sessionId 是框架 prop，也有显式声明的 inject face**；本插件选用后者。
   （实测：三通道都拿得到同一个值。）
2. **`isTabId` 在本代码库从未存在**：全仓检索只命中 `.agent-teams/` 里的任务描述文本，
   `git log --all -S 'isTabId'` 为空。真正落地的误用是 `props.tab?.id` 与 `SlotRegistry.register`
   的 `component` 签名（均已清除）。**文档中不得提及 `isTabId`。**

### 7.2 验证证据（隔离实例，端到端）

**隔离手段**：完全独立的 `DSH_HOME`（`W:\dsh-plugins\dsh-rtt-debug\.verify\dsh-home`）+ 显式挂载。
**为什么必须隔离**：boot / `--dump-config` 会写 `<profile>\cordis.yml`（`...\dsh\lib\profile-boot-Dk-7KqJc.js:209` `writeFileSync`），
而 `~/.dsh` 归在用实例所有。

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 最终产物能加载（端口可达 + 进组成树 + 进 boot 图） | ✅ | `coordination/verify.md` §12.2 |
| 2 | 启动日志无 `Failed to load plugins`、无守卫错误（**全文 84 B / 1 行**） | ✅ 0 命中，stderr 空 | 同上 |
| 3 | client 半在**真实 Cordis 4.0.2** 不抛错；D3 降级成立；双入口注册 | ✅ on-disk 与 served **双路 PASS** | §12.3 |
| 4 | `/api/rtt-debug/state` HTTP 200，JSON 与基准**逐字段一致** | ✅ `IDENTICAL: True` | §12.4 |
| 5 | 「被判字节 = 下发字节」 | ✅ code payload sha256 相同 `db873230…` | §12.3 |
| 6 | 负对照：损坏插件树**响亮失败** | ✅ exit=1、端口未开 | §12.5 |
| 7 | 行为不回归（守卫/抛错/渲染三轴 t7→t8 对照） | ✅ 3/3 场景不变 | §12.6 |
| 8 | 不影响在用实例：3080 全程 PID `7680` 未变；`~/.dsh` 五个配置/清单文件 mtime+sha256 完全未变 | ✅ | §12.7 |

**修复前基线（证明缺陷真实存在且不是检测失灵）**：从 `git HEAD` 另建、用 `tsdown` 构建得 `lib/client.js` **63218 B**，
与 `acceptance.md` §5.1 记录的修复前体积**逐字节一致**；判定器输出 **FAIL**，
`no-workbench` 与 `with-workbench` **均**抛 `cannot get property "betterSidebar" without inject`
（证明裸读与是否装 better-sidebar **无关**）。

**一条命令复现**：

```powershell
pwsh -File coordination/verify-final.ps1 -Tag my-run -Port 39084      # → RESULT: PASS（退出码即 verdict）
```

**本轮补充的判定与验证手段**（均在 `coordination/`）：

| 产物 | 作用 |
|---|---|
| `acceptance.md` | 判定契约：C1–C10 可判定条目 / 隔离判定 I1–I10 / 本机不可验证项 N1–N10 / A1–A24 三态 |
| `verify.md` | 隔离实例端到端验证报告（含 t10 对最终修订的复验） |
| `isolated-instance.ps1` | 隔离实例生命周期（`prepare`/`serve`/`verify`/`down`/`clean`/`bundleurl`） |
| `verify-final.ps1` | 一次性重验证：钉哈希 → 起实例 → 采证 → 真实 Cordis 判定 → 字节同一性 → 负对照 → 拆除回检 |
| `artifact-judge.mjs` | 把 client bundle 喂进**真实 Cordis** 判抛错/双入口注册/渲染 |
| `code-payload-identity.mjs` | 证明「被判字节 = 下发字节」 |

### 7.3 本轮构建与测试实测（命令全部亲自执行）

```
npm run typecheck   → exit 0（0 error）
npm run build       → exit 0；lib/index.js 102486 B、lib/client.js 63403 B
npm test            → exit 0；tests 115 / pass 115 / fail 0
                      （parsers 39 / core 27 / ocd 35 / service 14）
```

产物哈希（重建后与 t9 审核产物、t10 验证产物**逐字节相同**）：

| 文件 | 字节 | SHA256 |
|---|---|---|
| `lib/client.js` | 63403 | `0CFC46AD9E435438CC670EE698C95BA03B5C02D909D09C0C7180D55D51658EC6` |
| `lib/index.js` | 102486 | `774187053EBC78CC6521BEE2E7514E8E50764174B64679ED8EF2E889A3FB8305` |
| `src/client/index.tsx` | 11711 | `F2FD8AEC0244801824599B5C6DE0206C6896A7FF886AC8A8F2A94D2CD4A65D99` |

### 7.4 文档交付（本轮新增）

| 文件 | 内容 |
|---|---|
| `README.md` | 安装（**含「junction ≠ 挂载」关键事实 + 挂载矩阵五情形实测**）、构建/测试、配置项全表、双入口与 sessionId 口径、故障排查（本次真实故障的**特征与规避**）、已验证/未验证/已知问题、A1–A24 三态、目录结构、取证资产索引 |
| `docs/target-integration.md` | **D23《目标端接入说明》**：日志通道与变量通道区分；变量通道 4 种格式（CSV 默认 / keyvalue / binary-frame / custom-regex）的帧格式与**实测示例**；**缓冲核算与丢包（findings R7）**；**芯片无关参考 C 片段**；接入自检清单；待确认项 |

#### 7.4.1 追加轮次（t11）：修正 README 四处不一致并统一 A1 三态

依据 `coordination/integration.md` §5 的跨任务一致性检查（登记为 D-1…D-4），本轮修正如下：

| # | 级别 | 问题 | 修正 |
|---|---|---|---|
| **D-1** | **medium** | A1 的三态归类**同文件自相矛盾**：§7.3 表说「部分无法验证」，§7.4 汇总表说「未满足」、引用块说「A1/A24 未满足、13 项…」 | 按队长裁定统一为**本机不可验证**并加限定语；三处（§0 新增第 7 条结论 + §7.3 表 + §7.4 汇总表/引用块）**全部同步**，计数统一为 已满足 **10** / 未满足 **1（仅 A24）** / 本机不可验证 **14（含 A1）** = **25** |
| **D-2** | low | 原文本写「`lib/client.js` 的 :3648-3653」（省略包名前缀），会被误读成本项目 `lib/client.js` 的行号（**本项目该文件行数远小于 3648**，行号越界像错引） | 补全为 `<profiles>\node_modules\@deepseek-ai\dsh-client-ui-sidebar-right\lib\client.js:3648-3653`（该包 **3780 行**），并显式注明「**不是**本项目的 `lib/client.js`」+ 两个行数。<br>**会话 #8 补记**：同一歧义在 `task_plan.md` 与本文件也曾出现，已一并补全包名前缀（现已全文 0 处歧义引用） |
| **D-3** | low | §8.2 脚本清单只列 4 个，实际 `.verify\docs-parsers\` 有 **5** 个（漏 `verify-unnamed.mjs`） | 补齐第 5 行（603 B，实测 `exit 0`，输出 `["amps"]`）；并把两个目录的**性质差异**写清楚（`coordination\` = 交付资产 7 文件；`.verify\docs-parsers\` = 临时脚本 5 个） |
| **D-4** | low | §7.1「我本轮未重跑」注记已被 t6 同轮次复跑取代，交付记录不自洽 | 改为**同轮次复跑**记录：命令 `pwsh -File coordination/verify-final.ps1 -Tag t6-final -Port 39085`、`exit=0`、16 条件全真，出处指向 **`coordination/integration.md` §5.4** |
| — | **附带** | §8.1 取证资产表列 6 个文件，`coordination\` 实有 **7** 个（漏 `integration.md`） | 补齐 `integration.md` 一行，标题改为「共 7 个文件」 |

> **同时纠正一处我自己的措辞**：`task_plan.md` 与本节原先写「挂载矩阵**四**情形」，实际实测为**五**情形（多出官方 CLI `dsh plugin add link:` 一条），已统一改为「五情形」。

**A1 的裁定与限定语（逐字，勿简化）**：
> A1 归入「**本机不可验证**」（**不是**「已满足」）。**限定语：注册代码与降级路径已验证、页面可见性未验证。**
> 已验侧 = `artifact-judge.mjs` 两入口均注册成功且 `throw=none`；未验侧 = A1 判据要求「两个入口均可打开」，而本机**无可用浏览器**。
> 若验收方取**最严格口径**（要求页面中确实打开），A1 应回到「未满足」列。

### 7.5 文档中三条结论的**独立复测记录**（本轮亲自执行，不是转抄）

| # | 结论 | 我的复测 | 结果 |
|---|---|---|---|
| 1 | **junction ≠ 挂载** | 隔离 `DSH_HOME` 下建 profile → ① 仅 junction ② 写 `dsh.profile.bundles` ③ 写 profile `cordis.patch.yml` ④ `--patch` overlay，各跑 `--dump-config` | ① **0 命中**；②③④ **各 3 命中**（`# == dsh-rtt-debug` / `- id: dsh-rtt-debug` / `name: dsh-rtt-debug`） |
| 2 | 官方 CLI 会**自动调和 bundles** | 隔离实例内执行 `dsh plugin --profile docscheck4 add link:<repo>` | `exit=0`；`dependencies` 出现 `dsh-rtt-debug link:W:/dsh-plugins/dsh-rtt-debug`；`dsh.profile.bundles` **自动包含**；`--dump-config` 3 命中 |
| 3 | 本机在用 profile **未挂载**本插件 | `Select-String` profile `package.json` / `cordis.patch.yml` | 两条**均 0 命中**；junction 存在（`LinkType=Junction`） |

### 7.6 目标端接入文档的**实测支撑**（不是纸面说明）

| 验证项 | 做法 | 结果 |
|---|---|---|
| 4 种解析器的**示例负载**确实产生文档所写的结果 | 用插件**真实解析器**跑文档里的每一段示例负载 | CSV / keyvalue / binary-frame（定长 / 长度字段 / magic）/ custom-regex **全部逐一复现**，输出与文档一致 |
| 参考 C 片段**真能编译链接** | 从 `docs/target-integration.md` **逐字抽出** §4.1 的代码块写成 `doc_snippet.c`（不改一个字符），用 `arm-none-eabi-gcc 14.2.Rel1`、`-mcpu=cortex-m0plus -mthumb` 编译 + 链接 | **两个分支都 exit 0**：默认分支 `text 2544 / data 120 / bss 1040`；开启 `-DRTT_USE_RUNTIME_CHANNEL_SETUP=1` 分支 `2624 / 120 / 1552`（仅 3 条 `-Wall` 未用函数警告） |
| 插件的符号解析**真能吃下** `nm -S` 输出 | 对上面产出的真实 ELF 跑 `arm-none-eabi-nm -S --defined-only`，再用 `src/ocd/symbols.ts:39-40` 的**同一个正则**匹配 | **28/30 行匹配**；`_SEGGER_RTT @ 0x20000000`、`s_data_up_buffer @ 0x20000078`（`0x200` = 512，与代码声明一致）正确解析 |
| 「截断写 → 行粘连 → 列错位」这一 R7 后果**可复现** | 用真实 `CsvParser` 喂"被截断的行 + 下一行" | 输出 **6 个假变量**（含 `col3 = 2512010`）而非 3 个 → 文档的告警有实证 |
| 「端口在监听 ≠ 固件在写」 | `openocd -c "rtt server start 39099 0" -c shutdown`（**无目标**） | 输出 `Info : Listening on port 39099 for rtt connections` → **无目标也能起 server**，文档据此写明不可据此判断固件在写 |

### 7.7 本机环境限制（如实登记，未回避）

| # | 限制 | 实测 | 文档中的处理 |
|---|---|---|---|
| E1 | 无头浏览器不可用 | `msedge.exe` 退出码 `-2147483645`（mojo 命名管道被拒） | 改用**口径 A**（真实 Cordis 内跑 client 半）；N6 明确标注"无法验证" |
| E2 | 沙箱禁止管道型子进程 stdio | `execFile` → `spawn EPERM`（`listElfSymbols` 直接调用失败）；`node --test test/` 亦失败 | 测试改 `--test-isolation=none`；ELF 符号验证改为**手工比对** `nm` 输出与插件正则 |
| E3 | 无调试器/无目标 | 9090/9091/6666 均 `LISTENING=False`；`JLinkRTTLogger.exe`/`JLinkRTTClient.exe` NOT FOUND（PATH 上的 `jlink.exe` 是 **JDK** 的） | N1–N5 标注"无法验证"；接入文档只写"机制 + 自检清单"，不写"已跑通" |
| E4 | 隔离 `--patch` 的坑 | 损坏 overlay 使 boot 响亮失败（exit=1、端口未开）——用作**负对照** | 写进 `isolated-instance.ps1` 与 `verify-final.ps1` 的固定阶段 |

### 7.8 本轮**未改动**的文件

`src/**`（会话 #7 的文档轮次未改代码）、`package.json`、`tsdown.config.ts`、`test/**`、`coordination/**`
（均由前序执行方负责）；**未写入 `C:\Users\RUNIC\.dsh` 下任何文件**；**未重启/干扰在用实例 3080**（全程 PID `7680`）。

### 7.9 下一次会话恢复指引（更新）

1. 读 `README.md` → 安装/挂载（**junction ≠ 挂载**）、配置全表、故障排查、**已知问题 §7.3**
2. 读 `docs/target-integration.md` → 目标端接入（D23）：双通道、4 种格式、缓冲核算、参考 C 片段
3. 读 `coordination/acceptance.md` → 判定契约（C1–C10 / I1–I10 / N1–N10 / A1–A24 三态）
4. 读 `coordination/verify.md` → 隔离验证报告（含 t10 对最终修订的复验）
5. 本文件 7.x → 本轮修复、验证证据、环境限制
6. **命令备忘**（**注意：测试必须带 `--test-isolation=none`**）：
   - 测试：`npm test`
   - 构建：`npm run build`（= `npx tsdown`）
   - 类型：`npm run typecheck`
   - 加载判定：`node coordination/artifact-judge.mjs lib/client.js "check"`
   - 端到端：`pwsh -File coordination/verify-final.ps1 -Tag my-run -Port 39084`
   - 挂载验证：`dsh --profile web --dump-config | Select-String 'dsh-rtt-debug'`（期望 3 命中）
7. 本会话新写入的**临时验证脚本**（**非交付物**，可随时删除）：
   - `.verify\docs-parsers\`：`verify-formats.mjs`（4 种格式示例负载）、`verify-truncation.mjs`（截断粘连）、
     `probe-fiber-state.mjs`（硬/软 inject 对比）、`g4-repro.mjs`（G-4 复现）
   - `%TEMP%\dsh-SGwq4R\rtt-doc-c\`：C 片段编译工作区（`doc_snippet.c` = 从 `docs/target-integration.md`
     抽出的参考片段、`SEGGER_RTT*` 副本、`libc_shim.c`、`vsnprintf_shim.c`、`link.ld`、`resolve.mjs`、`snippet.elf`）
   - 隔离 DSH_HOME 落在 `.verify\docs-home\`（挂载矩阵实验用的 `docscheck*` profile 已删除，无遗留进程/端口）
8. **下一步建议**：
   - ① 用户裁决是否把插件**挂载进在用 web profile**（会写 `~/.dsh`，见 README §2.4）
   - ② 有真机时跑 `docs/target-integration.md` §5 的自检清单
   - ③ 需要时实现 **A24**（profile 导入导出 + 界面）与 **G-4 的可选加固**

---

## 会话 #8 —— 变量直读补全（t12–t15：缺口发现 → 修复 → 评审 → 隔离验证 → 文档）

> 本节为**追加记录**，会话 #1–#7 的内容原样保留。
> 时间线：**t12** 补 UI → **t13** 评审判 needs_revision → **t16** 修类型漂移 → **t14** 隔离验证**发现持久化 blocker** →
> **t17/t18** 复验 → **t19** 清 F2 → **t20** 复审判 pass → **t21** 修持久化 blocker → **t22** 复审判 pass → **t15**（本节）更新文档。

### 8.1 发现的缺口（T1）

| # | 缺口 | 证据 |
|---|---|---|
| **T1** | **OCD 直读没有变量发现机制** —— 用户无法配置变量 | `ocd.variables` 默认 `[]`（`src/config.ts:204`）；`POST /symbols` 与 `/ocd-vars` **早已实现**、transport 封装也已定义，却**全 client 目录零调用**，panel 也无配置 UI。t12 补齐「变量源」面板 |
| **T2** | **类型别名在两半漂移** → 按错误宽度解码 | client 侧一份**复制**的解析器只认 9 个规范拼写，Form A 对未识别拼写**静默回落 `u32`**：实测 `42.5f` 被读成 **`1110048768`**（t13 反例）；Form B 则是**合法别名被误拒**。t16 消除（共享单一实现 `src/ocd/binding-parse.ts`） |
| **T3** | **配置持久化对真实 settings 服务完全不工作**（**blocker**） | t14 立案：写入抛 namespace 错、**重启后配置全丢**、预置 settings 读不到。四根因：写入形状 / 未 register / **apply 期 `ctx.get('settings')` 为 undefined 致整段静默跳过** / 读取形状。t21 修复、t22 复核通过 |

### 8.2 修复与验证证据

| 项 | 内容 |
|---|---|
| **t12** | 新增「变量源」面板（`VariableSources`，`src/client/panel.tsx:667` 起）：A 区只读（RTT 自动发现）+ B 区可编辑（ELF 浏览勾选 / 手填） |
| **t16** | 抽出共享解析模块 `src/ocd/binding-parse.ts`（宿主与浏览器两半同源）；Form A 类型组放宽至含下划线 → **27 个拼写两个形式都接受**；未识别 → **拒绝并回显原文**，不静默改 u32 |
| **t20（复核）** | 真实 UI 提交路径：`VoltMv@0x20000000:float` → **`f32` / 42.5**（t13 记为 `u32` / `1110048768`）；**负向对照**同路径同地址同位模式绑 `u32` → **1110048768**（证明不是探针伪像）；Form A 8/8 + Form B 8/8 别名正确；非法拼写 4/4 被拒且**零配置写入**；两半一致性 **22/22 AGREE** |
| **t18（隔离）** | 端到端类型正确性 **10/10**（**真实 HTTP**，`fetch` 未打桩）：`uint16`→`u16`、`int16`→`i16`、`byte`→`u8`、`char`→`i8`、**`float`→`f32`**、`double`→`f64`、`short`→`i16`、两种手填形式、canonical `u16` —— **无一降级为 u32**；拒绝类 2/2。加载双就绪、双入口计数与 t10 基线一致、`/state` 200、非法输入 400 |
| **t21 + t22（blocker）** | 真实契约 `register(ns, schema函数)` / `get(ns)` / `update(ns, config)` + `ctx.inject(['settings'], …)` + **有界就绪门**（1000 ms）；`/profiles/add` 改为请求内立即持久化。`coordination/t14-api-probe.ps1`：**修复前 1 failed → 修复后 0 failed**（含**真实跨重启**读回：`elfPath=ocd/probe.elf`、`intervalMs=250`、`enabled=true`、`variables=2`） |

### 8.3 本轮文档更新（t15，只改 README / task_plan / progress）

| 位置 | 内容 |
|---|---|
| README **§4.2**（新增，含 3 个子节） | **两条变量来源对照表**（A 区 RTT 自动发现 / B 区 OCD **无自动发现、必须用户配置**）；「变量源」**面板操作步骤 10 步**（含真实文案键与字段名）；符号列表**三点限定**（候选池、只列数据段 `[bBdDgGsSrR]`、上限 5000）；**类型推断口径**（名字 → **大小覆盖**）；**手填两种语法 + unit 独立输入框**；**类型拼写口径**（9 规范 + 18 别名，**27 个拼写连 `_t` 形式两形式全接受**） |
| README **§4.4**（新增） | `ocd.enabled` false→true 的**实际生效行为**：运行时保存**即时重建**；未运行时**下次 [启动]** 生效（附行号与 UI 文案键） |
| README **§4.5**（新增） | 持久化时机（**所有改配置路由都立即持久化**）+ 就绪门 + **修复前无法保存配置（四根因）** + 未解析符号**静默跳过** + **修复前手填行需重加** |
| README **§6.8**（新增） | 排障：配置重启后丢失 / 类型不对 / 勾了没进配置 |
| README **§7.3 / §7.4 / §0** | **A9b 改归「本机不可验证」**（精确表述：**配置链路与类型链路已验证；真机出数未验证**）；计数改为 **9 / 1 / 15 = 25** |
| README 两处不准确描述 | **`.map` 不支持**（实现零命中，显式更正 spec 的「或解析 `.map`」）；**`elfPath` 不做工作区根解析**（逐字透传，相对路径按**宿主 CWD**） |
| README 引用修正 | 修复 7 处因源码演进**失效的行号引用**（`service.ts` 7 条 → 重定位到当前行号；`symbols.ts:163-192` → 改为 `binding-parse.ts:107-151`） |
| task_plan.md | 阶段 5 增列 t15 已完成项；计数同步；新增 **G-7（持久化 blocker）/ G-8（变量发现 + 类型漂移）/ G-9（判定盲区与 `.map`、`elfPath`、UI 文案不符）**；变更记录追加一行 |
| progress.md | 本节（会话 #8） |

### 8.4 本轮**未改动**的文件

`src/**`、`lib/**`、`package.json`、`tsdown.config.ts`、`test/**`、`docs/**`、`coordination/**`
（均为前序执行方产出）；**未写入 `C:\Users\RUNIC\.dsh`**；**未启动/干扰在用实例 3080**。

### 8.5 文档轮次自做的事实核对（不采信转述，逐条实测）

| 核对项 | 方法 | 结果 |
|---|---|---|
| 「27 个拼写两形式都接受」 | 用**真实** `normalizeType` + `parseManualBindingDetailed` 枚举 9 规范 + 18 别名（含 `_t` 形式），Form A/B 各跑一遍 | Form A **27 接受 / 0 拒绝**；Form B **27 / 0**；`uint17` 与 `std::uint16_t` 两形式**均拒绝**（后者 `unparsable`、两形式对称） |
| **类型推断优先级** | 复刻 `inferFromNmType → refineTypeFromName → typeForSize` 链路，12 组符号实测 | **实测为「大小 > 名字 > 段字母」**，与任务描述的「名字后缀 > 符号大小 > 段字母」**相反** → 文档按**实测**口径写，并列 9 行对照表（如 `tempC_i16`(size 2) → **`u16`**、`isReady`(size 1) → **`u8`**） |
| `.map` 支持 | 对 `src/**` 检索 `.map` 语义用法 | **0 命中**（仅数组 `.map()` 方法调用）→ 确认不支持 |
| `elfPath` 是否解析 | 检索 `resolve*(elfPath)` / `isAbsolute` / `workspaceRoot.*elfPath` | **0 命中** → 逐字透传（`src/index.ts:609-613`） |
| ⚠️ **发现 UI 文案与实现不符** | 读 `src/client/locales.ts:67` | `sources.elfPathHint` 写「相对路径按当前会话的工作区根解析」，与实现**不符** → 已在 README 按**实现**口径写明，并登记到 task_plan **G-9**（该文案属 client，不在 t15 in-scope，未改） |
| 全文引用 | 抽取 README 全部 `path:line` 引用逐条比对文件行数 | **104 OK / 0 FAIL**（三份文档合计） |
| **产物哈希与新鲜度** | 重建 `npm run build` + 比对 `lib/*.js.map` 内嵌 `sourcesContent` 与磁盘源码 | 重建后哈希**逐字节不变**；client 7 源 + host 19 源**全部 `IDENTICAL=true`** → 产物即当前源码树的产物 |
| ⚠️ **发现 README 产物哈希已过时** | 对比 README §3.3 与实测 | 树在 t18/t22 之后**仍在演进**（`binding-parse.ts` 于 01:04 变更）：当前 `lib/client.js` **93839 B / `AE19CA65…`**、`lib/index.js` **112541 B / `69D41787…`**，而 README §3.3 仍写 t10 时代的 `63403 B / `0CFC46AD…`` → **已更新 §3.3 为现状**，并把旧哈希明确标注为「历史、勿再引用」；§7.1 的 t6 复跑记录**保留其原始哈希**（那次复跑就是针对那份修订，改成新哈希不忠实），另加「修订口径说明」指向 §3.3 |

### 8.6 下一次会话恢复指引（更新）

1. 读 `README.md` → §2 安装（junction ≠ 挂载）、**§3.3 产物哈希（以该表为准）**、**§4.2 变量直读怎么配**、§4.4/§4.5 生效与持久化、§6.8 排障、§7.3 已知问题
2. 读 `coordination/verify.md` → **§13.5 持久化 blocker 发现书**、**§14 t18 类型端到端**（含 §14.10 不可验证项）
3. 读 `coordination/integration.md` §6.4 → A1 再分类
4. **命令备忘**：
   - 持久化验证：`pwsh -File coordination/t14-api-probe.ps1`（期望 **0 failed**）
   - 类型端到端：`node coordination/alias-e2e-probe.mjs`
   - 产物新鲜度：`.verify\docs-t15\freshness.mjs`（比对 sourcemap 内嵌源码）
   - 三绿：`npm run typecheck` / `npm run build` / `npm test`（115 pass）
5. **待办**：A24（唯一「未满足」）与 15 项真机/浏览器复验；G-9 的 UI 文案差异建议择一修正

---


## 会话 #10 —— 适配 DSH 0.2.1、J-Link 驱动、配置分层、解析器可编辑

- **提交**：`48eefe5`
- **环境**：DSH `0.2.1-rc.3`（本机桌面版），Node `v24.21.0`

### 10.1 用户提出的需求（逐条对应）

| # | 需求 | 落地 |
|---|---|---|
| 1 | 更新插件以兼容当前 DSH 版本 | settings 命名空间路径在 0.2.1 已失效，改走 `ctx.configEditor.edit` |
| 2 | J-Link 官方驱动兼容（无 OpenOCD 的 RTT） | 新增 `src/jlink/`：TELNET 通道选择 + GDB RSP 内存读 + 进程管理 |
| 3 | 时间轴可调分度，默认 50 | `plot.ts` 等分绘制 + 标签抽稀；工具栏输入框 2–200 |
| 4 | 缩放滚动范围不对 | 上限 60min → 24h；下限 3s → 0.1s |
| 5 | 「OCD 直读」改名 | 改为「变量直读」（内部 `ocd` 键与 `/ocd-vars` 保留，兼容既有配置） |
| 6 | 两个程序地址都可配置 | OpenOCD 程序路径此前缺失，已补；J-Link 已有 |
| 7 | 程序路径存全局，其余存工作区 | `extractToolPaths`/`stripToolPaths`/`applyToolPaths`，一次保存写两层 |
| 8 | 符号列表只显示全局变量 | `isGlobalDataSymbol`，默认 `globalsOnly: true` |
| 9 | 解析器可编辑：分隔符、换行标识、自定义脚本 | `decodeTerminator` + `LineSplitter` 可配终止符 + 新增 `script` 解析器（受限表达式） |

### 10.2 本轮修掉的**真实缺陷**（均为测试发现，非推测）

| # | 缺陷 | 后果 | 发现方式 |
|---|---|---|---|
| D-1 | 0.2.1 无 `settings.register` | 配置持久化完全失效，重启即丢 | 隔离实例 `/api/probe-inject` 实测原型方法 |
| D-2 | 判别条件用 `register && update` | **`persisted:true` 但文件未写**（谎报成功） | 实测 patch 文件时间戳未变 |
| D-3 | 无后端时返回「成功」 | 静默丢配置 | 代码审查后改为报错 |
| D-4 | `nm` 无 size 列时列下标错位 | 该版本 nm 的**全部符号被静默丢弃** | `parseNmOutput` 单测 |
| D-5 | `-select usb=` / `-RTTSearchRanges` 用法错误 | GDB Server 拒收 | 官方文档核对（子代理查证） |
| D-6 | 默认让调试器 halt 目标 | 停机后 RTT 停产，波形冻住 | 官方文档 + 语义推理 |

### 10.3 验证结果

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 error |
| 测试 | **197 pass / 0 fail**（新增 jlink 28、driver 12、persistence 5、parsers-edit 22、layering 12） |
| 构建 | `lib/index.js` 189 KB + `lib/client.js` 151 KB；新代码标记全部命中 |
| 解析器端到端 | **8/8**（分号分隔 + `\r` 终止 + 跳过表头 + 表达式缩放 `4095→3.3V`，跑真实 `DebugService`） |
| 真实宿主 | 隔离实例 `/variables` 返回三个工具路径；工具路径写入 profile patch 全局层；解析器配置经真实校验接受 |
| 安全边界 | 12 个逃逸尝试全部被拒（`constructor` 链、`require`、`process`、`globalThis`、箭头函数等） |

### 10.4 本机无法验证（明确边界）

- J-Link **真机**出数（本机未装 SEGGER 软件包、无 J-Link 硬件）；
- 同一 J-Link TELNET 端口的**多客户端并发**行为（SEGGER 无文档，插件已做检测并 `jlinkNotice` 上报）；
- 真实硬件上 `-nohalt` 的表现；
- 浏览器像素级外观；
- 工作区文件实际落盘（本工作区目录受 Windows 权限限制，写入被沙箱拒绝，故以 12 项单测锁定分层逻辑）。

---

