const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function load() {
  const window = { WpsAiToolRegistry: { registerTool() {} } };
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "materials.js"), "utf8");
  const factory = vm.runInThisContext(
    "(function(window, console){ " + code + "\n return window.WpsAiMaterialsToolInternals; })"
  );
  return factory(window, console).filterMaterials;
}

const LIST = [
  { id: "1", prompt: "蓝色科技封面", tags: ["科技", "蓝色"], project: "Q3", kind: "image" },
  { id: "2", prompt: "绿色自然背景", tags: ["自然", "绿色"], project: "Q4", kind: "image" },
  { id: "3", title: "行业报告", text: "半导体市场增长", tags: ["半导体"], project: "Q3", kind: "web" }
];

test("filterMaterials: project 精确", () => {
  const f = load();
  assert.deepStrictEqual(f(LIST, { project: "Q3" }).map((e) => e.id), ["1", "3"]);
});

test("filterMaterials: kind 精确", () => {
  const f = load();
  assert.deepStrictEqual(f(LIST, { kind: "web" }).map((e) => e.id), ["3"]);
});

test("filterMaterials: tags 任一命中(大小写不敏感)", () => {
  const f = load();
  assert.deepStrictEqual(f(LIST, { tags: ["蓝色"] }).map((e) => e.id), ["1"]);
  assert.deepStrictEqual(f(LIST, { tags: ["不存在", "自然"] }).map((e) => e.id), ["2"]);
});

test("filterMaterials: query 子串命中 prompt/标签/标题/正文", () => {
  const f = load();
  assert.deepStrictEqual(f(LIST, { query: "科技" }).map((e) => e.id), ["1"]);
  assert.deepStrictEqual(f(LIST, { query: "半导体" }).map((e) => e.id), ["3"]); // 命中 text
});

test("filterMaterials: 组合 project+tags", () => {
  const f = load();
  assert.deepStrictEqual(f(LIST, { project: "Q3", tags: ["半导体"] }).map((e) => e.id), ["3"]);
});

test("filterMaterials: 空条件返回全部", () => {
  const f = load();
  assert.strictEqual(f(LIST, {}).length, 3);
});
