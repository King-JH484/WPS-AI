const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadRegistry() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console });
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "registry.js"), "utf8");
  vm.runInContext(source, context, { filename: "registry.js" });
  return window.WpsAiToolRegistry;
}

test("diagnosticOnly 工具不从通用 MCP listAll 导出", () => {
  const registry = loadRegistry();
  registry.registerTool({ name: "normal", handler: async () => "ok" });
  registry.registerTool({ name: "template_probe", diagnosticOnly: "template_probe", handler: async () => "unsafe" });
  assert.deepEqual(Array.from(registry.listAll(), (tool) => tool.name), ["normal"]);
  assert.ok(registry.listForHost("wpp").some((tool) => tool.name === "template_probe"), "内部动态 resolver 仍需从宿主清单取到候选工具");
});

test("registry.execute 对无授权、错领域和过期 turn 的诊断调用 fail closed", async () => {
  const registry = loadRegistry();
  let calls = 0;
  registry.registerTool({
    name: "template_probe",
    diagnosticOnly: "template_probe",
    handler: async () => { calls += 1; return "ok"; }
  });

  for (const ctx of [
    {},
    { source: "mcp" },
    { turnId: "t1", diagnosticTurnId: "t1", diagnosticAuthorization: ["chart_object_probe"] },
    { turnId: "t2", diagnosticTurnId: "t1", diagnosticAuthorization: ["template_probe"] }
  ]) {
    const result = await registry.execute("template_probe", {}, ctx);
    assert.equal(result.ok, false);
    assert.match(result.error, /diagnostic_not_authorized/);
  }
  assert.equal(calls, 0);

  const authorized = await registry.execute("template_probe", {}, {
    turnId: "t1",
    diagnosticTurnId: "t1",
    diagnosticAuthorization: Object.freeze(["template_probe"])
  });
  assert.equal(authorized.ok, true);
  assert.equal(calls, 1);
});
