# 灵犀AI macOS Installer

产出 `lingxi-ai-<version>-mac.dmg`，包内含一个 `.pkg`，双击走系统安装向导。和 Windows 端的 Inno Setup 流程对齐。

## 文件清单

```
installer-mac/
├── build-dmg.sh              主构建脚本（必须在 macOS 上跑）
├── distribution.xml          productbuild 的 GUI 定义
├── uninstaller.applescript   一键卸载工具源码（osacompile 编成 .app）
├── uninstall-all.sh          .app 在 admin 上下文调起的清理脚本
├── scripts/
│   ├── preinstall            pkg 装文件前 —— stop 旧 LaunchAgent
│   └── postinstall           pkg 装完文件 —— sudo -u $user 调用真正安装逻辑
└── resources/
    ├── welcome.html          安装向导欢迎页
    └── conclusion.html       安装向导完成页
```

真正的安装/卸载逻辑：

- [plugin/tools/post-install-mac.sh](../plugin/tools/post-install-mac.sh) —— **安装**用户上下文：生成变体 / 写 publish.xml / 起 LaunchAgent
- [plugin/tools/pre-uninstall-mac.sh](../plugin/tools/pre-uninstall-mac.sh) —— 留给手动 `.sh` 安装方式的轻量卸载（停服务、清 publish.xml、删 `~/.lingxi-ai`，不动系统目录）
- [uninstall-all.sh](uninstall-all.sh) —— **dmg 卸载**：覆盖全部清理（用户域 + 系统域），由 `灵犀AI 卸载.app` 升权后调用

## 怎么打包

**前提**：必须在 macOS 上跑（pkgbuild/productbuild/hdiutil 都是 Mac 自带）。最低 macOS 10.15。

```bash
cd installer-mac
bash build-dmg.sh
```

第一次跑会自动调 `node ../plugin/tools/bundle-node.js --all` 下载 darwin-x64 + darwin-arm64 两份 Node 运行时（合起来 ~80MB，进 dmg 后压缩到 ~35MB）。已经下过就跳过。

产出：

- `dist/lingxi-ai-<version>-mac.dmg` —— 给用户的
- `dist/lingxi-ai-<version>.pkg` —— 同一个 pkg 单独丢出来，MDM/CI 部署用

## 安装时发生了什么

按 pkg 标准时序：

1. **preinstall（root）** —— 用 `stat -f "%Su" /dev/console` 找出 GUI 用户，`sudo -u` 该用户停老 LaunchAgent + 杀残留 node 进程。升级场景必备。
2. **payload 复制** —— `plugin/`（含 `runtime/node-darwin-x64/`、`node-darwin-arm64/`）解到 `/Library/Application Support/LingxiAI/`。这一份是只读的安装产物。
3. **postinstall（root）** —— 再次找 GUI 用户 + `sudo -u` 调用 `post-install-mac.sh`，把真正的用户上下文工作做掉：
   - 按 `uname -m` 挑 x64 / arm64 的内置 Node
   - 跑 `build-variants.js` 生成 `~/.lingxi-ai/plugin-wps`、`plugin-et`、`plugin-wpp`
   - 拷 `serve-permanent.js` + `proxy-server.js` 到 `~/.lingxi-ai/tools/`
   - 写 publish.xml 到 `com.kingsoft.wpsoffice.mac` 和 `com.kingsoft.wpsoffice.mac.global` 两个 Container
   - 写 `~/Library/LaunchAgents/com.lingxi-ai.server.plist` 并 `launchctl bootstrap gui/<uid>` 进 GUI 域
   - 探活 3889 端口 + 走 `curl` 探 3 个宿主的 manifest

日志：`~/.lingxi-ai/install.log`（用户上下文部分）。pkg 自己的 root 日志在 `/var/log/install.log`。

## 卸载（一键傻瓜式）

pkg 把 **灵犀AI 卸载.app** 装进 `/Applications/`。用户路径有三条：

- Spotlight 搜「灵犀AI 卸载」
- 在「应用程序」(Launchpad / Finder) 里双击
- 命令行 `open /Applications/灵犀AI\ 卸载.app`

点开后：

1. AppleScript 弹原生确认窗（写明要清理的清单）
2. `do shell script "..." with administrator privileges` 触发**一次**系统密码弹窗（同 Touch ID 解锁安装 .pkg 那种）
3. root 身份跑 [uninstall-all.sh](uninstall-all.sh)，一气呵成把这些都清掉：
   - 用户域：`launchctl bootout` LaunchAgent、`pkill` 残留 node、删 plist、删两个 Container 的 publish.xml、删 `~/.lingxi-ai/`
   - 系统域：删 `/Library/Application Support/LingxiAI/`、`pkgutil --forget com.lingxi-ai.installer`
   - 最后 `rm -rf` 自己所在的 `/Applications/灵犀AI 卸载.app`（macOS 允许 rm 正在跑的 bundle，Mach-O image 已 mmap 进内存，applet 进程继续活到 exit）
