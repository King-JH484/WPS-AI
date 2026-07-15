const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadStore(win) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "store.js"), "utf8");
  vm.runInThisContext("(function(window){" + code + "})")(win);
  return win.WpsAiStore;
}
function fakeLocalStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
// 记录所有 fetch 调用；/kv/all 按 opts.allItems 返回；其它返回 ok。
// opts.allFailFirst：/kv/all 先失败 N 次再成功（测冷启动重试）。
// opts.mergeListEcho / mergeObjectEcho：合并端点回显请求，用于测 store 的合并 helper 管道。
function fakeFetch(opts = {}) {
  const calls = [];
  let allFails = opts.allFailFirst || 0;
  let batchFails = opts.batchFailFirst || 0;
  const fn = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (/\/kv\/all$/.test(url)) {
      if (opts.proxyDown) throw new Error("ECONNREFUSED");
      if (allFails > 0) { allFails -= 1; throw new Error("ECONNREFUSED(cold)"); }
      return { ok: true, json: async () => ({ ok: true, items: opts.allItems || {} }) };
    }
    if (/\/kv\/merge-list$/.test(url)) {
      if (opts.mergeFail) throw new Error("merge down");
      return { ok: true, json: async () => ({ ok: true, merged: (body && body.items) || [] }) };
    }
    if (/\/kv\/merge-object$/.test(url)) {
      if (opts.mergeFail) throw new Error("merge down");
      return { ok: true, json: async () => ({ ok: true, merged: (body && body.patch) || {} }) };
    }
    if (/\/kv\/batch$/.test(url)) {
      if (opts.batchFail) throw new Error("batch down");
      if (batchFails > 0) { batchFails -= 1; throw new Error("batch down(transient)"); }
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  fn.calls = calls;
  return fn;
}
// 立即触发的 setTimeout：让 init 退避重试 / scheduleFlush 不真等；记录调用次数供断言
function fastTimers() {
  const st = (fn) => { st.calls += 1; Promise.resolve().then(() => { try { fn(); } catch (e) {} }); return st.calls; };
  st.calls = 0;
  return st;
}
const flushAsync = () => new Promise((r) => setImmediate(r));

test("backend=sqlite：init 从 /kv/all 灌 Map，getItem 同步命中", async () => {
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: fakeFetch({ allItems: { a: "1", __lingxi_kv_migrated_v1: "1" } }), localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  const backend = await S.init();
  assert.equal(backend, "sqlite");
  assert.equal(S.getItem("a"), "1");
  assert.equal(S.getItem("missing"), null);
});

test("backend=sqlite：setItem 攒脏 + flush 组 /kv/batch", async () => {
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" } });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  await S.init();
  S.setItem("k", "v");
  S.removeItem("gone");
  await S.flush();
  const batch = ff.calls.find((c) => /\/kv\/batch$/.test(c.url) && c.body && c.body.sets && c.body.sets.length);
  assert.ok(batch, "应发 /kv/batch");
  assert.deepStrictEqual([...batch.body.sets], [{ key: "k", value: "v" }]);
  assert.deepStrictEqual([...batch.body.dels], ["gone"]);
  // sqlite backend 不写 localStorage
  assert.equal(win.localStorage.getItem("k"), null);
});

test("首次迁移：把 localStorage 受管 key 批量写 SQLite 并清大键", async () => {
  const ff = fakeFetch({ allItems: {} }); // SQLite 空、无迁移标记
  const ls = fakeLocalStorage({ lingxi_conversations_v1: "big", lingxi_pure_mode: "1" });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: ls, addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  await S.init();
  const mig = ff.calls.find((c) => c.body && c.body.sets && c.body.sets.some((s) => s.key === "__lingxi_kv_migrated_v1"));
  assert.ok(mig, "应发迁移 batch 含标记");
  assert.ok(mig.body.sets.some((s) => s.key === "lingxi_conversations_v1" && s.value === "big"));
  // 迁移成功后大键从 localStorage 删除
  assert.equal(ls.getItem("lingxi_conversations_v1"), null);
});

test("首次迁移：把 provider 设置写入 SQLite，供 Word/Excel 共享", async () => {
  const ff = fakeFetch({ allItems: {} });
  const ls = fakeLocalStorage({ wps_ai_provider_settings_v1: JSON.stringify({ activeChatModel: "p::m" }) });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: ls, addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  await S.init();

  const mig = ff.calls.find((c) => c.body && c.body.sets && c.body.sets.some((s) => s.key === "__lingxi_kv_migrated_v1"));
  assert.ok(mig, "应发迁移 batch 含标记");
  assert.ok(
    mig.body.sets.some((s) => s.key === "wps_ai_provider_settings_v1" && /p::m/.test(s.value)),
    "provider 设置应纳入迁移 batch"
  );
  assert.match(S.getItem("wps_ai_provider_settings_v1"), /p::m/);
});

test("已迁移用户升级后：从旧 localStorage 补搬 provider 设置", async () => {
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" } });
  const ls = fakeLocalStorage({ wps_ai_provider_settings_v1: JSON.stringify({ activeChatModel: "word::m" }) });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: ls, addEventListener() {}, navigator: {} };
  const S = loadStore(win);
  await S.init();

  const batch = ff.calls.find((c) => c.body && c.body.sets && c.body.sets.some((s) => s.key === "wps_ai_provider_settings_v1"));
  assert.ok(batch, "已迁移但 SQLite 缺 provider 设置时，应补写 /kv/batch");
  assert.match(S.getItem("wps_ai_provider_settings_v1"), /word::m/);
});

