# WPP 原生专业创作能力设计

## 1. 目标

在不牺牲 Mac 与 Windows 差异化实现的前提下，把 Anthony AI 的 WPP 能力从“视觉生成与常规编辑”提升到“可维护原生文档结构的专业创作”，优先完成：

- 运行时能力探针和平台能力矩阵；
- 幻灯片母版、设计、版式和占位符；
- 真正的 `.potx` 模板导出与复用；
- 原生可编辑图表的基础创建、读取和更新；
- 主题、页眉页脚等模板相关能力；
- 不限制底层能力的动态工具包和同轮升级机制；
- Mac 与 Windows 独立声明、独立测试、允许能力不同。

本阶段不扩展 Writer、ET 和 PDF 的对象模型覆盖，也不追求 WPP 全部声明成员的一对一工具化。

## 2. 已确认约束

1. 本机是 Apple Silicon Mac；交付还需支持 Windows 电脑。
2. Mac 与 Windows 可以拥有不同能力，不能用最低公共子集限制双方。
3. 动态工具包只能优化模型上下文，不能成为能力权限阀门。
4. 用户明确请求某项已实现能力时，必须能够触发加载并调用；初始路由漏判后应在同一工具循环升级，而不是回复“没有工具”。
5. 优先使用 WPS 客户端 JSAPI。仅在运行时证据显示缺失时，才使用平台专属适配器。
6. 不提供任意对象路径或任意方法执行的 `raw_call`。
7. 保留现有修改历史、文档备份、用户审批和错误序列化机制。
8. 不纳入或覆盖用户当前未跟踪的 `DEBUG-PDF-PATH.md`、`TEST-STATUS.md`、`dist-permanent/`。

## 3. 非目标

- 不以 WPS 类型声明中约 204 个 WPP 接口的枚举覆盖率作为成功标准。
- 不在第一阶段实现宏、数字签名、密码、加密、IRM、共同编辑、工作流和 OLE 任意自动化。
- 不保证所有 WPS 安装包、历史版本和企业定制版本行为一致。
- 不用 PPTX 文件后缀伪装 POTX，也不把复制幻灯片视为自定义版式。

## 4. 方案选择

### 4.1 备选方案

#### 方案 A：全部工具始终发送

优点是模型永远可见全部能力；缺点是工具定义体积、请求费用、选错工具概率和维护成本快速上升。当前仅 47 个 PPT 工具定义已经约 47 KB，不能继续线性扩张。

#### 方案 B：固定关键词工具包

优点是实现简单、上下文较小；缺点是路由漏判会直接隐藏能力，违背“需要时真正能够调用”的要求。

#### 方案 C：分层注册、动态路由、同轮升级

底层能力始终注册；模型层默认暴露核心工具与相关领域工具；能力目录和工具包升级入口始终可见。工具包激活后，各供应商的下一次工具循环重新读取工具定义，完成同轮扩展。

采用方案 C。

## 5. 总体架构

```text
用户请求
   │
   ▼
WPP 意图路由器 ───────────────┐
   │                          │ 漏判/任务扩展
   ▼                          ▼
核心工具 + 相关工具包     能力目录/启用工具包
   │                          │
   └──────────────┬───────────┘
                  ▼
       每轮迭代重新解析工具集合
                  │
                  ▼
         WPP 领域工具（稳定契约）
                  │
                  ▼
         平台能力与适配器选择
          ├─ WPS JSAPI 公共实现
          ├─ Mac 专属实现/降级
          └─ Windows 专属实现/降级
                  │
                  ▼
              WPS 文档
```

系统分为四层：

1. **工具注册层**：保存所有工具定义、所属工具包、风险级别和平台要求。
2. **工具路由层**：根据宿主、用户请求、会话激活状态选择本轮可见工具。
3. **领域能力层**：提供母版、版式、占位符、图表、主题和模板的稳定任务级接口。
4. **平台适配层**：基于运行时探针选择公共、Mac 或 Windows 实现，并返回结构化能力/降级说明。

