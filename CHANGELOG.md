# 更新日志 / Changelog

> 历史版本的详细发布说明。最新版本概览见 [README](README.md#更新日志)。

## v1.3.0

围绕"PDF 宿主 + 多供应商管理 + 设置弹窗化 + TaskPane 自由布局"的大版本。

### PDF 宿主接入
- 新增第四个宿主 WPS PDF（addonType=pdf），ribbon 上独立「灵犀AI」标签，安装时自动注册 plugin-pdf 变体
- AI 工具：`pdf_get_info` / `pdf_read_document`（带 maxPages/maxChars 控量）/ `pdf_read_page`
- 三个开箱即用快捷操作：**对照翻译**（原文 | 译文 markdown 表格逐段对齐 + 页码标记）/ **全文总结**（一句话概括 + 要点 + 结论 + 可追问问题）/ **文档生成 PPT**（提炼大纲 → 复制到 WPS 演示用大纲生成 PPT 一键配色）
- 附 PDF 问答 + 智能推荐操作
- **PDF 当多模态附件**：WPS Office 整合阅读模式下 jsapi 拿不到 PDF 文本，改走"把整个文件 base64 化喂大模型"路径 —— proxy 新增 `/load-local-file` + `/openai-file-upload` 端点；Anthropic 走 document content block / OpenAI 走 Files API / Codex 走 input_file
- 多版本兼容：ActivePDF / ActivePdf / ActivePDFDocument 四种命名兜底

### 多供应商 + 模型能力
- 数据模型从单 active provider 改成 `chatProviders[]` 数组，可**同时挂多家**（Codex + Anthropic + 多家 OpenAI 兼容并存）；老结构 `providers.codex/openai/anthropic` 自动迁移
- 12 条预设供应商：Codex / Anthropic / OpenAI / DeepSeek / Kimi / 通义千问 / 智谱 / 豆包 / 硅基 / OpenRouter / Ollama / 自定义，新增时弹选单自动填好 baseURL + 默认模型
- header 模型下拉按 provider 分组列出所有 enabled 模型，行内显示 🖼 图像 / 📄 PDF / 💡 思考 三个能力图标（亮=支持，灰=不支持）；当前选中按钮上同样展示 caps
- 每张供应商卡片右上 ⚡ 按钮一键拉取该家真实模型列表写入下拉缓存
- 模型能力按 model id 模式判断（`capabilities.js`）：图像 / PDF / 思考；OpenAI 兼容协议不接受 `type:"file"` 的（DeepSeek/Kimi/Qwen/GLM）从 supportsPdf 白名单移除，避免错误请求
- 思考强度可调：聊天工具栏 💡 chip 点击循环低/中/高/关，按 provider 协议映射：Anthropic `thinking.budget_tokens` 1024/4000/16000，OpenAI `reasoning_effort`，Codex `reasoning.effort`

### 设置弹窗 + TaskPane 布局
- 设置从 Tab Bar 拆出 → **独立 960×720 dialog**（`Application.ShowDialog ?mode=settings`），脱离 TaskPane 宽度限制
- 左侧侧栏 4 个分类：聊天模型 / 生图模型 / 统一配置 / 程序信息
- 每条供应商以可折叠卡片展示，head 上 ⚡ 测试 / ☑ 启用 / ▾ 展开；body 内编辑 baseURL/API Key/默认模型实时持久化
- `storage` 事件双向同步：dialog 窗口里改了 localStorage，主 TaskPane 立刻 reload settings + 重渲模型下拉
- **TaskPane 一键脱离/停靠**：Tab Bar 右侧 ↗ 按钮调 WPS DockPosition；浮动模式 480×720 居中，窗口 8 个边角带 resize 抓手

### 线性图标统一 + UI 收敛
- 全套 emoji（🖼 📄 🧠 📕 ⟳ 等）换成 feather 风格线性 SVG
- 能力 chip 从 header 挪到聊天工具栏，跟附件按钮放一起，"打字前就看到能用啥能力"
- header 简化只剩：模型选择 + 🔄 刷新 + 「就绪」徽章

### 改动追溯优化
- 文档备份恢复加 EPERM/EBUSY/EACCES 退避重试（6 次累计 ~3s），处理 Windows 文件锁释放延迟 + WeChat sandbox 锁
- 关文档后强制等 400ms 再 copyFile；恢复失败也会自动重开原文档，不让用户白屏
- 失败时给清晰指引："文件仍被占用，请关闭微信预览窗口"等

### 工具 schema 修复
- `wps_insert_table` / `wpp_add_table` 二维数组内层 `items` 补 string 类型，strict tool 校验的模型（gpt-4o-2024-08-06+ / gpt-5）不再 invalid_function_parameters

### 安装器
- PDF tab 显示在「开始」左侧（修 serve-permanent 路由正则漏 /pdf/ 的 bug 后，统一 insertBeforeMso=TabHome）
- publish.xml 写入时不再带 `debug=""` 属性
- 版本号 1.2.1-beta → 1.3.0，统一 semver

---

## v1.2.1:beta

围绕"AI 操作可控、过程可追溯、UI 更顺手"做了一大批改动。

### 对话 / UI 体验
- 多对话管理 + 顶部「+ 新对话」/「📑 历史」入口，按对话独立 localStorage 持久化
- 历史对话回放完整应答过程（推理 + 工具调用 + 结果 + 文本回复）
- 纯净模式（眼睛切换）：隐藏工具调用 / 推理块，只看 AI 文本回复
- 聊天进度条：实时显示 AI 当前在干什么
- 输入框改两层布局：上 textarea / 下工具栏
- 附件上传：图片 + 文本文件，自动检测模型多模态能力
- pill 按钮全 SVG 化，移除装饰性 emoji

### 改动可追溯
- 「改动记录」Tab：每次 AI 对文档的修改按文件分组、按对话回合折叠
- per-turn 文档级备份 + 「↶ 恢复本轮」一键回退
- 切换文档自动过滤；空态文案区分三种

### 安全 / 可靠性
- AI 工作期间锁定文档：Word + Excel 硬锁，PPT banner 兜底
- 锁定用固定 token（`lingxi-ai-doc-lock-v1`），启动时自动清理残留卡锁
- 临时文档拒绝 AI 修改型操作
- 配置导出版本化 + API Key 加密

### 生图 / 写回
- 生图进度实时显示
- markdown→Word 真表格、嵌套列表
- 修扩写段首 16 字符缩进 bug

### 设置 / 提示词
- 系统提示词字段：默认配了一段"简洁直接"规则，可一键重置

---

## v1.1.0:beta

- 永久安装升级流程：重跑 install 自动停旧服务，避免文件锁
- macOS WKWebView 缓存修复：server 加 `no-store` 严格禁缓存 + HEAD 请求不发 body
- Mac taskpane 宽度自适应
- 聊天输入框快捷键：Enter 发送、Shift+Enter 换行
- 打包 / 文档：截图等临时文件不再误打入 zip；INSTALL.md 加完整升级章节 + 8 条 FAQ

---

## v1.0.0:beta（首版）

- **永久安装**：build-variants + serve-permanent + 三宿主同时注册 + 开机自启
- **数据可视化**：6 类 SVG 图表，配色跟主题色板，darkMode 自适应
- **设计主题**：12 套带设计理念色板
- **方案 A/B 模板**：8 套形状模板 + 4 套 SVG 视觉模板
- **统一风格 / 去 AI 味**：PPT 一键统一 + 自然化改写
- **多 provider + tool-use**：Codex / OpenAI / Anthropic 三家通用
- **markdown→Word 原生格式**
- **双模式**：预览确认 / AI 直接写入
- **多 bug 修复**：Mac Gatekeeper / GBK 编码 / CRLF 行尾 / WKWebView 缓存 / vbs 自启等
