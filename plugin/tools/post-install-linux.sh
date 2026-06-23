#!/usr/bin/env bash
# 灵犀AI Linux 安装后脚本(用户上下文)
#
# 调用入口:
#   - tar.gz 绿色包:   install.sh 解压后直接 bash 调
#   - .deb:           debian/postinst 通过 sudo -u <real-user> bash 调
#   - 手动调试:        bash post-install-linux.sh [<INSTALL_DIR>]
#
# 工作:
#   1. 挑合适架构的内置 Node(linux-x64 / linux-arm64)
#   2. 生成 plugin-wps/-et/-wpp/-pdf 四份宿主变体到 ~/.lingxi-ai/
#   3. 拷服务脚本
#   4. 写 publish.xml 到所有已知的 WPS Linux jsaddons 路径(原生 / snap / flatpak)
#   5. 写 systemd --user 单元并 enable + start;若 systemd 不可用退到 ~/.config/autostart/.desktop
#   6. 探活端口
#
# 所有输出走日志: ~/.lingxi-ai/install.log

set -u

INSTALL_DIR="${1:-}"
if [ -z "$INSTALL_DIR" ]; then
  # 兜底:脚本如果被直接拷到 ~/.lingxi-ai/ 调用,自身找不到 plugin/runtime
  INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi

TARGET="$HOME/.lingxi-ai"
mkdir -p "$TARGET"
LOG="$TARGET/install.log"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2; }

{
echo
echo "==================================================="
echo " post-install-linux 启动 $(date '+%F %T')"
echo " INSTALL_DIR=$INSTALL_DIR"
echo " TARGET=$TARGET"
echo " HOME=$HOME USER=$USER UID=$(id -u)"
echo "==================================================="
} >>"$LOG" 2>&1

# ---- 0. 发行版/架构指纹(日志用,排错关键) ----
ARCH="$(uname -m)"
DISTRO_ID=""
DISTRO_NAME=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-}"
  DISTRO_NAME="${PRETTY_NAME:-$NAME}"
fi
log "[post-install] arch=$ARCH distro=$DISTRO_ID ($DISTRO_NAME)"

# ---- 1. 挑 Node ----
# 国产 CPU(loongarch64/sw_64/mips64el) Node.js 官方 dist 不出预编译,只能用系统 node。
# x86_64 + aarch64 优先用内置 node,缺失再退到系统 node。
NODE_DIR=""
NODE_FALLBACK_ONLY=0
case "$ARCH" in
  aarch64|arm64)
    NODE_DIR="$INSTALL_DIR/plugin/runtime/node-linux-arm64"
    ;;
  x86_64|amd64)
    NODE_DIR="$INSTALL_DIR/plugin/runtime/node-linux-x64"
    ;;
  loongarch64|loongarch|loong64)
    # 龙芯。Loongnix/统信 UOS 龙芯版/银河麒麟龙芯版
    log "[i] 国产架构 $ARCH,跳过内置 Node,直接用 PATH 上的 node(请确保系统已装 Node 18+)"
    NODE_FALLBACK_ONLY=1
    ;;
  mips64el|mips64)
    # 旧龙芯 3A/3B
    log "[i] 国产架构 $ARCH,跳过内置 Node,直接用 PATH 上的 node"
    NODE_FALLBACK_ONLY=1
    ;;
  sw_64|sw64)
    # 申威
    log "[i] 国产架构 $ARCH(申威),跳过内置 Node,直接用 PATH 上的 node"
    NODE_FALLBACK_ONLY=1
    ;;
  riscv64)
    log "[i] RISC-V 架构,跳过内置 Node,直接用 PATH 上的 node"
    NODE_FALLBACK_ONLY=1
    ;;
  *)
    log "[WARN] 未知架构: $ARCH,试试 PATH 上的 node"
    NODE_FALLBACK_ONLY=1
    ;;
esac