### 5.1 工具元数据契约

工具定义在现有字段之外增加：

```js
{
  packs: ["wpp.core", "wpp.template"],
  capabilities: ["master.read", "layout.create"],
  risk: "read|document_write|filesystem_create|destructive",
  platform: "any|mac|windows",
  requires: ["master.customLayouts.add"]
}
```

- `packs`、`capabilities` 和 `risk` 必填；兼容期由注册表给旧工具补默认值并产生测试可见警告。
- 注册表拒绝未知工具包、未知风险值和重复 capability 所有权；同一 capability 有多个适配器时必须显式声明优先级。
- `requires` 是能力矩阵键，不等于平台判断；路由器只负责可见性，执行器仍须在调用前检查能力。
- 工具包、能力别名、显式意图关键词维护在单一清单中，测试从该清单生成，不允许散落在 provider 中。

## 6. 动态工具包设计

### 6.1 工具包

- `wpp.core`：基本读取、保存、幻灯片导航和能力工具；始终加载。
- `wpp.compose`：幻灯片、文本、形状、图片、表格和常规视觉创作。
- `wpp.template`：Design、SlideMaster、CustomLayout、Placeholder、Theme、POTX。
- `wpp.chart`：原生图表创建、数据、系列、坐标轴、标题、图例。
- `wpp.motion`：动画时间线、切换和媒体播放。
- `wpp.advanced`：高级对象操作、导入、可访问性和页面设置。

现有工具在不改变公开名称的前提下补充 `packs` 元数据，保证兼容已有提示词、测试和历史会话。

### 6.2 始终可见的安全网

新增两个始终可见的只读/低风险工具：

- `wpp_capability_catalog`：按关键词或领域查询已注册能力、当前平台支持状态和需要启用的工具包。
- `wpp_enable_tool_pack`：激活一个已知 WPP 工具包，只改变当前对话的工具可见集合，不修改文档。

用户明确说“母版、模板、版式、占位符、POTX”时，路由器预先激活 `wpp.template`；说“原生图表、可编辑图表、数据系列”时预先激活 `wpp.chart`。无法确定时加载更宽的工具集合，不以节省 token 为由拒绝能力。

路由器的确定性规则为：显式能力别名优先于宽泛关键词；一个请求命中多个领域时取工具包并集；用户点名具体已注册工具时直接加载该工具所属全部工具包；未知别名不自动映射为“unsupported”，而是加载 catalog 并让模型查询。

### 6.3 同轮升级

当前 provider 在进入 `runWithTools` 时一次性生成 `toolSpecs`。新增统一契约：

```ts
type ToolResolutionContext = {
  conversationId: string;
  turnId: string;
  host: string;
  providerId: string;
  platform: string;
  userText: string;
  explicitCapabilityKeys: string[];
};

type ResolvedToolSnapshot = {
  revision: number;
  definitions: ToolDefinition[];
  activePacks: string[];
  reasons: Record<string, string[]>;
};

resolveTools(context): ResolvedToolSnapshot
```

状态由 `WpsAiToolPacks` 统一持有：

- 对话级保存用户/模型显式启用的工具包，保证后续追问仍可使用；新建会话时清空。
- 每轮保存意图路由临时工具包；下一用户轮重新计算。
- 宿主变化时清除旧宿主工具包；provider 变化不清除，但重新生成 provider 对应 schema。
- `wpp_enable_tool_pack` 仅接受清单中的包；未知包返回结构化失败且不改变 revision。已知领域包可以在任一平台启用，具体工具执行时再依据能力矩阵选择适配器或返回证据充分的不支持结果，不能因平台预判隐藏整个领域。
- 成功启用令 revision 单调递增；重复启用幂等，不增加 revision。
- 每次 provider 请求使用一个不可变 `ResolvedToolSnapshot`，本次请求期间不突变；下一工具迭代获取新快照。

