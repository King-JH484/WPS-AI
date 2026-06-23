#!/usr/bin/env bash
# 灵犀AI Linux 卸载脚本(用户上下文)
#
# 调用入口:
#   - tar.gz 绿色包:  uninstall.sh 直接 bash 调
#   - .deb:          debian/prerm 通过 sudo -u <real-user> bash 调
#   - 手跑:          bash pre-uninstall-linux.sh
#
# 工作:
#   1. 停 + disable systemd --user 单元
#   2. 杀残留 node 进程
#   3. 删 systemd 单元 / autostart .desktop
#   4. 删所有已知 WPS Linux jsaddons 路径下的 publish.xml
#   5. 删 ~/.lingxi-ai

set -u

TARGET="$HOME/.lingxi-ai"
LOG="$TARGET/uninstall.log"

mkdir -p "$TARGET" 2>/dev/null || true

log() {
  if [ -d "$TARGET" ]; then
    echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2
  else
    echo "[$(date '+%F %T')] $*" >&2
  fi
}

log "==== pre-uninstall-linux 启动 ===="

# 1. 停 systemd --user 单元
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop lingxi-ai.service    >>"$LOG" 2>&1 || true
  systemctl --user disable lingxi-ai.service >>"$LOG" 2>&1 || true
  log "[OK] systemd 单元已 stop+disable"
fi

# 2. 杀残留 node 进程
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server    >>"$LOG" 2>&1 || true
sleep 1

# 3. 删 systemd 单元文件 / autostart 入口
UNIT="$HOME/.config/systemd/user/lingxi-ai.service"
if [ -f "$UNIT" ]; then
  rm -f "$UNIT"
  log "[OK] 删 $UNIT"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >>"$LOG" 2>&1 || true
fi

DESKTOP="$HOME/.config/autostart/lingxi-ai.desktop"
if [ -f "$DESKTOP" ]; then
  rm -f "$DESKTOP"
  log "[OK] 删 $DESKTOP"
fi

# 4. 删所有 WPS jsaddons 路径下的 publish.xml
# 跟 post-install-linux.sh 的 PUBLISH_DIRS 保持一致 - 改一个记得改两个
PUBLISH_DIRS=(
  "$HOME/.config/Kingsoft/Office6/jsaddons"
  "$HOME/.config/wps-office/jsaddons"
  "$HOME/.config/wps/jsaddons"
  "$HOME/.kingsoft/office6/jsaddons"
  "$HOME/.kingsoft/Office6/jsaddons"
  "$HOME/.linglong/com.wps.office/data/.config/Kingsoft/Office6/jsaddons"
  "$HOME/snap/wps-office/current/.config/Kingsoft/Office6/jsaddons"
  "$HOME/snap/wps-office-multilang/current/.config/Kingsoft/Office6/jsaddons"
  "$HOME/.var/app/com.wps.Office/config/Kingsoft/Office6/jsaddons"
)
for dir in "${PUBLISH_DIRS[@]}"; do
  pub="$dir/publish.xml"
  if [ -f "$pub" ]; then
    rm -f "$pub"
    log "[OK] 删 $pub"
  fi
done

# 5. 删 ~/.lingxi-ai(变体、服务脚本、日志)
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
  log "[OK] 删 $TARGET"
fi

log "==== pre-uninstall-linux 完成 ===="
exit 0
