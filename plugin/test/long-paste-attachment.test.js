// 测长文本粘贴→临时附件的判定/命名纯函数。app.js 是超大 IIFE、带 DOM 依赖，整体跑不动；
// 跟 pdf-context.test.js 一样按文本锚点切出目标函数源码再 eval，不用 brace 计数。
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
  // endMarker 是"下一个函数"的起点，它前面往往挂着自己的注释块——那些注释属于下一个
  // 函数，不是当前函数的一部分，留在切片尾部会把包裹用的 ")" 一起注释掉。逐行剥掉
  // 切片末尾的空行/纯注释行，直到碰到真正的代码（比如函数的收尾 "}"）。
  const lines = appSrc.slice(s, e).split("\n");
  while (lines.length && /^\s*(\/\/.*)?$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

// isLongPasteText 依赖上面同一段的两个 const 阈值，一起切出来包一层 IIFE 再返回函数，
// 这样常量走闭包，不用在测试里重复硬编码阈值。
const isLongPasteText = vm.runInThisContext(
  "(function() {\n" +
    sliceFn("const LONG_PASTE_MIN_LINES", "function pasteAttachmentName") +
    "\nreturn isLongPasteText;\n})()"
);
const pasteAttachmentName = vm.runInThisContext(
  "(" + sliceFn("function pasteAttachmentName", "function createPastedTextAttachment") + ")"
);

test("isLongPasteText：短文本（少行 + 短字符）不算长", () => {
  assert.equal(isLongPasteText("hello"), false);
  assert.equal(isLongPasteText("line1\nline2\nline3"), false);
  assert.equal(isLongPasteText(""), false);
  assert.equal(isLongPasteText(null), false);
});

test("isLongPasteText：行数 >= 10 触发长文本判定", () => {
  const nineLines = Array.from({ length: 9 }, (_, i) => "l" + i).join("\n");
  const tenLines = Array.from({ length: 10 }, (_, i) => "l" + i).join("\n");
  assert.equal(isLongPasteText(nineLines), false);
  assert.equal(isLongPasteText(tenLines), true);
});

test("isLongPasteText：行数统计对 \\r\\n / \\r / \\n 一致", () => {
  const tenLinesCRLF = Array.from({ length: 10 }, (_, i) => "l" + i).join("\r\n");
  const tenLinesCR = Array.from({ length: 10 }, (_, i) => "l" + i).join("\r");
  assert.equal(isLongPasteText(tenLinesCRLF), true);
  assert.equal(isLongPasteText(tenLinesCR), true);
});

test("isLongPasteText：单行但字符数 >= 1500 触发长文本判定", () => {
  const justUnder = "a".repeat(1499);
  const atThreshold = "a".repeat(1500);
  assert.equal(isLongPasteText(justUnder), false);
  assert.equal(isLongPasteText(atThreshold), true);
});

test("isLongPasteText：短单行文本不算长", () => {
  assert.equal(isLongPasteText("a".repeat(50)), false);
});

test("pasteAttachmentName：多行用行数命名", () => {
  const text = "l1\nl2\nl3";
  assert.equal(pasteAttachmentName(text), "粘贴文本 (3 行)");
});

test("pasteAttachmentName：单行用字符数命名", () => {
  const text = "a".repeat(1500);
  assert.equal(pasteAttachmentName(text), "粘贴文本 (1500 字)");
});
