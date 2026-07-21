const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadChatEvents() {
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "chat", "events.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiChatEvents;
}

test("normalizes legacy assistant and reasoning events", () => {
  const events = loadChatEvents();
  const msg = events.normalizeEvent(
    { type: "assistant_chunk", delta: "hi", fullText: "hello" },
    { provider: "openai", model: "gpt-x" }
  )[0];
  assert.equal(msg.type, "message.delta");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.delta, "hi");
  assert.equal(msg.text, "hello");
  assert.equal(msg.provider, "openai");
  assert.equal(msg.model, "gpt-x");

  const reasoning = events.normalizeEvent({ type: "reasoning_end", text: "thinking" })[0];
  assert.equal(reasoning.type, "reasoning.end");
  assert.equal(reasoning.text, "thinking");
});

test("normalizes tool calls and trims large tool results", () => {
  const events = loadChatEvents();
  const start = events.normalizeEvent({ type: "tool_call", id: "call-1", name: "read", args: { a: 1 } })[0];
  assert.equal(start.type, "tool.start");
  assert.deepEqual(start.tool, { id: "call-1", name: "read", args: { a: 1 } });

  const end = events.normalizeEvent({
    type: "tool_result",
    id: "call-1",
    name: "read",
    result: { ok: true, value: { text: "x".repeat(5000) } }
  })[0];
  const sanitized = events.sanitizeStandardEvent(end);
  assert.equal(sanitized.type, "tool.end");
  assert.equal(sanitized.tool.result.ok, true);
  assert.ok(JSON.stringify(sanitized.tool.result).length < 3500);
});

test("creates user message standard event", () => {
  const events = loadChatEvents();
  const ev = events.userMessageEvent("hello", [{ kind: "text", name: "a.txt" }]);
  assert.equal(ev.type, "message.end");
  assert.equal(ev.role, "user");
  assert.equal(ev.text, "hello");
  assert.equal(ev.attachments.length, 1);
});

test("ribbon 快捷指令 quickAction 全程透传（v2 事件 + legacy 转换）", () => {
  const events = loadChatEvents();
  // 普通消息不带 quickAction
  assert.equal(events.userMessageEvent("hi", []).quickAction, undefined);
  // 快捷指令带 label
  const ev = events.userMessageEvent("完整的模板提示词……", [], { label: "全文总结" });
  assert.deepEqual(ev.quickAction, { label: "全文总结" });
  // legacy 转换透传，供 v1 回放路径用
  const legacy = events.toLegacyEvent(ev);
  assert.equal(legacy.type, "user");
  assert.deepEqual(legacy.quickAction, { label: "全文总结" });
});

test("converts standard events back to legacy UI events", () => {
  const events = loadChatEvents();
  const legacy = events.toLegacyEvent({
    type: "tool.start",
    id: "evt",
    tool: { id: "call-1", name: "read", args: { a: 1 } }
  });
  assert.equal(legacy.type, "tool_call");
  assert.equal(legacy.id, "call-1");
  assert.equal(legacy.name, "read");

  const msg = events.toLegacyEvent({ type: "message.delta", delta: "a", text: "abc" });
  assert.equal(msg.type, "assistant_chunk");
  assert.equal(msg.fullText, "abc");
});
