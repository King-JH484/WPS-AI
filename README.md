# 灵犀AI（v1.0.0:beta）

WPS Office 多宿主 AI 助手插件，覆盖 **WPS 文字 / 表格 / 演示** 三端。一个面板调三家 AI（Codex/OpenAI 兼容/Anthropic）+ 一个图像 provider，AI 通过工具调用直接读写文档。

> 安装步骤见 [INSTALL.md](INSTALL.md)。本文档介绍能力、架构、配置和二次开发。

## 功能一览

### 三端通用
- **统一 AI 面板**：单个 TaskPane 兼容三个宿主，自动识别当前是文字 / 表格 / 演示
- **多 provider 切换**：
  - **Codex**（ChatGPT OAuth + PKCE）—— 复用 ChatGPT Plus 用户的会话
  - **OpenAI 兼容端点** —— 自定义 baseURL + API Key（适配 DeepSeek、Kimi、阿里千问、本地 Ollama 等）
  - **Anthropic Claude** —— 直连或代理
  - **图像 provider**（toapis 协议）—— GPT-Image-2 异步任务
- **流式输出 + tool-use 循环**：AI 一次对话内可连续调多个工具操作文档
- **双模式**：
  - **预览确认模式** —— AI 先生成结果，你确认后再插入/替换
  - **AI 直接写入模式** —— AI 调工具直接改文档（默认安全栏：调多了会停）
- **快捷键**：Enter 发送 / Shift+Enter 换行 / Cmd-Ctrl+Enter 兼容
- **对话打断**：长任务跑过头随时点停止
- **markdown→Word 原生格式**：AI 输出的 Markdown 写回 Word 时按 Word 原生样式渲染（标题层级 / 加粗 / 列表 / 代码块 / 表格）

### 文字（WPS Writer）
- **6 组快捷按钮**：写作（帮我写 / 续写 / 扩写 / 缩写）/ 改写（重写 / 帮我改）/ 润色（快速润色 / 更学术 / 更活泼 / 更正式 / 党政风 / 口语化 / 全文润色）/ 翻译（中文 / 英文）/ 总结（全文总结 / AI 排版）/ 智能（AI 生成图片 / 文档脑图 / 文档问答 / 智能推荐操作）
- AI 工具：读写选区 / 段落 / 全文，插入图片，插入表格，应用样式

### 表格（WPS Spreadsheet）
- 单元格读写、范围批量、格式化
- 自动调整高列宽、表格美化样式（带预设主题）
- 数据透视、列筛选辅助
- AI 生成公式、转表、批量校对

### 演示（WPS Presentation）
- **12 套带设计理念的色板**（每套带灵感来源）：
  - Bold Signal · Pitch Deck/主题演讲（Apple keynote 风）
  - Electric Studio · 工作室作品集（R/GA + Pentagram）
  - Creative Voltage · 复古活力（Eames + Massimo Vignelli）
  - Dark Botanical · 高端品牌（Hermès + RH catalog）
  - Notebook Tabs · 评测报告（Field Notes + Moleskine）
  - Pastel Geometry · 产品介绍（Stripe Atlas + Memphis）
  - Split Pastel · 创意机构（Spotify Wrapped 美学）
  - Vintage Editorial · 个人品牌（Wes Anderson + Vogue 老调）
  - Neon Cyber · 科技初创（Apple Vision Pro 克制霓虹）
  - Terminal Green · Dev 工具（GitHub Dark + 终端绿）
  - Swiss Modern · 企业汇报（Helvetica + Müller-Brockmann）
  - Paper & Ink · 深度叙事（Penguin Classics 文人气）
- **方案 A 模板**（纯形状拼，全可编辑）：cover-split / cover-band / section-fullbleed / content-sidebar / stat-hero / quote-block / two-column / closing-thanks
- **方案 B 视觉模板**（SVG 渲染图作背景，文字仍可编辑）：v-cover-gradient / v-section-modern / v-stat-bigtype / v-content-modern
- **6 类数据可视化图表**（SVG → PNG → AddPicture 链路，配色跟主题色板）：bar / donut / line / radar / gauge / heatmap
- **大纲生成 PPT**：贴大纲 → 自动选模板生成全套
- **统一风格**：现有 PPT 一键统一字体/色板/装饰/动画 + 适合页插图表
- **去 AI 味**：AI 改写让生成内容更自然
- ribbon 快捷键：AI 生成 PPT / 大纲生成 / 封面 / 单页 / 多页 / 配图 / 帮我写 / 帮我改 / 扩写 / 缩写 / 润色 / 校对 / 演讲稿 / 智能推荐

