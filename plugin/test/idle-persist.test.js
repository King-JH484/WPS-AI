const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadIdlePersist() {
  const win = { setTimeout, clearTimeout }; // node 环境无 requestIdleCallback → 走 setTimeout 兜底
  const code = fs.readFileSync(path.join(ROOT, "js", "idle-persist.js"), "utf8");
  vm.runInThisContext("(function(window){" + code + "})")(win);
  return win.WpsAiIdlePersist;
}

test("leading：空闲后的第一笔立即执行", () => {
  const { createIdlePersister } = loadIdlePersist();
  let runs = 0;
  const p = createIdlePersister(() => { runs += 1; }, { wait: 50 });
  p.schedule();
  assert.equal(runs, 1); // 立即执行，无需等待
  assert.equal(p.isPending(), false);
});

test("突发多次调用合并为一次延迟执行", async () => {
  const { createIdlePersister } = loadIdlePersist();
  let runs = 0;
  const p = createIdlePersister(() => { runs += 1; }, { wait: 40 });
  p.schedule(); // leading 立即 1 次
  p.schedule();
  p.schedule();
  p.schedule();
  assert.equal(runs, 1);
  assert.equal(p.isPending(), true);
  await sleep(120); // wait(40) + setTimeout(0) 兜底
  assert.equal(runs, 2); // 后三次合并成 1 次
  assert.equal(p.isPending(), false);
});

test("flushSync：立即执行 pending 的写入并清空定时器", async () => {
  const { createIdlePersister } = loadIdlePersist();
  let runs = 0;
  const p = createIdlePersister(() => { runs += 1; }, { wait: 1000 });
  p.schedule(); // leading 1 次
  p.schedule(); // pending
  assert.equal(runs, 1);
  p.flushSync();
  assert.equal(runs, 2);
  assert.equal(p.isPending(), false);
  await sleep(30);
  assert.equal(runs, 2); // 定时器已清，不会再触发
});

test("run 抛错不影响后续调度", async () => {
  const { createIdlePersister } = loadIdlePersist();
  let calls = 0;
  const p = createIdlePersister(() => { calls += 1; throw new Error("boom"); }, { wait: 30 });
  assert.doesNotThrow(() => p.schedule());
  p.schedule();
  await sleep(90);
  assert.equal(calls, 2);
});

test("conversations：高频 syncMessages 的 mergeList 被错峰合并", async () => {
  const mergeCalls = [];
  const win = {
    setTimeout, clearTimeout,
    WpsAiStore: {
      getItem: () => null,
      setItem: () => {},
      mergeList: (key, arr) => { mergeCalls.push(arr.length); return Promise.resolve(arr); }
    }
  };
  // 先装 idle-persist，再装 conversations（与 main.js 加载顺序一致）
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "idle-persist.js"), "utf8") + "})")(win);
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "conversations.js"), "utf8") + "})")(win);
  const Conv = win.WpsAiConversations;
  Conv.createNew({ docKey: "t" }); // 触发一次 persist（leading 立即）
  const before = mergeCalls.length;
  // 模拟一轮内的密集写入：syncMessages + 事件 + 压缩状态
  for (let i = 0; i < 6; i += 1) {
    Conv.syncMessages([{ role: "user", content: "问题 " + i }, { role: "assistant", content: "回答 " + i }]);
  }
  const immediately = mergeCalls.length - before;
  assert.ok(immediately <= 1, `密集调用不应逐次落盘（实际立即执行 ${immediately} 次）`);
  await sleep(400);
  const settled = mergeCalls.length - before;
  assert.ok(settled >= 1 && settled <= 2, `错峰后应合并为 1~2 次（实际 ${settled} 次）`);
});

test("conversations：beforeunload 强制 flush + sendBeacon 兜底已接线", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "conversations.js"), "utf8");
  assert.match(src, /createIdlePersister\(persistNow/);
  assert.match(src, /beforeunload/);
  assert.match(src, /sendBeacon/);
  assert.match(src, /kv\/merge-list/);
  const mainJs = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const idleIdx = mainJs.indexOf("js/idle-persist.js");
  const convIdx = mainJs.indexOf("js/conversations.js");
  assert.ok(idleIdx > 0 && idleIdx < convIdx, "idle-persist.js 必须在 conversations.js 之前加载");
});
