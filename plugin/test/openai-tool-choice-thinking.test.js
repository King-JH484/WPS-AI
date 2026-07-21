const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadOpenAIProvider(fetchImpl, options = {}) {
  let factory;
  const readSse = options.readSse || (async () => {});
  const sandbox = {
    window: {
      WpsAiRuntime: { forwardPrefix: () => "http://127.0.0.1:3890/forward/" },
      WpsAiProviderRegistry: { register: (_type, fn) => { factory = fn; } },
      WpsAiSse: { readSse },
      WpsAiToolRegistry: {
        toOpenAIToolSpec: (def) => ({ type: "function", function: { name: def.name, parameters: {} } }),
        execute: async () => ({ ok: true, value: { done: true } }),
        serializeResult: (result) => JSON.stringify(result)
      },
      fetch: fetchImpl
    },
    fetch: fetchImpl,
    console
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "openai.js"), "utf8");
  vm.runInContext(code, sandbox);
  return factory;
}

const PLAN_RESPONSE = {
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          taskType: "spreadsheet_qa",
          requiresTools: true,
          requiresSpreadsheetRead: true,
          requiredTools: ["et_get_sheet_info", "et_read_range"],
          reason: "need values"
        })
      }
    }]
  })
};

function reject400(message) {
  const payload = JSON.stringify({ error: { message } });
  return {
    ok: false,
    status: 400,
    clone: () => ({ text: async () => payload }),
    text: async () => payload,
    json: async () => JSON.parse(payload)
  };
}

// DeepSeek 等自带思考模式的模型只接受 tool_choice: auto，我们的表格读取守卫会强制
// "required" / 指定函数 → 400「Thinking mode does not support this tool_choice」。
// 这类模型的思考是服务端开的，buildThinkingParams 对它们返回 null，我们无从预判，
// 只能从 400 的错误信息里认出来再去掉 tool_choice 重试。
test("tool_choice 被思考模式拒绝 → 自动去掉 tool_choice 重试并成功", async () => {
  const bodies = [];
  let call = 0;
  const factory = loadOpenAIProvider(
    async (_url, options) => {
      call += 1;
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (call === 1) return PLAN_RESPONSE;
      if (body.tool_choice !== undefined) {
        return reject400("Thinking mode does not support this tool_choice");
      }
      return { ok: true, status: 200, idx: 1 };
    },
    { readSse: async (response) => { if (response.idx === 1) throw new Error("reached stream"); } }
  );

  const provider = factory({
    id: "ds", type: "openai", label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1", apiKey: "k", useProxy: false
  });

  await assert.rejects(
    () => provider.runWithTools({
      model: "deepseek-v4",
      messages: [{ role: "user", content: "当前表格有几个小区" }],
      tools: [{ name: "et_get_sheet_info" }, { name: "et_read_range" }],
      maxIterations: 2
    }),
    /reached stream/,
    "去掉 tool_choice 后应当成功进入流式读取，而不是把 400 抛给用户"
  );

  const streamed = bodies.filter((b) => b.stream === true);
  assert.ok(streamed.length >= 2, "应当发生了一次降级重试");
  assert.equal(streamed[0].tool_choice, "required", "首次仍带强制 tool_choice");
  assert.equal("tool_choice" in streamed[streamed.length - 1], false, "重试必须去掉 tool_choice");
  // 降级只去掉 tool_choice，tools 本身要保留——否则模型没法调用工具
  assert.ok(Array.isArray(streamed[streamed.length - 1].tools), "重试仍须带 tools");
});

test("非 tool_choice 的 400 仍走原来的 include_usage 降级", async () => {
  const bodies = [];
  let call = 0;
  const factory = loadOpenAIProvider(
    async (_url, options) => {
      call += 1;
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (call === 1) return PLAN_RESPONSE;
      if (body.stream_options) return reject400("unknown field: stream_options");
      return { ok: true, status: 200, idx: 1 };
    },
    { readSse: async (response) => { if (response.idx === 1) throw new Error("reached stream"); } }
  );

  const provider = factory({
    id: "gw", type: "openai", label: "GW",
    baseUrl: "https://gw.example.com/v1", apiKey: "k", useProxy: false
  });

  await assert.rejects(
    () => provider.runWithTools({
      model: "some-model",
      messages: [{ role: "user", content: "当前表格有几个小区" }],
      tools: [{ name: "et_get_sheet_info" }, { name: "et_read_range" }],
      maxIterations: 2
    }),
    /reached stream/
  );

  const streamed = bodies.filter((b) => b.stream === true);
  const last = streamed[streamed.length - 1];
  assert.equal(last.stream_options, undefined, "应去掉 include_usage");
  // 错误与 tool_choice 无关时，不该牺牲表格读取守卫
  assert.equal(last.tool_choice, "required", "非 tool_choice 错误不得误伤守卫");
});

test("重试仍失败 → 把原始错误信息抛给用户（不吞成通用 400）", async () => {
  let call = 0;
  const factory = loadOpenAIProvider(async (_url, options) => {
    call += 1;
    if (call === 1) return PLAN_RESPONSE;
    JSON.parse(options.body);
    return reject400("Thinking mode does not support this tool_choice");
  });

  const provider = factory({
    id: "ds", type: "openai", label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1", apiKey: "k", useProxy: false
  });

  await assert.rejects(
    () => provider.runWithTools({
      model: "deepseek-v4",
      messages: [{ role: "user", content: "当前表格有几个小区" }],
      tools: [{ name: "et_get_sheet_info" }, { name: "et_read_range" }],
      maxIterations: 2
    }),
    /Thinking mode does not support this tool_choice/,
    "全部重试失败时要保留原始错误信息，便于排查"
  );
});
