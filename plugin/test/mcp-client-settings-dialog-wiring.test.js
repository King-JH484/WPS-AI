const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

// 回归护栏：MCP 客户端设置面板渲染在独立的 ?mode=settings 窗口里。
// 该窗口的 bootstrap 是 `if (isSettingsDialog) { ... return; }` 分支——分支末尾 return，
// 主 TaskPane 之后的 WpsAiMcpClientUI.init() 在设置窗口里根本跑不到。
// 因此 init 必须也在 isSettingsDialog 分支内调用，否则 #mcpClientAddBtn 没有点击监听，
// 用户点「新增 MCP 服务」没有任何反应（与历史上 addImageProviderBtn 同款 bug）。
test("设置窗口(isSettingsDialog)分支内必须初始化 MCP Client UI", () => {
  const start = appJs.indexOf("if (isSettingsDialog) {");
  assert.ok(start >= 0, "找不到 isSettingsDialog 分支");
  // 该分支以「不跑下面的 TaskPane 初始化逻辑」的 return 结束
  const end = appJs.indexOf("不跑下面的 TaskPane 初始化逻辑", start);
  assert.ok(end > start, "找不到 isSettingsDialog 分支结尾");
  const block = appJs.slice(start, end);
  assert.match(
    block,
    /WpsAiMcpClientUI\??\.init/,
    "设置窗口分支必须调用 WpsAiMcpClientUI.init（否则 #mcpClientAddBtn 无点击监听，点「新增 MCP 服务」没反应）"
  );
});
