// plugin/test/mcp-client-approver.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

test("buildChatApprover 对 trusted 的 mcp__ 工具放行", () => {
  // 断言实现里存在 trusted 白名单判断逻辑（防回归）
  // 1. 检查 startsWith("mcp__") 守护条件
  assert.match(appJs, /startsWith\("mcp__"\)/, "approver 应以 startsWith(\"mcp__\") 检查外部工具");

  // 2. 检查准确的服务名解析公式：call.name.slice(5).split("__")[0]
  assert.match(appJs, /call\.name\.slice\(5\)\.split\("__"\)\[0\]/, "approver 应按 mcp__<service>__ 解析服务名");

  // 3. 检查 trusted 白名单查询逻辑：从 mcpClients 里核对 c.trusted
  assert.match(appJs, /mcpClients[\s\S]{0,200}?c\.trusted/, "approver 应在 mcpClients 里核对 trusted");
});
