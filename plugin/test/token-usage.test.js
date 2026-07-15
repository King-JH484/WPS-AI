const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadStore() {
  const mem = new Map();
  // 模拟 WpsAiStore：record 现在走 mergeObject(add) 让服务端原子累加（修 Critical 1），
  // 这里用同步 mock 复刻 add 合并语义（数值叶子求和、lastAt 取 max、字符串覆盖），写回 mem。
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const add = (a, b) => {
    const out = Object.assign({}, a);
    for (const k of Object.keys(b || {})) {
      const av = out[k], bv = b[k];
      if (typeof av === "number" && typeof bv === "number") out[k] = (k === "lastAt") ? Math.max(av, bv) : av + bv;
      else if (isObj(av) && isObj(bv)) out[k] = add(av, bv);
      else out[k] = bv;
    }
    return out;
  };
  const localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    mergeObject: (key, patch, mode) => {
      let cur = {};
      try { const raw = mem.get(key); const p = raw ? JSON.parse(raw) : {}; if (isObj(p)) cur = p; } catch (e) {}
      const merged = mode === "add" ? add(cur, patch || {}) : Object.assign({}, cur, patch || {});
      mem.set(key, JSON.stringify(merged));
      return merged;
    }
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "token-usage.js"), "utf8");
  const sandbox = { window: {}, localStorage, console };
  sandbox.window.WpsAiStore = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiTokenUsage;
}

test("record accumulates input/output/total/calls for same provider::model", () => {
  const t = loadStore();
  t.record({ provider: "OpenAI", model: "gpt-4o", input: 100, output: 20 });
  t.record({ provider: "OpenAI", model: "gpt-4o", input: 50, output: 10 });
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].input, 150);
  assert.strictEqual(b[0].output, 30);
  assert.strictEqual(b[0].total, 180);
  assert.strictEqual(b[0].calls, 2);
  assert.strictEqual(b[0].model, "gpt-4o");
  assert.strictEqual(b[0].provider, "OpenAI");
});

test("same model under different providers are separate rows, sorted by total desc", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m", input: 10, output: 5 });    // total 15
  t.record({ provider: "B", model: "m", input: 100, output: 50 });  // total 150
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 2);
  assert.strictEqual(b[0].provider, "B");   // larger total first
  assert.strictEqual(b[1].provider, "A");
});

test("getTotals sums all rows", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m1", input: 10, output: 5 });
  t.record({ provider: "B", model: "m2", input: 20, output: 5 });
  const g = t.getTotals();
  assert.strictEqual(g.input, 30);
  assert.strictEqual(g.output, 10);
  assert.strictEqual(g.total, 40);
  assert.strictEqual(g.calls, 2);
});

test("getSession reflects only this-process records", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m", input: 7, output: 3 });
  const s = t.getSession();
  assert.strictEqual(s.input, 7);
  assert.strictEqual(s.output, 3);
  assert.strictEqual(s.total, 10);
  assert.strictEqual(s.calls, 1);
});

test("invalid records are ignored (all-zero / non-numeric)", () => {
  const t = loadStore();
  t.record({});
  t.record({ provider: "A", model: "m", input: 0, output: 0 });
  t.record({ provider: "A", model: "m", input: "x", output: null });
  assert.strictEqual(t.getBreakdown().length, 0);
  assert.strictEqual(t.getSession().calls, 0);
});

test("missing provider/model default to unknown", () => {
  const t = loadStore();
  t.record({ input: 5, output: 5 });
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].model, "unknown");
  assert.strictEqual(b[0].provider, "unknown");
});

test("negative fields are clamped to 0 (mixed-sign record)", () => {
  const t = loadStore();
  t.record({ provider: "X", model: "y", input: 100, output: -5 });
  const b = t.getBreakdown();
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].input, 100);
  assert.strictEqual(b[0].output, 0);
  assert.strictEqual(b[0].total, 100);
});

test("clear empties persistent + session", () => {
  const t = loadStore();
  t.record({ provider: "A", model: "m", input: 10, output: 5 });
  t.clear();
  assert.strictEqual(t.getBreakdown().length, 0);
  assert.strictEqual(t.getTotals().total, 0);
  assert.strictEqual(t.getSession().total, 0);
});

test("onChange returns an unsubscribe fn that stops further notifications", () => {
  const t = loadStore();
  let n = 0;
  const off = t.onChange(() => { n += 1; });
  t.record({ provider: "A", model: "m", input: 1, output: 1 }); // n -> 1
  off();
  t.record({ provider: "A", model: "m", input: 1, output: 1 }); // no fire
  assert.strictEqual(n, 1);
  assert.strictEqual(typeof off, "function");
});

test("onChange fires on record and clear", () => {
  const t = loadStore();
  let n = 0;
  t.onChange(() => { n += 1; });
  t.record({ provider: "A", model: "m", input: 1, output: 1 });
  t.clear();
  assert.strictEqual(n, 2);
});

test("records are also grouped by local day for trend charts", () => {
  const t = loadStore();
  const now = Date.UTC(2026, 6, 8, 12);
  t.record({ provider: "A", model: "m1", input: 10, output: 5, ts: now - 2 * 86400000 });
  t.record({ provider: "B", model: "m2", input: 20, output: 10, ts: now });

  const days = t.getDailyBreakdown({ days: 3, now });
  assert.strictEqual(days.length, 3);
  assert.deepStrictEqual(Array.from(days, (d) => d.date), ["2026-07-06", "2026-07-07", "2026-07-08"]);
  assert.deepStrictEqual(Array.from(days, (d) => d.total), [15, 0, 30]);
  assert.deepStrictEqual(Array.from(days, (d) => d.calls), [1, 0, 1]);
});

test("range totals and model breakdown are calculated from daily buckets", () => {
  const t = loadStore();
  const now = Date.UTC(2026, 6, 8, 12);
  t.record({ provider: "A", model: "old", input: 100, output: 50, ts: now - 10 * 86400000 });
  t.record({ provider: "A", model: "new", input: 20, output: 10, ts: now - 86400000 });
  t.record({ provider: "B", model: "new", input: 6, output: 4, ts: now });

  const totals = t.getTotals({ days: 7, now });
  assert.strictEqual(totals.input, 26);
  assert.strictEqual(totals.output, 14);
  assert.strictEqual(totals.total, 40);
  assert.strictEqual(totals.calls, 2);

  const rows = t.getBreakdown({ days: 7, now });
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(Array.from(rows, (r) => `${r.provider}/${r.model}:${r.total}`), ["A/new:30", "B/new:10"]);
});
