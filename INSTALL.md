# 灵犀AI 插件安装指南（v1.3.0）

本文档介绍如何在另一台电脑上安装并使用灵犀AI WPS 插件（Beta 版，覆盖文字 / 表格 / 演示 / PDF 四端）。Windows 与 macOS 步骤分开列出。

## 两种安装模式

| 模式 | 适合 | 一句话区别 |
| --- | --- | --- |
| **永久安装**（推荐） | 长期使用 | 一次到位给三个 WPS 应用（文字 / 表格 / 演示）注册插件，后台服务开机自启，不用再开终端。 |
| **开发调试模式** | 临时试用、二次开发 | 用 `npm run dev:*`，每次只能给一个宿主用，关掉脚本插件就消失。 |

> 推荐先看「永久安装」一节。如果只是试用一次，跳到「开发调试模式（临时试用）」。

---

## 永久安装（一次性给 Word / Excel / PPT 都装上）

永久安装会在 `~/.lingxi-ai/`（Windows: `%USERPROFILE%\.lingxi-ai\`）下创建四份宿主变体，把后台服务设为登录自启，并在 WPS 的 jsaddons 配置里同时注册四个宿主。文件布局：

```
~/.lingxi-ai/                    （Windows: %USERPROFILE%\.lingxi-ai\）
├── plugin-wps/                  ← addonType=wps，wps 专用 ribbon
├── plugin-et/                   ← addonType=et，表格快捷按钮
├── plugin-wpp/                  ← addonType=wpp，PPT 风格 / 统一风格 / 去 AI 味
├── plugin-pdf/                  ← addonType=pdf，PDF 对照翻译 / 全文总结 / 生成 PPT
├── tools/
│   ├── serve-permanent.js       ← 常驻服务（端口 3889 静态文件）
│   └── proxy-server.js          ← 子进程，端口 3890 = CORS 代理 + /upload-image
└── server.log                   ← 服务日志
```

publish.xml 注册四条 `<jspluginonline>`，分别指向 `http://127.0.0.1:3889/wps/`、`/et/`、`/wpp/`、`/pdf/`。四个宿主同时拉起，互不干扰。

### Windows 永久安装

**推荐方式：图形化安装器（傻瓜式）**

