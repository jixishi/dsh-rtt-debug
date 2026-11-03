# dsh-rtt-debug

**DSH Web 侧边栏插件：上方实时变量波形图（带标尺）+ 下方完整 RTT 日志**，三路数据源并行、可独立启停。

- **作者**：JiXieShi
- **版本**：`0.1.0`
- **工作目录**：`W:\dsh-plugins\dsh-rtt-debug`（Windows / PowerShell）
- **定位**：**通用插件**——不绑定任何芯片 / 固件工程 / 厂商（规格 `spec.md` §0 原则 G1、决策 D18）。
  RTT 通道号、端口、控制块搜索区、解析器、符号地址、采样参数**全部可配**，默认值只是行业通用默认值。

> 本文每条结论都标注了**依据来源**（需求编号 / 文件行号 / 命令）。凡本机**未能验证**的，明确写成「无法验证」，不做推断。
> 目标固件侧怎么接入（写哪条通道、怎么发数据）见姊妹文档 [`docs/target-integration.md`](docs/target-integration.md)。

---

## 0. 先看结论（TL;DR）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **仅建 junction / `npm link` 不会让插件被加载**，必须**显式挂载**（加入 profile 的 `dsh.profile.bundles`，或在 profile 的 `cordis.patch.yml` 加 `insert` 行） | 本机实测，见 §2.2「挂载矩阵」；`coordination/acceptance.md` §0.1 |
| 2 | 本机现有 web profile **没有挂载本插件**（junction 存在但配置零引用），所以**当前 `http://127.0.0.1:3080` 的界面里看不到它** | `Select-String` 零命中，见 §2.3 |
| 3 | 本轮的 Cordis 守卫缺陷（`cannot get property "betterSidebar" without inject`）**已修复**，并在**隔离实例**端到端验证通过 | `coordination/verify.md` §12（verdict=pass） |
| 4 | `npm test` = **115 pass / 0 fail**；`npm run typecheck` = **0 error**；`npm run build` = 产出 `lib/index.js` + `lib/client.js` | 本机实测，见 §3.3 |
| 5 | 真机链路、浏览器像素级外观、日志完整性对照**本机无法验证**（无调试器、无头浏览器不可用） | `coordination/acceptance.md` §4 的 N1–N10；`coordination/verify.md` §12.9 |
| 6 | **A24（多套 Device Profile 的保存/切换/导入导出）已由用户裁决为遗留项，本轮不实现** —— 它是**唯一**“未满足”项 | `spec.md:387`；`coordination/acceptance.md` §5 判「未满足」 |
| 7 | **A1 归入「本机不可验证」（非「已满足」）**：注册代码与降级路径已验证（两入口均注册成功、`throw=none`），但「在真实页面打开」未验证（本机无可用浏览器） | `coordination/integration.md` §6.4（再分类）；§7.3/§7.4 |
| 8 | **A9b 同样归入「本机不可验证」（非「已满足」）**：配置链路与类型链路已验证，但**真机内存读取出数从未验证**（无目标板/无调试器，TCL 6666 未监听） | `coordination/verify.md` §14.10；§7.3/§7.4 |
| 9 | ⚠️ **修复前的版本无法保存配置**：若你在修复前配过 OCD 变量，**很可能已丢失，请重新配置** | `coordination/verify.md` §13.5；§4.5 |

> **三态计数（全文统一口径）**：已满足 **9** / 未满足 **1（仅 A24）** / 本机不可验证 **15（含 A1、A9b）** = **25** 条（A1–A24 + spec 内 A9b）。见 §7.4。

---

## 1. 它做什么

三路数据源并行（规格 `spec.md` §3.2.1，决策 D25），**任一路可单独开关**，互不干扰：

| # | 数据源 | 通路 | 是否需要固件配合 | 代码锚点 |
|---|---|---|---|---|
| 1 | **RTT 日志** | RTT up-channel 0 → `openocd "rtt server start 9090 0"` → TCP 9090 | 是（打印日志） | `src/service.ts:254-283` |
| 2 | **RTT 数据通道** | RTT up-channel 1 → `openocd "rtt server start 9091 1"` → TCP 9091 | 是（写通道） | `src/service.ts:285-312` |
| 3 | **OCD 变量读取** | OpenOCD TCL 端口（默认 6666）`mdw`/`mdh`/`mdb` 直读内存 | **否**（零固件改动） | `src/ocd/reader.ts`、`src/ocd/tcl.ts` |

界面：**上方波形**（刻度轴 / 网格 / 悬停准星 / 可拖动双游标 Δt·ΔV·1÷Δt / 自动测量 峰峰值·均值·频率·上升时间 / 图例勾选显隐），
**可拖拽分隔条**，**下方 RTT 日志**（级别着色含 SEGGER 颜色转义 / 关键字与正则过滤 / 自动跟随与上滚暂停 / 导出 / 行数上限环形缓冲）。
中英双语，跟随宿主语言（决策 D15 / `src/client/locales.ts`）。

---

## 2. 安装

### 2.1 环境基线（不可变前提）

| 项 | 本机实测值 | 取证命令 |
|---|---|---|
| DSH | `0.1.5-rc.1` | `dsh --version` |
| Node | `v26.8.1` | `node --version` |
| pnpm | `11.21.0` | `pnpm --version` |
| DSH_HOME | `C:\Users\RUNIC\.dsh` | `$env:DSH_HOME` |
| Web profile | `C:\Users\RUNIC\.dsh\profiles\web` | 目录读取 |
| 在用实例 | `http://127.0.0.1:3080`（**安装时不得干扰**） | `netstat -ano \| Select-String ':3080\s+.*LISTENING'` |
| openocd | `0.12.0 (2023-01-14)` @ `C:\Users\RUNIC\scoop\shims\openocd.exe` | `openocd --version` |
| SEGGER J-Link 工具 | ⛔ **未安装**（`JLinkRTTLogger.exe` / `JLinkRTTClient.exe` 不在 PATH；PATH 上的 `jlink.exe` 是 **JDK** 的） | `Get-Command JLinkRTTLogger.exe` |
| RTT 端口 9090/9091、TCL 6666 | 本机当前**均未监听**（无目标板/无 OpenOCD 在跑） | `Test-NetConnection 127.0.0.1 -Port 9090` |

> 因 J-Link 官方工具缺失 + 端口未监听，本机只能走 **OpenOCD 通路**，且**真机联调无法在本机完成**（`coordination/acceptance.md` §4 N1–N5）。

### 2.2 ⚠️ 关键事实：junction ≠ 挂载（本机实测）

本机已存在如下 junction：

```
C:\Users\RUNIC\.dsh\profiles\web\node_modules\dsh-rtt-debug
    → W:\dsh-plugins\dsh-rtt-debug          （LinkType = Junction）
```

但**该 profile 的配置里没有任何地方引用它**——因此它**不会被加载**。DSH 的组成树是按 `dsh.profile.bundles` 顺序**逐层套用每个 bundle 自己的 patch 文件**（`cordis.patch.yml`）再叠加 profile 自己的 patch 层得到的，`node_modules` 里有没有这个目录**不参与**这个计算。
（机制取证：`...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js:287-309` 的文件头注释与 `:843-871` `loadProfileDirectory()`。）

**我复现了「挂载矩阵」，五种情形逐一实测**（在**隔离** DSH_HOME 下做的，未触碰 `~/.dsh`；命令见 §2.5）。
每种情形**各用一个全新 profile**，所以下表的"命中"就是该情形**自身的增量**：

| # | 做法 | `dsh --dump-config` 命中 `dsh-rtt-debug` | 结论 |
|---|---|---|---|
| 1 | **仅建 junction** | **0 命中** | ❌ 不加载 |
| 2 | junction + 把 `dsh-rtt-debug` 追加进 `dsh.profile.bundles` | **3 命中**（`# == dsh-rtt-debug` / `- id: dsh-rtt-debug` / `name: dsh-rtt-debug`） | ✅ **加载** |
| 3 | junction + 在 profile 的 `cordis.patch.yml` 写 `insert` 行 | **3 命中**（`# == <该 patch 文件路径>` + 两行） | ✅ **加载** |
| 4 | junction + `--patch <overlay.yml>`（overlay 内容即本插件的 `cordis.patch.yml`） | **3 命中**（`# == <overlay 路径>` + 两行） | ✅ **加载** |
| 5 | 官方 CLI：`dsh plugin --profile <iso> add link:<repo>` | `exit=0`；`dependencies` 出现 `dsh-rtt-debug link:W:/dsh-plugins/dsh-rtt-debug`；**`dsh.profile.bundles` 自动包含**；dump-config **3 命中** | ✅ **加载（推荐路线）** |

> ⚠️ **别把不同情形叠在同一个 profile 上比对**：它们是**累积**的。
> 我在**同一个** profile 上顺序执行 1→2→3→4 时，命中数是 **0 → 3 → 6 → 9**，
> 容易被误读成"情形 3/4 各产生了 6/9 行"。要复现上表，**每种情形用一个新 profile**。