4. 弹「完成 🎉」对话框（不读 .app 资源，纯系统服务，所以 .app 被删了也能正常显示）

**关键设计**：admin 上下文下 `$HOME=/var/root`、`$USER=root`，没法直接定位用户目录。AppleScript 在升权之前先拿到 `short user name of (system info)` 等用户信息，作为环境变量 `TARGET_USER` / `TARGET_HOME` / `TARGET_UID` 传给升权后的 bash 脚本。

> Apple pkg 标准本身不带卸载机制（pkgutil 只能 forget 不会删文件）。要"卸完即净"必须自己实现一个卸载入口。我们走 .app 是因为 `.command` 不能在 Launchpad 里露面，对用户不够友好。

## 签名 / 公证（强烈推荐发布前做）

**不签的代价**：用户双击 dmg → 解开 → 双击 pkg，会撞 Gatekeeper 弹窗"无法打开，来自身份不明的开发者"。需要教用户右键 → 打开。dmg 解压后的脚本如果走 `bash xxx.sh` 倒是能绕过，但 `.pkg` 不行。

**签 pkg**：

```bash
bash build-dmg.sh --sign "Developer ID Installer: Your Name (TEAMID)"
```

`productbuild --sign` 用 **Installer** 证书。

**签 dmg + 公证**（build-dmg.sh 自身没做，照下面手动跑）：

```bash
# 1. dmg 用 Application 证书 codesign
codesign --sign "Developer ID Application: Your Name (TEAMID)" \
         --timestamp \
         dist/lingxi-ai-1.2.0-beta-mac.dmg

# 2. notarytool 公证(需先 store-credentials 一次)
xcrun notarytool submit dist/lingxi-ai-1.2.0-beta-mac.dmg \
      --keychain-profile "AC_PASSWORD" --wait

# 3. 把公证票钉到 dmg 上,这样断网也能验
xcrun stapler staple dist/lingxi-ai-1.2.0-beta-mac.dmg
```

证书来自 Apple Developer Program（$99/年）。第一次配 `notarytool` 用：

```bash
xcrun notarytool store-credentials AC_PASSWORD \
  --apple-id you@example.com \
  --team-id TEAMID \
  --password <app-specific-password>
```

## 本地测试（不发布）

```bash
# 装
open dist/lingxi-ai-1.2.0-beta-mac.dmg
# 在 Finder 里右键 .pkg → 打开(绕过 Gatekeeper)

# 验
ls ~/.lingxi-ai/                                 # plugin-wps / plugin-et / plugin-wpp / tools / server.log
launchctl list | grep lingxi                      # com.lingxi-ai.server
curl -s http://127.0.0.1:3889/wps/manifest.json   # 200
ls ~/Library/Containers/com.kingsoft.wpsoffice.mac*/Data/.kingsoft/wps/jsaddons/publish.xml

# 看日志
cat ~/.lingxi-ai/install.log
cat ~/.lingxi-ai/server.log

# 卸(一键,会弹原生密码框)
open "/Applications/灵犀AI 卸载.app"

# 或纯命令行(完全无 GUI 也能跑)
sudo TARGET_USER=$(whoami) TARGET_HOME=$HOME TARGET_UID=$(id -u) \
  bash "/Applications/灵犀AI 卸载.app/Contents/Resources/uninstall-all.sh"
```

## 已知坑

1. **测试 / 调试用户上下文**：pkg postinstall 跑在 root，所以 `$HOME` 是 `/var/root`。脚本里用 `stat -f "%Su" /dev/console` 找 GUI 用户。如果是 SSH 远程装 pkg、没有 GUI 登录，会失败。
2. **架构判断**：postinstall 用 `uname -m` 选 x64 / arm64。Rosetta 下跑的 Installer.app 可能报告错的架构 —— 但 Installer.app 本身是 universal 的，正常 GUI 装不踩这个。
3. **WKWebView 缓存**：升级后 WPS 偶尔还用旧缓存（INSTALL.md Q7）。post-install-mac.sh 没主动清，必要时手清。
4. **未签名 = 多两步点击**：Gatekeeper 拦下后，需要右键 pkg → 打开。或者 `xattr -dr com.apple.quarantine "/Volumes/灵犀AI 1.2.0-beta/"`。
