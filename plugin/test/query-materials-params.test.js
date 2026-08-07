const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadInternals() {
  const window = { WpsAiToolRegistry: { registerTool() {} } };
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "materials.js"), "utf8");
  const factory = vm.runInThisContext(
    "(function(window, console){ " + code + "\n return window.WpsAiMaterialsToolInternals; })"
  );
  return factory(window, console);
}

const LIST = [
  { id: "1", prompt: "蓝色科技封面", tags: ["科技"], project: "Q3", kind: "image", source: "generated", ts: 300 },
  { id: "2", prompt: "绿色自然背景", tags: ["自然"], project: "Q4", kind: "image", source: "web-search", ts: 100 },
  { id: "3", title: "行业报告", text: "半导体", tags: ["半导体"], project: "Q3", kind: "web", source: "web-fetch", ts: 200 }
];

test("filterMaterials: 按 source 过滤（此前返回了字段却不能过滤）", () => {
  const { filterMaterials } = loadInternals();
  assert.deepStrictEqual(filterMaterials(LIST, { source: "generated" }).map((e) => e.id), ["1"]);
  assert.deepStrictEqual(filterMaterials(LIST, { source: "web-search" }).map((e) => e.id), ["2"]);
});

test("filterMaterials: source 与其它条件叠加", () => {
  const { filterMaterials } = loadInternals();
  assert.deepStrictEqual(
    filterMaterials(LIST, { project: "Q3", source: "web-fetch" }).map((e) => e.id),
    ["3"]
  );
});

test("filterMaterials: 不传 source 时行为不变（全过）", () => {
  const { filterMaterials } = loadInternals();
  assert.strictEqual(filterMaterials(LIST, {}).length, 3);
});

test("sortMaterials: recent 按 ts 降序", () => {
  const { sortMaterials } = loadInternals();
  assert.deepStrictEqual(sortMaterials(LIST, "recent").map((e) => e.id), ["1", "3", "2"]);
});

test("sortMaterials: 默认/relevance 保持原顺序（稳定）", () => {
  const { sortMaterials } = loadInternals();
  assert.deepStrictEqual(sortMaterials(LIST, undefined).map((e) => e.id), ["1", "2", "3"]);
  assert.deepStrictEqual(sortMaterials(LIST, "relevance").map((e) => e.id), ["1", "2", "3"]);
});

test("sortMaterials: 不改原数组", () => {
  const { sortMaterials } = loadInternals();
  const copy = LIST.slice();
  sortMaterials(LIST, "recent");
  assert.deepStrictEqual(LIST, copy);
});
