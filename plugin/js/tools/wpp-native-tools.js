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
})(window);
