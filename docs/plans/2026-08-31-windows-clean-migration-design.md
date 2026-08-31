# Anthony AI Windows 干净迁移与 Codex 交接设计

## 1. 目标

将安装过品牌更换前版本（灵犀AI / LingxiAI）的 Windows 电脑，迁移为仅运行当前 `King-JH484/WPS-AI` 仓库版本的 Anthony AI 环境。

本次迁移明确采用“彻底清空”策略：不迁移旧 API Key、模型配置、历史会话、缓存、日志或其他旧运行状态。

## 2. 非目标

- 不删除或重装 WPS Office 本体。
- 不修改用户的 Word、Excel、PowerPoint、PDF 文档。
- 不删除 `publish.xml` 中第三方 WPS JS 加载项。
- 不删除与 Anthony AI / 灵犀AI 无关的 Node.js、计划任务、注册表项或目录。
- 不宣称未经 Windows 真机执行的安装包已经完成验收。

## 3. 当前仓库交付前置条件

交给朋友电脑前，仓库必须满足：

1. 本机已完成的 PDF 历史会话、PDF 路径探测、DOCX 入口、provider 设置写入和 proxy CPU 修复已提交并推送。
2. Windows 安装、卸载脚本只选择性增删本项目的 `publish.xml` 条目。
3. 旧品牌清理覆盖：
   - `%USERPROFILE%\.lingxi-ai`
   - `%ProgramFiles%\LingxiAI` 及对应实际 Inno 安装目录
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LingxiAI`
   - 计划任务 `LingxiAI`
   - `lingxi-launcher.exe`
   - 命令行或可执行路径明确位于旧目录的相关进程
   - `publish.xml` 中 `lingxi-ai-*` 条目
4. 当前品牌清理覆盖旧的失败安装，确保重装前不存在冲突的 `AnthonyAI` 任务、Run 项、进程或 `.anthony-ai` 状态目录。
5. 提供受控的四宿主存储清理入口，删除 WebView `localStorage` 和 WPS PluginStorage 中属于两品牌的设置、凭据、历史与缓存键，不删除整个 WPS 用户数据目录。
6. 安装器元数据、仓库链接和用户可见品牌均指向 Anthony AI / `King-JH484/WPS-AI`。
7. Windows 构建脚本保持 cmd.exe 可执行的编码与 CRLF 行尾。
8. 构建前静态检查所有安装脚本引用的文件存在且进入安装包；任何清理、注册或探活失败都必须向 Inno Setup 返回非零。

## 4. 安全边界

朋友电脑上的 Codex可以在本任务范围内执行管理员命令，但必须遵守：

- 删除前先用只读命令解析出精确目标；不得对 `%USERPROFILE%`、`%APPDATA%`、`%ProgramFiles%`、磁盘根目录或通配符目标执行递归删除。
- 只终止命令行、可执行路径或已解析安装位置明确属于 `LingxiAI` / `AnthonyAI` 的进程。
- 关闭 WPS 前先提示用户保存未保存文档；不强杀带未保存内容的 WPS 进程。
- 修改 `publish.xml` 前生成临时副本，解析并保留所有非 `lingxi-ai`、非 `anthony-ai` 条目；修改后进行 XML 解析验证。
- 调用任何历史卸载器前，必须把 `publish.xml` 复制到插件目录之外，并用 XML 解析器保存第三方节点的完整语义快照；解析或快照校验失败时立即中止。
- 日志不得输出 API Key、Authorization 头、OAuth token、完整 provider 配置或其他凭据。
- 旧配置无需备份；但删除动作仍须记录精确路径和执行结果，以便审计。
- 无关异常不得通过扩大删除范围处理。
- 删除目录前必须规范化绝对路径，并拒绝磁盘根、用户根、系统目录、过短路径、通配符、未展开环境变量和 reparse point/junction/symlink。
- 卸载注册表目录必须同时通过 AppId、显示名/发布者、卸载器及预期插件文件交叉验证；不得直接执行未经解析的 `UninstallString`，不得使用 `Invoke-Expression`。
- 删除计划任务、Run 值或终止进程前，必须验证其 Action、值数据、可执行路径或命令行指向已确认的产品根目录，不能只凭任务名或 `node.exe` 进程名。
- 提权前固定实际使用 WPS 的目标用户 SID、Profile、AppData 和会话 ID。管理员权限只用于受保护安装目录；用户注册表操作使用 `HKEY_USERS\<SID>`，不得依赖提权进程的 `HKCU`。
- 存在多个交互会话或无法唯一确认 WPS 用户时必须中止并让现场用户确认，不能选择“最新 explorer.exe”猜测。

## 5. 仓库修复设计

### 5.1 本机修复入库

只提交本轮确认属于产品修复的源文件、测试和设计文档。不得顺带提交用户已有的 `DEBUG-PDF-PATH.md`、`TEST-STATUS.md` 或 `dist-permanent/`。

提交前运行相关测试与完整测试；完整测试中若有既有失败，必须列出并确认与本次改动无关。

### 5.2 Windows 安装入口统一

Windows 的推荐交付路径为：

1. 朋友电脑克隆指定仓库。
2. 核验 `origin` 和指定提交 SHA。
3. 在 Windows 本机使用仓库内置 Node 运行时和 Inno Setup 6 构建安装器。
4. 运行新构建的安装器。

手动永久安装入口必须与 GUI 安装器使用同一套核心安装逻辑，不能继续生成另一套旧式 Run/VBS 服务架构。

### 5.3 新旧 Inno 安装迁移

旧安装器与当前安装器曾共用 AppId `{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}`，Inno Setup 默认可能恢复旧安装目录。新安装必须避免把 Anthony AI 继续安装到 `LingxiAI` 目录。

仓库安装器明确设置 `UsePreviousAppDir=no`，固定安装到目标 WPS 用户的 `%LOCALAPPDATA%\Programs\AnthonyAI`，不再让 `{autopf}` 因提权方式改变安装范围。

迁移器枚举目标 SID 的 HKCU、HKLM 以及 32/64 位卸载注册表视图，按 AppId、旧显示名和实际 `InstallLocation` 识别历史安装。朋友电脑必须先完成旧版卸载，确认旧卸载项和旧目录均消失，再运行新安装器；只要旧卸载失败、同 AppId 仍登记或目标目录仍为旧品牌目录，新安装就必须中止。

Windows 真机验收必须包含“安装旧 Lingxi 版本 → 执行迁移 → 安装 Anthony AI”的升级用例，确认最终只有一个 Anthony AI 卸载项、一个新目录和一个有效卸载器。

### 5.4 `publish.xml`

所有 Windows 安装/卸载入口调用同一个 PowerShell XML DOM 修改器，统一遵循：

- 安装：保留第三方条目，按 `name` 属性精确移除旧的 `lingxi-ai-*` 和现有 `anthony-ai-*`，再写入四个当前条目。
- 卸载：只移除上述两个品牌的条目；若无其他条目才删除文件。
- 原文件无法解析时立即中止，不得覆盖。
- 修改通过同目录临时文件完成，解析复验后原子替换。
- 第三方保护比较完整节点语义，包括名称、类型、URL、属性和子节点，不能只比较数量。
- 测试夹具覆盖多行节点、注释、非 ASCII、不同属性顺序和第三方哨兵条目。

不得再通过 `findstr` 按行拼 XML，也不得删除整个文件完成卸载。

### 5.5 品牌扫描

品牌扫描分为两类：

- 允许保留：卸载兼容逻辑、迁移文档、许可证中的旧品牌事实。
- 必须修复：UI、安装器显示名、默认安装目录、当前任务/服务名、当前配置路径、下载链接、仓库链接、构建产物名和面向用户的安装说明。

旧品牌兼容字面量不能全局替换。

### 5.6 四宿主存储清理

彻底删除不仅包括文件目录，还包括 WPS WebView 与 PluginStorage。仓库需提供只执行清理、不加载聊天或 provider 状态的专用清理页/模式，并在 Word、Excel、PowerPoint、PDF 四宿主分别执行：

- 删除 `lingxi_*`、`__lingxi_*` 和已盘点确认属于旧品牌的键。
- 删除本次要求彻底重装所覆盖的 `anthony_*`、`__anthony_*` 设置、provider、历史、缓存和邮箱键。
- 清理对应 WPS PluginStorage 键并立即持久化。
- 不清空整个 localStorage，不删除整个 WPS WebView 用户数据目录。
- 清理后重开各宿主复检，确认旧 provider、凭据和会话不会回灌新 SQLite。

清理器使用显式键清单/前缀白名单并记录键名，不记录键值。

### 5.7 失败关闭与完成标记

- 构建门禁扫描所有 `.bat`、`.ps1`、`.iss` 的本地脚本引用，确认文件存在且包含在安装包中。
- 清理旧进程、更新 XML、构建变体、注册任务、启动服务、静态端口探活、代理探活和四宿主路由探活任一步失败都返回非零。
- Inno Setup 必须捕获 post-install 返回码；失败时显示失败并不得生成成功标记。
- 成功标记包含目标 SID、提交 SHA、安装路径、内置 Node 路径、实际端口和每项探活结果。
- 仅存在 `publish.xml` 或端口监听不能作为安装成功依据。

## 6. 朋友电脑 Codex 执行流程

### 阶段 A：只读盘点

记录：

- Windows 版本、架构、PowerShell 版本、Git、WPS 版本与安装位置。
- 当前登录交互用户、SID、Profile、AppData、会话 ID 与管理员状态；若有多个交互会话则停止自动处理。
- 相关卸载注册表项及其 `InstallLocation` / `UninstallString`。
- `LingxiAI` / `AnthonyAI` 计划任务、Run 项、进程命令行、端口占用。
- `.lingxi-ai`、`.anthony-ai` 和精确安装目录。
- WPS `publish.xml` 的位置与第三方条目清单。

### 阶段 B：彻底清理

1. 提示保存并完全退出 WPS。
2. 在仍可启动旧同源加载项时，依次进入四宿主的专用清理页，删除两品牌 WebView/PluginStorage 状态并复检。
3. 在产品目录之外备份并解析 `publish.xml`，保存第三方节点语义快照；失败则中止。
4. 使用新迁移清理器注销旧/当前品牌计划任务、Run 项并停止明确属于产品根路径的进程。
5. 旧 uninstaller 只用于删除已验证的旧安装文件和卸载登记；运行后从快照原子恢复/合并第三方节点，再选择性移除两个品牌条目。若旧 uninstaller 不安全或无法拆分，则在保护快照后运行并立即恢复第三方节点。
6. 删除精确解析并通过安全校验的旧/当前状态目录和安装目录。
7. 再次扫描所有卸载注册表视图、目录、存储键、任务、Run 项、进程、端口和加载项条目，确认两品牌运行状态均已清空。

### 阶段 C：获取与构建

1. 克隆 `https://github.com/King-JH484/WPS-AI.git` 到新的明确目录。
2. 验证远端地址、工作树干净状态和交接文档指定的提交 SHA。
3. 验证内置 Windows Node 可执行文件存在且可启动。
4. 安装/定位 Inno Setup 6，在 Windows 本机编译安装器。
5. 记录安装器 SHA-256。

