# 灵犀AI 插件安装指南（v1.0.0:beta）

本文档介绍如何在另一台电脑上安装并使用灵犀AI WPS 插件（Beta 版）。Windows 与 macOS 步骤分开列出。

## 两种安装模式

| 模式 | 适合 | 一句话区别 |
| --- | --- | --- |
| **永久安装**（推荐） | 长期使用 | 一次到位给三个 WPS 应用（文字 / 表格 / 演示）注册插件，后台服务开机自启，不用再开终端。 |
| **开发调试模式** | 临时试用、二次开发 | 用 `npm run dev:*`，每次只能给一个宿主用，关掉脚本插件就消失。 |

> 推荐先看「永久安装」一节。如果只是试用一次，跳到「开发调试模式（临时试用）」。

---

## 永久安装（一次性给 Word / Excel / PPT 都装上）

永久安装会在 `~/.lingxi-ai/`（Windows: `%USERPROFILE%\.lingxi-ai\`）下创建三份宿主变体（`plugin-wps` / `plugin-et` / `plugin-wpp`），把后台服务设为登录自启，并在 WPS 的 jsaddons 配置里同时注册三个宿主。

### Windows 永久安装

1. 解压 `lingxi-ai-1.0.0-beta.zip` 到任意目录。
2. 进入 `plugin/` 目录，**双击** `install-permanent-windows.bat`。脚本会：
   - 调 `node tools/build-variants.js` 生成三份宿主变体到 `%USERPROFILE%\.lingxi-ai\`
   - 拷常驻服务脚本（`serve-permanent.js` + `proxy-server.js`）
   - 写 `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`，包含 `wps`/`et`/`wpp` 三条 `<jspluginonline>`
   - 用 `schtasks` 创建登录自启的计划任务 `LingxiAI`
   - 立即起一份后台服务（用 `wscript.exe` 起 vbs 包装，无窗口）
3. **完全退出 WPS**（任务栏右下角 WPS 图标右键退出），然后重开 WPS 文字 / 表格 / 演示，顶部都会出现「灵犀AI」标签页。
4. 重启电脑后服务也会自动跑。
5. 排查：日志在 `%USERPROFILE%\.lingxi-ai\server.log`；要看实时输出，双击 `%USERPROFILE%\.lingxi-ai\run-server-debug.bat`。

**卸载**：双击 `plugin\uninstall-permanent-windows.bat`，会删计划任务、停服务、删 publish.xml、删 `~/.lingxi-ai`。

### macOS 永久安装

1. 解压 zip 到任意目录。
2. 终端进入 `plugin/`：
   ```bash
   cd ~/lingxi-ai/plugin
   chmod +x install-permanent-mac.sh uninstall-permanent-mac.sh
   ./install-permanent-mac.sh
   ```
3. 脚本会：
   - 生成三份宿主变体到 `~/.lingxi-ai/`
   - 写 publish.xml 到两个 WPS Container（`com.kingsoft.wpsoffice.mac` + `com.kingsoft.wpsoffice.mac.global`）
   - 写 `~/Library/LaunchAgents/com.lingxi-ai.server.plist` 并 `launchctl load`
4. **完全退出 WPS** → 重新打开任意 WPS 应用，顶部出现「灵犀AI」。
5. 日志：`~/.lingxi-ai/server.log`。

**卸载**：`./uninstall-permanent-mac.sh`。

### 永久安装架构

```
~/.lingxi-ai/                    （Windows: %USERPROFILE%\.lingxi-ai\）
├── plugin-wps/                  ← addonType=wps，wps 专用 ribbon
├── plugin-et/                   ← addonType=et，表格快捷按钮
├── plugin-wpp/                  ← addonType=wpp，PPT 风格 / 统一风格 / 去 AI 味
├── tools/
│   ├── serve-permanent.js       ← 常驻服务（端口 3889 静态文件）
│   └── proxy-server.js          ← 子进程，端口 3890 = CORS 代理 + /upload-image
└── server.log                   ← 服务日志
```

WPS publish.xml 注册三条 `<jspluginonline>`，分别指向 `http://127.0.0.1:3889/wps/`、`/et/`、`/wpp/`。三个宿主同时拉起，互不干扰。

