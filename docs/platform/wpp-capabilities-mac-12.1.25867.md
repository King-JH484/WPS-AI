# WPP 原生能力真机报告 — macOS 12.1.25867

## 环境与证据

- 平台：Apple Silicon macOS（`darwin/arm64`）
- WPS：WPS Office for Mac `12.1.25867`（build `25867`）
- 插件：Anthony AI `1.4.7`，源码提交 `a5dc037043ef`
- 适配器：`wps_jsapi`
- 测试文件：原 PPTX 的一次性副本，文件名含 `test`；原文件未修改
- 探针：受控写探针；所有临时对象均删除，`cleanupVerified=true`
- 复测：占位符集合等待 `8 x 150ms`；`ChartData.Activate()` 后 Workbook 等待 `12 x 200ms`

机器可读证据见 [wpp-capabilities-mac-12.1.25867.json](./wpp-capabilities-mac-12.1.25867.json)。

## 结论

| 能力 | 状态 | 真机结论 |
|---|---|---|
| 母版/版式读取 | supported | 可遍历 Design、SlideMaster、CustomLayouts |
| 母版固定形状 | supported | `SlideMaster.Shapes.AddShape/Delete` 可逆写入成功 |
| 自定义版式 | supported | `CustomLayouts.Add/Delete` 可逆写入成功 |
| 版式占位符 | degraded | `AddPlaceholder` 调用后没有可观察原生对象，延迟复测仍失败 |
| 按版式新增页面 | supported | `Slides.AddSlide/Delete` 可逆写入成功 |
| 主题应用 | unverified | 未在本轮对真实主题文件执行受控写探针 |
| POTX 导出 | unverified | 安全事务已实现，但未在本轮执行 `SaveCopyAs(format=26)` 真机探针 |
| 原生图表创建/读取/类型更新/删除 | supported | 原生 Chart 对象闭环成功 |
| 原生图表数据工作簿 | degraded | `ChartData.Workbook` 在 Activate 和 2.4 秒等待后仍不可用 |

`degraded` 不等于工具会悄悄改用图片：Anthony AI 会拒绝需要该能力的操作，并说明当前宿主限制。普通图片图表仍由 `wpp_render_chart` 提供，但不冒充可编辑原生图表。

## 能力边界

当前 Mac 版已经可以创建真正继承自自定义版式的页面、维护母版固定形状，以及创建和调整原生图表对象/类型。当前不能宣称支持原生占位符写入、原生图表数据工作簿编辑、主题应用或 POTX 真机导出。Windows 必须运行自己的探针；本报告不得作为 Windows 支持证据。

动态工具包只控制每轮暴露给模型的 schema 数量：`wpp_capability_catalog` 与 `wpp_enable_tool_pack` 始终可见，模型可在同一工具循环启用 `template_native` 或 `chart_native`，随后立即获得相应工具。工具执行前还会单独核验真机 capability，因此工具包不会成为永久能力上限。
