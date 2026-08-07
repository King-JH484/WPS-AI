// plugin/test/mcp-client-ui.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "mcp-client-ui.js"), "utf8"), sandbox);
  return sandbox.window.WpsAiMcpClientUI;
}

test("renderToolParams 渲染参数名/类型/必填", () => {
  const ui = load();
  const schema = { type: "object", properties: { path: { type: "string", description: "文件路径" }, n: { type: "number" } }, required: ["path"] };
  const h = ui.renderToolParams(schema);
  assert.match(h, /path/);
  assert.match(h, /string/);
  assert.match(h, /必填/);       // path 必填
  assert.match(h, /文件路径/);
  assert.match(h, /number/);
});

test("renderToolParams 无参数时给出占位", () => {
  const ui = load();
  assert.match(ui.renderToolParams({ type: "object", properties: {} }), /无参数|—/);
});

test("renderServiceCard 显示名称/连接状态/工具数", () => {
  const ui = load();
  const cfg = { id: "s1", name: "my-fs", type: "stdio", enabled: true };
  const status = { connected: true, toolCount: 3, error: null, tools: [] };
  const h = ui.renderServiceCard(cfg, status);
  assert.match(h, /my-fs/);
  assert.match(h, /已连接/);
  assert.match(h, /3/);           // 工具数
  assert.match(h, /data-mcp-id="s1"/);
});

test("renderServiceCard 未连接显示错误摘要", () => {
  const ui = load();
  const cfg = { id: "s2", name: "bad", type: "stdio", enabled: true };
  const status = { connected: false, toolCount: 0, error: "子进程退出 code=1", tools: [] };
  const h = ui.renderServiceCard(cfg, status);
  assert.match(h, /子进程退出/);
});

test("renderToolList 渲染工具名/描述与展开锚点", () => {
  const ui = load();
  const h = ui.renderToolList([{ name: "read_file", description: "读取文件", inputSchema: { type: "object", properties: {} } }]);
  assert.match(h, /read_file/);
  assert.match(h, /读取文件/);
  assert.match(h, /data-mcp-tool="read_file"/);
});

test("渲染转义外部工具元数据（防注入）", () => {
  const ui = load();
  const evil = "<script>alert(1)</script>";
  const listH = ui.renderToolList([{ name: evil, description: '"><img src=x onerror=y>', inputSchema: { type: "object", properties: {} } }]);
  assert.ok(!listH.includes("<script>"), "工具名须转义，不得出现裸 <script>");
  assert.ok(listH.includes("&lt;script&gt;"), "应转义为 HTML 实体");
  const paramsH = ui.renderToolParams({ type: "object", properties: { [evil]: { type: "string", description: evil } }, required: [] });
  assert.ok(!paramsH.includes("<script>"), "参数名/描述须转义");
  const cardH = ui.renderServiceCard({ id: "s", name: evil, type: "stdio", enabled: true }, { connected: false, toolCount: 0, error: evil, tools: [] });
  assert.ok(!cardH.includes("<script>"), "服务名/错误摘要须转义");
});

test("validateServiceConfig 校验名称格式与唯一性", () => {
  const ui = load();
  assert.ok(ui.validateServiceConfig({ id: "1", name: "Bad Name" }, []), "含空格/大写应报错");
  assert.ok(ui.validateServiceConfig({ id: "1", name: "有中文" }, []), "非 ASCII 应报错");
  assert.strictEqual(ui.validateServiceConfig({ id: "1", name: "ok-1" }, []), null, "合法名通过");
  assert.ok(ui.validateServiceConfig({ id: "2", name: "dup" }, [{ id: "1", name: "dup" }]), "重名应报错");
  assert.strictEqual(ui.validateServiceConfig({ id: "1", name: "dup" }, [{ id: "1", name: "dup" }]), null, "编辑自身不算重名");
});

test("renderServiceCard 有备注名时显示备注为主标题 + 英文名副标题", () => {
  const ui = load();
  const h = ui.renderServiceCard(
    { id: "s1", name: "my-fs", note: "我的文件系统", type: "stdio", enabled: true },
    { connected: true, toolCount: 1, tools: [] }
  );
  assert.match(h, /我的文件系统/, "应显示备注名");
  assert.match(h, /mcp-subname[^>]*>my-fs/, "应显示英文名副标题");
});

test("renderServiceCard 无备注名时回退显示英文名、不渲染副标题", () => {
  const ui = load();
  const h = ui.renderServiceCard({ id: "s2", name: "plain", type: "stdio", enabled: true }, { connected: false, toolCount: 0, tools: [] });
  assert.match(h, /plain/);
  assert.doesNotMatch(h, /mcp-subname/, "无备注名不渲染副标题");
});

test("parseMcpServersJson: mcpServers 包裹 + stdio/sse 混合", () => {
  const ui = load();
  const json = JSON.stringify({ mcpServers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    myremote: { url: "http://localhost:3000/mcp/sse" }
  } });
  const r = ui.parseMcpServersJson(json);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.clients.length, 2);
  const pw = r.clients.find((c) => c.name === "playwright");
  assert.strictEqual(pw.type, "stdio");
  assert.strictEqual(pw.command, "npx");
  assert.strictEqual(pw.args.length, 2);
  assert.strictEqual(pw.args[0], "-y");
  assert.strictEqual(pw.args[1], "@playwright/mcp@latest");
  assert.strictEqual(pw.note, "playwright");
  const rm = r.clients.find((c) => c.type === "sse");
  assert.strictEqual(rm.url, "http://localhost:3000/mcp/sse");
});

test("parseMcpServersJson: 直接 { 名称: {...} } 无 mcpServers 包裹也行", () => {
  const ui = load();
  const r = ui.parseMcpServersJson('{"fs":{"command":"npx","args":["x"]}}');
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.clients[0].name, "fs");
});

test("parseMcpServersJson: 非法 key 归一为合法名，原 key 存为备注", () => {
  const ui = load();
  const r = ui.parseMcpServersJson('{"mcpServers":{"My Server_1":{"command":"npx"}}}');
  assert.strictEqual(r.clients[0].name, "my-server-1");
  assert.strictEqual(r.clients[0].note, "My Server_1");
});

test("parseMcpServersJson: 坏 JSON / 空 / 无 command|url → error", () => {
  const ui = load();
  assert.ok(ui.parseMcpServersJson("not json").error);
  assert.ok(ui.parseMcpServersJson('{"mcpServers":{}}').error);
  assert.ok(ui.parseMcpServersJson('{"x":{"foo":"bar"}}').error);
});