1. 下载 `lingxi-ai-1.3.0-setup.exe`（约 30MB，内置 Node 运行时，不依赖系统 Node）。
2. **双击运行 setup.exe**，按向导一路「下一步」，默认装到 `C:\Program Files\LingxiAI`（也可改装到其他盘）。无需管理员权限。
3. 安装器最后一步会自动跑后台脚本：生成三份宿主变体到 `%USERPROFILE%\.lingxi-ai\`、写 `publish.xml`、注册登录自启、起后台服务。
4. **完全退出 WPS**（任务栏右下角 WPS 图标右键退出），然后重开 WPS 文字 / 表格 / 演示，顶部都会出现「灵犀AI」标签页。
5. 重启电脑后服务也会自动跑。
6. 排查：日志在 `%USERPROFILE%\.lingxi-ai\server.log`；要看实时输出，双击 `%USERPROFILE%\.lingxi-ai\run-server-debug.bat`。

**卸载**：开始菜单 → 「灵犀AI」 → 「卸载灵犀AI」，或控制面板 → 程序和功能 → 选「灵犀AI」卸载。会自动停服务、清 publish.xml、清 `~/.lingxi-ai`、移除自启项。

**升级**：下新版 setup.exe 双击运行即可，Inno Setup 会原地替换。原来的 provider 配置 / OAuth Token / 模型选择都在 localStorage 里，重装不会丢。

---

**备选方式：手动 .bat 安装**（适合不想装 Inno 产物 / 想看脚本细节的进阶用户）

1. 解压 `lingxi-ai-1.3.0.zip` 到任意目录。
2. 进入 `plugin/` 目录，**双击** `install-permanent-windows.bat`。脚本会：
   - 调 `node tools/build-variants.js` 生成三份宿主变体到 `%USERPROFILE%\.lingxi-ai\`
   - 拷常驻服务脚本（`serve-permanent.js` + `proxy-server.js`）
   - 写 `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`，包含 `wps`/`et`/`wpp` 三条 `<jspluginonline>`
   - 注册到 HKCU Run 实现登录自启
   - 立即起一份后台服务（用 `wscript.exe` 起 vbs 包装，无窗口）

   > 该方式需要先在系统 PATH 装 Node.js 18+ 或 20+。GUI 安装器内置 Node，没这要求。

**手动卸载**：双击 `plugin\uninstall-permanent-windows.bat`。

### macOS 永久安装

**推荐方式：图形化安装器（dmg + pkg，傻瓜式）**

1. 下载 `lingxi-ai-1.3.0-mac.dmg`（约 35MB，内置 darwin-x64 + darwin-arm64 两份 Node 运行时，不依赖系统 Node）。
2. 双击 dmg 打开 → 双击「灵犀AI 安装器.pkg」。**未签名版本会被 Gatekeeper 拦**：右键 .pkg → 打开 → 在警告弹窗里再点「打开」即可。
3. 按向导一路下一步。装到 `/Library/Application Support/LingxiAI/`（需要管理员密码,一次性输入）。
4. 装完最后一步会自动跑 post-install：按你的 CPU 架构选 Mac 版内置 Node、生成三份宿主变体到 `~/.lingxi-ai/`、写两个 Container 的 publish.xml、写 LaunchAgent 并立即拉起服务。
5. **完全退出 WPS** → 重新打开任意 WPS 应用,顶部出现「灵犀AI」。
6. 日志:`~/.lingxi-ai/install.log`(安装过程) + `~/.lingxi-ai/server.log`(后台服务)。

**卸载**(一键傻瓜式):

1. 打开 Spotlight(`Cmd+Space`) → 搜「灵犀AI 卸载」,或在「应用程序」里双击 **灵犀AI 卸载.app**
2. 弹窗确认 → 输入一次系统密码(系统密码框,因为要删 `/Library/Application Support/`)
3. 完事。脚本会一次性清掉:LaunchAgent、WPS publish.xml、`~/.lingxi-ai/`、`/Library/Application Support/LingxiAI/`、pkgutil receipt,**以及卸载工具 .app 自身**(应用程序文件夹里不会留残留)

**升级**:下新版 dmg → 同样流程双击 pkg。preinstall 会先停旧服务,postinstall 重新写 publish.xml + 重启 LaunchAgent。

---

**备选方式：手动 .sh 安装**（适合不想装 pkg / 想看脚本细节的进阶用户）

1. 解压 zip 到任意目录。
2. 终端进入 `plugin/`：
   ```bash
   cd ~/lingxi-ai/plugin
   ```
3. 运行安装脚本（**用 `bash` 调用，不要用 `./`**）：
   ```bash
   bash install-permanent-mac.sh
   ```

   > **为什么不用 `./install-permanent-mac.sh`？**
   > zip 解压的文件被 macOS 打了 `com.apple.quarantine` 扩展属性，Gatekeeper 会拦下直接执行，报 `operation not permitted`。`bash xxx.sh` 是把文件作为参数喂给 bash 解释器，绕过 Gatekeeper 的"执行"检查，最稳。
   > 一定要用 `./` 的话先 `xattr -dr com.apple.quarantine . && chmod +x *.sh` 再 `./install-permanent-mac.sh`，但没必要。
4. 脚本会：
   - 生成三份宿主变体到 `~/.lingxi-ai/`
   - 写 publish.xml 到两个 WPS Container（`com.kingsoft.wpsoffice.mac` + `com.kingsoft.wpsoffice.mac.global`）
   - 写 `~/Library/LaunchAgents/com.lingxi-ai.server.plist` 并 `launchctl load`
5. **完全退出 WPS** → 重新打开任意 WPS 应用，顶部出现「灵犀AI」。
6. 日志：`~/.lingxi-ai/server.log`。

**卸载**：`bash uninstall-permanent-mac.sh`（同样推荐 bash 法）。

**升级**：拿到新版 zip → 解压到任意位置 → 进入新解压目录的 `plugin/` → `bash install-permanent-mac.sh`。脚本第一步会自动 `launchctl unload` + `pkill` 旧服务，再按正常流程重写 `~/.lingxi-ai/` 和 publish.xml。完成后**完全退出 WPS 重开**。

> ⚠️ macOS 升级有时 WKWebView 会缓存上一版的 JS/CSS（症状：新功能不生效，控制台报 `Main resource content verification failed`）。如出现，按 [Q7](#q7macos-上重装后报-main-resource-content-verification-failed) 清一次缓存即可。

---

## 前置环境

| 必装项 | GUI 安装器 | 手动脚本 / 调试模式 | 说明 |
| --- | --- | --- | --- |
| **WPS Office** | ✅ | ✅ | 国内/国际版均可。Windows 12.x+，macOS 5.x+。 |
| **Node.js LTS** | ❌ 已内置 | ✅ 需自装 18+ / 20+ | GUI 安装包内置便携 Node，不读系统 PATH。手动方式从 <https://nodejs.org/zh-cn/> 下。 |
| **wpsjs CLI** | ❌ | ✅ 仅调试模式 | 调试模式安装脚本会自动 `npm install -g wpsjs`。 |

> **不需要**自行编译/打包 —— 插件源码即运行体（前端 JS）。`npm install` 只装一个 `wps-jsapi` 类型提示包，GUI / 永久模式都不需要。

---

## 开发调试模式（临时试用）

适合只想本地跑一下 / 改代码看效果的场景。每次只能给一个宿主用。

### Windows 调试模式

1. 解压 `lingxi-ai-1.3.0.zip` 到任意目录，例如 `D:\lingxi-ai\`。解压后会得到 `plugin/` 子目录。
2. 进入 `plugin/` 目录，**双击** `install-windows.bat`。脚本会：
   - 检查 Node.js / npm
   - 全局安装 wpsjs（首次需要联网下载，几十秒）
   - 在 plugin 目录执行 `npm install`
3. 安装完成后**保留窗口**，**双击**对应应用的启动脚本：
   - `start-wps.bat` —— WPS 文字
   - `start-et.bat` —— WPS 表格
   - `start-wpp.bat` —— WPS 演示
4. 启动脚本会同时拉起：
   - 本地 CORS 代理（`127.0.0.1:3890`）—— **必需**，转发 OpenAI/Anthropic 请求并提供 SVG→PNG 上传端点
   - wpsjs 调试服务（`127.0.0.1:3889`）—— 注册插件给 WPS
   - WPS 客户端会被自动唤起
5. 在 WPS 顶部功能区找到「**灵犀AI**」分组 → 点击「**打开灵犀AI**」打开右侧助手面板。
6. 第一次使用：在面板设置区配置 provider（Codex OAuth / OpenAI / Anthropic），保存后即可使用。

> **关闭服务**：在启动脚本的命令行窗口按 `Ctrl-C`，或直接关闭窗口。下次使用再次双击 `start-*.bat`。

> **不想看到黑框窗口**：可以建一个 Windows 计划任务，使用「无界面」运行 `start-*.bat`。一般开发使用没必要。

### macOS 调试模式

1. 解压 `lingxi-ai-1.3.0.zip` 到任意目录，例如 `~/lingxi-ai/`。
2. 打开终端，`cd` 进入 `plugin/` 目录：
   ```bash
   cd ~/lingxi-ai/plugin
   ```
3. 运行安装脚本（**用 `bash` 调用，不要用 `./`**，绕过 macOS Gatekeeper 的 quarantine 拦截）：
   ```bash
   bash install-mac.sh
   ```
   该脚本会：
   - 检查 Node.js / npm
   - 全局安装 wpsjs
   - `npm install`
   - 写入 macOS WPS 容器配置（`com.kingsoft.wpsoffice.mac` 和 `com.kingsoft.wpsoffice.mac.global`）
4. **完全退出 WPS**（菜单 → 退出 WPS，确保所有 WPS 进程已关闭）。
5. 启动对应应用（同样用 `bash`）：
   ```bash
   bash start-wps.sh   # WPS 文字
   bash start-et.sh    # WPS 表格
   bash start-wpp.sh   # WPS 演示
   ```
6. 重新打开 WPS。如果顶部功能区看不到「灵犀AI」，进入「加载项 / 可用加载项」启用 `lingxi-ai`，再切回任意文档即可看到。

---

## 打包 Windows 安装器（维护者）

从源码构建 `lingxi-ai-1.3.0-setup.exe` 的步骤，给发版的人参考。普通用户不需要这一节。

### 前置工具

| 工具 | 必装 | 说明 |
| --- | --- | --- |
| **Inno Setup 6+** | ✅ | <https://jrsoftware.org/isdl.php> 或 `winget install -e --id JRSoftware.InnoSetup`。装完 `ISCC.exe` 在 `%ProgramFiles(x86)%\Inno Setup 6\` 或 `%LOCALAPPDATA%\Programs\Inno Setup 6\` |
| **.NET Framework csc.exe** | ✅ | Windows 7+ 自带，在 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，不用单独装 |
| **Node.js LTS** | ✅ | 跑 `tools/bundle-node.js` 拉便携 Node 用 |

### 步骤

1. **拉 portable Node 内置进安装包**（只需跑一次，30MB+ 不进 git）：
   ```bash
   cd plugin
   node tools/bundle-node.js
   ```
   产物：`plugin/runtime/node-win-x64/node.exe`（v22.11.0，~95MB 解压）。

2. **编 `lingxi-launcher.exe`**（零窗口 launcher，跟 setup.exe 一起 ship，~6.5KB；改了 `.cs` 后才需要重编）：
   ```powershell
   cd plugin/tools
   & 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:winexe /out:lingxi-launcher.exe lingxi-launcher.cs
   ```
   生成 `plugin/tools/lingxi-launcher.exe`，进 git（binary）。

3. **编 Inno Setup 安装器**：
   ```cmd
   cd installer
   build.bat
   ```
   `build.bat` 自动找 ISCC.exe 路径并编译 `lingxi-ai.iss`。产物在 `dist/lingxi-ai-1.3.0-setup.exe`（~24MB）。

### 后台服务架构（技术细节）

setup.exe 装完后，task 起后台服务的链路：

```
计划任务 LingxiAI (ONLOGON 触发)
  └─ Action.Execute = <install dir>\plugin\tools\lingxi-launcher.exe  (winexe 子系统，零窗口)
     Action.Argument = <logPath> <staticPort> <proxyPort> <nodeExe> <scriptPath> --root <rootDir>
     └─ launcher 内部 ProcessStartInfo.CreateNoWindow=true spawn node
        └─ node serve-permanent.js (listen 13889 / 13890)
           ├─ stdout/stderr → launcher 异步抓 → server.log
           └─ 端口冲突自动回退 (pick-ports.ps1)：3889/3890 被 Hyper-V/WSL2 排除时退到 13889/13890
