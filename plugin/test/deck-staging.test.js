const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function load() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "deck-staging.js"), "utf8");
  const window = {};
  const factory = vm.runInThisContext(
    "(function(window, console){ " + code + "\n return window.WpsAiDeckStaging; })"
  );
  return factory(window, console);
}

test("collectImageRequests: 收集带 data-gen-prompt 的 img 并注入 id，普通 img 不动", () => {
  const S = load();
  const html = '<div><img data-gen-prompt="城市" data-gen-size="16:9"><img src="http://x/y.png" class="logo"></div>';
  const { html: out, requests } = S.collectImageRequests(html);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].prompt, "城市");
  assert.strictEqual(requests[0].size, "16:9");
  assert.strictEqual(requests[0].id, "g0");
  assert.ok(out.includes('data-gen-id="g0"'), "目标 img 注入了 id");
  assert.ok(out.includes('src="http://x/y.png"'), "普通 img 的 src 原样保留");
});

test("collectImageRequests: 多张目标 img 递增 id，resolution 可选", () => {
  const S = load();
  const html = '<img data-gen-prompt="a"><img data-gen-prompt="b" data-gen-resolution="2K">';
  const { requests } = S.collectImageRequests(html);
  assert.deepStrictEqual(requests.map(r => r.id), ["g0", "g1"]);
  assert.strictEqual(requests[0].resolution, undefined);
  assert.strictEqual(requests[1].resolution, "2K");
});

test("collectImageRequests: 属性值内含 > 不破坏 img 匹配", () => {
  const S = load();
  const { requests } = S.collectImageRequests('<img data-gen-prompt="销量 > 100 的品类">');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].prompt, "销量 > 100 的品类");
});

test("applyPlaceholders: 目标 img 的 src 变占位，普通 img 不动", () => {
  const S = load();
  const { html, requests } = S.collectImageRequests('<img data-gen-prompt="a"><img src="keep.png">');
  const out = S.applyPlaceholders(html, requests, { surfaceColor: "#EEE" });
  assert.ok(out.includes("data:image/svg+xml,"), "目标 img 用了占位 dataURL");
  assert.ok(out.includes('src="keep.png"'), "普通 img 不动");
});

test("fillImages: 有 URL 的 id 回填 src，无 URL 的不动", () => {
  const S = load();
  const { html, requests } = S.collectImageRequests('<img data-gen-prompt="a"><img data-gen-prompt="b">');
  const ph = S.applyPlaceholders(html, requests, {});
  const filled = S.fillImages(ph, { g0: "http://real/a.png" });
  assert.ok(filled.includes('src="http://real/a.png"'), "g0 被回填");
  // g1 未提供 URL，仍是占位
  assert.ok(filled.includes("data:image/svg+xml,"), "g1 仍保留占位");
});

test("buildPlaceholderDataUrl: 返回 svg dataURL 且含 caption", () => {
  const S = load();
  const url = S.buildPlaceholderDataUrl({ surfaceColor: "#F4F4F5" }, "AI 配图生成中…");
  assert.ok(url.startsWith("data:image/svg+xml,"));
  assert.ok(decodeURIComponent(url).includes("AI 配图生成中"));
});

test("makeLimiter: 并发不超过上限且全部完成", async () => {
  const S = load();
  const run = S.makeLimiter(2);
  let active = 0, peak = 0;
  const mk = () => run(async () => {
    active += 1; peak = Math.max(peak, active);
    await Promise.resolve(); await Promise.resolve();
    active -= 1; return "ok";
  });
  const res = await Promise.all([mk(), mk(), mk(), mk(), mk()]);
  assert.strictEqual(res.length, 5);
  assert.ok(peak <= 2, `峰值并发 ${peak} 应 ≤ 2`);
});

test("makeLimiter: 单个 reject 不拖垮其余", async () => {
  const S = load();
  const run = S.makeLimiter(2);
  const results = await Promise.allSettled([
    run(async () => { throw new Error("boom"); }),
    run(async () => "ok")
  ]);
  assert.strictEqual(results[0].status, "rejected");
  assert.strictEqual(results[1].status, "fulfilled");
});

