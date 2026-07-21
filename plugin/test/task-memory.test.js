const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function makeWin() {
  const store = {};
  return {
    win: {
      setTimeout, clearTimeout,
      localStorage: { getItem: (k) => store["ls:" + k] || null, setItem: (k, v) => { store["ls:" + k] = String(v); }, removeItem: (k) => { delete store["ls:" + k]; } },
      WpsAiStore: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }
    },
    store
  };
}

function loadModule(win, rel) {
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, rel), "utf8") + "})")(win);
}

test("TaskStore：登记/进度/日志上限/收尾/列表/停止信号", () => {
  const { win } = makeWin();
  loadModule(win, "js/task-store.js");
  const T = win.WpsAiTaskStore;
  const task = T.add({ type: "proofread", title: "批注校对" });
  assert.equal(task.status, "running");
  T.update(task.id, { progress: 50, log: "分块 1/2" });
  assert.equal(T.get(task.id).progress, 50);
  assert.equal(T.get(task.id).logs.length, 1);
  // 日志上限
  for (let i = 0; i < 60; i += 1) T.update(task.id, { log: "l" + i });
  assert.equal(T.get(task.id).logs.length, T.MAX_LOGS);
  // 停止信号
  assert.equal(T.isStopRequested(task.id), false);
  T.requestStop(task.id);
  assert.equal(T.isStopRequested(task.id), true);
  T.clearStop(task.id);
  assert.equal(T.isStopRequested(task.id), false);
  // 收尾
  T.finish(task.id);
  assert.equal(T.get(task.id).status, "success");
  assert.equal(T.get(task.id).progress, 100);
  const failed = T.add({ type: "x", title: "y" });
  T.finish(failed.id, { error: "boom" });
  assert.equal(T.get(failed.id).status, "error");
  // 列表最新在前 + 类型过滤
  assert.equal(T.list({ limit: 1 })[0].id, failed.id);
  assert.equal(T.list({ type: "proofread" }).length, 1);
});

test("TaskStore：归档上限 MAX_TASKS，旧任务先出", () => {
  const { win } = makeWin();
  loadModule(win, "js/task-store.js");
  const T = win.WpsAiTaskStore;
  const first = T.add({ type: "t", title: "first" });
  for (let i = 0; i < T.MAX_TASKS; i += 1) T.add({ type: "t", title: "t" + i });
  assert.equal(T.list({ limit: 100 }).length, T.MAX_TASKS);
  assert.equal(T.get(first.id), null); // 最旧的被挤出
});

test("ChatMemory：抓取（压缩摘要优先）/短对话跳过/同对话覆盖/按文档隔离", () => {
  const { win } = makeWin();
  loadModule(win, "js/chat/memory.js");
  const M = win.WpsAiChatMemory;
  const mkConv = (id, docKey, n, extra) => Object.assign({
    id, docKey, title: "对话" + id,
    messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "这是一条足够长的消息内容，用来保证抽取出的摘要具备足够的信息量而不会被丢弃，编号 " + i }))
  }, extra);
  // 短对话不记
  assert.equal(M.captureFromConversation(mkConv("c0", "doc:a", 2)), null);
  // 压缩摘要优先
  const rec = M.captureFromConversation(mkConv("c1", "doc:a", 8, { compression: { summary: "用户偏好正式语气；已确定用合同模板排版；待办：补充第三章数据。" } }));
  assert.ok(rec.summary.includes("合同模板"));
  // 无压缩摘要 → 用最后一条 assistant
  const rec2 = M.captureFromConversation(mkConv("c2", "doc:a", 8));
  assert.ok(rec2.summary.includes("编号"));
  // 其它文档
  M.captureFromConversation(mkConv("c3", "doc:b", 8));
  // 按文档隔离 + 排除当前对话 + 新的在前
  const list = M.listForDoc("doc:a", { excludeConvId: "c2", limit: 5 });
  assert.equal(list.length, 1);
  assert.equal(list[0].convId, "c1");
  // 同对话覆盖更新（不产生重复）
  M.captureFromConversation(mkConv("c1", "doc:a", 10, { compression: { summary: "更新后的摘要内容——用户从合同模板改用公文模板排版全文，其余此前确定的结论全部保持不变。" } }));
  const again = M.listForDoc("doc:a", { limit: 5 });
  assert.equal(again.filter((r) => r.convId === "c1").length, 1);
  assert.ok(again.find((r) => r.convId === "c1").summary.includes("公文模板"));
  // 注入块双语
  assert.match(M.buildBlock(list, "zh"), /历史对话备忘/);
  assert.match(M.buildBlock(list, "en"), /earlier conversations/);
  assert.equal(M.buildBlock([], "zh"), "");
});

test("接线：app.js 归档抓记忆 + 发送注入 + boot 重灌；proofread 挂任务", () => {
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /captureFromConversation\?\.\(global\.WpsAiConversations\?\.getCurrent/);
  assert.match(appJs, /listForDoc\(getCurrentDocKey\(\)/);
  assert.match(appJs, /WpsAiTaskStore\?\.reloadFromStore/);
  assert.match(appJs, /WpsAiChatMemory\?\.reloadFromStore/);
  assert.match(appJs, /WpsAiTaskStore\?\.add\?\.\(\{ type: "proofread"/);
  const proofread = fs.readFileSync(path.join(ROOT, "js", "proofread.js"), "utf8");
  assert.match(proofread, /shouldStop/);
});
