const test = require("node:test");
const assert = require("node:assert");

const mailbox = require("../js/conversation-mailbox.js");

test("历史请求只允许匹配文档的主面板消费", () => {
  const now = 1_000_000;
  const raw = JSON.stringify({ id: "conv-a", docKey: "/tmp/a.pdf", ts: now - 1000 });
  assert.equal(mailbox.inspect(raw, "/tmp/b.pdf", now).action, "keep");
  const match = mailbox.inspect(raw, "/tmp/a.pdf", now);
  assert.equal(match.action, "consume");
  assert.equal(match.request.id, "conv-a");
});

test("历史请求超过 TTL 后清理而不注入", () => {
  const now = 1_000_000;
  const raw = JSON.stringify({ id: "conv-a", docKey: "/tmp/a.pdf", ts: now - 31_000 });
  assert.equal(mailbox.inspect(raw, "/tmp/a.pdf", now, 30_000).action, "clear");
});

test("旧版无 docKey 请求仍可消费，无效请求会清理", () => {
  const now = 1_000_000;
  assert.equal(mailbox.inspect(JSON.stringify({ id: "legacy", ts: now }), "/tmp/a.pdf", now).action, "consume");
  assert.equal(mailbox.inspect("not-json", "/tmp/a.pdf", now).action, "clear");
  assert.equal(mailbox.inspect(JSON.stringify({ docKey: "/tmp/a.pdf", ts: now }), "/tmp/a.pdf", now).action, "clear");
});
