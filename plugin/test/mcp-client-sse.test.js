// plugin/test/mcp-client-sse.test.js
const test = require("node:test");
const assert = require("node:assert");
const { SseMcpClient } = require("../tools/mcp-client-manager.js");
const { startFakeSseServer } = require("./fixtures/fake-mcp-sse.js");

test("sse: initialize + listTools + call", async () => {
  const { server, url } = await startFakeSseServer();
  const c = new SseMcpClient({ url, headers: {} });
  await c.start();
  const info = await c.initialize();
  assert.strictEqual(info.serverInfo.name, "fake-sse");
  const tools = await c.listTools();
  assert.strictEqual(tools[0].name, "ping");
  const res = await c.call("ping", {});
  assert.strictEqual(res.content[0].text, "pong");
  c.close();
  server.close();
});

test("sse: 超时未收到 endpoint → start 快速拒绝并销毁 SSE 连接（不泄漏）", async () => {
  const { server, url } = await startFakeSseServer({ noEndpoint: true });
  const c = new SseMcpClient({ url, headers: {}, startTimeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(() => c.start(), /endpoint/);
  assert.ok(Date.now() - t0 < 1500, "应在小超时内拒绝");
  assert.ok(c._sseReq == null || c._sseReq.destroyed, "SSE 连接应被销毁");
  c.close();
  server.close();
});

test("sse: POST 到不可达端点 → 挂起请求快速拒绝，不等 60s", async () => {
  const { server, url } = await startFakeSseServer({ badEndpoint: true });
  const c = new SseMcpClient({ url, headers: {} });
  await c.start(); // 收到 endpoint（指向死端口 127.0.0.1:1）
  const t0 = Date.now();
  await assert.rejects(() => c.initialize());
  assert.ok(Date.now() - t0 < 3000, "POST 失败应快速拒绝");
  c.close();
  server.close();
});