---

## 前置环境（两种模式都需要）

| 必装项 | 说明 |
| --- | --- |
| **WPS Office** | 国内版或国际版均可。Windows 推荐 12.x 及以上，macOS 推荐 5.x 及以上。 |
| **Node.js LTS** | 18+ 或 20+。下载地址：<https://nodejs.org/zh-cn/> |
| **wpsjs CLI**（仅调试模式需要） | 调试模式安装脚本会自动 `npm install -g wpsjs`。永久模式自带 Node 静态服务，**不依赖** wpsjs。 |

> **不需要**自行编译/打包 —— 插件源码即运行体（前端 JS）。`npm install` 只装一个 `wps-jsapi` 类型提示包，永久模式连这步都跳过。

---

## 开发调试模式（临时试用）

适合只想本地跑一下 / 改代码看效果的场景。每次只能给一个宿主用。

### Windows 调试模式

1. 解压 `lingxi-ai-1.0.0-beta.zip` 到任意目录，例如 `D:\lingxi-ai\`。解压后会得到 `plugin/` 子目录。
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

1. 解压 `lingxi-ai-1.0.0-beta.zip` 到任意目录，例如 `~/lingxi-ai/`。
2. 打开终端，`cd` 进入 `plugin/` 目录：
   ```bash
   cd ~/lingxi-ai/plugin
   ```
3. 给脚本可执行权限并运行安装：
   ```bash
   chmod +x install-mac.sh start-*.sh
   ./install-mac.sh
   ```
   该脚本会：
   - 检查 Node.js / npm
   - 全局安装 wpsjs
   - `npm install`
   - 写入 macOS WPS 容器配置（`com.kingsoft.wpsoffice.mac` 和 `com.kingsoft.wpsoffice.mac.global`）
4. **完全退出 WPS**（菜单 → 退出 WPS，确保所有 WPS 进程已关闭）。
5. 启动对应应用：
   ```bash
   ./start-wps.sh   # WPS 文字
   ./start-et.sh    # WPS 表格
   ./start-wpp.sh   # WPS 演示
   ```
6. 重新打开 WPS。如果顶部功能区看不到「灵犀AI」，进入「加载项 / 可用加载项」启用 `lingxi-ai`，再切回任意文档即可看到。

## 常见问题

### Q1：插件加载后图表 / 视觉模板报 "代理服务器返回 404"
代理服务器是旧进程（启动时还没有 `/upload-image` 路由）。
- **调试模式**：在启动脚本窗口按 `Ctrl-C` 完全停掉，再重新双击 `start-*.bat` / 运行 `./start-*.sh` 即可。
- **永久模式**：Windows 重新双击 `install-permanent-windows.bat` 走一遍重装；macOS 重新跑 `./install-permanent-mac.sh`。脚本会重启常驻服务。

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

### Q5：版本号为什么 manifest.json 写 `1.0.0:beta` 但 package.json 写 `1.0.0-beta`
WPS 直接读取 `manifest.json` 的 version 显示在加载项列表，按用户要求保留 `1.0.0:beta` 字面值。`package.json` 的 version 由 npm 校验为严格 semver，必须用 `-beta`，不影响实际功能。

### Q6：能否完全离线安装？
可以，但要预先在能联网的机器上：
1. `npm install -g wpsjs` → 把 `%APPDATA%\npm\node_modules\wpsjs` 拷贝到目标机相同位置（Windows）；macOS 是 `/usr/local/lib/node_modules/wpsjs`
2. 在源目录 `npm install` 后把 `plugin/node_modules/` 一并拷过去

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
