#!/usr/bin/env bash
# 灵犀AI macOS 安装后脚本(用户上下文)
#
# 由 installer-mac/scripts/postinstall (root 上下文) 通过 sudo -u 调起。
# 也可以直接手跑做调试: bash post-install-mac.sh <INSTALL_DIR>
#
# 工作:
#   1. 挑合适架构的内置 Node
#   2. 生成 plugin-wps/-et/-wpp 三份宿主变体到 ~/.lingxi-ai/
#   3. 拷服务脚本
#   4. 写 publish.xml 到两个 WPS Container
#   5. 写 LaunchAgent plist 并 launchctl bootstrap 进 gui domain
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
echo " post-install-mac 启动 $(date '+%F %T')"
echo " INSTALL_DIR=$INSTALL_DIR"
echo " TARGET=$TARGET"
echo " HOME=$HOME USER=$USER UID=$(id -u)"
echo "==================================================="
} >>"$LOG" 2>&1

# ---- 1. 挑 Node ----
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  NODE_DIR="$INSTALL_DIR/plugin/runtime/node-darwin-arm64" ;;
  x86_64) NODE_DIR="$INSTALL_DIR/plugin/runtime/node-darwin-x64"   ;;
  *)
    log "[X] 不支持的架构: $ARCH"
    exit 1
    ;;
esac
NODE_BIN="$NODE_DIR/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  log "[WARN] 内置 Node 不在 $NODE_BIN,退到 PATH 上的 node"
  if ! command -v node >/dev/null 2>&1; then
    log "[X] 没找到 Node。请装 LTS: https://nodejs.org/zh-cn/"
    exit 1
  fi
  NODE_BIN="$(command -v node)"
fi
log "[post-install] 使用 Node: $NODE_BIN ($("$NODE_BIN" --version))"

# ---- 2. 停老服务(升级场景) ----
log "[post-install] 停老服务..."
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist" >>"$LOG" 2>&1 || true
launchctl unload "$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist" >>"$LOG" 2>&1 || true
pkill -9 -f serve-permanent >>"$LOG" 2>&1 || true
pkill -9 -f proxy-server   >>"$LOG" 2>&1 || true
sleep 1

# ---- 3. 生成三份宿主变体 ----
log "[post-install] 生成三份宿主变体到 $TARGET..."
(cd "$INSTALL_DIR/plugin" && "$NODE_BIN" tools/build-variants.js --out "$TARGET" --port 3889) >>"$LOG" 2>&1
if [ $? -ne 0 ]; then
  log "[X] 生成宿主变体失败,详见 $LOG"
  exit 1
fi

# ---- 4. 拷服务脚本 ----
mkdir -p "$TARGET/tools"
cp "$INSTALL_DIR/plugin/tools/serve-permanent.js" "$TARGET/tools/serve-permanent.js"
cp "$INSTALL_DIR/plugin/tools/proxy-server.js"   "$TARGET/tools/proxy-server.js"
log "[post-install] 服务脚本已就位"

# ---- 5. 写 publish.xml ----
PUBLISH_XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" debug="" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  debug="" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" debug="" enable="enable" install="null"/>
</jsplugins>'
for container in com.kingsoft.wpsoffice.mac com.kingsoft.wpsoffice.mac.global; do
  dir="$HOME/Library/Containers/$container/Data/.kingsoft/wps/jsaddons"
  mkdir -p "$dir"
  printf '%s\n' "$PUBLISH_XML" > "$dir/publish.xml"
  log "[post-install] 写: $dir/publish.xml"
done

# ---- 6. 写 LaunchAgent plist ----
mkdir -p "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/com.lingxi-ai.server.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lingxi-ai.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TARGET/tools/serve-permanent.js</string>
    <string>--root</string>
    <string>$TARGET</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LINGXI_STATIC_PORT</key>
    <string>3889</string>
    <key>PROXY_PORT</key>
    <string>3890</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$TARGET/server.log</string>
  <key>StandardErrorPath</key>
  <string>$TARGET/server.log</string>
  <key>WorkingDirectory</key>
  <string>$TARGET</string>
</dict>
</plist>
EOF
log "[post-install] LaunchAgent: $PLIST"

# ---- 7. 拉服务 ----
# 优先用 bootstrap(新 launchctl 写法,Mojave+);失败退到 load
if launchctl bootstrap "gui/$(id -u)" "$PLIST" >>"$LOG" 2>&1; then
  log "[post-install] launchctl bootstrap 成功"
else
  log "[post-install] bootstrap 失败,试 legacy load"
  launchctl load "$PLIST" >>"$LOG" 2>&1 || log "[WARN] launchctl load 也失败,需重新登录或重启"
fi

# ---- 8. 探活 ----
sleep 3
if nc -z 127.0.0.1 3889 2>/dev/null; then
  log "[OK] 3889 端口监听中,服务起来了"
else
  log "[WARN] 3889 端口没监听 - server.log 内容:"
  if [ -f "$TARGET/server.log" ]; then
    cat "$TARGET/server.log" >>"$LOG" 2>&1
  else
    log "(server.log 不存在,LaunchAgent 可能没起)"
  fi
fi

# WPS 加载项路由探活
for host in wps et wpp; do
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

log "[post-install] 完成"
exit 0
