#!/usr/bin/env bash
# Anthony AI macOS 轻量卸载(用户上下文,不动系统目录)
#
# 给手动 .sh 安装路径 + 升级前清旧场景用。dmg 安装的用户应该走
# /Applications/Anthony AI 卸载.app(它调 installer-mac/uninstall-all.sh
# 一并清掉 /Library/Application Support/AnthonyAI 和 pkgutil receipt)。
#
# 直接手跑: bash pre-uninstall-mac.sh

set -u

# 修 T7：空 $HOME 会让 rm -rf "$HOME/.anthony-ai" 变成 rm -rf "/.anthony-ai"。空/根家目录退出。
if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  echo "[pre-uninstall] [ERROR] \$HOME 为空或为根，已中止以免误删系统路径。" >&2
  exit 1
fi

TARGET="$HOME/.anthony-ai"
PLIST="$HOME/Library/LaunchAgents/com.anthony-ai.server.plist"
LOG="$TARGET/uninstall.log"

# ---- 旧品牌（灵犀AI / lingxi-ai）残留 ----
# 从旧版升级上来的机器上，这些路径还在，LaunchAgent 还会在登录时把旧服务拉起来，
# 于是出现「卸载完了 3889/3890 还被占着」「重启后又冒出一个后台进程」。
# 这些字面量是历史事实，**不参与**品牌改名替换（见 docs/REBRAND.md 的「受保护字面量」）。
LEGACY_HOME_DIRS=(
  "$HOME/.lingxi-ai"
)
LEGACY_PLISTS=(
  "$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
)
LEGACY_LOG_DIRS=(
  "$HOME/Library/Logs/lingxi-ai"
)

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

# 1b. 停旧品牌 LaunchAgent（升级场景；不存在就静默跳过）
for lp in "${LEGACY_PLISTS[@]}"; do
  [ -f "$lp" ] || continue
  launchctl bootout "gui/$(id -u)" "$lp" >>"$LOG" 2>&1 || true
  launchctl unload "$lp" >>"$LOG" 2>&1 || true
  log "[OK] 旧品牌 LaunchAgent 已卸: $lp"
done
# 旧版 Label 可能已加载但 plist 已被手工删掉，按 Label 再兜一刀
launchctl bootout "gui/$(id -u)/com.lingxi-ai.server" >>"$LOG" 2>&1 || true
launchctl remove com.lingxi-ai.server >>"$LOG" 2>&1 || true

# 2. 杀残留进程
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server   >>"$LOG" 2>&1 || true
pkill -9 -f mcp-server     >>"$LOG" 2>&1 || true
pkill -9 -f service-watchdog.sh >>"$LOG" 2>&1 || true
# 旧品牌装在 ~/.lingxi-ai 下，脚本名跟现在一样（serve-permanent/proxy-server），上面几条
# 已经能杀到；这条按安装路径再兜一刀，覆盖旧版改过脚本名的情况。
pkill -9 -f "\.lingxi-ai/" >>"$LOG" 2>&1 || true

# 3. 删 LaunchAgent plist
if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  log "[OK] 删 $PLIST"
fi

# 3b. 删旧品牌 plist
for lp in "${LEGACY_PLISTS[@]}"; do
  if [ -f "$lp" ]; then
    rm -f "$lp"
    log "[OK] 删旧品牌 plist: $lp"
  fi
done

# 4. 删两个 Container 里的 publish.xml
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  pub="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons/publish.xml"
  if [ -f "$pub" ]; then
    # 修 T3：共享清单，只移除 anthony 条目，保留别家插件。
    # 旧品牌 lingxi-ai-* 条目也要一起摘掉，否则会被当成「别家插件」原样保留下来，
    # WPS 下次启动仍去连早已不存在的旧服务。见 docs/REBRAND.md。
    others="$(grep -i jspluginonline "$pub" 2>/dev/null | grep -vi lingxi-ai | grep -vi anthony-ai || true)"
    if [ -n "$others" ]; then
      {
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        printf '%s\n' '<jsplugins>'
        printf '%s\n' "$others"
        printf '%s\n' '</jsplugins>'
      } > "$pub"
      log "[OK] 保留其它插件，移除 anthony 条目: $pub"
    else
      rm -f "$pub"
      log "[OK] 删 $pub"
    fi
  fi
done

# 5. 删 ~/.anthony-ai(变体目录、服务脚本、日志)
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  log "[OK] 删 $TARGET"
fi

# 6. 删旧品牌用户级残留目录（升级场景）。系统级的
#    /Library/Application Support/LingxiAI 需要 root，由 installer-mac/uninstall-all.sh 负责。
for ld in "${LEGACY_HOME_DIRS[@]}" "${LEGACY_LOG_DIRS[@]}"; do
  # 防呆：路径必须在 $HOME 下且不等于 $HOME 本身
  case "$ld" in
    "$HOME"/?*) ;;
    *) continue ;;
  esac
  if [ -d "$ld" ]; then
    rm -rf "$ld"
    log "[OK] 删旧品牌残留: $ld"
  fi
done

log "==== pre-uninstall-mac 完成 ===="
exit 0