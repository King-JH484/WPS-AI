const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const providers = ["openai.js", "openai-responses.js", "codex.js", "anthropic.js", "gemini.js"];

test("每个 provider 都在每次工具循环中重新解析工具 snapshot", () => {
  for (const file of providers) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "providers", file), "utf8");
    const loopAt = source.indexOf("for (let iter = 0; iter < maxIterations; iter += 1)");
    assert.ok(loopAt >= 0, `${file} 缺少工具循环`);
    const resolveAt = source.indexOf("resolveToolSnapshot", loopAt);
    assert.ok(resolveAt > loopAt, `${file} 未在循环内调用 resolveToolSnapshot`);
    assert.match(source.slice(resolveAt, resolveAt + 900), /toolSnapshot\.definitions/,
      `${file} 未从动态 snapshot 生成请求 schema`);
  }
});

test("provider facade 向实现层透传 resolver 与工具上下文", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "openai.js"), "utf8");
  assert.match(source, /resolveTools/);
  assert.match(source, /toolContext/);
  assert.match(source, /provider\.runWithTools\([\s\S]*resolveTools[\s\S]*toolContext/);
});

test("execution context 绑定当前 turn 的不可变诊断授权", () => {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "js", "providers", "tool-resolution.js"), "utf8"),
    context,
    { filename: "tool-resolution.js" }
  );
  const result = window.WpsAiProviderTools.executionContext(
    null,
    { turnId: "turn-1", host: "wpp" },
    { revision: 2, diagnosticAuthorization: ["template_probe"] }
  );
  assert.equal(result.diagnosticTurnId, "turn-1");
  assert.deepEqual(Array.from(result.diagnosticAuthorization), ["template_probe"]);
  assert.ok(Object.isFrozen(result.diagnosticAuthorization));
});

function loadToolResolution() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "js", "providers", "tool-resolution.js"), "utf8"),
    context,
    { filename: "tool-resolution.js" }
  );
  return window.WpsAiProviderTools;
}

test("resolver 初始静态 snapshot 排除 diagnosticOnly，首次动态解析失败时 fail closed", async () => {
  const runtime = loadToolResolution();
  const tools = [{ name: "normal" }, { name: "probe", diagnosticOnly: "template_probe" }];
  const staticSnapshot = await runtime.createResolver({ tools })();
  assert.deepEqual(Array.from(staticSnapshot.definitions, (tool) => tool.name), ["normal"]);

  const failing = runtime.createResolver({
    tools,
    resolveTools: async () => { throw new Error("boom"); }
  });
  await assert.rejects(() => failing(), /boom/);
});

test("resolver 只有在已有成功安全 snapshot 后允许一次失败回退", async () => {
  const runtime = loadToolResolution();
  let call = 0;
  const resolver = runtime.createResolver({
    tools: [{ name: "unsafe-unfiltered" }],
    resolveTools: async () => {
      call += 1;
      if (call === 1) return { revision: 7, definitions: [{ name: "safe" }], diagnosticAuthorization: [] };
      throw new Error(`boom-${call}`);
    }
  });
  assert.deepEqual(Array.from((await resolver()).definitions, (tool) => tool.name), ["safe"]);
  assert.deepEqual(Array.from((await resolver()).definitions, (tool) => tool.name), ["safe"]);
  await assert.rejects(() => resolver(), /boom-3/);
});

test("OpenAI planner 使用 resolver 的安全初始 snapshot 而非原始 tools", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "openai.js"), "utf8");
  assert.doesNotMatch(source, /const initialToolSpecs = tools\.map/);
  assert.match(source, /initialToolSnapshot[\s\S]{0,300}initialToolSnapshot\.definitions\.map/);
});
