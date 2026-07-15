const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// 在当前 realm 执行模块，注入 localStorage/console，返回 WpsAiMaterialLibrary。
function load() {
  const mem = new Map();
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "material-library.js"), "utf8");
  const window = {};
  window.WpsAiStore = localStorage;
  const factory = vm.runInThisContext(
    "(function(window, localStorage, console){ " + code + "\n return window.WpsAiMaterialLibrary; })"
  );
  return factory(window, localStorage, console);
}

test("normalizeTags: 字符串按逗号/顿号/分号切分、去空去重、限量", () => {
  const M = load();
  assert.deepStrictEqual(M.normalizeTags("科技, 蓝色、科技；未来 "), ["科技", "蓝色", "未来"]);
  assert.deepStrictEqual(M.normalizeTags(["a", " a ", "b", ""]), ["a", "b"]);
  assert.strictEqual(M.normalizeTags("").length, 0);
  assert.ok(M.normalizeTags(Array.from({ length: 20 }, (_, i) => "t" + i)).length <= 12);
});

test("add/list: tags/project/source/kind 被持久化并可读回", () => {
  const M = load();
  M.add({ url: "/tmp/a.png", sourceUrl: "http://x/a.png", prompt: "蓝色科技封面", tags: ["科技", "蓝色"], project: "Q3汇报", source: "generated" });
  const e = M.list()[0];
  assert.strictEqual(e.url, "/tmp/a.png");
  assert.strictEqual(e.sourceUrl, "http://x/a.png");
  assert.deepStrictEqual(e.tags, ["科技", "蓝色"]);
  assert.strictEqual(e.project, "Q3汇报");
  assert.strictEqual(e.source, "generated");
  assert.strictEqual(e.kind, "image");
});

test("add: 派生素材可保留同 URL 的原素材", () => {
  const M = load();
  const original = M.add({ url: "/tmp/same.png", tags: ["原图标签"], source: "local" });
  const edited = M.add({ url: "/tmp/same.png", tags: ["重绘"], source: "inpaint" }, { allowDuplicate: true });
  const entries = M.list();

  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, edited.id);
  assert.equal(entries[1].id, original.id);
  assert.deepStrictEqual(entries[0].tags, ["重绘"]);
  assert.deepStrictEqual(entries[1].tags, ["原图标签"]);
});

test("normalizeEntry: 旧条目缺字段有默认值(向后兼容)", () => {
  const M = load();
  M.add({ url: "http://x/b.png" });
  const e = M.list()[0];
  assert.deepStrictEqual(e.tags, []);
  assert.strictEqual(e.project, "");
  assert.strictEqual(e.source, "generated");
  assert.strictEqual(e.kind, "image");
  assert.strictEqual(e.title, "");
  assert.strictEqual(e.text, "");
});

test("update: 合并 patch 并规整 tags", () => {
  const M = load();
  const a = M.add({ url: "http://x/c.png" });
  const u = M.update(a.id, { tags: "新, 标签、新", project: "P1" });
  assert.deepStrictEqual(u.tags, ["新", "标签"]);
  assert.strictEqual(u.project, "P1");
  assert.strictEqual(M.find(a.id).project, "P1");
});

test("update: 不存在的 id 返回 null", () => {
  const M = load();
  assert.strictEqual(M.update("nope", { tags: ["x"] }), null);
});

test("kind=web 素材保留 title/text", () => {
  const M = load();
  M.add({ url: "http://site/p", kind: "web", title: "标题", text: "正文内容", source: "web-fetch" });
  const e = M.list()[0];
  assert.strictEqual(e.kind, "web");
  assert.strictEqual(e.title, "标题");
  assert.strictEqual(e.text, "正文内容");
});

test("addMany: meta 透传 tags/project", () => {
  const M = load();
  M.addMany([{ url: "http://x/d.png" }], { project: "PX", tags: ["共享"] });
  const e = M.list()[0];
  assert.strictEqual(e.project, "PX");
  assert.deepStrictEqual(e.tags, ["共享"]);
});
