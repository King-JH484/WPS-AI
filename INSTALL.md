# 灵犀AI 插件安装指南（v1.0.0:beta）

本文档介绍如何在另一台电脑上安装并使用灵犀AI WPS 插件（Beta 版）。Windows 与 macOS 步骤分开列出。

## 前置环境（任何系统都需要）

| 必装项 | 说明 |
| --- | --- |
| **WPS Office** | 国内版或国际版均可。Windows 推荐 12.x 及以上，macOS 推荐 5.x 及以上。 |
| **Node.js LTS** | 18+ 或 20+。下载地址：<https://nodejs.org/zh-cn/> |
| **wpsjs CLI** | 安装脚本会自动 `npm install -g wpsjs`，也可手动执行该命令。 |

> **不需要**自行编译/打包 —— 插件源码即运行体（前端 JS）。`npm install` 只装一个 `wps-jsapi` 类型提示包。

## Windows 安装步骤

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

## macOS 安装步骤

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
代理服务器是旧进程（启动时还没有 `/upload-image` 路由）。在启动脚本窗口按 `Ctrl-C` 完全停掉，再重新双击 `start-*.bat` / 运行 `./start-*.sh` 即可。

### Q2：WPS 看不到「灵犀AI」分组
- **Windows**：确认 `start-*.bat` 还在运行（窗口未关闭），重新打开 WPS。
- **macOS**：完全退出 WPS（包括 dock 上的右键退出），再打开。仍看不到，运行 `npm run install:mac-publish` 重写一遍配置。

### Q3：浏览器无法弹出 OAuth 授权页
点击登录后插件会显示授权链接，复制到系统浏览器打开，授权后回到插件输入回调 `code` 即可。

### Q4：3889 / 3890 端口被占用
有其他程序占用了这两个端口。关闭对应程序，或修改：
- 端口 3889：在 `package.json` 的 dev 命令里加参数 `--port`
- 端口 3890：设置环境变量 `PROXY_PORT=新端口`，并同步修改 `plugin/js/tools/presentation.js` 中的 `127.0.0.1:3890` 引用

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
