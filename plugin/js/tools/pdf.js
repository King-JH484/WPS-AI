(function attachPdfTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;
  const pdf = () => global.WpsAiHostPdf;

  registry.registerTool({
    name: "pdf_get_info",
    hosts: ["pdf"],
    description: "查询当前 PDF 的基础信息（页数）。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pages = await pdf().pageCount();
      return { pages };
    }
  });

  registry.registerTool({
    name: "pdf_read_document",
    hosts: ["pdf"],
    description: "读取整篇 PDF 的纯文本，每页前面带『【第 N 页】』标记。长 PDF 用 maxChars 限制总字符数，避免把上下文撑爆。",
    parameters: {
      type: "object",
      properties: {
        maxPages: { type: "number", description: "最多读多少页，默认全读" },
        maxChars: { type: "number", description: "总字符上限，默认无上限。长 PDF 建议 8000-15000" }
      }
    },
    handler: async ({ maxPages, maxChars } = {}) => {
      const text = await pdf().readDocumentText({ maxPages, maxChars });
      return { text, length: text.length };
    }
  });

  registry.registerTool({
    name: "pdf_read_page",
    hosts: ["pdf"],
    description: "读取 PDF 指定页码（1-based）的纯文本。",
    parameters: {
      type: "object",
      required: ["page"],
      properties: {
        page: { type: "number", description: "页码，从 1 开始" }
      }
    },
    handler: async ({ page }) => {
      const text = await pdf().readPage(page);
      return { page, text, length: text.length };
    }
  });
})(window);
