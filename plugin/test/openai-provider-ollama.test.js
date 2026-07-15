const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadOpenAIProvider(fetchImpl = async () => ({ ok: true, json: async () => ({ data: [] }) }), options = {}) {
  let factory;
  const readSse = options.readSse || (async () => {});
  const sandbox = {
    window: {
      WpsAiRuntime: {
        forwardPrefix: () => "http://127.0.0.1:3890/forward/"
      },
      WpsAiProviderRegistry: {
        register: (_type, fn) => { factory = fn; }
      },
      WpsAiSse: {
        readSse
      },
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
  factory._filters = sandbox.window.WpsAiModelFilters;
  return factory;
}

test("Ollama OpenAI-compatible provider allows empty API key and omits Authorization", async () => {
  let seenHeaders;
  const factory = loadOpenAIProvider(async (_url, options) => {
    seenHeaders = options.headers;
    return {
      ok: true,
      json: async () => ({ data: [{ id: "qwen2.5:7b" }] })
    };
  });

  const provider = factory({
    id: "ollama",
    type: "openai",
    label: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    useProxy: false
  });

  await provider.ensureReady();
  const models = await provider.listModels();

  assert.deepEqual(models, ["qwen2.5:7b"]);
  assert.equal(seenHeaders.Authorization, undefined);
  assert.equal(seenHeaders["Content-Type"], "application/json");
});

test("non-Ollama OpenAI-compatible provider still requires API key", async () => {
  const factory = loadOpenAIProvider();
  const provider = factory({
    id: "deepseek",
    type: "openai",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: ""
  });

  await assert.rejects(() => provider.ensureReady(), /API Key/);
});

test("OpenAI-compatible listModels returns only chat-capable models from mixed /models payload", async () => {
  const factory = loadOpenAIProvider(async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: "gpt-4o-mini", modalities: ["text"] },
        { id: "qwen-vl-plus", capabilities: { chat: true, vision: true } },
        { id: "gpt-image-1", type: "image_generation", modalities: ["image"] },
        { id: "sora-2", type: "video_generation", modalities: ["video"] },
        { id: "dall-e-3" },
        { id: "claude-sonnet-4-6", type: "chat" }
      ]
    })
  }));
  const provider = factory({
    id: "mixed",
    type: "openai",
    label: "Mixed",
    baseUrl: "https://mixed.example/v1",
    apiKey: "sk-test",
    useProxy: false
  });

  const models = await provider.listModels();

  assert.deepEqual(models, ["claude-sonnet-4-6", "gpt-4o-mini", "qwen-vl-plus"]);
});

test("shared model filters keep image generation models out of image-provider picker", () => {
  const factory = loadOpenAIProvider();
  const filters = factory._filters;

  const images = filters.filterImageModels([
    { id: "gpt-4o-mini", modalities: ["text"] },
    { id: "gpt-image-1", type: "image_generation" },
    { id: "dall-e-3" },
    { id: "sora-2", type: "video_generation" },
    { id: "flux-pro" }
  ]);

  assert.deepEqual(images, ["dall-e-3", "flux-pro", "gpt-image-1"]);
});

test("runWithTools normalizes empty assistant tool-call content for Ollama", async () => {
  const bodies = [];
  let call = 0;
  const factory = loadOpenAIProvider(
    async (_url, options) => {
      call += 1;
      bodies.push(JSON.parse(options.body));
      if (call === 1) return { ok: true, status: 200, idx: 1 };
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "stop after second body capture" } })
      };
    },
    {
      readSse: async (response, cb) => {
        if (response.idx !== 1) return;
        await cb(null, {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                function: { name: "get_host_info", arguments: "{}" }
              }]
            },
            finish_reason: "tool_calls"
          }]
        });
      }
    }
  );

  const provider = factory({
    id: "ollama",
    type: "openai",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    useProxy: false
  });

  await assert.rejects(
    () => provider.runWithTools({
      model: "qwen",
      messages: [{ role: "user", content: "create a sheet" }],
      tools: [{ name: "get_host_info" }],
      maxIterations: 3
    }),
    /stop after second body capture/
  );

  assert.equal(bodies.length, 3);
  for (const body of bodies.slice(1)) {
    const assistantWithToolCall = body.messages.find((m) => m.role === "assistant" && m.tool_calls);
    assert.ok(assistantWithToolCall);
    assert.equal(assistantWithToolCall.content, "");
    assert.notEqual(assistantWithToolCall.content, null);
  }
});
