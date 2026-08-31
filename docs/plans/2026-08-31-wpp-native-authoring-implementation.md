# Plan: WPP 原生专业创作能力

## Objective

为 Anthony AI 建立不限制底层能力的动态 WPP 工具系统，并在 Mac/Windows 可独立分级的能力矩阵上交付母版、版式、占位符、主题、POTX 和原生图表闭环。

## Requirements

- 公共 WPS JSAPI 优先，Mac 与 Windows 允许能力不对称。
- 工具包只减少每轮 schema，不隐藏已实现能力；支持同一工具循环升级。
- 禁止任意 `raw_call`。
- `declared/unverified` 写能力不得冒充已支持。
- 破坏性和覆盖写操作经过独立风险门，不受直接操作模式影响。
- 每个阶段独立测试和 Git 提交。
- 不提交现有 `DEBUG-PDF-PATH.md`、`TEST-STATUS.md`、`dist-permanent/`。

## Assumptions

- 当前 Mac 可用于 WPS 12.1.25867 真机验收。
- 当前没有 Windows 真机执行环境；Windows 首轮交付探针和证据报告，朋友电脑执行后再决定是否实现 COM 适配器。
- WPS 类型声明不是行为证据，只有当前版本真机行为探针可标记 `supported`。
- 若 Mac 关键写接口失败，本计划在阶段 B 停止，不擅自加入 OOXML 写兜底。

## Milestones

| Status | Milestone | Deliverable | Acceptance Check |
|---|---|---|---|
| Complete | A1 元数据与工具包状态 | capability registry、pack catalog、元数据校验、对话/轮次状态 | `node --test test/wpp-tool-packs.test.js` |
| Complete | A2 动态 provider 解析 | 五类 provider 每次迭代重新解析 schema，静态模式兼容 | `node --test test/provider-dynamic-tools.test.js` |
| Complete | A3 风险与副作用分类 | registry risk metadata、始终开启 destructive gate、filesystem audit | `node --test test/tool-risk-gate.test.js test/host-extension-tools.test.js` |
| Complete | B1 能力矩阵与探针 | adapter registry、平台/版本证据、只读/沙箱探针骨架 | `node --test test/wpp-capability-matrix.test.js` |
| Complete | B2 稳定句柄 | Design/Layout/Shape 不透明句柄和 stale/ambiguous 错误；Chart 复用 Shape handle | `node --test test/wpp-native-handles.test.js` |
| Complete | B3 模板原生领域工具 | master fixed-shape/layout/placeholder/theme/add-slide-from-layout；未验证 theme 写入 fail closed | `node --test test/wpp-native-template-tools.test.js test/wpp-native-probe.test.js` |
| Complete | B4 POTX 安全导出 | SaveCopyAs=26、临时文件验证、排他落盘和失败清理 | `node --test test/wpp-potx-export.test.js` |
| Pending | B5 Mac 真机与 Windows 探针交接 | 平台证据报告、Windows 执行指南 | Mac WPS 人工流程 + 报告字段校验 |
| Pending | C1 原生图表 | 柱状、折线、饼/环、散点的创建/读取/更新 | `node --test test/wpp-native-chart.test.js` + Mac WPS 人工检查 |
| Pending | C2 回归与发布验证 | 完整测试、lint、静态扫描、build、最终报告 | 下列 Verification 全部完成或明确记录环境限制 |

## Work Breakdown

### A1. 元数据与工具包状态

1. 新建 `plugin/js/tools/wpp-capabilities.js`，定义唯一 capability registry、adapter 描述和 pack catalog。
2. 新建 `plugin/js/tools/tool-packs.js`，实现：
   - `beginTurn(context)`；
   - `enablePack(context, pack)`；
   - `resolveTools(context, baseDefinitions)`；
   - conversation/turn/host reset；
   - revision、幂等和不可变 snapshot。
3. 扩展 `registry.registerTool` 的元数据规范化；旧工具保持兼容。
4. 为现有 47 个 WPP 工具分组；先按清单批量补元数据，不改公开名称。
5. 新增始终可见的 `wpp_capability_catalog` 和 `wpp_enable_tool_pack`。
6. 在 taskpane 加载顺序中将 capability/pack 文件放在 presentation 工具前。

### A2. 动态 provider 解析

1. `app.js` 创建 `ToolResolutionContext`，保留静态 `tools` 数组作为兼容回退。
2. provider `runWithTools` 增加 `resolveTools/toolContext` 可选参数。
3. 在 OpenAI Chat、OpenAI Responses、Codex、Anthropic、Gemini 的每次请求迭代开始前重新获取不可变 snapshot 并转换 schema。
4. 工具执行上下文传递 `conversationId/turnId/toolRevision`。
5. resolver 连续失败两次才终止；第一次沿用最后成功 snapshot 并发诊断事件。
6. 对显式 WPP 修改能力但零匹配工具调用的情况，增加最多一次内部继续提示。

### A3. 风险与副作用

1. 新建 `WpsAiRiskGate`，对 `destructive` 和允许覆盖的 `filesystem_create` 始终审批。
2. registry 根据 `risk` 决定快照、备份和外部副作用审计，不再只靠工具名。
3. 保持旧 `history.isMutatingTool` 行为兼容，新增 effect 元数据优先路径。
4. 先只把新 WPP 工具完整标注；旧工具由默认规则兼容，避免一次重写 177 个工具。

### B1. 能力矩阵与探针

