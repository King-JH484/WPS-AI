const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 场景：一轮对话进行中，用户切换模型下拉（改的是全局 activeChatModel）。
// 在跑的这轮必须继续用发送时锁定的 provider，绝不能把新模型名发到旧供应商
// （否则报「Not found the model ...」）。facade 的 runWithTools 收到 config 时
// 必须用它、不再读全局 getActiveConfig。

function loadFacade({ activeConfigRef, buildProvider }) {
  const registry = {
    // 模拟「用户中途切换模型」——每次读都可能变
    getActiveConfig: () => activeConfigRef.current,
    buildProvider
  };
  const sandbox = {
    window: { WpsAiProviderRegistry: registry, WpsAiChatEvents: null },
    console
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "openai.js"), "utf8");
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiOpenAI;
}

function fakeProvider(config) {
  return {
    id: config.id, type: config.type, label: config.label,
    defaultModel: config.model || "",
    ensureReady: async () => {},
    // 记录实际被调用时用的 provider + model
    runWithTools: async ({ model }) => {
      config.__called = { providerId: config.id, model };
      return "";
    }
  };
}

test("runWithTools 传了 config → 用锁定的 provider，无视全局切换", async () => {
  const provA = { id: "provA", type: "openai", label: "A", model: "model-a", baseUrl: "https://a" };
  const provB = { id: "provB", type: "openai", label: "B", model: "deepseek-v4-pro", baseUrl: "https://b" };
  const activeConfigRef = { current: provA };
  const built = [];
  const facade = loadFacade({
    activeConfigRef,
    buildProvider: (cfg) => { built.push(cfg.id); return fakeProvider(cfg); }
  });

  // 发送时锁定 provA。模拟「话说到一半用户切到了 provB / deepseek-v4-pro」：
  activeConfigRef.current = provB;

  await facade.runWithTools({ model: "model-a", config: provA, messages: [], tools: [] });

  // 必须用锁定的 provA 构建，而不是被切换后的 provB
  assert.deepEqual(built, ["provA"], "应当用锁定的 config 构建 provider");
  assert.equal(provA.__called.providerId, "provA");
  assert.equal(provA.__called.model, "model-a", "发出去的模型是本轮锁定的，不是切换后的");
  assert.equal(provB.__called, undefined, "被切到的新供应商不该被这轮碰到");
});

test("不传 config → 保持原行为，读全局 getActiveConfig", async () => {
  const provA = { id: "provA", type: "openai", label: "A", model: "model-a" };
  const activeConfigRef = { current: provA };
  const built = [];
  const facade = loadFacade({
    activeConfigRef,
    buildProvider: (cfg) => { built.push(cfg.id); return fakeProvider(cfg); }
  });
  await facade.runWithTools({ model: "model-a", messages: [], tools: [] });
  assert.deepEqual(built, ["provA"], "无 config 时回退读全局激活配置");
});
