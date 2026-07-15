(function attachPresentationHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  async function getActivePresentation() {
    const app = await getApp();
    return app?.ActivePresentation || null;
  }

  async function ensurePresentation() {
    const pres = await getActivePresentation();
    if (!pres) throw new Error("未检测到打开的 WPS 演示。");
    return pres;
  }

  async function getActiveWindow() {
    const app = await getApp();
    return app?.ActiveWindow || null;
  }

  async function getSelection() {
    const win = await getActiveWindow();
    return win?.Selection || null;
  }

  // COM 对象的属性访问本身可能抛异常（选区类型不匹配时 ShapeRange/SlideRange 直接 throw，
  // 可选链 ?. 挡不住），必须用 try/catch 包裹，否则后面的兜底逻辑走不到。
  function safeShapeRange(sel) {
    try { return sel?.ShapeRange || null; } catch (error) { return null; }
  }

  function safeSlideRangeItem1(sel) {
    try {
      const sr = sel?.SlideRange;
      return sr?.Item ? sr.Item(1) : null;
    } catch (error) { return null; }
  }

  async function getCurrentSlide() {
    const sel = await getSelection();
    const view = safeSlideRangeItem1(sel);
    if (view) return view;
    const win = await getActiveWindow();
    if (win?.View?.Slide) return win.View.Slide;
    const pres = await ensurePresentation();
    return pres.Slides?.Item?.(1) || null;
  }

  function readShapeText(shape) {
    try {
      if (!shape?.HasTextFrame) return "";
      const frame = shape.TextFrame;
      const range = frame?.TextRange;
      const text = range?.Text || "";
      return String(text);
    } catch (error) {
      return "";
    }
  }

  function readSlideText(slide, withHeader = false) {
    if (!slide) return "";
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    const lines = [];
    for (let i = 1; i <= count; i += 1) {
      const shape = shapes.Item(i);
      const text = readShapeText(shape).trim();
      if (text) lines.push(text);
    }
    const body = lines.join("\n");
    if (!withHeader) return body;
    const idx = slide.SlideIndex || slide.Index || "";
    return `# Slide ${idx}\n${body}`;
  }

  async function readSelectedShapesText() {
    const sel = await getSelection();
    const shapeRange = safeShapeRange(sel);
    const count = shapeRange?.Count || 0;
    if (!count) return "";
    const lines = [];
    for (let i = 1; i <= count; i += 1) {
      const text = readShapeText(shapeRange.Item(i)).trim();
      if (text) lines.push(text);
    }
    return lines.join("\n");
  }

  async function readSlideAtCursor() {
    const slide = await getCurrentSlide();
    return readSlideText(slide).trim();
  }

  async function readPresentationText() {
    const pres = await ensurePresentation();
    const slides = pres.Slides;
    const count = slides?.Count || 0;
    const buffers = [];
    for (let i = 1; i <= count; i += 1) {
      buffers.push(readSlideText(slides.Item(i), true).trim());
    }
    return buffers.filter(Boolean).join("\n\n");
  }

  async function readSelectionText() {
    const text = await readSelectedShapesText();
    if (text) return text.trim();
    return readSlideAtCursor();
  }

  async function readDocumentText() {
    return readPresentationText();
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    if (scope === "slide") return readSlideAtCursor();
    return readPresentationText();
  }

  function pickWritableShape(slide) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    for (let i = 1; i <= count; i += 1) {
      const shape = shapes.Item(i);
      try {
        if (shape.HasTextFrame) return shape;
      } catch (error) { /* skip */ }
    }
    return null;
  }

  // mode = "replace" 整体覆盖形状文字；"append" 在原文末尾追加（insert 的正确语义）。
  function applyTextToShape(shape, text, mode) {
    const range = shape.TextFrame.TextRange;
    if (mode === "append") {
      if (typeof range.InsertAfter === "function") range.InsertAfter(text);
      else range.Text = String(range.Text || "") + text;
    } else {
      range.Text = text;
    }
  }

  async function writeToTextFrame(text, mode = "replace") {
    if (!text) throw new Error("没有可写入的文本。");

    const sel = await getSelection();
    const shapeRange = safeShapeRange(sel);
    if (shapeRange?.Count > 0) {
      const shape = shapeRange.Item(1);
      try {
        if (shape.HasTextFrame) {
          applyTextToShape(shape, text, mode);
          return;
        }
      } catch (error) { /* fallthrough */ }
    }

    const slide = await getCurrentSlide();
    if (!slide) throw new Error("未检测到当前幻灯片。");
    const shape = pickWritableShape(slide);
    if (!shape) throw new Error("当前幻灯片没有可写入文字的形状。");
    applyTextToShape(shape, text, mode);
  }

  async function insertText(text) {
    return writeToTextFrame(text, "append");
  }

  async function replaceSelectionText(text) {
    return writeToTextFrame(text, "replace");
  }

  function getScopeOptions() {
    return [
      { value: "selection", label: "当前选中形状" },
      { value: "slide", label: "当前幻灯片" },
      { value: "presentation", label: "整个演示文稿" }
    ];
  }

  global.WpsAiHostPresentation = {
    host: "wpp",
    label: "WPS 演示",
    readSelectionText,
    readDocumentText,
    readByScope,
    insertText,
    replaceSelectionText,
    getScopeOptions,
    _internal: {
      getApp,
      getActivePresentation,
      getCurrentSlide,
      readSlideText,
      readShapeText,
      writeToTextFrame
    }
  };
})(window);
