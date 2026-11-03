# 任务计划（task_plan）：DSH 侧边栏 RTT 日志 + 实时变量波形图插件

- **项目代号**：`dsh-rtt-debug`
- **工作目录**：`W:\dsh-plugins\dsh-rtt-debug`
- **作者**：JiXieShi
- **创建日期**：需求评估阶段
- **状态**：🟡 阶段 0（需求评估）进行中 —— **等待用户确认关键决策后才进入编码**

---

## 目标声明（Goal）

在 DSH Web 侧边栏中提供一个插件页面：**上方为实时变量波形图（支持标尺、支持自定义添加图例/选择变量），
下方为 RTT 日志**；数据来自目标板（RS32F066 / Cortex-M0+）的 SEGGER RTT 链路。

**验收方向**（待用户确认后细化）：
1. 侧边栏可打开该页面，布局为上波形、下日志；
2. 波形图实时刷新，横轴为时间，支持标尺交互；
3. 用户可从变量列表中自定义勾选/添加图例（变量曲线），支持移除；
4. RTT 日志实时滚动显示，支持颜色/级别辨识；
5. 断连可恢复，不阻塞 DSH 主界面。

---

## 环境基线（不可变前提，详见 findings.md）

| 项 | 值 |
|---|---|
| DSH | 0.1.5-rc.1 |
| Node / pnpm | v26.8.1 / 11.21.0 |
| Python | 3.7.9 |
| Web profile | `C:\Users\RUNIC\.dsh\profiles\web` |
| 原生侧边栏包 | `@deepseek-ai/dsh-client-ui-sidebar-right`（`ctx.sidebarRightTabs` / `ctx.sidebarRight`） |
| 调试链路 | OpenOCD 0.12.0 + J-Link SWD（`interface/jlink.cfg`），RTT server `127.0.0.1:9090` |
| **网络** | ⛔ npm registry 不可达，代理未运行 → **禁止引入新依赖** |
| **J-Link 工具** | ⛔ `JLink*.exe` 未安装 → 只能走 OpenOCD 通路 |

---

## 关键决策点（Decision Gates）

> 未决项会阻塞后续阶段，必须由用户裁决。裁决结果回填本表。

