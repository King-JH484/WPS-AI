const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// 加载 IIFE 模块到沙箱（脚本挂到 window 上）
function loadModule() {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "js", "markdown-to-word.js"),
    "utf8"
  );
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiMarkdownToWord;
}

// 假 Selection：记录 TypeText / Style / 段落 / bullet-number / 表格单元格 的调用序列
function makeFakeSelection() {
  const trace = [];
  const font = new Proxy({}, {
    set(t, p, v) { if (p === "Name") trace.push(["font.Name", v]);
                   if (p === "Bold" && v) trace.push(["bold"]);
                   if (p === "Italic" && v) trace.push(["italic"]);
                   t[p] = v; return true; },
    get(t, p) { return t[p]; }
  });
  const listFormat = {
    ApplyBulletDefault() { trace.push(["bullet"]); },
    ApplyNumberDefault() { trace.push(["number"]); },
    RemoveNumbers() {}
  };
  const fakeTable = {
    Style: 0,
    AutoFitBehavior() {},
    Cell(r, c) { return { Range: { set Text(v) { trace.push(["cell", r, c, v]); } } }; },
    Rows: { Item() { return { Range: { Font: {}, }, Shading: {} }; } },
    Range: { End: 0, Font: {} }
  };
  const range = {
    End: 0,
    ListFormat: listFormat,
    Tables: { Add() { trace.push(["table.add"]); return fakeTable; } }
  };
  const sel = {
    Font: font,
    ParagraphFormat: new Proxy({}, { set() { return true; }, get() { return 0; } }),
    Range: range,
    TypeText(t) { trace.push(["text", t]); },
    TypeParagraph() { trace.push(["para"]); },
    Delete() { trace.push(["delete"]); },
    SetRange() {}, MoveDown() {}, InsertAfter(t) { trace.push(["text", t]); }
  };
  Object.defineProperty(sel, "Style", {
    set(v) { trace.push(["style", v]); }, get() { return -1; }, configurable: true
  });
  return { sel, trace };
}

test("paragraph with plain text writes one run", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "你好" }]);
  assert.deepStrictEqual(trace.filter((e) => e[0] === "text"), [["text", "你好"]]);
});

test("整段文本里的换行保留成软回车（翻译替换不再丢换行）", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "第一行\n第二行\r\n第三行" }]);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["第一行", "\x0B", "第二行", "\x0B", "第三行"]);
});

test("paragraphBlocks：\\n / \\r\\n / 单独 \\r 都切成独立段落块", () => {
  const mod = loadModule();
  const blocks = mod.paragraphBlocks("段一\n段二\r\n段三\r段四");
  const paras = blocks.filter((b) => b.type === "paragraph").map((b) => b.text);
  assert.deepStrictEqual([...paras], ["段一", "段二", "段三", "段四"]); // 跨 realm：重装进本 realm 数组再比
});

test("无换行的单行文本仍是一次 TypeText（不改变原行为）", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "单行没有换行" }]);
  assert.deepStrictEqual(trace.filter((e) => e[0] === "text"), [["text", "单行没有换行"]]);
});

test("paragraph with runs applies bold/italic without markdown parsing", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", runs: [
    { text: "普通" }, { text: "粗", bold: true }, { text: "斜", italic: true }
  ] }]);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["普通", "粗", "斜"]);
  assert.ok(trace.some((e) => e[0] === "bold"));
  assert.ok(trace.some((e) => e[0] === "italic"));
});

test("literal markdown in text is NOT parsed (star stays literal)", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "**不该加粗**" }]);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["**不该加粗**"]);
  assert.ok(!trace.some((e) => e[0] === "bold"));
});

test("heading applies HeadingN style", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "heading", level: 2, text: "标题" }]);
  assert.ok(trace.some((e) => e[0] === "style" && e[1] === -3)); // Heading2
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "标题"));
});

test("heading honors levels 4-6 (schema promises 1-6)", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "heading", level: 5, text: "H5" }]);
  assert.ok(trace.some((e) => e[0] === "style" && e[1] === -6)); // Heading5
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "H5"));
});

