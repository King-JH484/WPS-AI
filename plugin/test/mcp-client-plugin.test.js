const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSandbox({ fetchImpl } = {}) {
  const store = new Map();
  const sandbox = {
    window: {
      WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" },
      WpsAiMcpBridge: { getToken: () => "tok" },
      WpsAiStore: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
    },
    console,
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ ok: true, status: [] }) }))
  };
  sandbox.window.fetch = sandbox.fetch;
  vm.createContext(sandbox);
  for (const f of ["js/tools/registry.js", "js/mcp-client.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox);
  }
  return sandbox.window;
}

test("registry 支持 unregisterTool", () => {
  const w = loadSandbox();
  w.WpsAiToolRegistry.registerTool({ name: "t1", handler: async () => 1 });
  assert.ok(w.WpsAiToolRegistry.getDefinition("t1"));
  w.WpsAiToolRegistry.unregisterTool("t1");
  assert.strictEqual(w.WpsAiToolRegistry.getDefinition("t1"), null);
});

test("namespacedName + normalizeResult", () => {
  const w = loadSandbox();
  assert.strictEqual(w.WpsAiMcpClient.namespacedName("fs", "read"), "mcp__fs__read");
  // JSON round-trip: vm.createContext gives sandboxed objects a different
  // Object.prototype from this file's realm; deepStrictEqual checks prototype
  // identity too, so compare via JSON to sidestep the cross-realm mismatch
  // (same workaround used in markdown-to-word.adapters.test.js).
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(w.WpsAiMcpClient.normalizeResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }))),
    { ok: true, value: "a\nb" }
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(w.WpsAiMcpClient.normalizeResult({ content: [{ type: "text", text: "bad" }], isError: true }))),
    { ok: false, error: "bad" }
  );
});

test("reconcile 注册命名空间工具，handler 路由到 /mcpc/call", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith("/mcpc/reconcile")) {
      return { ok: true, json: async () => ({ ok: true, status: [
        { id: "s1", name: "fs", connected: true, toolCount: 1, error: null,
          tools: [{ name: "read", description: "read file", inputSchema: { type: "object", properties: {} } }] }
      ] }) };
    }
    if (url.endsWith("/mcpc/call")) {
      return { ok: true, json: async () => ({ ok: true, result: { content: [{ type: "text", text: "FILEDATA" }] } }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const w = loadSandbox({ fetchImpl });
  await w.WpsAiMcpClient.reconcile([{ id: "s1", name: "fs", type: "stdio", enabled: true }]);
  const def = w.WpsAiToolRegistry.getDefinition("mcp__fs__read");
  assert.ok(def, "应注册 mcp__fs__read");
  assert.match(def.description, /\[mcp: fs\]/);
  const out = await def.handler({ path: "/x" });
  assert.strictEqual(out.content[0].text, "FILEDATA"); // handler 返回原始 MCP result；execute 外层归一化由 registry 负责
  const callReq = calls.find((c) => c.url.endsWith("/mcpc/call"));
  assert.strictEqual(callReq.body.id, "s1");
  assert.strictEqual(callReq.body.name, "read"); // 用原始名，非命名空间名
});

test("再次 reconcile 注销上一批外部工具(无泄漏)", async () => {
  let call = 0;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith("/mcpc/reconcile")) {
      call += 1;
      const status = call === 1
        ? [{ id: "s1", name: "fs", connected: true, toolCount: 1, error: null, tools: [{ name: "read", description: "d", inputSchema: { type: "object", properties: {} } }] }]
        : [{ id: "s2", name: "db", connected: true, toolCount: 1, error: null, tools: [{ name: "query", description: "d", inputSchema: { type: "object", properties: {} } }] }];
      return { ok: true, json: async () => ({ ok: true, status }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const w = loadSandbox({ fetchImpl });
  await w.WpsAiMcpClient.reconcile([{ id: "s1", name: "fs", type: "stdio", enabled: true }]);
  assert.ok(w.WpsAiToolRegistry.getDefinition("mcp__fs__read"));
  await w.WpsAiMcpClient.reconcile([{ id: "s2", name: "db", type: "stdio", enabled: true }]);
  assert.strictEqual(w.WpsAiToolRegistry.getDefinition("mcp__fs__read"), null, "旧工具应被注销");
  assert.ok(w.WpsAiToolRegistry.getDefinition("mcp__db__query"), "新工具应注册");
});

test("testConnection 转发到 /mcpc/test 并归一化结果", async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith("/mcpc/test")) {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ok: true, result: { ok: true, toolCount: 2 } }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const w = loadSandbox({ fetchImpl });
  const r = await w.WpsAiMcpClient.testConnection({ id: "x", type: "stdio", command: "npx" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.toolCount, 2);
  assert.ok(sentBody && sentBody.client, "应把 cfg 放在 client 字段发送");
  assert.strictEqual(sentBody.client.command, "npx");
});
