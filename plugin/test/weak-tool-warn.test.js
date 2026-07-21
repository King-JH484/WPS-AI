const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// detectRestatedToolCall 是 app.js 内部纯函数，抽出来在隔离作用域里跑（不依赖 DOM）。
const appSrc = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8").replace(/\r\n/g, "\n");
const start = appSrc.indexOf("function detectRestatedToolCall(");
const end = appSrc.indexOf("\n  let _weakToolWarnedAt", start);
assert.ok(start > 0 && end > start, "detectRestatedToolCall 未找到");
const fnSrc = appSrc.slice(start, end);
const detect = new Function(fnSrc + "\nreturn detectRestatedToolCall;")();

const toolEvents = [
  { type: "tool_call", name: "et_read_range" },
  { type: "tool_result", name: "et_read_range" }
];

test("回答里出现工具内部名 → 判为复述（弱模型）", () => {
  assert.equal(detect(toolEvents, "我注意到你提到了 et_read_range 已被调用，但当前……", []), true);
});

test("复述措辞（工具名被拆开时的第二信号）→ 命中", () => {
  assert.equal(detect(toolEvents, "该工具已被调用了，我需要更多信息。", []), true);
  assert.equal(detect(toolEvents, "I noticed you mentioned a tool was invoked.", []), true);
});

test("正常回答（用数据答题、无工具名）→ 不误报", () => {
  assert.equal(detect(toolEvents, "当前表格共有 8 个社区：望京、朝阳、海淀……", []), false);
});

test("没执行工具 → 一律不提示", () => {
  assert.equal(detect([{ type: "assistant" }], "et_read_range 已被调用", []), false);
});

test("空回答 → 不提示", () => {
  assert.equal(detect(toolEvents, "   ", []), false);
});

test("extraToolNames 兜底：本轮事件无名但注册表里有该工具名", () => {
  const evs = [{ type: "tool_result" }]; // 没带 name
  assert.equal(detect(evs, "结果显示 wps_read_document 返回了内容", ["wps_read_document"]), true);
});

test("接线 + i18n：maybeWarnWeakToolModel 调用 + 词条存在", () => {
  assert.match(appSrc, /maybeWarnWeakToolModel\(turnEvents, assistantText\)/);
  assert.match(appSrc, /detectRestatedToolCall\(turnEvents, finalText, registered\)/);
  const i18n = fs.readFileSync(path.join(__dirname, "..", "js", "i18n.js"), "utf8");
  assert.match(i18n, /没有正确利用工具返回的数据来回答/);
  assert.match(i18n, /tool-calling ability is limited/);
});
