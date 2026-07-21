const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadCompress() {
  const win = {};
  const code = fs.readFileSync(path.join(ROOT, "js", "chat", "compress.js"), "utf8");
  vm.runInThisContext("(function(window){" + code + "})")(win);
  return win.WpsAiChatCompress;
}

function msgs(n, text = "普通消息内容") {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${text} ${i}` }));
}

test("plan: 未超阈值不压缩", () => {
  const C = loadCompress();
  assert.equal(C.plan(msgs(10), null), null);
  assert.equal(C.plan(msgs(C.TRIGGER_MSGS), null), null); // 刚好等于阈值不触发
});

test("plan: 超条数阈值 → 压缩到只留最近 keepRecent 条（balanced 档）", () => {
  const C = loadCompress();
  const history = msgs(30);
  const p = C.plan(history, null);
  assert.equal(p.start, 0);
  assert.equal(p.end, 30 - C.KEEP_RECENT);
  assert.equal(p.budget.level, "balanced");
});

test("plan: 已有摘要时从 upTo 续压，未超阈值不重复压", () => {
  const C = loadCompress();
  // upTo=18，之后只有 10 条新消息 → 不触发
  assert.equal(C.plan(msgs(28), { summary: "旧摘要", upTo: 18 }), null);
  // upTo=18，之后有 25 条 → 触发，压到 43-keepRecent（43 条 ≥40 → standard 档 keep 10）
  const p = C.plan(msgs(43), { summary: "旧摘要", upTo: 18 });
  assert.equal(p.start, 18);
  assert.equal(p.budget.level, "standard");
  assert.equal(p.end, 43 - p.budget.keepRecent);
});

test("plan: 字符阈值也能触发（少量超长消息）", () => {
  const C = loadCompress();
  const history = msgs(16, "长".repeat(4000)); // 16 条 × 4000 字 = 6.4 万 → standard 档
  const p = C.plan(history, null);
  assert.equal(p.start, 0);
  assert.equal(p.budget.level, "standard");
  assert.equal(p.end, 16 - p.budget.keepRecent);
});

test("P0-2 预算分级：对话越重，触发越早、保留越少、摘要越短", () => {
  const C = loadCompress();
  const balanced = C.budgetFor(msgs(10));
  const standard = C.budgetFor(msgs(45));
  const tight = C.budgetFor(msgs(90));
  assert.equal(balanced.level, "balanced");
  assert.equal(standard.level, "standard");
  assert.equal(tight.level, "tight");
  assert.ok(tight.triggerMsgs < standard.triggerMsgs && standard.triggerMsgs < balanced.triggerMsgs);
  assert.ok(tight.keepRecent < standard.keepRecent && standard.keepRecent < balanced.keepRecent);
  assert.ok(tight.summaryLimit < standard.summaryLimit && standard.summaryLimit < balanced.summaryLimit);
  // 字符量单独也能推档：少量超长消息 → tight
  assert.equal(C.budgetFor(msgs(20, "长".repeat(7000))).level, "tight"); // 14 万字符
});

test("textOf: 多模态数组只取文本部分并标注附件类型", () => {
  const C = loadCompress();
  const t = C.textOf([
    { type: "text", text: "看看这张图" },
    { type: "image_url", image_url: { url: "data:..." } }
  ]);
  assert.match(t, /看看这张图/);
  assert.match(t, /\[image_url\]/);
});

test("buildSummaryMessages / buildContextBlock 中英双语", () => {
  const C = loadCompress();
  const m = C.buildSummaryMessages("旧摘要内容", msgs(4), "zh");
  assert.equal(m[0].role, "system");
  assert.match(m[1].content, /【旧摘要】/);
  assert.match(m[1].content, /用户: /);
  const en = C.buildSummaryMessages("", msgs(2), "en");
  assert.match(en[1].content, /User: /);
  assert.match(C.buildContextBlock("S", "zh"), /此前对话摘要/);
  assert.match(C.buildContextBlock("S", "en"), /Earlier conversation summary/);
});

test("conversations: 压缩状态随对话存取，upTo 越界视为无压缩", () => {
  const win = {
    WpsAiStore: {
      getItem: () => null,
      setItem: () => {},
      mergeList: (key, arr) => Promise.resolve(arr)
    }
  };
  const code = fs.readFileSync(path.join(ROOT, "js", "conversations.js"), "utf8");
  vm.runInThisContext("(function(window){" + code + "})")(win);
  const Conv = win.WpsAiConversations;
  const conv = Conv.createNew({ docKey: "t" });
  Conv.syncMessages(msgs(20));
  assert.equal(Conv.getCompression(), null);
  Conv.setCompression(conv.id, { summary: "摘要正文", upTo: 8 });
  assert.deepEqual(Conv.getCompression(), { summary: "摘要正文", upTo: 8 });
  // upTo 超过 messages 长度 → 视为失效
  Conv.setCompression(conv.id, { summary: "摘要正文", upTo: 99 });
  assert.equal(Conv.getCompression(), null);
});

test("app.js 发送前套用摘要（system 拼接 + slice 历史），轮末触发后台压缩", () => {
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /getCompression\?\.\(\)/);
  assert.match(appJs, /buildContextBlock\(historyComp\.summary/);
  assert.match(appJs, /chatHistory\.slice\(historyComp\.upTo\)/);
  assert.match(appJs, /scheduleHistoryCompression\(\)/);
});
