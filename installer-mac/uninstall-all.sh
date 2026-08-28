#!/usr/bin/env bash
# Anthony AI 一键卸载脚本
#
# 由 /Applications/Anthony AI 卸载.app 在 admin 上下文调起(root 身份跑)。
# 也支持手跑做调试: sudo TARGET_USER=$(whoami) TARGET_HOME=$HOME TARGET_UID=$(id -u) \
#                         bash uninstall-all.sh
#
# 必须由 AppleScript 显式传入 TARGET_USER/TARGET_HOME/TARGET_UID,因为 admin 上下文
# 下 $HOME=/var/root、$USER=root,这些都不再指向真正的用户。
# SELF_APP 是 .app bundle 的绝对路径,最后一步用来删自己。

set -u

# 兜底:没传环境变量就从 GUI console 推断(应付手跑场景)
TARGET_USER="${TARGET_USER:-$(stat -f "%Su" /dev/console)}"
TARGET_HOME="${TARGET_HOME:-$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
TARGET_UID="${TARGET_UID:-$(id -u "$TARGET_USER")}"

# 修 M1：本脚本以 root 身份跑且随后 rm -rf "$TARGET_HOME/..."。preinstall/postinstall 都做了
# 空值/root 守卫，唯独这个真正执行删除的脚本漏了。若 dscl 读失败 → TARGET_HOME 空 →
# rm -rf "/.anthony-ai"、误删系统级 /Library/LaunchAgents 与 /Library/Containers。这里补齐守卫。
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ] || [ -z "$TARGET_HOME" ] || [ ! -d "$TARGET_HOME" ]; then
  echo "[uninstall] [ERROR] 无法确定真实用户/家目录 (user='$TARGET_USER' home='$TARGET_HOME')，已中止以免误删系统路径。" >&2
  echo "[uninstall] 请手动运行：sudo TARGET_USER=\$(whoami) TARGET_HOME=\$HOME TARGET_UID=\$(id -u) bash \"$0\"" >&2
  exit 1
fi

echo "==== Anthony AI 卸载 $(date '+%F %T') ===="
echo "用户: $TARGET_USER  uid: $TARGET_UID  home: $TARGET_HOME"
echo

PLIST="$TARGET_HOME/Library/LaunchAgents/com.anthony-ai.server.plist"

# ---- 旧品牌（灵犀AI / lingxi-ai）残留 ----
# 从旧版升级上来的机器上这些东西还在：LaunchAgent 会在登录时把旧服务拉起来占住
# 3889/3890，pkgutil receipt 会让 macOS 一直认为旧 pkg 是"已安装"。
# 这些字面量是历史事实，**不参与**品牌改名替换，见 docs/REBRAND.md「受保护字面量」。
LEGACY_PLIST="$TARGET_HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
LEGACY_LABEL="com.lingxi-ai.server"
LEGACY_USER_DIRS=(
  "$TARGET_HOME/.lingxi-ai"
  "$TARGET_HOME/Library/Logs/lingxi-ai"
)
LEGACY_SYSTEM_DIRS=(
  "/Library/Application Support/LingxiAI"
)
LEGACY_PKG_IDS=(
  "com.lingxi-ai.installer"
)
LEGACY_APPS=(
  "/Applications/灵犀AI 卸载.app"
)

# 1. 停 LaunchAgent
# root 跑 bootout 指定 gui domain 即可,不需要 sudo -u
echo "[1/7] 停 LaunchAgent..."
launchctl bootout "gui/$TARGET_UID" "$PLIST" 2>/dev/null || true
# 兜底老写法
sudo -u "$TARGET_USER" launchctl unload "$PLIST" 2>/dev/null || true

# 1b. 停旧品牌 LaunchAgent（升级场景）
launchctl bootout "gui/$TARGET_UID" "$LEGACY_PLIST" 2>/dev/null || true
launchctl bootout "gui/$TARGET_UID/$LEGACY_LABEL" 2>/dev/null || true
sudo -u "$TARGET_USER" launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
sudo -u "$TARGET_USER" launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LEGACY_PLIST"

