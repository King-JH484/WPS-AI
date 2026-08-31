# Plan: WPS 最小运行时修复

## Objective

在本机恢复历史会话注入与 DOCX 主入口，并消除 Anthony AI 代理进程的设置回写高占用，同时保持 PDF 冷启动贴靠侧窗方案不变。

## Requirements

- 历史窗口选择会话后必须切换主聊天内容。
- 无用户操作时不得持续重写 provider settings。
- DOCX 功能区必须显示可点击的主入口。
- PDF 冷启动继续使用现有独立贴靠侧窗。
- 不覆盖用户已有未提交修改。

## Assumptions

- 当前 WPS 版本支持 `Application.PluginStorage`；不可用时走 localStorage 兼容回退。
- Ribbon 修改需要完全重启 WPS 才能排除缓存影响。

## Milestones

| Status | Milestone | Deliverable | Acceptance Check |
|---|---|---|---|
| Complete | 规格与失败证据 | 设计、根因记录、失败测试 | 测试稳定重现三项缺陷及多面板边界 |
| Complete | 最小代码修复 | PluginStorage 邮箱、幂等模型选择、普通尺寸入口 | 37 项定向测试通过 |
| Complete | 本机部署 | 更新 `~/.anthony-ai` 运行目录并重启服务/WPS | 运行时资源与仓库源码一致 |
| Complete | 实机验收 | PDF 历史、DOCX 入口、CPU/SQLite 采样 | 全部验收项通过 |
| Complete | 经验沉淀 | WorkspaceD 复利/踩坑记录与索引 | 检索索引重建成功 |

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-08-28 | PDF 冷启动保留贴靠侧窗 | 用户暂时接受；PDF 宿主未暴露原生 CreateTaskPane |
| 2026-08-28 | 历史跨窗通信使用 PluginStorage | WPS 官方用于同一加载项多页面共享，localStorage 事件实测不可靠 |
| 2026-08-28 | 通过幂等写入消除 CPU 回路 | 修复触发源，不以延长轮询掩盖问题 |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| WPS WebView 的 PluginStorage 兼容差异 | 历史选择仍不能注入 | 同一轮询检查 PluginStorage/localStorage，并实机验收 |
| 多个主面板同时轮询同一邮箱 | 非目标文档抢走请求 | 消费前匹配 docKey；不匹配不删除；30 秒 TTL 清理陈旧请求 |
| Ribbon 缓存 | 误判入口修改无效 | 全退 WPS 后重新启动并核对运行时 XML |
| 多页面仍有其他无条件设置写入 | CPU 只部分下降 | 同时观察 SQLite 更新时间戳和 40 秒 CPU 样本 |

## Verification

- Node 定向测试：双存储历史 IPC、多面板匹配与 TTL、模型选择幂等、Writer 专属 Ribbon 尺寸。
- 运行相关现有测试：provider settings、ribbon callbacks、minimal PDF repair。
- 运行完整测试集与 lint（若存在既有失败，单独记录并确认与本修复无关）。
- 本机 WPS 手动流程：DOCX 打开侧栏；PDF 打开历史并切换会话；冷启动 PDF 保持贴靠侧窗。
- 按完整命令行锁定 `proxy-server.js` PID，预热后每秒采样 40 次；读取 SQLite provider settings 的 `__updatedAt`，确认静止期全程不变化。

## Change Log

- 2026-08-28：创建计划，记录用户确认的 PDF 冷启动边界。
- 2026-08-28：完成历史双存储邮箱、设置幂等写入和 Writer Ribbon 修复；部署本机后实测通过。
- 2026-08-28：两轮 40 秒采样分别为平均 0.12% 与 0.01% CPU，provider settings 的 `__updatedAt` 全程不变。
- 2026-08-28：完整测试 701 项中 693 通过、1 跳过、7 个既有失败；本次相关 37 项全通过。ESLint 因本地未安装依赖未执行。
