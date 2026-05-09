(function attachWpsBridge(global) {
  "use strict";

  // Host 检测：通过特征属性判断当前 WPS 宿主类型
  // 注意：COM 对象的属性访问可能抛错，必须用 try/catch 包裹
  function detectHostFromApp(app) {
    if (!app) return "unknown";

    try { if (app.ActiveWorkbook) return "et"; } catch (e) {}
    try { if (app.ActivePresentation) return "wpp"; } catch (e) {}
    try { if (app.ActiveDocument) return "wps"; } catch (e) {}

    // 没有打开文档时按集合判断
    try { if (app.Workbooks) return "et"; } catch (e) {}
    try { if (app.Presentations) return "wpp"; } catch (e) {}
    try { if (app.Documents) return "wps"; } catch (e) {}

    return "unknown";
  }

  async function getApplication() {
    if (global.WpsAiAddon?.getApplication) {
      const app = await global.WpsAiAddon.getApplication();
      if (app) return app;
    }
    return global.Application || global.wps?.Application || null;
  }

  async function getHost() {
    const app = await getApplication();
    return detectHostFromApp(app);
  }

  async function getHostBridge() {
    const host = await getHost();
    switch (host) {
      case "et":
        if (global.WpsAiHostSpreadsheet) return global.WpsAiHostSpreadsheet;
        break;
      case "wpp":
        if (global.WpsAiHostPresentation) return global.WpsAiHostPresentation;
        break;
      case "wps":
      default:
        if (global.WpsAiHostWriter) return global.WpsAiHostWriter;
    }
    // 兜底：找任何已加载的 host 模块
    return global.WpsAiHostWriter || global.WpsAiHostSpreadsheet || global.WpsAiHostPresentation || null;
  }

  function ensureBridge(bridge) {
    if (!bridge) {
      throw new Error("未检测到 WPS 宿主环境，请确认插件运行在 WPS 文字 / 表格 / 演示 中。");
    }
    return bridge;
  }

  // ---- 对外统一 API：保持与历史 WpsAiDocument 接口兼容 ----

  async function readSelectionText() {
    const bridge = ensureBridge(await getHostBridge());
    return bridge.readSelectionText();
  }

  async function readDocumentText() {
    const bridge = ensureBridge(await getHostBridge());
    return bridge.readDocumentText();
  }

  async function readByScope(scope) {
    const bridge = ensureBridge(await getHostBridge());
    if (typeof bridge.readByScope === "function") return bridge.readByScope(scope);
    return scope === "selection" ? bridge.readSelectionText() : bridge.readDocumentText();
  }

  async function insertText(text) {
    const bridge = ensureBridge(await getHostBridge());
    return bridge.insertText(text);
  }

  async function replaceSelectionText(text) {
    const bridge = ensureBridge(await getHostBridge());
    return bridge.replaceSelectionText(text);
  }

  async function getScopeOptions() {
    const bridge = await getHostBridge();
    if (!bridge) {
      return [
        { value: "selection", label: "当前选区" },
        { value: "document", label: "全文" }
      ];
    }
    return bridge.getScopeOptions();
  }

  async function getHostInfo() {
    const host = await getHost();
    const bridge = await getHostBridge();
    return {
      host,
      label: bridge?.label || "未知宿主"
    };
  }

  global.WpsAiDocument = {
    getApplication,
    getActiveDocument: async () => {
      const app = await getApplication();
      return app?.ActiveDocument || app?.ActiveWorkbook || app?.ActivePresentation || null;
    },
    getHost,
    getHostInfo,
    getHostBridge,
    getScopeOptions,
    readSelectionText,
    readDocumentText,
    readByScope,
    insertText,
    replaceSelectionText
  };
})(window);
