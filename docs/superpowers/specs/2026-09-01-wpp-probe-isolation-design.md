# WPP 写探针隔离与防卡死设计

## 1. 问题与证据

2026-09-01，用户在专用测试演示中要求制作母版。模型启用 `template_native` 后调用 `wpp_probe_native_write_capabilities`。该工具名和描述只强调版式、占位符、母版形状和按版式加页，但底层 `probe({mode:"write"})` 还无条件执行：

1. `Shapes.AddChart2` 创建图表；
2. 修改 `ChartType`；
3. `ChartData.Activate()`；
4. 访问嵌入式 `Workbook` 并写数据。

因此普通母版任务出现了图表。运行日志在 `2026-09-01T01:39:19.290Z` 记录该工具 `tool.start` 后没有 `tool.end`；WPS 进程持续存在。机器有 24GB 内存、检查时系统可用内存约 42%，Anthony AI LaunchAgent 的 active/inactive memory limit 均为 unlimited，两个 Node 进程远低于 100MB RSS。本次问题不是内存上限，而是不可取消的 WPS 同步原生调用卡在工具 Promise 内。

## 2. 目标

- 普通母版/模板创作不能看见或自动调用破坏性写探针。
- 模板写探针绝不创建图表，也不调用 `ChartData.Activate()`。
- 图表对象探针与模板探针独立执行、独立报告和独立清理。
- Mac 12.1.25867 已知不安全的 ChartData Workbook 探针不再通过常规模型工具暴露。
- `supported/degraded/unverified` 证据仍按 capability 独立记录，拆分不能虚假提升能力。
- 现有正常母版、版式和原生图表创作工具名称保持兼容。

## 3. 方案选择

采用“领域拆分 + 显式诊断可见性”方案。

不采用单工具 `scope` 参数：模型仍可能在母版任务中选择 chart scope，而且工具描述继续混合两类副作用。不采用独立 WPS 实例运行全量探针：隔离成本高，且不能解决普通对话错误暴露诊断工具的问题。

## 4. 工具可见性

工具注册元数据新增 `diagnosticOnly: "template_probe" | "chart_object_probe"`。授权在每轮开始时仅从该轮原始用户输入计算为不可变 `diagnosticAuthorization`，模板和图表分别授权，不存在“全部诊断”通配权限。

只有明确、肯定的领域诊断请求才授权。例如“请运行母版能力探针”“测试原生图表对象接口”。以下内容均不授权：单独出现“探针”、文件名包含 `test/probe`、引用/转述诊断文字、模型后续文字、工具结果、对话历史，以及包含“不要/禁止/别/无需/不运行”等否定词的请求。

允许识别的领域词与诊断词为：

- 模板领域：`母版/模板/版式/master/template/layout`；
- 图表对象领域：`原生图表/图表对象/native chart/chart object`；
- 诊断动作：`运行/执行/开始/测试/run/execute/test` 与 `探针/能力测试/接口测试/probe/capability test/interface test` 的肯定组合。

`wpp_enable_tool_pack` 只启用领域包，不能创建、扩大或修改 `diagnosticAuthorization`。模板探针授权不能暴露图表探针，反之亦然。

schema 可见性不是安全边界。`registry.execute()` 在调用任何 `diagnosticOnly` 工具前必须核对执行上下文中的不可变授权和工具要求的领域；缺失、过期、领域不符一律 fail closed。通用 MCP 的 `listAll()` 不导出这些诊断工具，MCP executor 也必须拒绝按名称直接调用；未来若需要开发者诊断通道，另行设计带本地显式确认和短期凭据的入口。

只读的 `wpp_probe_native_capabilities` 保持始终可见，因为它不修改文档。破坏性模板和图表写探针标记为 `diagnosticOnly`。

五类 provider 在任何 planner 或模型子调用前都只能接收过滤后的安全 snapshot。resolver 的初始 fallback 也必须由安全过滤结果构造，不能以 `allTools` 初始化；首次解析失败直接 fail closed，只有已有成功安全 snapshot 时才允许一次沿用。该约束同时适用于 OpenAI Chat、OpenAI Responses、Codex、Anthropic 和 Gemini。

## 5. 探针职责拆分

### 5.1 模板写探针

保留公开名 `wpp_probe_native_write_capabilities` 以兼容已有交接文档，但将描述改为“模板结构写探针”，并精确标记 `diagnosticOnly:"template_probe"`。执行器调用：

```js
probe({
  mode: "write",
  domains: ["template"],
  expectedDocumentId,
  sandboxConfirmed: true
})
```

只执行：

- `CustomLayouts.Add/Delete`；
- `Shapes.AddPlaceholder/Delete`；
- `Slides.AddSlide/Delete`；
- `SlideMaster.Shapes.AddShape/Delete`。

不得调用任何 `AddChart`、`ChartData`、主题应用或文件导出接口。

