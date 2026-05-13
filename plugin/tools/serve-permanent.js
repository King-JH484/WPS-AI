#!/usr/bin/env node
/**
 * 永久安装时的常驻服务（无外部依赖，纯 stdlib）。
 *
 * 端口 3889：静态文件服务，路由：
 *   /wps/*  → <root>/plugin-wps/*
 *   /et/*   → <root>/plugin-et/*
 *   /wpp/*  → <root>/plugin-wpp/*
 *   /pdf/*  → <root>/plugin-pdf/*
 *
 * 端口 3890：CORS 代理 + /upload-image。直接由本进程 spawn proxy-server.js 子进程。
 *
 * 用法：
 *   node serve-permanent.js              # root = 此脚本所在目录的 ..
 *   node serve-permanent.js --root <dir> # 显式指定根目录（应包含 plugin-wps/-et/-wpp/-pdf）
 *
 * 退出：Ctrl-C 或 SIGTERM。子代理也会随之退出。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");

const STATIC_PORT = Number(process.env.LINGXI_STATIC_PORT) || 3889;
const HOST_PREFIXES = new Set(["wps", "et", "wpp", "pdf"]);

function parseArgs() {
  const args = process.argv.slice(2);
  let root = path.resolve(__dirname, "..");
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      root = path.resolve(args[i + 1]);
      i += 1;
    }
  }
  return { root };
}

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
  ".map": "application/json; charset=utf-8"
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function safeJoin(rootDir, relPath) {
  // 防止 path traversal：解析后必须仍以 rootDir 为前缀
  const resolved = path.resolve(rootDir, relPath);
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) return null;
  return resolved;
}

function logAccess(req, status, extra) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const ua = String(req.headers["user-agent"] || "-").slice(0, 80);
  const tail = extra ? ` ${extra}` : "";
  console.log(`[serve] ${ts} ${req.method} ${req.url} → ${status}${tail} ua="${ua}"`);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err) {
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Not Found: ${req.url}`);
      logAccess(req, 404, `missing=${filePath}`);
      return;
    }
    if (st.isDirectory()) {
      // 目录：尝试 index.html
      const indexPath = path.join(filePath, "index.html");
      fs.stat(indexPath, (e2, s2) => {
        if (e2 || !s2.isFile()) {
          setCors(res);
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Directory listing forbidden");
        } else {
          serveFile(req, res, indexPath);
        }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ctype = MIME[ext] || "application/octet-stream";
    setCors(res);
    // 严格禁止 WebView 缓存——Mac WPS WKWebView 的资源校验对老缓存敏感，
    // 一旦插件文件更新就会报 "Main resource content verification failed"
    res.writeHead(200, {
      "Content-Type": ctype,
      "Content-Length": st.size,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Last-Modified": st.mtime.toUTCString()
    });
    logAccess(req, 200, `bytes=${st.size}`);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function start({ root }) {
  const variantDirs = {
    wps: path.join(root, "plugin-wps"),
    et: path.join(root, "plugin-et"),
    wpp: path.join(root, "plugin-wpp"),
    pdf: path.join(root, "plugin-pdf")
  };

  for (const [host, dir] of Object.entries(variantDirs)) {
    if (!fs.existsSync(dir)) {
      console.error(`[serve] ⚠️  缺少 ${dir}（${host} 变体目录）。请先运行 build-variants.js。`);
    }
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
    let pathname = decodeURIComponent(parsed.pathname || "/");

    // 健康检查
    if (pathname === "/health" || pathname === "/_health") {
      setCors(res);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, hosts: Object.keys(variantDirs) }));
      return;
    }

    // /wps/, /et/, /wpp/, /pdf/ 前缀路由
    const m = /^\/(wps|et|wpp|pdf)(\/.*)?$/.exec(pathname);
    if (!m) {
      setCors(res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("可用前缀: /wps/, /et/, /wpp/, /pdf/, /health");
      logAccess(req, 404, "unknown-prefix");
      return;
    }
    const host = m[1];
    let rel = m[2] || "/";
    if (rel === "/" || rel === "") rel = "/index.html";

    const baseDir = variantDirs[host];
    const target = safeJoin(baseDir, rel.replace(/^\//, ""));
    if (!target) {
      setCors(res);
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad path");
      return;
    }

    serveFile(req, res, target);
  });

  server.listen(STATIC_PORT, "127.0.0.1", () => {
    console.log(`[serve] 静态服务启动: http://127.0.0.1:${STATIC_PORT}`);
    console.log(`[serve]   /wps/  → ${variantDirs.wps}`);
    console.log(`[serve]   /et/   → ${variantDirs.et}`);
    console.log(`[serve]   /wpp/  → ${variantDirs.wpp}`);
    console.log(`[serve]   /pdf/  → ${variantDirs.pdf}`);
  });

  // 找一份 proxy-server.js（变体目录里都有）
  const proxyCandidates = [
    path.join(variantDirs.wps, "tools", "proxy-server.js"),
    path.join(variantDirs.et, "tools", "proxy-server.js"),
    path.join(variantDirs.wpp, "tools", "proxy-server.js"),
    path.join(__dirname, "proxy-server.js")
  ];
  const proxyScript = proxyCandidates.find((p) => fs.existsSync(p));
  if (!proxyScript) {
    console.error("[serve] 找不到 proxy-server.js，AI 调用和图表会失败");
    return;
  }

  const proxy = spawn(process.execPath, [proxyScript], {
    cwd: path.dirname(proxyScript),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const wireProxy = (stream, target) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) target.write(`[proxy] ${line}\n`);
    });
  };
  wireProxy(proxy.stdout, process.stdout);
  wireProxy(proxy.stderr, process.stderr);
  proxy.on("exit", (code, signal) => {
    console.error(`[serve] proxy 进程退出 code=${code} signal=${signal}`);
  });

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[serve] 关闭中（${reason}）...`);
    try { server.close(); } catch (e) {}
    if (proxy && !proxy.killed) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(proxy.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
        } else {
          proxy.kill("SIGTERM");
        }
      } catch (e) { /* ignore */ }
    }
    setTimeout(() => process.exit(0), 800);
  };
  process.on("SIGINT", () => shutdown("Ctrl-C"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start(parseArgs());
