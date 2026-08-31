const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTemplateExportManager } = require("../tools/template-export.js");
const vm = require("node:vm");

function fakePotx() {
  return Buffer.from("PK\x03\x04....[Content_Types].xml....ppt/presentation.xml....PK\x05\x06................................", "latin1");
}

test("POTX 事务在验证 OOXML 后排他落盘", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-potx-test-"));
  try {
    const manager = createTemplateExportManager();
    const finalPath = path.join(dir, "brand.potx");
    const prepared = manager.prepare({ finalPath });
    fs.writeFileSync(prepared.tempPath, fakePotx());
    const result = manager.finalize({ token: prepared.token });
    assert.equal(result.path, finalPath);
    assert.ok(fs.existsSync(finalPath));
    assert.ok(!fs.existsSync(prepared.tempPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("无 overwrite 时拒绝覆盖；显式覆盖会保留备份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-potx-test-"));
  try {
    const finalPath = path.join(dir, "brand.potx");
    fs.writeFileSync(finalPath, "old");
    const manager = createTemplateExportManager();
    assert.throws(() => manager.prepare({ finalPath }), /overwrite=true/);
    const prepared = manager.prepare({ finalPath, overwrite: true });
    fs.writeFileSync(prepared.tempPath, fakePotx());
    const result = manager.finalize({ token: prepared.token });
    assert.ok(result.backupPath);
    assert.equal(fs.readFileSync(result.backupPath, "utf8"), "old");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("结构不完整的 ZIP 不落盘并保留原文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-potx-test-"));
  try {
    const finalPath = path.join(dir, "brand.potx");
    fs.writeFileSync(finalPath, "old");
    const manager = createTemplateExportManager();
    const prepared = manager.prepare({ finalPath, overwrite: true });
    fs.writeFileSync(prepared.tempPath, Buffer.from("PK\x03\x04broken", "latin1"));
    assert.throws(() => manager.finalize({ token: prepared.token }), /过小|缺少/);
    assert.equal(fs.readFileSync(finalPath, "utf8"), "old");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("前端只调用 SaveCopyAs format=26，并在成功后 finalize", async () => {
  const calls = [];
  const fetchCalls = [];
  const presentation = { SaveCopyAs: (...args) => calls.push(args) };
  const window = {
    navigator: { platform: "MacIntel" },
    WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" },
    WpsAiHostPresentation: { _internal: { getActivePresentation: async () => presentation } },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url.endsWith("/prepare")) return { ok: true, json: async () => ({ ok: true, token: "t1", tempPath: "/tmp/.brand.tmp.potx" }) };
      return { ok: true, json: async () => ({ ok: true, path: "/tmp/brand.potx", size: 123 }) };
    }
  };
  window.window = window;
  const context = vm.createContext({ window, console, navigator: window.navigator, Date, Promise });
  for (const [folder, file] of [["tools", "wpp-capabilities.js"], ["hosts", "presentation-native-handles.js"], ["hosts", "presentation-native.js"]]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", folder, file), "utf8"), context, { filename: file });
  }
  const result = await window.WpsAiPresentationNative.exportTemplate({ path: "/tmp/brand.potx" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 26);
  assert.equal(fetchCalls.length, 2);
  assert.equal(result.path, "/tmp/brand.potx");
});
