#!/usr/bin/env bash
# 灵犀AI macOS 卸载脚本(用户上下文)
#
# 由 uninstall.command 或 pkg postinstall(升级时清旧)调用。
# 直接手跑也行: bash pre-uninstall-mac.sh

set -u

TARGET="$HOME/.lingxi-ai"
PLIST="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
LOG="$TARGET/uninstall.log"

mkdir -p "$TARGET" 2>/dev/null || true

log() {
  if [ -d "$TARGET" ]; then
    echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2
  else
    echo "[$(date '+%F %T')] $*" >&2
  fi
}

log "==== pre-uninstall-mac 启动 ===="

# 1. 停 LaunchAgent
launchctl bootout "gui/$(id -u)" "$PLIST" >>"$LOG" 2>&1 || true
launchctl unload "$PLIST" >>"$LOG" 2>&1 || true
log "[OK] LaunchAgent 已卸"

# 2. 杀残留进程
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server   >>"$LOG" 2>&1 || true

# 3. 删 LaunchAgent plist
if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  log "[OK] 删 $PLIST"
fi

# 4. 删两个 Container 里的 publish.xml
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  pub="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons/publish.xml"
  if [ -f "$pub" ]; then
    rm -f "$pub"
    log "[OK] 删 $pub"
  fi
done

# 5. 删 ~/.lingxi-ai(变体目录、服务脚本、日志)
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  log "[OK] 删 $TARGET"
fi

log "==== pre-uninstall-mac 完成 ===="
exit 0
