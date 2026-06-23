#!/usr/bin/env bash
# 灵犀AI Linux 打包脚本: 产出
#   - dist/lingxi-ai-<version>-linux-<arch>.tar.gz   绿色包,带 install.sh/uninstall.sh,所有发行版通用
#   - dist/lingxi-ai_<version>_<deb-arch>.deb        Debian/Ubuntu/Deepin/UOS/openKylin/银河麒麟桌面版
#   - dist/lingxi-ai-<version>-1.<rpm-arch>.rpm      openEuler/Anolis/Fedora/RHEL/银河麒麟服务器/中标麒麟
#
# 流程:
#   1. 准备内置 Node(plugin/runtime/node-linux-<arch>)
#   2. Staging: plugin/ + post-install-linux.sh + pre-uninstall-linux.sh + install.sh + uninstall.sh
#   3. 按 --format 产 tar.gz / deb / rpm
#
# 用法:
#   cd installer-linux
#   bash build.sh                              # 默认 x64,产 tar+deb+rpm(有什么工具就产什么)
#   bash build.sh --arch arm64                 # arm64 (鲲鹏/飞腾)
#   bash build.sh --format tar                 # 只产 tar.gz
#   bash build.sh --format deb,rpm             # 只产 deb 和 rpm
#   bash build.sh --version 1.3.0
#
# 国产架构(loongarch64/sw_64/mips64el):
#   - tar.gz 仍可用,但不会带内置 node(Node.js 官方 dist 不出预编译)
#   - 安装时 post-install-linux.sh 会自动退到系统 PATH 上的 node
#   - 用 --arch native --no-bundle-node 跳过内置 node 下载步骤
#
# 必须在 Linux 上跑(或 macOS + GNU coreutils + dpkg/rpm; Windows 上用 WSL)。

set -euo pipefail

# ---- 参数 ----
VERSION=""
ARCH="x64"
FORMAT="all"        # tar, deb, rpm, all, 或逗号分隔组合
BUNDLE_NODE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version)      VERSION="$2"; shift 2 ;;
    --arch)         ARCH="$2"; shift 2 ;;
    --format)       FORMAT="$2"; shift 2 ;;
    --skip-deb)     FORMAT="${FORMAT//deb,/}"; FORMAT="${FORMAT//,deb/}"; [ "$FORMAT" = "deb" ] && FORMAT="tar"; shift ;;
    --skip-rpm)     FORMAT="${FORMAT//rpm,/}"; FORMAT="${FORMAT//,rpm/}"; [ "$FORMAT" = "rpm" ] && FORMAT="tar"; shift ;;
    --no-bundle-node) BUNDLE_NODE=0; shift ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | head -n -1
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# format 展开
WANT_TAR=0; WANT_DEB=0; WANT_RPM=0
case "$FORMAT" in
  all) WANT_TAR=1; WANT_DEB=1; WANT_RPM=1 ;;
  *)
    IFS=',' read -ra FMTS <<< "$FORMAT"
    for f in "${FMTS[@]}"; do
      case "$f" in
        tar|tarball|tgz) WANT_TAR=1 ;;
        deb)             WANT_DEB=1 ;;
        rpm)             WANT_RPM=1 ;;
        *) echo "未知 --format: $f (支持 tar/deb/rpm/all)"; exit 1 ;;
      esac
    done
    ;;
esac

# ---- 路径 ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"
WORK_DIR="$SCRIPT_DIR/build"
STAGING="$WORK_DIR/staging"

PKG_NAME="lingxi-ai"