### 阶段 D：安装与机器级验收

1. 运行安装器并核验安装路径不含 `LingxiAI`。
2. 核验安装目录 ACL、计划任务 principal、状态目录和 WPS 运行用户均匹配已固定的目标 SID。
3. 核验只有 `AnthonyAI` 计划任务，无旧品牌任务或 Run 项。
4. 核验后台进程命令行只指向 `.anthony-ai` 或 Anthony AI 安装目录。
5. 读取实际选中的静态/代理端口并探活。
6. 核验 `wps`、`et`、`wpp`、`pdf` 的 manifest、ribbon 和入口页路由。
7. 核验 `publish.xml` 恰有四个 Anthony AI 条目、零个 Lingxi AI 条目，且第三方节点完整语义保持不变。
8. 核验成功标记中的 SID、提交 SHA、路径、Node、端口和探活结果与现场一致。
9. 注销或重启 Windows 一次，确认正确用户登录后 `AnthonyAI` 能启动且 `LingxiAI` 不会复活。

### 阶段 E：WPS 功能验收

分别新建或打开非重要测试文件，验证：

- Word：可见 Anthony AI 标签和入口，侧栏可打开。
- Excel：标签、侧栏和宿主识别正常。
- PowerPoint：标签、侧栏和宿主识别正常。
- PDF：彻底关闭 WPS 后直接打开指定测试 PDF，冷启动采用当前已接受的无边框贴靠侧窗；移动、缩放、关闭跟随正常，路径识别正常。
- 历史：旧历史应为空；新建会话后关闭侧栏和 WPS，再打开同一文档，确认新历史能够恢复。
- 设置：新增 provider、保存、重启后读取正常；使用测试凭据时不得写入交接日志。
- CPU/内存：分别记录 WPS 打开但空闲、面板打开、WPS 关闭三种状态各 5 分钟的均值、峰值和内存趋势；WPS 关闭超过 `IdleSeconds + 15 秒` 后产品 Node 进程必须消失。
- 第三方 `publish.xml` 哨兵在旧卸载、新安装、当前卸载、重装四个阶段均保持语义一致。

任何一项未通过，Codex 应停在诊断与最小修复循环中，不得把状态报告为完成。

## 7. 最终交付报告

朋友电脑上的 Codex 最终必须报告：

- 仓库 URL、提交 SHA、安装器 SHA-256。
- 目标用户 SID、Profile、会话 ID以及安装目录 ACL 检查。
- 删除的旧任务、Run 项、目录和加载项条目。
- 保留的第三方 WPS 加载项数量。
- 两品牌 WebView/PluginStorage 键名复检结果（不含键值）。
- Anthony AI 安装路径、任务动作、运行时路径和端口。
- 所有卸载注册表视图复检结果和成功标记内容。
- 自动化测试和四宿主人工验收结果。
- CPU/内存观察结果。
- 注销/重启后冷启动结果。
- 未解决问题、日志路径及是否需要回滚。

只有清理复检、机器级验收和四宿主验收全部通过，才可声明“正常使用”。
