const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadRuntime() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  for (const file of ["wpp-capabilities.js", "tool-packs.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "tools", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return window;
}

const defs = [
  { name: "todo_replace_all", hosts: ["*"], handler() {} },
  { name: "wpp_get_presentation_info", hosts: ["wpp"], handler() {} },
  { name: "wpp_add_slide", hosts: ["wpp"], handler() {} },
  { name: "wpp_master_inspect", hosts: ["wpp"], handler() {}, capability: "wpp.master.inspect" },
  { name: "wpp_native_chart_create", hosts: ["wpp"], handler() {}, capability: "wpp.chart.native.create" },
  { name: "wpp_probe_native_write_capabilities", hosts: ["wpp"], pack: "template_native", diagnosticOnly: "template_probe", handler() {} },
  { name: "wpp_probe_native_chart_capabilities", hosts: ["wpp"], pack: "chart_native", diagnosticOnly: "chart_object_probe", handler() {} },
  { name: "wps_read_document", hosts: ["wps"], handler() {} }
];

test("WPP 工具包仅改变可见 schema，并可在同一轮幂等升级", () => {
  const runtime = loadRuntime();
  const packs = runtime.WpsAiToolPacks;
  const ctx = { host: "wpp", conversationId: "c1", turnId: "t1", userText: "制作一个演示文稿" };

  packs.beginTurn(ctx);
  const initial = packs.resolveTools(ctx, defs);
  assert.ok(Object.isFrozen(initial));
  assert.ok(initial.definitions.some((tool) => tool.name === "todo_replace_all"));
  assert.ok(initial.definitions.some((tool) => tool.name === "wpp_add_slide"));
  assert.ok(!initial.definitions.some((tool) => tool.name === "wpp_master_inspect"));

  const enabled = packs.enablePack(ctx, "template_native");
  assert.equal(enabled.changed, true);
  const upgraded = packs.resolveTools(ctx, defs);
  assert.ok(upgraded.revision > initial.revision);
  assert.ok(upgraded.definitions.some((tool) => tool.name === "wpp_master_inspect"));

  const repeated = packs.enablePack(ctx, "template_native");
  assert.equal(repeated.changed, false);
  assert.equal(packs.resolveTools(ctx, defs).revision, upgraded.revision);
});

test("显式模板/图表意图自动预启用相应工具包，非 WPP 宿主保持静态兼容", () => {
  const runtime = loadRuntime();
  const packs = runtime.WpsAiToolPacks;
  const wppCtx = { host: "wpp", conversationId: "c2", turnId: "t2", userText: "制作母版并插入原生图表" };
  packs.beginTurn(wppCtx);
  const snapshot = packs.resolveTools(wppCtx, defs);
  assert.ok(snapshot.enabledPacks.includes("template_native"));
  assert.ok(snapshot.enabledPacks.includes("chart_native"));
  assert.ok(snapshot.definitions.some((tool) => tool.name === "wpp_native_chart_create"));

  const writer = packs.resolveTools({ host: "wps", conversationId: "c3", turnId: "t3" }, defs);
  assert.deepEqual(
    Array.from(writer.definitions, (tool) => tool.name),
    defs.filter((tool) => !tool.diagnosticOnly).map((tool) => tool.name)
  );
});

test("能力目录区分声明与实测，不把 Windows 待验证能力冒充 supported", () => {
  const runtime = loadRuntime();
  const catalog = runtime.WpsAiWppCapabilities.catalog({ platform: "win32" });
  const master = catalog.capabilities.find((item) => item.key === "wpp.master.inspect");
  assert.equal(master.state, "unverified");
  assert.equal(master.adapters.find((item) => item.id === "windows_com").state, "unverified");
});

test("普通母版创作启用模板包但不暴露 destructive diagnostic 工具", () => {
  const runtime = loadRuntime();
  const packs = runtime.WpsAiToolPacks;
  const ctx = { host: "wpp", conversationId: "c4", turnId: "t4", userText: "请为当前演示制作一套母版和版式" };
  packs.beginTurn(ctx);
  const snapshot = packs.resolveTools(ctx, defs);
  assert.ok(snapshot.enabledPacks.includes("template_native"));
  assert.ok(snapshot.definitions.some((tool) => tool.name === "wpp_master_inspect"));
  assert.ok(!snapshot.definitions.some((tool) => tool.diagnosticOnly));
});

test("模板与图表诊断按当前原始输入分别授权，启用工具包不能扩大授权", () => {
  const runtime = loadRuntime();
  const packs = runtime.WpsAiToolPacks;
  const ctx = { host: "wpp", conversationId: "c5", turnId: "t5", userText: "请运行母版能力探针" };
  packs.beginTurn(ctx);
  packs.enablePack(ctx, "chart_native");
  const snapshot = packs.resolveTools(ctx, defs);
  assert.deepEqual(Array.from(snapshot.diagnosticAuthorization), ["template_probe"]);
  assert.ok(snapshot.definitions.some((tool) => tool.name === "wpp_probe_native_write_capabilities"));
  assert.ok(!snapshot.definitions.some((tool) => tool.name === "wpp_probe_native_chart_capabilities"));

  const chartCtx = { host: "wpp", conversationId: "c6", turnId: "t6", userText: "测试原生图表对象接口" };
  packs.beginTurn(chartCtx);
  const chartSnapshot = packs.resolveTools(chartCtx, defs);
  assert.deepEqual(Array.from(chartSnapshot.diagnosticAuthorization), ["chart_object_probe"]);
  assert.ok(chartSnapshot.definitions.some((tool) => tool.name === "wpp_probe_native_chart_capabilities"));
  assert.ok(!chartSnapshot.definitions.some((tool) => tool.name === "wpp_probe_native_write_capabilities"));
});

test("否定、引用和文件名不会授权写探针", () => {
  const runtime = loadRuntime();
  const packs = runtime.WpsAiToolPacks;
  for (const [index, userText] of [
    "不要运行母版探针，只制作母版",
    "文件名是 probe-test.pptx，请制作母版",
    "刚才 AI 提到了‘运行母版能力探针’，现在只做排版"
  ].entries()) {
    const ctx = { host: "wpp", conversationId: `neg-${index}`, turnId: `neg-${index}`, userText };
    packs.beginTurn(ctx);
    const snapshot = packs.resolveTools(ctx, defs);
    assert.equal(snapshot.diagnosticAuthorization.length, 0, userText);
    assert.ok(!snapshot.definitions.some((tool) => tool.diagnosticOnly), userText);
  }
});