# ---- 架构归一化 ----
# Linux 包管理器命名很乱:同一个 ARM64 在 deb 叫 arm64,在 rpm 叫 aarch64,在 node dist 叫 arm64
case "$ARCH" in
  x64|amd64|x86_64)
    ARCH_NORM="x64"
    DEB_ARCH="amd64"
    RPM_ARCH="x86_64"
    NODE_DIR_NAME="node-linux-x64"
    ;;
  arm64|aarch64)
    ARCH_NORM="arm64"
    DEB_ARCH="arm64"
    RPM_ARCH="aarch64"
    NODE_DIR_NAME="node-linux-arm64"
    ;;
  loongarch64|loong64)
    # 龙芯(Loongnix/UOS 龙芯版/麒麟龙芯版)
    ARCH_NORM="loongarch64"
    DEB_ARCH="loongarch64"
    RPM_ARCH="loongarch64"
    NODE_DIR_NAME=""        # 不带内置 node
    BUNDLE_NODE=0
    echo "[i] 龙芯架构: 不打包内置 Node,安装时依赖系统 node 18+"
    ;;
  sw_64|sw64)
    ARCH_NORM="sw_64"
    DEB_ARCH="sw_64"
    RPM_ARCH="sw_64"
    NODE_DIR_NAME=""
    BUNDLE_NODE=0
    echo "[i] 申威架构: 不打包内置 Node,安装时依赖系统 node 18+"
    ;;
  mips64el|mips64)
    ARCH_NORM="mips64el"
    DEB_ARCH="mips64el"
    RPM_ARCH="mips64el"
    NODE_DIR_NAME=""
    BUNDLE_NODE=0
    echo "[i] 旧龙芯 mips64el: 不打包内置 Node,安装时依赖系统 node 18+"
    ;;
  *)
    echo "[X] 不支持的架构: $ARCH (允许 x64/arm64/loongarch64/sw_64/mips64el)"
    exit 1
    ;;
esac

# 从 plugin/package.json 拿 version
if [ -z "$VERSION" ]; then
  if command -v node >/dev/null 2>&1; then
    VERSION="$(node -p "require('$PLUGIN_DIR/package.json').version" 2>/dev/null || echo "")"
  fi
  if [ -z "$VERSION" ]; then
    VERSION="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$PLUGIN_DIR/package.json" | head -n 1)"
  fi
  VERSION="${VERSION:-0.0.0}"
fi

TARBALL_NAME="${PKG_NAME}-${VERSION}-linux-${ARCH_NORM}.tar.gz"
DEB_NAME="${PKG_NAME}_${VERSION}_${DEB_ARCH}.deb"
RPM_NAME="${PKG_NAME}-${VERSION}-1.${RPM_ARCH}.rpm"

echo "============================================="
echo "  灵犀AI Linux Installer Build"
echo "============================================="
echo "  Version:     $VERSION"
echo "  Arch:        $ARCH_NORM (deb=$DEB_ARCH rpm=$RPM_ARCH)"
echo "  Bundle Node: $([ "$BUNDLE_NODE" = "1" ] && echo "yes ($NODE_DIR_NAME)" || echo "no (用系统 node)")"
echo "  Formats:     $([ "$WANT_TAR" = "1" ] && echo -n "tar ")$([ "$WANT_DEB" = "1" ] && echo -n "deb ")$([ "$WANT_RPM" = "1" ] && echo -n "rpm")"
echo "  Output:"
[ "$WANT_TAR" = "1" ] && echo "    $DIST_DIR/$TARBALL_NAME"
[ "$WANT_DEB" = "1" ] && echo "    $DIST_DIR/$DEB_NAME (若有 dpkg-deb)"
[ "$WANT_RPM" = "1" ] && echo "    $DIST_DIR/$RPM_NAME (若有 rpmbuild)"
echo "============================================="

# ---- 1. 准备 Node 运行时 ----
if [ "$BUNDLE_NODE" = "1" ]; then
  echo
  echo "[1/4] 准备内置 Node 运行时($NODE_DIR_NAME)..."
  NODE_BIN="$PLUGIN_DIR/runtime/$NODE_DIR_NAME/bin/node"
  if [ ! -f "$NODE_BIN" ]; then
    echo "  Linux 版 node 不在,跑 bundle-node.js 下载..."
    if ! command -v node >/dev/null 2>&1; then
      echo "[X] 当前机器没装 node,无法跑 bundle-node.js"
      echo "    先装 Node LTS 用来跑构建工具,再重试"
      exit 1
    fi
    ( cd "$PLUGIN_DIR" && node tools/bundle-node.js ) || {
      echo "[X] bundle-node.js 失败,看上面输出"
      exit 1
    }
  fi
  if [ ! -f "$NODE_BIN" ]; then
    echo "[X] 还是没找到 $NODE_BIN,手动跑: cd plugin && node tools/bundle-node.js --all"
    exit 1
  fi
  echo "  [OK] $NODE_BIN"
