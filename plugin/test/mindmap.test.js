const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function load() {
  const window = {};
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "mindmap.js"), "utf8");
  const factory = vm.runInThisContext("(function(window){ " + code + "\n return window.WpsAiMindmap; })");
  return factory(window);
}

test("outlineToTree: 单个 # 作为根，层级正确", () => {
  const M = load();
  const t = M.outlineToTree("# 报告\n## 背景\n### 现状\n## 结论");
  assert.strictEqual(t.name, "报告");
  assert.deepStrictEqual(t.children.map((c) => c.name), ["背景", "结论"]);
  assert.deepStrictEqual(t.children[0].children.map((c) => c.name), ["现状"]);
});

test("outlineToTree: 列表项挂在最近标题下", () => {
  const M = load();
  const t = M.outlineToTree("# A\n## 要点\n- 第一\n- 第二");
  const yaodian = t.children.find((c) => c.name === "要点");
  assert.deepStrictEqual(yaodian.children.map((c) => c.name), ["第一", "第二"]);
});

test("outlineToTree: 缩进列表嵌套", () => {
  const M = load();
  const t = M.outlineToTree("## 章\n- 父\n  - 子1\n  - 子2");
  const fu = t.children.find((c) => c.name === "父");
  assert.deepStrictEqual(fu.children.map((c) => c.name), ["子1", "子2"]);
});

test("outlineToTree: 多个顶层 # 用合成根包住", () => {
  const M = load();
  const t = M.outlineToTree("# 一\n# 二");
  assert.strictEqual(t.name, "脑图");
  assert.deepStrictEqual(t.children.map((c) => c.name), ["一", "二"]);
});

test("outlineToTree: 清洗行内 markdown 与残留符号", () => {
  const M = load();
  const t = M.outlineToTree("# **加粗标题** `code`");
  assert.strictEqual(t.name, "加粗标题 code");
});

test("outlineToTree: 忽略非标题/列表的说明行", () => {
  const M = load();
  const t = M.outlineToTree("以下是脑图：\n# 主题\n- 点");
  assert.strictEqual(t.name, "主题");
  assert.deepStrictEqual(t.children.map((c) => c.name), ["点"]);
});

test("outlineToTree: 空输入返回空根", () => {
  const M = load();
  const t = M.outlineToTree("");
  assert.strictEqual(t.name, "脑图");
  assert.deepStrictEqual(t.children, []);
});

test("toMarkmapData: { name, children } → { content, children }，content 转义", () => {
  const M = load();
  const node = M.toMarkmapData({ name: "a<b> & c", children: [{ name: "子", children: [] }] });
  assert.strictEqual(node.content, "a&lt;b&gt; &amp; c");
  assert.strictEqual(node.children[0].content, "子");
  assert.deepStrictEqual(node.children[0].children, []);
});

test("outlineToMarkmap: markdown → markmap INode", () => {
  const M = load();
  const root = M.outlineToMarkmap("# 主题\n## 分支\n- 点");
  assert.strictEqual(root.content, "主题");
  assert.strictEqual(root.children[0].content, "分支");
  assert.strictEqual(root.children[0].children[0].content, "点");
});
