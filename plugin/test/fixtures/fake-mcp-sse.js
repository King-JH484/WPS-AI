// plugin/test/fixtures/fake-mcp-sse.js
// 起一个最小 HTTP+SSE MCP server，返回 { server, url }，测试完 server.close()。
const http = require("http");

function startFakeSseServer(opts = {}) {
  let sseRes = null;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "Cache-Control": "no-cache" });
      sseRes = res;
      if (!opts.noEndpoint) {
        // 告诉客户端往哪 POST
        if (opts.badEndpoint) {
          res.write("event: endpoint\ndata: http://127.0.0.1:1/messages\n\n");
        } else {
          res.write("event: endpoint\ndata: /messages\n\n");
        }
      }
      req.on("close", () => { sseRes = null; });
      return;
    }
    if (req.method === "POST" && req.url === "/messages") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        res.writeHead(202); res.end(); // 响应从 SSE 回
        if (msg.method === "notifications/initialized") return;
        let result;
        if (msg.method === "initialize") result = { protocolVersion: "2024-11-05", serverInfo: { name: "fake-sse", version: "1.0" }, capabilities: {} };
        else if (msg.method === "tools/list") result = { tools: [{ name: "ping", description: "pong", inputSchema: { type: "object", properties: {} } }] };
        else if (msg.method === "tools/call") result = { content: [{ type: "text", text: "pong" }] };
        else result = null;
        if (sseRes) sseRes.write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n\n");
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}/sse` });
    });
  });
}
module.exports = { startFakeSseServer };