1. 新建 `plugin/js/hosts/presentation-native.js`，封装 JSAPI 对象获取、平台检测和适配器注册。
2. 只读探针检查对象/方法但只产生 `declared/unverified`；受控写探针才产生 `supported`。
3. 证据按 capability + adapter 保存，缓存键含平台、架构、WPS 版本、插件版本。
4. `wpp_probe_native_capabilities` 默认只读；写探针要求测试文档或显式 `sandbox=true`。

### B2. 稳定句柄

1. 文档 identity 使用 FullName/Name/运行期 nonce 的摘要，不在模型结果中泄漏完整路径。
2. Layout handle 包含 Design/Layout 名称、MatchingName、索引提示和形状指纹。
3. Shape/Chart handle 使用 SlideID + Shape.Id。
4. 所有写操作先解析句柄；stale/ambiguous 结构化失败。

### B3. 模板领域工具

1. `wpp_master_inspect`：读取 Design/Master/Layout/引用关系。
2. `wpp_master_update`：背景、固定形状、页眉页脚和主题关联的已验证子集。
3. `wpp_layout_manage`：list/create/clone/update/reorder/delete；不支持级联删除。
4. `wpp_placeholder_manage`：七类占位符 list/create/update/delete。
5. `wpp_add_slide_from_layout`：只接受有效 layout handle。
6. `wpp_theme_manage`：读取、应用 `.thmx/.potx/.pptx`，不静默改成逐页视觉近似。

### B4. POTX 导出

1. `wpp_template_export` 只使用已验证 `SaveCopyAs` format 26。
2. proxy 增加临时文件、OOXML 结构校验和排他 finalization 小接口。
3. 缺少 SaveCopyAs 支持时 fail closed。
4. 覆盖模式先做可恢复备份并通过 risk gate。

### B5. 平台验收

1. 在 Mac 测试副本运行母版/版式/占位符/主题/POTX 流程。
2. 输出 `docs/platform/wpp-capabilities-mac-<version>.md/json`。
3. 输出 Windows Codex 执行文档和报告模板；所有能力保持 `unverified`，直到朋友电脑回传证据。

### C1. 原生图表

1. 通过 `Shapes.AddChart/AddChart2` 创建原生图表。
2. 封装工作簿/ChartData 写入，并验证 WPS 是否允许在当前平台访问。
3. 支持四类基础图表；失败按类型记录 capability，不用图片兜底冒充。
4. 返回稳定 chart handle，支持 read/update/delete。

### C2. 回归与发布

1. 更新工具描述，明确图片图表与原生图表差异。
2. 更新能力边界和 Windows 交接文档。
3. 运行完整检查并审阅 Git diff，只提交本任务文件。

## Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-08-31 | 采用动态工具包 + 同轮升级，不永久隐藏能力 | 控制 schema 体积且满足需要时可调用 |
| 2026-08-31 | 能力证据按 capability + adapter 保存 | 允许 Mac/Windows 和 JSAPI/COM/OOXML 独立分级 |
| 2026-08-31 | POTX 缺少 SaveCopyAs 时 fail closed | 避免改变当前演示文稿路径和类型 |
| 2026-08-31 | Windows COM 等朋友电脑探针证据后再实现 | 不基于声明和猜测预写平台代码 |
| 2026-08-31 | 删除不支持级联 | 降低引用关系破坏和回滚风险 |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| provider 动态 schema 语义不一致 | 某些模型同轮看不到新工具 | 共用 conformance fixtures，逐 provider 验证请求体 |
| WPS Mac 声明与实现不一致 | 母版/图表写入失败 | 读写探针分离，未验证写能力拒绝执行 |
| 工具元数据使旧宿主回归 | Writer/ET/PDF 工具丢失 | 未提供 resolver 时保持静态数组路径 |
| WPS 对象无稳定 GUID | 重排后误写对象 | 复合指纹、重新解析、stale/ambiguous 拒绝 |
| SaveCopyAs 覆盖文件 | 数据丢失 | 唯一临时文件、排他 finalization、覆盖备份 |
| Windows 无本机环境 | 无法宣称支持 | 提供探针与 `unverified` 报告，不伪造真机结论 |
| 原生图表数据工作簿接口不稳定 | 图表只能创建不能更新 | 各图表类型独立 capability；阶段 C 可按证据降级 |

## Verification

- `cd /Users/Anthony/.local/github/WPS-AI/plugin && node --test test/*.test.js`
- `cd /Users/Anthony/.local/github/WPS-AI/plugin && npm run lint`
- `cd /Users/Anthony/.local/github/WPS-AI/plugin && npm run scan:semgrep:ci`
- `cd /Users/Anthony/.local/github/WPS-AI/plugin && npm run build`
- `git diff --check`
- `git status --short`
- Mac WPS：母版、七类占位符、自定义版式、主题应用、四类原生图表、POTX 重开。
- Windows：仅记录朋友电脑实际执行的 probe evidence；本机 mock 不得标记为 live support。

## Change Log

- 2026-08-31：根据已批准规格创建实施计划，拆分为 A/B/C 三个可停止阶段。
- 2026-08-31：完成 Phase A；五类 provider 支持同轮 schema 升级，直连模式仍保留 destructive/覆盖写审批。
- 2026-08-31：完成 B1/B2；加入 WPS JSAPI 只读探针、adapter evidence 与跨重排稳定句柄，写能力仍保持 unverified。
- 2026-08-31：完成 B3/B4 代码层；受控写探针可放行实际验证的版式/占位符/母版固定形状/按版式加页，POTX 使用格式 26 与代理事务安全落盘。
