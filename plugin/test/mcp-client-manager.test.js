// plugin/test/mcp-client-manager.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { McpClientManager } = require("../tools/mcp-client-manager.js");

const FIXTURE = path.join(__dirname, "fixtures", "fake-mcp-stdio.js");
function stdioCfg(id, extra = {}) {
  return Object.assign({ id, name: id, type: "stdio", enabled: true, command: process.execPath, args: [FIXTURE], env: {} }, extra);
}

test("reconcile 连接 enabled 的 stdio 并拉到工具", async () => {
  const m = new McpClientManager();
  const status = await m.reconcile([stdioCfg("a")]);
  assert.strictEqual(status.length, 1);
  assert.strictEqual(status[0].connected, true);
  assert.strictEqual(status[0].toolCount, 1);
  assert.strictEqual(status[0].tools[0].name, "echo");
  m.closeAll();
});

test("reconcile 跳过 enabled:false，并断开已移除的", async () => {
  const m = new McpClientManager();
  await m.reconcile([stdioCfg("a")]);
  const status = await m.reconcile([stdioCfg("a", { enabled: false })]);
  assert.strictEqual(status[0].connected, false);
  await m.reconcile([]); // 全移除
  assert.strictEqual(m.getStatusList().length, 0);
  m.closeAll();
});

test("call 路由到指定连接", async () => {
  const m = new McpClientManager();
  await m.reconcile([stdioCfg("a")]);
  const res = await m.call("a", "echo", { text: "yo" });
  assert.strictEqual(res.content[0].text, "yo");
  m.closeAll();
});

test("call 到不存在的连接抛错", async () => {
  const m = new McpClientManager();
  await assert.rejects(() => m.call("ghost", "x", {}), /未连接|不存在/);
  m.closeAll();
});

test("reconcile 禁用后再启用能重新连接并恢复工具", async () => {
  const m = new McpClientManager();
  await m.reconcile([stdioCfg("a")]);
  let status = await m.reconcile([stdioCfg("a", { enabled: false })]);
  assert.strictEqual(status[0].connected, false);
  assert.strictEqual(status[0].toolCount, 0);   // 禁用后工具清零
  status = await m.reconcile([stdioCfg("a")]);   // 重新启用
  assert.strictEqual(status[0].connected, true);
  assert.strictEqual(status[0].toolCount, 1);    // 工具恢复
  m.closeAll();
});

test("reconcile 配置变更(fingerprint 变)不破坏连接", async () => {
  const m = new McpClientManager();
  await m.reconcile([stdioCfg("a")]);
  // 改 env → fingerprint 变 → 应重连,仍连上且工具在
  const status = await m.reconcile([stdioCfg("a", { env: { FOO: "bar" } })]);
  assert.strictEqual(status[0].connected, true);
  assert.strictEqual(status[0].toolCount, 1);
  m.closeAll();
});

test("reconcile 禁用并改名 → status 反映新名", async () => {
  const m = new McpClientManager();
  await m.reconcile([stdioCfg("a", { name: "old" })]);
  const status = await m.reconcile([stdioCfg("a", { name: "new", enabled: false })]);
  assert.strictEqual(status[0].connected, false);
  assert.strictEqual(status[0].name, "new");
  m.closeAll();
});

test("testConnection 成功返回工具数且不进 _conns", async () => {
  const m = new McpClientManager();
  const r = await m.testConnection(stdioCfg("t"));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.toolCount, 1);
  assert.strictEqual(m.getStatusList().length, 0, "测试连接不应留下连接");
  m.closeAll();
});

test("testConnection 失败返回 ok:false + error（SSE 死端口快速失败）", async () => {
  const m = new McpClientManager();
  const r = await m.testConnection({ type: "sse", url: "http://127.0.0.1:1/sse", headers: {} });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error, "应带错误信息");
  m.closeAll();
});

const { resolveSpawn } = require("../tools/mcp-client-manager.js");

test("resolveSpawn: Windows 裸命令(npx)经 cmd.exe /c 解析（修 spawn npx ENOENT）", () => {
  const r = resolveSpawn("npx", ["-y", "@playwright/mcp@latest"], true);
  assert.match(r.file, /cmd/i, "应走 cmd.exe");
  assert.deepStrictEqual(r.args, ["/c", "npx", "-y", "@playwright/mcp@latest"]);
});

test("resolveSpawn: Windows 全路径 .exe 直接 spawn（不拆带空格的路径）", () => {
  const exe = "C:\Program Files\nodejs\node.exe";
  const r = resolveSpawn(exe, ["script.js"], true);
  assert.strictEqual(r.file, exe);
  assert.deepStrictEqual(r.args, ["script.js"]);
});

test("resolveSpawn: Windows 显式 .cmd 脚本也经 cmd.exe", () => {
  const r = resolveSpawn("C:\tools\server.cmd", ["a"], true);
  assert.match(r.file, /cmd/i);
  assert.deepStrictEqual(r.args, ["/c", "C:\tools\server.cmd", "a"]);
});

test("resolveSpawn: 非 Windows 原样直传", () => {
  const r = resolveSpawn("npx", ["-y", "x"], false);
  assert.strictEqual(r.file, "npx");
  assert.deepStrictEqual(r.args, ["-y", "x"]);
});
