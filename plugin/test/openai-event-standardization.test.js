const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("WpsAiOpenAI.runWithTools emits standardized chat events", async () => {
  const context = {
    window: {},
    console,
    DOMException
  };
  context.window.window = context.window;
  context.window.WpsAiProviderRegistry = {
    getActiveConfig() { return { id: "stub", type: "openai" }; },
    buildProvider() {
      return {
        type: "openai",
        label: "Stub",
        defaultModel: "stub-model",
        async ensureReady() {},
        async runWithTools({ onEvent }) {
          await onEvent({ type: "assistant_chunk", delta: "hi", fullText: "hi" });
          await onEvent({ type: "tool_call", id: "call-1", name: "read", args: { a: 1 } });
          await onEvent({ type: "done", text: "hi" });
          return { content: "hi" };
        }
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "chat", "events.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "openai.js"), "utf8"), context);

  const seen = [];
  await context.window.WpsAiOpenAI.runWithTools({
    messages: [],
    tools: [],
    onEvent(ev) { seen.push(ev); }
  });

  assert.deepEqual(seen.map((ev) => ev.type), ["message.delta", "tool.start", "done"]);
  assert.equal(seen[0].schema, "lingxi.chat.event.v1");
  assert.equal(seen[0].model, "stub-model");
  assert.equal(seen[1].tool.name, "read");
});
