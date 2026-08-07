const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeStorage(seed = {}) {
  const mem = new Map(Object.entries(seed));
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    _mem: mem
  };
}
function loadRegistry(storeSeed = {}) {
  const sandbox = { window: { WpsAiStore: makeStorage(storeSeed) }, localStorage: makeStorage(), console };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "registry.js"), "utf8");
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiProviderRegistry;
}
const SETTINGS_KEY = "wps_ai_provider_settings_v1";

test("默认设置含空 mcpClients 数组", () => {
  const reg = loadRegistry();
  assert(Array.isArray(reg.DEFAULT_SETTINGS.mcpClients), "mcpClients should be an array");
  assert.equal(reg.DEFAULT_SETTINGS.mcpClients.length, 0, "mcpClients should be empty");
});

test("老配置缺 mcpClients 时 loadSettings 补空数组，不崩", () => {
  const reg = loadRegistry({ [SETTINGS_KEY]: JSON.stringify({ operationMode: "direct" }) });
  const s = reg.loadSettings();
  assert(Array.isArray(s.mcpClients), "mcpClients should be an array");
  assert.equal(s.mcpClients.length, 0, "mcpClients should be empty");
});

test("loadSettings 保留 mcpClients 内容且每次返回独立副本", () => {
  const clients = [{ id: "mc-1", name: "fs", type: "stdio", enabled: true, command: "npx", args: ["-y", "x"] }];
  const reg = loadRegistry({ [SETTINGS_KEY]: JSON.stringify({ mcpClients: clients }) });
  const s = reg.loadSettings();
  assert.strictEqual(s.mcpClients.length, 1);
  assert.strictEqual(s.mcpClients[0].name, "fs");
  assert.strictEqual(s.mcpClients[0].args.length, 2);
  assert.strictEqual(s.mcpClients[0].args[0], "-y");
  assert.strictEqual(s.mcpClients[0].args[1], "x");
  // 改动返回值不得回灌到后续 load（每次 load 返回独立副本）
  s.mcpClients[0].name = "MUTATED";
  const s2 = reg.loadSettings();
  assert.strictEqual(s2.mcpClients[0].name, "fs", "loadSettings 每次应返回独立副本");
});
