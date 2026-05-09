(function attachWriterHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  async function getActiveDocument() {
    const app = await getApp();
    return app?.ActiveDocument || null;
  }

  async function ensureDocument() {
    const doc = await getActiveDocument();
    if (!doc) {
      throw new Error("未检测到打开的 WPS 文字文档。");
    }
    return doc;
  }

  async function getSelection() {
    const app = await getApp();
    const doc = await getActiveDocument();
    return app?.Selection || doc?.Application?.Selection || null;
  }

  async function readSelectionText() {
    const sel = await getSelection();
    const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
    const text = sel?.Text || range?.Text || "";
    return String(text).trim();
  }

  async function readDocumentText() {
    const doc = await ensureDocument();
    const range = typeof doc.Range === "function" ? await doc.Range() : null;
    const text = doc.Content?.Text || range?.Text || "";
    return String(text).trim();
  }

  function looksLikeMarkdown(text) {
    if (typeof text !== "string") return false;
    return /(^|\n)\s*(#{1,6} |[-*+] |\d+\. |> |```)/.test(text)
      || /\*\*[^\n*]+\*\*/.test(text)
      || /(^|[^*])\*[^\n*]+\*([^*]|$)/.test(text)
      || /`[^`\n]+`/.test(text);
  }

  async function insertText(text, options = {}) {
    if (!text) throw new Error("没有可插入的文本。");
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前光标位置。");

    const format = options.format || (looksLikeMarkdown(text) ? "markdown" : "plain");
    if (format === "markdown" && global.WpsAiMarkdownToWord) {
      global.WpsAiMarkdownToWord.writeMarkdown(sel, text, { replace: false });
      return;
    }
    if (typeof sel.TypeText === "function") return sel.TypeText(text);
    if (typeof sel.InsertAfter === "function") return sel.InsertAfter(text);
    throw new Error("当前 Selection 对象不支持插入文本。");
  }

  async function replaceSelectionText(text, options = {}) {
    if (!text) throw new Error("没有可替换的文本。");
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");

    const format = options.format || (looksLikeMarkdown(text) ? "markdown" : "plain");
    if (format === "markdown" && global.WpsAiMarkdownToWord) {
      global.WpsAiMarkdownToWord.writeMarkdown(sel, text, { replace: true });
      return;
    }
    if ("Text" in sel) { sel.Text = text; return; }
    const range = typeof sel.Range === "function" ? await sel.Range() : sel.Range;
    if (range && "Text" in range) { range.Text = text; return; }
    if (typeof sel.TypeText === "function") return sel.TypeText(text);
    throw new Error("当前 Selection 对象不支持替换文本。");
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    return readDocumentText();
  }

  function getScopeOptions() {
    return [
      { value: "selection", label: "当前选区" },
      { value: "document", label: "全文" }
    ];
  }

  global.WpsAiHostWriter = {
    host: "wps",
    label: "WPS 文字",
    readSelectionText,
    readDocumentText,
    readByScope,
    insertText,
    replaceSelectionText,
    getScopeOptions,
    looksLikeMarkdown
  };
})(window);
