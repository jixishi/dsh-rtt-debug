# dsh-rtt-debug 离线安装指南

本目录包含 `dsh-rtt-debug` 插件的完整离线安装产物与自动化安装脚本。

---

## 目录内容

- `dsh-rtt-debug-0.1.0.tgz`：预先构建并打包的完整 npm 插件包（包含全量构建产物、源映射、插件补丁与随包 AI 技能）。
- `install.ps1`：Windows PowerShell 一键安装脚本。
- `install.sh`：Linux / macOS Bash 一键安装脚本。
- `README.md`：本离线安装指南。

---

## 安装方法

### 方法一：一键自动安装（推荐）

#### Windows 用户
打开 PowerShell（无需管理员权限），进入本解压目录执行：
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

#### Linux / macOS 用户
打开终端，进入本解压目录执行：
```bash
chmod +x ./install.sh
./install.sh
```

脚本将自动完成：
1. 校验并解压安装包至 `~/.dsh/profiles/web/node_modules/dsh-rtt-debug`；
2. 自动在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中登记 `dsh-rtt-debug`；
3. 将配套的 `rtt-debug` AI 技能安装至 `~/.dsh/skills/rtt-debug/SKILL.md`；
4. 提示重启 `dsh web`。

---

### 方法二：通过 pnpm 离线安装

如果你偏好使用包管理器管理 DSH Profile，可在 DSH Profile 目录直接引用本地 `.tgz` 文件：

```bash
cd ~/.dsh/profiles/web
pnpm add <安装包所在绝对路径>/dsh-rtt-debug-0.1.0.tgz
```
安装后确认 `~/.dsh/profiles/web/package.json` 中已将 `"dsh-rtt-debug"` 列入 `dsh.profile.bundles`：
```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-rtt-debug"
      ]
    }
  }
}
```

---

### 方法三：手动解压安装

1. 解压 `dsh-rtt-debug-0.1.0.tgz`：
   ```bash
   tar -xzf dsh-rtt-debug-0.1.0.tgz
   ```
   解压后会产生一个 `package` 文件夹。
2. 将 `package` 文件夹移动并重命名为目标路径：
   `~/.dsh/profiles/web/node_modules/dsh-rtt-debug`
3. 检查 `~/.dsh/profiles/web/package.json`，在 `dsh.profile.bundles` 列表中加入 `"dsh-rtt-debug"`。
4. 将 `package/skills/rtt-debug/SKILL.md` 复制到 `~/.dsh/skills/rtt-debug/SKILL.md`。

---

## 启动与生效

完成安装后，在终端中启动或重启 DSH Web 实例：
```bash
dsh web
```
在浏览器中打开 Web 界面（如 `http://127.0.0.1:3080`），侧边栏即可看到 **RTT 调试** 插件，右侧打开波形与日志面板！
在会话中也可直接向 AI 发送指令（例如：「使用 rtt-debug 技能配置监控变量 g_sys_tick_ms 并启动」）。
