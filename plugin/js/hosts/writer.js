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

  async function readSelectionSnapshot() {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
    const text = sel?.Text || range?.Text || "";
    return {
      text: String(text || "").trim(),
      range: {
        start: Number(range?.Start),
        end: Number(range?.End)
      }
    };
  }

  function HTML_FILE_URL() { return (window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/html-file"; }

  async function readDocumentText() {
    const doc = await ensureDocument();
    const range = typeof doc.Range === "function" ? await doc.Range() : null;
    const text = doc.Content?.Text || range?.Text || "";
    return String(text).trim();
  }

  const STYLE_IDS = {
    normal: -1,
    title: -63,
    subtitle: -75,
    heading1: -2,
    heading2: -3,
    heading3: -4,
    heading4: -5,
    bullet: -19,
    numbered: -29,
    quote: -85
  };

  function safeSet(obj, prop, value) {
    try { obj[prop] = value; } catch (e) {}
  }

  function clearParagraphFormat(sel) {
    try { sel?.Range?.ListFormat?.RemoveNumbers?.(); } catch (e) {}
    try {
      const pf = sel?.ParagraphFormat;
      if (!pf) return;
      safeSet(pf, "LeftIndent", 0);
      safeSet(pf, "FirstLineIndent", 0);
      safeSet(pf, "RightIndent", 0);
      safeSet(pf, "CharacterUnitLeftIndent", 0);
      safeSet(pf, "CharacterUnitFirstLineIndent", 0);
      safeSet(pf, "CharacterUnitRightIndent", 0);
      safeSet(pf, "SpaceBefore", 0);
      safeSet(pf, "SpaceAfter", 6);
      safeSet(pf, "LineSpacingRule", 0);
    } catch (e) {}
  }

  function applyBlockStyle(sel, type, level) {
    const t = String(type || "paragraph").toLowerCase();
    clearParagraphFormat(sel);
    let style = STYLE_IDS.normal;
    if (t === "title") style = STYLE_IDS.title;
    else if (t === "subtitle") style = STYLE_IDS.subtitle;
    else if (t === "heading") {
      const n = Math.max(1, Math.min(4, Number(level || 1)));
      style = STYLE_IDS[`heading${n}`] || STYLE_IDS.heading1;
    } else if (t === "quote") {
      style = STYLE_IDS.quote;
    } else if (t === "bullet") {
      style = STYLE_IDS.bullet;
    } else if (t === "numbered") {
      style = STYLE_IDS.numbered;
    }
    safeSet(sel, "Style", style);
    try {
      const font = sel.Font;
      if (font) {
        if (t === "title") {
          safeSet(font, "Bold", true);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 18);
        } else if (t === "subtitle") {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 12);
        } else if (t === "heading") {
          safeSet(font, "Bold", true);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", Number(level || 1) <= 1 ? 16 : (Number(level || 1) === 2 ? 14 : 12));
        } else if (t === "quote") {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", true);
          safeSet(font, "Size", 10.5);
        } else {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 10.5);
        }
      }
    } catch (e) {}
    if (t === "bullet") {
      try { sel.Range.ListFormat?.ApplyBulletDefault?.(); } catch (e) {}
    } else if (t === "numbered") {
      try { sel.Range.ListFormat?.ApplyNumberDefault?.(); } catch (e) {}
    }
    if ((t === "bullet" || t === "numbered") && Number(level) > 1) {
      try {
        const pf = sel.ParagraphFormat;
        if (pf) safeSet(pf, "LeftIndent", 14 * Math.min(Number(level) - 1, 5));
      } catch (e) {}
    }
  }

  function writePlainParagraph(sel, text) {
    const value = String(text || "").replace(/\s+$/g, "");
    if (value) {
      if (typeof sel.TypeText === "function") sel.TypeText(value);
      else if (typeof sel.InsertAfter === "function") sel.InsertAfter(value);
      else throw new Error("当前 Selection 对象不支持写入文本。");
    }
    if (typeof sel.TypeParagraph === "function") sel.TypeParagraph();
    else if (typeof sel.TypeText === "function") sel.TypeText("\n");
  }

  async function replaceDocumentBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("没有可替换的排版内容。");
    }
    await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    if (typeof sel.WholeStory !== "function") throw new Error("当前 Selection 不支持全文选择。");
    sel.WholeStory();
    try { sel.Delete(); } catch (e) {
      try { sel.Text = ""; } catch (e2) {}
    }
    for (const block of blocks) {
      const type = String(block?.type || "paragraph").toLowerCase();
      if (type === "spacer") {
        if (typeof sel.TypeParagraph === "function") sel.TypeParagraph();
        continue;
      }
      applyBlockStyle(sel, type, block?.level);
      const text = block?.text != null ? block.text : "";
      writePlainParagraph(sel, text);
      clearParagraphFormat(sel);
    }
    return { replaced: blocks.length };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function blocksToHtml(blocks) {
    const parts = [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8">',
      "<style>",
      "@page{margin:72pt 72pt 72pt 72pt;}",
      "body{font-family:SimSun,'Songti SC',serif;font-size:10.5pt;color:#111;}",
      "p.MsoNormal{margin:0 0 6pt 0;text-indent:21pt;mso-char-indent-count:2.0;line-height:175%;mso-line-height-rule:exactly;}",
      "p.LingxiSubtitle{margin:0 0 12pt 0;text-align:center;text-indent:0;font-size:12pt;color:#4b5563;line-height:150%;}",
      "p.LingxiQuote{margin:8pt 0 8pt 0;padding-left:12pt;border-left:3pt solid #1a6dff;color:#374151;font-style:italic;text-indent:0;line-height:165%;}",
      "h1{margin:0 0 16pt 0;text-align:center;font-size:18pt;font-weight:bold;line-height:135%;}",
      "h2{margin:14pt 0 6pt 0;font-size:16pt;font-weight:bold;line-height:145%;}",
      "h3{margin:14pt 0 6pt 0;font-size:14pt;font-weight:bold;line-height:145%;}",
      "h4{margin:14pt 0 6pt 0;font-size:12pt;font-weight:bold;line-height:145%;}",
      "ul,ol{margin:6pt 0 8pt 24pt;padding-left:18pt;line-height:165%;}",
      "li{margin:0 0 3pt 0;}",
      "</style>",
      "</head>",
      "<body>"
    ];
    let listTag = "";
    const closeList = () => {
      if (listTag) {
        parts.push(`</${listTag}>`);
        listTag = "";
      }
    };
    const listStyle = 'margin:6pt 0 8pt 24pt;padding-left:18pt;line-height:1.65;';
    blocks.forEach((block) => {
      const type = String(block?.type || "paragraph").toLowerCase();
      const text = escapeHtml(block?.text || "");
      if (type === "spacer") {
        closeList();
        parts.push('<p class="MsoNormal" style="text-indent:0;mso-char-indent-count:0;">&nbsp;</p>');
        return;
      }
      if (type === "bullet" || type === "numbered") {
        const tag = type === "numbered" ? "ol" : "ul";
        if (listTag !== tag) {
          closeList();
          parts.push(`<${tag} style="${listStyle}">`);
          listTag = tag;
        }
        parts.push(`<li style="margin:0 0 3pt 0;">${text}</li>`);
        return;
      }
      closeList();
      if (type === "title") {
        parts.push(`<h1 style="margin:0 0 16pt 0;text-align:center;font-size:18pt;font-weight:bold;line-height:1.35;">${text}</h1>`);
      } else if (type === "subtitle") {
        parts.push(`<p class="LingxiSubtitle" style="margin:0 0 12pt 0;text-align:center;font-size:12pt;color:#4b5563;text-indent:0;mso-char-indent-count:0;line-height:150%;">${text}</p>`);
      } else if (type === "heading") {
        const level = Math.max(1, Math.min(4, Number(block?.level || 2)));
        const size = level <= 1 ? 16 : (level === 2 ? 14 : 12);
        parts.push(`<h${Math.min(level + 1, 4)} style="margin:14pt 0 6pt 0;font-size:${size}pt;font-weight:bold;line-height:1.45;">${text}</h${Math.min(level + 1, 4)}>`);
      } else if (type === "quote") {
        parts.push(`<p class="LingxiQuote" style="margin:8pt 0 8pt 0;padding-left:12pt;border-left:3pt solid #1a6dff;color:#374151;font-style:italic;text-indent:0;mso-char-indent-count:0;line-height:165%;">${text}</p>`);
      } else {
        parts.push(`<p class="MsoNormal" style="margin:0 0 6pt 0;text-indent:21pt;mso-char-indent-count:2.0;line-height:175%;mso-line-height-rule:exactly;">${text}</p>`);
      }
    });
    closeList();
    parts.push("</body>", "</html>");
    return parts.join("");
  }

  async function replaceDocumentBlocksHtml(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("没有可替换的排版内容。");
    }
    await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const html = blocksToHtml(blocks);
    const resp = await fetch(HTML_FILE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.htmlPath) {
      throw new Error(payload.error || `html-file ${resp.status}`);
    }
    if (typeof sel.WholeStory !== "function") throw new Error("当前 Selection 不支持全文选择。");
    sel.WholeStory();
    try { sel.Delete(); } catch (e) {
      try { sel.Text = ""; } catch (e2) {}
    }
    const range = typeof sel.Range === "function" ? await sel.Range() : sel.Range;
    if (!range?.InsertFile) throw new Error("Range.InsertFile 不可用");
    range.InsertFile(payload.htmlPath);
    return { replaced: blocks.length, htmlPath: payload.htmlPath };
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

  async function replaceRangeText(rangeInfo, text, options = {}) {
    if (!text) throw new Error("没有可替换的文本。");
    const doc = await ensureDocument();
    const start = Number(rangeInfo?.start);
    const end = Number(rangeInfo?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return replaceSelectionText(text, options);
    }
    let range = null;
    try {
      if (typeof doc.Range === "function") range = doc.Range(start, end);
    } catch (e) {}
    if (!range) return replaceSelectionText(text, options);
    const format = options.format || (looksLikeMarkdown(text) ? "markdown" : "plain");
    try { range.Select?.(); } catch (e) {}
    const sel = await getSelection();
    if (format === "markdown" && global.WpsAiMarkdownToWord && sel) {
      global.WpsAiMarkdownToWord.writeMarkdown(sel, text, { replace: true });
      return;
    }
    if ("Text" in range) { range.Text = text; return; }
    if (sel && "Text" in sel) { sel.Text = text; return; }
    if (typeof sel?.TypeText === "function") return sel.TypeText(text);
    throw new Error("当前 Range 对象不支持替换文本。");
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
    readSelectionSnapshot,
    readDocumentText,
    readByScope,
    insertText,
    replaceSelectionText,
    replaceRangeText,
    replaceDocumentBlocks,
    replaceDocumentBlocksHtml,
    getScopeOptions,
    looksLikeMarkdown
  };
})(window);