test("backend=localStorage：proxy 挂 + 无迁移标记 → localStorage 灌 + 写 localStorage", async () => {
  const ls = fakeLocalStorage({ lingxi_pure_mode: "1" }); // 无 __lingxi_kv_migrated_v1
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: fakeFetch({ proxyDown: true }), localStorage: ls, addEventListener() {}, navigator: {}, setTimeout: fastTimers() };
  const S = loadStore(win);
  const backend = await S.init();
  assert.equal(backend, "localStorage");
  assert.equal(S.getItem("lingxi_pure_mode"), "1");
  S.setItem("lingxi_pure_mode", "0");
  assert.equal(ls.getItem("lingxi_pure_mode"), "0");
});

test("C2a：init 冷启动 /kv/all 先失败再成功 → 退避重试后 sqlite", async () => {
  const st = fastTimers();
  const ff = fakeFetch({ allFailFirst: 2, allItems: { a: "1", __lingxi_kv_migrated_v1: "1" } });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {}, setTimeout: st };
  const S = loadStore(win);
  const backend = await S.init();
  assert.equal(backend, "sqlite");
  assert.equal(S.getItem("a"), "1");
  const allCalls = ff.calls.filter((c) => /\/kv\/all$/.test(c.url)).length;
  assert.equal(allCalls, 3, "应重试 3 次 /kv/all（0/1500/3000）");
  assert.ok(st.calls >= 2, "两次退避应经过 setTimeout");
});

test("C2：已迁移标记在 localStorage + proxy 挂 → backend=unavailable，写入不落 localStorage", async () => {
  const ls = fakeLocalStorage({ __lingxi_kv_migrated_v1: "123", wps_ai_access_token: "OLD" });
  const st = fastTimers();
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: fakeFetch({ proxyDown: true }), localStorage: ls, addEventListener() {}, navigator: {}, setTimeout: st };
  const S = loadStore(win);
  const backend = await S.init();
  assert.equal(backend, "unavailable");
  // 读仍从 Map（localStorage 灌入的旧值）
  assert.equal(S.getItem("wps_ai_access_token"), "OLD");
  // 写：绝不落 localStorage（避免滞留永远到不了 SQLite 的写入）
  S.setItem("wps_ai_access_token", "NEW");
  assert.equal(S.getItem("wps_ai_access_token"), "NEW"); // Map 更新
  assert.equal(ls.getItem("wps_ai_access_token"), "OLD"); // localStorage 不动
  S.removeItem("wps_ai_access_token");
  assert.equal(ls.getItem("wps_ai_access_token"), "OLD");
});

test("C2：unavailable → 代理回来 flush 成功后升回 sqlite", async () => {
  const ls = fakeLocalStorage({ __lingxi_kv_migrated_v1: "123" });
  const ff = fakeFetch({ proxyDown: true });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: ls, addEventListener() {}, navigator: {}, setTimeout: fastTimers() };
  const S = loadStore(win);
  await S.init();
  S.setItem("lingxi_pure_mode", "1"); // 挂脏
  await S.flush(); // 代理已恢复（proxyDown 只挡 /kv/all；/kv/batch 正常返回 ok）
  const batch = ff.calls.find((c) => /\/kv\/batch$/.test(c.url));
  assert.ok(batch, "unavailable 下 flush 应尝试 /kv/batch");
  // 恢复后再写应写 localStorage 直写（sqlite 小键 write-through）
  S.setItem("lingxi_pure_mode", "0");
  assert.equal(ls.getItem("lingxi_pure_mode"), "0");
});

