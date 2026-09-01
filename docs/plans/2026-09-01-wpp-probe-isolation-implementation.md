# Plan: WPP 写探针隔离与防卡死

## Objective

让普通母版创作永远不会误触图表或阻塞型 ChartData 诊断，同时保留按领域、显式授权、可审计的模板与图表对象真机探针。

## Requirements

- 模板写探针不调用 `AddChart/AddChart2/ChartData.Activate`。
- 图表对象探针独立，且不访问 ChartData Workbook。
- 诊断工具按 `template_probe` / `chart_object_probe` 分域授权。
- schema 隐藏之外，registry 执行层和 MCP 层必须再次 fail closed。
- 五类 provider 不能在 planner、初始 fallback 或 resolver 失败时暴露不安全工具。
- capability evidence 按领域和完整平台/版本身份合并。
- 动态工具包仍支持普通工具同轮升级，不形成永久限制。
- Mac 12.1.25867 不再通过普通模型工具执行 ChartData 探针。

## Assumptions

- 当前卡死仅发生在 `/tmp` 测试副本，已安全关闭。
- 已验证的 Mac capability 报告保持有效；本次不重新运行 ChartData Workbook。
- Windows 仍需目标机独立探测，不复用 Mac 状态。

## Milestones

| Status | Milestone | Deliverable | Acceptance Check |
|---|---|---|---|
| Complete | M1 诊断授权契约 | 分域、肯定、不可变 turn authorization；否定语句拒绝 | `node --test test/wpp-tool-packs.test.js` |
| Complete | M2 执行与 MCP 门禁 | registry fail closed；MCP 不导出/不执行诊断工具 | 新增 registry/MCP 回归测试 |
| Complete | M3 Provider 安全快照 | planner、初始 snapshot、失败回退均从安全工具集开始 | 五 provider 动态工具测试 |
| Complete | M4 探针领域拆分 | template 与 chart_object 独立执行、独立清理；无 ChartData 自动调用 | `node --test test/wpp-native-probe.test.js` |
| Complete | M5 证据与图表数据边界 | 领域局部 merge、版本隔离；data 检查早于 AddChart | capability/chart 测试 |
| Complete | M6 文档与部署 | Windows 交接、平台报告、项目记录；本机四变体部署 | 静态门禁、health、哈希和日志检查 |
| In progress | M7 真机回归 | WPP 新变体与功能区已加载，CPU/RSS 正常；普通母版聊天发送待人工 UI 确认 | Mac 测试副本人工流程、CPU/RSS 采样 |

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-09-01 | 保留模板探针旧公开名 | 兼容既有交接文档与调用记录 |
| 2026-09-01 | 新增独立 chart object probe | 消除模板探针的跨领域副作用 |
| 2026-09-01 | 不公开 ChartData 写探针 | Mac 同步调用可能不可取消地阻塞 WPS |
| 2026-09-01 | MCP 不导出 diagnosticOnly | schema 隐藏不能充当执行安全边界 |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 诊断关键词误判 | 普通任务误获授权 | 分域肯定组合、否定词拒绝、执行层复核 |
| provider fallback 泄露全工具 | 绕过动态过滤 | 初始安全 snapshot；首次失败直接终止 |
| 领域报告覆盖其他证据 | capability 状态倒退或误授权 | assessedDomains + 局部 capability merge |
| WPS 同步 JSAPI 不可取消 | UI 再次卡死 | 普通工具路径移除已知阻塞调用，不依赖 Promise timeout |
| Windows 能力不同 | Mac 修复误限 Windows | Windows 独立证据；后续适配器单独设计 |

## Verification

- `cd /Users/Anthony/.local/github/WPS-AI/plugin && node --test test/wpp-tool-packs.test.js test/provider-dynamic-tools.test.js test/wpp-native-probe.test.js test/wpp-native-chart.test.js test/wpp-capability-matrix.test.js`
- 新增 registry/MCP diagnostic gate 测试。
- 变更文件 ESLint、`git diff --check`。
- Windows 迁移契约与静态包门禁。
- 完整 `node --test test/*.test.js`，既有失败与新增失败分开记录。
- 永久安装态 3889/3890 health、源码/安装文件哈希、临时探针标志扫描。
- Mac 普通母版请求只运行创作/读取工具；日志必须出现成对 `tool.start/tool.end`。

## Change Log

- 2026-09-01：根据已批准并独立审查通过的设计创建实施计划。
- 2026-09-01：完成 M1–M6；本机 12 条路由与关键文件哈希通过，Node 采样为 0.0% CPU。Computer Use 点击 WPS 内嵌功能区时桥接断连，M7 保留一次人工聊天发送确认，不以自动化断连冒充产品结论。
