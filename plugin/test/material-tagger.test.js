const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// 同一个 window 里先装 material-library（提供 normalizeTags），再装 material-tagger。
function load() {
  const mem = new Map();
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
  const window = {};
  window.WpsAiStore = localStorage;
  const ml = fs.readFileSync(path.join(__dirname, "..", "js", "material-library.js"), "utf8");
  vm.runInThisContext("(function(window, localStorage, console){ " + ml + " })")(window, localStorage, console);
  const tg = fs.readFileSync(path.join(__dirname, "..", "js", "material-tagger.js"), "utf8");
  const factory = vm.runInThisContext("(function(window, console){ " + tg + "\n return window.WpsAiMaterialTagger; })");
  return factory(window, console);
}

test("parseTagsReply: 去前缀、逗号/顿号切分", () => {
  const T = load();
  assert.deepStrictEqual(T.parseTagsReply("标签：科技, 蓝色、未来"), ["科技", "蓝色", "未来"]);
});

test("parseTagsReply: 换行与项目符号", () => {
  const T = load();
  assert.deepStrictEqual(T.parseTagsReply("- 科技\n- 蓝色\n- 未来"), ["科技", "蓝色", "未来"]);
});

test("parseTagsReply: 空输入 → []", () => {
  const T = load();
  assert.deepStrictEqual(T.parseTagsReply(""), []);
  assert.deepStrictEqual(T.parseTagsReply(null), []);
});

test("parseTagsReply: 以数字开头的标签不被吞首位数字", () => {
  const T = load();
  assert.deepStrictEqual(T.parseTagsReply("3D建模，赛博朋克，未来感"), ["3D建模", "赛博朋克", "未来感"]);
  assert.deepStrictEqual(T.parseTagsReply("2K海报，4K壁纸"), ["2K海报", "4K壁纸"]);
});

test("parseTagsReply: 编号列表仍被正确剥离", () => {
  const T = load();
  assert.deepStrictEqual(T.parseTagsReply("1. 科技\n2. 蓝色\n3. 未来"), ["科技", "蓝色", "未来"]);
  assert.deepStrictEqual(T.parseTagsReply("1) 科技\n2) 蓝色"), ["科技", "蓝色"]);
});

test("parseTagsReply: 最多 8 个", () => {
  const T = load();
  const many = Array.from({ length: 15 }, (_, i) => "标签" + i).join(",");
  assert.ok(T.parseTagsReply(many).length <= 8);
});

test("tagImage: 文本路径用注入 chat 产出标签", async () => {
  const T = load();
  const tags = await T.tagImage({ prompt: "蓝色科技封面", chat: async () => "科技, 蓝色, 封面" });
  assert.deepStrictEqual(tags, ["科技", "蓝色", "封面"]);
});

test("tagImage: 无 prompt 无图 → []", async () => {
  const T = load();
  assert.deepStrictEqual(await T.tagImage({ chat: async () => "不该被调用" }), []);
});

test("tagImage: chat 抛错 → [] (best-effort)", async () => {
  const T = load();
  assert.deepStrictEqual(await T.tagImage({ prompt: "x", chat: async () => { throw new Error("boom"); } }), []);
});