| ID | 决策点 | 备选 | 裁决 | 状态 |
|---|---|---|---|---|
| D1 | 「实时变量」数据来源 | A 日志正则解析 / B OpenOCD 读内存 / C 改固件加结构化 RTT 通道 | **D. 先 A（日志解析），数据源抽象为 provider 接口，预留 B/C 扩展** | ✅ 已裁决 |
| D2 | 目标硬件可用性 | A 常连可联调 / B 仅偶连 / C 现在不可用 | **A. 能常连，可随时配合联调** | ✅ 已裁决 |
| D3 | 面板宿主 | A 原生右侧栏 tab / B better-sidebar 下方面板 / C 两者 | **C. 两者都要（核心视图做成可复用组件，双入口注册）** | ✅ 已裁决 |
| D4 | 波形图技术栈 | A 手写 Canvas / B 手写 SVG / C 复用已装 d3@7.9.0 | **A. 手写 Canvas 渲染（零依赖）** | ✅ 已裁决 |
| D5 | 「标尺」语义 | A 仅刻度轴 / B 仅游标测量 / C 刻度 + 游标都要 | **C. 刻度轴 + 悬停准星 + 可拖动双游标测量 + 自动测量（峰峰值/均值/频率/上升时间）** | ✅ 已裁决 |
| D6 | 「添加图例」交互 | A 变量列表点选 / B 手输表达式 / C 两者 | **B. 自动发现的变量列表勾选 + 自定义正则/表达式提取规则** | ✅ 已裁决 |
| D7 | 采样率与保留窗口 | 待定数值 | **C. 可配置（UI 设置项，给出合理默认值）** | ✅ 已裁决 |
| D8 | 交付形态与署名 | A 本地插件 / B 可发布 npm 包 / 仓库归属 | **A. 本地开发目录 + link 安装** | ✅ 已裁决 |
| D9 | OpenOCD 进程管理 | A 自动拉起 / B 仅 attach / C 可切换 | **C. 两种模式可切换（默认自动）** | ✅ 已裁决 |
| D10 | 上下分栏交互 | A 可拖拽+工具栏 / B 固定比例 / C 可拖拽+持久化 | **A. 可拖拽分隔条 + 波形区工具栏** | ✅ 已裁决 |
| D11 | 日志视图能力 | 多选 | **A 级别着色（含 RTT 颜色转义）+ B 关键字过滤/搜索 + C 自动跟随/上滚暂停 + D 导出日志 + E 行数上限环形缓冲** | ✅ 已裁决 |
| D12 | 变量发现规则 | A 自动识别 / B +KF 预设 / C 仅手写正则 | **A. 自动识别 `key=value` / `key:value` 形式** | ✅ 已裁决 |
| D13 | openocd.cfg 归属 | A 自带 / B 用 KF 的 / C 自带+可配 | **不自带；自动读取、首次由用户指定并记住（插件保持通用，不硬编码任何绝对路径）** | ✅ 已裁决 |
| D14 | 联调配合方式 | A 自行拉链路 / B 手动启动仅 attach / C 全程陪同 | **A. 由我自行拉起链路验证，需要时再找用户** | ✅ 已裁决 |
| D15 | 界面语言 | A 纯中文 / B 中英双语 | **B. 中英双语，跟随 DSH 语言** | ✅ 已裁决 |
| D16 | cfg 自动发现规则 | A 工作目录搜索 / B 优先KF / C 首次指定记住 | **C. 首次使用时由用户指定并记住到插件设置；路径一律用相对/可配置名称匹配，禁止硬编码绝对路径（插件须通用）** | ✅ 已裁决 |
| D17 | 多变量 Y 轴策略 | 待定（量纲不同：mV / 个 / s / ms / 布尔） | **单 Y 轴；变量可点选切换显示/隐藏**（不做双轴、不做归一化、不做多泳道） | ✅ 已裁决 |
| D18 | 通用性 | — | **通用插件**：不绑定任何芯片/固件/厂商；KF 仅作验证样本 | ✅ 已裁决 |
| D19 | 变量通道 | — | 变量走 **RTT 独立通道**（≠ 日志通道），通道号可配 | ✅ 已裁决 |
| D20 | 日志完整性 | — | 日志**完整**接收，不因变量采集而丢行 | ✅ 已裁决 |
| D21 | 本期重点 | — | **变量解析 + 日志解析** | ✅ 已裁决 |
| D22 | 变量通道默认格式 | A CSV / B keyvalue / C binary / D 全支持 | **D. 四种全支持，默认 CSV 文本行** | ✅ 已裁决 |
| D23 | 固件侧接入参考 | A 文档+C片段 / B 不需要 / C +demo | **A. 芯片无关接入文档 + 参考 C 片段** | ✅ 已裁决 |
| D24 | 交付批次 | A 核心先交 / B 全部 / C 分三批 | **C. 分三批，每批可独立验收** | ✅ 已裁决 |

> **全部决策门（D1–D24）已裁决完毕。** 阶段 0 需求评估完成。
> 定稿规格：`spec.md`（原则 G1–G5 / 验收 A1–A24 / 批次 1–3）

---

## 阶段划分

### 阶段 0：需求评估与计划（✅ 已完成）
- [x] 勘察工作目录与 DSH 环境
- [x] 勘察侧边栏注册 API（原生 + better-sidebar）
- [x] 勘察 RTT 链路与工具可用性
- [x] 落盘 `findings.md`
- [x] 落盘 `task_plan.md` + `progress.md`
- [x] 向用户提出关键问题并回收裁决（D1–D24 全部裁决）
- [x] 输出定稿需求规格 → `spec.md`（24 条验收标准 A1–A24 + 3 批交付计划）

**阶段 0 完成。**

> ⚠️ **重要修正已并入**（用户两次追加）：
> 1. **变量走 RTT 独立通道**（非日志文本正则）；日志须完整不丢行；
> 2. **本插件是通用插件**，不绑定 KF / RS32F066；所有功能与配置均可变。
>
> 由此新增决策 D18–D24，并新增硬性原则 G1–G5（见 `spec.md` §0）。

### 阶段 1：方案设计与技术选型（✅ 已完成）
- [x] 确定数据通道架构（Host 半：RTT 接入、进程管理、状态机）
- [x] 确定 Client 半：tab 注册 + 布局 + 波形渲染
- [x] 确定 RTT 解析器（日志行 → 文本流；变量 → 时间序列）
- [x] 定义 HTTP / WebSocket 路由契约
- [x] 明确「标尺」与「添加图例」的交互规格
- [x] 产出 `design.md`（含架构图、状态机、数据结构、错误处理、测试策略）
- [x] 复核并**修正**了「npm 不可达」的错误结论（见 findings §4.3 修正说明）

