"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { spawn } = require("child_process");

const source = fs.readFileSync(path.join(__dirname, "..", "cleanup-storage.js"), "utf8");

function createStorage(items) {
  const map = new Map(Object.entries(items));
  return {
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index] ?? null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    removeItem(key) { map.delete(key); },
    keys() { return Array.from(map.keys()); }
  };
}

test("存储清理只删除两品牌与显式 WPS AI 凭据键", () => {
  const localStorage = createStorage({
    lingxi_conversations_v1: "secret-old",
    anthony_history_v1: "secret-new",
    __lingxi_kv_migrated_v1: "1",
    wps_ai_access_token: "token",
    third_party_setting: "keep"
  });
  const context = { localStorage, location: { pathname: "/wps/" }, console };
  context.window = context;
  vm.runInNewContext(source, context);
  const removed = context.AnthonyStorageCleanup.clearLocalStorage(localStorage);
  assert.deepEqual(Array.from(removed), [
    "__lingxi_kv_migrated_v1", "anthony_history_v1", "lingxi_conversations_v1", "wps_ai_access_token"
  ]);
  assert.deepEqual(localStorage.keys(), ["third_party_setting"]);
});

test("PluginStorage 清单同时覆盖旧新品牌入口邮箱", () => {
  const context = { localStorage: createStorage({}), location: { pathname: "/pdf/" }, console };
  context.window = context;
  vm.runInNewContext(source, context);
  const keys = context.AnthonyStorageCleanup.PLUGIN_STORAGE_KEYS;
  assert.ok(keys.includes("lingxi_ai_pending_action"));
  assert.ok(keys.includes("anthony_ai_pending_action"));
  assert.ok(keys.includes("lingxi_ai_taskpane_id_v11"));
  assert.ok(keys.includes("anthony_conversations_dialog_request_v1"));
  assert.ok(keys.includes("wps_ai_provider_settings_v1"));
});

test("专用清理服务器只提供四宿主清理变体", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-clean-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const host of ["wps", "et", "wpp", "pdf"]) {
    const dir = path.join(root, `plugin-${host}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `<p>${host}-cleanup</p>`);
  }
  const port = 42000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "tools", "serve-storage-cleanup.js"), "--root", root, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cleanup server timeout")), 3000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("[cleanup-server]")) { clearTimeout(timer); resolve(); }
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.mode, "storage-cleanup");
  const html = await fetch(`http://127.0.0.1:${port}/pdf/`).then((r) => r.text());
  assert.match(html, /pdf-cleanup/);
  const unknown = await fetch(`http://127.0.0.1:${port}/other/`);
  assert.equal(unknown.status, 404);
});
