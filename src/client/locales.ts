/**
 * Panel copy, in both languages.
 *
 * Keys are looked up at render time rather than resolved once, so a language
 * change re-renders the panel with the new strings — which is what the
 * sidebar's thunked `title`/`description` contract expects.
 *
 * The active language follows the host locale service when one is reachable and
 * falls back to the browser's own preference, so the panel is usable even
 * outside DSH.
 */

export type LocaleKey = keyof typeof ZH

const ZH = {
  'tab.title': 'RTT 调试',
  'tab.description': '实时变量波形（上方）与完整 RTT 日志（下方）；三路数据源可独立启停。',

  'status.loading': '加载中…',
  'status.running': '{backend} 运行中（pid {pid}）',
  'status.attached': '已连接现有 {backend}',
  'status.error': '错误：{message}',
  'status.notReadyPrompt': '（提示：请先在终端启动调试后端，或在「变量源」中完成配置）',
  'status.idle': '未启动',
  'status.probing': '探测中…',
  'status.starting': '启动中…',

  'source.log': 'RTT 日志',
  'source.rttVar': 'RTT 数据通道',
  'source.ocd': '变量直读',

  'btn.start': '启动',
  'btn.stop': '停止',
  'btn.running': '运行中',
  'btn.clear': '清空',
  'btn.clearAll': '全部清空',
  'btn.close': '关闭',

  'wave.window': '时间窗',
  'wave.cursor': '标尺',
  'wave.cursorClear': '清除标尺',
  'wave.cursorHint': '开启后单击放置游标 A/B；拖动可移动，读数显示 Δt / ΔV / 1÷Δt',
  'wave.autoscale': '自动量程',
  'wave.toggleSeries': '显示/隐藏 {name}',
  'wave.pick': '选择变量（{count}/{total}）',
  'wave.empty': '暂无变量数据。启动数据源后，勾选变量即可看到曲线。',
  'plot.empty': '暂无变量数据。启动数据源后，勾选变量即可看到曲线。',

  'readout.delta': '游标测量',
  'readout.hover': '悬停',

  'log.filterPlaceholder': '过滤关键字…',
  'log.regex': '正则',
  'log.follow': '自动跟随',
  'log.export': '导出',
  'log.jumpToLatest': '回到最新',
  'log.counters': '保留 {retained} / 已收 {total}',
  'log.completenessHint': '「已收」为累计接收行数，独立于环形缓冲，可用于核对日志完整性。',

  'sources.open': '变量源',
  'sources.title': '变量源',
  'sources.rttSection': 'RTT 数据通道（只读）',
  'sources.parser': '解析器',
  'sources.parserSection': '解析器（可编辑）',
  'sources.parserId': '类型',
  'sources.parserDelimiter': '分隔符',
  'sources.parserDelimiterHint': '字段分隔符，如 , ; 制表符 \\t 或空格（空格按连续空白切分）。',
  'sources.parserTerminator': '换行标识',
  'sources.parserTerminatorHint': '记录结束符。支持 \\n（默认）、\\r、\\r\\n、\\t、\\0，或直接填一个字符。',
  'sources.parserExpression': '自定义解析表达式',
  'sources.parserExpressionHint': '对每条记录求值，返回一个对象即为变量。可用：fields（已切分的字段数组）、line（原始记录）、index（序号）、Number、Math。',
  'sources.parserSkipFirst': '跳过首行（表头）',
  'sources.parserPattern': '正则',
  'sources.parserPatternHint': '行正则，具名捕获组即变量名。未命名组会被忽略。',
  'sources.parserFlags': '正则标志',
  'sources.parserHasHeader': '首行是表头',
  'sources.parserSave': '保存解析器',
  'sources.parserSaved': '解析器已保存',
  'sources.parserError': '解析器报错：{message}',
  'sources.parserSandboxNote': '自定义表达式在宿主进程内运行，仅允许纯计算：无 require / process / 全局对象，无法访问文件或网络。',
  'sources.rttNone': '尚未发现变量。启动数据源后此处会列出已解析的变量名。',
  'sources.rttFallbackHint': '以下名称来自已收到的曲线数据（解析器尚未回报描述符）。',
  'sources.ocdSection': 'OCD 直读（可编辑）',
  'sources.enabled': '启用变量直读',
  'sources.configPath': 'OpenOCD 配置',
  'sources.configPathHint': 'OpenOCD 配置文件路径（如 openocd.cfg）。未启动时按此配置拉起；若已有 OpenOCD 运行则自动连接。',
  'sources.elfPath': 'ELF 路径',
  'sources.elfPathHint': '相对路径按宿主进程的工作目录（CWD）解析——本项不做工作区解析，如需指向当前会话的工作区请使用绝对路径。',
  'sources.nmPath': 'nm 路径',
  'sources.nmPathHint': '留空则按 transport 默认值（arm-none-eabi-nm）取符号。',
  'sources.interval': '轮询间隔',
  'sources.intervalUnit': 'ms',
  'sources.filter': '筛选',
  'sources.filterPlaceholder': '符号名关键字…',
  'sources.browse': '浏览符号',
  'sources.browsing': '读取中…',
  'sources.browseEmpty': '未找到匹配的符号。',
  'sources.browseHint': '需要先填写 ELF 路径。',
  'sources.browseCount': '找到 {count} 个符号',
  'sources.manualLabel': '手填地址',
  'sources.manualPlaceholder': '如 0x20000000:u16:VoltMv 或 VoltMv@0x20000000:u16',
  'sources.manualHint': '两种写法都支持；类型可省略（默认 u32）。',
  'sources.unit': '单位',
  'sources.unitPlaceholder': '如 mV',
  'sources.add': '添加',
  'sources.manualBad': '无法解析该写法，请检查地址与类型。',
  'sources.configured': '已配置变量（{count}）',
  'sources.configuredEmpty': '尚未配置变量。勾选符号或手填地址后添加。',
  'sources.columnName': '名称',
  'sources.columnAddress': '地址',
  'sources.columnType': '类型',
  'sources.columnUnit': '单位',
  'sources.remove': '移除',
  'sources.save': '保存到当前 Profile',
  'sources.saving': '保存中…',
  'sources.saved': '已保存到 Profile「{name}」，并已持久化。',
  'sources.reload': '重新读取配置',
  'sources.loadFailed': '读取配置失败：{message}',
  'sources.saveFailed': '保存失败：{message}',
  'sources.persistFailed': '配置已生效，但写入持久化设置失败；宿主重启后可能丢失。',
  'sources.unresolved': '以下条目未解析成功，已跳过（不会写入配置）：',
  'sources.unresolvedItem': '{name}：{reason}',
  'sources.needRestartHint': '生效方式：数据源已在运行时，保存会即时按新变量重建 OCD 采样（关闭开关则立即停止直读）；数据源未运行时，保存的变量将在下次 [启动] 时生效。',
  'sources.keepRunningNote': 'OCD 直读需要 OpenOCD TCL 端口可达；连接失败会在上方状态栏报错，不会静默。',

  'sources.saveWorkspace': '保存到工作区 (.dsh)',
  'sources.saveWorkspaceHint': '保存到当前工作区的 .dsh/rtt-debug.json（随当前项目管理与版本化）',
  'sources.saveGlobal': '保存到全局设置',
  'sources.saveGlobalHint': '保存到宿主全局设置（~/.dsh/settings.yaml，所有项目共享）',
  'sources.savedWorkspace': '已成功保存至工作区「{path}」',
  'sources.savedGlobal': '已成功保存至全局设置（~/.dsh）',
  'sources.scopeWorkspace': '📁 当前配置：工作区 (.dsh/rtt-debug.json)',
  'sources.scopeGlobal': '🌐 当前配置：全局设置 (~/.dsh)',
  'sources.browseFile': '浏览…',
  'sources.pickerTitleCfg': '选择 OpenOCD 配置文件 (*.cfg)',
  'sources.pickerTitleElf': '选择固件 ELF 文件 (*.elf, *.axf, *.out)',
  'sources.quickCandidates': '推荐候选（点击直接填入）：',
  'sources.parentDir': '返回上一级',
  'sources.emptyDir': '当前目录无匹配文件',
  'sources.filterFile': '过滤文件名…',
  'sources.jumpLive': '回到最新 (Live)',
  'sources.freqHint': '对应频率：{freq}',
  'sources.periodHint': '对应周期：{ms} ms',
  'sources.intervalUnitHz': 'Hz',
  'sources.unitModeMs': '毫秒 (ms)',
  'sources.unitModeHz': '频率 (Hz)',

  'wave.divisions': '分度',
  'wave.divisionsHint': '时间轴网格列数（默认 50）。列线始终按该密度绘制；标签过密时自动隔一显示。',
  'wave.resetWindow': '恢复 1 分钟时间窗',
  'wave.zoomLimitHint': '滚轮缩放范围：{min} … {max}',

  /* driver tabs */
  'driver.tabOpenocd': 'OpenOCD',
  'driver.tabJlink': 'J-Link 驱动',
  'driver.hint': '变量直读通道：选择由 OpenOCD 还是 J-Link 官方驱动承担内存读取。',
  'driver.jlinkTitle': 'J-Link 官方驱动（无需 OpenOCD）',
  'driver.jlinkExecutable': 'J-Link 可执行文件',
  'driver.jlinkExecutableHint': 'JLinkGDBServerCL.exe 或 JLink.exe 的完整路径；留空则从 PATH 查找。**属于本机**：存全局配置。',
  'driver.openocdExecutable': 'OpenOCD 程序',
  'driver.openocdExecutableHint': 'OpenOCD 可执行文件（openocd.exe）的完整路径；留空则用 PATH 里的 openocd。**属于本机**：存全局配置，不写入工作区。',
  'driver.jlinkDevice': '目标器件',
  'driver.jlinkDeviceHint': '传给 J-Link 的 -device 值，例如 STM32F407VG、Cortex-M4。',
  'driver.jlinkInterface': '调试接口',
  'driver.jlinkSpeed': '接口速率 (kHz)',
  'driver.jlinkGdbPort': 'GDB 端口',
  'driver.jlinkRttTelnetPort': 'RTT Telnet 端口',
  'driver.jlinkRttTelnetHint': 'J-Link 的 RTT TELNET 通道端口（默认 19021）。每条 RTT 通道各占一条连接。',
  'driver.jlinkSerial': '探针序列号',
  'driver.jlinkSerialHint': '可选：多探针时指定 -select usb=<serial>。留空表示默认探针。',
  'driver.jlinkAutoStart': '由插件启动 J-Link',
  'driver.jlinkAutoStartHint': '关闭时插件只连接已在运行的 J-Link 软件（attach 模式）。',
  'driver.jlinkChannels': 'RTT 通道使用 TELNET 直连，内存读取走 GDB 协议。',
  'sources.toolScopeHint': '程序路径（OpenOCD / J-Link / nm）存全局配置；其余设置存工作区 .dsh/rtt-debug.json。',
} as const