具体调用流程：

1. `app.js` 创建 `ToolResolutionContext`，把 `resolveTools` 和上下文传给 provider wrapper；静态数组接口继续保留以兼容其他宿主。
2. 每次模型工具迭代开始前重新解析当前工具集合，并重新生成该 provider 的 schema；不得复用旧 `toolSpecs`。
3. `wpp_enable_tool_pack` 修改对话级激活状态；
4. 下一次迭代自动携带新增工具；
5. OpenAI Chat 还必须重新计算依赖工具名的 planning/weak-tool guard；其他 provider 重新计算所有从 tool definitions 派生的数据；
6. OpenAI Chat、OpenAI Responses、Codex、Anthropic、Gemini 使用同一组 provider conformance tests；
7. 解析器抛错时本迭代沿用上一个成功快照并把诊断写入事件流；连续两次失败才终止，禁止发送半套 schema；
8. 工具包启用工具返回失败时，模型得到明确原因，不能假装已启用；
9. 动态解析未提供时保持原行为，避免影响 Writer/ET/PDF。

`app.js` 还要把 `conversationId/turnId` 写入每次 registry `execute` 的上下文；五类 provider 执行工具时原样传递该上下文，使 `wpp_enable_tool_pack` 修改正确的对话状态，不能使用进程级全局“最近一次会话”猜测。

为了防止模型看见能力仍过早回复“做不了”，`app.js` 记录本轮 `explicitCapabilityKeys` 和实际工具调用。如果用户明确要求修改文档、能力目录显示为 `supported/degraded`、但模型未调用任何匹配工具并直接结束，则自动追加一次内部继续提示并重试，明确要求查询 catalog 或调用匹配工具。每轮最多自动继续一次；第二次仍未执行则向用户报告模型未使用已提供能力，而不是声称 WPS 没有接口。

工具包不是授权系统。所有文档写操作仍走原有审批、备份与历史记录。

## 7. 平台能力探针

### 7.1 探针输出

`wpp_probe_native_capabilities` 返回：

```json
{
  "schemaVersion": 1,
  "platform": "mac|windows|linux|unknown",
  "wpsVersion": "...",
  "capabilities": {
    "presentation.slideMaster.read": { "status": "supported", "adapter": "jsapi", "evidence": { "kind": "live_read_probe" } },
    "master.customLayouts.add": { "status": "unverified", "adapter": "jsapi", "reason": "尚未运行沙箱写探针" },
    "slides.addSlide": { "status": "supported", "adapter": "jsapi", "evidence": { "kind": "live_write_probe" } },
    "presentation.saveAs.potx": { "status": "declared", "adapter": null, "reason": "仅有官方声明" },
    "chart.native.create": { "status": "unsupported", "adapter": null, "evidence": { "kind": "live_write_probe" } }
  }
}
```

探针分为：

- **只读探针**：对象和方法存在性、集合读取、版本与平台；可自动执行。
- **沙箱写探针**：仅在临时新建演示文稿或用户允许的测试副本中创建后立即清理；不得在用户正文档中试写。
- **格式探针**：输出到临时目录，验证生成文件类型和 OOXML 部件后清理。

### 7.2 能力状态

- `supported`：对应读/写行为已在当前平台和版本真机验证成功；仅有属性存在性不足以进入此状态。
- `declared`：官方文档或声明文件存在，但尚无适配器行为证据。
- `unverified`：适配器已实现并通过 mock/静态测试，但尚未在当前平台真机执行。
- `unsupported`：真机确认缺失或失败。
- `degraded`：可用替代实现，但语义或可编辑性下降。
- `blocked`：因安全、权限或当前文档状态不能执行。