```

关键脚本（都在 `plugin/tools/`）：
- `bundle-node.js` — 拉 nodejs.org 便携包
- `lingxi-launcher.cs` / `.exe` — 零窗口 launcher（.NET Framework winexe）
- `pick-ports.ps1` — 试 bind TcpListener 找可用端口
- `rewrite-proxy-port.ps1` — 端口变了批量改 TARGET 下 JS 里的 `:3890`
- `register-task.ps1` — 用 PowerShell ScheduledTask cmdlet 注册 ONLOGON 任务
- `post-install-windows.bat` — Inno `[Run]` 触发的主流程
- `pre-uninstall-windows.bat` — Inno `[UninstallRun]` 触发的清理

## 打包 macOS 安装器（维护者）

从源码构建 `lingxi-ai-1.3.0-mac.dmg` 的步骤。**必须在 macOS 上跑**（pkgbuild / productbuild / hdiutil 都是 mac 自带，Windows 上不能交叉构建）。

### 前置工具

| 工具 | 必装 | 说明 |
| --- | --- | --- |
| **macOS 10.15+** | ✅ | distribution.xml 里 `min="10.15"` |
| **Xcode Command Line Tools** | ✅ | `xcode-select --install`,带 `pkgbuild` / `productbuild` / `codesign` / `notarytool` / `hdiutil` |
| **Node.js LTS** | ✅ | 跑 `bundle-node.js --all` 拉两份便携 Node 用 |
| **Apple Developer ID 证书**(可选) | ⭕ | 不签也能装,只是用户得右键 .pkg → 打开绕 Gatekeeper。发布前强烈推荐签 + 公证 |

### 步骤

1. **拉两份 portable Node 内置进 pkg**（首次跑会下载,后续跳过）：
   ```bash
   cd plugin
   node tools/bundle-node.js --all
   ```
   产物：
   - `plugin/runtime/node-darwin-x64/bin/node`（Intel Mac）
   - `plugin/runtime/node-darwin-arm64/bin/node`（Apple Silicon）
   - `plugin/runtime/node-win-x64/node.exe`（Windows 那份也会一起拉）

   两份 Mac 加起来 ~80MB，压进 dmg 后 ~35MB。`build-dmg.sh` 跑时如果检测不到也会自动调一次。

2. **编 dmg**：
   ```bash
   cd installer-mac
   bash build-dmg.sh
   ```
   产物：
   - `dist/lingxi-ai-1.3.0-mac.dmg`（~35MB,给用户的）
   - `dist/lingxi-ai-1.3.0.pkg`（MDM 部署 / CI 静默装用,同一份 pkg 单独丢出来）

   流程：staging 拷源码 → `pkgbuild` 打组件包 → `productbuild` 套 distribution.xml + welcome/conclusion → `hdiutil` UDZO 压成 dmg。

3. **签名 + 公证（发布前）**：
   ```bash
   # pkg 用 Installer 证书签
   bash build-dmg.sh --sign "Developer ID Installer: Your Name (TEAMID)"

   # dmg 自身要用 Application 证书 codesign(productbuild 只签 pkg,不签 dmg)
   codesign --sign "Developer ID Application: Your Name (TEAMID)" \
            --timestamp \
            dist/lingxi-ai-1.3.0-mac.dmg

   # 公证(首次要 store-credentials 一次)
   xcrun notarytool store-credentials AC_PASSWORD \
     --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
   xcrun notarytool submit dist/lingxi-ai-1.3.0-mac.dmg \
     --keychain-profile AC_PASSWORD --wait

   # 把公证票钉到 dmg(断网也能验)
   xcrun stapler staple dist/lingxi-ai-1.3.0-mac.dmg
   ```
   证书来自 Apple Developer Program（$99/年）。

### 安装链路（技术细节）

pkg 标准三阶段，跟 Inno Setup 那边对照看：

```
1. preinstall  (root 上下文)
   └─ stat -f "%Su" /dev/console 找 GUI 用户
   └─ sudo -u <user> launchctl bootout + pkill 旧服务  (升级场景必需)

