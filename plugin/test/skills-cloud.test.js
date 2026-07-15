const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function load(fetchImpl) {
  const mem = new Map();
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
  const window = {};
  window.WpsAiStore = localStorage;
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "skills.js"), "utf8");
  const factory = vm.runInThisContext(
    "(function(window, localStorage, console, fetch){ " + code + "\n return window.WpsAiSkills; })"
  );
  return factory(window, localStorage, console, fetchImpl || (async () => { throw new Error("no fetch"); }));
}

test("parseCloudIndex: {skills:[]} 形态，id 加 cloud- 前缀、带 hostFilter", () => {
  const S = load();
  const out = S.parseCloudIndex({ skills: [
    { id: "market", name: "市场调研", description: "d", url: "https://x/market.md", hostFilter: ["wps"] }
  ] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "cloud-market");
  assert.strictEqual(out[0].source, "cloud");
  assert.strictEqual(out[0].url, "https://x/market.md");
  assert.deepStrictEqual(out[0].hostFilter, ["wps"]);
});

test("parseCloudIndex: 数组形态 + 去重 + 丢弃无内容来源", () => {
  const S = load();
  const out = S.parseCloudIndex([
    { id: "a", name: "A", content: "内容A" },
    { id: "a", name: "A重复", content: "x" },     // 重复 id 丢弃
    { id: "b", name: "B" }                          // 无 content/url/contentPath 丢弃
  ]);
  assert.deepStrictEqual(out.map((s) => s.id), ["cloud-a"]);
  assert.strictEqual(out[0].content, "内容A");
});

test("parseCloudIndex: 垃圾输入 → []", () => {
  const S = load();
  assert.deepStrictEqual(S.parseCloudIndex(null), []);
  assert.deepStrictEqual(S.parseCloudIndex({}), []);
  assert.deepStrictEqual(S.parseCloudIndex("nope"), []);
});

test("loadCloud: 成功拉取并写缓存，list() 含云端技能", async () => {
  const S = load(async () => ({ ok: true, json: async () => ({ skills: [{ id: "s1", name: "云技能1", content: "c1" }] }) }));
  const skills = await S.loadCloud({ url: "https://x/index.json" });
  assert.strictEqual(skills.length, 1);
  assert.strictEqual(skills[0].id, "cloud-s1");
  assert.strictEqual(S.readCloudSkills().length, 1);
  assert.ok(S.list().some((s) => s.id === "cloud-s1"), "list() 含云端技能");
});

test("loadCloud: 网络失败 → 回退缓存", async () => {
  let call = 0;
  const S = load(async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({ skills: [{ id: "s1", name: "n", content: "c" }] }) };
    throw new Error("offline");
  });
  await S.loadCloud({ url: "u" });        // 第一次成功，缓存 1 条
  const again = await S.loadCloud({ url: "u" }); // 第二次失败，回退缓存
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].id, "cloud-s1");
});

test("云端技能默认不启用（不在 DEFAULT_ENABLED）", async () => {
  const S = load(async () => ({ ok: true, json: async () => ({ skills: [{ id: "s1", name: "n", content: "c" }] }) }));
  await S.loadCloud({ url: "u" });
  assert.strictEqual(S.isEnabled("cloud-s1"), false);
});