每项结果还包含 `evidence: {kind, platform, wpsVersion, pluginVersion, timestamp, probeId, details}`。合并优先级为：当前版本成功/失败的行为探针 > 同版本持久化真机证据 > 已实现但未真机的适配器 > 官方声明。`blocked` 是本次调用的瞬态状态，不覆盖持久化支持状态；失败或中断的沙箱探针保留上次证据并记录新诊断，不自动降为 `unsupported`。

Mac 与 Windows 分别缓存能力结果，缓存键至少包含平台、CPU 架构、WPS 版本、插件版本；升级任一版本后重新探测。缓存写入使用完整结果替换，禁止把 Mac 结果合并为 Windows 支持。

## 8. 领域工具契约

### 8.1 母版和版式

- `wpp_master_inspect`：列出 Design、SlideMaster、CustomLayout、形状和引用关系。
- `wpp_master_update`：更新母版背景、固定形状、页眉页脚和主题关联。
- `wpp_layout_manage`：`list/create/clone/update/reorder/delete`，删除需额外保护。
- `wpp_placeholder_manage`：`list/create/update/delete`，支持标题、正文、图片、对象、日期、页脚和页码等类型。
- `wpp_add_slide_from_layout`：按领域工具返回的对象句柄创建幻灯片，使用 `Slides.AddSlide`，不复制现有页。

领域工具接受友好名称和结构化属性，不向模型暴露任意对象路径。

对象身份使用不透明句柄而不是裸索引。Design/Layout 句柄由文档身份、Design 名称/索引、Layout 名称/MatchingName/索引和形状摘要指纹组成；Chart/Shape 句柄至少包含文档身份、SlideID 和 Shape.Id。每次使用都重新解析并验证指纹：没有匹配返回 `stale_handle`，多个匹配返回 `ambiguous_handle` 并附候选摘要。索引只能作为显示信息，不能作为后续写操作的唯一身份。

第一阶段删除策略不支持级联：被幻灯片引用的版式/母版一律拒绝删除；被使用的占位符也拒绝删除。执行删除前完整预检引用关系，预检通过后才进入始终开启的破坏性审批。若 WPS 不支持事务，删除操作一次只处理一个对象，依赖操作前备份；部分失败必须返回实际完成项、失败项和恢复路径。

### 8.2 主题

- 读取当前 Design、主题文件名、主题色和主题字体。
- 应用 `.thmx/.potx/.pptx` 时优先使用 Presentation 级接口。
- 创建/更新主题色或字体只在探针验证后开放；不支持时明确返回 `degraded`，不静默改成逐页纯色。

### 8.3 原生图表

- `wpp_native_chart_manage` 支持 `create/read/update/delete`。
- 第一阶段覆盖柱状、折线、饼图/环形图和散点图的基本数据、标题、图例与坐标轴。
- 返回基于 `SlideID + Shape.Id` 的图表句柄和结构化摘要，确保后续能继续编辑；形状索引只用于 UI 提示。
- 现有 `wpp_render_chart` 保留为“视觉图片图表”，工具描述明确标注不可编辑；不能用它冒充原生图表。

### 8.4 模板导出

- 扩展 `wpp_save_as` 支持 `potx=26`，并提供语义更明确的 `wpp_template_export`。
- 导出前在 proxy 层完成路径规范化、父目录验证、扩展名强制归一和符号链接/Windows 路径别名解析。
- 导出后验证 ZIP 内容类型、`ppt/slideMasters/`、`ppt/slideLayouts/` 和关系文件。
- 默认使用 `SaveCopyAs` 写入同目录唯一临时文件，验证通过后由 proxy 使用排他式创建/移动完成最终落盘；目标已存在则失败，不存在检查和最终写入之间不能留普通覆盖竞态。
- 用户明确允许覆盖时仍进入 `filesystem_create` 风险审批，先把旧文件移到可恢复备份，再替换。
- 失败时清理临时文件；清理失败记录具体路径并提示用户，不把部分文件报告为成功。

## 9. 平台适配策略

### 9.1 公共路径

