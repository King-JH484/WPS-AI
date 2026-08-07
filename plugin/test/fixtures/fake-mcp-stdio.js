// plugin/test/fixtures/fake-mcp-stdio.js
// 最小假 MCP server：换行分隔 JSON-RPC。支持 initialize / tools/list / tools/call。
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.method === "notifications/initialized") continue; // 通知无响应
    let result;
    if (msg.method === "initialize") {
      result = { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "1.0" }, capabilities: {} };
    } else if (msg.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    } else if (msg.method === "tools/call") {
      if (msg.params && msg.params.name === "__exit__") {
        process.exit(0); // 模拟子进程自行退出，不写任何响应
      } else if (msg.params && msg.params.name === "echo") {
        result = { content: [{ type: "text", text: String((msg.params.arguments || {}).text || "") }] };
      } else {
        result = { content: [{ type: "text", text: "unknown tool" }], isError: true };
      }
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
