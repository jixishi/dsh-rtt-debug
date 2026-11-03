#!/usr/bin/env bash
set -euo pipefail

PROFILE_PATH="${1:-$HOME/.dsh/profiles/web}"
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TGZ_PATH="${CURRENT_DIR}/dsh-rtt-debug-0.1.0.tgz"

echo "=========================================================="
echo "  dsh-rtt-debug 插件离线安装向导"
echo "=========================================================="

if [ ! -f "$TGZ_PATH" ]; then
  echo "错误: 未找到安装包 $TGZ_PATH"
  exit 1
fi

echo "目标 DSH Profile: $PROFILE_PATH"

if [ ! -d "$PROFILE_PATH" ]; then
  echo "错误: DSH Profile 目录不存在: $PROFILE_PATH"
  echo "请确保已安装 DeepSeek Harness 并运行过 dsh web。"
  exit 1
fi

mkdir -p "${PROFILE_PATH}/node_modules"
TARGET_DIR="${PROFILE_PATH}/node_modules/dsh-rtt-debug"

echo "[1/4] 清理已有安装目录..."
rm -rf "$TARGET_DIR"

echo "[2/4] 解压安装插件包到 node_modules/dsh-rtt-debug..."
TEMP_DIR=$(mktemp -d)
tar -xzf "$TGZ_PATH" -C "$TEMP_DIR"
mv "$TEMP_DIR/package" "$TARGET_DIR"
rm -rf "$TEMP_DIR"

echo "[3/4] 注册插件到 profile package.json (dsh.profile.bundles)..."
PKG_JSON="${PROFILE_PATH}/package.json"
if [ -f "$PKG_JSON" ]; then
  node -e "
    const fs = require('fs');
    const p = '$PKG_JSON';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
    if (!pkg.dsh.profile.bundles.includes('dsh-rtt-debug')) {
      pkg.dsh.profile.bundles.push('dsh-rtt-debug');
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2), 'utf8');
      console.log('      已追加 dsh-rtt-debug 到 bundles');
    } else {
      console.log('      bundles 中已有 dsh-rtt-debug，跳过追加');
    }
  "
fi

echo "[4/4] 安装 AI 技能到 ~/.dsh/skills/rtt-debug..."
SKILL_SRC="${TARGET_DIR}/skills/rtt-debug/SKILL.md"
if [ -f "$SKILL_SRC" ]; then
  mkdir -p "$HOME/.dsh/skills/rtt-debug" "$HOME/.agents/skills/rtt-debug" 2>/dev/null || true
  cp -f "$SKILL_SRC" "$HOME/.dsh/skills/rtt-debug/SKILL.md" 2>/dev/null || true
  cp -f "$SKILL_SRC" "$HOME/.agents/skills/rtt-debug/SKILL.md" 2>/dev/null || true
fi

echo ""
echo "=========================================================="
echo "  安装成功！"
echo "  请重启 DSH Web 实例生效: dsh web"
echo "=========================================================="