else
  echo
  echo "[1/4] 跳过内置 Node 打包($ARCH_NORM 走系统 node)"
fi

# ---- 2. Staging ----
echo
echo "[2/4] 准备 staging 目录..."
rm -rf "$WORK_DIR"
mkdir -p "$STAGING/plugin"

# 排除其他平台的 runtime,只留当前 linux 架构
RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='dist*'
  --exclude='.DS_Store'
  --exclude='__MACOSX'
  --exclude='.git'
  --exclude='install-windows.bat'
  --exclude='install-permanent-windows.bat'
  --exclude='uninstall-permanent-windows.bat'
  --exclude='start-*.bat'
  --exclude='runtime/node-win-x64'
  --exclude='runtime/node-darwin-x64'
  --exclude='runtime/node-darwin-arm64'
)
# 只留当前架构的 linux node;其他全排除
for other in node-linux-x64 node-linux-arm64; do
  if [ "$other" != "$NODE_DIR_NAME" ]; then
    RSYNC_EXCLUDES+=(--exclude="runtime/$other")
  fi
done
if [ "$BUNDLE_NODE" = "0" ]; then
  # 国产架构:整个 runtime 不要
  RSYNC_EXCLUDES+=(--exclude='runtime/node-linux-x64')
  RSYNC_EXCLUDES+=(--exclude='runtime/node-linux-arm64')
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a "${RSYNC_EXCLUDES[@]}" "$PLUGIN_DIR/" "$STAGING/plugin/"
else
  # 退路:tar(rsync 在精简 docker 镜像可能没有)
  TAR_EXCLUDES=()
  for x in "${RSYNC_EXCLUDES[@]}"; do
    case "$x" in --exclude=*) TAR_EXCLUDES+=("--exclude=${x#--exclude=}") ;; esac
  done
  ( cd "$PLUGIN_DIR" && tar "${TAR_EXCLUDES[@]}" -cf - . ) | ( cd "$STAGING/plugin" && tar -xf - )
fi

# README / INSTALL
cp "$ROOT_DIR/README.md"  "$STAGING/" 2>/dev/null || true
cp "$ROOT_DIR/INSTALL.md" "$STAGING/" 2>/dev/null || true

# 可执行位
chmod +x "$STAGING/plugin/tools/"*.sh 2>/dev/null || true
[ -n "$NODE_DIR_NAME" ] && chmod +x "$STAGING/plugin/runtime/$NODE_DIR_NAME/bin/node" 2>/dev/null || true

# tar.gz 的入口
cp "$SCRIPT_DIR/install.sh"   "$STAGING/install.sh"
cp "$SCRIPT_DIR/uninstall.sh" "$STAGING/uninstall.sh"
chmod +x "$STAGING/install.sh" "$STAGING/uninstall.sh"

STAGING_SIZE=$(du -sh "$STAGING" | awk '{print $1}')
echo "  Staging 大小: $STAGING_SIZE"

# ---- 3. tar.gz ----
mkdir -p "$DIST_DIR"
TARBALL_PATH="$DIST_DIR/$TARBALL_NAME"

if [ "$WANT_TAR" = "1" ]; then
  echo
  echo "[3/4] 打 tar.gz..."
  rm -f "$TARBALL_PATH"

  TOP_DIR="${PKG_NAME}-${VERSION}"
  TOP_STAGING="$WORK_DIR/$TOP_DIR"
  cp -a "$STAGING" "$TOP_STAGING"

  ( cd "$WORK_DIR" && tar -czf "$TARBALL_PATH" "$TOP_DIR" )
  rm -rf "$TOP_STAGING"
  TARBALL_SIZE=$(du -sh "$TARBALL_PATH" | awk '{print $1}')
  echo "  [OK] $TARBALL_PATH ($TARBALL_SIZE)"
else
  echo
  echo "[3/4] 跳过 tar.gz(--format 未包含 tar)"
fi

# ---- 4. .deb + .rpm ----
DEB_PATH="$DIST_DIR/$DEB_NAME"
RPM_PATH="$DIST_DIR/$RPM_NAME"