NODE_BIN=""
if [ "$NODE_FALLBACK_ONLY" = "0" ] && [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then
  NODE_BIN="$NODE_DIR/bin/node"
  # glibc 太老(银河麒麟 V10 早期 / CentOS 7)Node 22 跑不起来,run 一下验证
  if ! "$NODE_BIN" --version >/dev/null 2>&1; then
    log "[WARN] 内置 Node 在 $ARCH 上无法运行(可能 glibc 太老),退到 PATH 上的 node"
    log "       内置 Node 报错: $("$NODE_BIN" --version 2>&1 | head -n 3)"
    NODE_BIN=""
  fi
fi

if [ -z "$NODE_BIN" ]; then
  if ! command -v node >/dev/null 2>&1; then
    log "[X] 没找到 Node。请装 Node 18+ LTS:"
    log "    - Ubuntu/Debian/Deepin/UOS/openKylin: sudo apt install nodejs"
    log "    - openEuler/Anolis/银河麒麟服务器/中标麒麟: sudo dnf install nodejs 或 sudo yum install nodejs"
    log "    - 龙芯系统:从 Loongnix 软件源装,或自行下载 loongarch64 二进制"
    exit 1
  fi
  NODE_BIN="$(command -v node)"
fi
log "[post-install] 使用 Node: $NODE_BIN ($("$NODE_BIN" --version 2>&1 || echo '?'))"

# ---- 2. 停老服务(升级场景) ----
log "[post-install] 停老服务..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop lingxi-ai.service >>"$LOG" 2>&1 || true
  systemctl --user disable lingxi-ai.service >>"$LOG" 2>&1 || true
fi
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server    >>"$LOG" 2>&1 || true
sleep 1

# ---- 3. 生成四份宿主变体 ----
# 同 mac 思路:build-variants.js 会就地改 package.json,所以先复制到用户可写目录再跑
log "[post-install] 生成宿主变体到 $TARGET..."
PLUGIN_TMP="$TARGET/.plugin-build-tmp"
rm -rf "$PLUGIN_TMP"
cp -R "$INSTALL_DIR/plugin" "$PLUGIN_TMP"

(cd "$PLUGIN_TMP" && "$NODE_BIN" tools/build-variants.js --out "$TARGET") >>"$LOG" 2>&1
BUILD_RC=$?
rm -rf "$PLUGIN_TMP"

if [ $BUILD_RC -ne 0 ]; then
  log "[X] 生成宿主变体失败,详见 $LOG"
  exit 1
fi

# ---- 4. 拷服务脚本 ----
mkdir -p "$TARGET/tools"
cp "$INSTALL_DIR/plugin/tools/serve-permanent.js" "$TARGET/tools/serve-permanent.js"
cp "$INSTALL_DIR/plugin/tools/proxy-server.js"    "$TARGET/tools/proxy-server.js"
log "[post-install] 服务脚本已就位"

# ---- 5. 写 publish.xml 到所有已知 WPS Linux jsaddons 路径 ----
PUBLISH_XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>
</jsplugins>'

# WPS for Linux 在不同发行版/分发渠道下的 jsaddons 路径分布很散,挨个写一遍。
# 写多了不会出错(WPS 启动时只读它认得的那个);写少了「灵犀AI」标签就不显示。
PUBLISH_DIRS=(
  # 主流官方包(WPS for Linux 11.x deb/rpm) - Ubuntu/Debian/Fedora/openEuler 等
  "$HOME/.config/Kingsoft/Office6/jsaddons"

  # 国产 WPS 专业版常见路径(银河麒麟/统信 UOS/Deepin/中标麒麟自带)
  "$HOME/.config/wps-office/jsaddons"
  "$HOME/.config/wps/jsaddons"
  "$HOME/.kingsoft/office6/jsaddons"
  "$HOME/.kingsoft/Office6/jsaddons"

  # UOS 应用商店(linglong 包管理)
  "$HOME/.linglong/com.wps.office/data/.config/Kingsoft/Office6/jsaddons"

  # snap
  "$HOME/snap/wps-office/current/.config/Kingsoft/Office6/jsaddons"
  "$HOME/snap/wps-office-multilang/current/.config/Kingsoft/Office6/jsaddons"

  # flatpak
  "$HOME/.var/app/com.wps.Office/config/Kingsoft/Office6/jsaddons"
)
WROTE_ANY=0
for dir in "${PUBLISH_DIRS[@]}"; do
  parent="$(dirname "$dir")"
  if [ -d "$parent" ] || [ "$dir" = "$HOME/.config/Kingsoft/Office6/jsaddons" ]; then
    mkdir -p "$dir"
    printf '%s\n' "$PUBLISH_XML" > "$dir/publish.xml"
    log "[post-install] 写: $dir/publish.xml"
    WROTE_ANY=1
  fi
done
if [ "$WROTE_ANY" = "0" ]; then
  log "[WARN] 没找到任何 WPS 配置目录,写了默认 ~/.config/Kingsoft/Office6/jsaddons/publish.xml"
fi

# ---- 6. 写 systemd --user 单元并起来 ----
USE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  USE_SYSTEMD=1
fi

if [ "$USE_SYSTEMD" = "1" ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT="$UNIT_DIR/lingxi-ai.service"
  cat > "$UNIT" <<EOF
[Unit]
Description=Lingxi AI WPS plugin background server
After=default.target

[Service]
Type=simple
Environment=LINGXI_STATIC_PORT=3889
Environment=PROXY_PORT=3890
WorkingDirectory=$TARGET
ExecStart=$NODE_BIN $TARGET/tools/serve-permanent.js --root $TARGET
Restart=always
RestartSec=3
StandardOutput=append:$TARGET/server.log
StandardError=append:$TARGET/server.log

[Install]
WantedBy=default.target
EOF
  log "[post-install] systemd 单元: $UNIT"

  systemctl --user daemon-reload >>"$LOG" 2>&1 || true
  systemctl --user enable lingxi-ai.service >>"$LOG" 2>&1 || true
  if systemctl --user restart lingxi-ai.service >>"$LOG" 2>&1; then
    log "[post-install] systemctl --user start 成功"
  else
    log "[WARN] systemctl --user start 失败,见 $LOG"
  fi

  # loginctl enable-linger:用户没登录时也能跑(server 进程在后台保活)
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" >>"$LOG" 2>&1 || true
  fi
else
  # systemd 不可用:退到 XDG autostart .desktop + 立刻 nohup 启动一次
  log "[post-install] systemd --user 不可用,退到 ~/.config/autostart/"
  AUTOSTART_DIR="$HOME/.config/autostart"
  mkdir -p "$AUTOSTART_DIR"
  DESKTOP="$AUTOSTART_DIR/lingxi-ai.desktop"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Lingxi AI Server
Exec=$NODE_BIN $TARGET/tools/serve-permanent.js --root $TARGET
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
  log "[post-install] autostart 入口: $DESKTOP"

  # 立刻起一次(用户重启会话之前)
  ( cd "$TARGET" && LINGXI_STATIC_PORT=3889 PROXY_PORT=3890 \
    nohup "$NODE_BIN" "$TARGET/tools/serve-permanent.js" --root "$TARGET" \
      >>"$TARGET/server.log" 2>&1 & ) || log "[WARN] nohup 启动失败"
fi

# ---- 7. 探活 ----
sleep 3
if command -v nc >/dev/null 2>&1; then
  if nc -z 127.0.0.1 3889 2>/dev/null; then
    log "[OK] 3889 端口监听中,服务起来了"
  else
    log "[WARN] 3889 端口没监听 - server.log 末尾:"
    [ -f "$TARGET/server.log" ] && tail -n 40 "$TARGET/server.log" >>"$LOG" 2>&1
  fi
else
  # nc 不在:用 /dev/tcp(bash 内建)兜底
  if (echo > /dev/tcp/127.0.0.1/3889) >/dev/null 2>&1; then
    log "[OK] 3889 端口监听中"
  else
    log "[WARN] 3889 端口没监听 - server.log 末尾:"
    [ -f "$TARGET/server.log" ] && tail -n 40 "$TARGET/server.log" >>"$LOG" 2>&1
  fi
fi

# WPS 加载项路由探活
if command -v curl >/dev/null 2>&1; then
  for host in wps et wpp pdf; do
    for file in manifest.json ribbon.xml index.html; do
      url="http://127.0.0.1:3889/$host/$file"
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || echo 000)"
      if [ "$code" = "200" ]; then
        log "[OK] $url -> 200"
      else
        log "[X]  $url -> $code"
      fi
    done
  done
fi

log "[post-install] 完成"
exit 0