2. payload 复制
   └─ plugin/* (含 runtime/node-darwin-x64, node-darwin-arm64)
      → /Library/Application Support/LingxiAI/

3. postinstall (root 上下文)
   └─ 再次找 GUI 用户 + drop privilege
   └─ sudo -u <user> bash post-install-mac.sh /Library/Application Support/LingxiAI
      ├─ uname -m → 选 x64 或 arm64 内置 Node
      ├─ node build-variants.js → ~/.lingxi-ai/plugin-{wps,et,wpp}
      ├─ cp serve-permanent.js + proxy-server.js → ~/.lingxi-ai/tools/
      ├─ 写 publish.xml → ~/Library/Containers/com.kingsoft.wpsoffice.mac{,.global}/Data/.kingsoft/wps/jsaddons/
      ├─ 写 ~/Library/LaunchAgents/com.lingxi-ai.server.plist
      ├─ launchctl bootstrap gui/<uid> <plist>   (Mojave+ 现代写法,降级到 load)
      └─ 探活 :3889 + curl 三个宿主 manifest
```

关键文件（[installer-mac/](installer-mac/) + [plugin/tools/](plugin/tools/)）：
- `installer-mac/build-dmg.sh` — 主构建脚本
- `installer-mac/distribution.xml` — productbuild GUI 定义（最低 10.15、universal、单 choice）
- `installer-mac/scripts/preinstall` — root 上下文，停老服务
- `installer-mac/scripts/postinstall` — root 上下文，drop privilege 调真正逻辑
- `installer-mac/uninstaller.applescript` — 一键卸载工具源，`osacompile` 编成 `/Applications/灵犀AI 卸载.app`
- `installer-mac/uninstall-all.sh` — .app 升权后跑的全清脚本（被打进 .app 的 Contents/Resources）
- `installer-mac/resources/welcome.html` / `conclusion.html` — 安装向导文案
- `plugin/tools/post-install-mac.sh` — 用户上下文，真正的安装逻辑
- `plugin/tools/pre-uninstall-mac.sh` — 留给手动 `.sh` 安装路径的轻量卸载

完整说明 + 排查、本地测试命令在 [installer-mac/README.md](installer-mac/README.md)。

---

## 常见问题

### Q1：插件加载后图表 / 视觉模板报 "代理服务器返回 404"
代理服务器是旧进程（启动时还没有 `/upload-image` 路由）。
- **调试模式**：在启动脚本窗口按 `Ctrl-C` 完全停掉，再重新双击 `start-*.bat` / 运行 `bash start-*.sh` 即可。
- **永久模式**：Windows 重新双击 `install-permanent-windows.bat` 走一遍重装；macOS 重新跑 `bash install-permanent-mac.sh`。脚本会重启常驻服务。

### Q2：WPS 看不到「灵犀AI」分组
- **永久模式（Windows）**：确认计划任务 `LingxiAI` 已注册（`schtasks /Query /TN LingxiAI`），且 `~/.lingxi-ai/server.log` 没有报错。仍看不到 → 退出 WPS 全部进程后重启。
- **永久模式（macOS）**：检查 `launchctl list | grep lingxi` 是否有 `com.lingxi-ai.server`。再退出 WPS 全部进程重启。
- **调试模式 Windows**：确认 `start-*.bat` 窗口还在运行，重新打开 WPS。
- **调试模式 macOS**：完全退出 WPS（包括 dock 上的右键退出）后再打开。仍看不到，运行 `npm run install:mac-publish` 重写一遍配置。

### Q3：浏览器无法弹出 OAuth 授权页
点击登录后插件会显示授权链接，复制到系统浏览器打开，授权后回到插件输入回调 `code` 即可。

### Q4：3889 / 3890 端口被占用
两种模式都用这两个端口（3889 = WPS 加载插件源；3890 = AI/图片代理）。关掉占用端口的程序即可，或：
- **调试模式**：3889 端口可在 `package.json` 的 dev 命令里加 `--port`；3890 端口设置环境变量 `PROXY_PORT=新端口` 并同步改 `plugin/js/tools/presentation.js` 中的 `127.0.0.1:3890` 引用。
- **永久模式**：用环境变量 `LINGXI_STATIC_PORT` / `PROXY_PORT` 启动 `serve-permanent.js`。改完同样要同步 `presentation.js`，再到 `publish.xml` 把 URL 端口替换。

### Q5：manifest.json 和 package.json 的 version 字段格式有什么约束？
WPS 直接读取 `manifest.json` 的 version 显示在加载项列表，可以是任意字符串（历史版本曾用 `1.2.1:beta` 这种带冒号的字面值）。`package.json` 的 version 由 npm 校验为严格 semver，beta 版本必须用 `-beta` 后缀（如 `1.2.1-beta`）。从 1.3.0 起两边对齐成纯 semver。

### Q6：能否完全离线安装？
可以，但要预先在能联网的机器上：
1. `npm install -g wpsjs` → 把 `%APPDATA%\npm\node_modules\wpsjs` 拷贝到目标机相同位置（Windows）；macOS 是 `/usr/local/lib/node_modules/wpsjs`
2. 在源目录 `npm install` 后把 `plugin/node_modules/` 一并拷过去

### Q7：macOS 上重装后报 "Main resource content verification failed"
Mac WPS 用 WKWebView，会缓存上次加载过的插件资源。重装后磁盘上的文件变了，WKWebView 还在用旧缓存，校验对不上就报这个。

修法（先停服务再清缓存再重启）：
```bash
# 完全停 WPS + 服务
pkill -9 wps; pkill -9 -f kingsoft
launchctl unload ~/Library/LaunchAgents/com.lingxi-ai.server.plist
pkill -9 -f serve-permanent; pkill -9 -f proxy-server

# 清 WPS 全部缓存
rm -rf ~/Library/Containers/com.kingsoft.wpsoffice.mac/Data/Library/Caches/*
rm -rf ~/Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/Library/Caches/*
rm -rf ~/Library/Caches/com.kingsoft.wpsoffice.mac
rm -rf ~/Library/WebKit/com.kingsoft.wpsoffice.mac 2>/dev/null

# 拉服务回来
launchctl load ~/Library/LaunchAgents/com.lingxi-ai.server.plist
open -a wps
```

服务现在已经发 `Cache-Control: no-store`，正常情况下 WKWebView 不该再缓存。如果还是出，按上面流程手动清一次。

### Q8：macOS 直接 `./xxx.sh` 报 "operation not permitted"
zip 解压后所有文件被 macOS 打了 `com.apple.quarantine` 扩展属性，Gatekeeper 拦下来了，`chmod +x` 也救不回。两条出路：
- `bash xxx.sh`（最快，绕过 Gatekeeper 执行检查）
- `xattr -dr com.apple.quarantine .`（清掉 quarantine，之后 `./` 也能跑）

### Q9：360 安全卫士拦截 setup.exe 安装失败

症状:跑 setup.exe 时 360 弹窗,点了"允许"安装仍然失败;退出 360 后安装就正常。

**为啥点"允许"还失败**:360 的拦截分多层:
- **L1 黄色提示**:点"允许" → 当下这步操作放过
- **L2 沉默拦截**:某些后续行为(创建计划任务、生成新 .exe 到 Program Files、写其它软件的 publish.xml)被 *静默 block*,不弹窗,直接当作"失败"
- **L3 隔离/删除**:特征匹配的文件直接进隔离区

setup.exe 和 `lingxi-launcher.exe` 都是 *未签名* 的 PE,加上脚本里有 "创建计划任务" 这种 360 重点监控的行为,把 L2/L3 都触发了。"允许"按钮只解 L1,L2/L3 还在拦。这是 360 的设计,脚本侧绕不开。

**用户侧解法（推荐）**:
1. 暂时退出 360(右下角图标右键 → 退出)。
2. 装 setup.exe。
3. 装完之后再启 360。
4. 360 主界面 → 设置 → 安全防护中心 → 信任与限制 → 加入信任:
   - `C:\Users\<你>\AppData\Local\Programs\LingxiAI\` (整个目录)
   - `C:\Users\<你>\.lingxi-ai\` (整个目录)
   - 计划任务 `LingxiAI` 加白
5. 之后日常用 / 升级 / 卸载都不会再被拦。

**用户侧解法（不退 360）**:
- 360 主界面 → 防护中心 → **操作记录** → 找到 LingxiAI 相关的拦截条目 → 「始终允许」(注意:每条拦截都要单独"始终允许",可能有 3-5 条)。

**维护者侧根治**:
- 申请 360 开发者白名单(免费):<https://open.360.cn/> → 软件加白 → 提交 setup.exe + lingxi-launcher.exe。审核 1-2 周。
- 后续考虑买代码签名证书(¥800-2000/年),签了之后 360 / QQ管家 / 腾讯电脑管家全部不再拦,Windows SmartScreen 也不再警告。

## 卸载

直接删除解压目录即可。如果想清理 macOS 的 WPS 配置：

```bash
rm ~/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml
rm ~/Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml
```

## 反馈

发现 Bug 或有改进建议，请联系灵犀AI 维护者，附上：
- 系统 + WPS 版本
- 触发场景（哪个宿主、哪个工具）
- 控制台报错截图（在 WPS 加载项面板按 F12 打开 DevTools）
