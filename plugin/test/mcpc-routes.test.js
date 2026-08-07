// plugin/test/mcpc-routes.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { McpClientManager, handleMcpcRequest } = require("../tools/mcp-client-manager.js");

const FIXTURE = path.join(__dirname, "fixtures", "fake-mcp-stdio.js");
const cfg = { id: "a", name: "a", type: "stdio", enabled: true, command: process.execPath, args: [FIXTURE], env: {} };

test("非 /mcpc 前缀返回 null", async () => {
  const m = new McpClientManager();
  const r = await handleMcpcRequest("/healthz", "GET", null, m);
  assert.strictEqual(r, null);
});

test("reconcile → status → call → disconnect", async () => {
  const m = new McpClientManager();
  const rc = await handleMcpcRequest("/mcpc/reconcile", "POST", { clients: [cfg] }, m);
  assert.strictEqual(rc.status, 200);
  assert.strictEqual(rc.body.status[0].connected, true);

  const st = await handleMcpcRequest("/mcpc/status", "GET", null, m);
  assert.strictEqual(st.body.status[0].toolCount, 1);

  const cl = await handleMcpcRequest("/mcpc/call", "POST", { id: "a", name: "echo", args: { text: "hey" } }, m);
  assert.strictEqual(cl.body.result.content[0].text, "hey");

  const dc = await handleMcpcRequest("/mcpc/disconnect", "POST", { id: "a" }, m);
  assert.strictEqual(dc.body.ok, true);
  m.closeAll();
});

test("call 失败返回 ok:false", async () => {
  const m = new McpClientManager();
  const cl = await handleMcpcRequest("/mcpc/call", "POST", { id: "ghost", name: "x", args: {} }, m);
  assert.strictEqual(cl.body.ok, false);
  assert.match(cl.body.error, /未连接|不存在/);
});

test("/mcpc/test 路由：临时建连返回工具数", async () => {
  const m = new McpClientManager();
  const r = await handleMcpcRequest("/mcpc/test", "POST", { client: cfg }, m);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.result.ok, true);
  assert.strictEqual(r.body.result.toolCount, 1);
  m.closeAll();
});