## 安装

两种模式，详见 [INSTALL.md](INSTALL.md)：

| 模式 | 适合 | 一句话 |
| --- | --- | --- |
| **永久安装** | 长期使用 | 双击 `install-permanent-windows.bat` / `bash install-permanent-mac.sh`，三个 WPS 应用一次到位，开机自启 |
| **开发调试** | 临时试用、二次开发 | `npm run dev:wps` / `dev:et` / `dev:wpp`，每次只能给一个宿主 |

## 配置 AI Provider

第一次打开 AI 助手面板，点右上角 ⚙ 设置：

### Codex（ChatGPT OAuth）
- 直接点「Sign in with ChatGPT」走浏览器授权
- 走 PKCE 流程，回调 `code` 复制粘贴到面板
- Token 持久化到 localStorage，不退出登录就一直保持

### OpenAI 兼容
- 任何 OpenAI Chat Completions 协议的端点都行：DeepSeek / Kimi / 阿里通义 / 本地 Ollama / OpenAI 官方
- 默认走本地 CORS 代理 `127.0.0.1:3890`（不能直连国外 API 时必需）

### Anthropic Claude
- 默认 `https://api.anthropic.com/v1`
- 推荐 `claude-sonnet-4-6` 或 `claude-opus-4-7`

### 图像 Provider
- 当前对接 toapis.com 异步任务协议（GPT-Image-2）
- AI 在文档里插图时自动调用

## 项目结构

```text
plugin/
├── index.html                       # WPS 加载项入口页（空 body，加载 main.js）
├── main.js                          # 统一脚本加载器，按 URL 决定是否加载 app.js
├── taskpane.html                    # 业务 UI 全部在这
├── ribbon.xml                       # 顶部功能区（按 addonType 由 gen-ribbon.js 生成）
├── manifest.json                    # 插件声明（addonType / version）
├── package.json                     # wpsjs 项目配置 + npm 脚本
├── css/style.css                    # UI 样式
├── images/                          # icon SVG（ai.svg + 12 个分类线性图标）
├── js/
│   ├── app.js                       # 业务 UI 编排（chat / settings / quick actions）
│   ├── auth.js                      # Codex OAuth + PKCE
│   ├── markdown-render.js           # Markdown → HTML（聊天展示）
│   ├── markdown-to-word.js          # Markdown → Word 原生格式（写回文档）
│   ├── openai.js                    # provider 门面（按当前激活 provider 调用）
│   ├── quick-actions.js             # 各宿主快捷按钮元数据 + ribbon 生成源
│   ├── wps-addon-adapter.js         # OnAddinLoad/OnAction/GetImage 等 ribbon 回调 + TaskPane 创建
│   ├── wps.js                       # 多宿主分发 + 统一文档读写 API
│   ├── providers/
│   │   ├── registry.js              # provider 注册表 + 设置存储 + COLOR_SCHEMES（12 套主题）
│   │   ├── sse.js                   # SSE 通用流式解析
│   │   ├── codex.js                 # Codex provider
│   │   ├── openai.js                # OpenAI 兼容 provider
│   │   ├── anthropic.js             # Anthropic provider
│   │   └── image.js                 # 图像生成 provider
│   ├── hosts/
│   │   ├── writer.js                # WPS 文字桥接（Selection/Range）
│   │   ├── spreadsheet.js           # WPS 表格桥接（Worksheets/Range/Cells）
│   │   └── presentation.js          # WPS 演示桥接（Slides/Shapes/TextFrame）
│   └── tools/
│       ├── registry.js              # 工具注册表（按宿主分组）
│       ├── common.js                # 通用工具
│       ├── writer.js                # 文字工具
│       ├── spreadsheet.js           # 表格工具
│       ├── presentation.js          # 演示工具（含 wpp_render_chart / 12 主题 / 模板 A B）
│       └── image.js                 # 图像生成工具
└── tools/
    ├── proxy-server.js              # CORS 代理 + /upload-image（端口 3890）
    ├── serve-permanent.js           # 永久模式静态服务器（端口 3889）
    ├── build-variants.js            # 生成 plugin-wps/-et/-wpp 三宿主变体
    ├── dev.js                       # 跨平台并发跑 proxy + wpsjs debug
    ├── gen-ribbon.js                # 按 addonType 从 quick-actions.js 生成 ribbon.xml
    ├── set-addon-type.js            # 切换 addonType（wps/et/wpp）
    └── install-mac-publish.js       # macOS WPS Container 配置补写脚本
```

