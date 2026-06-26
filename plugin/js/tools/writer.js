(function attachWriterTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const doc = () => global.WpsAiDocument;
  const writer = () => global.WpsAiHostWriter;
  const imageAssets = () => global.WpsAiImageAssets;
  const WD_COLLAPSE_END = 0;
  const MSO = { TRUE: -1, FALSE: 0 };
  function proxyBaseUrl() { return (window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"); }
  function DEBUG_LOG_URL() { return proxyBaseUrl() + "/debug-log"; }
  function LOCAL_IMAGE_INFO_URL() { return proxyBaseUrl() + "/local-image-info"; }
  function IMAGE_HTML_FILE_URL() { return proxyBaseUrl() + "/image-html-file"; }

  registry.registerTool({
    name: "wps_read_selection",
    hosts: ["wps"],
    description: "读取 WPS 文字 当前选区文本。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const text = await writer().readSelectionText();
      return { text };
    }
  });

  registry.registerTool({
    name: "wps_read_document",
    hosts: ["wps"],
    description: "读取 WPS 文字 当前整篇文档的纯文本。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const text = await writer().readDocumentText();
      return { text, length: text.length };
    }
  });

  registry.registerTool({
    name: "wps_insert_text",
    hosts: ["wps"],
    description: "在当前光标位置插入文本（不替换选中内容）。默认自动判断格式；想保持原样请显式传 format=\"plain\"。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "要插入的内容，支持 markdown" },
        format: { type: "string", enum: ["markdown", "plain"], description: "渲染方式，默认按内容自动判断（含 markdown 语法时按 markdown 渲染）" }
      }
    },
    handler: async ({ text, format } = {}) => {
      await writer().insertText(text, { format });
      return { inserted: text.length, format: format || "auto" };
    }
  });

  registry.registerTool({
    name: "wps_replace_selection",
    hosts: ["wps"],
    description: "用指定文本替换当前选区。默认自动判断格式；要写纯文本请传 format=\"plain\"。全文 AI 排版请走专用预览弹窗，不要用 markdown 替换全文。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "替换内容，支持 markdown" },
        format: { type: "string", enum: ["markdown", "plain"], description: "渲染方式，默认自动判断" }
      }
    },
    handler: async ({ text, format } = {}) => {
      await writer().replaceSelectionText(text, { format });
      return { replaced: text.length, format: format || "auto" };
    }
  });

  registry.registerTool({
    name: "wps_find_replace",
    hosts: ["wps"],
    description: "在当前 WPS 文字 文档全局执行查找/替换。",
    parameters: {
      type: "object",
      required: ["find", "replace"],
      properties: {
        find: { type: "string", description: "要查找的文本" },
        replace: { type: "string", description: "替换为" },
        matchCase: { type: "boolean", default: false }
      }
    },
    handler: async ({ find, replace, matchCase = false } = {}) => {
      const app = await doc().getApplication();
      const document = app?.ActiveDocument;
      if (!document) throw new Error("未检测到活动文档。");
      const range = document.Content;
      const finder = range.Find;
      finder.Text = find;
      finder.Replacement.Text = replace;
      finder.MatchCase = matchCase;
      // wdReplaceAll = 2
      const ok = finder.Execute(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
      return { matched: !!ok };
    }
  });

  // ---- 内部工具 ----

  async function getActiveDocument() {
    const app = await doc().getApplication();
    const d = app?.ActiveDocument;
    if (!d) throw new Error("未检测到活动文档。");
    return d;
  }

  async function getApp() {
    const app = await doc().getApplication();
    if (!app) throw new Error("未检测到 WPS 文字 应用对象。");
    return app;
  }

  function collectionCount(collection) {
    if (!collection) return null;
    try {
      const n = Number(collection.Count);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    }
  }

  function shortPath(value) {
    const raw = String(value || "");
    if (raw.length <= 180) return raw;
    return raw.slice(0, 80) + "..." + raw.slice(-80);
  }

  function debugLog(message, data) {
    try {
      console.log("[wps_insert_image]", message, data || "");
    } catch (e) {}
    try {
      fetch(DEBUG_LOG_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "wps_insert_image", message, data })
      }).catch(() => {});
    } catch (e) {}
  }

  function imageCounts(document) {
    return {
      inline: collectionCount(document?.InlineShapes),
      floating: collectionCount(document?.Shapes),
      fields: collectionCount(document?.Fields)
    };
  }

  function hasComparableCounts(before, after) {
    return (typeof before.inline === "number" && typeof after.inline === "number")
      || (typeof before.floating === "number" && typeof after.floating === "number");
  }

  function imageCountIncreased(before, after) {
    return (typeof before.inline === "number" && typeof after.inline === "number" && after.inline > before.inline)
      || (typeof before.floating === "number" && typeof after.floating === "number" && after.floating > before.floating);
  }

  function fieldCountIncreased(before, after) {
    return typeof before.fields === "number" && typeof after.fields === "number" && after.fields > before.fields;
  }

  function collectionItem(collection, index) {
    if (!collection || !index) return null;
    try { return collection.Item(index); } catch (e) {}
    try { return collection(index); } catch (e) {}
    return null;
  }

  function latestInsertedShape(document, before, after) {
    if (typeof before.inline === "number" && typeof after.inline === "number" && after.inline > before.inline) {
      return collectionItem(document?.InlineShapes, after.inline);
    }
    if (typeof before.floating === "number" && typeof after.floating === "number" && after.floating > before.floating) {
      return collectionItem(document?.Shapes, after.floating);
    }
    return null;
  }

  function safeRead(obj, prop) {
    try {
      const value = obj?.[prop];
      if (typeof value === "function") return null;
      return value == null ? null : value;
    } catch (e) {
      return null;
    }
  }

  function rangeInfo(range) {
    if (!range) return null;
    const info = {
      start: safeRead(range, "Start"),
      end: safeRead(range, "End")
    };
    try {
      const text = String(range.Text || "");
      info.textLength = text.length;
    } catch (e) {}
    return info;
  }

  function shapeInfo(shape) {
    if (!shape) return null;
    return {
      type: safeRead(shape, "Type"),
      name: safeRead(shape, "Name"),
      width: safeRead(shape, "Width"),
      height: safeRead(shape, "Height"),
      range: rangeInfo(safeRead(shape, "Range"))
    };
  }

  function duplicateRange(range) {
    if (!range) return null;
    try {
      const dup = typeof range.Duplicate === "function" ? range.Duplicate() : range.Duplicate;
      return dup || range;
    } catch (e) {
      return range;
    }
  }

  function collapsedSelectionRange(sel) {
    const range = duplicateRange(sel?.Range);
    if (!range) return null;
    try { range.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return range;
  }

  function documentRange(document, start, end) {
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    try {
      if (typeof document?.Range === "function") return document.Range(s, e);
    } catch (err) {}
    return null;
  }

  function hintedInsertionRange(document) {
    let hint = global.WpsAiWriterInsertionRangeHint;
    if (!hint) {
      try {
        const raw = localStorage.getItem("lingxi_writer_insertion_range_hint_v1");
        hint = raw ? JSON.parse(raw) : null;
      } catch (e) {
        hint = null;
      }
    }
    if (!hint || Date.now() - Number(hint.ts || 0) > 10 * 60 * 1000) return null;
    const range = documentRange(document, hint.start, hint.end);
    if (!range) return null;
    try { range.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return range;
  }

  function documentSelectionRange(document, sel) {
    const source = sel?.Range;
    const range = documentRange(document, safeRead(source, "Start"), safeRead(source, "End"));
    if (!range) return null;
    try { range.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return range;
  }

  function documentEndRange(document) {
    const content = duplicateRange(document?.Content);
    if (!content) return null;
    try { content.Collapse(WD_COLLAPSE_END); } catch (e) {}
    return content;
  }

  function applyImageSize(shape, width, height) {
    if (!shape) return;
    if (typeof width === "number") {
      try { shape.Width = width; } catch (e) {}
    }
    if (typeof height === "number") {
      try { shape.Height = height; } catch (e) {}
    }
  }

  function revealInsertedShape(app, shape) {
    if (!shape) return;
    try { shape.Select(); } catch (e) {}
    try { shape.Range?.Select?.(); } catch (e) {}
    try { app?.ActiveWindow?.ScrollIntoView?.(shape.Range, true); } catch (e) {}
    try { app?.ScreenRefresh?.(); } catch (e) {}
  }

  async function shortDelay(ms = 80) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function localImagePathCandidates(fileName) {
    const raw = String(fileName || "").trim();
    const candidates = [raw];
    if (!raw || /^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return candidates;
    if (/^\/var\//.test(raw)) candidates.push(`/private${raw}`);
    if (/^\/private\/var\//.test(raw)) candidates.push(raw.replace(/^\/private/, ""));
    try {
      const resp = await fetch(LOCAL_IMAGE_INFO_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: raw })
      });
      const payload = await resp.json().catch(() => ({}));
      if (resp.ok && payload.realPath) candidates.push(payload.realPath);
      if (resp.ok && payload.safePath) candidates.push(payload.safePath);
      if (resp.ok && payload.jpegPath) candidates.push(payload.jpegPath);
    } catch (e) {
      debugLog("local-image-info-failed", { fileName: shortPath(raw), error: e?.message || String(e) });
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  }

  async function writerImageCandidates(fileName) {
    const raw = String(fileName || "").trim();
    if (!raw) throw new Error("缺少图片路径 fileName。");
    if (/^https?:\/\//i.test(raw)) {
      const candidates = [raw];
      try {
        const local = await imageAssets()?.ensureLocalImagePath?.(raw);
        if (local && local !== raw) candidates.push(...await localImagePathCandidates(local));
      } catch (e) {
        debugLog("remote-localize-failed", { fileName: shortPath(raw), error: e?.message || String(e) });
      }
      return Array.from(new Set(candidates.filter(Boolean)));
    }
    const local = await imageAssets()?.ensureLocalImagePath?.(raw) || raw;
    return localImagePathCandidates(local);
  }

  async function prepareWordImageInsertion(app, document, sel) {
    const state = {
      interactive: safeRead(app, "Interactive"),
      protectionType: safeRead(document, "ProtectionType"),
      readOnly: safeRead(document, "ReadOnly"),
      documentName: safeRead(document, "Name"),
      selectionRange: rangeInfo(sel?.Range),
      hintedRange: rangeInfo(hintedInsertionRange(document)),
      documentSelectionRange: rangeInfo(documentSelectionRange(document, sel)),
      documentEndRange: rangeInfo(documentEndRange(document))
    };
    debugLog("app-state-before", state);
    try {
      if (app && app.Interactive === false) {
        app.Interactive = true;
        debugLog("interactive-restored", { previous: false });
      }
    } catch (e) {
      debugLog("interactive-restore-failed", { error: e?.message || String(e) });
    }
    try { if (app?.Visible === false) app.Visible = true; } catch (e) {}
    try { app?.Activate?.(); } catch (e) {}
    try { app?.ActiveWindow?.Activate?.(); } catch (e) {}
    try { document?.Activate?.(); } catch (e) {}
    try { sel?.Range?.Select?.(); } catch (e) {}
    await shortDelay(120);
    debugLog("app-state-after", {
      interactive: safeRead(app, "Interactive"),
      protectionType: safeRead(document, "ProtectionType"),
      readOnly: safeRead(document, "ReadOnly"),
      selectionRange: rangeInfo(app?.Selection?.Range || sel?.Range),
      hintedRange: rangeInfo(hintedInsertionRange(document)),
      documentSelectionRange: rangeInfo(documentSelectionRange(document, app?.Selection || sel)),
      documentEndRange: rangeInfo(documentEndRange(document))
    });
  }

  async function verifyDocumentImageCounts(document, before, strategyName, delayMs = 80) {
    await shortDelay(delayMs);
    const after = imageCounts(document);
    const inserted = imageCountIncreased(before, after);
    return { after, inserted, comparable: hasComparableCounts(before, after) };
  }

  async function probeTextWrite(document, sel) {
    const marker = `LINGXI_IMAGE_PROBE_${Date.now()}`;
    const range = hintedInsertionRange(document) || documentSelectionRange(document, sel) || collapsedSelectionRange(sel) || documentEndRange(document);
    const beforeStart = rangeInfo(range);
    try {
      if (range && "Text" in range) {
        range.Text = marker;
      } else if (typeof sel?.TypeText === "function") {
        sel.TypeText(marker);
      } else {
        return { ok: false, beforeStart, error: "无可用文本写入 API" };
      }
      await shortDelay(60);
      const content = String(document?.Content?.Text || "");
      const found = content.includes(marker);
      try {
        const cleanup = document?.Content?.Find;
        if (cleanup) {
          cleanup.Text = marker;
          cleanup.Replacement.Text = "";
          cleanup.Execute(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
        }
      } catch (e) {}
      return { ok: found, beforeStart, found };
    } catch (e) {
      return { ok: false, beforeStart, error: e?.message || String(e) };
    }
  }

  async function insertByHtmlFragment(document, app, sel, fileName, width, height) {
    const before = imageCounts(document);
    const resp = await fetch(IMAGE_HTML_FILE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fileName })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.htmlPath) {
      throw new Error(payload.error || `image-html-file ${resp.status}`);
    }
    const range = collapsedSelectionRange(sel);
    if (!range?.InsertFile) throw new Error("Range.InsertFile 不可用");
    range.InsertFile(payload.htmlPath);
    const verified = await verifyDocumentImageCounts(document, before, "range.insert-file-html", 120);
    debugLog("range-insert-file-html-result", { before, after: verified.after, inserted: verified.inserted, htmlPath: shortPath(payload.htmlPath), imagePath: shortPath(payload.imagePath) });
    if (!verified.inserted && verified.comparable) {
      throw new Error(`InsertFile HTML 后未确认新增图片。before=${JSON.stringify(before)} after=${JSON.stringify(verified.after)}`);
    }
    const shape = latestInsertedShape(document, before, verified.after);
    applyImageSize(shape, width, height);
    revealInsertedShape(app, shape);
    return { shape, strategy: "range.insert-file-html", before, after: verified.after, attempts: [] };
  }

  function fieldCodePath(fileName) {
    return String(fileName || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function addIncludePictureField(document, range, fileName) {
    if (!document?.Fields?.Add) throw new Error("Document.Fields.Add 不可用");
    if (!range) throw new Error("Range 不可用");
    const code = `INCLUDEPICTURE "${fieldCodePath(fileName)}" \\d`;
    try {
      return document.Fields.Add(range, 67, code, true);
    } catch (e1) {
      try { return document.Fields.Add(range, undefined, code, true); } catch (e2) {}
      try { return document.Fields.Add(range, 67, code); } catch (e3) {}
      throw e1;
    }
  }

  async function insertByIncludePictureField(document, app, sel, fileName, width, height) {
    const before = imageCounts(document);
    const ranges = [
      ["hinted", hintedInsertionRange(document)],
      ["documentSelection", documentSelectionRange(document, sel)],
      ["selection", collapsedSelectionRange(sel)],
      ["contentEnd", documentEndRange(document)]
    ].filter((entry) => entry[1]);

    for (const [label, range] of ranges) {
      try {
        const field = addIncludePictureField(document, range, fileName);
        try { field?.Update?.(); } catch (e) {}
        try { document?.Fields?.Update?.(); } catch (e) {}
        try { app?.ScreenRefresh?.(); } catch (e) {}
        const verified = await verifyDocumentImageCounts(document, before, `field.includePicture.${label}`, 160);
        const shape = latestInsertedShape(document, before, verified.after);
        debugLog("field-include-picture-result", {
          range: label,
          before,
          after: verified.after,
          inserted: verified.inserted,
          field: {
            code: (() => { try { return String(field?.Code?.Text || "").slice(0, 220); } catch (e) { return null; } })(),
            resultRange: rangeInfo(safeRead(field, "Result"))
          }
        });
        const fieldInserted = fieldCountIncreased(before, verified.after);
        if (verified.inserted || fieldInserted || (!verified.comparable && field)) {
          applyImageSize(shape, width, height);
          revealInsertedShape(app, shape);
          return { shape, strategy: `field.includePicture.${label}`, fileName, before, after: verified.after, attempts: [] };
        }
      } catch (e) {
        debugLog("field-include-picture-failed", { range: label, fileName: shortPath(fileName), error: e?.message || String(e) });
      }
    }

    throw new Error("INCLUDEPICTURE 域插入后未确认新增图片。");
  }

  async function insertWordImage(document, app, sel, fileNames, width, height) {
    const attempts = [];
    await prepareWordImageInsertion(app, document, sel);
    const strategies = [
      {
        name: "document.inlineShapes.fileOnly",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName);
        }
      },
      {
        name: "selection.inlineShapes.fileOnly",
        run: (targetFileName) => {
          if (!sel?.InlineShapes?.AddPicture) throw new Error("Selection.InlineShapes.AddPicture 不可用");
          return sel.InlineShapes.AddPicture(targetFileName);
        }
      },
      {
        name: "document.inlineShapes.hintedRange.mso",
        run: (targetFileName) => {
          const range = hintedInsertionRange(document);
          if (!range) throw new Error("无可用的弹窗前光标 Range");
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.inlineShapes.documentSelectionRange.mso",
        run: (targetFileName) => {
          const range = documentSelectionRange(document, sel);
          if (!range) throw new Error("Document.Range(selection) 不可用");
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.inlineShapes.originalSelectionRange.boolean",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, false, true, sel.Range);
        }
      },
      {
        name: "document.inlineShapes.originalSelectionRange.mso",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, sel.Range);
        }
      },
      {
        name: "selection.inlineShapes.boolean",
        run: (targetFileName) => {
          if (!sel?.InlineShapes?.AddPicture) throw new Error("Selection.InlineShapes.AddPicture 不可用");
          return sel.InlineShapes.AddPicture(targetFileName, false, true);
        }
      },
      {
        name: "range.inlineShapes.boolean",
        run: (targetFileName) => {
          const range = collapsedSelectionRange(sel);
          if (!range?.InlineShapes?.AddPicture) throw new Error("Range.InlineShapes.AddPicture 不可用");
          return range.InlineShapes.AddPicture(targetFileName, false, true);
        }
      },
      {
        name: "document.inlineShapes.collapsedRange.boolean",
        run: (targetFileName) => {
          const range = collapsedSelectionRange(sel);
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, false, true, range);
        }
      },
      {
        name: "document.inlineShapes.collapsedRange.mso",
        run: (targetFileName) => {
          const range = collapsedSelectionRange(sel);
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.inlineShapes.selectionRange.boolean",
        run: (targetFileName) => {
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, false, true, sel.Range);
        }
      },
      {
        name: "document.inlineShapes.contentEnd.mso",
        run: (targetFileName) => {
          const range = documentEndRange(document);
          if (!range) throw new Error("Document.Content Range 不可用");
          if (!document?.InlineShapes?.AddPicture) throw new Error("Document.InlineShapes.AddPicture 不可用");
          return document.InlineShapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, range);
        }
      },
      {
        name: "document.shapes.floating.anchor.mso",
        run: (targetFileName) => {
          if (!document?.Shapes?.AddPicture) throw new Error("Document.Shapes.AddPicture 不可用");
          const range = collapsedSelectionRange(sel);
          const shape = document.Shapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, 0, 0, undefined, undefined, range);
          try {
            return shape?.ConvertToInlineShape?.() || shape;
          } catch (e) {
            return shape;
          }
        }
      },
      {
        name: "document.shapes.floating.noAnchor.mso",
        run: (targetFileName) => {
          if (!document?.Shapes?.AddPicture) throw new Error("Document.Shapes.AddPicture 不可用");
          const shape = document.Shapes.AddPicture(targetFileName, MSO.FALSE, MSO.TRUE, 0, 0);
          try {
            return shape?.ConvertToInlineShape?.() || shape;
          } catch (e) {
            return shape;
          }
        }
      }
    ];

    const files = Array.isArray(fileNames) ? fileNames : await localImagePathCandidates(fileNames);
    debugLog("path-candidates", { files: files.map(shortPath) });

    for (const candidate of files) {
      for (const strategy of strategies) {
        const before = imageCounts(document);
        debugLog("try", { strategy: strategy.name, before, fileName: shortPath(candidate) });
        try {
          let shape = strategy.run(candidate);
          const verified = await verifyDocumentImageCounts(document, before, strategy.name);
          if (!shape && verified.inserted) shape = latestInsertedShape(document, before, verified.after);
          const info = shapeInfo(shape);
          attempts.push({ strategy: strategy.name, fileName: candidate, before, after: verified.after, inserted: verified.inserted, shape: info });
          debugLog("result", { strategy: strategy.name, before, after: verified.after, inserted: verified.inserted, shape: info });
          if (verified.inserted || (!verified.comparable && shape)) {
            applyImageSize(shape, width, height);
            revealInsertedShape(app, shape);
            debugLog("success", { strategy: strategy.name, before, after: verified.after, shape: shapeInfo(shape), fileName: shortPath(candidate) });
            return { shape, strategy: strategy.name, fileName: candidate, before, after: verified.after, attempts };
          }
        } catch (e) {
          const after = imageCounts(document);
          const inserted = imageCountIncreased(before, after);
          const shape = inserted ? latestInsertedShape(document, before, after) : null;
          attempts.push({
            strategy: strategy.name,
            fileName: candidate,
            before,
            after,
            inserted,
            shape: shapeInfo(shape),
            error: e?.message || String(e)
          });
          debugLog("error", {
            strategy: strategy.name,
            before,
            after,
            inserted,
            fileName: shortPath(candidate),
            error: e?.message || String(e)
          });
          if (inserted) {
            applyImageSize(shape, width, height);
            revealInsertedShape(app, shape);
            debugLog("success-after-error", { strategy: strategy.name, before, after, shape: shapeInfo(shape), fileName: shortPath(candidate) });
            return { shape, strategy: strategy.name, fileName: candidate, before, after, attempts };
          }
        }
      }

      if (!/^https?:\/\//i.test(candidate)) {
        try {
          const htmlInserted = await insertByHtmlFragment(document, app, sel, candidate, width, height);
          htmlInserted.attempts = attempts.concat([{ strategy: htmlInserted.strategy, fileName: candidate, before: htmlInserted.before, after: htmlInserted.after, inserted: true, shape: shapeInfo(htmlInserted.shape) }]);
          htmlInserted.fileName = candidate;
          debugLog("success", { strategy: htmlInserted.strategy, before: htmlInserted.before, after: htmlInserted.after, shape: shapeInfo(htmlInserted.shape), fileName: shortPath(candidate) });
          return htmlInserted;
        } catch (e) {
          debugLog("range-insert-file-html-failed", { fileName: shortPath(candidate), error: e?.message || String(e) });
        }

        try {
          const fieldInserted = await insertByIncludePictureField(document, app, sel, candidate, width, height);
          fieldInserted.attempts = attempts.concat([{ strategy: fieldInserted.strategy, fileName: candidate, before: fieldInserted.before, after: fieldInserted.after, inserted: true, shape: shapeInfo(fieldInserted.shape) }]);
          debugLog("success", { strategy: fieldInserted.strategy, before: fieldInserted.before, after: fieldInserted.after, shape: shapeInfo(fieldInserted.shape), fileName: shortPath(candidate) });
          return fieldInserted;
        } catch (e) {
          debugLog("field-include-picture-all-failed", { fileName: shortPath(candidate), error: e?.message || String(e) });
        }
      }
    }

    const last = attempts[attempts.length - 1] || null;
    const textProbe = await probeTextWrite(document, sel);
    debugLog("text-write-probe", textProbe);
    debugLog("failed", { fileName: shortPath(Array.isArray(fileNames) ? fileNames[0] : fileNames), last, textProbe });
    throw new Error(`WPS 未确认图片已插入。fileName=${Array.isArray(fileNames) ? fileNames[0] : fileNames}；最后状态=${JSON.stringify(last)}；文本写入探针=${JSON.stringify(textProbe)}`);
  }

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    // Word Color 也是 BGR 整数（0xBBGGRR）
    return (b << 16) | (g << 8) | r;
  }

  // wd 内置样式 ID（WdBuiltinStyle 枚举）
  const STYLE_IDS = {
    "Normal": -1, "正文": -1,
    "Heading 1": -2, "标题 1": -2, "标题1": -2,
    "Heading 2": -3, "标题 2": -3, "标题2": -3,
    "Heading 3": -4, "标题 3": -4, "标题3": -4,
    "Heading 4": -5, "Heading 5": -6, "Heading 6": -7,
    "Title": -63, "标题": -63,
    "Subtitle": -75, "副标题": -75,
    "Quote": -85, "引用": -85,
    "List Bullet": -19, "项目符号": -19,
    "List Number": -29, "编号列表": -29
  };

  // ---- 文档统计 / 大纲 / 选择 ----

  registry.registerTool({
    name: "wps_get_doc_stats",
    hosts: ["wps"],
    description: "获取当前文档统计信息：总字符数、汉字数、段落数、页数。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const stats = {};
      // WdStatistic 枚举：1=Words, 2=Lines, 3=Pages, 4=Paragraphs, 5=Characters, 6=CharactersWithSpaces
      const safe = (n) => {
        try { return document.ComputeStatistics(n); } catch (e) { return null; }
      };
      stats.words = safe(1);
      stats.lines = safe(2);
      stats.pages = safe(3);
      stats.paragraphs = safe(4);
      stats.characters = safe(5);
      stats.charactersWithSpaces = safe(6);
      try { stats.name = document.Name; } catch (e) { stats.name = null; }
      try { stats.saved = !!document.Saved; } catch (e) {}
      return stats;
    }
  });

  registry.registerTool({
    name: "wps_get_outline",
    hosts: ["wps"],
    description: "提取文档大纲（所有标题样式段落的层级和文本）。返回数组，每项含 level（1-9）、text、index。",
    parameters: {
      type: "object",
      properties: {
        maxLevel: { type: "integer", minimum: 1, maximum: 9, default: 3, description: "提取到第几级标题为止，默认 3" }
      }
    },
    handler: async ({ maxLevel = 3 } = {}) => {
      const document = await getActiveDocument();
      const paragraphs = document.Paragraphs;
      const count = paragraphs?.Count || 0;
      const out = [];
      for (let i = 1; i <= count; i += 1) {
        const p = paragraphs.Item(i);
        let styleName = "";
        try {
          const style = p.Style;
          styleName = typeof style === "string" ? style : (style?.NameLocal || style?.Name || "");
        } catch (e) { styleName = ""; }
        const m = /^(?:Heading|标题)\s*(\d)/i.exec(styleName);
        if (m) {
          const level = parseInt(m[1], 10);
          if (level <= maxLevel) {
            let text = "";
            try { text = String(p.Range.Text || "").replace(/[\r\n]+$/g, ""); } catch (e) {}
            out.push({ level, text, index: i });
          }
        }
      }
      return { count: out.length, headings: out };
    }
  });

  registry.registerTool({
    name: "wps_select_all",
    hosts: ["wps"],
    description: "选中整篇文档（等同 Ctrl+A）。后续 wps_replace_selection 可以替换全文。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      return { ok: true };
    }
  });

  registry.registerTool({
    name: "wps_replace_document",
    hosts: ["wps"],
    description: "替换整个文档内容（先全选再替换）。默认自动判断格式。慎用：此操作覆盖现有所有文字；AI 排版场景应走专用富文本预览弹窗。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "新内容，支持 markdown" },
        format: { type: "string", enum: ["markdown", "plain"] }
      }
    },
    handler: async ({ text, format } = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      await writer().replaceSelectionText(text, { format });
      return { replaced: text.length, format: format || "auto" };
    }
  });

  registry.registerTool({
    name: "wps_select_paragraph",
    hosts: ["wps"],
    description: "把选区移到指定序号的段落上（用于 wps_get_outline 返回的 index 跳转）。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1, description: "段落序号（从 1 开始）" }
      }
    },
    handler: async ({ index } = {}) => {
      const document = await getActiveDocument();
      const p = document.Paragraphs.Item(index);
      if (!p) throw new Error(`段落 ${index} 不存在`);
      p.Range.Select();
      return { selected: index };
    }
  });

  // ---- 段落样式 / 字符格式 ----

  registry.registerTool({
    name: "wps_apply_paragraph_style",
    hosts: ["wps"],
    description: "为当前选区应用段落样式。常用：Heading 1 / Heading 2 / Heading 3 / Normal / Title / Quote / List Bullet / List Number。",
    parameters: {
      type: "object",
      required: ["style"],
      properties: {
        style: { type: "string", description: "样式名（中英文都支持）" }
      }
    },
    handler: async ({ style } = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const styleId = STYLE_IDS[style];
      try {
        if (styleId != null) {
          sel.Style = styleId;
        } else {
          sel.Style = style;
        }
      } catch (e) {
        throw new Error(`应用样式失败：${e.message || e}`);
      }
      return { style };
    }
  });

  registry.registerTool({
    name: "wps_format_selection",
    hosts: ["wps"],
    description: "对当前选区应用字符格式（粗/斜/下划线/字体/字号/颜色）。所有参数可选，只设置传入的项。",
    parameters: {
      type: "object",
      properties: {
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        underline: { type: "boolean", description: "true=单下划线" },
        fontName: { type: "string", description: "字体名，如 \"宋体\"、\"Microsoft YaHei\"" },
        fontSize: { type: "number", description: "字号（磅）" },
        color: { type: "string", description: "字体颜色 #RRGGBB" },
        highlight: { type: "string", description: "荧光笔色 #RRGGBB（部分 WPS 版本支持）" }
      }
    },
    handler: async (opts = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const font = sel.Font;
      if (!font) throw new Error("未获取到 Font 对象。");
      const applied = {};
      if (typeof opts.bold === "boolean") { font.Bold = opts.bold ? 1 : 0; applied.bold = opts.bold; }
      if (typeof opts.italic === "boolean") { font.Italic = opts.italic ? 1 : 0; applied.italic = opts.italic; }
      if (typeof opts.underline === "boolean") {
        // wdUnderlineNone=0, wdUnderlineSingle=1
        font.Underline = opts.underline ? 1 : 0;
        applied.underline = opts.underline;
      }
      if (opts.fontName) { font.Name = opts.fontName; applied.fontName = opts.fontName; }
      if (typeof opts.fontSize === "number") { font.Size = opts.fontSize; applied.fontSize = opts.fontSize; }
      if (opts.color) { font.Color = parseColor(opts.color); applied.color = opts.color; }
      if (opts.highlight) {
        try { sel.Range.HighlightColorIndex = parseColor(opts.highlight); applied.highlight = opts.highlight; }
        catch (e) { /* 部分版本不支持 */ }
      }
      return { applied };
    }
  });

  // ---- 插入元素 ----

  registry.registerTool({
    name: "wps_insert_page_break",
    hosts: ["wps"],
    description: "在当前光标位置插入分页符。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      // wdPageBreak = 7
      sel.InsertBreak(7);
      return { ok: true };
    }
  });

  registry.registerTool({
    name: "wps_insert_table",
    hosts: ["wps"],
    description: "在当前光标位置插入表格。可选 data 是二维数组用于初始填充。",
    parameters: {
      type: "object",
      required: ["rows", "cols"],
      properties: {
        rows: { type: "integer", minimum: 1 },
        cols: { type: "integer", minimum: 1 },
        data: {
          type: "array",
          description: "二维数组，外层为行内层为列；单元格按 String() 写入。可省略。",
          items: { type: "array", items: { type: "string" } }
        }
      }
    },
    handler: async ({ rows, cols, data } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const table = document.Tables.Add(sel.Range, rows, cols);
      if (Array.isArray(data)) {
        for (let r = 0; r < Math.min(rows, data.length); r += 1) {
          const row = data[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < Math.min(cols, row.length); c += 1) {
            try {
              const cell = table.Cell(r + 1, c + 1);
              cell.Range.Text = String(row[c] ?? "");
            } catch (e) { /* skip */ }
          }
        }
      }
      return { rows, cols, filled: !!data };
    }
  });

  registry.registerTool({
    name: "wps_insert_hyperlink",
    hosts: ["wps"],
    description: "在当前光标位置插入超链接。textToDisplay 留空时显示 URL 本身。",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        textToDisplay: { type: "string" },
        screenTip: { type: "string", description: "鼠标悬停提示" }
      }
    },
    handler: async ({ url, textToDisplay, screenTip } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Hyperlinks.Add(sel.Range, url, undefined, screenTip, textToDisplay || url);
      return { url, textToDisplay: textToDisplay || url };
    }
  });

  registry.registerTool({
    name: "wps_insert_image",
    hosts: ["wps"],
    description: "在当前光标位置插入图片。fileName 可以是 HTTP URL、dataUrl 或本地路径；HTTP 会先按 WPS 原生方式插入，失败再本地化兜底。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        width: { type: "number", description: "宽度（磅，1磅=1/72英寸）；省略使用原图" },
        height: { type: "number", description: "高度（磅）；省略使用原图" }
      }
    },
    handler: async ({ fileName, width, height } = {}) => {
      if (!fileName) throw new Error("缺少图片路径 fileName。");
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const candidateFiles = await writerImageCandidates(fileName);
      debugLog("start", {
        sourceFileName: shortPath(fileName),
        candidateFiles: candidateFiles.map(shortPath),
        counts: imageCounts(document),
        selectionRange: rangeInfo(sel.Range)
      });
      const inserted = await insertWordImage(document, app, sel, candidateFiles, width, height);
      return {
        inserted: true,
        fileName: inserted.fileName || candidateFiles[0],
        sourceFileName: fileName,
        strategy: inserted.strategy,
        before: inserted.before,
        after: inserted.after,
        shape: shapeInfo(inserted.shape)
      };
    }
  });

  registry.registerTool({
    name: "wps_insert_toc",
    hosts: ["wps"],
    description: "在当前光标位置插入目录（基于文档中的标题样式）。",
    parameters: {
      type: "object",
      properties: {
        upperHeadingLevel: { type: "integer", default: 1 },
        lowerHeadingLevel: { type: "integer", default: 3 },
        useHyperlinks: { type: "boolean", default: true }
      }
    },
    handler: async ({ upperHeadingLevel = 1, lowerHeadingLevel = 3, useHyperlinks = true } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      // TablesOfContents.Add(Range, UseHeadingStyles, UpperHeadingLevel, LowerHeadingLevel,
      //   UseFields, TableID, RightAlignPageNumbers, IncludePageNumbers, AddedStyles, UseHyperlinks)
      document.TablesOfContents.Add(
        sel.Range, true, upperHeadingLevel, lowerHeadingLevel,
        false, undefined, true, true, undefined, useHyperlinks
      );
      return { upperHeadingLevel, lowerHeadingLevel };
    }
  });

  registry.registerTool({
    name: "wps_save",
    hosts: ["wps"],
    description: "保存当前文档（使用现有路径）。新文档需先在 WPS 里另存为再调用此工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      try {
        document.Save();
        return { saved: true, name: document.Name };
      } catch (e) {
        throw new Error(`保存失败（可能是新文档没有路径）：${e.message || e}`);
      }
    }
  });

  // ---- 批注 / 书签 ----

  registry.registerTool({
    name: "wps_add_comment",
    hosts: ["wps"],
    description: "对当前选区添加批注。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "批注内容" }
      }
    },
    handler: async ({ text } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Comments.Add(sel.Range, text);
      return { added: true };
    }
  });

  registry.registerTool({
    name: "wps_list_bookmarks",
    hosts: ["wps"],
    description: "列出文档中的所有书签。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const bms = document.Bookmarks;
      const count = bms?.Count || 0;
      const names = [];
      for (let i = 1; i <= count; i += 1) {
        try { names.push(bms.Item(i).Name); } catch (e) {}
      }
      return { count, bookmarks: names };
    }
  });

  registry.registerTool({
    name: "wps_add_bookmark",
    hosts: ["wps"],
    description: "在当前选区或光标位置添加命名书签。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "书签名（不能含空格和特殊字符）" }
      }
    },
    handler: async ({ name } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Bookmarks.Add(name, sel.Range);
      return { added: name };
    }
  });

  registry.registerTool({
    name: "wps_goto_bookmark",
    hosts: ["wps"],
    description: "跳转到指定书签的位置。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" }
      }
    },
    handler: async ({ name } = {}) => {
      const document = await getActiveDocument();
      const bm = document.Bookmarks.Item(name);
      if (!bm) throw new Error(`书签不存在：${name}`);
      bm.Select();
      return { gone: name };
    }
  });
})(window);