优先使用 WPS 加载项 JSAPI：

- `Presentation.Designs`
- `Presentation.SlideMaster`
- `Master.CustomLayouts`
- `Slides.AddSlide`
- `Slide.CustomLayout`
- `Shapes.AddPlaceholder`
- `Shapes.AddChart/AddChart2`
- `Presentation.SaveAs`

### 9.2 Mac

- 以当前 WPS 12.1.25867 真机探针结果为准。
- 未验证接口保持 `declared`，不直接写用户文档。
- 若母版写入部分缺失，优先使用基于已存在模板的 `ApplyTemplate`/克隆策略。
- OOXML 兜底只能离线操作副本，操作后重新打开验证；不得修改 WPS 正在打开的原文件。
- 第一可交付版本必须完成当前 Mac 的公共 JSAPI 真机报告；任何 OOXML 写兜底属于后续独立阶段，只有公共 JSAPI 证据不足且用户确认后才实施。

### 9.3 Windows

- 同样优先使用 JSAPI，保持共享代码路径。
- 第一可交付版本提供共享 JSAPI 适配器、Windows 探针执行器和平台证据报告；在朋友电脑未运行前状态只能是 `unverified`。
- 朋友电脑探针确认 JSAPI 缺失但 Kingsoft WPP COM/Interop 可用时，后续阶段实现 Windows 专属适配器；未取得这项证据前不预写 COM 兜底。
- COM 适配器必须实现同一领域契约，返回 `adapter: "windows-com"`。
- Windows 专属增强不要求在 Mac 降级到相同水平，反之亦然。
- 对 `declared/unverified` 的写能力默认拒绝执行并返回需要运行的探针；只读声明可展示，但不得表示为已支持。

## 10. 错误处理与安全

1. 所有领域工具先读取能力矩阵；不支持时返回包含平台、WPS 版本、能力键和原因的错误。
2. 不捕获后静默成功；部分成功必须返回 `warnings` 和实际完成项。
3. 破坏性操作包括删除母版、删除版式、删除占位符、覆盖模板和批量改变引用关系，必须进入独立 `WpsAiRiskGate`；该 gate 位于 registry execute 层，始终启用，不受直接操作模式或 `buildChatApprover()` 是否返回 approver 的影响。
4. 风险分类以工具定义的 `risk` 元数据为准，不再只依赖工具名称。`document_write/destructive` 在执行前创建文档备份并记录 before/after；`filesystem_create` 记录目标、临时文件、校验结果和最终状态，但不伪造文档快照。现有 `wpp_save_as` 的“只读”历史分类需迁移为外部副作用分类并保持兼容展示。
5. 探针不得泄漏本地路径、文档内容或账户信息。
6. 平台专属适配器失败后不得无提示换成视觉近似实现。
7. 风险 gate 拒绝、超时或 UI 不可用时工具返回 `approval_required/approval_denied`，不执行任何预写动作。

## 11. 测试策略

### 11.1 自动化测试

- 工具注册、工具包元数据、能力目录和路由选择。
- 五类 provider 在工具包激活后的下一迭代重新生成工具定义。
- 初始漏判后通过 `wpp_enable_tool_pack` 同轮获得模板工具。
- 平台能力矩阵合并规则：公共、Mac、Windows 独立且不互相覆盖。
- WPS 对象 mock 测试：母版读取、版式创建、占位符、按版式新增、原生图表、POTX 格式值。
- 保存扩展名/格式一致性和覆盖保护。
- 现有 47 个工具名称和行为兼容测试。
- 风险元数据、直接操作模式下的始终开启 gate、文档写与文件副作用的不同审计路径。
- 稳定句柄的重排后解析、重复名称歧义、删除后的 stale handle。
- POTX 临时文件验证、排他落盘、覆盖备份、失败清理和路径别名测试。

### 11.2 Mac 真机验收