# 2. 杀残留 node 进程(用户进程,sudo -u)
echo "[2/7] 杀残留 node 进程..."
sudo -u "$TARGET_USER" pkill -9 -f serve-permanent 2>/dev/null || true
sudo -u "$TARGET_USER" pkill -9 -f proxy-server   2>/dev/null || true
sudo -u "$TARGET_USER" pkill -9 -f mcp-server     2>/dev/null || true
# 旧品牌装在 ~/.lingxi-ai 下，按安装路径再兜一刀
sudo -u "$TARGET_USER" pkill -9 -f "\.lingxi-ai/" 2>/dev/null || true
sleep 1

# 3. 删 LaunchAgent plist
echo "[3/7] 删 LaunchAgent plist..."
rm -f "$PLIST"

# 4. 两个 WPS Container 的 publish.xml
echo "[4/7] 删 WPS publish.xml..."
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  pub="$TARGET_HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons/publish.xml"
  if [ -f "$pub" ]; then
    # 修 W1（mac 侧同理）：publish.xml 是 WPS 共享插件清单，只移除 anthony 条目，保留别家插件。
    other="$(grep -i jspluginonline "$pub" 2>/dev/null | grep -vi lingxi-ai | grep -vi anthony-ai || true)"
    if [ -n "$other" ]; then
      printf '%s\n' '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' '<jsplugins>' "$other" '</jsplugins>' > "$pub"
      echo "  保留其它插件，移除 anthony 条目: $pub"
    else
      rm -f "$pub"
      echo "  删 $pub"
    fi
  fi
done

# 5. 用户数据 + 系统安装目录
echo "[5/7] 删 ~/.anthony-ai 和 /Library/Application Support/AnthonyAI..."
rm -rf "$TARGET_HOME/.anthony-ai"
rm -rf "/Library/Application Support/AnthonyAI"

# 5b. 旧品牌数据目录（用户级 + 系统级）。本脚本是 root 上下文，是唯一能删
#     /Library/Application Support/LingxiAI 的卸载入口。
for ld in "${LEGACY_USER_DIRS[@]}"; do
  case "$ld" in "$TARGET_HOME"/?*) ;; *) continue ;; esac
  if [ -d "$ld" ]; then rm -rf "$ld" && echo "  删旧品牌残留 $ld"; fi
done
for ld in "${LEGACY_SYSTEM_DIRS[@]}"; do
  if [ -d "$ld" ]; then rm -rf "$ld" && echo "  删旧品牌系统目录 $ld"; fi
done
for la in "${LEGACY_APPS[@]}"; do
  if [ -d "$la" ]; then rm -rf "$la" && echo "  删旧品牌 App $la"; fi
done

# 6. pkgutil receipt(让 macOS 不再认为这个 pkg 是已装的)
echo "[6/7] pkgutil --forget com.anthony-ai.installer..."  # 步骤总数 7（含删自身）
pkgutil --forget com.anthony-ai.installer 2>/dev/null || true
# 旧品牌 receipt 一并 forget，否则 macOS 仍认为旧 pkg 已装，重装旧版会被跳过
for lp in "${LEGACY_PKG_IDS[@]}"; do
  pkgutil --forget "$lp" 2>/dev/null || true
done

# 7. 删 .app 自身。macOS 允许 rm 正在跑的 bundle:文件被 unlink,但 applet
#    的 Mach-O image 已 mmap 进内存,进程继续跑到 exit。AppleScript 末尾的
#    display dialog 只用系统服务,不读 .app 自己的资源,所以仍能正常弹窗。
#
#    bash 短脚本几乎一定一次性读进内存,删自己所在路径不会中断后续命令,
#    但保险起见把这一步放最后(下面就只剩 exit)。
echo "[7/7] 删 .app 自身..."
SELF_APP_DEFAULT="/Applications/Anthony AI 卸载.app"
APP_TO_DELETE="${SELF_APP:-$SELF_APP_DEFAULT}"
if [ -d "$APP_TO_DELETE" ]; then
  rm -rf "$APP_TO_DELETE" && echo "  删 $APP_TO_DELETE" || echo "  [WARN] 删 .app 失败,请手动拖到废纸篓"
fi

echo
echo "==== 卸载完成 ===="
exit 0
