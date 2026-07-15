const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadHost() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", "writer.js"), "utf8");
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiHostWriter;
}

test("formatDocContextForPrompt: null -> empty string", () => {
  const h = loadHost();
  assert.strictEqual(h.formatDocContextForPrompt(null), "");
});

test("formatDocContextForPrompt: all-empty ctx -> empty string", () => {
  const h = loadHost();
  assert.strictEqual(h.formatDocContextForPrompt({ title: "", outline: [], before: "", after: "" }), "");
});

test("formatDocContextForPrompt: title only omits outline/context blocks", () => {
  const h = loadHost();
  const out = h.formatDocContextForPrompt({ title: "项目周报", outline: [], before: "", after: "" });
  assert.ok(out.includes("【文档背景】"));
  assert.ok(out.includes("标题：项目周报"));
  assert.ok(!out.includes("大纲："));
  assert.ok(!out.includes("选区前文"));
  assert.ok(!out.includes("选区后文"));
});

test("formatDocContextForPrompt: full context renders all blocks with heading depth", () => {
  const h = loadHost();
  const out = h.formatDocContextForPrompt({
    title: "白皮书",
    outline: [{ level: 1, text: "概述" }, { level: 2, text: "背景" }, { level: 3, text: "细节" }],
    before: "前面这段",
    after: "后面这段"
  });
  assert.ok(out.includes("标题：白皮书"));
  assert.ok(out.includes("# 概述"));
  assert.ok(out.includes("## 背景"));
  assert.ok(out.includes("### 细节"));
  assert.ok(out.includes("选区前文：…前面这段"));
  assert.ok(out.includes("选区后文：后面这段…"));
});

test("formatDocContextForPrompt: heading level clamped to 1-3", () => {
  const h = loadHost();
  const out = h.formatDocContextForPrompt({ title: "", outline: [{ level: 7, text: "深层" }], before: "", after: "" });
  assert.ok(out.includes("### 深层"));   // 7 -> clamp 3
  assert.ok(!out.includes("####"));
});

test("formatDocContextForPrompt: total output capped at 3500 chars", () => {
  const h = loadHost();
  const big = "字".repeat(5000);
  const out = h.formatDocContextForPrompt({ title: "T", outline: [], before: big, after: "" });
  assert.ok(out.length <= 3500);
});