## 二次开发

### 调试模式启动
```bash
cd plugin
npm install
npm run dev:wps   # 或 dev:et / dev:wpp，切换宿主
```
会同时拉起 CORS 代理（3890）和 wpsjs debug（3889），WPS 自动唤起。改完 JS 直接刷新 TaskPane 看效果。

### 加新工具
所有 AI 可调用工具集中注册在 `js/tools/<host>.js`。模板：
```js
registry.registerTool({
  name: "wps_my_tool",
  hosts: ["wps"],         // 或 ["wps","et","wpp"]
  description: "...",     // 这里写得越清楚 AI 越知道何时调
  parameters: { type: "object", properties: { ... }, required: [...] },
  handler: async (params) => {
    // 真实操作 wps-jsapi
    return { ok: true, ... };
  }
});
```
Provider 实现侧自动把这些工具暴露给 AI。

### 加新 ribbon 按钮
编辑 `js/quick-actions.js` 加条目，再跑 `npm run gen-ribbon` 重生成 `ribbon.xml`。

### 加新色板主题
编辑 `js/providers/registry.js` 的 `COLOR_SCHEMES` 加一项，并在 `js/app.js` 的本地 `COLOR_SCHEMES` mirror 同步颜色。

### 永久模式重新打包
```bash
cd plugin
node tools/build-variants.js --out C:/path/dist-permanent
```

## 已知限制

- **WPS 桌面客户端专用**，WebOffice 不支持
- **Mac WPS WKWebView**：永久模式重装后偶尔需要清 WebKit 缓存（详见 INSTALL.md Q7）
- **wpsjs debug 一次只能注册一个宿主**：调试时切宿主要 `npm run dev:et` 重启
- **永久模式 publish.xml 路径硬编码**：不同 WPS 版本若改了 jsaddons 路径要手动更新安装脚本
- **Codex OAuth 是非官方复用方案**，OpenAI 调整授权策略时可能要更新 client_id
- **图像 provider 协议绑定 toapis**，要换其他图像服务需要在 `providers/image.js` 加适配

## 反馈

发现 Bug 请附：
- 系统 + WPS 版本
- 哪个宿主、哪个工具触发
- 控制台报错（在 TaskPane 内右键 → 检查 / 「打开JS调试器」）
- `~/.lingxi-ai/server.log` 后 50 行（永久模式）

## 更新日志摘要（v1.0.0:beta）

`git log --oneline` 完整历史。主要里程碑：

- **永久安装**：build-variants + serve-permanent + 三宿主同时注册 + 自启
- **数据可视化**：6 类 SVG 图表，配色跟主题色板，darkMode 自适应
- **设计主题**：12 套带设计理念色板，每套带灵感来源
- **方案 B 视觉模板**：渐变封面 / 现代分章 / 大数字 / 现代内容
- **方案 A 形状模板**：8 套高频商用版式
- **统一风格 / 去 AI 味**：PPT 一键统一 + 自然化改写
- **多 provider + tool-use**：Codex / OpenAI / Anthropic 三家通用
- **markdown→Word 原生格式**：AI 输出按 Word 样式渲染
- **双模式**：预览确认 / AI 直接写入
- **多 bug 修复**：Mac Gatekeeper / GBK 编码 / CRLF 行尾 / WKWebView 缓存 / vbs 自启等
