# 灵犀AI WPS 加载项

灵犀AI 是一个运行在 WPS 客户端内的 JS 加载项插件。用户通过 ChatGPT / Codex OAuth 登录后，插件读取 WPS 文字文档内容，并调用 OpenAI Responses API 生成结果，再由用户确认插入或替换回文档。

## 功能特性

- WPS 文字客户端加载项入口：顶部功能区 `灵犀AI`。
- ChatGPT / Codex OAuth 登录，使用 PKCE 授权码流程。
- 登录态使用 `localStorage` 持久化，除非手动退出，否则下次打开继续保持登录。
- OpenAI API 使用 Bearer Token 鉴权，不在前端保存 API Key。
- 使用 OpenAI Responses API：`https://api.openai.com/v1/responses`。
- 支持 SSE 流式输出，结果先显示在插件窗口中。
- 支持读取当前选区或全文。
- 支持润色、总结、翻译、自定义指令。
- 支持插入到光标位置或替换当前选区。

## 项目结构

```text
plugin/
├── index.html                       # WPS 加载项入口页
├── main.js                          # 统一加载脚本
├── taskpane.html                    # 灵犀AI 业务页面
├── ribbon.xml                       # WPS 顶部功能区配置
├── manifest.json                    # 插件声明
├── package.json                     # wpsjs 项目配置
├── css/
│   └── style.css                    # UI 样式
├── images/
│   └── ai.svg                       # Ribbon 图标
├── js/
│   ├── auth.js                      # Codex OAuth + PKCE + Token 管理
│   ├── openai.js                    # AI 客户端门面（按当前 provider 调用）
│   ├── providers/
│   │   ├── registry.js              # provider 注册表 + 设置存储
│   │   ├── sse.js                   # SSE 通用流式解析
│   │   ├── codex.js                 # Codex (ChatGPT OAuth) provider
│   │   ├── openai.js                # OpenAI 兼容 provider（自定义 baseURL+API Key）
│   │   └── anthropic.js             # Anthropic Claude provider
│   ├── wps-addon-adapter.js         # WPS 客户端 API 适配与 Ribbon 回调
│   ├── wps.js                       # 多宿主分发 + 统一文档读写 API
│   ├── hosts/
│   │   ├── writer.js                # WPS 文字桥接（Selection/Range）
│   │   ├── spreadsheet.js           # WPS 表格桥接（Worksheets/Range/Cells）
│   │   └── presentation.js          # WPS 演示桥接（Slides/Shapes/TextFrame）
│   └── app.js                       # 业务 UI 编排
└── tools/
    ├── install-mac-publish.js       # macOS WPS 加载项配置补写脚本
    ├── proxy-server.js              # 本地 CORS 代理（转发 OpenAI/Claude/自定义 API）
    └── set-addon-type.js            # 切换 addonType（wps/et/wpp）的小工具
```

## OAuth 配置

OAuth 配置位于 [plugin/js/auth.js](plugin/js/auth.js:5)：

```js
const CODEX_OAUTH = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  extraParams: Object.freeze({
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true"
  })
});
```

说明：

- `clientId` 是 OAuth Client ID，不是 OpenAI API Key。
- `redirectUri` 必须与该 OAuth Client ID 登记的回调地址一致。
- `offline_access` 用于获取 refresh token，以支持长期登录。
- Token 持久化保存到本机 `localStorage`，点击退出登录时清除。

## WPS 客户端调试

安装 `wpsjs`：

```bash
npm install -g wpsjs
```

进入插件目录：

```bash
cd plugin
```

首次可安装类型提示依赖：

```bash
npm install
```

### 启动开发环境（推荐）

使用 `dev` 命令同时启动 CORS 代理和 wpsjs 调试服务：

```bash
npm run dev
```

如需在 WPS 表格 / WPS 演示 中调试，使用对应别名（会自动切换 `addonType`，再启动 `wpsjs debug`）：

```bash
npm run dev:wps   # WPS 文字
npm run dev:et    # WPS 表格
npm run dev:wpp   # WPS 演示
```

> wpsjs 一次只能把 addon 注册给一个宿主。插件 JS 已做多宿主适配，加载后会自动识别当前是文字 / 表格 / 演示，并切换处理范围与读写策略。

### 分别启动

先启动 CORS 代理服务器（占用 3890 端口）：

```bash
npm run proxy
```

再启动 wpsjs 调试：

```bash
wpsjs debug
```

如果只想启动本地插件服务，不自动拉起 WPS：

