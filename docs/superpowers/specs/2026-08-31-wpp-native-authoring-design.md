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

### 6.3 同轮升级

当前 provider 在进入 `runWithTools` 时一次性生成 `toolSpecs`。需要调整为：

1. `runWithTools` 接收初始工具集合和一个可选动态解析器；
2. 每次模型工具迭代开始前重新解析当前工具集合；
3. `wpp_enable_tool_pack` 修改对话级激活状态；
4. 下一次迭代自动携带新增工具；
5. OpenAI Chat、OpenAI Responses、Codex、Anthropic、Gemini 使用相同语义；
6. 未启用动态解析时保持原行为，避免影响 Writer/ET/PDF。

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
    "presentation.slideMaster.read": { "supported": true, "adapter": "jsapi" },
    "master.customLayouts.add": { "supported": false, "adapter": null, "reason": "..." },
    "slides.addSlide": { "supported": true, "adapter": "jsapi" },
    "presentation.saveAs.potx": { "supported": true, "adapter": "jsapi" },
    "chart.native.create": { "supported": false, "adapter": null, "reason": "..." }
  }
}
```

探针分为：

- **只读探针**：对象和方法存在性、集合读取、版本与平台；可自动执行。
- **沙箱写探针**：仅在临时新建演示文稿或用户允许的测试副本中创建后立即清理；不得在用户正文档中试写。
- **格式探针**：输出到临时目录，验证生成文件类型和 OOXML 部件后清理。

### 7.2 能力状态

- `supported`：真机验证成功。
- `declared`：声明文件存在但尚未真机验证，不能作为可执行承诺。
- `unsupported`：真机确认缺失或失败。
- `degraded`：可用替代实现，但语义或可编辑性下降。
- `blocked`：因安全、权限或当前文档状态不能执行。

Mac 与 Windows 分别缓存能力结果，缓存键至少包含平台、WPS 版本、插件版本；升级任一版本后重新探测。

## 8. 领域工具契约

### 8.1 母版和版式

- `wpp_master_inspect`：列出 Design、SlideMaster、CustomLayout、形状和引用关系。
- `wpp_master_update`：更新母版背景、固定形状、页眉页脚和主题关联。
- `wpp_layout_manage`：`list/create/clone/update/reorder/delete`，删除需额外保护。
- `wpp_placeholder_manage`：`list/create/update/delete`，支持标题、正文、图片、对象、日期、页脚和页码等类型。
- `wpp_add_slide_from_layout`：按 design/layout 名称或稳定索引创建幻灯片，使用 `Slides.AddSlide`，不复制现有页。

领域工具接受友好名称和结构化属性，不向模型暴露任意对象路径。

### 8.2 主题

- 读取当前 Design、主题文件名、主题色和主题字体。
- 应用 `.thmx/.potx/.pptx` 时优先使用 Presentation 级接口。
- 创建/更新主题色或字体只在探针验证后开放；不支持时明确返回 `degraded`，不静默改成逐页纯色。

### 8.3 原生图表

- `wpp_native_chart_manage` 支持 `create/read/update/delete`。
- 第一阶段覆盖柱状、折线、饼图/环形图和散点图的基本数据、标题、图例与坐标轴。
- 返回图表形状索引和结构化摘要，确保后续能继续编辑。
- 现有 `wpp_render_chart` 保留为“视觉图片图表”，工具描述明确标注不可编辑；不能用它冒充原生图表。

### 8.4 模板导出

- 扩展 `wpp_save_as` 支持 `potx=26`，并提供语义更明确的 `wpp_template_export`。
- 导出前验证扩展名和格式一致。
- 导出后验证 ZIP 内容类型、`ppt/slideMasters/`、`ppt/slideLayouts/` 和关系文件。
- 不覆盖现有文件，除非用户明确允许。

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

### 9.3 Windows

- 同样优先使用 JSAPI，保持共享代码路径。
- JSAPI 缺失但 Kingsoft WPP COM/Interop 可用时，可提供 Windows 专属适配器。
- COM 适配器必须实现同一领域契约，返回 `adapter: "windows-com"`。
- Windows 专属增强不要求在 Mac 降级到相同水平，反之亦然。

## 10. 错误处理与安全

1. 所有领域工具先读取能力矩阵；不支持时返回包含平台、WPS 版本、能力键和原因的错误。
2. 不捕获后静默成功；部分成功必须返回 `warnings` 和实际完成项。
3. 破坏性操作包括删除母版、删除版式、删除占位符、覆盖模板和批量改变引用关系，必须进入审批。
4. 写工具必须接入现有快照/历史机制；工具名称加入修改型分类测试。
5. 探针不得泄漏本地路径、文档内容或账户信息。
6. 平台专属适配器失败后不得无提示换成视觉近似实现。

## 11. 测试策略

### 11.1 自动化测试

- 工具注册、工具包元数据、能力目录和路由选择。
- 五类 provider 在工具包激活后的下一迭代重新生成工具定义。
- 初始漏判后通过 `wpp_enable_tool_pack` 同轮获得模板工具。
- 平台能力矩阵合并规则：公共、Mac、Windows 独立且不互相覆盖。
- WPS 对象 mock 测试：母版读取、版式创建、占位符、按版式新增、原生图表、POTX 格式值。
- 保存扩展名/格式一致性和覆盖保护。
- 现有 47 个工具名称和行为兼容测试。

### 11.2 Mac 真机验收

1. 在测试副本上运行只读和受控写探针。
2. 创建命名自定义版式和占位符。
3. 用该版式新建两页。
4. 修改母版固定元素，确认引用页同步。
5. 创建原生图表并在 WPS UI 修改数据。
6. 导出 POTX，重新打开并创建新演示。

### 11.3 Windows 验收

提供可由朋友电脑 Codex 执行的测试命令和人工步骤，记录：

- WPS 版本和架构；
- 每项 capability 的 adapter；
- JSAPI 与 COM 差异；
- POTX 与原生图表结果；
- 失败日志与可接受降级。

Windows 未实机验收前，相关能力标记为 `declared` 或 `unverified`，不能在文档中写成“已验证支持”。

## 12. 交付与提交策略

按可回滚增量提交：

1. 设计规格。
2. 实施计划和能力矩阵契约测试。
3. 动态工具包与同轮升级。
4. WPP 能力探针和平台适配骨架。
5. 母版、版式、占位符和 POTX。
6. 原生图表和主题基础能力。
7. Mac 真机验证、Windows 交接测试和文档。

每个实现提交必须通过相关单元测试；最终运行完整 `npm test`/Node 测试、lint、静态扫描和构建中适用于当前环境的检查。任何无法在 Mac 上执行的 Windows 验收都要明确记录，不伪造通过结果。

## 13. 完成标准

- AI 能识别并检查当前平台的母版/图表/模板能力。
- 自定义版式新页使用原生 `CustomLayout`，不是复制幻灯片。
- 生成的 POTX 具有正确内容类型和母版/版式部件。
- 至少一种原生图表能够创建、读取并更新数据。
- 动态路由漏判后，同一轮可激活所需工具包继续执行。
- Mac 与 Windows 能力独立报告，允许不对称。
- 现有 PPT 生成与编辑流程没有回归。
- 所有本轮代码和文档均有清晰 Git 提交，未混入用户已有未跟踪文件。