test("list writes each item as bullet/number", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "list", ordered: false, items: ["甲", "乙"] }]);
  assert.strictEqual(trace.filter((e) => e[0] === "bullet").length, 2);
  const texts = trace.filter((e) => e[0] === "text").map((e) => e[1]);
  assert.deepStrictEqual(texts, ["甲", "乙"]);
});

test("ordered list uses number default", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "list", ordered: true, items: ["一"] }]);
  assert.strictEqual(trace.filter((e) => e[0] === "number").length, 1);
});

test("table fills cells and adds a native table", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "table", header: true, rows: [["A", "B"], ["1", "2"]] }]);
  assert.ok(trace.some((e) => e[0] === "table.add"));
  assert.ok(trace.some((e) => e[0] === "cell" && e[3] === "A"));
  assert.ok(trace.some((e) => e[0] === "cell" && e[3] === "2"));
});

test("code block switches to Consolas and writes text verbatim", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "code", text: "x=1" }]);
  assert.ok(trace.some((e) => e[0] === "font.Name" && e[1] === "Consolas"));
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "x=1"));
});

test("spacer emits a paragraph break", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "spacer" }]);
  assert.ok(trace.some((e) => e[0] === "para"));
});

test("replace option clears the selection first", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "新" }], { replace: true });
  assert.strictEqual(trace[0][0], "delete");
});

test("unknown block type is skipped, following block still runs", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  assert.doesNotThrow(() => mod.writeBlocks(sel, [{ type: "bogus" }, { type: "paragraph", text: "ok" }]));
  // 跳过未知块后，后续合法块仍要写出 —— 证明未知块没有中断整个数组
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "ok"));
});

test("paragraph block with listFormat bullet re-applies bullet before text", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "改写后的项" }], {
    replace: true, listFormat: { kind: "bullet", level: 1 }
  });
  const bulletIdx = trace.findIndex((e) => e[0] === "bullet");
  const textIdx = trace.findIndex((e) => e[0] === "text" && e[1] === "改写后的项");
  assert.ok(bulletIdx !== -1, "should apply a bullet");
  assert.ok(textIdx !== -1, "should write the text");
  assert.ok(bulletIdx < textIdx, "bullet must come before the text");
});

test("paragraph block with listFormat numbered re-applies number", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "paragraph", text: "改写后的项" }], {
    replace: true, listFormat: { kind: "numbered", level: 1 }
  });
  assert.ok(trace.some((e) => e[0] === "number"), "should apply a number");
  assert.ok(!trace.some((e) => e[0] === "bullet"), "should not apply a bullet");
});

test("listFormat only affects paragraph blocks, not headings", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  mod.writeBlocks(sel, [{ type: "heading", level: 2, text: "标题" }], {
    replace: true, listFormat: { kind: "bullet", level: 1 }
  });
  assert.ok(!trace.some((e) => e[0] === "bullet"), "heading must not get a bullet");
  assert.ok(!trace.some((e) => e[0] === "number"), "heading must not get a number");
  assert.ok(trace.some((e) => e[0] === "style" && e[1] === -3), "heading keeps Heading2 style");
});

test("a block that throws does not abort the rest (per-block try/catch/continue)", () => {
  const mod = loadModule();
  const { sel, trace } = makeFakeSelection();
  // 让第一次 TypeText 抛出；writeRuns 会退化到 InsertAfter，所以 InsertAfter 也要抛，
  // 才能把异常抛到 writeBlocks 的外层 per-block catch。之后的调用恢复正常记录。
  let firstText = true;
  sel.TypeText = (t) => {
    if (firstText) { firstText = false; throw new Error("boom-typetext"); }
    trace.push(["text", t]);
  };
  let firstInsert = true;
  sel.InsertAfter = (t) => {
    if (firstInsert) { firstInsert = false; throw new Error("boom-insertafter"); }
    trace.push(["text", t]);
  };
  assert.doesNotThrow(() =>
    mod.writeBlocks(sel, [{ type: "paragraph", text: "boom" }, { type: "paragraph", text: "after" }])
  );
  // 第一个块彻底抛出后，第二个块仍被写出
  assert.ok(trace.some((e) => e[0] === "text" && e[1] === "after"));
});