1. 在测试副本上运行只读和受控写探针。
2. 创建、克隆、重排命名自定义版式；在测试副本中删除未引用版式并验证引用版式拒删。
3. 创建并读取标题、正文、图片、页脚和页码占位符。
4. 用该版式新建两页。
5. 修改母版固定元素、主题色/字体、页眉页脚，确认引用页同步。
6. 创建柱状、折线、饼图/环形图和散点图，读取并更新基础数据；在 WPS UI 再次修改数据。
7. 导出 POTX，重新打开并创建新演示。

### 11.3 Windows 验收

提供可由朋友电脑 Codex 执行的测试命令和人工步骤，记录：

- WPS 版本和架构；
- 每项 capability 的 adapter；
- JSAPI 与 COM 差异；
- POTX 与原生图表结果；
- 失败日志与可接受降级。

Windows 未实机验收前，相关能力标记为 `declared` 或 `unverified`，不能在文档中写成“已验证支持”。

### 11.4 证据报告

每次真机验收生成独立报告，逐项记录 capability key、平台、CPU 架构、WPS 版本、插件提交、适配器、探针 ID、结果和日志摘要。mock、声明文件、Mac 真机、Windows 真机使用不同 evidence kind；发布说明只能从同平台真机 evidence 生成“已支持”列表。

## 12. 交付与提交策略

交付拆成三个独立停止/继续阶段，每阶段都有可单独使用的产物：

### 阶段 A：工具路由基础设施

- 元数据、工具包状态、动态解析契约、五 provider 同轮升级和风险 gate。
- 停止条件：provider conformance tests 全部通过，现有宿主静态工具模式无回归。

### 阶段 B：模板原生最小闭环

- 只读/沙箱探针、稳定句柄、母版/版式/占位符、主题与页眉页脚基础、按版式新增、POTX 安全导出。
- 停止条件：mock 契约通过、当前 Mac 真机报告完成；Windows 产出可执行探针和 `unverified` 报告模板。
- 若 Mac 的关键写接口不支持，停止并根据证据单独设计 OOXML 兜底，不在本阶段即兴加入。

### 阶段 C：原生图表与平台增强

- 四类原生图表基础闭环；根据朋友电脑证据决定是否实现 Windows COM 适配器。
- 停止条件：Mac 四类图表真机验收；Windows 保持证据真实，未运行不宣称通过。

对应可回滚提交：

1. 设计规格。
2. 实施计划和能力矩阵契约测试。
3. 动态工具包与同轮升级。
4. WPP 能力探针和平台适配骨架。
5. 母版、版式、占位符和 POTX。
6. 原生图表和主题基础能力。
7. Mac 真机验证、Windows 探针交接测试和平台证据文档。

每个实现提交必须通过相关单元测试；最终运行完整 `npm test`/Node 测试、lint、静态扫描和构建中适用于当前环境的检查。任何无法在 Mac 上执行的 Windows 验收都要明确记录，不伪造通过结果。

## 13. 完成标准

- AI 能识别并检查当前平台的母版/图表/模板能力。
- 自定义版式新页使用原生 `CustomLayout`，不是复制幻灯片。
- 生成的 POTX 具有正确内容类型和母版/版式部件。
- 四类承诺图表均通过 mock 契约和当前 Mac 真机基础创建/读取/更新；若真机证明某类不支持，则从承诺列表移出并以 `unsupported/degraded` 证据说明，不能以图片图表冒充。
- 动态路由漏判后，同一轮可激活所需工具包继续执行。
- Mac 与 Windows 能力独立报告，允许不对称。
- 主题色/字体、页眉页脚、五类占位符以及版式创建/克隆/重排/安全删除都有对应验收证据。
- 完成平台/版本/evidence-tagged 报告，mock 或声明结果不能被展示为真机支持。
- 现有 PPT 生成与编辑流程没有回归。
- 所有本轮代码和文档均有清晰 Git 提交，未混入用户已有未跟踪文件。
