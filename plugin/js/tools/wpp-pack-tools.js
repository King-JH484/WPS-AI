(function registerWppPackTools(global) {
  "use strict";
  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  registry.registerTool({
    name: "wpp_capability_catalog",
    hosts: ["wpp"],
    pack: "core",
    risk: "read_only",
    description: "查看演示专业能力、工具包及当前平台验证状态。状态为 unverified 的写能力不能视为可用。",
    parameters: { type: "object", properties: {} },
    handler: async (_args, context) => global.WpsAiWppCapabilities.catalog({ platform: context?.platform || "unknown" })
  });

  registry.registerTool({
    name: "wpp_enable_tool_pack",
    hosts: ["wpp"],
    pack: "core",
    risk: "read_only",
    description: "在当前对话轮次立即启用一个 WPP 工具包。启用只影响模型可见 schema，不授予额外权限。",
    parameters: {
      type: "object",
      properties: {
        pack: { type: "string", enum: ["compose", "template_native", "chart_native", "motion_media", "delivery"] }
      },
      required: ["pack"],
      additionalProperties: false
    },
    handler: async (args, context) => global.WpsAiToolPacks.enablePack(context, args.pack)
  });
})(window);
