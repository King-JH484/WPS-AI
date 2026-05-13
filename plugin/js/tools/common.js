(function attachCommonTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  registry.registerTool({
    name: "get_host_info",
    hosts: ["*"],
    description: "查询当前 WPS 宿主类型（wps=文字 / et=表格 / wpp=演示 / pdf=PDF）以及活动文档名称。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const info = await global.WpsAiDocument.getHostInfo();
      const app = await global.WpsAiDocument.getApplication();
      let docName = null;
      try {
        if (app?.ActiveWorkbook) docName = app.ActiveWorkbook.Name;
        else if (app?.ActivePresentation) docName = app.ActivePresentation.Name;
        else if (app?.ActivePDF) docName = app.ActivePDF.Name || app.ActivePDF.FileName;
        else if (app?.ActivePdf) docName = app.ActivePdf.Name || app.ActivePdf.FileName;
        else if (app?.ActiveDocument) docName = app.ActiveDocument.Name;
      } catch (e) { /* ignore */ }
      return { host: info.host, label: info.label, document: docName };
    }
  });

  registry.registerTool({
    name: "suggest_quick_actions",
    hosts: ["*"],
    description: "向用户推荐一组当前文档场景下可执行的快捷操作。actions 中每一条会被渲染成一个按钮，用户点击后会自动以你给出的 prompt 作为下一条用户消息发送给你。请确保 prompt 是自洽的、明确指定要调用哪些工具完成什么。",
    parameters: {
      type: "object",
      required: ["actions"],
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            required: ["label", "prompt"],
            properties: {
              label: { type: "string", description: "按钮上显示的简短标签，控制在 12 个汉字以内" },
              prompt: { type: "string", description: "用户点击后将作为下一条消息发送的完整指令" }
            }
          }
        }
      }
    },
    handler: async ({ actions }) => {
      const cleaned = (actions || [])
        .filter((a) => a && typeof a.label === "string" && typeof a.prompt === "string")
        .map((a) => ({ label: a.label.trim(), prompt: a.prompt.trim() }))
        .filter((a) => a.label && a.prompt);
      // UI 层会监听 tool_result 事件、读取 value.actions 把它们渲染成按钮
      return { count: cleaned.length, actions: cleaned };
    }
  });
})(window);
