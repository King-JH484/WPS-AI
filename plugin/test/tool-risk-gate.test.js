const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadGate() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console });
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "risk-gate.js"), "utf8");
  vm.runInContext(source, context, { filename: "risk-gate.js" });
  return window.WpsAiRiskGate;
}

test("直接操作模式仍必须审批 destructive 与覆盖写入", () => {
  const gate = loadGate();
  assert.equal(gate.requiresApproval({ risk: "destructive" }, { operationMode: "direct" }), true);
  assert.equal(gate.requiresApproval(
    { risk: "filesystem_create" },
    { operationMode: "direct", args: { overwrite: true } }
  ), true);
  assert.equal(gate.requiresApproval({ risk: "document_write" }, { operationMode: "direct" }), false);
});

test("预览确认模式继续审批普通写工具，安全只读免审批", () => {
  const gate = loadGate();
  assert.equal(gate.requiresApproval({ risk: "document_write" }, { operationMode: "preview" }), true);
  assert.equal(gate.requiresApproval({ risk: "read_only" }, { operationMode: "preview" }), false);
});

test("registry 优先使用 risk 元数据，控制类只读工具不触发文档快照", async () => {
  let captures = 0;
  const window = {
    WpsAiHistory: { isMutatingTool: () => true },
    WpsAiSnapshot: { detectHost: () => "wpp", captureBefore: async () => { captures += 1; return {}; } }
  };
  window.window = window;
  const context = vm.createContext({ window, console });
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "registry.js"), "utf8");
  vm.runInContext(source, context, { filename: "registry.js" });
  window.WpsAiToolRegistry.registerTool({
    name: "wpp_enable_tool_pack",
    hosts: ["wpp"],
    risk: "read_only",
    handler: async () => ({ enabled: true })
  });
  const result = await window.WpsAiToolRegistry.execute("wpp_enable_tool_pack", {});
  assert.equal(result.ok, true);
  assert.equal(captures, 0);
});