test("makeImageTracker: 某页全部就绪才返回该页 urlById", () => {
  const S = load();
  const tr = S.makeImageTracker([{ seq: 1, ids: ["g0", "g1"] }, { seq: 2, ids: ["g0"] }]);
  assert.strictEqual(tr.record(1, "g0", "u0"), null, "第1页还差一张");
  const done1 = tr.record(1, "g1", null);
  assert.deepStrictEqual(done1, { seq: 1, urlById: { g0: "u0", g1: null } });
  const done2 = tr.record(2, "g0", "u2");
  assert.deepStrictEqual(done2, { seq: 2, urlById: { g0: "u2" } });
});

test("makeImageTracker: 未知 seq/id 返回 null", () => {
  const S = load();
  const tr = S.makeImageTracker([{ seq: 1, ids: ["g0"] }]);
  assert.strictEqual(tr.record(9, "g0", "x"), null);
  assert.strictEqual(tr.record(1, "zz", "x"), null);
});

test("runImageBackfill: 每页图齐后回填并 replace，成功/失败分别计数", async () => {
  const S = load();
  const pages = [
    { seq: 1, cacheId: "c1", html: '<img data-gen-id="g0" data-gen-prompt="a"><img data-gen-id="g1" data-gen-prompt="b">',
      css: "", palette: {}, templateName: "studio", layout: "freeform",
      requests: [{ id: "g0", prompt: "a" }, { id: "g1", prompt: "b" }] },
    { seq: 2, cacheId: "c2", html: '<img data-gen-id="g0" data-gen-prompt="c">',
      css: "", palette: {}, templateName: "studio", layout: "freeform",
      requests: [{ id: "g0", prompt: "c" }] }
  ];
  const replaced = [];
  let genCalls = 0;
  const deps = {
    generateImage: async (req) => {
      genCalls += 1;
      if (req.prompt === "b") return null; // 模拟这张失败
      return "http://img/" + req.prompt + ".png";
    },
    renderReplace: async (info) => { replaced.push(info); },
    reportProgress: () => {}
  };
  const res = await S.runImageBackfill({ pages, concurrency: 2, deps });
  assert.strictEqual(genCalls, 3);
  assert.strictEqual(res.imagesOk, 2);
  assert.strictEqual(res.imagesFailed, 1);
  assert.strictEqual(res.pagesReplaced, 2);
  assert.strictEqual(res.skipped, 0);
  // 第1页：g0 用真实 URL，g1 失败→占位；cacheId 透传给 renderReplace（供缓存一致性更新）
  const p1 = replaced.find((r) => r.seq === 1);
  assert.strictEqual(p1.cacheId, "c1");
  assert.ok(p1.html.includes('src="http://img/a.png"'));
  assert.ok(p1.html.includes("data:image/svg+xml,"), "失败的 g1 用了占位");
});

test("runImageBackfill: renderReplace 抛错的页计入 skipped 且不影响其它页", async () => {
  const S = load();
  const pages = [
    { seq: 1, html: '<img data-gen-id="g0" data-gen-prompt="a">', css: "", palette: {}, templateName: "studio", layout: "freeform", requests: [{ id: "g0", prompt: "a" }] },
    { seq: 2, html: '<img data-gen-id="g0" data-gen-prompt="b">', css: "", palette: {}, templateName: "studio", layout: "freeform", requests: [{ id: "g0", prompt: "b" }] }
  ];
  const deps = {
    generateImage: async () => "http://img/x.png",
    renderReplace: async (info) => { if (info.seq === 1) throw new Error("页没了"); }
  };
  const res = await S.runImageBackfill({ pages, concurrency: 2, deps });
  assert.strictEqual(res.pagesReplaced, 1);
  assert.strictEqual(res.skipped, 1);
});