const EN: Record<LocaleKey, string> = {
  'tab.title': 'RTT Debug',
  'tab.description': 'Live variable waveform (top) and the complete RTT log (bottom); three independently switchable data sources.',

  'status.loading': 'Loading…',
  'status.running': '{backend} running (pid {pid})',
  'status.attached': 'Attached to an existing {backend}',
  'status.error': 'Error: {message}',
  'status.notReadyPrompt': ' (hint: start the debug backend in a terminal, or finish configuring it in Variable Sources)',
  'status.idle': 'Not started',
  'status.probing': 'Probing…',
  'status.starting': 'Starting…',

  'source.log': 'RTT log',
  'source.rttVar': 'RTT data channel',
  'source.ocd': 'Variable reads',

  'btn.start': 'Start',
  'btn.stop': 'Stop',
  'btn.running': 'Running',
  'btn.clear': 'Clear',
  'btn.clearAll': 'Clear all',
  'btn.close': 'Close',

  'wave.window': 'Window',
  'wave.cursor': 'Ruler',
  'wave.cursorClear': 'Clear ruler',
  'wave.cursorHint': 'Click to place cursor A/B; drag to move. Shows Δt / ΔV / 1÷Δt.',
  'wave.autoscale': 'Autoscale',
  'wave.toggleSeries': 'Show/hide {name}',
  'wave.pick': 'Variables ({count}/{total})',
  'wave.empty': 'No variable data yet. Start a source, then tick a variable to plot it.',
  'plot.empty': 'No variable data yet. Start a source, then tick a variable to plot it.',

  'readout.delta': 'Cursor',
  'readout.hover': 'Hover',

  'log.filterPlaceholder': 'Filter…',
  'log.regex': 'regex',
  'log.follow': 'Follow',
  'log.export': 'Export',
  'log.jumpToLatest': 'Jump to latest',
  'log.counters': '{retained} kept / {total} received',
  'log.completenessHint': '“received” counts every line ever accepted, independent of the ring buffer — use it to verify log completeness.',

  'sources.open': 'Sources',
  'sources.title': 'Variable sources',
  'sources.rttSection': 'RTT data channel (read-only)',
  'sources.parser': 'Parser',
  'sources.parserSection': 'Parser (editable)',
  'sources.parserId': 'Type',
  'sources.parserDelimiter': 'Delimiter',
  'sources.parserDelimiterHint': 'Field separator: , ; tab (\\t) or a space (whitespace runs).',
  'sources.parserTerminator': 'Record terminator',
  'sources.parserTerminatorHint': 'Ends a record. Supports \\n (default), \\r, \\r\\n, \\t, \\0, or a literal character.',
  'sources.parserExpression': 'Custom parse expression',
  'sources.parserExpressionHint': 'Evaluated per record; return an object to produce variables. Available: fields (split array), line (raw record), index, Number, Math.',
  'sources.parserSkipFirst': 'Skip first line (header)',
  'sources.parserPattern': 'Pattern',
  'sources.parserPatternHint': 'Line regex; named capture groups become variable names. Unnamed groups are ignored.',
  'sources.parserFlags': 'Flags',
  'sources.parserHasHeader': 'First line is a header',
  'sources.parserSave': 'Save parser',
  'sources.parserSaved': 'Parser saved',
  'sources.parserError': 'Parser error: {message}',
  'sources.parserSandboxNote': 'The custom expression runs in the host process and permits pure computation only: no require / process / globals, no file or network access.',
  'sources.rttNone': 'No variables discovered yet. Start a source and the parsed names appear here.',
  'sources.rttFallbackHint': 'These names come from the series already received (the parser has not reported descriptors yet).',
  'sources.ocdSection': 'Variable reads (editable)',
  'sources.enabled': 'Enable variable reads',
  'sources.configPath': 'OpenOCD config',
  'sources.configPathHint': 'Path to OpenOCD config file (e.g. openocd.cfg). Used when spawning OpenOCD; attaches automatically if already running. **Project-scoped**: saved with the workspace.',
  'sources.elfPath': 'ELF path',
  'sources.elfPathHint': 'A relative path resolves against the current session workspace root (falls back to host process CWD when no session is attached).',
  'sources.nmPath': 'nm path',
  'sources.nmPathHint': 'Empty uses the default (arm-none-eabi-nm). **Machine-wide**: saved in the global config, never in the workspace file.',
  'sources.toolScopeHint': 'Program paths (OpenOCD / J-Link / nm) live in the global config; everything else is saved to the workspace’s .dsh/rtt-debug.json.',
  'sources.interval': 'Poll interval',
  'sources.intervalUnit': 'ms',
  'sources.filter': 'Filter',
  'sources.filterPlaceholder': 'symbol name contains…',
  'sources.browse': 'Browse symbols',
  'sources.browsing': 'Reading…',
  'sources.browseEmpty': 'No matching symbols.',
  'sources.browseHint': 'Set an ELF path first.',
  'sources.browseCount': '{count} symbols found',
  'sources.manualLabel': 'Manual address',
  'sources.manualPlaceholder': 'e.g. 0x20000000:u16:VoltMv or VoltMv@0x20000000:u16',
  'sources.manualHint': 'Both spellings work; the type may be omitted (defaults to u32).',
  'sources.unit': 'Unit',
  'sources.unitPlaceholder': 'e.g. mV',
  'sources.add': 'Add',
  'sources.manualBad': 'Could not parse that spelling — check the address and type.',
  'sources.configured': 'Configured variables ({count})',
  'sources.configuredEmpty': 'Nothing configured yet. Tick a symbol or enter a manual address.',
  'sources.columnName': 'Name',
  'sources.columnAddress': 'Address',
  'sources.columnType': 'Type',
  'sources.columnUnit': 'Unit',
  'sources.remove': 'Remove',
  'sources.save': 'Save to current profile',
  'sources.saving': 'Saving…',
  'sources.saved': 'Saved to profile “{name}” and persisted.',
  'sources.reload': 'Reload config',
  'sources.loadFailed': 'Could not read the configuration: {message}',
  'sources.saveFailed': 'Save failed: {message}',
  'sources.persistFailed': 'Applied, but writing to persistent settings failed — it may be lost across a host restart.',
  'sources.unresolved': 'These entries did not resolve and were skipped (not written to the config):',
  'sources.unresolvedItem': '{name}: {reason}',
  'sources.needRestartHint': 'How it takes effect: with a source already running, saving re-binds the OCD sampling immediately (switching the toggle off stops the reads at once). While stopped, the saved variables take effect on the next [Start].',
  'sources.keepRunningNote': 'OCD reads need a reachable OpenOCD TCL port; a failed connection is reported in the status line above rather than failing silently.',

  'sources.saveWorkspace': 'Save to workspace (.dsh)',
  'sources.saveWorkspaceHint': 'Save to current workspace .dsh/rtt-debug.json (recommended)',
  'sources.saveGlobal': 'Save to global settings',
  'sources.saveGlobalHint': 'Save to host global settings (~/.dsh/settings.yaml)',
  'sources.savedWorkspace': 'Successfully saved to workspace “{path}”',
  'sources.savedGlobal': 'Successfully saved to global settings (~/.dsh)',
  'sources.scopeWorkspace': '📁 Current config: Workspace (.dsh/rtt-debug.json)',
  'sources.scopeGlobal': '🌐 Current config: Global (~/.dsh)',
  'sources.browseFile': 'Browse…',
  'sources.pickerTitleCfg': 'Select OpenOCD config file (*.cfg)',
  'sources.pickerTitleElf': 'Select firmware ELF file (*.elf, *.axf, *.out)',
  'sources.quickCandidates': 'Quick suggestions (click to select):',
  'sources.parentDir': 'Up',
  'sources.emptyDir': 'No matching files in directory',
  'sources.filterFile': 'Filter files…',
  'sources.jumpLive': 'Jump to live',
  'sources.freqHint': 'Equivalent: {freq}',
  'sources.periodHint': 'Equivalent: {ms} ms',
  'sources.intervalUnitHz': 'Hz',
  'sources.unitModeMs': 'ms',
  'sources.unitModeHz': 'Hz',

  'wave.divisions': 'Div',
  'wave.divisionsHint': 'Grid columns along the time axis (default 50). Lines always follow that density; labels thin out automatically when space is short.',
  'wave.resetWindow': 'Back to a 1-minute window',
  'wave.zoomLimitHint': 'Wheel zoom range: {min} … {max}',

  'driver.tabOpenocd': 'OpenOCD',
  'driver.tabJlink': 'J-Link driver',
  'driver.hint': 'Which backend performs the memory reads for direct variable sampling.',
  'driver.jlinkTitle': 'SEGGER J-Link driver (no OpenOCD)',
  'driver.jlinkExecutable': 'J-Link executable',
  'driver.jlinkExecutableHint': 'Full path to JLinkGDBServerCL.exe or JLink.exe; empty means look it up on PATH. **Machine-wide**: saved in the global config.',
  'driver.openocdExecutable': 'OpenOCD program',
  'driver.openocdExecutableHint': 'Full path to openocd.exe; empty uses openocd from PATH. **Machine-wide**: saved in the global config, never in the workspace file.',
  'driver.jlinkDevice': 'Target device',
  'driver.jlinkDeviceHint': 'The -device value for J-Link, e.g. STM32F407VG or Cortex-M4.',
  'driver.jlinkInterface': 'Target interface',
  'driver.jlinkSpeed': 'Interface speed (kHz)',
  'driver.jlinkGdbPort': 'GDB port',
  'driver.jlinkRttTelnetPort': 'RTT Telnet port',
  'driver.jlinkRttTelnetHint': 'The J-Link RTT TELNET port (default 19021). Each RTT channel takes its own connection.',
  'driver.jlinkSerial': 'Probe serial',
  'driver.jlinkSerialHint': 'Optional: pick one probe with -select usb=<serial>. Empty means the default probe.',
  'driver.jlinkAutoStart': 'Plugin starts J-Link',
  'driver.jlinkAutoStartHint': 'When off, the plugin only attaches to already-running J-Link software.',
  'driver.jlinkChannels': 'RTT channels use the TELNET port directly; memory reads use the GDB protocol.',
}

let activeLanguage: 'zh' | 'en' | undefined

/** Resolve the panel language: host locale when known, else the browser's. */
function resolveLanguage(): 'zh' | 'en' {
  if (activeLanguage !== undefined) return activeLanguage
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}

/**
 * Pin the language explicitly (used when the host locale service is reachable).
 * @param language - BCP-47 tag; anything not starting with `zh` selects English.
 */
export function setLanguage(language: string | undefined): void {
  activeLanguage = language === undefined ? undefined : language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const DICTIONARIES = { zh: ZH, en: EN } as const

/**
 * Look up a string.
 * @param key - message key.
 * @param params - values substituted into `{name}` placeholders.
 */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const table = DICTIONARIES[resolveLanguage()] as Record<string, string>
  let text = table[key] ?? ZH[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}