> 第 2 行的机制：`dsh plugin` 子命令会**按已安装状态**调和 `dsh.profile.bundles`
> ——某个依赖若声明了 `dsh.bundle`，它就会被追加进 bundle 栈
> （取证：`...\@deepseek-ai\dsh\lib\plugin-Ddi42qoW.js:34-78` `reconcilePlugins()`）。
> 本插件**自带** `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它），内容是一条
> `insert: [{ id: dsh-rtt-debug, name: dsh-rtt-debug }]`——所以走官方 CLI 安装时**应当**会被自动挂上。

### 2.3 本机当前实际安装状态（实测）

| 断言 | 实测 | 取证 |
|---|---|---|
| profile `node_modules` 下存在本插件的 junction | ✅ `LinkType=Junction`，`Target=W:\dsh-plugins\dsh-rtt-debug` | `Get-Item ... -Force \| Select LinkType,Target` |
| 该包出现在 profile `package.json` 的 `dependencies` | ❌ **不存在**（0 命中） | `Select-String <profile>\package.json -Pattern 'dsh-rtt-debug'` |
| 该包出现在 `dsh.profile.bundles` | ❌ **不存在**（0 命中） | 同上 |
| 该包出现在 profile `cordis.patch.yml` | ❌ **不存在**（`'rtt'` 0 命中） | `Select-String <profile>\cordis.patch.yml -Pattern 'rtt'` |

→ **结论：本机在用实例 3080 当前并没有加载本插件。** 若要在 3080 里看到它，必须按 §2.4 显式挂载（会写 `~/.dsh`，属对在用实例的改动，**应由用户确认后执行**）。

### 2.4 可照做的挂载步骤（三条路线，任选一条）

> 三条路线**都需要先把插件放到 Node 能解析的位置**：`dsh plugin ... add` 会自己建立链接；
> 手工路线需要自己建 junction 或 `npm link`。**只有链接是不够的**（见 §2.2）。

**路线 A —— 官方 CLI（推荐，会同时完成链接 + 挂载 + 调和 bundles）**

```powershell
# 在插件源码目录下执行；pnpm 会把 link: 规格锚定到你当前所在目录
cd W:\dsh-plugins\dsh-rtt-debug
dsh plugin --profile web add link:W:\dsh-plugins\dsh-rtt-debug
# 期望：pnpm 输出 "dependencies: + dsh-rtt-debug link:W:/dsh-plugins/dsh-rtt-debug"，
#       且 profile 的 package.json 里 dsh.profile.bundles 出现 "dsh-rtt-debug"
```

> **我在隔离实例里实测过这条命令**：`exit=0`，`dependencies` 出现 `dsh-rtt-debug link:W:/dsh-plugins/dsh-rtt-debug`，
> `dsh.profile.bundles` 自动包含 `dsh-rtt-debug`，随后 `--dump-config` 命中 3 行。
> **注意**：本机尚未对 `web` profile 执行过这条命令（见 §2.3），所以上面的「期望」来自隔离实测，不是 3080 的既成事实。

**路线 B —— 用插件市场（dshmarket）启用**

本机已装 `dshmarket@1.47.0`（在 `dsh.profile.bundles` 内）。它的「插件管理 / 热禁用-启用」开关会往 profile 的
`cordis.patch.yml` 写入 `- id: …` + `disabled: true|false` 行，属官方补丁层机制。
对**本地源码目录**的插件，更稳妥的是走路线 A 或 C。

**路线 C —— 手工：junction + 在 profile 的 `cordis.patch.yml` 加 `insert` 行**

```powershell
$Prof = 'C:\Users\RUNIC\.dsh\profiles\web'
$Nm   = Join-Path $Prof 'node_modules'
New-Item -ItemType Junction -Path (Join-Path $Nm 'dsh-rtt-debug') -Target 'W:\dsh-plugins\dsh-rtt-debug' -Force
# 然后把下面的 insert 行追加进 $Prof\cordis.patch.yml（保留原有内容）
```

本插件的 `cordis.patch.yml` 全文（可用 `Get-Content W:\dsh-plugins\dsh-rtt-debug\cordis.patch.yml` 查看）：

```yaml
- insert:
    - id: dsh-rtt-debug
      name: dsh-rtt-debug
```

或者不改 profile、改用一次性 overlay（相当于 §2.2 挂载矩阵的第 4 种情形，**不持久化**，每次启动都要带）：

```powershell
dsh --profile web --patch W:\dsh-plugins\dsh-rtt-debug\cordis.patch.yml
```

**挂载后的验证命令**

```powershell
dsh --profile web --dump-config | Select-String 'dsh-rtt-debug'
# 期望 3 行：# == <patch 文件路径> / - id: dsh-rtt-debug / name: dsh-rtt-debug
```

> ⚠️ **这条命令我未在 `web` profile 上执行过**（那会写 `~/.dsh`，属对在用实例的改动）。
> 上面「期望 3 行」来自我在 §2.5 的**隔离 profile** 上的实测结果——隔离下情形 2/3/4 **各**得 3 命中。

### 2.5 复现「挂载矩阵」（§2.2）的完整命令

以下命令**不触碰 `~/.dsh`**：全程使用工作区内的隔离 `DSH_HOME`。
（为什么必须隔离：boot/dump-config 会写 `<profile>\cordis.yml`——`...\dsh\lib\profile-boot-Dk-7KqJc.js:209` `writeFileSync`。）

下面这段就是我在本机**逐字跑过**的版本：**前三种情形各用一个全新 profile**（`docscheck` / `docscheck2` / `docscheck3`），
所以每种情形的命中数就该是 `0 / 3 / 3`。

```powershell
$Repo = 'W:\dsh-plugins\dsh-rtt-debug'
$Iso  = "$Repo\.verify\docs-home"                       # 隔离 DSH_HOME
$env:DSH_HOME = $Iso; $env:TEMP = "$Iso\tmp"; $env:TMP = $env:TEMP
$Dsh  = 'C:\Users\RUNIC\scoop\persist\nodejs\bin\node_modules\@deepseek-ai\dsh\lib\bin.js'
$Node = (Get-Command node).Source

function New-Probe([string]$name) {
  & $Node $Dsh --profile $name --from-default-profile web --dump-config > $null 2>&1
  $prof = "$Iso\profiles\$name"
  New-Item -ItemType Directory -Force -Path "$prof\node_modules" | Out-Null
  New-Item -ItemType Junction -Path "$prof\node_modules\dsh-rtt-debug" -Target $Repo | Out-Null
  return $prof
}
function Show-Hits([string]$name, [string]$overlay) {
  $out = if ($overlay) { & $Node $Dsh --profile $name --patch $overlay --dump-config | Out-String }
         else          { & $Node $Dsh --profile $name --dump-config | Out-String }
  $hits = @(($out -split "`n") | Select-String -SimpleMatch 'dsh-rtt-debug')
  "$name : $($hits.Count) hit(s)"
  $hits | ForEach-Object { "     " + $_.Line.Trim() }
}

# ── 情形 1：只建 junction ─────────────────────────────────────────────────
$p1 = New-Probe 'docscheck'
Show-Hits 'docscheck' ''                                 # 期望：0 hit(s)

# ── 情形 2：追加进 dsh.profile.bundles ────────────────────────────────────
$mp = "$p1\package.json"; $m = Get-Content $mp -Raw | ConvertFrom-Json
$m.dsh.profile.bundles = @($m.dsh.profile.bundles) + 'dsh-rtt-debug'
$m | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM $mp
Show-Hits 'docscheck' ''                                 # 期望：3 hit(s)

# ── 情形 3：profile 的 cordis.patch.yml（新 profile）──────────────────────
$p2 = New-Probe 'docscheck2'
Copy-Item "$Repo\cordis.patch.yml" "$p2\cordis.patch.yml" -Force
Show-Hits 'docscheck2' ''                                # 期望：3 hit(s)

# ── 情形 4：--patch overlay（新 profile）─────────────────────────────────
$p3 = New-Probe 'docscheck3'
$ov = "$Iso\docs-overlay.yml"; Copy-Item "$Repo\cordis.patch.yml" $ov -Force
Show-Hits 'docscheck3' $ov                               # 期望：3 hit(s)
```

清理（junction 要用 `(Get-Item x -Force).Delete()` 删**链接本身**，**不要**递归进目标目录）：

```powershell
Get-ChildItem "$Iso\profiles" -Force | ForEach-Object {
  if ($_.LinkType) { $_.Delete() } else { Remove-Item $_.FullName -Recurse -Force }
}
Remove-Item "$Iso\docs-overlay.yml" -ErrorAction SilentlyContinue
```

**本机实测输出**：

```
docscheck  : 0 hit(s)
docscheck  : 3 hit(s)      # == dsh-rtt-debug / - id: dsh-rtt-debug / name: dsh-rtt-debug
docscheck2 : 3 hit(s)      # == W:\...\.verify\docs-home\profiles\docscheck2\cordis.patch.yml + 两行
docscheck3 : 3 hit(s)      # == W:\...\.verify\docs-home\docs-overlay.yml + 两行
```

清理：删掉 `$Iso\profiles\docscheck*` 即可（junction 要用 `(Get-Item x -Force).Delete()` 删链接本身，**不要**递归进目标目录）。

---

## 3. 构建与开发

### 3.1 命令

```powershell
npm install          # 首次；项目自带 .npmrc 把 npm cache 指向工作区内（见 §3.4）
npm run build        # = tsdown，产出 lib/index.js（Host, ESM）+ lib/client.js（Client, 惰性 CJS）
npm run typecheck    # = tsc --noEmit
npm test             # = node --test --test-isolation=none test/parsers.test.ts test/core.test.ts test/ocd.test.ts test/service.test.ts
npm run watch        # = tsdown --watch
```

### 3.2 产物契约（不能改错，否则插件静默不工作）

| 产物 | 形态 | 契约来源 |
|---|---|---|
| `lib/index.js` | Host 半，Node ESM | `package.json` `main` / `exports['.']` |
| `lib/client.js` | Client 半，**惰性 CJS**：文件是 `window.__ModuleLoader__.load({ id: "dsh-rtt-debug", factory: (require) => {…} })`，**执行只注册工厂**，模块体在 materialization 时才跑 | `dsh-client-modules` 的 `manifest.d.ts` 契约；`tsdown.config.ts` 的 `banner`/`footer` 实现 |
| React | **保持 external**，由宿主的平台模块表（React / Cordis / 静态 UI 库）提供 | `tsdown.config.ts` 的 `deps.neverBundle: ['react', …]` |

> 历史教训（已修复，见 `progress.md` B5/B6）：Client 半若构建成 IIFE，会被 tree-shake 成 **40 字节空产物**；
> 产物文件名若与 `package.json` 声明不符，插件会**激活失败或完全不执行**。

### 3.3 实测结果与产物哈希（**以本表为准**）

```
npm run typecheck   → exit 0（0 error）
npm run build       → exit 0；lib/index.js 112541 B、lib/client.js 93839 B
npm test            → exit 0；tests 115 / pass 115 / fail 0
                      （parsers 39 / core 27 / ocd 35 / service 14）
