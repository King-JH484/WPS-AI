#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const root = process.cwd();
const port = Number(process.env.WPSJS_PORT || process.env.STATIC_PORT) || 3889;
const PORT_LADDER_SIZE = Number(process.env.STATIC_PORT_LADDER_SIZE) || 20;
let resolvedPort = port;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    return null;
  }

  if (decoded === "/" || decoded === "") decoded = "/index.html";
  const resolved = path.resolve(root, decoded.replace(/^\/+/, ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function serve(req, res, filePath) {
  fs.stat(filePath, (error, stat) => {
    if (error) {
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Not Found: ${req.url}`);
      return;
    }

    if (stat.isDirectory()) {
      serve(req, res, path.join(filePath, "index.html"));
      return;
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    setCors(res);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    setCors(res);
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const parsed = url.parse(req.url || "/");
  if (parsed.pathname === "/health" || parsed.pathname === "/_health" || parsed.pathname === "/healthz") {
    setCors(res);
    res.setHeader("X-Lingxi-Service", "lingxi-ai-static/v1");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "lingxi-ai-static/v1", port: resolvedPort, root }));
    return;
  }

  const filePath = safePath(parsed.pathname || "/");
  if (!filePath) {
    setCors(res);
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad path");
    return;
  }

  serve(req, res, filePath);
});

function startListenLadder(targetPort, attemptsLeft) {
  // 同 proxy-server：listening 监听器也要清，否则递归 listen 时旧闭包会跟着 fire，
  // 把 resolvedPort 覆盖回上一轮的端口，日志/状态对不上。
  server.removeAllListeners("error");
  server.removeAllListeners("listening");
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`[static] 端口 ${targetPort} 已被占用，自动切到 ${targetPort + 1}（剩 ${attemptsLeft - 1} 次尝试）`);
      startListenLadder(targetPort + 1, attemptsLeft - 1);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`[static] 端口梯子（${port}..${port + PORT_LADDER_SIZE}）全占用，启动失败。`);
    } else {
      console.error(`[static] 启动失败：${error.message}`);
    }
    process.exit(1);
  });
  server.listen(targetPort, "127.0.0.1", () => {
    resolvedPort = targetPort;
    const switched = targetPort !== port;
    console.log(`[static] 本地插件服务已启动: http://127.0.0.1:${resolvedPort}` + (switched ? `（请求端口 ${port} 被占用，已自动切换到 ${resolvedPort}）` : ""));
    console.log(`[static] root=${root}`);
  });
}

startListenLadder(port, PORT_LADDER_SIZE);