# .deb
if [ "$WANT_DEB" = "1" ]; then
  if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo
    echo "[4a]  没找到 dpkg-deb,跳过 .deb"
    echo "      Ubuntu/Debian: sudo apt install dpkg"
    echo "      Fedora/RHEL:   sudo dnf install dpkg"
    echo "      Mac:           brew install dpkg"
  else
    echo
    echo "[4a]  打 .deb..."

    DEB_ROOT="$WORK_DIR/deb-root"
    rm -rf "$DEB_ROOT"
    mkdir -p "$DEB_ROOT/DEBIAN"
    mkdir -p "$DEB_ROOT/opt/lingxi-ai"

    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude='install.sh' --exclude='uninstall.sh' "$STAGING/" "$DEB_ROOT/opt/lingxi-ai/"
    else
      ( cd "$STAGING" && tar --exclude='install.sh' --exclude='uninstall.sh' -cf - . ) \
        | ( cd "$DEB_ROOT/opt/lingxi-ai" && tar -xf - )
    fi

    INSTALLED_SIZE_KB=$(du -sk "$DEB_ROOT/opt/lingxi-ai" | awk '{print $1}')

    cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $VERSION
Section: utils
Priority: optional
Architecture: $DEB_ARCH
Maintainer: lingxi-ai <noreply@lingxi-ai.local>
Installed-Size: $INSTALLED_SIZE_KB
Depends: bash, coreutils
Recommends: systemd, curl
Homepage: https://github.com/lewis-hui1202/WPS-AI
Description: Lingxi AI plugin for WPS Office (Linux)
 灵犀AI WPS 插件,运行本地后台服务给 WPS 加载项调用,
 安装后自动注册 jsaddons 并通过 systemd --user 单元保活。
 .
 支持 Ubuntu/Debian/Deepin/统信 UOS/银河麒麟桌面版/openKylin。
EOF

    cp "$SCRIPT_DIR/debian/postinst" "$DEB_ROOT/DEBIAN/postinst"
    cp "$SCRIPT_DIR/debian/prerm"    "$DEB_ROOT/DEBIAN/prerm"
    chmod 0755 "$DEB_ROOT/DEBIAN/postinst" "$DEB_ROOT/DEBIAN/prerm"

    rm -f "$DEB_PATH"
    dpkg-deb --root-owner-group --build "$DEB_ROOT" "$DEB_PATH"
    DEB_SIZE=$(du -sh "$DEB_PATH" | awk '{print $1}')
    echo "  [OK] $DEB_PATH ($DEB_SIZE)"
  fi
fi

