# 灵犀AI · WPS Office 多宿主 AI 助手

**🌐 语言 / Language**: **中文** · [English](README.en.md)

一个 TaskPane 兼容 **WPS 文字 / 表格 / 演示 / PDF** 四端，挂多家 AI（Codex / OpenAI 兼容 / Anthropic）+ 一家图像 provider，AI 通过工具调用直接读写文档。

> 🤖 100% 由 Claude vibe coding 完成：架构、provider 适配、PPT 主题/图表、Word 渲染、跨平台安装器、文档全程由 [Claude](https://claude.com/claude-code) 和人类对话迭代而来。仓库里没有一行手敲代码 —— 也欢迎你 fork 自己 vibe。

---

## 截图

| WPS 文字 | WPS 表格 | WPS 演示 |
|---|---|---|
| ![](img/1.png) | ![](img/2.png) | ![](img/3.png) |

---

## 5 分钟跑起来

### 1. 下载安装包

| 平台 | 安装包 | 大小 |
|---|---|---|
| **Windows** | [`lingxi-ai-1.3.0-setup.exe`](https://github.com/lewis-hui1202/WPS-AI/releases) | ~30 MB |
| **macOS** | [`lingxi-ai-1.3.0.pkg`](https://github.com/lewis-hui1202/WPS-AI/releases)（双击直接装） | ~35 MB |

两个包都内置了 Node 运行时，**无需单独装 Node**。

### 2. 安装

- **Windows**：先临时关掉杀软实时防护 → 双击 setup.exe → 完全退出 WPS → 重开 WPS，ribbon 出现「灵犀AI」标签即成功
- **macOS**：**右键 .pkg → 打开**（Gatekeeper 拦未签名包，双击会报错）→ 输系统密码 → 完全退出 WPS → 重开 WPS

详细步骤（卸载 / 升级 / 故障排查 / 安装器构建）见 [INSTALL.md](INSTALL.md)。

### 3. 配置 AI 模型

1. ribbon 点「打开灵犀AI」→ TaskPane 右侧弹出 → ⚙ 设置（独立 960×720 弹窗）
2. 「聊天模型」面板 → **+ 新增供应商** → 12 条预设里选一家（baseURL 已预填）
3. 填 API Key → ⚡ 测试 → 关弹窗 → header 下拉挑模型开聊

**可同时挂多家**：DeepSeek + Anthropic + Codex + Kimi 一起开，下拉里随时切。

| 预设 | baseURL（预填） |
|---|---|
| **Codex（ChatGPT OAuth）** | （OAuth） |
| **Anthropic** / **OpenAI** | `api.anthropic.com` / `api.openai.com` |
| **DeepSeek** / **Kimi** / **Qwen** | DeepSeek / Moonshot / DashScope 兼容地址 |
| **GLM** / **豆包** / **硅基** / **OpenRouter** | 各家 OpenAI 兼容协议地址 |
| **本地 Ollama** | `http://localhost:11434/v1`（免 Key） |
| **自定义** | URL + Key 自填 |

#### 系统要求

| 项 | Windows | macOS |
|---|---|---|
| **操作系统** | Windows 10 / 11 (x64) | macOS 10.15 Catalina+ (Intel + Apple Silicon) |
| **WPS** | WPS Office 12.x+ | WPS Office 5.x+ |
| **运行时** | 内置便携 Node 22.x | 内置 darwin-x64 + arm64 Node |
| **权限** | 默认装到用户目录 | 安装时输系统密码（写 `/Library/Application Support/LingxiAI/`） |

不支持 WebOffice、移动端 WPS、低版本桌面客户端 —— JSAPI 加载项要求桌面客户端 + 上述最低版本。

---

## 功能一览

### 四端通用

**AI 接入**
- 同时挂多家 chat provider（Codex / Anthropic / OpenAI 兼容 11 家 + 自定义），header 下拉按 provider 分组
- 模型旁三个能力图标：🖼 图像 / 📄 PDF / 💡 思考
- 思考强度可调（低 / 中 / 高 / 关），按 provider 映射到 `thinking.budget_tokens` / `reasoning_effort` / `reasoning.effort`
- PDF 当多模态附件喂大模型，Claude 走 document block / OpenAI 走 Files API / Codex 走 input_file
- 流式输出 + tool-use 循环：一次对话内连续调多个工具操作文档
- **预览确认模式** vs **AI 直接写入模式**：两档安全

**TaskPane 体验**
- 设置 / PPT 风格预设独立成 WPS dialog 窗口，脱离 TaskPane 宽度限制
- 一键脱离 / 停靠：浮动窗口 8 个边角带 resize 抓手
- 弹窗按屏幕分辨率自适应（小屏不再溢出）

**对话**
- 多对话管理 + 历史完整回放（推理 + 工具调用 + 文本回复）
- 工具调用气泡像 Claude Code：默认仅显示尾部参数预览，结果到达即消失；可在设置里打开开发者日志看完整 JSON
- 进度条带最近输出尾段
- AI 工作期间文档锁定 banner + 进度合并（不再视觉重叠）
- 附件支持：图片 / PDF / 文本文件
- 系统提示词可定制；支持「技能」(内置 4 套 + 导入 .md/.txt) 按场景拼到 system prompt

**操作安全**
- AI 工作期间硬锁文档（Word `Document.Protect` / Excel `UserInterfaceOnly`）
- 临时文档拒绝修改（聊天前先 fail-fast，避免等 AI 输出完才提示）
- per-turn 文档备份 + 一键回退（自动 GC 最近 20 份）
- 改动记录 Tab：按文件分组，展开看入参/前后快照/错误
- 配置导入导出（API Key 加密 + 版本号兼容）

### 文字 / 表格 / 演示 / PDF

| 宿主 | 能力速览 |
|---|---|
| **文字** | 6 组快捷按钮（写作 / 改写 / 润色 / 翻译 / 总结 / 智能）+ markdown→Word 原生格式（真表格 + 嵌套列表 + 段落缩进强制清零） |
| **表格** | 单元格/范围读写、批量格式化、表格美化、列宽自适应、AI 生成公式 / 转表 / 校对 |
| **演示** | 12 套带设计理念的色板 + 8 套形状模板 + 4 套 SVG 视觉模板 + 6 类数据可视化图表 + 大纲生成 PPT + HTML 模板系统（freeform + ECharts + 分图层插入）+ 统一风格 + 去 AI 味 |
| **PDF** | 对照翻译（markdown 原文/译文表格）+ 全文总结 + 文档生成 PPT 大纲 + PDF 问答 + 智能推荐操作 |

### MCP 服务（v1.4 新增）

设置 → MCP 服务 → 开启后把 WPS 工具暴露给外部 agent（Claude Code CLI / Claude Desktop / Cursor 等）：
- 配置 JSON 一键复制（自动填好 plugin 安装路径）
- 工具按宿主分组显示
- 实时状态徽章（已连接 / 已开启未连接 / 未启用）

---

## 项目结构

```text
plugin/
├── taskpane.html                  # 业务 UI 入口
├── main.js                        # 脚本加载器
├── manifest.json / ribbon.xml     # 插件声明 + ribbon
├── css/style.css
├── js/
│   ├── app.js                     # 业务 UI 编排
│   ├── wps.js / hosts/*           # 宿主分发 + 各宿主 jsapi 桥接
│   ├── providers/*                # provider 注册表 + 12 条预设 + capabilities
│   ├── tools/*                    # AI 可调用工具（按宿主分组 + registry）
│   ├── html-templates/*           # 模板系统（cache / components / renderer / studio）
│   ├── mcp-bridge.js              # MCP 桥（plugin 侧）
│   └── skills.js                  # 技能（内置 + 导入）
└── tools/
    ├── proxy-server.js            # CORS 代理 + 文件 / 备份 / MCP 端点
    ├── mcp-server.js              # stdio MCP server (供外部 agent 用)
    ├── serve-permanent.js         # 永久模式静态服务器
    ├── build-variants.js          # 多宿主变体打包
    └── dev.js / gen-ribbon.js
```

---

## 二次开发

```bash
cd plugin
npm install
npm run dev:wps   # 或 dev:et / dev:wpp / dev:pdf
```

会同时拉起 CORS 代理（3890）和 wpsjs debug（3889），WPS 自动唤起。

**加新工具** —— 编辑 `js/tools/<host>.js`：
```js
registry.registerTool({
  name: "wps_my_tool",
  hosts: ["wps"],                // 或 ["wps","et","wpp","pdf"]
  description: "...",            // 越清楚 AI 越知道何时调
  parameters: { type: "object", properties: { ... }, required: [...] },
  handler: async (params) => ({ ok: true, ... })
});
```

**加新 ribbon 按钮** —— 编辑 `js/quick-actions.js`，跑 `npm run gen-ribbon`。

**永久模式打包** —— `node tools/build-variants.js --out C:/path/dist-permanent`。

---

## 已知限制

- WPS 桌面客户端专用，Web/Mobile WPS 均不支持
- Mac WPS WKWebView 永久模式重装后偶尔需要清 WebKit 缓存（详见 [INSTALL.md](INSTALL.md) Q7）
- wpsjs debug 一次只能注册一个宿主，调试切宿主要重启
- Codex OAuth 是非官方复用方案，OpenAI 调整授权策略时可能需更新 client_id
- 图像 provider 协议绑定 toapis，换其他服务需在 `providers/image.js` 适配

---

## 反馈

发现 Bug 请附：
- 系统 + WPS 版本
- 哪个宿主、哪个工具触发
- 控制台报错（TaskPane 内右键 → 检查 / 「打开 JS 调试器」）
- `~/.lingxi-ai/server.log` 后 50 行（永久模式）

---

## 更新日志

完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

- **v1.4**（开发中）：HTML 模板系统（freeform + ECharts + 分图层插入）/ 技能 / MCP 服务 / 响应式弹窗 / PPT 风格预设独立窗口
- **v1.3**：PDF 宿主 / 多供应商管理 / 设置弹窗化 / TaskPane 自由布局
- **v1.2.1**：多对话管理 / 改动记录 / 文档锁定 / 配置加密
- **v1.1**：永久安装升级 / Mac WKWebView 缓存修复 / IME 输入兼容
- **v1.0**：首版（永久安装 / 12 主题 / 6 图表 / 多 provider）
