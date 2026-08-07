const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSanitizer() {
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "chat", "history-sanitize.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiChatHistory;
}

// 一轮对话由不同模型/供应商接力时，出站历史必须是通用 {role, content}，
// 不能带 OpenAI 特有的 tool_calls / role:"tool" / tool_call_id——否则切到 Anthropic
// 或不支持工具的模型会 400 / 语义错乱。

test("剥掉 assistant 上残留的 tool_calls 等附加字段，只留 role+content", () => {
  const { sanitizeForModel } = loadSanitizer();
  const out = sanitizeForModel([
    { role: "user", content: "帮我在表格写入数据" },
    {
      role: "assistant",
      content: "已写入",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "et_write_range", arguments: "{}" } }],
      name: "x"
    }
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "帮我在表格写入数据" },
    { role: "assistant", content: "已写入" }
  ]);
  assert.equal("tool_calls" in out[1], false);
  assert.equal("name" in out[1], false);
});

test("丢弃 role:'tool' / 'function' 等供应商特有角色（切到 Anthropic/无工具模型不崩）", () => {
  const { sanitizeForModel } = loadSanitizer();
  const out = sanitizeForModel([
    { role: "user", content: "问题" },
    { role: "assistant", content: "我调用一下工具" },
    { role: "tool", content: '{"ok":true}', tool_call_id: "call_1" },
    { role: "function", name: "f", content: "x" },
    { role: "assistant", content: "根据结果，答案是…" }
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "assistant"]);
  assert.ok(out.every((m) => !("tool_call_id" in m)));
});

test("多模态数组 content 原样保留（交给各 provider 自己归一化）", () => {
  const { sanitizeForModel } = loadSanitizer();
  const multimodal = [{ type: "text", text: "看这张图" }, { type: "image_url", image_url: { url: "data:..." } }];
  const out = sanitizeForModel([{ role: "user", content: multimodal }]);
  assert.deepEqual(out[0].content, multimodal);
});

test("空 content 的轮保留（不破坏 user/assistant 交替，Anthropic 的硬要求）", () => {
  const { sanitizeForModel } = loadSanitizer();
  const out = sanitizeForModel([
    { role: "user", content: "a" },
    { role: "assistant", content: "" },
    { role: "user", content: "b" }
  ]);
  assert.equal(out.length, 3, "空 assistant 不能被删，否则 user 连续两条 Anthropic 会拒");
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user"]);
});

test("边界：null / 非对象项被安全跳过", () => {
  const { sanitizeForModel } = loadSanitizer();
  assert.deepEqual(sanitizeForModel(null), []);
  assert.deepEqual(sanitizeForModel([null, "x", 42, { role: "user", content: "ok" }]), [{ role: "user", content: "ok" }]);
});
