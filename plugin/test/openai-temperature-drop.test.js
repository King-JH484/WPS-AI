const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// GPT-5 / o 系列等推理模型只认 temperature=1，传 0.1/0.2 之类会 400
// 「invalid temperature: only 1 is allowed for this model」。排版预览 / 合规 / 校对都传
// 低 temperature，撞上这类模型就整个失败。传输层应认出该错误、去掉 temperature 重试。

function loadOpenAIProvider(fetchImpl, options = {}) {
  let factory;
  const readSse = options.readSse || (async () => {});
  const sandbox = {
    window: {
      WpsAiRuntime: { forwardPrefix: () => "http://127.0.0.1:3890/forward/" },
      WpsAiProviderRegistry: { register: (_type, fn) => { factory = fn; } },
      WpsAiSse: { readSse },
      WpsAiToolRegistry: {
        toOpenAIToolSpec: (def) => ({ type: "function", function: { name: def.name, parameters: {} } })
      }
    },
    fetch: fetchImpl,
    console
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "openai.js"), "utf8");
  vm.runInContext(code, sandbox);
  return factory;
}

function reject400(message) {
  const payload = JSON.stringify({ error: { message } });
  return {
    ok: false, status: 400,
    clone: () => ({ text: async () => payload }),
    text: async () => payload,
    json: async () => JSON.parse(payload)
  };
}

const provider = () => ({
  id: "p", type: "openai", label: "P",
  baseUrl: "https://api.example.com/v1", apiKey: "k", useProxy: false
});

test("streamChat: temperature 被拒 → 去掉 temperature 重试并成功", async () => {
  const bodies = [];
  const factory = loadOpenAIProvider(
    async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if ("temperature" in body) {
        return reject400("invalid temperature: only 1 is allowed for this model");
      }
      return { ok: true, status: 200, idx: 1 };
    },
    { readSse: async (r) => { if (r.idx === 1) throw new Error("reached stream"); } }
  );
  const p = factory(provider());
  await assert.rejects(
    () => p.streamChat({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], temperature: 0.1, onToken() {} }),
    /reached stream/,
    "去掉 temperature 后应进入流式，而不是把 400 抛给用户"
  );
  assert.equal(bodies[0].temperature, 0.1, "首次仍带 temperature");
  assert.equal("temperature" in bodies[bodies.length - 1], false, "重试必须去掉 temperature");
});

test("chat（非流式）: temperature 被拒 → 去掉 temperature 重试并成功", async () => {
  const bodies = [];
  const factory = loadOpenAIProvider(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if ("temperature" in body) {
      return reject400("invalid temperature: only 1 is allowed for this model");
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "排版结果" } }] }) };
  });
  const p = factory(provider());
  const out = await p.chat({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], temperature: 0.1 });
  assert.equal(out, "排版结果");
  assert.equal(bodies[0].temperature, 0.1);
  assert.equal("temperature" in bodies[bodies.length - 1], false, "重试去掉 temperature");
});

test("与 temperature 无关的 400 不误删 temperature（走原有 include_usage 降级）", async () => {
  const bodies = [];
  const factory = loadOpenAIProvider(
    async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.stream_options) return reject400("unknown field: stream_options");
      return { ok: true, status: 200, idx: 1 };
    },
    { readSse: async (r) => { if (r.idx === 1) throw new Error("reached stream"); } }
  );
  const p = factory(provider());
  await assert.rejects(
    () => p.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.2, onToken() {} }),
    /reached stream/
  );
  const last = bodies[bodies.length - 1];
  assert.equal(last.stream_options, undefined, "去掉 include_usage");
  assert.equal(last.temperature, 0.2, "非 temperature 错误不得误删 temperature");
});

test("chat: 非 temperature 的 400 直接抛原始错误（不吞、不多打）", async () => {
  let calls = 0;
  const factory = loadOpenAIProvider(async () => {
    calls += 1;
    return reject400("invalid api key");
  });
  const p = factory(provider());
  await assert.rejects(
    () => p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.1 }),
    /invalid api key/
  );
  assert.equal(calls, 1, "非 temperature 错误不得触发重试");
});
