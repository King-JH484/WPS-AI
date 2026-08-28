#!/usr/bin/env bash
set -e

echo "============================================"
echo "  Anthony AI 永久卸载（macOS）"
echo "============================================"

TARGET="$HOME/.anthony-ai"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.anthony-ai.server.plist"

# ---- 旧品牌（灵犀AI / lingxi-ai）残留 ----
# 升级上来的机器上旧 LaunchAgent 还会自启，不清就会出现「卸载完了端口还被占着」。
# 这些字面量是历史事实，不参与品牌改名替换，见 docs/REBRAND.md。
LEGACY_PLIST="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
LEGACY_TARGET="$HOME/.lingxi-ai"
LEGACY_LOGS="$HOME/Library/Logs/lingxi-ai"

# 1. 卸 LaunchAgent
if [ -f "$LAUNCH_AGENT" ]; then
  launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
  rm -f "$LAUNCH_AGENT"
  echo "[OK] 已删除 LaunchAgent"
fi

# 1b. 卸旧品牌 LaunchAgent
if [ -f "$LEGACY_PLIST" ]; then
  launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
  launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
  rm -f "$LEGACY_PLIST"
  echo "[OK] 已删除旧品牌 LaunchAgent: $LEGACY_PLIST"
fi
# plist 已被手删但 Label 仍在册时的兜底
launchctl bootout "gui/$(id -u)/com.lingxi-ai.server" 2>/dev/null || true
launchctl remove com.lingxi-ai.server 2>/dev/null || true
pkill -9 -f "\.lingxi-ai/" 2>/dev/null || true

# 2. 删 publish.xml
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  pub="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons/publish.xml"
  if [ -f "$pub" ]; then
    rm -f "$pub"
    echo "[OK] 已删除 $pub"
  fi
done

# 3. 删目标目录
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  echo "[OK] 已删除 $TARGET"
fi

# 4. 删旧品牌用户级残留（升级场景）
for ld in "$LEGACY_TARGET" "$LEGACY_LOGS"; do
  case "$ld" in "$HOME"/?*) ;; *) continue ;; esac
  if [ -d "$ld" ]; then
    rm -rf "$ld"
    echo "[OK] 已删除旧品牌残留 $ld"
  fi
done

echo
echo "卸载完成。重启 WPS 后插件不再加载。"
echo "注：系统级的 /Library/Application Support/LingxiAI（旧品牌 dmg 安装留下的）"
echo "    需要管理员权限，请用 /Applications 里的卸载 App，或手动执行："
echo "    sudo rm -rf \"/Library/Application Support/LingxiAI\""