```bash
wpsjs debug --server --port 3889
```

> **说明**：CORS 代理服务器是必需的。WPS 加载项运行在 WebView 中，遵循浏览器 CORS 策略，而 OpenAI / ChatGPT API 不允许前端跨域请求。代理在本地 `localhost:3890` 转发 API 请求到远程端点并注入 CORS 头。

## macOS WPS 看不到可用加载项时

macOS 版 WPS 可能读取 `com.kingsoft.wpsoffice.mac.global` 容器配置，而 `wpsjs debug` 默认写入 `com.kingsoft.wpsoffice.mac` 容器。

如果“可用加载项”列表为空，执行：

```bash
cd plugin
npm run install:mac-publish
```

该脚本会写入以下两个配置文件：

```text
/Users/jinhuilv/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml
/Users/jinhuilv/Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml
```

执行后：

1. 保持 `wpsjs debug` 或 `wpsjs debug --server --port 3889` 运行。
2. 完全退出 WPS。
3. 重新打开 WPS 文字。
4. 打开任意文字文档。
5. 在“加载项 / 可用加载项”启用 `lingxi-ai`。
6. 顶部功能区应出现 `灵犀AI`。

## 在 WPS 中使用

1. 打开 WPS 文字。
2. 打开任意文档。
3. 在顶部功能区找到 `灵犀AI`。
4. 点击 `打开灵犀AI`。
5. 点击 `Sign in with ChatGPT`。
6. 浏览器授权完成后，复制回调 URL 或 `code`。
7. 粘贴到插件中的 Authorization Code 输入框。
8. 点击“使用 Code 换取 Token”。
9. 选择模型、处理范围和操作类型。
10. 点击“生成预览”。
11. 检查结果后选择“插入到光标”或“替换选区”。

如果点击登录后浏览器没有弹出，插件会显示授权链接或复制到剪贴板，请手动粘贴到系统浏览器打开。

## 模型列表说明

插件优先通过 Codex 兼容模型接口获取模型列表：

```text
https://chatgpt.com/backend-api/codex/models
```

如果该接口不可用，再尝试 OpenAI 模型列表接口：

```text
https://api.openai.com/v1/models
```

如果接口失败，则使用内置 Codex 模型列表：

- `gpt-5.4`
- `gpt-5.3-codex`
- `gpt-5.3-codex-spark`
- `gpt-5.2-codex`
- `gpt-5.1-codex`
- `gpt-5.2`

模型区域的“刷新”按钮会触发接口获取；若接口失败，会自动回退到内置 Codex 模型。

## 打包

WPS 桌面端可使用：

```bash
cd plugin
wpsjs build
```

发布版：

```bash
cd plugin
wpsjs publish
```

如果需要 zip 包，并要求 `index.html` 位于压缩包根路径：

```bash
(cd plugin && zip -r ../lingxi-ai-plugin.zip .)
```

检查压缩包内容：

```bash
unzip -l lingxi-ai-plugin.zip
```

正确结构应在根路径直接看到 `index.html`。

## 关键实现说明

- [plugin/index.html](plugin/index.html:1) 是 WPS 加载项入口页。
- [plugin/main.js](plugin/main.js:1) 统一加载桌面端所需脚本。
- [plugin/taskpane.html](plugin/taskpane.html:1) 是灵犀AI业务 UI。
- [plugin/ribbon.xml](plugin/ribbon.xml:1) 定义顶部功能区入口。
- [plugin/js/wps-addon-adapter.js](plugin/js/wps-addon-adapter.js:1) 提供 `OnAddinLoad`、`OnAction`、`GetImage` 等 Ribbon 回调。
- [plugin/js/auth.js](plugin/js/auth.js:1) 负责 OAuth 登录、PKCE、Token 持久化与刷新。
- [plugin/js/openai.js](plugin/js/openai.js:1) 负责 Responses API 请求和 SSE 流式解析。
- [plugin/js/wps.js](plugin/js/wps.js:1) 负责读取选区、读取全文、插入和替换文档内容。

## 注意事项

- 当前运行目标是 WPS 桌面客户端，不是 WebOffice。
- 桌面端默认不加载金山文档 Addon SDK，避免出现“当前页面必须嵌入在 weboffice 页面中”的错误。
- 前端不会保存 OpenAI API Key。
- Codex OAuth 是非官方复用方案，若 OpenAI 调整授权策略，可能需要更新 OAuth 配置。
- OpenAI Responses API 是否接受当前 OAuth Token，以真实接口返回为准。