### 5.2 图表对象写探针

新增 `wpp_probe_native_chart_capabilities`，属于 `chart_native`，标记 `risk:"destructive"` 和 `diagnosticOnly:"chart_object_probe"`。执行器调用 `domains:["chart_object"]`，仅验证：

- 原生图表创建；
- Chart 对象读取；
- `ChartType` 更新；
- 图表删除与集合恢复。

它可以临时新增一页承载探针图表，但必须自行清理，不依赖模板探针生成的页面。

### 5.3 ChartData Workbook

不新增模型可调用的 ChartData 写探针。Mac 12.1.25867 的真机报告继续将 `wpp.chart.native.data` 标为 degraded。其他平台先通过受控开发诊断或新增可隔离/可取消适配器取得证据，再单独设计公开探针。

普通 `wpp_native_chart_create/update` 仍在执行前要求 `wpp.chart.native.data=supported`；没有证据时 fail closed，不回退 PNG 冒充原生数据图表。

带 categories/series 的 create/update 必须在调用 `AddChart/AddChart2` 或读取 `ChartData` 前完成 data capability 检查。仅修改已有图表类型或标题可以在 `wpp.chart.native.update=supported` 且不传 data 字段时继续；创建工具当前 schema 强制要求数据，因此 data 不支持时不得创建半成品。

## 6. 执行与错误处理

- 写探针继续要求 `sandboxConfirmed=true`、精确 `expectedDocumentId`，且文件名包含 `probe/test/测试/sandbox`。
- `domains` 由工具 handler 固定传入，不交给模型自由填写。
- 每个领域拥有自己的临时对象和 `finally` 清理边界。
- 每份写报告包含 `assessedDomains`，且 `capabilities` 只列本次实际评估的键。模板报告只包含 master/layout/placeholder/add-from-layout；图表对象报告只包含 chart create/read/update/delete；未评估的键不得以 unverified 写入报告。
- `recordEvidence()` 只合并报告明确列出的证据。用于授权查询的完整 key 为 capability + adapter + platform + CPU architecture + WPS version/build + plugin version；任一字段不同都视为没有当前证据。模板探针失败不影响图表证据，图表探针失败不覆盖模板证据；两个执行顺序结果必须相同。
- 报告中的 probe ID、时间戳和文档 ID 属于审计 provenance，不参与跨文档 capability 授权 key；platform、architecture、adapter、WPS build 和 plugin version 都是授权隔离字段，变化后不得沿用旧 supported。
- 由于同步 WPS JSAPI 调用无法由 JavaScript Promise timeout 中断，任何已知可能阻塞的原生调用都不得放入普通对话探针。

## 7. 回归测试

1. “制作母版”自动启用 `template_native`，但看不到两个 destructive diagnostic 工具。
2. “请运行母版能力探针”只授权模板写探针；“不要运行母版探针”“文档名是 probe-test”“刚才提到探针”均不授权。
3. 图表对象诊断必须取得独立肯定授权；模板授权后启用 `chart_native` 仍看不到、也不能直接执行图表探针。
4. `registry.execute()` 无授权、错领域、过期 turn context 均拒绝；通用 MCP 不列出且不能执行诊断工具。
5. 五类 provider 的 planner、首次 snapshot 和 resolver 失败路径都不暴露诊断工具或未启用包；已有安全 snapshot 的单次回退仍保持相同安全边界。
6. 普通领域包可在同一工具循环升级，非诊断工具不受影响；新 turn 按新输入重算，不继承上一轮限制或授权。
7. 模板写探针通过 mock，并断言 `AddChart/AddChart2/ChartData.Activate` 调用次数为 0。
8. 图表对象探针单独验证 create/read/update/delete，断言不读取 `ChartData`。
9. 两类探针分别验证集合恢复和 `cleanupVerified=true`；先模板后图表、先图表后模板的证据结果一致，领域内清理失败只降级本领域。
10. data capability 不支持时，带数据 create/update 在 `AddChart/AddChart2/ChartData.Activate` 前拒绝；类型/标题-only update 仍按独立 update capability 执行。
11. 平台、adapter 或 WPS build 改变后旧证据不能授权新环境。
12. 相关风险门测试和 Windows 迁移契约继续通过。

## 8. 部署与验收

修复后只部署干净的四宿主永久变体。重新打开同一测试副本：

1. 输入普通母版制作请求，确认模型工具清单没有写探针且不会插入图表；
2. 输入明确的模板能力探针请求，确认只出现模板临时对象并全部清理；
3. 不在 Mac 普通 UI 中运行 ChartData Workbook 探针；
4. 检查日志中每个工具均有成对 `tool.start/tool.end`；
5. 采样 WPS、renderer、静态服务和代理 CPU/RSS，确认无持续异常。

Windows 交接文档同步改为分别运行模板探针和图表对象探针，并明确禁止自动测试 ChartData Workbook。
