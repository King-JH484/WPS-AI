const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadModule() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "markdown-to-word.js"), "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiMarkdownToWord;
}

test("blocksFromMarkdown maps heading/paragraph/list/table", () => {
  const m = loadModule();
  const blocks = m.blocksFromMarkdown("# 标题\n\n正文有**粗体**\n\n- 甲\n- 乙\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("paragraph"));
  assert.ok(types.includes("list"));
  assert.ok(types.includes("table"));
  const h = blocks.find((b) => b.type === "heading");
  assert.strictEqual(h.level, 1);
  assert.strictEqual(h.text, "标题");
});

test("blocksFromMarkdown paragraph keeps inline bold as runs (no literal **)", () => {
  const m = loadModule();
  const blocks = m.blocksFromMarkdown("有**粗**字");
  const p = blocks.find((b) => b.type === "paragraph");
  assert.ok(Array.isArray(p.runs));
  assert.ok(p.runs.some((r) => r.text === "粗" && r.bold === true));
  assert.ok(!p.runs.some((r) => r.text.includes("**")));
});

test("blocksFromMarkdown unordered/ordered items become list blocks", () => {
  const m = loadModule();
  const ul = m.blocksFromMarkdown("- 项");
  assert.strictEqual(ul[0].type, "list");
  assert.strictEqual(ul[0].ordered, false);
  const ol = m.blocksFromMarkdown("1. 项");
  assert.strictEqual(ol[0].type, "list");
  assert.strictEqual(ol[0].ordered, true);
});

test("blocksFromMarkdown merges consecutive ul items into one list block", () => {
  const m = loadModule();
  const blocks = m.blocksFromMarkdown("- 甲\n- 乙\n- 丙");
  const lists = blocks.filter((b) => b.type === "list");
  assert.strictEqual(lists.length, 1);
  assert.strictEqual(lists[0].ordered, false);
  assert.strictEqual(lists[0].items.length, 3);
});

test("blocksFromMarkdown merges consecutive ol items into one list block", () => {
  const m = loadModule();
  const blocks = m.blocksFromMarkdown("1. 一\n2. 二");
  const lists = blocks.filter((b) => b.type === "list");
  assert.strictEqual(lists.length, 1);
  assert.strictEqual(lists[0].ordered, true);
  assert.strictEqual(lists[0].items.length, 2);
});

test("blocksFromMarkdown keeps ul run and ol run as separate list blocks", () => {
  const m = loadModule();
  const blocks = m.blocksFromMarkdown("- a\n- b\n\n1. c\n2. d");
  const lists = blocks.filter((b) => b.type === "list");
  assert.strictEqual(lists.length, 2);
  assert.strictEqual(lists[0].ordered, false);
  assert.strictEqual(lists[0].items.length, 2);
  assert.strictEqual(lists[1].ordered, true);
  assert.strictEqual(lists[1].items.length, 2);
});

test("blocksFromMarkdown table includes header row first", () => {
  const m = loadModule();
  const blocks = m.blocksFromMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  const t = blocks.find((b) => b.type === "table");
  assert.strictEqual(t.header, true);
  // JSON round-trip: vm.createContext gives sandboxed arrays a different
  // Array.prototype from this file's realm; deepStrictEqual checks prototype
  // identity, so normalize before comparing (see task-5-report.md).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.rows[0])), ["A", "B"]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.rows[1])), ["1", "2"]);
});

test("paragraphBlocks splits plain text by newline into paragraphs", () => {
  const m = loadModule();
  const blocks = m.paragraphBlocks("第一段\n第二段");
  const paras = blocks.filter((b) => b.type === "paragraph");
  assert.strictEqual(paras.length, 2);
  assert.strictEqual(paras[0].text, "第一段");
  assert.strictEqual(paras[1].text, "第二段");
});

test("paragraphBlocks does NOT parse markdown (plain text stays literal)", () => {
  const m = loadModule();
  const blocks = m.paragraphBlocks("**不该加粗**");
  assert.strictEqual(blocks[0].type, "paragraph");
  assert.strictEqual(blocks[0].text, "**不该加粗**");
});

test("paragraphBlocks blank line becomes spacer, trailing spacers trimmed", () => {
  const m = loadModule();
  const blocks = m.paragraphBlocks("A\n\nB\n\n");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(blocks.map((b) => b.type))), ["paragraph", "spacer", "paragraph"]);
});

test("paragraphBlocks empty input yields one empty paragraph", () => {
  const m = loadModule();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.paragraphBlocks(""))), [{ type: "paragraph", text: "" }]);
});
