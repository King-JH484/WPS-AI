const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadChatBlocks() {
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "chat", "blocks.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiChatBlocks;
}

test("builds text and reasoning blocks from standard events", () => {
  const blocks = loadChatBlocks();
  const out = blocks.fromEvents([
    { type: "message.delta", role: "assistant", delta: "hel", text: "hel", model: "m" },
    { type: "message.delta", role: "assistant", delta: "lo", text: "hello", model: "m" },
    { type: "message.end", role: "assistant", text: "hello", model: "m", elapsedMs: 1200 },
    { type: "reasoning.delta", delta: "think", text: "think" },
    { type: "reasoning.end", text: "think" }
  ]);

  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "text");
  assert.equal(out[0].text, "hello");
  assert.equal(out[0].model, "m");
  assert.equal(out[0].elapsedMs, 1200);
  assert.equal(out[1].kind, "reasoning");
  assert.equal(out[1].text, "think");
});

test("user message.end 透传 quickAction 到 text block（回放折叠操作盒子）", () => {
  const blocks = loadChatBlocks();
  const out = blocks.fromEvents([
    { type: "message.end", role: "user", text: "模板提示词全文", quickAction: { label: "全文总结" } },
    { type: "message.end", role: "user", text: "普通消息" }
  ]);
  assert.deepEqual(out[0].quickAction, { label: "全文总结" });
  assert.equal(out[1].quickAction, null);
});

test("builds tool and status blocks from standard events", () => {
  const blocks = loadChatBlocks();
  const out = blocks.fromEvents([
    { type: "message.end", role: "user", text: "run", attachments: [{ kind: "text" }] },
    { type: "tool.start", tool: { id: "1", name: "read", args: { a: 1 } } },
    { type: "tool.end", tool: { id: "1", name: "read", result: { ok: true } } },
    { type: "status", status: "retrying", text: "retry" },
    { type: "error", error: { message: "boom" } }
  ]);

  assert.deepEqual(out.map((b) => b.kind), ["text", "tool-call", "tool-result", "status", "error"]);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].name, "read");
  assert.equal(out[2].result.ok, true);
  assert.equal(out[3].text, "retry");
  assert.equal(out[4].error.message, "boom");
});
