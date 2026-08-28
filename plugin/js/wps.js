(function attachWpsBridge(global) {
  "use strict";

  // Host 检测：通过特征属性判断当前 WPS 宿主类型
  // 注意：COM 对象的属性访问可能抛错，必须用 try/catch 包裹
  function detectHostFromApp(app) {
    console.log('[detectHost] start, app:', !!app);

    if (!app) {
      // 如果 Application 对象不可用，从 URL 路径推断
      console.log('[detectHost] no app, using URL fallback');
      try {
        const path = window.location.pathname;
        console.log('[detectHost] URL path:', path);
        if (path.includes('/pdf/')) return "pdf";
        if (path.includes('/wpp/')) return "wpp";
        if (path.includes('/et/')) return "et";
        if (path.includes('/wps/')) return "wps";
      } catch (e) {
        console.error('[detectHost] URL fallback error:', e);
      }
      return "unknown";
    }

    console.log('[detectHost] checking Active* properties');

    // PDF 优先识别：WPS PDF reader 既可能也暴露 ActiveDocument 兜底，得在 wps 之前判
    try { if (app.ActivePDF) { console.log('[detectHost] found ActivePDF'); return "pdf"; } } catch (e) {}
    try { if (app.ActivePdf) { console.log('[detectHost] found ActivePdf'); return "pdf"; } } catch (e) {}
    try { if (app.ActivePDFDocument) { console.log('[detectHost] found ActivePDFDocument'); return "pdf"; } } catch (e) {}
    try { if (app.ActiveWorkbook) { console.log('[detectHost] found ActiveWorkbook'); return "et"; } } catch (e) {}
    try { if (app.ActivePresentation) { console.log('[detectHost] found ActivePresentation'); return "wpp"; } } catch (e) {}
    try { if (app.ActiveDocument) { console.log('[detectHost] found ActiveDocument'); return "wps"; } } catch (e) {}

    console.log('[detectHost] no Active* found, checking collections');

    // 没有打开文档时按集合判断
    try { if (app.Workbooks) { console.log('[detectHost] found Workbooks'); return "et"; } } catch (e) {}
    try { if (app.Presentations) { console.log('[detectHost] found Presentations'); return "wpp"; } } catch (e) {}
    try { if (app.Documents) { console.log('[detectHost] found Documents'); return "wps"; } } catch (e) {}

    console.log('[detectHost] no collections found, trying URL fallback');

    // 最后从 URL 路径推断
    try {
      const path = window.location.pathname;
      console.log('[detectHost] fallback URL path:', path);
      if (path.includes('/pdf/')) { console.log('[detectHost] URL detected: pdf'); return "pdf"; }
      if (path.includes('/wpp/')) { console.log('[detectHost] URL detected: wpp'); return "wpp"; }
      if (path.includes('/et/')) { console.log('[detectHost] URL detected: et'); return "et"; }
      if (path.includes('/wps/')) { console.log('[detectHost] URL detected: wps'); return "wps"; }
    } catch (e) {
      console.error('[detectHost] URL fallback failed:', e);
    }

    console.warn('[detectHost] all methods failed, returning unknown');
    return "unknown";
  }

  async function getApplication() {
    if (global.WpsAiAddon?.getApplication) {
      const app = await global.WpsAiAddon.getApplication();
      if (app) return app;
    }
    return global.Application
      || global.wps?.WpsApplication?.()
      || global.wps?.EtApplication?.()
      || global.wps?.WppApplication?.()
      || global.wps?.PdfApplication?.()
      || global.wps?.PDFApplication?.()
      || global.wps?.KPdfApplication?.()
      || global.wps?.KpdfApplication?.()
      || global.pdf?.Application
      || global.kpdf?.Application
      || global.wps?.Application
      || null;
  }

  async function getHost() {
    const app = await getApplication();
    return detectHostFromApp(app);
  }

  async function getHostInfo() {
    // 强制从 URL 推断宿主类型（WPS 12.1.25867 Application 对象不可靠）
    let host = "unknown";
    let label = "未知宿主";

    try {
      const path = window.location.pathname;
      if (path.includes('/pdf/')) {
        host = "pdf";
        label = "WPS PDF";
      } else if (path.includes('/wpp/')) {
        host = "wpp";
        label = "WPS 演示";
      } else if (path.includes('/et/')) {
        host = "et";
        label = "WPS 表格";
      } else if (path.includes('/wps/')) {
        host = "wps";
        label = "WPS 文字";
      }
    } catch (e) {
      // 如果 URL 检测失败，才回退到 Application 对象检测
      const app = await getApplication();
      host = detectHostFromApp(app);
      label = getHostLabel(host);
    }

    return { host, label };
  }

  async function getHostBridge() {
    const host = await getHost();
    switch (host) {
      case "et":
        return global.WpsAiHostSpreadsheet || null;
      case "wpp":
        return global.WpsAiHostPresentation || null;
      case "pdf":
        return global.WpsAiHostPdf || null;
      case "wps":
        return global.WpsAiHostWriter || null;
    }
    // 修 B49：宿主检测为 "unknown"（启动竞态 / getApplication 返回 null）时，绝不兜底成 Writer——
    // 否则会在 Excel/PDF 环境里跑 Word API（Selection.TypeText 等），行为未定义。返回 null 让
    // ensureBridge 报"未检测到宿主"，由上层重试。
    return null;
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
      return app?.ActiveDocument || app?.ActiveWorkbook || app?.ActivePresentation || app?.ActivePDF || app?.ActivePdf || null;
    },
    getHost,
    getHostInfo,
    getHostBridge,
    getScopeOptions,
    readSelectionText,
    readDocumentText,
    readByScope
  };
})(window);
