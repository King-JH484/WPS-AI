const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// 加载 openai.js（IIFE）到 vm 沙箱，用 mock fetch/SSE 驱动 streamChat，
// 验证 stream_options.include_usage 的「带着发 → 400 去掉重试」自愈逻辑。
function loadProvider(fetchImpl) {
  let factory = null;
  const recorded = [];
  const window = {
    WpsAiProviderRegistry: { register: (_t, f) => { factory = f; } },
    WpsAiSse: {
      // 模拟服务端返回一段内容 + 一个 usage 块（符合 include_usage 规范：usage 块 choices 为空）
      readSse: async (_response, cb) => {
        await cb(null, { choices: [{ delta: { content: "你好" } }] });
        await cb(null, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      }
    },
    WpsAiTokenUsage: { record: (x) => recorded.push(x) }
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "openai.js"), "utf8");
  const sandbox = { window, console, fetch: fetchImpl };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const provider = factory({ apiKey: "k", baseUrl: "http://gw.test", useProxy: false, label: "网关A" });
  return { provider, recorded };
}

test("streamChat: 正常网关一次发送即带 stream_options.include_usage", async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };
  const { provider, recorded } = loadProvider(fetchImpl);
  const text = await provider.streamChat({ model: "m", messages: [], onToken: () => {} });

  assert.strictEqual(bodies.length, 1, "只发一次");
  assert.deepStrictEqual(bodies[0].stream_options, { include_usage: true });
  assert.strictEqual(text, "你好");
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].input, 11);
  assert.strictEqual(recorded[0].output, 7);
});

test("streamChat: 严格网关回 400 → 去掉 stream_options 重试一次并成功", async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.stream_options) {
      return { ok: false, status: 400, json: async () => ({}) };
    }
    return { ok: true, status: 200 };
  };
  const { provider } = loadProvider(fetchImpl);
  const text = await provider.streamChat({ model: "m", messages: [], onToken: () => {} });

  assert.strictEqual(bodies.length, 2, "首次带 stream_options 被拒，去掉后重试一次");
  assert.deepStrictEqual(bodies[0].stream_options, { include_usage: true });
  assert.strictEqual(bodies[1].stream_options, undefined, "重试请求体不含 stream_options");
  assert.strictEqual(text, "你好", "对话仍正常返回内容");
});

test("streamChat: 非 stream_options 导致的 400 → 重试仍失败 → 抛原始错误", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 400, json: async () => ({ error: { message: "上下文超长" } }) };
  };
  const { provider } = loadProvider(fetchImpl);
  await assert.rejects(
    () => provider.streamChat({ model: "m", messages: [], onToken: () => {} }),
    /上下文超长/
  );
  assert.strictEqual(calls, 2, "带着发 + 去掉重试各一次，仍失败");
});

test("streamChat: 非 400 错误不触发重试，直接抛错", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 500, json: async () => ({ error: { message: "服务端错误" } }) };
  };
  const { provider } = loadProvider(fetchImpl);
  await assert.rejects(
    () => provider.streamChat({ model: "m", messages: [], onToken: () => {} }),
    /服务端错误/
  );
  assert.strictEqual(calls, 1, "500 不重试");
});
