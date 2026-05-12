# 灵犀AI（v1.2.1:beta）

WPS Office 多宿主 AI 助手插件，覆盖 **WPS 文字 / 表格 / 演示** 三端。一个面板调三家 AI（Codex/OpenAI 兼容/Anthropic）+ 一个图像 provider，AI 通过工具调用直接读写文档。

> 🤖 **100% 由 Claude 进行 Vibe Coding 完成**：本项目从架构设计、provider 适配、wps-jsapi 封装、12 套 PPT 主题、6 类 SVG 图表、markdown→Word 渲染、双平台安装器（Inno Setup + pkg/dmg），到 README/INSTALL 文档，全程由 [Claude](https://claude.com/claude-code)（Claude Code CLI + Opus / Sonnet 模型）配合人类提示词节奏 vibe coding 出来。仓库里没有一行代码是"手敲"的，全靠和 AI 来回对话迭代。也欢迎你 fork 下来自己 vibe 着改。

> 5 分钟跑起来直接看 [快速开始](#快速开始傻瓜-3-步)。卸载、升级、故障排查、安装器构建在 [INSTALL.md](INSTALL.md)。

## 效果预览

> 三个宿主的 ribbon + 侧边 TaskPane 实拍：

**WPS 文字（Writer）—— AI 助手面板 + 6 组快捷按钮**

![灵犀AI 在 WPS 文字里的样子](img/1.png)

**WPS 表格（Spreadsheet）—— 表格美化 / 自动调宽 / 智能推荐**

![灵犀AI 在 WPS 表格里的样子](img/2.png)

**WPS 演示（Presentation）—— AI 生成 PPT / 大纲转 PPT / 统一风格 / 去 AI 味**

![灵犀AI 在 WPS 演示里的样子](img/3.png)

## 快速开始（傻瓜 3 步）

不想看长文档？照着下面三步走，5 分钟跑起来：

### 1. 下载安装包

| 平台 | 安装包 | 大小 |
| --- | --- | --- |
| **Windows** | `dist/lingxi-ai-1.2.1-beta-setup.exe` | ~30MB |
| **macOS** | `dist/lingxi-ai-1.2.1-beta-mac.dmg`（里面是 `.pkg`） | ~35MB |

> 两个安装包都内置了 Node 运行时，**不需要单独装 Node.js**。

### 2. 安装

**Windows 用户**：
1. **先关闭杀毒软件 / Windows Defender 实时防护**（未签名 exe 会被误杀，安装完成后可重新打开）
2. 双击 `lingxi-ai-1.2.1-beta-setup.exe`，一路「下一步」即可
3. **完全退出 WPS**（任务栏右下角 WPS 图标右键退出），重新打开 WPS 文字 / 表格 / 演示
4. 顶部 ribbon 出现「灵犀AI」标签页 = 成功

**Mac 用户**：
1. 双击 dmg，打开后看到「灵犀AI 安装器.pkg」
2. **右键 .pkg → 打开**（未签名版本被 Gatekeeper 拦时这样开），警告弹窗里再点「打开」
3. 按向导一路下一步，中途输一次系统密码
4. **完全退出 WPS** → 重新打开任意 WPS 应用，顶部出现「灵犀AI」= 成功

> 详细步骤、卸载、升级、故障排查见 [INSTALL.md](INSTALL.md)。

### 3. 在设置里配置 AI 模型

1. 打开 WPS 文字/表格/演示中任意一个，点 ribbon 上的 **「打开灵犀AI」** 按钮，右侧 TaskPane 弹出
2. 点 TaskPane 右上角 **⚙ 设置**，切到 **「设置」** Tab
3. 选一种 provider 配置（任选其一即可，可同时配多个，header 下拉切换）：

   | Provider | 怎么配 |
   | --- | --- |
   | **Codex（ChatGPT OAuth）** | 点「Sign in with ChatGPT」走浏览器授权，把回调 code 粘回来就行 |
   | **OpenAI 兼容**（DeepSeek / Kimi / 通义 / Ollama 等） | 填 `baseURL` + `API Key` + 模型名，比如 DeepSeek 用 `https://api.deepseek.com/v1` + `deepseek-chat` |
   | **Anthropic Claude** | 填 API Key，模型推荐 `claude-sonnet-4-6` 或 `claude-opus-4-7` |
   | **图像 Provider（toapis）** | 想让 AI 在文档里插图才需要，填 toapis 的 key |

4. 保存后回到「AI 助手」Tab，header 下拉里选刚配好的模型，输入框打字开聊 —— 让 AI 直接读写文档就行了。

> 配置完想换 provider？header 上的下拉随时切，不用重新登录。

## 功能一览

### 三端通用

**AI 接入**
- **统一 AI 面板**：单个 TaskPane 兼容三个宿主，自动识别当前是文字 / 表格 / 演示
- **多 provider 切换**：
  - **Codex**（ChatGPT OAuth + PKCE）—— 复用 ChatGPT 用户的会话
  - **OpenAI 兼容端点** —— 自定义 baseURL + API Key（适配 DeepSeek、Kimi、阿里千问、本地 Ollama 等）
  - **Anthropic Claude** —— 直连或代理
  - **图像 provider**（toapis 协议）—— GPT-Image-2 异步任务，**实时显示生图百分比 + 已用秒数**
- **流式输出 + tool-use 循环**：AI 一次对话内可连续调多个工具操作文档
- **双模式**：
  - **预览确认模式** —— AI 先生成结果，你确认后再插入/替换
  - **AI 直接写入模式** —— AI 调工具直接改文档（默认安全栏：调多了会停）

**对话体验**
- **多对话管理**：自动按每段对话存档，「+ 新对话」开新的、「📑 历史」下拉切回去继续。本地 localStorage 持久化，重启 WPS 不丢
- **历史完整回放**：切回旧对话能完整看到当时的过程 —— 你的提问、AI 推理、工具调用与结果、AI 文本回复
- **纯净模式**：右上角眼睛图标切换，隐藏工具调用 / 推理过程，只看 AI 的自然语言回复
- **AI 处理进度条**：聊天输入框上方实时显示 AI 当前在干什么（思考 / 推理 / 执行某工具 / 生成回复），生图时显示百分比填充
- **快捷键**：Enter 发送 / Shift+Enter 换行 / Cmd-Ctrl+Enter 兼容；中文输入法候选时按 Enter 不误发
- **对话打断**：长任务跑过头随时点圆形停止按钮
- **附件支持**：聊天输入框 ➕ 图标上传图片或文本文件给 AI 当参考（图片支持 png/jpg/gif/webp，文本支持 txt/md/csv/json/js 等多种；单文件 ≤ 5MB；自动检测模型是否多模态，非多模态时图片自动忽略并提示）
- **系统提示词配置**：设置里可定制 AI 的全局回答风格（默认配了一套"简洁直接、不堆 emoji、不带 AI 套话、直接调工具改文档"的规则，可一键重置）

**操作安全 / 改动追踪**
- **AI 工作期间锁定文档**：调工具期间通过 `Document.Protect`（Word）+ `Worksheet.Protect(UserInterfaceOnly=true)`（Excel）硬锁，用户输入不进文档；工具调用前后自动解锁/重锁。锁用固定 token，启动时自动清理残留卡锁
- **临时文档拒绝操作**：AI 修改型工具调用前检测文档是否已存盘，未存盘直接拒绝并提示用户先 Ctrl-S
- **改动记录 Tab**：每次 AI 对文档的修改都记一条（按文件分组，只看当前文件的）。展开看入参、改动前后快照、错误信息（弹窗显示，scroll 完整）
- **per-turn 文档备份 + 一键回退**：每轮 AI 对话开始时自动备份当前文档到 `~/.lingxi-ai/backups/<doc>/<时间>.<ext>`；不满意可一键恢复到本轮前的状态；自动 GC 保留最近 20 份
- **配置导入/导出**：API Key 等敏感字段加密（`enc:v1:` 前缀 + XOR 混淆）；带版本号，导入时自动检测兼容性，老版本配置无 version 视为 `0.0`

**渲染 / 写入**
- **markdown→Word 原生格式**：AI 输出的 Markdown 写回 Word 时按 Word 原生样式渲染 —— 标题层级 / 加粗 / 列表 / 代码块 / **真表格**（带边框 + 表头浅灰底 + AutoFit）/ 嵌套列表（按字符单位缩进）；段落级缩进强制清零（含中文 Word 专有的 `CharacterUnitFirstLineIndent`，根治"扩写后段首 16 字符缩进"）
- **聊天内 markdown 渲染**：支持标题 / 加粗 / 代码块 / 表格（聊天气泡里也是真 `<table>` 渲染）

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

## 更新日志

### v1.2.1:beta（当前）

围绕"AI 操作可控、过程可追溯、UI 更顺手"做了一大批改动。

**对话 / UI 体验**
- 多对话管理 + 顶部「+ 新对话」/「📑 历史」入口，按对话独立 localStorage 持久化
- 历史对话回放完整应答过程（推理 + 工具调用 + 结果 + 文本回复）
- 纯净模式（眼睛切换）：隐藏工具调用 / 推理块，只看 AI 文本回复
- 聊天进度条：实时显示 AI 当前在干什么（思考 / 推理 / 执行某工具 / 生成回复）
- 输入框改两层布局：上 textarea / 下工具栏（左 ➕ 上传、右 ↑ 发送 / ◼ 停止），去掉"清空"按钮
- 附件上传：图片 + 文本文件，自动检测模型多模态能力，非多模态时图片自动忽略并提示
- pill 按钮全 SVG 化（历史 / 纯净模式 / 推理标记），移除装饰性 emoji

**改动可追溯**
- 「改动记录」Tab：每次 AI 对文档的修改按文件分组、按对话回合折叠
- 详情用弹窗展示（不再内联折叠，scroll 完整可读），含入参 / 改动前后快照 / 错误
- per-turn 文档级备份：每轮 AI 对话自动 `fs.copyFile` 当前文档到 `~/.lingxi-ai/backups/`
- 「↶ 恢复本轮」一键回退：关 doc → 覆盖文件 → 重开
- 改动记录跟磁盘文件挂钩：切换文档自动过滤；空态文案区分三种（未保存 / 当前文件无记录 / 默认）

**安全 / 可靠性**
- AI 工作期间锁定文档：Word `Document.Protect(wdAllowOnlyReading)` + Excel `Worksheet.Protect(UserInterfaceOnly=true)`，PPT 用 banner + 选区轮询警告兜底
- 锁定用**固定 token**（`lingxi-ai-doc-lock-v1`），启动时自动清理残留卡锁
- 临时文档（未存盘）拒绝 AI 修改型操作，提示用户先 Ctrl-S
- 配置导出版本化 + API Key 加密：导入时检测版本兼容，老版本无 version 视为 `0.0`

**生图 / 写回**
- 生图进度实时显示：解析 toapis 任务状态的 progress 字段，进度条切到确定模式按 % 静态填充
- markdown→Word 表格支持：真 Word 表格（`Tables.Add`）+ 表头加粗浅灰底 + AutoFit
- markdown 嵌套列表：按字符单位缩进
- 修扩写段首 16 字符缩进 bug：`resetParagraph` 同时清 pt 单位和**中文字符单位**两套缩进

**设置 / 提示词**
- 系统提示词字段：默认配了一段"简洁直接、不堆 emoji、不带 AI 套话、直接调工具改文档"规则，可一键重置；用户改的内容会以"用户偏好（优先级高于上述默认规则）"形式追加进每轮 system message

### v1.1.0:beta

- **永久安装升级流程**：重跑 install 自动停旧服务，避免文件锁
- **macOS WKWebView 缓存修复**：server 加 `no-store` 严格禁缓存 + HEAD 请求不发 body
- **Mac taskpane 宽度自适应**：CSS + JS 双管同步 body 到 pane 实际宽度
- **聊天输入框快捷键**：Enter 发送、Shift+Enter 换行（中文 IME 候选时按 Enter 不误触发）
- **打包 / 文档**：截图等临时文件不再误打入 zip；INSTALL.md 加完整升级章节 + 8 条 FAQ；README 重写

### v1.0.0:beta（首版）

主要能力：
- **永久安装**：build-variants + serve-permanent + 三宿主同时注册 + 开机自启
- **数据可视化**：6 类 SVG 图表，配色跟主题色板，darkMode 自适应
- **设计主题**：12 套带设计理念色板，每套带灵感来源
- **方案 B 视觉模板**：渐变封面 / 现代分章 / 大数字 / 现代内容
- **方案 A 形状模板**：8 套高频商用版式
- **统一风格 / 去 AI 味**：PPT 一键统一 + 自然化改写
- **多 provider + tool-use**：Codex / OpenAI / Anthropic 三家通用
- **markdown→Word 原生格式**：AI 输出按 Word 样式渲染
- **双模式**：预览确认 / AI 直接写入
- **多 bug 修复**：Mac Gatekeeper / GBK 编码 / CRLF 行尾 / WKWebView 缓存 / vbs 自启等
