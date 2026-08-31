(function registerWppNativeTools(global) {
  "use strict";
  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  registry.registerTool({
    name: "wpp_probe_native_capabilities",
    hosts: ["wpp"],
    pack: "core",
    risk: "read_only",
    description: "探测当前 WPS 演示版本实际暴露的母版、版式、模板和原生图表接口。默认只读；未验证写能力不会标记为 supported。",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["read"], default: "read" } },
      additionalProperties: false
    },
    handler: async () => global.WpsAiPresentationNative.probe({ mode: "read" })
  });

  registry.registerTool({
    name: "wpp_probe_native_write_capabilities",
    hosts: ["wpp"], pack: "template_native", risk: "destructive",
    description: "在名称含 test/probe/测试/sandbox 的专用演示中执行可逆写探针，逐项验证版式、占位符、母版形状和按版式加页，并核验清理。需要当前 documentId 精确匹配。",
    parameters: {
      type: "object",
      properties: { expectedDocumentId: { type: "string" }, sandboxConfirmed: { type: "boolean", const: true } },
      required: ["expectedDocumentId", "sandboxConfirmed"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.probe({
      mode: "write", expectedDocumentId: args.expectedDocumentId, sandboxConfirmed: args.sandboxConfirmed === true
    })
  });

  registry.registerTool({
    name: "wpp_master_inspect",
    hosts: ["wpp"],
    pack: "template_native",
    capability: "wpp.master.inspect",
    risk: "read_only",
    description: "读取当前演示的 Design、SlideMaster、自定义版式及占位符，返回可供后续安全操作使用的稳定 layout handle。",
    parameters: {
      type: "object",
      properties: { includeShapes: { type: "boolean", default: true } },
      additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.inspect({ includeShapes: args.includeShapes !== false })
  });

  registry.registerTool({
    name: "wpp_layout_manage",
    hosts: ["wpp"], pack: "template_native", capability: "wpp.layout.manage", risk: "destructive", riskByAction: { list: "read_only" },
    description: "原生管理自定义版式：list/create/clone/update/move/delete。写操作仅在当前平台探针标记 supported 后执行；delete 不级联。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "clone", "update", "move", "delete"] },
        layoutHandle: { type: "string" }, designIndex: { type: "integer", minimum: 1 }, index: { type: "integer", minimum: 1 },
        name: { type: "string" }, matchingName: { type: "string" }
      },
      required: ["action"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.manageLayout(args)
  });

  registry.registerTool({
    name: "wpp_placeholder_manage",
    hosts: ["wpp"], pack: "template_native", capability: "wpp.placeholder.manage", risk: "destructive",
    description: "在自定义版式中原生创建、更新或删除占位符。使用稳定 layout/shape handle，不接受页序猜测。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "delete"] },
        layoutHandle: { type: "string" }, shapeHandle: { type: "string" },
        type: { type: "string", enum: ["title", "body", "center_title", "subtitle", "vertical_title", "vertical_body", "object", "chart", "table", "picture"] },
        name: { type: "string" }, left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
      },
      required: ["action"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.managePlaceholder(args)
  });

  registry.registerTool({
    name: "wpp_add_slide_from_layout",
    hosts: ["wpp"], pack: "template_native", capability: "wpp.slide.add_from_layout", risk: "document_write",
    description: "使用已解析的原生 CustomLayout 新增幻灯片，形成真正继承母版/版式的页面。",
    parameters: {
      type: "object",
      properties: { layoutHandle: { type: "string" }, index: { type: "integer", minimum: 1 } },
      required: ["layoutHandle"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.addSlideFromLayout(args)
  });

  registry.registerTool({
    name: "wpp_theme_manage",
    hosts: ["wpp"], pack: "template_native", capability: "wpp.theme.manage", risk: "document_write",
    description: "通过 WPS 原生 ApplyTemplate/ApplyTemplate2 应用 .thmx/.potx/.pptx 主题或模板，不用逐页视觉近似冒充主题。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, variantGuid: { type: "string" } },
      required: ["path"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.manageTheme(args)
  });

  registry.registerTool({
    name: "wpp_master_update",
    hosts: ["wpp"], pack: "template_native", capability: "wpp.master.update", risk: "document_write",
    description: "在原生 SlideMaster 上新增、更新或删除固定形状。只开放已由 AddShape/Delete 受控探针验证的子集。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_shape", "update_shape", "delete_shape"] }, designIndex: { type: "integer", minimum: 1 },
        shapeHandle: { type: "string" }, shapeType: { type: "string", enum: ["rectangle", "ellipse"] },
        name: { type: "string" }, text: { type: "string" }, left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" }
      },
      required: ["action"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.updateMaster(args)
  });

  registry.registerTool({
    name: "wpp_template_export",
    hosts: ["wpp"], pack: "template_native", capability: "wpp.template.export", risk: "filesystem_create",
    description: "将当前演示通过 SaveCopyAs(format=26) 导出为真正的 POTX。先写同目录临时文件，经代理验证 OOXML 结构后排他落盘；覆盖会保留备份。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", pattern: "\\.potx$" }, overwrite: { type: "boolean", default: false } },
      required: ["path"], additionalProperties: false
    },
    handler: async (args) => global.WpsAiPresentationNative.exportTemplate(args)
  });
})(window);
