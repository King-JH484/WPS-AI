// plugin/test/mcp-client-panel.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "..", "taskpane.html"), "utf8");

test("侧栏有 MCP 客户端入口", () => {
  assert.match(html, /data-settings-panel="mcp-client"[^>]*role="tab"/, "缺 sidebar 按钮");
  assert.match(html, /<span>MCP 客户端<\/span>/, "缺 MCP 客户端标签");
});
test("有 MCP 客户端面板与容器锚点", () => {
  assert.match(html, /<section[^>]*data-settings-panel="mcp-client"/, "缺 section");
  assert.match(html, /id="mcpClientList"/, "缺服务列表容器");
  assert.match(html, /id="mcpClientAddBtn"/, "缺新增按钮");
});
test("图标为线性 SVG，无 emoji", () => {
  const m = html.match(/data-settings-panel="mcp-client"[\s\S]{0,450}?<\/button>/);
  assert.ok(m, "找不到 sidebar 按钮块");
  assert.match(m[0], /stroke="currentColor"/, "图标须线性 stroke-currentColor");
});
