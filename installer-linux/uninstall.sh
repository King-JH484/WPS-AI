#!/usr/bin/env bash
# 灵犀AI Linux 绿色包卸载入口(tar.gz 路径用)
#
# 用法:
#   bash uninstall.sh                       # 装在 ~/.local/share/lingxi-ai
#   sudo bash uninstall.sh                  # 装在 /opt/lingxi-ai
#   bash uninstall.sh --prefix /custom/dir  # 自定义路径
#   bash uninstall.sh --keep-files          # 只停服务/清 publish.xml,不删安装目录
#
# .deb 装的请用: sudo apt remove lingxi-ai   (维护者脚本会做同样的事)

set -u

PREFIX=""
KEEP_FILES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)     PREFIX="$2"; shift 2 ;;
    --keep-files) KEEP_FILES=1; shift ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | head -n -1
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [ -z "$PREFIX" ]; then
  # 顺序探测常见安装路径
  for cand in /opt/lingxi-ai "$HOME/.local/share/lingxi-ai"; do
    if [ -d "$cand" ]; then PREFIX="$cand"; break; fi
  done
fi

TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-$HOME}"
TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null || id -u)"

echo "============================================="
echo "  灵犀AI Linux 卸载"
echo "============================================="
echo "  Prefix:       ${PREFIX:-<没找到,只清用户数据>}"
echo "  Target user:  $TARGET_USER (uid=$TARGET_UID)"
echo "============================================="

# 1. 跑用户态清理(停服务、删 publish.xml、删 ~/.lingxi-ai)
PRE_UNINSTALL=""
if [ -n "$PREFIX" ] && [ -f "$PREFIX/plugin/tools/pre-uninstall-linux.sh" ]; then
  PRE_UNINSTALL="$PREFIX/plugin/tools/pre-uninstall-linux.sh"
elif [ -f "$(cd "$(dirname "$0")" && pwd)/plugin/tools/pre-uninstall-linux.sh" ]; then
  # 还没装(从 tarball 解压目录直接调)
  PRE_UNINSTALL="$(cd "$(dirname "$0")" && pwd)/plugin/tools/pre-uninstall-linux.sh"
fi

if [ -n "$PRE_UNINSTALL" ]; then
  echo "[1/2] 跑用户态清理: $PRE_UNINSTALL"
  if [ "$(id -u)" = "0" ] && [ "$TARGET_USER" != "root" ]; then
    sudo -u "$TARGET_USER" -H \
      HOME="$TARGET_HOME" USER="$TARGET_USER" \
      XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
      bash "$PRE_UNINSTALL" || true
  else
    bash "$PRE_UNINSTALL" || true
  fi
else
  echo "[1/2] [WARN] 没找到 pre-uninstall-linux.sh,跳过用户态清理"
fi

# 2. 删安装目录
if [ "$KEEP_FILES" = "1" ]; then
  echo "[2/2] --keep-files: 保留 $PREFIX"
elif [ -n "$PREFIX" ] && [ -d "$PREFIX" ]; then
  echo "[2/2] 删 $PREFIX ..."
  if [ "$(id -u)" = "0" ] || [ -w "$PREFIX" ]; then
    rm -rf "$PREFIX"
  else
    echo "  [WARN] 没权限删 $PREFIX,需要 sudo bash uninstall.sh"
  fi
else
  echo "[2/2] 安装目录已不在,跳过"
fi

echo
echo "============================================="
echo "  卸载完成"
echo "============================================="
