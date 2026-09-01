const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function collection(items) {
  return { Count: items.length, Item: (index) => items[index - 1] };
}

function loadNative(presentation) {
  const window = {
    WpsAiHostPresentation: { _internal: { getActivePresentation: async () => presentation } },
    WpsAiWppCapabilities: { capabilities: [] }
  };
  window.window = window;
  const context = vm.createContext({ window, console, navigator: { platform: "MacIntel" } });
  for (const file of ["presentation-native-handles.js", "presentation-native.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return window.WpsAiPresentationNative;
}

function loadCapabilities() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "tools", "wpp-capabilities.js"), "utf8"), context);
  return window.WpsAiWppCapabilities;
}

const identity = Object.freeze({ architecture: "arm64", wpsVersion: "12.1.0", wpsBuild: "25867", pluginVersion: "1.4.7" });

test("领域局部证据合并与探针执行顺序无关", () => {
  for (const reports of [
    [["wpp.master.update", "template"], ["wpp.chart.native.create", "chart_object"]],
    [["wpp.chart.native.create", "chart_object"], ["wpp.master.update", "template"]]
  ]) {
    const capabilities = loadCapabilities();
    for (const [key, domain] of reports) {
      capabilities.recordEvidence({
        platform: "darwin", assessedDomains: [domain], runtimeIdentity: identity,
        capabilities: { [key]: { state: "supported", adapter: "wps_jsapi", reason: "test" } },
        evidence: { observedAt: "2026-09-01T00:00:00.000Z" }
      });
    }
    assert.equal(capabilities.getCapabilityStatus("darwin", "wpp.master.update", "wps_jsapi", identity).state, "supported");
    assert.equal(capabilities.getCapabilityStatus("darwin", "wpp.chart.native.create", "wps_jsapi", identity).state, "supported");
  }
});

test("WPS build 或架构变化后旧证据不能授权新环境", () => {
  const capabilities = loadCapabilities();
  capabilities.recordEvidence({
    platform: "darwin", assessedDomains: ["template"], runtimeIdentity: identity,
    capabilities: { "wpp.master.update": { state: "supported", adapter: "wps_jsapi", reason: "test" } }
  });
  assert.equal(capabilities.getCapabilityStatus("darwin", "wpp.master.update", "wps_jsapi", { ...identity, wpsBuild: "25880" }).state, "unverified");
  assert.equal(capabilities.getCapabilityStatus("darwin", "wpp.master.update", "wps_jsapi", { ...identity, architecture: "x64" }).state, "unverified");
});

test("只读探针真实遍历母版对象；写能力保持 unverified", async () => {
  const layouts = Object.assign(collection([{ Name: "Title", MatchingName: "title", Shapes: collection([]) }]), { Add() {} });
  const master = { Name: "Master", CustomLayouts: layouts, Shapes: collection([]) };
  const design = { Name: "Design 1", Index: 1, SlideMaster: master };
  const presentation = {
    Name: "probe.pptx", FullName: "/tmp/probe.pptx",
    Designs: collection([design]), Slides: { ...collection([]), AddSlide() {} },
    SaveCopyAs() {}
  };
  const native = loadNative(presentation);
  const report = await native.probe({ mode: "read" });
  assert.equal(report.capabilities["wpp.master.inspect"].state, "supported");
  assert.equal(report.capabilities["wpp.layout.manage"].state, "unverified");
  assert.equal(report.capabilities["wpp.template.export"].state, "unverified");
  assert.equal(report.evidence.mutated, false);
});

test("缺失对象链时返回 unsupported 证据而非抛错或冒充支持", async () => {
  const native = loadNative({ Name: "empty.pptx", Slides: collection([]) });
  const report = await native.probe({ mode: "read" });
  assert.equal(report.capabilities["wpp.master.inspect"].state, "unsupported");
  assert.match(report.capabilities["wpp.master.inspect"].reason, /Designs|SlideMaster/);
});

test("写探针没有显式沙箱确认时 fail closed", async () => {
  const native = loadNative({ Name: "probe.pptx", Slides: collection([]) });
  await assert.rejects(() => native.probe({ mode: "write" }), /sandboxConfirmed/);
});
