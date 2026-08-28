# WPS 最小运行时修复设计

## 目标

在不改变 PDF 冷启动现有贴靠侧窗方案的前提下，修复历史会话无法注入、WPS 多页面设置回写导致代理进程持续高占用、DOCX 功能区主入口消失三个问题，并以本机 WPS 实测作为验收依据。

## 已确认边界

- PDF 冷启动继续使用现有独立贴靠侧窗，不尝试通过隐藏 Writer 文档伪造原生 TaskPane。
- Writer、表格、演示宿主仍优先使用 WPS 原生 `CreateTaskPane`。
- 保留当前 SQLite 会话与设置存储，不迁移后端，不新增常驻服务。
- 只修改与三个已复现问题直接相关的代码；保留用户已有未提交改动。

## 根因与设计

### 1. 历史会话选择没有注入主面板

历史窗口通过 `localStorage` 写入选择请求，主 TaskPane 依赖跨 WebView 的 `storage` 事件触发消费。WPS `ShowDialog` 与 TaskPane 的 WebView 没有可靠共享该事件，因此列表可读取 SQLite 数据，但点选后主面板不切换。

修复采用 WPS 官方 `Application.PluginStorage` 作为同一加载项多个页面间的短期消息邮箱：

- 历史窗口将 `{ id, docKey, ts }` 写入 `PluginStorage`。
- 主面板复用已有的 PluginStorage 轮询机制，以低频、可去重方式同时检查 PluginStorage 与 `localStorage`，不再依赖 `storage` 事件才能消费请求。
- 请求携带 `docKey` 和时间戳；只有文档键匹配的主面板才删除并消费，超过 30 秒的陈旧请求由任一面板清理，避免多面板抢消费或崩溃后重放。
- 保留 `localStorage` 读写作为旧 WPS 或 PluginStorage 不可用时的兼容回退。
- 无效 JSON、重复时间戳和已删除会话均安全忽略。

### 2. `/usr/local/bin/node` 持续高 CPU

多个 WPS WebView 接收到设置变更后都会执行模型下拉重建；重建无条件调用 `setActiveChatModel`，随后更新时间戳并持久化完整设置。新的设置写入再次触发其他 WebView，形成循环。

最小修复包含两道幂等保护：

- `setActiveChatModel` 仅在编码后的 provider/model 值真正变化时持久化。
- 设置存储事件只负责加载和渲染；模型选择器重建不得产生无变化写入。

不通过增加定时器间隔掩盖问题，也不移除 SQLite 持久化。

### 3. DOCX 主入口按钮消失

运行日志确认 WPS 已加载 `openWpsAiPane` 的 label、visible、enabled 和 image 回调，但 Writer 的紧凑功能区没有渲染单独的 `size="large"` 控件。其他 Anthony AI 快捷项正常显示。

只将 Writer 的主入口改为普通尺寸控件，PDF、表格和演示保持现有尺寸；保留独立 `anthonyCore` 分组、现有图标、标签和回调。构建生成器是唯一源头，重新生成产物，避免只手改 XML。

## 验收

- PDF：打开历史记录并选择另一条会话，主面板标题和消息内容切换到选中会话。
- DOCX：Anthony AI 功能区可见“打开 Anthony AI”入口，点击后打开或切换原生侧边栏。
- CPU：按完整命令行锁定 `proxy-server.js` PID，预热后每秒采样一次、连续 40 秒；平均 CPU 显著低于旧基线约 24%，且设置记录的 `__updatedAt` 全程不变。
- PDF 冷启动：仍使用现有贴靠侧窗，能打开、跟随主窗口并正常关闭；不要求原生 TaskPane。
- 自动化：覆盖无 `storage` 事件时的双存储轮询、多面板不抢走不匹配请求、模型值未变化时零持久化、Writer 入口为普通尺寸且其他宿主尺寸不变；相关现有测试无回归。

## 风险控制

- PluginStorage 在部分旧宿主可能不可用：保留 localStorage 回退。
- Ribbon 尺寸改变可能影响其他宿主布局：对生成后的 wps/et/wpp/pdf XML 做结构测试，并在 Writer 与 PDF 实机检查。
- WPS 会缓存 Ribbon：部署后必须彻底退出并重新启动 WPS 才验收。
