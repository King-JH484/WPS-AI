const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(file, win) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8");
  vm.runInNewContext(code, { window: win, console, Date, Math, JSON, setTimeout, clearTimeout });
}

function makeStore(seed = {}) {
  const mem = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
  const calls = [];
  return {
    calls,
    getItem(key) {
      return mem.has(key) ? mem.get(key) : null;
    },
    setItem(key, value) {
      calls.push({ op: "setItem", key, value: String(value) });
      mem.set(key, String(value));
    },
    removeItem(key) {
      calls.push({ op: "removeItem", key });
      mem.delete(key);
    },
    async mergeList(key, items) {
      calls.push({ op: "mergeList", key, items });
      const cur = mem.has(key) ? JSON.parse(mem.get(key)) : [];
      return cur.concat(items.filter((it) => !cur.some((old) => old.id === it.id)));
    },
    async mergeObject(key, patch) {
      calls.push({ op: "mergeObject", key, patch });
      const cur = mem.has(key) ? JSON.parse(mem.get(key)) : {};
      return Object.assign({}, cur, patch);
    }
  };
}

test("conversation delete uses exact replacement so sqlite merge cannot revive deleted rows", () => {
  const key = "lingxi_conversations_v1";
  const rows = [
    { id: "keep", title: "keep", createdAt: 1, updatedAt: 1, messages: [] },
    { id: "gone", title: "gone", createdAt: 2, updatedAt: 2, messages: [] }
  ];
  const store = makeStore({
    [key]: JSON.stringify(rows),
    lingxi_current_conversation_v1: "gone"
  });
  const win = { WpsAiStore: store };
  loadModule("conversations.js", win);

  win.WpsAiConversations.deleteById("gone");

  assert.equal(store.calls.some((c) => c.op === "mergeList" && c.key === key), false);
  const write = store.calls.find((c) => c.op === "setItem" && c.key === key);
  assert.ok(write, "delete should rewrite the conversation list exactly");
  assert.deepStrictEqual(JSON.parse(write.value).map((c) => c.id), ["keep"]);
  assert.equal(store.calls.some((c) => c.op === "removeItem" && c.key === "lingxi_current_conversation_v1"), true);
  assert.deepStrictEqual(win.WpsAiConversations.listConversations().map((c) => c.id), ["keep"]);
});

test("history deleteTurn uses exact replacement for turns and entries", () => {
  const entriesKey = "lingxi_history_v1";
  const turnsKey = "lingxi_history_turns_v1";
  const entries = [
    { id: "e1", ts: 1, turnId: "t-keep", toolName: "wps_insert_text" },
    { id: "e2", ts: 2, turnId: "t-gone", toolName: "wps_insert_text" }
  ];
  const turns = {
    "t-keep": { id: "t-keep", prompt: "keep" },
    "t-gone": { id: "t-gone", prompt: "gone" }
  };
  const store = makeStore({
    [entriesKey]: JSON.stringify(entries),
    [turnsKey]: JSON.stringify(turns)
  });
  const win = { WpsAiStore: store };
  loadModule("history.js", win);

  win.WpsAiHistory.deleteTurn("t-gone");

  assert.equal(store.calls.some((c) => c.op === "mergeList" && c.key === entriesKey), false);
  assert.equal(store.calls.some((c) => c.op === "mergeObject" && c.key === turnsKey), false);
  const entriesWrite = store.calls.find((c) => c.op === "setItem" && c.key === entriesKey);
  const turnsWrite = store.calls.find((c) => c.op === "setItem" && c.key === turnsKey);
  assert.ok(entriesWrite, "deleteTurn should rewrite entries exactly");
  assert.ok(turnsWrite, "deleteTurn should rewrite turn index exactly");
  assert.deepStrictEqual(JSON.parse(entriesWrite.value).map((e) => e.id), ["e1"]);
  assert.deepStrictEqual(Object.keys(JSON.parse(turnsWrite.value)), ["t-keep"]);
  assert.deepStrictEqual(win.WpsAiHistory.listEntries().map((e) => e.id), ["e1"]);
});