> 阶段 1 输入：`spec.md`（需求定稿）+ `findings.md`（环境约束 C1–C10）
> 阶段 1 输出：`design.md`（v1.0）

### 阶段 1.5：编码前置确认（✅ 已完成）
- [x] O1 构建工具选型 → **tsdown**（`0.23.0`，与 DSH 生态一致）
- [x] O2 依赖安装方式 → **项目本地 devDeps + 项目 `.npmrc`**（cache 指向工作区内）
- [x] O3 git 仓库 → **是**，`git init` + 作者 `JiXieShi <lydxh935227514@gmail.com>`
- [x] O4 变量默认通道 → **日志=0，变量=1**

### 阶段 2：Host 半实现（✅ 批次 1 完成）
- [x] 插件骨架（`package.json` / `.npmrc` / `tsconfig` / `tsdown.config` / `cordis.patch.yml`）
- [x] 配置 schema + DeviceProfile + 校验（`src/config.ts`）
- [x] OpenOCD 进程管理：attach-优先-spawn、就绪探测、崩溃重连、argv 安全（`src/openocd/manager.ts`）
- [x] TcpLink（每流独立背压策略）+ LineSplitter/FixedFrameSplitter（`src/core/`）
- [x] ParserRegistry + 4 解析器（csv/keyvalue/binary-frame/custom-regex）
- [x] SeriesStore / LogStore（含完整性计数器）+ AnsiDecoder + detectLevel
- [x] OCD 数据源：TCL 客户端（只读白名单）+ 符号解析 + 批量读/撕裂读防护（`src/ocd/`）
- [x] 手写 RFC 6455 WebSocket（零运行时依赖）（`src/core/ws.ts`）
- [x] DebugService 三源编排（`src/service.ts`）
- [x] HTTP + 2×WS 路由 + 浏览器信任栅栏（`src/index.ts`）

### 阶段 3：Client 半实现（✅ 批次 1 完成）
- [x] 双入口注册（原生右侧栏 tab + better-sidebar 工作台）（`src/client/index.tsx`）
- [x] 手写 Canvas 波形：网格/刻度/准星/双游标/像素 min-max 抽取/自动测量（`src/client/plot.ts`）
- [x] 面板布局：上波形 + 可拖拽分隔条 + 下日志（`src/client/panel.tsx`）
- [x] 图例管理（勾选显隐 + 变量选择弹层）
- [x] 日志视图（级别着色/过滤/跟随/导出/行数上限）
- [x] 中英双语（跟随宿主 locale）（`src/client/locales.ts`）
- [x] 样式隔离（CSS 字符串注入，全部 `.rttd-*` 命名空间）

### 阶段 4：测试与构建验证（✅ 批次 1 完成）
- [x] 单元测试：解析器 39 / 核心 27 / OCD 35
- [x] 集成测试：service 14（mock TCP，含日志完整性压测）
- [x] `tsc --noEmit` 零错误
- [x] `tsdown` 双产物构建成功
- [ ] 真机联调（等待用户上电；不可用 mock 替代）

### 阶段 5：交付与文档（🟡 进行中）

> 说明：本轮（缺陷修复轮）补齐了阶段 5 的**文档**部分；阶段 5 的**批次 2/3 功能范围**仍未实现。
> 判定口径见 `coordination/acceptance.md` §5.2（t1 对账）、`coordination/integration.md` §6.4（A1 再分类）与 `coordination/verify.md` §14.10（A9b）：
> **A1–A24 三态 = 已满足 9 / 未满足 1（仅 A24）/ 本机不可验证 15（含 A1、A9b）= 25 条（A1–A24 + spec 内 A9b）**；**项目整体不可宣称已交付完成**。
> **计数相对 t1 口径的两次再分类**：① A1（t11，裸读已修 + 未挂载属部署状态）② **A9b（t15，真机缺位 → 真实内存读取出数从未验证）**。
> 两者都**不是**「已满足」——已满足项不得包含它们。

