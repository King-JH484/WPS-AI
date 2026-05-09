/**
 * 本地 CORS 代理服务器
 *
 * WPS 加载项的 WebView 遵循浏览器 CORS 策略，而 chatgpt.com/backend-api/*
 * 和 api.openai.com/v1/* 均不允许前端跨域请求。此代理在本地转发请求并注入
 * CORS 响应头，使插件能正常调用远程 API。
 *
 * 路由映射：
 *   /codex/*  → https://chatgpt.com/backend-api/codex/*
 *   /openai/* → https://api.openai.com/v1/*
 *
 * 启动：node tools/proxy-server.js
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

// 生成图保存目录：os.tmpdir()/lingxi-ai-render/，启动时确保存在
const RENDER_DIR = path.join(os.tmpdir(), "lingxi-ai-render");
try { fs.mkdirSync(RENDER_DIR, { recursive: true }); } catch (e) { /* ignore */ }

const PROXY_PORT = Number(process.env.PROXY_PORT) || 3890;

// NOTE: 路由前缀到远程目标的映射，按匹配优先级排列
const ROUTE_MAP = [
  { prefix: "/codex/", target: "https://chatgpt.com/backend-api/codex/" },
  { prefix: "/openai/", target: "https://api.openai.com/v1/" }
];

// NOTE: 允许透传到远程 API 的请求头，其余由代理过滤
const PASSTHROUGH_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "client_version",
  "user-agent",
  "x-api-key",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-beta"
]);

/**
 * 为响应注入 CORS 头，允许 WPS WebView 的跨域请求
 */
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, chatgpt-account-id, OpenAI-Beta, originator, client_version, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta"
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, X-Request-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * 根据请求路径匹配路由，返回远程目标 URL
 * @param {string} pathname - 请求路径
 * @param {string} search - 查询字符串（含 ? 前缀）
 */
function resolveTarget(pathname, search) {
  // 通用转发：/forward/<urlencoded-base>/<rest> → <decoded-base>/<rest>
  // 用于 OpenAI 兼容端点和 Anthropic Claude 自定义 baseURL。
  const FORWARD_PREFIX = "/forward/";
  if (pathname.startsWith(FORWARD_PREFIX)) {
    const tail = pathname.slice(FORWARD_PREFIX.length);
    const slashIndex = tail.indexOf("/");
    const encodedBase = slashIndex === -1 ? tail : tail.slice(0, slashIndex);
    const rest = slashIndex === -1 ? "" : tail.slice(slashIndex);
    let decodedBase;
    try {
      decodedBase = decodeURIComponent(encodedBase);
    } catch (error) {
      return null;
    }
    if (!/^https?:\/\//i.test(decodedBase)) {
      return null;
    }
    return decodedBase.replace(/\/+$/, "") + rest + (search || "");
  }

  for (const route of ROUTE_MAP) {
    if (pathname.startsWith(route.prefix)) {
      const suffix = pathname.slice(route.prefix.length);
      return route.target + suffix + (search || "");
    }
  }
  return null;
}

/**
 * 过滤请求头，仅保留允许透传的 header
 */
function filterHeaders(rawHeaders) {
  const filtered = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (PASSTHROUGH_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * 读取请求体（用于 POST/PUT 等方法）
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 将请求转发到远程 API 并将响应流式传回客户端
 */
function proxyRequest(targetUrl, method, headers, body, clientRes) {
  const url = new URL(targetUrl);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    headers
  };

  // DEBUG: 打印发送到远端的请求头
  console.log(`[proxy] → 请求头:`, JSON.stringify(headers, null, 2));

  const transport = url.protocol === "https:" ? https : http;
  const proxyReq = transport.request(options, (proxyRes) => {
    // DEBUG: 打印远端响应状态码
    console.log(`[proxy] ← ${targetUrl} 响应: ${proxyRes.statusCode}`);

    setCorsHeaders(clientRes);

    // NOTE: 透传远程 API 的状态码和关键响应头
    clientRes.writeHead(proxyRes.statusCode, {
      "Content-Type": proxyRes.headers["content-type"] || "application/json",
      "Cache-Control": "no-cache",
      ...(proxyRes.headers["x-request-id"] && { "X-Request-Id": proxyRes.headers["x-request-id"] })
    });

    // DEBUG: 对错误响应，手动读取并记录响应体后再写入客户端
    if (proxyRes.statusCode >= 400) {
      const chunks = [];
      proxyRes.on("data", (chunk) => {
        chunks.push(chunk);
        clientRes.write(chunk);
      });
      proxyRes.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf-8").slice(0, 500);
        console.log(`[proxy] ← 错误响应体: ${bodyText}`);
        clientRes.end();
      });
    } else {
      // 流式透传响应体，支持 SSE
      proxyRes.pipe(clientRes);
    }
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] 转发请求失败: ${targetUrl}`, err.message);
    setCorsHeaders(clientRes);
    clientRes.writeHead(502, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: { message: `代理转发失败: ${err.message}` } }));
  });

  if (body && body.length > 0) {
    proxyReq.write(body);
  }

  proxyReq.end();
}

const server = http.createServer(async (req, res) => {
  const { method, url: reqUrl } = req;
  const parsedUrl = new URL(reqUrl, `http://localhost:${PROXY_PORT}`);
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search;

  // CORS 预检请求直接响应
  if (method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /upload-image —— 接收 base64 dataUrl（PNG/JPG），落到本地临时文件，返回路径
  if (pathname === "/upload-image" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const dataUrl = String(json.dataUrl || "");
      const m = /^data:(image\/(?:png|jpeg|jpg|svg\+xml));base64,(.+)$/i.exec(dataUrl);
      if (!m) {
        setCorsHeaders(res);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid dataUrl" }));
        return;
      }
      const mime = m[1].toLowerCase();
      const ext = mime.includes("svg") ? "svg" : (mime.includes("jpeg") || mime.includes("jpg")) ? "jpg" : "png";
      const buf = Buffer.from(m[2], "base64");
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filepath = path.join(RENDER_DIR, filename);
      fs.writeFileSync(filepath, buf);
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: filepath, size: buf.length }));
      console.log(`[proxy] /upload-image → ${filepath} (${buf.length} bytes)`);
    } catch (error) {
      console.error("[proxy] /upload-image 失败:", error.message);
      setCorsHeaders(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const targetUrl = resolveTarget(pathname, search);
  if (!targetUrl) {
    setCorsHeaders(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: `未知路由: ${pathname}。可用：/codex/*, /openai/*, /forward/<encoded-base>/*, /upload-image (POST)`
      }
    }));
    return;
  }

  console.log(`[proxy] ${method} ${pathname}${search || ""} → ${targetUrl}`);

  const headers = filterHeaders(req.headers);
  // NOTE: 设置正确的 Host 头，避免远程服务器拒绝请求
  const remoteUrl = new URL(targetUrl);
  headers["Host"] = remoteUrl.host;

  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : null;

  proxyRequest(targetUrl, method, headers, body, res);
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`[proxy] CORS 代理服务器已启动: http://127.0.0.1:${PROXY_PORT}`);
  console.log("[proxy] 路由映射:");
  ROUTE_MAP.forEach((route) => {
    console.log(`  ${route.prefix}* → ${route.target}*`);
  });
  console.log("  /forward/<urlencoded-base>/* → <base>/* (通用转发，用于自定义端点)");
  console.log(`  POST /upload-image → 落地图片到 ${RENDER_DIR}/<random>.png|jpg|svg`);
});
