(function attachPdfHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  // WPS PDF 暴露的活动文档属性在不同版本里命名不一致，防御性多试几个
  async function getActivePdf() {
    const app = await getApp();
    if (!app) return null;
    try { if (app.ActivePDF) return app.ActivePDF; } catch (e) {}
    try { if (app.ActivePdf) return app.ActivePdf; } catch (e) {}
    try { if (app.ActivePDFDocument) return app.ActivePDFDocument; } catch (e) {}
    try { if (app.ActivePdfDoc) return app.ActivePdfDoc; } catch (e) {}
    try { if (app.ActiveDocument) return app.ActiveDocument; } catch (e) {}
    return null;
  }

  async function ensurePdf() {
    const pdf = await getActivePdf();
    if (!pdf) throw new Error("未检测到打开的 PDF 文档，请确认插件运行在 WPS PDF 中并已打开文件。");
    return pdf;
  }

  function pageCountSync(pdf) {
    try { if (typeof pdf.PageCount === "number") return pdf.PageCount; } catch (e) {}
    try {
      const fn = pdf.GetPageCount;
      if (typeof fn === "function") return Number(fn.call(pdf)) || 0;
    } catch (e) {}
    try { if (pdf.Pages?.Count != null) return Number(pdf.Pages.Count) || 0; } catch (e) {}
    try { if (typeof pdf.Pages === "number") return pdf.Pages; } catch (e) {}
    return 0;
  }

  // 取第 idx 页（1-based）。Pages 集合在不同版本是函数 / Item 方法 / 索引调用，都试一遍
  function getPageSync(pdf, idx) {
    try { if (typeof pdf.GetPage === "function") return pdf.GetPage(idx); } catch (e) {}
    try { if (pdf.Pages?.Item) return pdf.Pages.Item(idx); } catch (e) {}
    try { if (typeof pdf.Pages === "function") return pdf.Pages(idx); } catch (e) {}
    return null;
  }

  function getPageText(page) {
    if (!page) return "";
    try { if (typeof page.GetText === "function") return String(page.GetText() || ""); } catch (e) {}
    try { if (typeof page.GetAllText === "function") return String(page.GetAllText() || ""); } catch (e) {}
    try { if (typeof page.Text === "string") return page.Text; } catch (e) {}
    try { if (typeof page.Content === "string") return page.Content; } catch (e) {}
    return "";
  }

  async function readDocumentText({ maxPages, maxChars } = {}) {
    const pdf = await ensurePdf();
    const total = pageCountSync(pdf);
    if (!total) return "";
    const limit = maxPages && maxPages > 0 ? Math.min(maxPages, total) : total;
    const charCap = maxChars && maxChars > 0 ? maxChars : Infinity;
    const parts = [];
    let acc = 0;
    for (let i = 1; i <= limit; i += 1) {
      const raw = getPageText(getPageSync(pdf, i));
      if (!raw) continue;
      const trimmed = raw.trim();
      parts.push(`【第 ${i} 页】\n${trimmed}`);
      acc += trimmed.length;
      if (acc >= charCap) break;
    }
    return parts.join("\n\n");
  }

  async function readSelectionText() {
    // WPS PDF jsapi 不暴露稳定的"当前选区"API。退化为读第 1 页内容做提示
    return readDocumentText({ maxPages: 1 });
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    return readDocumentText();
  }

  function readOnly() {
    throw new Error("PDF 是只读宿主，无法写回原文。请把结果发到对话里，或新建 Word/PPT 再用。");
  }

  function getScopeOptions() {
    return [
      { value: "document", label: "整篇 PDF" },
      { value: "selection", label: "首页（PDF 不支持选区）" }
    ];
  }

  global.WpsAiHostPdf = {
    host: "pdf",
    label: "WPS PDF",
    readDocumentText,
    readSelectionText,
    readByScope,
    insertText: readOnly,
    replaceSelectionText: readOnly,
    getScopeOptions,
    getActivePdf,
    pageCount: async () => pageCountSync(await ensurePdf()),
    readPage: async (idx) => getPageText(getPageSync(await ensurePdf(), Math.max(1, Math.floor(idx || 1))))
  };
})(window);
