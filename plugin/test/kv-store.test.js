const test = require("node:test");
const assert = require("node:assert");
process.env.ANTHONY_KV_DB = ":memory:";
const kv = require("../tools/kv-store.js");
const RUN = kv.available(); // 无 --experimental-sqlite 时整组跳过

test("set/get 往返", { skip: !RUN && "需 --experimental-sqlite" }, () => {
  kv.batch({ sets: [{ key: "a", value: "1" }, { key: "b", value: "两" }] });
  const all = kv.getAll();
  assert.equal(all.a, "1");
  assert.equal(all.b, "两");
});

test("batch 覆盖 + 删除在一个事务", { skip: !RUN }, () => {
  kv.batch({ sets: [{ key: "a", value: "x" }], dels: ["b"] });
  const all = kv.getAll();
  assert.equal(all.a, "x");
  assert.ok(!("b" in all));
});

test("stats 返回每 key 字节数与总和", { skip: !RUN }, () => {
  kv.clear({});
  kv.batch({ sets: [{ key: "k", value: "abcd" }] });
  const s = kv.stats();
  assert.equal(s.total, 4);
  assert.deepStrictEqual([...s.entries], [{ key: "k", bytes: 4 }]);
});

test("clear({keys}) 只删指定；clear() 清全部", { skip: !RUN }, () => {
  kv.batch({ sets: [{ key: "p", value: "1" }, { key: "q", value: "2" }] });
  kv.clear({ keys: ["p"] });
  assert.ok(!("p" in kv.getAll()));
  assert.ok("q" in kv.getAll());
  kv.clear({});
  assert.equal(Object.keys(kv.getAll()).length, 0);
});

test("mergeList：按 id 去重、保留 ts 更大者、incoming 平局胜", { skip: !RUN }, () => {
  kv.clear({});
  // 磁盘既有 a(ts1)、b(ts5)
  kv.batch({ sets: [{ key: "L", value: JSON.stringify([{ id: "a", ts: 1, v: "old" }, { id: "b", ts: 5, v: "keepB" }]) }] });
  const merged = kv.mergeList({
    key: "L", idKey: "id", tsKey: "ts",
    items: [
      { id: "a", ts: 3, v: "newA" },   // 比磁盘的 a(ts1) 新 → 覆盖
      { id: "b", ts: 2, v: "staleB" }, // 比磁盘的 b(ts5) 旧 → 保留磁盘
      { id: "c", ts: 9, v: "newC" }    // 新增
    ]
  });
  const byId = Object.fromEntries(merged.map((x) => [x.id, x]));
  assert.equal(byId.a.v, "newA");
  assert.equal(byId.b.v, "keepB");
  assert.equal(byId.c.v, "newC");
  // 升序按 ts 排：a(3), c(9)? b(5) → a,b,c
  assert.deepStrictEqual(merged.map((x) => x.id), ["a", "b", "c"]);
  // 写回磁盘持久化
  const stored = JSON.parse(kv.getAll().L);
  assert.equal(stored.length, 3);
});

test("mergeList：平局（ts 相等）incoming 胜", { skip: !RUN }, () => {
  kv.clear({});
  kv.batch({ sets: [{ key: "L2", value: JSON.stringify([{ id: "x", ts: 5, v: "disk" }]) }] });
  const merged = kv.mergeList({ key: "L2", idKey: "id", tsKey: "ts", items: [{ id: "x", ts: 5, v: "incoming" }] });
  assert.equal(merged[0].v, "incoming");
});

test("mergeObject assign：patch 逐 key 覆盖，其余保留（turns 索引）", { skip: !RUN }, () => {
  kv.clear({});
  kv.batch({ sets: [{ key: "O", value: JSON.stringify({ t1: { a: 1 }, t2: { a: 2 } }) }] });
  const merged = kv.mergeObject({ key: "O", mode: "assign", patch: { t2: { a: 22 }, t3: { a: 3 } } });
  assert.deepStrictEqual(merged, { t1: { a: 1 }, t2: { a: 22 }, t3: { a: 3 } });
  assert.deepStrictEqual(JSON.parse(kv.getAll().O), merged);
});

test("mergeObject add：数值叶子求和、lastAt 取 max、字符串覆盖", { skip: !RUN }, () => {
  kv.clear({});
  kv.batch({ sets: [{ key: "U", value: JSON.stringify({ "p::m": { model: "m", provider: "p", input: 10, output: 5, total: 15, calls: 2, lastAt: 100 } }) }] });
  const merged = kv.mergeObject({ key: "U", mode: "add", patch: { "p::m": { model: "m", provider: "p", input: 3, output: 7, total: 10, calls: 1, lastAt: 50 } } });
  const e = merged["p::m"];
  assert.equal(e.input, 13);
  assert.equal(e.output, 12);
  assert.equal(e.total, 25);
  assert.equal(e.calls, 3);
  assert.equal(e.lastAt, 100); // max(100,50)
  assert.equal(e.provider, "p");
});

test("mergeObject add：新 key 首次写入整块", { skip: !RUN }, () => {
  kv.clear({});
  const merged = kv.mergeObject({ key: "U2", mode: "add", patch: { "q::n": { input: 4, calls: 1, lastAt: 7 } } });
  assert.deepStrictEqual(merged["q::n"], { input: 4, calls: 1, lastAt: 7 });
});
