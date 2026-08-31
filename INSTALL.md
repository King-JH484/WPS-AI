# Anthony AI 插件安装指南

Anthony AI 是一款 WPS Office 加载项，覆盖 **文字 / 表格 / 演示 / PDF** 四端，提供 AI 写作、润色、翻译、排版、文档问答、生成图片、本地抠图等能力，支持接入 Codex / OpenAI / Anthropic 等多家模型。

支持平台：Windows、macOS、Linux（均需先安装 WPS Office）。

## Windows 安装（当前 fork）

1. 克隆 `https://github.com/King-JH484/WPS-AI.git`。
2. 安装 Inno Setup 6。
3. 双击 `plugin\install-permanent-windows.bat`，脚本会运行静态门禁、构建并启动安装器。
4. **完全退出并重开 WPS**，分别验证文字、表格、演示和 PDF 顶部出现「Anthony AI」。
5. 首次使用：打开「Anthony AI」面板，在设置里配置模型 provider。

品牌更换前安装过“灵犀AI”的电脑不得直接覆盖安装，应先按照仓库内 Windows 干净迁移交接文档完成旧服务、旧存储和旧安装目录清理。

## 其他平台

macOS 和 Linux 的源码构建与安装入口保留在 `installer-mac/`、`installer-linux/` 和 `plugin/` 对应脚本中。不同平台的安装结果必须在目标系统真机验收，不能用 macOS 测试替代 Windows 验收。

## 反馈

发现问题请通过 [GitHub Issues](https://github.com/King-JH484/WPS-AI/issues) 反馈，并附上系统、WPS 版本、触发场景和去敏后的日志。不得公开 API Key、OAuth token 或完整 provider 配置。
