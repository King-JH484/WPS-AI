#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const root = path.resolve(arg("--root", path.join(require("os").tmpdir(), "anthony-ai-storage-cleanup")));
const port = Number(arg("--port", "3889")) || 3889;
const hosts = new Set(["wps", "et", "wpp", "pdf"]);

function safeFile(host, rel) {
  const base = path.join(root, `plugin-${host}`);
  const target = path.resolve(base, rel || "index.html");
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname); }
  catch (_) { res.writeHead(400); res.end("Bad URL"); return; }
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, mode: "storage-cleanup", root, port }));
    return;
  }
  const match = /^\/(wps|et|wpp|pdf)\/?(.*)$/.exec(pathname);
  if (!match || !hosts.has(match[1])) { res.writeHead(404); res.end("Not Found"); return; }
  const file = safeFile(match[1], match[2] || "index.html");
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("Not Found"); return; }
  const ext = path.extname(file).toLowerCase();
  const type = ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".js" ? "application/javascript; charset=utf-8"
      : ext === ".json" ? "application/json; charset=utf-8"
        : ext === ".xml" ? "application/xml; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store, no-cache, must-revalidate" });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[cleanup-server] http://127.0.0.1:${port}/health root=${root}`);
});
server.on("error", (error) => {
  console.error(`[cleanup-server] ${error.code || "ERR"}: ${error.message}`);
  process.exit(1);
});