# .rpm
if [ "$WANT_RPM" = "1" ]; then
  if ! command -v rpmbuild >/dev/null 2>&1; then
    echo
    echo "[4b]  没找到 rpmbuild,跳过 .rpm"
    echo "      openEuler/Anolis/Fedora/RHEL: sudo dnf install rpm-build"
    echo "      Ubuntu/Debian:                 sudo apt install rpm"
    echo "      Mac:                           brew install rpm"
  else
    echo
    echo "[4b]  打 .rpm..."

    RPM_TOP="$WORK_DIR/rpmbuild"
    rm -rf "$RPM_TOP"
    mkdir -p "$RPM_TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

    # SOURCES: payload tarball - lingxi-ai-payload/opt/lingxi-ai/...
    PAYLOAD_DIR="$WORK_DIR/lingxi-ai-payload"
    rm -rf "$PAYLOAD_DIR"
    mkdir -p "$PAYLOAD_DIR/opt/lingxi-ai"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude='install.sh' --exclude='uninstall.sh' "$STAGING/" "$PAYLOAD_DIR/opt/lingxi-ai/"
    else
      ( cd "$STAGING" && tar --exclude='install.sh' --exclude='uninstall.sh' -cf - . ) \
        | ( cd "$PAYLOAD_DIR/opt/lingxi-ai" && tar -xf - )
    fi
    ( cd "$WORK_DIR" && tar -czf "$RPM_TOP/SOURCES/lingxi-ai-payload-$VERSION.tar.gz" lingxi-ai-payload )

    cp "$SCRIPT_DIR/rpm/lingxi-ai.spec" "$RPM_TOP/SPECS/lingxi-ai.spec"

    # Mac 上 brew rpm 的 rpmrc 默认只把 Darwin 当兼容架构，--target / --define 都
    # 改不了这一层判断 → 报 "no compatible architectures found"。
    # 写一份临时 rpmrc 包住系统 rpmrc 再追加 Linux 架构兼容声明，--rcfile 指过去。
    RPMRC_TMP="$RPM_TOP/rpmrc.linux"
    SYSTEM_RPMRC=""
    # rpm 默认 rcfile 列表：rpmbuild --showrc | head -2 通常会带出来
    # 兜底直接探常见路径（brew / Linux）
    for cand in \
      "$(brew --prefix rpm 2>/dev/null)/lib/rpm/rpmrc" \
      "/usr/local/lib/rpm/rpmrc" \
      "/opt/homebrew/lib/rpm/rpmrc" \
      "/usr/lib/rpm/rpmrc"; do
      if [ -n "$cand" ] && [ -f "$cand" ]; then SYSTEM_RPMRC="$cand"; break; fi
    done
    {
      [ -n "$SYSTEM_RPMRC" ] && echo "include: $SYSTEM_RPMRC"
      # 追加 Linux 架构兼容声明 —— 让 rpmbuild 在 Mac 上也认 x86_64 / aarch64 为合法 build target
      cat <<'RC'
arch_canon: x86_64: x86_64 1
arch_canon: amd64:  x86_64 1
arch_canon: aarch64: aarch64 2
arch_canon: arm64:  aarch64 2

buildarchtranslate: x86_64: x86_64
buildarchtranslate: amd64:  x86_64
buildarchtranslate: aarch64: aarch64
buildarchtranslate: arm64:  aarch64

arch_compat: x86_64: noarch
arch_compat: aarch64: noarch

buildarch_compat: x86_64: noarch
buildarch_compat: aarch64: noarch

os_canon: linux: Linux 1
RC
    } > "$RPMRC_TMP"
    echo "  [4b] 用临时 rpmrc 加 Linux 架构兼容声明: $RPMRC_TMP"

    rpmbuild -bb "$RPM_TOP/SPECS/lingxi-ai.spec" \
      --rcfile "$RPMRC_TMP" \
      --define "_topdir $RPM_TOP" \
      --define "version $VERSION" \
      --define "buildarch $RPM_ARCH" \
      --define "_target_os linux" \
      --define "_arch $RPM_ARCH" \
      --define "_build_arch $RPM_ARCH" \
      --define "_host_cpu $RPM_ARCH" \
      --target "${RPM_ARCH}-linux-gnu" \
      || { echo "[X] rpmbuild 失败"; exit 1; }

    # rpmbuild 输出在 RPMS/<arch>/
    BUILT_RPM="$(find "$RPM_TOP/RPMS" -name '*.rpm' | head -n 1)"
    if [ -z "$BUILT_RPM" ]; then
      echo "[X] rpmbuild 跑完没找到 rpm 产物"
      exit 1
    fi
    rm -f "$RPM_PATH"
    cp "$BUILT_RPM" "$RPM_PATH"
    RPM_SIZE=$(du -sh "$RPM_PATH" | awk '{print $1}')
    echo "  [OK] $RPM_PATH ($RPM_SIZE)"
  fi
fi

# 清 staging(保留 dist/)
rm -rf "$WORK_DIR"

echo
echo "============================================="
echo "  打包完成 🎉"
echo "============================================="
[ -f "$TARBALL_PATH" ] && echo "  tar.gz: $TARBALL_PATH"
[ -f "$DEB_PATH" ]     && echo "  deb:    $DEB_PATH"
[ -f "$RPM_PATH" ]     && echo "  rpm:    $RPM_PATH"
echo
echo "  本地测试:"
[ -f "$TARBALL_PATH" ] && {
  echo "    # tarball(任意发行版):"
  echo "    tar -xzf '$TARBALL_PATH' && cd ${PKG_NAME}-${VERSION} && bash install.sh"
  echo
}
[ -f "$DEB_PATH" ] && {
  echo "    # Ubuntu/Debian/Deepin/UOS/银河麒麟桌面版:"
  echo "    sudo apt install '$DEB_PATH'"
  echo
}
[ -f "$RPM_PATH" ] && {
  echo "    # openEuler/Anolis/Fedora/RHEL/银河麒麟服务器/中标麒麟:"
  echo "    sudo dnf install '$RPM_PATH'   # 或 sudo yum install ..."
  echo
}
echo "============================================="