```

| 文件 | 字节 | SHA256 |
|---|---|---|
| `lib/client.js` | 93839 | `AE19CA65078787AFCE51C8C4925B87617D7755C449D548DF19171E885AFFDEF3` |
| `lib/index.js` | 112541 | `69D417871868A4244143B1E57EB8BDF89E889221B16E5E86C1470AFF6007A18A` |
| `src/client/index.tsx` | 11711 | `F2FD8AEC0244801824599B5C6DE0206C6896A7FF886AC8A8F2A94D2CD4A65D99` |
| `src/client/panel.tsx` | 56331 | `FE5E233EE8ED7D13A8FA4CD4…` |
| `src/ocd/binding-parse.ts` | 7349 | `46BEFB0E69E369C7F26D18C8…` |
| `package.json` | 1486 | `29668EA40D37F9ABF7B063669B1A7B0276F0F2C1B1726054B609F909339E7D8B` |

> **可复现性**：我**重建过一次**，两个产物 SHA256 与上表**逐字节一致**（仅 mtime 前移），
> 且 `lib/client.js.map` / `lib/index.js.map` 内嵌的 `sourcesContent` 与磁盘源码**逐一 `IDENTICAL=true`**
> （client 7 个源、host 19 个源全部比对）——即**被验证的产物就是当前源码树的产物**（新鲜度用内容而非时间戳证明）。

> ⚠️ **历史哈希（勿再引用）**：更早的修订曾产出 `lib/client.js` 63403 B / `0CFC46AD…` 与
> `lib/index.js` 102486 B / `77418705…`（见 `coordination/verify.md` §12.1 t10 记录、§14 t18 记录 93838 B / `F37AEB75…`）。
> 那些哈希属于**已过时的修订**，只应出现在各自轮次的历史报告里；**本 README 的现状描述以本节表格为准**。

`lib/` 下另有 `client.iife.js`(40 B)、`client.iife.js.map`、`index.mjs`、`index.mjs.map` 等**陈旧遗留产物**
（mtime 17:49:27，远早于最终构建），来自 `progress.md` B5 记录的 IIFE 试错。
它们**不参与**加载（加载只看 `lib/index.js` / `lib/client.js`），但 `client.iife.js` 会让你误以为构建出错——直接忽略即可。

### 3.4 为什么有 `.npmrc` / `.npmrc.pnpm`

本机 npm 默认 cache 落在**工作区外**（`C:\Users\RUNIC\scoop\persist\nodejs\cache`），沙箱下报
`EPERM ... _cacache\tmp\***`——尽管 registry 完全可达（`npm ping` → `PONG 899ms`）。
项目用 `.npmrc` 把 `cache` 与 `.npmrc.pnpm` 里的 `store-dir` 指到工作区内绕开它，**不改任何全局配置**。

---

## 4. 配置

**所有可配置项都是默认值，不是常量**（规格 §0 G1/G2）。配置存在**插件自己的 settings 文档**里，**不写 `~/.dsh` 的组成文件**。
Host 侧路由 `POST /api/rtt-debug/config` 读写配置；配置校验在边界处完成（`src/config.ts:239-321` `validateConfig`）。

### 4.1 默认值一览（`src/config.ts:169-207` `createDefaultProfile()`）

| 配置 | 默认值 | 说明 / 校验 |
|---|---|---|
| RTT 日志通道号 | `0` | `src/config.ts:152`；与变量通道**必须不同**（`:284-287`） |
| RTT 变量通道号 | `1` | `src/config.ts:154`；SEGGER 惯例 channel 0 是终端 |
| RTT 日志端口 | `9090` | `src/config.ts:156`；与变量端口**必须不同**（`:280-283`） |
| RTT 变量端口 | `9091` | `src/config.ts:158` |
| OpenOCD TCL 端口 | `6666` | `src/config.ts:160` |
| RTT 控制块搜索地址 / 区大小 / 标识串 | `0x20000000` / `0x1000` / `SEGGER RTT` | `src/config.ts:183`；**通用默认，请按目标改** |
| 变量解析器 | `csv` | `src/config.ts:195`；可选 `csv` / `keyvalue` / `binary-frame` / `custom-regex`（`src/parsers/registry.ts:55-58`） |
| 采样抽取率 | `10` Hz | `src/config.ts:191`；`0` = 不去抽 |
| 数据保留窗口 | `10` 分钟 | `src/config.ts:192` |
| 每序列点数上限 | `100000` | `src/config.ts:193` |
| 日志行数上限 | `5000` | `src/config.ts:186`（`src/core/store.ts:247-250` 丢最旧） |
| OpenOCD cfg 路径 | **空字符串**（首次使用时指定） | 默认值 `src/config.ts:175`；「故意留空」的理由见 `src/config.ts:38-40`；**不自带、不硬编码**（决策 D13/D16） |
| OpenOCD 可执行文件 | `openocd`（走 PATH） | `src/config.ts:176`（接口 `:44`） |
| OpenOCD 进程模式 | `auto`（先探测，未监听则 spawn；已监听则 attach） | 默认值 `src/config.ts:174`（类型 `:26`）、`src/openocd/manager.ts:95-123` |
| OpenOCD 启动超时 | `6000` ms | `src/config.ts:180` |
| 自动重启 | `true` | `src/config.ts:181` |
| OCD 变量读取 | **关闭**（`enabled: false`） | `src/config.ts:198`；启用需配 ELF 或手填地址。**开机默认没有任何变量**（`ocd.variables: []`），必须由用户配置——见 **§4.2** | |
| ELF / `nm` | 空 / `arm-none-eabi-nm` | `src/config.ts:199-200`。**`elfPath` 与 `openocd.configPath` 的路径口径不同**：`elfPath` **不做工作区根解析**，逐字透传给 `nm`（`src/index.ts:609-613`），相对路径按**宿主进程 CWD** 解析 —— 见 **§4.3.2** |
| OCD 轮询周期 | `100` ms | `src/config.ts:201`；必须为正（`:292-294`） |
| 撕裂读防护 | `true`（连读两次，不一致则丢弃该样本） | `src/config.ts:202`、`src/ocd/reader.ts:262-274` |
| 批量读合并距离 | `64` 字节 | `src/config.ts:203`（`planReadBatches` `src/ocd/reader.ts:74`） |
| 界面语言 | 跟随宿主 locale | `src/client/locales.ts:106-118`（决策 D15） |

### 4.2 ⭐ 变量从哪来：两条来源，以及 OCD 直读**如何取变量列表**

这是最容易踩坑的一节。插件有**两条互不相干的变量来源**（对应 §1 的数据源 2 与数据源 3）：

| | **A 区 —— RTT 数据通道** | **B 区 —— OCD 直读** |
|---|---|---|
| 配置字段 | `variables.*` | `ocd.*` |
| 变量列表怎么来 | **解析器自动发现**：目标固件往 RTT channel 1 写数据，解析器（`csv`/`keyvalue`/`binary-frame`/`custom-regex`）边收边产出变量名（`src/parsers/*.ts` 的 `descriptors()`） | **没有自动发现**。必须由用户**显式配置**：从 ELF 符号表**浏览勾选**，或**手填地址** |
| 需要固件配合 | 是（固件要往通道写） | **否**（零固件改动） |
| 默认状态 | `enabled: true`，但目标不写就没数据 | **`enabled: false` + `variables: []`** → 什么都不读 |
| 谁决定变量名 | 数据自己带（表头 / 键名 / 帧布局 / 捕获组） | 符号名或手填名 |

> ⚠️ **B 区没有自动发现机制，这是设计而非缺陷**：OCD 直读靠 `mdw`/`mdh`/`mdb` 按**地址**读内存，
> 插件无法从"内存"本身猜出用户关心哪些变量。所以必须有人告诉它「读哪个地址、按什么类型解码」——
> 这个"告诉"的动作就是**变量源面板**（t12 补齐；在此之前 `POST /symbols`、`/ocd-vars` 与 transport 封装
> 早已存在，但 **client 目录零调用、面板无配置 UI**，等于没有入口）。

#### 4.2.1 「变量源」面板操作步骤

**打开方式**：波形工具条上的 **[变量源]** 按钮（文案键 `sources.open` = `变量源`，`src/client/panel.tsx:895`）。
面板分**两个区块**，与实际 UI 标题一致：

```
┌─ 变量源 ─────────────────────────────────────────────────────────────┐
│ RTT 数据通道（只读）                                    ← A 区，sources.rttSection
│   解析器: csv                                          ← sources.parser
│   <发现到的变量名列表；没数据时提示「尚未发现变量…」>      ← sources.rttNone
├──────────────────────────────────────────────────────────────────────┤
│ OCD 直读（可编辑）                                      ← B 区，sources.ocdSection
│   ☑ 启用变量直读        ← sources.enabled（= ocd.enabled 开关）        │
│   ELF 路径 [__________] ← sources.elfPath                            │
│   nm 路径  [__________] ← sources.nmPath（留空 → arm-none-eabi-nm）    │
│   轮询间隔 [100] ms     ← sources.interval + sources.intervalUnit     │
│   筛选 [______] [浏览符号] ← sources.filter + sources.browse          │
│   ┌ 符号候选池（勾选）┐  名称 / 地址 / 大小 / 推断类型                 │
│   └──────────────────┘                                              │
│   手填地址 [__________________] 单位 [____] [添加]                     │
│   已配置变量（N）       名称 | 地址 | 类型 | 单位 | 移除                │
│   [保存到当前 Profile]  [重新读取配置]                                 │
└──────────────────────────────────────────────────────────────────────┘
```

**步骤**

| # | 动作 | 说明 |
|---|---|---|
| 1 | 点工具条 **[变量源]** | 打开/关闭面板 |
| 2 | 填 **ELF 路径** | 必填才能浏览。`/symbols` 对空 `elfPath` 直接返回 **400**（`src/index.ts:603-605`） |
| 3 | （可选）填 **nm 路径** | 留空 → 默认 `arm-none-eabi-nm`（`src/index.ts:606-608`） |
| 4 | （可选）填 **筛选** 关键字 | 传给 `nm` 做名称子串过滤（`src/ocd/symbols.ts:145`） |
| 5 | 点 **[浏览符号]** | 后端跑 `nm -S --defined-only <elf>` 并把候选列出来（`src/ocd/symbols.ts:109-152`） |
| 6 | **勾选**要画的符号 | 勾选只是"进候选"，**保存后才写回配置**，未勾选的不采样 |
| 7 | 或：在 **手填地址** 里写一行，点 **[添加]** | 语法见 §4.2.3；**类型无法识别会被拒绝并在 UI 上显示原因**，不会静默改成 u32 |
| 8 | 点 **[保存到当前 Profile]** | 写入当前活动 profile 并**立即持久化**（见 §4.5） |
| 9 | **重开面板确认**（可选但推荐） | 点 **[重新读取配置]** 或关闭再打开，核对「已配置变量（N）」与表格行的**类型列**是否符合预期 |
| 10 | 勾选 **启用变量直读**（若尚未启用） | 这是 `ocd.enabled`；生效时机见 §4.4 |

| 程序路径总被重置 | 它是**本机字段**（§3.5），不随工作区文件走；改动会写进全局层 |
| 符号列表里找不到某个变量 | 它是 `static`（文件内私有），默认不列（§7.4） |
| 解析器改了没生效 | 是否点了保存；`script` 的表达式是否通过校验（界面会显示语法错误） |
**符号列表的三点限定（都不是缺陷，但会影响你的预期）**

1. **它是候选池，不是采样清单**：勾选只改变本地候选状态，**只有点 [保存]** 才写回配置；未保存的勾选不产生任何采样。
2. **只列数据段符号**：`nm` 的输出按类型字母过滤，只保留 `[bBdDgGsSrR]`（`.bss`/`.data`/`.rodata` 等），
   代码段符号（`T`/`t`）不会出现在列表里（`src/ocd/symbols.ts:144`）。
3. **有 5000 条上限**：`options.limit ?? 5000`（`src/ocd/symbols.ts:127`），巨型 ELF 会被截断 —— 用「筛选」缩小范围。
   另：无 ELF 时 `/ocd-vars` 会**回退到手填解析**（`src/index.ts:653-664`），所以手填路线不依赖 `nm`。

> **`.map` 文件不支持**（重要更正）：`spec.md` 的 A9b 判据里写了「或解析 `.map`」，
> 但**实现中检索零命中** —— 符号解析**只走 `nm`**（`src/ocd/symbols.ts:109-152`）。
> **本文档不声称支持 `.map`**；用 `.map` 文件当作 `elfPath` 会失败。

#### 4.2.2 类型是怎么推断出来的（口径：**猜 + 名字修正 + 大小取整**）

链接完成后 **C 类型信息已经丢失**，`nm` 只告诉你「哪个段、多大」，所以只能推断。实际链路是**三步**：

```
nm 的段字母  ──① 段猜测──▶  fallback      ──② 名字修正──▶  inferredType  ──③ 大小取整──▶  最终 type
inferFromNmType()            refineTypeFromName()                  typeForSize()
```

- **① 段字母猜测**（`src/ocd/symbols.ts:55-64`）：无论 `B/D/C/G/S` 还是 `R/T/W/V`，**都返回 `u32`**（只是默认宽度）。
- **② 名字修正**（`src/ocd/symbols.ts:77-92`）：名字后缀优先，例如 `volt_u16` → `u16`、`gain_f32` → `f32`、
  `isReady` / `*Flag` → `bool`、`fVoltage` → `f32`。
- **③ 大小取整**（`src/ocd/symbols.ts:158-164`，判定点在 `src/index.ts:649`）：
  **`size > 0` 时 `typeForSize` 的结果才是最终 type**，它**会覆盖第 ② 步的名字推断**。

**⭐ 因此实际优先级是「符号大小 > 名字后缀 > 段字母」——不是反过来。** 我实测了这条链路：

| 符号名 | 段字母 | `nm` 报的大小 | 名字修正得到 | **最终 type** | 说明 |
|---|---|---|---|---|---|
| `volt_u16` | `D` | 2 | `u16` | `u16` | 一致 |
| `gain_f32` | `D` | 4 | `f32` | `f32` | 一致 |
| `counter_i32` | `D` | 4 | `i32` | `i32` | 一致 |
| `offset_f64` | `D` | 8 | `f64` | `f64` | 一致 |
| **`tempC_i16`** | `D` | **2** | `i16` | **`u16`** | ⚠️ **大小覆盖了名字的符号性** |
| **`isReady`** | `D` | **1** | `bool` | **`u8`** | ⚠️ 大小覆盖 bool |
| **`fVoltage`** | `D` | **1** | `f32` | **`u8`** | ⚠️ 大小覆盖 f32 |
| `isReady` | `D` | 0 | `bool` | **`bool`** | 大小未知（`nm` 无 size 列）→ 名字生效 |
| `plainGlobal` | `D` | 2 | `u32` | **`u16`** | 纯靠大小 |

**实践建议**：推断只是**起点**。在「已配置变量」表格里核对**类型列**，与固件实际的 C 类型不符时**改用手填行**
（手填的 `type` 会**原样透传、不再被大小覆盖** —— 见 `src/index.ts:657-662`，只有 `symbol` 路线才走 `typeForSize`）。

#### 4.2.3 手填地址语法（两种写法 + 单位）

解析器是 **`src/ocd/binding-parse.ts:107-151`**（`parseManualBindingDetailed`）。该模块是
**宿主与浏览器两半共享的单一实现**（`src/ocd/symbols.ts:24` 转出，client 直接 import），
所以面板里的预览与实际存储**不会漂移**。

| 写法 | 形式 | 示例 | 类型可省略？ |
|---|---|---|---|
| **Form A** | `name@address:type` | `VoltMv@0x20000000:u16` | ✅ 省略 → **默认 `u32`**（`src/ocd/binding-parse.ts:127`） |
| **Form B** | `address:type:name` | `0x20000000:u16:VoltMv` | ✅ 省略 → **默认 `u32`**（`:148`） |

- **地址**接受 `0x20000000` / `0x2000_0000`（下划线分隔）/ `536870912` 十进制（`src/ocd/binding-parse.ts:48-53`）。
- **单位（`unit`）**是**面板上的独立输入框**（`sources.unit`，占位符 `如 mV`），**不写进地址字符串**；
  留空则不带单位（`src/client/panel.tsx:760-766`）。单位只用于显示。
- **首尾的反引号/单双引号会被剥掉**（`src/ocd/binding-parse.ts:108`），从别处粘贴时不必手删。

**类型拼写（口径已定稿）**

| 类别 | 内容 |
|---|---|
| 9 个规范拼写 | `i8` `u8` `i16` `u16` `i32` `u32` `f32` `f64` `bool` |
| 18 个别名 | `int8` `uint8` `char` `byte` `int16` `uint16` `short` `ushort` `int32` `uint32` `int` `unsigned` `long` `ulong` `float` `double` `boolean` `flag` |
| **`_t` 后缀（宽松）** | `normalizeType` 先剥掉尾缀 `_t` 再查表（`src/ocd/binding-parse.ts:65`）→ **上面 27 个拼写全部也接受 `_t` 形式**（`u16_t`、`uint16_t`、`int32_t`、`float_t`…），**两个形式（A/B）都接受**。我实测：**27/27 全通过，Form A 与 Form B 各 27 接受、0 拒绝** |
| **无法识别的拼写** | **拒绝**（`unknown-type`）并**回显你的原文**（`spelling` 字段），**不会静默改成 u32**（`src/ocd/binding-parse.ts:129`、`:143`） |
| **类型省略** | 仍然是 **`u32`** —— 这是既有约定、被 `test/ocd.test.ts` 固定住，与"拼错"是两回事（`src/ocd/binding-parse.ts:84-87` 专门解释了区别） |

> **修复范围是 18 个别名 + 9 个规范拼写 = 27 个,不是 `uint16_t` 一个。**
> 更早的版本里 client 侧有一份**复制的**解析器（只认 9 个规范拼写），造成两半漂移，
> 已由 t16 消除：现在只有 `binding-parse.ts` 一份实现（`src/ocd/binding-parse.ts:1-25` 记录了复制为何出问题）。

**已知的结构性限制（不是待修项）**

`std::uint16_t` 这类**限定名无法表示**：`:` 在本语法里是**字段分隔符**，所以限定名在两种写法里都解析不了。
`std::uint16_t` 这类**限定名无法表示**：`:` 在本语法里是**字段分隔符**，所以限定名在两种写法里都解析不了。
这是语法本身决定的、**两个形式对称**的限制，实测 Form A 与 Form B **均**以 `unparsable` 拒绝。
**不要把它当作待修缺陷**；需要时用 `uint16_t`。

### 4.3 手工配一个 profile 的最小例子

```powershell
# 读当前配置（POST，body 为空对象）
Invoke-RestMethod 'http://127.0.0.1:<port>/api/rtt-debug/config' -Method Post -ContentType 'application/json' -Body '{}'
# 切换活动 profile
Invoke-RestMethod 'http://127.0.0.1:<port>/api/rtt-debug/config' -Method Post -ContentType 'application/json' `
  -Body '{"profileId":"default"}'
# 新增一套 profile（只有名字，其余取默认）
Invoke-RestMethod 'http://127.0.0.1:<port>/api/rtt-debug/profiles/add' -Method Post -ContentType 'application/json' `
  -Body '{"name":"my board"}'
```

> 若请求来自**带 `sessionId` 的面板**，Host 会用该会话的 `cwd` 作为工作区根来解析**相对** cfg 路径
> （`src/index.ts:206-210`）；不带 `sessionId` 时回落 `process.cwd()`。这是 F3 缺陷的修复点（见 §5.2）。
> **注意**：这条只适用于 `openocd.configPath` —— `elfPath` **不走**工作区根解析，见 §4.2 与 §4.2.2。

### 4.4 OCD 直读的生效时机（`ocd.enabled` 从 false → true）

**按实际实现**（`src/service.ts:139-156` `reconcileOcdReader()`，由 `setConfig` 在 `:120` 调用）：


### 4.4 OCD 直读的生效时机（`ocd.enabled` 从 false → true）

**按实际实现**（`src/service.ts:139-156` `reconcileOcdReader()`，由 `setConfig` 在 `:120` 调用）：

| 数据源当前状态 | 你在「变量源」里保存后 | 依据 |
|---|---|---|
| **已在运行**（已按过 [启动]） | **立即重建 OCD 采样**：`enabled` 打开 → 立刻启动 reader；关闭 → **立刻停止直读**；已存在 reader → 只重绑变量 | `:140` `if (!this.running) return`、`:142-147` 停止分支、`:148` 已有则返回、`:152` 无则 `startOcd()` |
| **未运行**（还没按过 [启动]） | **保存不产生采样**；变量在**下次 [启动]** 时生效 | `:140` 提前返回；启动路径 `:221` `if (this.profile.ocd.enabled) await this.startOcd()` |

这与 UI 内置提示一致（文案键 `sources.needRestartHint` / `sources.keepRunningNote`，`src/client/locales.ts:102-103`）：
> 「数据源已在运行时，保存会即时按新变量重建 OCD 采样（关闭开关则立即停止直读）；数据源未运行时，保存的变量将在下次 [启动] 时生效。」

> **注意**：`requirement` 里若写成「改 `enabled` 一律需要重启数据源」是**不准确**的 —— 运行时改是**即时**的。
> OCD 连接失败不会让 `setConfig` 抛错（它会吞掉异常并通过状态上报，`src/service.ts:149-155`），所以**保存不会失败**，只在状态栏显示错误。

### 4.5 配置持久化：时机、边界与一次真实故障

**持久化机制（实际实现）**

| 环节 | 行为 | 依据 |
|---|---|---|
| namespace 注册 | `settings.register('dsh-rtt-debug', <schema 函数>)` | `src/index.ts`（t21 修复） |
| 读取 | `settings.get('dsh-rtt-debug')` | 同上 |
| 写入 | `settings.update('dsh-rtt-debug', config)` | 同上 |
| **写入时机** | **所有改配置的路由都在请求内立即持久化** —— `POST /config` 与 `POST /profiles/add` 都会在响应前落盘 | `src/index.ts:553-570`、`:588-597` |
| teardown 兜底 | 卸载时再刷一次 | `src/index.ts` 的 disposer |
| **就绪门** | handler 顶部 `await persistenceReady`（**1000 ms 上界**），遮住「路由已注册、存储配置还没应用」的启动窗口 | `src/index.ts:152-181`、`:194` |

**为什么需要就绪门（实测竞态，不是理论）**：路由在 `ctx.effect` 里**同步**注册，而「把已存配置应用到 service」
发生在**更晚**的 `ctx.inject(['settings'], …)` 回调里。请求恰好落在这个窗口时，service 还持**默认值**
（`intervalMs=100`、空 `elfPath`）——看上去就像"保存没生效"。窗口被有界门遮住；无 settings 服务的宿主最多等一次
（实测 921 ms，后续请求 0 ms），**不会每请求都付这个代价**。

**⭐ 修复前的版本无法保存配置（如实记录）**

t14 发现并立案、t21 修复、t22 复核通过的 **blocker**：修复前插件对真实 settings 服务**完全不工作**。四个根因：

| # | 根因 | 表现 |
|---|---|---|
| ① | 写入形状错：传了**单个对象** `{[ns]: config}`，而真实签名是 `update(ns, patch)` | 抛 `settings namespace "[object Object]" must match /^[a-z][a-z0-9-]*$/` |
| ② | namespace **从未 `register`** | 未注册时写入直接抛 `settings namespace "X" is not registered` |
| ③ | `ctx.get('settings')` 在 **apply 期返回 undefined** | **整段持久化被静默跳过**（这也是启动日志一直「干净」的原因） |
| ④ | 读取形状错：`get().value`，真实为 `get(ns)` | 一旦执行必抛 `TypeError` |

验证：`coordination/t14-api-probe.ps1` **修复前 2 failed → 修复后 0 failed**（含跨重启读回）。
修复前的两个失败项：**`config-write`**（`persistError` 恰为 `settings namespace "[object Object]" must match /^[a-z][a-z0-9-]*$/`）与 **`config-persisted-across-restart`**（重启后 `variables=0`/空 `elfPath`/`intervalMs=100`）——由 **产物级对照**证实：`.verify/evidence/t28-pre-fix/api-probe.json`（`verdict=FAIL, failures=2`）vs `.verify/evidence/t28-post-fix/api-probe.json`（`verdict=PASS, failures=0`）。
出处：`coordination/verify.md` §13.5（发现书）与 `.verify/evidence/t14-final/FINDING-settings-persistence.md`。

> ⚠️ **对用户的实际影响 —— 请务必注意**：
> **修复前的版本无法保存配置。** 如果你在修复前配置过 OCD 变量（或改过其它配置），
> **那些设置很可能已经丢失**（写入根本没落盘），**请重新配置一遍**。

**另一个必须知道的既有静默行为**：**未解析的符号会被跳过**

`src/service.ts:319` 对「没有 `address`」的条目直接 `continue`：

```ts
if (entry.address === undefined) continue  // unresolved symbol
```

**修复前建立的手填行需要重加（t17-F2）**

t16 修复前，**Form A**（`name@address:type`）会把无法识别的别名**静默降级为 `u32`** 并**存进配置** ——
即存的 `type:'u32'` 已经**销毁了原始拼写证据**，无法自动迁移回 `f32`/`i16` 等。
→ **排障要点**：**本次修复前建立的手填行，请先删掉再重加。**（Symbol 路线不受影响：它每次保存都重新解析 ELF。）

---

## 5. 面板双入口

同一个面板组件 `RttDebugPanel`（`src/client/panel.tsx:34`）注册到**两个宿主面**（决策 D3）：

| 入口 | 宿主 API | 代码锚点 | 缺失时的行为 |
|---|---|---|---|
| **A —— DSH 原生右侧栏 tab** | `ctx.sidebarRightTabs.register(...)`（类型）+ keyed 槽 `sidebar.right.pane.tab`（主体） | `src/client/index.tsx:114-158` | 若 `sidebarRightTabs` 服务不出现，A 入口不注册，**插件仍正常激活** |
| **B —— dsh-better-sidebar 工作台面板** | `ctx.betterSidebar.registerTab({...})` | `src/client/index.tsx:176-195` | **降级**：`betterSidebar` 缺失时 apply 照常执行、插件 fiber 仍 ACTIVE，只是 B 入口不注册 |

### 5.1 为什么两个入口都必须「软等待」

Cordis 的 `ctx.<service>` **只在插件的 `inject` 列表里声明过才合法**；对未声明的服务裸读会抛
`cannot get property "<name>" without inject`。而 `betterSidebar` 由 **兄弟插件 fiber**（`dsh-better-sidebar` 自己）提供，
**不是祖先 fiber**——所以**裸读在装或不装 better-sidebar 两种环境下都必抛**
（实测：`coordination/acceptance.md` §1.3 的三行拓扑对照表）。

正确写法（本插件采用）：`ctx.inject?.(['betterSidebar'], injected => injected.get('betterSidebar'))` + 判空。
**硬 `inject: ['betterSidebar']` 是错误修法**：服务缺失时 `apply` **根本不执行**、fiber 停在 `PENDING`
（实测：`coordination/verify.md` §4.5，`applyRan:false`、`fiberState:2`→`PENDING`），直接违反 D3「缺失即降级」。

### 5.2 sessionId 是从哪来的（F3 缺陷的修复口径）

- **入口 A**：`sidebar.right.pane.tab` 这个座位由宿主以 `renderSlot(seat, {}, …)` 分发，**owner props 恒为 `{}`**，
  所以**没有 `props.tab` 可读**（修复前正是读了它 → 恒 `undefined` → 面板拿不到 session → Host 回落 `process.cwd()`）。
  现在改从**槽的 inject face** 取：`inject: (sessionId) => ({ sessionId })`（`src/client/index.tsx:147`）。
- **准确表述（不要把这句话说错）**：`sessionId` **确实同时是框架 standard prop**——ui-session 声明了 `props: ['sessionId']`，
  渲染器 `renderEntry` 把 `{ …kit, …injected, …slotInjected.props, …ownerProps }` 一起展开，因此**有两条等价通道**。
  本插件选择**显式声明的 inject face**，因为那是上游文档化的正道。
- **入口 B**：better-sidebar 给每个 tab component 传 `{ ctx, store, scope, tab, visible, expanded }`，其中 `scope = { sessionId, cwd }`。
  修复前 `component: () => panel()` 直接丢弃它 → 工作台面同样回落 `process.cwd()`；现为 `panel(props?.scope?.sessionId)`（`src/client/index.tsx:193`）。
- **URL 级证据（reviewer 独立复核）**：修复后入口 A 与入口 B **各 3/3** 发出 session-scoped 请求
  （`/api/rtt-debug/snapshot?sessionId=…`、`/api/rtt-debug/ws/log?sessionId=…`、`/api/rtt-debug/ws/series?sessionId=…`）；
  按修复前形态重建则 **0/3**（`coordination/verify.md` §12 引用的 t9 结论）。

---

## 6. 故障排查

### 6.1 症状：`cannot get property "betterSidebar" without inject`（本轮已修的真实故障）

**故障特征**（修复前基线，可复现）：

```
failed to apply loader entry <id> (dsh-rtt-debug): cannot get property "betterSidebar" without inject
```

- 报错发生在 **client 半**（浏览器页面内），**不会**写进 Node 侧启动日志
  ——所以「服务端日志干净」**不能**证明 client 半没抛错（`coordination/acceptance.md` §5.1 第 4 条）。
- 整个 `apply` 被终止，**两个入口都不注册**，面板根本不出现。
- **装或不装 `dsh-better-sidebar` 都会抛**（因为它是兄弟 fiber 提供的服务）。

**排查命令（必须带注释过滤，否则会误判）**：

```powershell
Select-String -Path src\client\index.tsx -Pattern '\.betterSidebar' |
  Where-Object { $_.Line.TrimStart() -notmatch '^\*|^//' }        # 期望：无输出
Select-String -Path lib\client.js        -Pattern '\.betterSidebar' |
  Where-Object { $_.Line.TrimStart() -notmatch '^\*|^//' }        # 期望：无输出
```

> ⚠️ **不带 `Where-Object` 会同时出现假阳性与假阴性**（两者都已实测）：
> - 假阳性：修复代码自己的**解释性注释**里含字面量 `ctx.betterSidebar`。
>   本机实测裸扫 `src\client\index.tsx` 得 **2** 行，**两行都是注释**
>   （`:10` 是 JSDoc 行、`:164` 是 `//` 行）；裸扫 `lib\client.js` 得 **1** 行，也是注释。
> - 假阴性：修复前的问题行写成 `(ctx as unknown as { betterSidebar?: … }).betterSidebar`，**不含**字面量 `ctx.betterSidebar`。
> 契约 `coordination/acceptance.md` §2 的 C1/C3 因此强制要求该过滤。

**根因与修法**：裸读 `ctx.betterSidebar` → 改为 `ctx.inject?.(['betterSidebar'], injected => injected.get('betterSidebar'))` + 判空。

**只用真实 Cordis 才能复现/验证（推荐的一键判定）**：

```powershell
# 直接跑「服务端实际下发的那份字节」，进真实 cordis 4.0.2
node coordination/artifact-judge.mjs lib/client.js "my-check"
# 期望：
#   {"scenario":"no-workbench","throw":"none","calls":{"nativeTab":1,"nativeSlot":1,"workbench":0}}
#   {"scenario":"with-workbench","throw":"none","calls":{"nativeTab":1,"nativeSlot":1,"workbench":1}}
#   {... "verdict":"PASS","bodyRenderOk":true}      exit=0
# 上线版可用 --url 直接判服务端下发的那份：
node coordination/artifact-judge.mjs --url "http://127.0.0.1:<port>/plugins/??dsh-rtt-debug/client.js&rev=<rev>" "served"
```

### 6.2 症状：tab 重复 / 槽重复 key（effect owner 归属错误，t7 已修）

**特征**（实测原文）：

```
slot duplicate-key errors: 3 -> keyed slot "sidebar.right.pane.tab" already has an entry for key "dsh-rtt-debug"
```

在「服务消失 → 重现」的 flap 下，若把注册的 disposer 挂在**外层 `ctx`** 上，重复注册不会被释放，重现时就撞 key。
**修法**：disposer 改挂 `injected.effect(...)`（等待中的子 fiber），服务消失时先释放、重现时再注册
（`src/client/index.tsx:154-157`）。

> **诚实边界**：另一条症状 `tab type id "dsh-rtt-debug" is already registered` 需要**特定拓扑**才可达
> ——真实 `TabRegistry` 把 effect 挂在提供者自己的 ctx 上，且实例在 apply 内新建，常见拓扑下会自愈；
在「服务消失 → 重现」的 flap 下，若把注册的 disposer 挂在**外层 `ctx`** 上，重复注册不会被释放，重现时就撞 key。
**修法**：disposer 改挂 `injected.effect(...)`（等待中的子 fiber），服务消失时先释放、重现时再注册
（`src/client/index.tsx:154-157`）。

> **诚实边界**：另一条症状 `tab type id "dsh-rtt-debug" is already registered` 需要**特定拓扑**才可达
> ——真实 `TabRegistry` 把 effect 挂在提供者自己的 ctx 上，且实例在 apply 内新建，常见拓扑下会自愈；
> 我（以及 t7）都用脚本复现过它，但**真机/完整浏览器下的观察本机无法完成**（无头 Edge 不可用）→ 记为**待现场确认**。

### 6.3 症状：面板能打开，但 cfg 相对路径解析到了插件目录

**原因**：面板没把 `sessionId` 传给 Host，Host 回落到 `process.cwd()`（F3 缺陷，t8 已修）。
Host 侧口径：带 `sessionId` 时用该会话的 `cwd` 作为工作区根（`src/index.ts:206-210`）。
**验证**：看请求 URL 是否带 `?sessionId=`（见 §5.2 的 3/3 证据）。

### 6.4 症状：页面上出现 `Failed to load plugins` 卡片

这是 **浏览器侧**启动卡片的标题（`dsh-web-frontend` 的 bundle 文案），**不是** Node 服务端日志文案。
排查顺序：
1. 先确认产物存在：`Get-ChildItem lib\index.js,lib\client.js`（缺 `lib/client.js` 会**显式失败并给出构建指令**）；
2. 确认挂载（§2.3）——**没挂载时根本不会有这张卡片**，卡片出现说明节点在树里但加载失败；
3. 看启动日志与 stderr：`cannot get property` / `Failed to load plugins` 是否命中；
4. 用 §6.1 的 `artifact-judge.mjs` 直接判 client 半字节。

### 6.5 症状：端口冲突 / 找不到 cfg / OpenOCD 起不来

| 现象 | 处理 |
|---|---|
| `no OpenOCD config file configured — set one for this device profile` | 在配置里填 `openocd.configPath`（相对路径按会话工作区解析，`src/openocd/manager.ts:83-87`） |
| `OpenOCD config file not found: <绝对路径>` | 检查相对路径基准（会话 `cwd`）或改用绝对路径 |
| 状态 `attached` 而非 `running` | **正常**：9090 或 TCL 端口已被别的 OpenOCD 占用时，插件选择 attach 而不重复 spawn，避免调试器争用（`src/openocd/manager.ts:104-114`） |
| `OpenOCD did not open its RTT ports within 6000 ms` | 状态里带 OpenOCD 自身 stderr 尾部（最多 200 行，`src/openocd/manager.ts:42`）；常见原因是目标未上电或 cfg 里的 adapter 配置不对 |
| 日志里出现 `rtt server start <port> <channel>` 失败 | 用 `openocd -c "help rtt"` 确认你的 OpenOCD 版本支持按通道起服务（0.12.0 实测支持） |
| 日志里出现 `rtt setup` / `rtt start` 报错 | 本机实测：这两条命令**需要目标已 `init`** —— 无目标时会退化成打印 `rtt` 用法并 **exit 1**。**先接目标再判**（`docs/target-integration.md` §5） |
| 状态显示 `reconnecting`，带 `attempt N, retrying in M ms` | 属设计行为（指数退避，`src/core/tcp-link.ts` 的重连参数）。板子掉电 / 调试器被拔时会进入该状态，恢复后自动回到 `open`（`src/service.ts:447-456`） |

### 6.6 症状：波形没数据

按数据源逐条排查（三源可独立启停，`src/service.ts:178-221`）：

1. **RTT 变量通道**：目标固件是否**真的初始化了 channel 1**？SEGGER RTT 的 `aUp[1]` 未初始化时
   `pBuffer=NULL`、`SizeOfBuffer=0`，`SEGGER_RTT_Write` 会**静默丢弃**（不报错）——这是最常见的「没数据但不报错」。
   接入方法与缓冲核算见 [`docs/target-integration.md`](docs/target-integration.md) §3。
2. **解析器选错**：默认 `csv`；若固件发的是 `key=value`，改成 `keyvalue`，否则一个样本都产不出。
   坏帧不会中断流（`src/service.ts:299-301` 吞掉解析异常继续跑），所以「没数据」和「数据畸形」在 UI 上长得一样。
3. **OCD 读取**：默认 `enabled: false` 且 `variables: []` → **必须先配置变量**（见 §4.2）。
   排查顺序：① 勾选 **启用变量直读**；② 核对「已配置变量（N）」列表里变量在不在；
   ③ 若走 symbol 路线，检查 ELF 路径能否被 `nm` 读取（相对路径按**宿主 CWD**解析，见 §4.2.2）；
   ④ 若符号**未解析**，它会被 `src/service.ts:319` 静默 `continue` 跳过 —— **不会报错，只是不出现在波形里**（见 §4.5）。
4. **OCD 变量类型不对**（值离谱、负数变正、小数变整数）：类型推断的**大小优先于名字**（§4.2.2），
   用**手填行**固定类型（手填的 `type` 不被 `typeForSize` 覆盖）。
5. **修复前配过 OCD 变量**：t16 之前 **Form A** 会把别名静默存成 `u32`，原始拼写已丢失 → **删掉重加**（§4.5）。
6. **串口/端口**：`Test-NetConnection 127.0.0.1 -Port 9091`；OCD 走 TCL `-Port 6666`。

### 6.7 症状：日志丢行

设计上日志链路**不做解析节流**：`data` 事件里同步完成「解码 → 分级 → 入环」，中间没有 `await`；
接收缓冲用 `pause` 策略（`16 MiB`）而非丢包（`src/service.ts:259-260`）。
完整性计数 `log.total`（`LogStore.totalIngested`，`src/core/store.ts:205`）**独立于环形缓冲**，
可用于核对「收到多少行 vs 保留多少行」（`src/service.ts:435`）。

> ⚠️ **本机无法验证「对照固件实际打印行数」这一条**（无真机，`coordination/acceptance.md` §4 N7）。
> 目前只有 mock TCP 的主机侧压测用例 `DebugService: no log line is lost while the variable channel floods`。

### 6.8 症状：配置「保存了」但重启后没了 / 变量类型不对

**（a）配置不持久化** —— 这是本轮修复的 **blocker**（t14 发现 → t21 修复 → t22 复核，`coordination/verify.md` §13.5）。

| 现象 | 原因 |
|---|---|
| 保存后重启，配置**全部回落默认值**（`intervalMs=100`、空 `elfPath`、`variables=0`） | 修复前：写入形状错 + namespace 未注册 + apply 期拿不到 settings 服务 → **整段持久化被静默跳过** |
| 保存成功但立即断电/强杀，配置丢失 | 修复前 `/profiles/add` **只靠 teardown 写**；现已改为**请求内立即持久化**（§4.5） |
| 响应里出现 `persisted: false` + `persistError` | 持久化失败会被**显式返回**（`src/index.ts:566-569`），按 `persistError` 排查；不要当成保存成功 |

**验证命令（可直接照跑）**：`pwsh -File coordination/t14-api-probe.ps1` → 修复后 **0 failed**（含跨重启读回）。
自检文件：`.verify/evidence/t14-final/FINDING-settings-persistence.md`。

> ⚠️ **务必注意**：**修复前的版本无法保存配置**。修复前配过的 OCD 变量**很可能已经丢失**（写入根本没落盘），请**重新配置**。

**（b）变量类型不对**


**（c）「变量源」面板里勾了符号但没进配置**：勾选只是候选；**必须点 [保存到当前 Profile]** 才写回（§4.2.1）。

---

## 7. 已验证 / 未验证（不要混为一谈）

### 7.1 已在**隔离 DSH 实例**端到端验证通过（`coordination/verify.md` §12，verdict = pass）

| 判据 | 结果 |
|---|---|
| 最终产物能加载：端口可达 + 进组成树 + 进 boot 图 | ✅ |
| 启动日志无 `Failed to load plugins`、无守卫错误（全文 84 B / 1 行） | ✅ 0 命中 |
| client 半在**真实 Cordis** 不抛错；D3 降级成立；双入口注册 | ✅ on-disk 与 served 双路 PASS |
| `/api/rtt-debug/state` HTTP 200，JSON 与基准**逐字段一致** | ✅ |
| 「被判字节 = 下发字节」（code payload sha256 相同 `db873230…`） | ✅ |
| 负对照：故意损坏的插件树确实响亮失败（exit=1、端口未开） | ✅ |
| 不影响在用实例：3080 全程 PID `7680` 未变；`~/.dsh` 五个配置/清单文件 mtime+sha256 完全未变 | ✅ |

**同轮次端到端复跑** —— 由最终集成（t6）补齐，**取代**本节原先「我本轮未重跑」的注记：

```powershell
pwsh -File coordination/verify-final.ps1 -Tag t6-final -Port 39085      # → RESULT: PASS（退出码即 verdict）
```

| 项 | 值 |
|---|---|
| 命令 / Tag | `pwsh -File coordination/verify-final.ps1 -Tag t6-final -Port 39085` |
| 退出码 | **0**（`RESULT: PASS`） |
| 判定条件 | **16 条全部为真**（逐条从 `summary.json` 重算复核） |
| 绑定产物（**t6 轮次的修订**） | `lib/client.js` 63403 B `0CFC46AD…`、`lib/index.js` 102486 B `77418705…`、`src/client/index.tsx` 11711 B `F2FD8AEC…`、`package.json` 1486 B `29668EA4…` |
| 原始证据 | `.verify/evidence/t6-final/`（12 个文件）+ 控制台全文 `.verify/evidence/t6/verify-final-t6-final.console.txt` |
| **出处** | **`coordination/integration.md` §5.4**（该节明确写出「README §7.1 的『我本轮未重跑』注记已被本次 t6 同轮次复跑取代」） |

> 该脚本的判定口径：退出码 `0` 要求**全部**判据为真（含 `lib/client.js` 基线样例必须判 **FAIL**，
> 即判定器必须保有辨别力），见 `coordination/verify-final.ps1:240-255`。
> 复跑发生在**冻结修订**之上，运行后复查 **artifact drift = False**（脚本在 `[1/7]` 钉的哈希与集成报告 §1 一致）。

> ⚠️ **修订口径说明（重要）**：上表「绑定产物」是 **t6 轮次**的修订（`63403 B` / `0CFC46AD…`）。
> 其后还有 t16–t22 的修订（类型解析重构 + 持久化修复），**当前产物哈希与大小已不同** ——
> 现状一律以 **§3.3 的表为准**（`lib/client.js` 93839 B / `AE19CA65…`）。
> 上表的结论（**加载成功、双入口、路由 200、字节同一性、负对照**）在 t18/t22 各轮次都已**在各自修订上复验通过**；
> 本表保留其原始哈希是因为**那次复跑的记录就是针对那份修订**，改写成新哈希反而不忠实。

**我（文档轮次）亲自重跑的部分**（结果与 §3.3 一致）：`npm run typecheck` / `npm run build` / `npm test`（§3.3），
以及 `node coordination/artifact-judge.mjs lib/client.js` → `verdict":"PASS","bodyRenderOk":true`（exit 0）。
产物哈希重建后逐字节一致，故上述结论绑定的是同一份被验证的字节。

### 7.2 本机**无法验证**（禁止写成「通过」，出处 `coordination/acceptance.md` §4）

| # | 项 | 原因 |
|---|---|---|
| N1–N3 | 真机 RTT 9090 / 9091 / OpenOCD TCL 6666 与 OCD 真机读取 | 端口全部未监听，无调试器/无目标 |
| N4 | J-Link 设备是否在场 | 沙箱限制 PnP 枚举，**不得**据此断言在场或不在场 |
| N5 | SEGGER J-Link 官方工具链 | 未安装 |
| N6 | 波形/交互的**像素级外观**（曲线、刻度、准星、游标拖动、分隔条拖拽） | 无头 Edge 不可用（mojo 拒绝访问），无 puppeteer/playwright |
| N7 | 日志完整性的**真机对照** | 需固件实际打印行数作对照 |
| N8 | 拔插调试器后的断连恢复（真机） | 无调试器可拔插 |
| N9 | 语言切换的端到端表现 | 需浏览器 |
| N10 | 入口 B 在页面中的**可见性** | 只证明了「注册调用确实发生」（`workbench:1`），未证明它在页面上真的出现 |

### 7.3 已知问题 / 残留风险（如实记录）

| # | 项 | 级别 | 说明与依据 |
|---|---|---|---|

### 7.3 已知问题 / 残留风险（如实记录）

| # | 项 | 级别 | 说明与依据 |
|---|---|---|---|
| F2 | **入口 A 的 `slots` 未列入 `inject`** | **low** | `ctx.inject?.(['sidebarRightTabs'], …)` 只等服务 `sidebarRightTabs`，随后 `injected.get('slots')` 若为 `undefined` 直接 `return`（`src/client/index.tsx:114-118`）。**隔离环境下可复现「加载成功但面板永不注册」**——我用 `artifact-judge.mjs` 的拓扑改造实测：provide `sidebarRightTabs` + `slots` → `nativeTab:1, nativeSlot:1`；**只 provide `sidebarRightTabs` 不 provide `slots`** → `throw:none` 但 `nativeTab:0, nativeSlot:0`。但**真实拓扑不可达**：`dsh-client-ui-sidebar-right` 自身**硬 inject** `['slots','layout','locale','resources']`（取证路径**不是**本项目的 `lib/client.js`，而是该包自己的：`<profiles>\node_modules\@deepseek-ai\dsh-client-ui-sidebar-right\lib\client.js:3648-3653`，3780 行；本项目 `lib/client.js` 仅 1764 行），四者齐备前不会 `provide('sidebarRightTabs')`。t8 的新 inject face 未引入任何新服务读取 → 维持 low。可选加固：`ctx.inject?.(['sidebarRightTabs','slots'], …)`。复现脚本：`.verify\docs-parsers\g4-repro.mjs`。 |
| F3-残余 | 入口 B 的 tab-id 症状需**真机/完整浏览器**才能观察 | 待现场确认 | 本机无头浏览器不可用（N6）。 |
| A24 | **Device Profile 的多套保存/切换/导入导出** | **未满足（遗留项）** | 代码里**没有**导入导出：对 `src/**` 检索 `importProfile\|exportProfile\|profiles/import\|profiles/export` → **0 命中**；`src/client/panel.tsx` 检索 `profile` → **0 命中**（无 profile 管理界面）。已具备：数据结构 `DeviceProfile`（`src/config.ts:131-141`）、`GET /profiles`、`POST /profiles/add`、`POST /config` 切换、settings 持久化。**已由用户裁决列入遗留项，本轮不实现。** |
| A1 | 侧边栏「两个入口均可打开」（`spec.md:363`） | **本机不可验证** | **限定语：注册代码与降级路径已验证、页面可见性未验证。** 已验侧 —— `coordination/artifact-judge.mjs` 实测两入口**均注册成功**且 `throw=none`：`no-workbench` → `nativeTab:1, nativeSlot:1, workbench:0`（D3 降级成立）、`with-workbench` → `…, workbench:1`（入口 B 注册）；裸读 C1/C3 各 **0 命中**。未验侧 —— A1 判据要求「**可打开**」，本机**无可用浏览器**（`acceptance.md` §4 的 N6/N10）→ 无法观察真实页面。**再分类说明**：A1 已按 `coordination/integration.md` §6.4 由 t1 的「未满足」改归**本机不可验证**——原「未满足」理由(a)（`:127` 裸读致 `apply` 抛错）已被本轮修复**实证消除**，理由(b)（profile 未挂载）属**部署状态**而非代码缺陷（挂载路线见 §2.4）。若验收方取**最严格口径**（要求页面中确实打开），A1 应回到「未满足」列。 |
| **A9b** | **OCD 读变量**（`spec.md:372`） | **本机不可验证** | **精确表述：配置链路与类型链路已验证；真机出数未验证。** 已验侧 —— ①**符号定位**：`nm -S --defined-only` 取符号表、数据段过滤、类型推断链路（`src/ocd/symbols.ts:109-152`、§4.2.2）；②**手填回退**：无 ELF 时走 `binding-parse.ts`（`src/index.ts:653-664`）；③**只读红线**：`ALLOWED_READ_COMMANDS` 白名单 + `assertReadOnly`（`src/ocd/tcl.ts:41-60`），5 条单测；④**端到端类型正确性**：别名拼写经**真实 HTTP** 提交后 `type` 未被降级为 u32（**10/10**，含 t13 原始反例 `float`→`f32`；`coordination/verify.md` §14.5）。**未验侧 —— 真机出数**：判据要求「**周期读取、波形出数**」，而本机**无目标板/无调试器**、TCL 端口 6666 未监听 → `mdw` 真机读回**从未验证**。`coordination/verify.md` §14.10 明确：t17 记录的「f32 → 42.5」是在**本地 mock TCL 端点**上取得的，**不是真机出数，不得据此判 A9b 通过**。**再分类说明**：A9b 原先（`acceptance.md:412`、`integration.md:519`）被列入「已满足/通过」，那是在真机缺位前提下按「代码存在 + 只读已证」的**偏乐观口径**给的；按 t14/t18 的明确要求改归**本机不可验证**。 |
| 判定盲区 | `test/` **未覆盖 `src/client/**`** | 记录 | `plot.ts` 的 `deltaBetween`/`measure`/`ticksFor`/`decimateToPixels` 与 `panel.tsx` 的 `filterLog` 零单测 → A5/A6/A7 的**算法正确性无单测证据**，只有「代码存在 + 守卫级加载通过」。 |
| 遗留产物 | `lib/` 下的 `client.iife.js`(40 B) 与 `index.mjs` 等陈旧文件 | 记录 | `progress.md` B5 的试错遗留，不参与加载（§3.3）。 |

### 7.4 A1–A24 三态汇总

| 三态 | 条目 | 计数 |
|---|---|---|
| 已满足 | A8、A9、A11、A14、A15、A18、A20、A22、A23 | **9** |
| 未满足 | **A24**（Device Profile 导入导出 + 管理界面；用户已裁决为遗留项） | **1** |
| 本机不可验证 | **A1**、**A9b**、A2、A3、A4、A5、A6、A7、A10、A12、A13、A16、A17、A19、A21 | **15** |
| 合计 | — | **25**（A1–A24 + `spec.md:372` 另列的 A9b） |

> **计数变化（相对 `acceptance.md` §5.2 的 t1 口径 10/2/13）**：已满足 **10 → 9**（A9b 移出）、
> 未满足 **2 → 1**（A1 移出）、本机不可验证 **13 → 15**（A1 与 A9b 移入）。三者之和恒为 **25**。
> 相对 `integration.md` §6.4 的 10/1/14 口径，本轮仅把 **A9b 从「通过」移入「本机不可验证」**。

> 项目整体**不可宣称已交付完成**：**A24 未满足**、**14 项**因环境受限无法验证（`coordination/acceptance.md` §4 的 N1–N10）。
> **A1 归入「本机不可验证」不等于它已通过**——它的判据要求「两个入口均可打开」，
> 而本机没有可用浏览器；已验的只是**注册代码与降级路径**（§7.3 A1 行的限定语）。

---

## 8. 目录结构

```
W:\dsh-plugins\dsh-rtt-debug\
├── README.md                  ← 本文件
├── docs\target-integration.md ← 《目标端接入说明》+ 参考 C 片段（D23）
├── spec.md                    ← 需求规格（G1–G5 原则、A1–A24 验收、三批交付）
├── design.md                  ← 技术设计（三源架构、状态机、路由契约）
├── findings.md                ← 环境取证（约束 C1–C10、风险 R1–R9）
├── task_plan.md               ← 计划与决策门 D1–D26
├── progress.md                ← 逐会话进度日志
├── cordis.patch.yml           ← 本插件的 bundle patch（一条 insert 行）
├── package.json               ← dsh.bundle.patch + dsh.client{platform:'web'}
├── tsconfig.json / tsdown.config.ts
├── src\
│   ├── index.ts               ← Host 半：HTTP + 2×WS 路由 + 浏览器信任栅栏
│   ├── service.ts             ← 三源编排、flush、状态、导出
│   ├── config.ts              ← 配置 schema + DeviceProfile + 校验
│   ├── core\                  ← types / framing / ansi / store / tcp-link / ws（手写 RFC 6455）
│   ├── parsers\               ← csv / keyvalue / binary-frame / custom-regex / registry
│   ├── ocd\                   ← symbols / tcl（只读白名单）/ reader
│   ├── openocd\manager.ts     ← 进程生命周期（attach-优先-spawn、就绪探测、重启）
│   └── client\                ← panel / plot / transport / styles / locales / index（双入口）
├── test\                      ← 115 个用例（parsers 39 / core 27 / ocd 35 / service 14）
├── coordination\              ← 本轮缺陷修复的判定契约与验证资产（见下）
└── lib\                       ← 构建产物（.gitignore 忽略）
```

### 8.1 本轮缺陷修复的取证资产（`coordination\`，共 7 个文件）

| 文件 | 作用 |
|---|---|
| `acceptance.md` | **判定契约**：环境基线、故障复现基线、修复后 C1–C10 可判定条目、隔离判定 I1–I10、本机不可验证项 N1–N10、A1–A24 三态复核 |
| `verify.md` | **隔离实例端到端验证报告**：修复前失败基线 + 修复后加载成功 + 字节同一性 + 负对照 + 不回归 + 清理（含 t10 最终修订复验） |
| `integration.md` | **最终集成报告**：哈希冻结核对、全量自检、**同轮次**端到端复跑（`-Tag t6-final`）、A1–A24 最终对账与 **A1 再分类**（§6.4）、跨任务一致性检查（§5，登记 D-1…D-4） |
| `isolated-instance.ps1` | 隔离实例生命周期脚本（`prepare` / `serve` / `verify` / `down` / `clean` / `bundleurl`） |
| `verify-final.ps1` | 一次性重验证：钉哈希 → 起隔离实例 → 采证 → 真实 Cordis 判定 → 字节同一性 → 负对照 → 拆除回检。**退出码即 verdict** |
| `artifact-judge.mjs` | C4 判定器：把 client bundle 喂进**真实 cordis 4.0.2**，判抛错/双入口注册/渲染 |
| `code-payload-identity.mjs` | 证明「被判字节 = 下发字节」（剥掉 combo route 包装后比 code payload sha256） |

> 隔离实例脚本**必须**用它自己的 `DSH_HOME`（工作区内）：boot/`--dump-config` 会写 `<profile>\cordis.yml`
> （`...\dsh\lib\profile-boot-Dk-7KqJc.js:209`），而 `~/.dsh` 归在用实例所有。

### 8.2 文档轮次新增的临时验证脚本（**非交付物**，可随时删除）

放在 **`.verify\docs-parsers\`**（共 **5** 个 `.mjs`），用途是让本 README 与 `docs/target-integration.md` 里的每条结论可复核：

| 脚本 | 验证什么 |
|---|---|
| `verify-formats.mjs` | 用插件**真实解析器**跑目标端接入文档里的每一段示例负载（4 种格式） |
| `verify-truncation.mjs` | 「RTT 写被截断 → 行粘连 → CSV 列错位」这一 R7 后果 |
| `probe-fiber-state.mjs` | 硬 `inject` vs 软 `inject` 在服务缺失时的 `applyRan` / fiber state |
| `g4-repro.mjs` | G-4：只 provide `sidebarRightTabs` 而不 provide `slots` → `nativeSlot:0` |
| `verify-unnamed.mjs` | `custom-regex` 的**未命名捕获组会被忽略**（603 B；实测 `exit 0`，输出 `["amps"]`） |

> ⚠️ **别把两个目录搞混**（它们都装脚本，但性质不同）：
> - **`coordination\`** = **交付资产**（7 个文件：`acceptance.md` / `integration.md` / `verify.md` 三份报告 +
>   `artifact-judge.mjs` / `code-payload-identity.mjs` / `isolated-instance.ps1` / `verify-final.ps1` 四个脚本）——见 §8.1；
> - **`.verify\docs-parsers\`** = **本轮临时验证脚本**（上表 5 个 `.mjs`），**非交付物**，删掉不影响任何结论，
>   只是删掉后上表的复现需要自己重写脚本。

---

## 9. 本轮变更（适配 DSH 0.2.1 + J-Link 官方驱动 + 时间轴改进）

本轮在 **DSH `0.2.1-rc.3`** 上完成适配，并加入三条新能力。下面每条都给出实测依据。

### 9.1 适配 DSH 0.2.1 的关键点（**会直接影响「配置能否保存」**）

| # | 事实 | 影响 | 依据 |
|---|---|---|---|
| 1 | 0.2.1 的 settings 服务**已移除 `register()` / `get()`**，只保留 `describe` / `update` / `write` / `replace` / `mutate` / `schema` / `configure` 等 | 旧代码的 `settings.register(ns, schema)` 抛 `settings.register is not a function`，**整条持久化链路失效**：配置只存在内存里，重启即丢 | 隔离实例 `/api/probe-inject` 实测原型方法列表；`@deepseek-ai/dsh-settings` 0.2.1 `lib/index.js` |
| 2 | 0.2.1 的正道是 **`ctx.configEditor.edit(entry, change)`**：把插件**自身 Config** 写进**当前 profile 的 patch 层**并立即生效 | 配置现在落在 `profiles/<name>/cordis.patch.yml` 的 `- id: dsh-rtt-debug` 下 | `@deepseek-ai/dsh-config-editor` README + `lib/index.js:70` |
| 3 | **判别新旧的唯一可靠信号是 `register` 是否存在**；`update` 两代都有 | 我最初用 `register && update` 组合判别，把 0.2.1 误判成旧版，**跳过了 configEditor**，导致 `persisted:true` 但**文件根本没写**。这个「谎报保存成功」比直接报错更糟 | 实测：`hasRegister=false`、`hasUpdate=true` |
| 4 | 没有可用持久化后端时必须**报错**，不能返回「成功」 | 已在 `persistNow()` 的 `none` 分支改为返回明确错误信息 | `src/index.ts` |

> ⚠️ **升级提示**：0.1.x 上通过 settings 命名空间保存的配置**不会自动迁移**到 0.2.x 的 profile patch。
> 升级后请在「变量源」里重新保存一次（写盘一次后即固化在 profile patch 中）。

### 9.2 J-Link 官方驱动直连（**无需 OpenOCD**）

「变量源」抽屉的「OCD 直读」处新增 **OpenOCD / J-Link 驱动** 标签页切换。选 J-Link 后：

| 数据面 | 走什么 | 说明 |
|---|---|---|
| RTT 日志 / 数据通道 | **SEGGER TELNET 端口**（默认 19021） | 一条连接对应**一个** RTT 通道，连接后 **100 ms 内**发送 `$$SEGGER_TELNET_ConfigStr=RTTCh;<n>;…$$` 选择通道 |
| 变量直读（内存） | **GDB 远程串行协议**（默认 2331） | 裸 RSP `m<addr>,<len>` 读内存，不经 OpenOCD；Cortex-M 上可在**目标运行中**读取 |

源码：`src/jlink/telnet.ts`（通道选择器）、`src/jlink/rsp.ts`（RSP 编解码）、`src/jlink/manager.ts`（进程与 argv）、`src/jlink/reader.ts`（批量内存轮询）。

**已在真实宿主验证**：`/api/rtt-debug/config` 返回完整 `driver` + `jlink` 字段；切换驱动并保存后 `persisted:true`，且**重启后仍然保留**（`driver=jlink`、`device=STM32F407VG`）。

#### 重要：`-RTTSearchRanges` 不适用于 GDB Server

`-RTTSearchRanges` 属于 **JLinkRTTLogger / J-Scope**，`JLinkGDBServer` 会以「未知参数」拒绝。
本插件因此把搜索范围放进**每条连接的 TELNET 配置串**（`SetRTTSearchRanges;0x… 0x…`）。

#### 重要：探针序列号用 `-USB`，不是 `-select usb=`

现行 SEGGER 文档（V8.24+）的形式是 `-USB <SerialNo / Nickname>`；`-SelectEmuBySN` 会被 GDB Server 明确拒绝。
代码与测试都按 `-USB` 实现（`test/jlink.test.ts` 有专门用例钉住这一点）。

#### 重要：默认 `-nohalt -noir`，否则波形会「冻住」

调试器连上时默认会 **halt 目标**，而 halted 的核不再产生 RTT —— 那正是本面板要显示的东西会消失的原因。
因此 `keepTargetRunning` 默认为 `true`，启动参数带上 `-nohalt -noir`。

#### ⚠️ 一处 SEGGER **未公开**的行为（本插件如实上报，不猜）

「同一台 J-Link 的 RTT TELNET 端口能否**同时**接受两个客户端、各自选不同通道」——SEGGER **没有任何文档说明**，
论坛上 2017 / 2019 年的官方回答甚至表示 telnet **只支持通道 0**（`RTTCh` 是后来才加的）。
本插件的处理方式：

- 两条连接各自选通道；
- 若某个通道连上后**一个字节都没收到就被 J-Link 关闭**、而另一通道仍然在线，则判定为「此 J-Link 一次只服务一个 TELNET 通道」，
  **停止重连**并在界面顶部以橙色提示条说明原因（`state.jlinkNotice`）。

**本机无法验证**：本机未安装 SEGGER 软件包，也没有 J-Link 硬件。因此 J-Link 路径只验证到
「协议桩 + 真实 DebugService」这一层（13/13 检查通过），**真机数据流出数未验证**。

### 9.3 时间轴：可调分度（默认 50）+ 缩放范围修正

| 项 | 改前 | 改后 |
|---|---|---|
| 时间轴分度 | 固定约 6 条，由 `ticksFor(…, 6)` 决定 | **可调 2–200，默认 50**（工具栏「分度」输入框）。**列线始终按该密度绘制**，空间不足时只**抽稀标签**，不减少列线 |
| 滚轮缩放上限 | 60 分钟（任意截断） | 24 小时（`MAX_WINDOW_MINUTES`） |
| 滚轮缩放下限 | 3 秒 | **0.1 秒**（`MIN_WINDOW_MINUTES`），可放大到单样本级别 |

分度实现：`src/client/plot.ts` 的 `drawGrid` 按 `span / divisions` 等分绘制竖线，`timeLabelStride()` 决定标签抽稀倍数。

### 9.4 本轮自检结果

| 项 | 结果 |
|---|---|
| `typecheck`（`tsc --noEmit`） | **0 error** |
| 测试 | **163 pass / 0 fail**（新增 `test/jlink.test.ts` 28 项、`test/driver.test.ts` 12 项、`test/persistence.test.ts` 5 项） |
| 构建 | `lib/index.js` + `lib/client.js` 均产出；新代码标记（`JLinkGDBServerCL`/`-RTTTelnetPort`/`QStartNoAckMode`/`driver.tabJlink`/`wave.divisions`）均在产物中命中 |
| 真实宿主加载 | 隔离实例（`DSH_HOME` 在工作区内，端口 39182–39189）中 `/api/rtt-debug/state` 返回 `driver` 字段；Boot 图含 `dsh-rtt-debug/client.js`，下发 bundle 含新 UI |
| J-Link 协议桩端到端 | **13/13**：两通道同一 TELNET 端口各自选通道、日志行到达、CSV 采样解析、RSP 内存读出 `u16=1234` / `u32=0x1000` |
| J-Link 缺失时的报错 | 可操作提示：`J-Link software not found (tried …). Set the JLinkGDBServerCL.exe path … or install the SEGGER J-Link Software Pack.` |
| **本机无法验证** | J-Link **真机**出数、多客户端并发行为、真实硬件上的 `-nohalt` 表现 |

---

## 10. 许可与署名

MIT License。作者 **JiXieShi** `<lydxh935227514@gmail.com>`。
