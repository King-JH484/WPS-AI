// 测 app.js 里两个 PDF 相关纯函数：占位符提取（Bug B 修复）与 PDF 文本上下文构造。
// app.js 是超大 IIFE、带 DOM 依赖，整体跑不动；这里按文本锚点切出目标函数源码再 eval，
// 不用 brace 计数（extractQuickPromptPlaceholders 的正则字面量里含 {} 会破坏计数）。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
function sliceFn(startMarker, endMarker) {
  const s = appSrc.indexOf(startMarker);
  assert.ok(s >= 0, "未找到起点: " + startMarker);
  const e = appSrc.indexOf(endMarker, s);
  assert.ok(e > s, "未找到终点: " + endMarker);
  return appSrc.slice(s, e).replace(/\s+$/, "");
}
const extractQuickPromptPlaceholders = vm.runInThisContext(
  "(" + sliceFn("function extractQuickPromptPlaceholders", "function cleanQuickPromptLabel") + ")"
);
const shouldUseMultilineQuickPromptInput = vm.runInThisContext(
  "(" + sliceFn("function shouldUseMultilineQuickPromptInput", "function extractQuickPromptPlaceholders") + ")"
);
const buildPdfTextContext = vm.runInThisContext(
  "(" + sliceFn("function buildPdfTextContext", "// 双通道读 PDF") + ")"
);
const parsePageRange = vm.runInThisContext(
  "(" + sliceFn("function parsePageRange", "function populateParallelTranslateLangs") + ")"
);

test("占位符：{{...}} 识别为输入", () => {
  const p = extractQuickPromptPlaceholders("翻译成 {{目标语言}}");
  assert.equal(p.length, 1);
  assert.equal(p[0].label, "目标语言");
  assert.equal(p[0].raw, "{{目标语言}}");
});

test("占位符：[P3] 页码标记被排除，真实输入保留", () => {
  const p = extractQuickPromptPlaceholders("目标语言：[在这里写] 带页码 [P3]");
  assert.equal(p.length, 1);
  assert.equal(p[0].label, "在这里写");
});

test("占位符：[...] 向后兼容仍识别", () => {
  const p = extractQuickPromptPlaceholders("请帮我写关于 [描述主题] 的内容");
  assert.equal(p.length, 1);
  assert.equal(p[0].label, "描述主题");
});

test("占位符：混合 [写主标题] + {{副标题}}，排除 [P12]", () => {
  const p = extractQuickPromptPlaceholders("主标题 [写主标题]，副标题 {{副标题}}，引用 [P12]");
  assert.equal(p.length, 2);
  assert.deepEqual(p.map((x) => x.label), ["写主标题", "副标题"]);
});

test("占位符：大小写页码 [p5] 也排除", () => {
  const p = extractQuickPromptPlaceholders("见 [p5] 与 [真实输入]");
  assert.equal(p.length, 1);
  assert.equal(p[0].label, "真实输入");
});

test("PDF 问答快捷输入使用多行输入框", () => {
  assert.equal(shouldUseMultilineQuickPromptInput({ host: "pdf", key: "qa" }), true);
  assert.equal(shouldUseMultilineQuickPromptInput({ host: "wps", key: "qa" }), false);
  assert.match(appSrc, /shouldUseMultilineQuickPromptInput\(payload\)/);
  assert.match(appSrc, /rows="5"/);
});

test("buildPdfTextContext：带页码 + 计数", () => {
  const r = buildPdfTextContext([{ page: 1, text: "hello" }, { page: 2, text: "world" }]);
  assert.match(r.contextText, /\[P1\] hello/);
  assert.match(r.contextText, /\[P2\] world/);
  assert.equal(r.usedPages, 2);
  assert.equal(r.totalPages, 2);
  assert.equal(r.truncated, false);
});

test("buildPdfTextContext：跳过空白页，usedPages 只计非空", () => {
  const r = buildPdfTextContext([{ page: 1, text: "   " }, { page: 2, text: "real" }]);
  assert.ok(!/\[P1\]/.test(r.contextText));
  assert.match(r.contextText, /\[P2\] real/);
  assert.equal(r.usedPages, 1); // 空白页不计入
});

test("buildPdfTextContext：全空白页 → usedPages 0（触发无可翻译文字守卫）", () => {
  const r = buildPdfTextContext([{ page: 3, text: "" }, { page: 4, text: "  " }]);
  assert.equal(r.usedPages, 0);
  assert.equal(r.charCount, 0);
});

test("buildPdfTextContext：超预算截断", () => {
  const big = "x".repeat(100);
  const pages = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, text: big }));
  const r = buildPdfTextContext(pages, 250);
  assert.equal(r.truncated, true);
  assert.ok(r.usedPages < 10);
  assert.ok(r.usedPages >= 1);
});

test("buildPdfTextContext：空输入不崩", () => {
  const r = buildPdfTextContext([]);
  assert.equal(r.usedPages, 0);
  assert.equal(r.totalPages, 0);
  assert.equal(r.truncated, false);
});

test("parsePageRange：区间 + 单页 + 去重升序", () => {
  assert.deepEqual(parsePageRange("1-3, 8, 2"), [1, 2, 3, 8]);
});

test("parsePageRange：全角逗号 + 倒序区间 + 波浪号", () => {
  assert.deepEqual(parsePageRange("5-3，10"), [3, 4, 5, 10]);
});

test("parsePageRange：max 上限裁剪 + 忽略非法", () => {
  assert.deepEqual(parsePageRange("1-5, abc, 99", 6), [1, 2, 3, 4, 5]);
});

test("parsePageRange：空/无效返回空数组", () => {
  assert.deepEqual(parsePageRange(""), []);
  assert.deepEqual(parsePageRange("abc, -"), []);
});