- [x] `README.md`（安装/使用/配置/双入口/故障排查/版本基线/已知问题）
- [x] 《目标端接入说明》+ 参考 C 片段（D23）→ `docs/target-integration.md`
- [x] 缺陷修复轮的全部文档同步（`README.md` §6 故障排查、`docs/target-integration.md` 的缓冲核算 R7）
- [x] README 四处不一致修正（D-1 A1 三态统一 / D-2 跨包路径前缀 / D-3 脚本清单补齐 / D-4 同轮次复跑出处）
- [x] 变量直读文档补全（t15）：README §4.2 两条变量来源 + 「变量源」面板操作步骤 + 手填语法与 `_t` 别名口径；§4.4 生效时机；§4.5 持久化与静默跳过；§6.8 排障；A9b 表述修正
- [ ] 批次 2/3 范围（见 `spec.md` §8）
  - [ ] A1 第二入口在**真实浏览器页面**中可见性（**本机不可验证**，见 `coordination/acceptance.md` §4 N6/N10；A1 三态归「本机不可验证」，限定语见 README §7.3）
  - [ ] **A9b 真机 OCD 出数**（`mdw` 真机读回、波形出数）—— **本机不可验证**（无目标板/无调试器，TCL 6666 未监听）；t17 的「f32 → 42.5」取自**本地 mock TCL**，**不得**据此判通过（`coordination/verify.md` §14.10）
  - [ ] A24 Device Profile 多套保存/切换/**导入导出** —— **已由用户裁决列入遗留项，本轮不实现**（**唯一**「未满足」项）
  - [ ] A1/A9b/A16/A19/A21 等 **15 项**「本机不可验证」项的**真机/浏览器**复验（清单见 `coordination/acceptance.md` §4）

#### 阶段 5 交付物清单（本轮新增/更新）

| 文件 | 状态 | 内容要点 | 依据 |
|---|---|---|---|
| `README.md` | ✅ 新建 | 安装（含「junction ≠ 挂载」+ 挂载矩阵**五情形**实测）、构建/测试、配置项全表、**§4.2 变量直读如何取变量列表（A 区/B 区 + 面板步骤 + 类型推断 + 手填语法）**、双入口与 sessionId 口径、故障排查（含 §6.8 持久化与类型漂移）、已验证/未验证/已知问题、A1–A24 三态 | D23、G1/G2、A23 |
| `docs/target-integration.md` | ✅ 新建 | 双通道区分、4 种格式的帧格式与实测示例、缓冲核算与丢包（R7）、芯片无关参考 C 片段（**已用 arm-none-eabi-gcc 14.2.Rel1 / Cortex-M0+ 实编通过**）、接入自检清单、待确认项 | **D23**、G3/G4、A8/A9、findings R7 |
| `task_plan.md` | ✅ 更新 | 本阶段勾选项 + 已知问题 + 交付物清单（**只追加/状态更新，未删除历史**） | 用户裁决 |
| `progress.md` | ✅ 更新 | 追加「会话 #7 —— 缺陷修复与隔离验证」+「会话 #8 —— 变量直读补全」完整记录（根因/修复/验证证据/复现命令） | 用户裁决 |

---

## 非目标（Non-Goals，除非用户另行要求）

- ❌ 不做 SWD 调试器替代品（不实现断点/单步/寄存器编辑）
- ❌ 不修改 KF 固件（除非 D1 裁决为「改固件加 RTT 通道」）
- ❌ 不引入新的第三方运行时依赖（受 §网络 约束）
- ❌ 不触碰 DSH 自身配置与组成文件（`~/.dsh` 下 composition / settings / mcp.json）

---

## 已遇到的问题与对策

| # | 问题 | 尝试次数 | 对策 |
|---|---|---|---|
| P1 | `Get-ChildItem` 扫描 `C:\Program Files` 被沙箱拒绝（`Web Server\certs\keys` 等） | 1 | 改为精确路径定位，不做全盘扫描 |
| P2 | `npm view` 报 `EPERM`（缓存目录 `C:\Users\RUNIC\scoop\persist\nodejs\cache\_cacache\tmp`） | 1 | 放弃 npm registry 查询，改用本地已装包类型定义取证 |
| P3 | npm registry SSL 连接失败、代理 7890 未运行 | 2 | **记录为硬约束**：零新依赖（**后于阶段 1 经用户提示复测推翻**：真因是缓存目录在沙箱外，见 findings §4.3） |
| P4 | PowerShell `Substring` 越界（文件仅 119 字节 BOM 处理） | 2 | 改用 `Select-String -Context` / `-TotalCount` 分页读取 |
| **P5** | **插件加载失败：`cannot get property "betterSidebar" without inject`** | 多轮 | **已修复**：裸读 `ctx.betterSidebar` → `ctx.inject?.(['betterSidebar'], injected => injected.get(...))` + 判空。详见下节「已知问题」G-1 |
| **P6** | **入口 A 的 effect owner 归属错误 → 槽重复 key / tab-id 重复** | 3 | **已修复**：disposer 由外层 `ctx.effect` 改挂 `injected.effect`。详见 G-2 |
| **P7** | **入口 A 读了从不存在的 `props.tab`，sessionId 丢失 → cfg 相对路径回落 `process.cwd()`** | 多轮 | **已修复**：改从槽的 `inject` face 取（`inject: (sessionId) => ({ sessionId })`）。详见 G-3 |
| **P8** | 无头浏览器不可用（`msedge.exe` mojo 命名管道被拒，退出码 `-2147483645`），无法做 DOM 级验证 | 2 | 改为**口径 A**：把服务端实际下发的字节喂进真实 Cordis 调用 `apply`（`coordination/artifact-judge.mjs`），并在报告中如实标注这是替代口径 |
| **P9** | 沙箱禁止管道型子进程 stdio（`execFile` → `spawn EPERM`），`node --test test/` 与 `listElfSymbols()` 直接调用均失败 | 2 | 测试改用 `--test-isolation=none`；`listElfSymbols` 的真实调用留待宿主进程内验证，本机改用手工比对 `nm` 输出与插件正则 |

---

## 已知问题与遗留项（本轮如实登记，不隐藏）

> 登记口径：**每一条都给出级别、现象、依据与复现方式**；无法在本机验证的，明确标注「待现场确认」而不断言。

### G-1（已修复）加载失败：`cannot get property "betterSidebar" without inject`

| 项 | 内容 |
|---|---|
| 需求依据 | 验收 **A1**、决策 **D3**（双入口，缺失即降级） |
| 症状 | `failed to apply loader entry <id> (dsh-rtt-debug): cannot get property "betterSidebar" without inject`；整个 `apply` 被终止，**两个入口都不注册** |
| 根因 | `src/client/index.tsx:127`（修复前）裸读 `(ctx as unknown as { betterSidebar?: … }).betterSidebar`。Cordis 的 Proxy `get` 陷阱对**未在 `inject` 中声明**的服务抛错；类型断言只骗过编译器，不改变运行时语义，且判空写在读取之后（永远执行不到） |
| 关键事实 | `betterSidebar` 由 **兄弟插件 fiber**（`dsh-better-sidebar`）提供，**不是祖先 fiber** → **装或不装该插件，裸读都必抛**（`coordination/acceptance.md` §1.3 三行拓扑对照） |
| 修法 | `ctx.inject?.(['betterSidebar'], injected => injected.get('betterSidebar'))` + 判空 |
| **错误修法（已排除）** | **硬 `inject: ['betterSidebar']`**：服务缺失时 `apply` 根本不执行、fiber 停在 `PENDING`，直接违反 D3。本机复测：`{"label":"hard-inject-missing","applyRan":false,"fiberState":0,"stateName":"PENDING"}` |
| 验证 | 修复后隔离实例（独立 `DSH_HOME` + 显式挂载）`RESULT: PASS`；`no-workbench` 场景 `throw=none`、`workbench:0`（**降级成立**）；`with-workbench` 场景 `workbench:1`（入口 B 注册）。见 `coordination/verify.md` §12 |

### G-2（已修复）入口 A 的 effect owner 归属错误

| 项 | 内容 |
|---|---|
| 症状（**实测为准**） | 常见拓扑下首先出现 **slot 重复 key**：`keyed slot "sidebar.right.pane.tab" already has an entry for key "dsh-rtt-debug"`；tab-id 形式的 `tab type id "dsh-rtt-debug" is already registered` **仅特定拓扑可达**（在注册表实例跨 fiber 存活并被重新 provide 的拓扑下可复现） |
| 根因 | 入口 A 的注册 disposer 挂在**外层 `ctx`** 上，服务消失时未释放 → 服务重现时重复注册 |
| 修法 | 改挂 `injected.effect(...)`（等待中的子 fiber，`src/client/index.tsx:154-157`）：服务消失时先释放，重现时再注册 |
| 验证 | 修复前 3 轮 flap：每轮 `slot duplicate-key errors: 3`；修复后：每轮 `up{tab:1,slot:1} → down{tab:0,slot:0} → back{tab:1,slot:1}`，0 duplicate，teardown 0/0（`coordination/verify.md` 引用 t7 证据） |
| **待现场确认** | 在**真机/完整浏览器**中观察该症状需要可见页面；本机无头 Edge 不可用 → 记为待现场确认，不宣称"真机已复现" |

### G-3（已修复）入口 A 读了从不存在的 prop，sessionId 丢失

| 项 | 内容 |
|---|---|
| 症状 | 面板能打开，但 **cfg 相对路径解析到插件目录**而非会话工作区（Host 回落 `process.cwd()`） |
| 根因 | `sidebar.right.pane.tab` 这个 seat 由宿主以 `renderSlot(seat, {}, …)` 分发，**owner props 恒为 `{}`**，所以 **`props.tab` 永远 undefined**（`dsh-client-ui-sidebar-right` 的 `lib/client.js:736` 实测） |
| 修法 | 入口 A 改从**槽的 inject face** 取：`inject: (sessionId) => ({ sessionId })`（`src/client/index.tsx:147`）。入口 B 同类缺陷一并修：better-sidebar 传 `scope = { sessionId, cwd }`，原 `component: () => panel()` 丢弃之 → 现为 `panel(props?.scope?.sessionId)`（`src/client/index.tsx:193`） |
| **准确表述（勿写错）** | `sessionId` **确实同时是框架 standard prop**（ui-session 的 `BUILTIN_SOURCE` 声明 `props: ['sessionId']`，渲染器 `renderEntry` 把 `{ …kit, …injected, …slotInjected.props, …ownerProps }` 一起展开）→ **有两条等价通道**；本插件选用**显式声明的 inject face**（上游文档化的正道）。**不要写成"sessionId 不是从组件 props 来"** |
| 验证 | URL 级：修复后入口 A/B **各 3/3** 发出 session-scoped 请求；按修复前形态重建则 **0/3**。Host 侧：带 `?sessionId=` 时解析到会话 cwd、不带时回落 `process.cwd()`（t9 独立复核，`src/index.ts:206-210`） |

### G-4（**未修复，残留风险**）入口 A 的 `slots` 未列入 `inject` —— **级别 low**

| 项 | 内容 |
|---|---|
| 现象 | 隔离环境下可复现「**加载成功但面板永不注册**」：`injected.get('slots')` 为 `undefined` 时直接 `return`（`src/client/index.tsx:114-118`） |
| 实测复现 | 用 `coordination/artifact-judge.mjs` 的拓扑改造（`.verify\docs-parsers\g4-repro.mjs`）：provide `sidebarRightTabs` **+** `slots` → `{"nativeTab":1,"nativeSlot":1}`；**只 provide `sidebarRightTabs` 而不 provide `slots`** → `throw:"none"` 但 `{"nativeTab":0,"nativeSlot":0}` |
| 为什么仍判 low | **真实拓扑不可达**：`dsh-client-ui-sidebar-right` 自身**硬 inject** `['slots','layout','locale','resources']`（取证路径**不是**本项目的 `lib/client.js`，而是该包自己的：`<profiles>\node_modules\@deepseek-ai\dsh-client-ui-sidebar-right\lib\client.js:3648-3653`，该包 3780 行；本项目 `lib/client.js` 行数远小于此），四者齐备前不会 `provide('sidebarRightTabs')` → 等待 `sidebarRightTabs` 成功时 `slots` 必然已在。且 t8 新增的 inject face **未引入任何新的服务读取** |
| 可选加固 | `ctx.inject?.(['sidebarRightTabs','slots'], …)` |

### G-5（**未满足，遗留项 —— A1–A24 中唯一一项**）A24 Device Profile 多套保存/切换/**导入导出**

| 项 | 内容 |
|---|---|
| 状态 | **未满足**（**唯一**未满足项），**已由用户裁决列入遗留项，本轮不实现** |
| 已有 | 数据结构 `DeviceProfile`（`src/config.ts:131-141`）；`POST /config` 切换 `activeProfile` 与替换配置（`src/index.ts:260-273`）；`POST /profiles/add` 新建（`src/index.ts:281-292`）；settings 持久化（`src/index.ts:164-180`） |
| 缺失（实测） | 对 `src/**` 检索 `importProfile\|exportProfile\|profiles/import\|profiles/export` → **0 命中**；`src/client/panel.tsx` 检索 `profile` → **0 命中**（**无 profile 管理界面**）。而 `spec.md:387` 明确要求「导入导出」 |
| 复现 | `Select-String -Path src\*.ts,src\**\*.ts -Pattern 'importProfile\|exportProfile'` → 无输出 |

### G-6（记录）判定盲区与遗留产物

| 项 | 内容 |
|---|---|
| 测试覆盖盲区 | `test/` **完全未覆盖 `src/client/**`**：`plot.ts` 的 `deltaBetween`/`measure`/`ticksFor`/`decimateToPixels` 与 `panel.tsx` 的 `filterLog` **零单测** → A5/A6/A7 只有「代码存在 + 守卫级加载通过」，**没有算法正确性证据** |
| 测试口径 | `npm test` 现为 **115 pass / 0 fail**（parsers 39 / core 27 / ocd 35 / service 14）。**勿写旧的 101**（那是 `package.json:48` 未纳入 `service.test.ts` 时的数字） |
| 陈旧产物 | `lib/client.iife.js`（**40 字节**）、`client.iife.js.map`、`index.mjs`、`index.mjs.map`，mtime `17:49:27`，早于最终构建 → `progress.md` B5（IIFE 试错）遗留。**不参与加载**（加载只看 `lib/index.js` / `lib/client.js`） |
| 本机不可验证项 | N1–N10 清单见 `coordination/acceptance.md` §4；其中 9090/9091/6666 均 `LISTENING=False`、`JLinkRTTLogger.exe`/`JLinkRTTClient.exe` NOT FOUND（PATH 上的 `jlink.exe` 是 **JDK** 的）、无头 Edge 不可用 |

### G-7（**已修复，blocker**）配置持久化对真实 settings 服务完全不工作

> t14 发现 → t21 修复 → t22 复核通过。**修复前的版本无法保存配置。**

| 项 | 内容 |
|---|---|
| 症状 | ① `/config` 写入返回 `persisted:false` + `settings namespace "[object Object]" must match /^[a-z][a-z0-9-]*$/`；② **重启后配置全部丢失**（`elfPath`/`intervalMs`/`variables` 全回落默认）；③ 预置的 `settings.yaml` **读不到** |
| 四部分根因 | ① 写入形状错（单对象 `{[ns]:config}` vs 真实 `update(ns, patch)`）；② namespace **从未 `register`**（未注册时 write 直接抛）；③ `ctx.get('settings')` **apply 期返回 undefined** → **整段持久化被静默跳过**（也是启动日志一直「干净」的原因）；④ 读取形状错（`get().value` vs 真实 `get(ns)`） |
| 修法 | 真实契约（`register(ns, schema函数)` / `get(ns)` / `update(ns, config)`）+ `ctx.inject(['settings'], …)` + **有界就绪门** `persistenceReady`（1000 ms 兜底，handler 顶部 await，`src/index.ts:152-181`/`:194`）；另：`/profiles/add` 由「只靠 teardown」改为**请求内立即持久化**（`src/index.ts:588-597`） |
| 为何 t12 没抓到 | `src/index.ts:69-72` 的 `SettingsFace` 是**按假设声明**的；**与该假设形状一致的自建 stub 会接受这两种调用，真实服务不会**；`test/` 下 0 处涉及 settings |
| 验证 | `coordination/t14-api-probe.ps1` **修复前 1 failed → 修复后 0 failed**（含跨重启读回）；t22 用**真实 cordis + 真实 FileSettingsProvider + 真实 lib/index.js** 复核：三成员调用完全匹配真实契约，跨重启 1204 B 文档、`intervalMs:250` 读回成功 |
| 用户影响 | ⚠️ **修复前配过的 OCD 变量很可能已丢失（写入根本没落盘），需重新配置** |
| 出处 | `coordination/verify.md` §13.5；`.verify/evidence/t14-final/FINDING-settings-persistence.md` |

### G-8（**已修复**）变量直读没有变量发现机制 + 类型别名在两半漂移

| 项 | 内容 |
|---|---|
| 缺口① | **OCD 直读原先没有变量发现入口**：`ocd.variables` 默认空数组；`POST /symbols` 与 `/ocd-vars` **早已实现**、transport 封装也已定义，却**全 client 目录零调用**，panel 也无配置 UI → 用户**没有任何办法**配置变量。t12 补齐「变量源」面板（`src/client/panel.tsx:667` 起，`VariableSources`） |
| 缺口② | **类型别名在 client 侧有一份复制实现**，只认 9 个规范拼写，且 Form A 对无法识别的拼写**静默回落 `u32`** → **按错误宽度解码**（实测 `42.5f` 被读成 **`1110048768`**）；Form B 则是**合法别名被误拒**。精确划分：**Form A = 静默错宽度；Form B = 合法别名被误拒**（均已消除） |
| 修法 | t16 抽出**共享单一实现** `src/ocd/binding-parse.ts`（宿主与浏览器两半同源，`src/ocd/symbols.ts:24` 转出）；Form A 的类型组放宽到含下划线，使 27 个拼写两个形式都接受；无法识别 → **拒绝并回显原文**（`unknown-type`），不静默改成 u32 |
| 复核 | t20 在**真实 UI 提交路径**上验证：`VoltMv@0x20000000:float` → `f32` / **42.5**（t13 记为 `u32` / `1110048768`）；**负向对照**（同路径同地址同位模式绑 `u32`）得 **1110048768** → 证明是类型正确带来的，非探针伪像 |
| 遗留 | 修复前 Form A 存下的 `type:'u32'` **已销毁原始拼写证据，无法自动迁移** → **修复前建立的手填行请删后重加** |
| 出处 | `coordination/verify.md` §14（t18）；`coordination/alias-e2e-probe.mjs` |

### G-9（记录）判定盲区与遗留产物（承 G-6，追加）

| 项 | 内容 |
|---|---|
| `.map` 不支持 | `spec.md:372` 的 A9b 判据写了「或解析 `.map`」，但**实现检索零命中** → 符号解析**只走 `nm`**。**文档不得声称支持 `.map`**（README §4.2.1 已显式更正） |
| `elfPath` 不做工作区根解析 | 与 `openocd.configPath` **不同**：`elfPath` 逐字透传（`src/index.ts:609-613`），相对路径按**宿主进程 CWD** 解析；仓库内检索「elfPath 工作区根解析」**0 命中** |
| ⚠️ UI 文案与实现不符（**新发现，未修**） | `src/client/locales.ts:67` 的 `sources.elfPathHint` 写着「相对路径按当前会话的工作区根解析」，与上面实测**不符**（该处属 client 文案，不在 t15 的 in-scope：本轮只改文档）。README 已按**实现**口径写明并标注该差异；**建议后续轮次修正该文案或让实现按工作区根解析**，二者取一 |

---

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 初始 | 建立计划 | 需求评估阶段启动 |
| 缺陷修复轮 | 阶段 5 勾选 `README.md` 与 D23 文档；新增「已知问题与遗留项」G-1…G-6；新增 P5–P9 问题行；新增阶段 5 交付物清单 | 补齐可交付文档；将本轮修复与残留风险如实登记（**只追加/状态更新，未删除任何历史记录**） |
| 缺陷修复轮（t11） | 三态计数统一为 已满足 10 / 未满足 1（仅 A24）/ 本机不可验证 14（含 A1）；阶段 5 增列「README 四处不一致修正」为已完成；A1 条目改归「本机不可验证」并加限定语 | 采纳 `coordination/integration.md` §6.4 的 A1 再分类（队长裁定）；消解 README 内 A1 归类自相矛盾（D-1） |
| 缺陷修复轮（t15） | 三态计数再改为 **已满足 9 / 未满足 1（仅 A24）/ 本机不可验证 15（含 A1、A9b）**；README 新增 §4.2（两条变量来源 + 面板步骤 + 类型推断 + 手填语法）、§4.4（生效时机）、§4.5（持久化 + 静默跳过）、§6.8（排障）；修正 `.map` 与 `elfPath` 两处不准确描述；新增 G-7…G-9 | 为「变量直读 + 类型漂移 + 持久化 + Form A 放宽」更新交付文档；**A9b 真机出数未验证不得列「已满足」**（t14/t18 明确要求） |