test("I3：sqlite 模式小受管键 setItem/removeItem write-through 到 localStorage", async () => {
  const ls = fakeLocalStorage();
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" } });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: ls, addEventListener() {}, navigator: {}, setTimeout: fastTimers() };
  const S = loadStore(win);
  await S.init();
  S.setItem("wps_ai_access_token", "TOK"); // 小受管键 → 写透
  assert.equal(ls.getItem("wps_ai_access_token"), "TOK");
  S.removeItem("wps_ai_access_token");
  assert.equal(ls.getItem("wps_ai_access_token"), null);
  // 大键（LARGE_KEYS_TO_CLEAR）不写透，保持 sqlite 独占
  S.setItem("lingxi_conversations_v1", "X");
  assert.equal(ls.getItem("lingxi_conversations_v1"), null);
});

test("I4：flush 失败后即使无后续 setItem 也重排重试", async () => {
  const st = fastTimers();
  // batch 先失败一次再成功：失败触发 catch 里的 scheduleFlush（重排），下一次成功收敛
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" }, batchFailFirst: 1 });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {}, setTimeout: st };
  const S = loadStore(win);
  await S.init();
  S.setItem("k", "v");        // scheduleFlush(1) → 定时器触发 flush → batch 失败 → catch scheduleFlush(2) → flush 成功
  const armedAfterSet = st.calls; // 至少 1
  await flushAsync(); await flushAsync(); await flushAsync();
  const batchCalls = ff.calls.filter((c) => /\/kv\/batch$/.test(c.url)).length;
  assert.equal(batchCalls, 2, "失败一次 + 重试成功一次 = 2 次 /kv/batch");
  assert.ok(st.calls > armedAfterSet, "flush 失败后 catch 里应再排一次重试定时器");
});

test("Critical1：sqlite 模式 mergeList POST /kv/merge-list 并刷新 Map", async () => {
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" } });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {}, setTimeout: fastTimers() };
  const S = loadStore(win);
  await S.init();
  const items = [{ id: "c1", updatedAt: 5 }];
  const merged = await S.mergeList("lingxi_conversations_v1", items, "id", "updatedAt");
  const post = ff.calls.find((c) => /\/kv\/merge-list$/.test(c.url));
  assert.ok(post, "应 POST /kv/merge-list");
  assert.equal(post.body.idKey, "id");
  assert.deepStrictEqual(merged, items);
  assert.equal(S.getItem("lingxi_conversations_v1"), JSON.stringify(items)); // Map 刷新
});

test("Critical1 fallback：merge 端点挂 / localStorage 后端 → 客户端合并 + setItem", async () => {
  const ls = fakeLocalStorage({ lingxi_history_v1: JSON.stringify([{ id: "a", ts: 1, v: "old" }, { id: "b", ts: 9 }]) });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: fakeFetch({ proxyDown: true }), localStorage: ls, addEventListener() {}, navigator: {}, setTimeout: fastTimers() };
  const S = loadStore(win);
  await S.init(); // 无迁移标记 → localStorage 后端
  const merged = await S.mergeList("lingxi_history_v1", [{ id: "a", ts: 3, v: "new" }, { id: "c", ts: 2 }], "id", "ts");
  const byId = Object.fromEntries(merged.map((x) => [x.id, x]));
  assert.equal(byId.a.v, "new"); // ts3 > ts1
  assert.equal(byId.b.ts, 9);    // 保留
  assert.ok(byId.c);             // 新增
  assert.deepStrictEqual(JSON.parse(ls.getItem("lingxi_history_v1")), merged); // 写回 localStorage
});

test("Critical1：mergeObject add 回显合并并刷新 Map（sqlite）", async () => {
  const ff = fakeFetch({ allItems: { __lingxi_kv_migrated_v1: "1" } });
  const win = { WpsAiRuntime: { proxyBase: () => "http://x" }, fetch: ff, localStorage: fakeLocalStorage(), addEventListener() {}, navigator: {}, setTimeout: fastTimers() };
  const S = loadStore(win);
  await S.init();
  const patch = { "p::m": { input: 3, calls: 1 } };
  const merged = await S.mergeObject("lingxi_token_usage_v1", patch, "add");
  const post = ff.calls.find((c) => /\/kv\/merge-object$/.test(c.url));
  assert.ok(post);
  assert.equal(post.body.mode, "add");
  assert.deepStrictEqual(merged, patch); // 回显
  assert.equal(S.getItem("lingxi_token_usage_v1"), JSON.stringify(patch));
});
