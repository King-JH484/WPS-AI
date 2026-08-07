// plugin/test/mcp-client-stdio.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { StdioMcpClient } = require("../tools/mcp-client-manager.js");

const FIXTURE = path.join(__dirname, "fixtures", "fake-mcp-stdio.js");

test("stdio: initialize + listTools + call echo", async () => {
  const c = new StdioMcpClient({ command: process.execPath, args: [FIXTURE], env: {} });
  await c.start();
  const info = await c.initialize();
  assert.strictEqual(info.serverInfo.name, "fake");
  const tools = await c.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, "echo");
  assert.ok(tools[0].inputSchema.properties.text);
  const res = await c.call("echo", { text: "hi" });
  assert.strictEqual(res.content[0].text, "hi");
  assert.strictEqual(c.connected, true);
  c.close();
});

test("stdio: 未知工具返回 isError", async () => {
  const c = new StdioMcpClient({ command: process.execPath, args: [FIXTURE], env: {} });
  await c.start();
  await c.initialize();
  const res = await c.call("nope", {});
  assert.strictEqual(res.isError, true);
  c.close();
});

test("stdio: 进程退出后 connected=false", async () => {
  const c = new StdioMcpClient({ command: process.execPath, args: [FIXTURE], env: {} });
  await c.start();
  await c.initialize();
  c.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(c.connected, false);
});

test("stdio: 子进程自行退出后再调用快速失败而非挂 60s", async () => {
  const c = new StdioMcpClient({ command: process.execPath, args: [FIXTURE], env: {} });
  await c.start();
  await c.initialize();
  // 触发子进程自行退出（不经 close()，proc.killed 保持 false）
  c.call("__exit__", {}).catch(() => {});   // 这次调用因进程退出被 reject
  await new Promise((r) => setTimeout(r, 150)); // 等 exit 事件传播
  const t0 = Date.now();
  await assert.rejects(() => c.call("echo", { text: "x" }), /子进程未运行/);
  assert.ok(Date.now() - t0 < 1000, "退出后调用应快速失败，不应等 60s 超时");
  c.close();
});
