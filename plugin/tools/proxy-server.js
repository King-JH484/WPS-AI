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
const crypto = require("crypto");
const { URL } = require("url");

// 生成图保存目录：os.tmpdir()/lingxi-ai-render/，启动时确保存在
const RENDER_DIR = path.join(os.tmpdir(), "lingxi-ai-render");
try { fs.mkdirSync(RENDER_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// 文档快照备份根目录：~/.lingxi-ai/backups/
// 每个文档独立子目录：<basename>-<hash6>/，文件名 <ISO 时间>-<ext>
const BACKUPS_ROOT = path.join(os.homedir(), ".lingxi-ai", "backups");
const MAX_BACKUPS_PER_DOC = 20;
try { fs.mkdirSync(BACKUPS_ROOT, { recursive: true }); } catch (e) { /* ignore */ }

const PROXY_PORT = Number(process.env.PROXY_PORT) || 3890;

// ===== 文档备份辅助函数 =====

function sendJson(res, code, body) {
  setCorsHeaders(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// 给文档生成稳定的备份子目录名：<safe-basename>-<6 位 hash>
// hash 取自完整路径，避免同名文件互相覆盖
function docBackupDir(docPath) {
  const base = path.basename(docPath, path.extname(docPath)).replace(/[^\w一-龥.-]/g, "_").slice(0, 40);
  const hash = crypto.createHash("md5").update(path.resolve(docPath)).digest("hex").slice(0, 6);
  return path.join(BACKUPS_ROOT, `${base}-${hash}`);
}

function ensureDocBackupDir(docPath) {
  const dir = docBackupDir(docPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 砍掉超过 maxKeep 份的旧备份；.pre-restore 这种安全备份 也参与计数但单独 GC
function gcDocBackups(dir, maxKeep) {
  try {
    const entries = fs.readdirSync(dir)
      .filter((n) => !n.includes(".pre-restore"))
      .map((n) => ({ name: n, fp: path.join(dir, n), mt: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    entries.slice(maxKeep).forEach((e) => {
      try { fs.unlinkSync(e.fp); } catch (_) {}
    });
    // .pre-restore 留最近 5 份
    const safety = fs.readdirSync(dir)
      .filter((n) => n.includes(".pre-restore"))
      .map((n) => ({ name: n, fp: path.join(dir, n), mt: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    safety.slice(5).forEach((e) => {
      try { fs.unlinkSync(e.fp); } catch (_) {}
    });
  } catch (e) { /* GC 失败不影响主流程 */ }
}

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

// ===== MCP 桥：让外部 agent（Claude Code CLI 等）通过 mcp-server.js 调用 WPS plugin 暴露的工具 =====
// 设计：
//   1. WPS plugin（浏览器侧）POST /mcp/register 上报 tool 清单；之后长轮询 GET /mcp/poll 等任务。
//   2. 外部 MCP bridge（mcp-server.js stdio）POST /mcp/call 投递 call，挂着 res 等结果。
//   3. plugin /mcp/poll 拿到 call → 执行 → POST /mcp/result，proxy 把结果回写给挂着的外部 res。
//
// 仅本机 IPC，不出网；plugin 不在线时外部 /mcp/call 收到 503。
const mcpState = {
  tools: [],                         // 最近一次 plugin 注册的工具清单
  pluginRegisteredAt: 0,             // plugin 上线时间戳（ms）
  pendingCalls: new Map(),           // call_id → { res, ts }，外部投递后挂着等结果
  inboxForPlugin: [],                // plugin /poll 时按 FIFO 出队的 call
  pollerHolds: []                    // plugin 长轮询的 res 列队（一次取一个）
};
const MCP_CALL_TIMEOUT_MS = 60 * 1000;       // 单次 call 等待结果超时
const MCP_POLL_TIMEOUT_MS = 25 * 1000;       // plugin 长轮询超时（< 30s 避免某些反代关连接）
const MCP_PLUGIN_STALE_MS = 60 * 1000;       // 超过这个时间没注册就认为 plugin 下线

function genCallId() {
  return "mc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function pluginAlive() {
  return Date.now() - mcpState.pluginRegisteredAt < MCP_PLUGIN_STALE_MS;
}

// 把一个 call 推给 plugin：若有等待的 poller 立即喂出去；否则塞 inbox 等下次 poll
function dispatchCallToPlugin(call) {
  if (mcpState.pollerHolds.length > 0) {
    const pollerRes = mcpState.pollerHolds.shift();
    try { sendJson(pollerRes, 200, { ok: true, call }); } catch (e) {}
  } else {
    mcpState.inboxForPlugin.push(call);
  }
}

// 周期性 GC：超时的 pendingCalls / 长轮询 / inbox
setInterval(() => {
  const now = Date.now();
  // pending calls 超时
  mcpState.pendingCalls.forEach((entry, id) => {
    if (now - entry.ts > MCP_CALL_TIMEOUT_MS) {
      try { sendJson(entry.res, 504, { ok: false, error: "plugin 未在 60s 内返回结果" }); } catch (e) {}
      mcpState.pendingCalls.delete(id);
    }
  });
  // 长轮询超时：返回空（plugin 收到 204 会立刻发新一轮）
  while (mcpState.pollerHolds.length > 0) {
    const r = mcpState.pollerHolds[0];
    if (now - (r._mcpHoldTs || 0) > MCP_POLL_TIMEOUT_MS) {
      mcpState.pollerHolds.shift();
      try { sendJson(r, 200, { ok: true, call: null }); } catch (e) {}
    } else {
      break; // FIFO，前面没超时后面也没
    }
  }
}, 2000).unref?.();

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

  // ===== MCP 桥路由 =====

  // POST /mcp/register —— WPS plugin 上报最新工具清单（含 description / inputSchema）
  if (pathname === "/mcp/register" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      if (!Array.isArray(json.tools)) {
        sendJson(res, 400, { ok: false, error: "tools 必须是数组" });
        return;
      }
      mcpState.tools = json.tools;
      mcpState.pluginRegisteredAt = Date.now();
      console.log(`[mcp] plugin 注册 ${json.tools.length} 个工具`);
      sendJson(res, 200, { ok: true, count: json.tools.length });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /mcp/poll —— plugin 长轮询。有任务立即返回，没任务挂着直到 25s 超时（GC 兜底）
  if (pathname === "/mcp/poll" && method === "GET") {
    if (mcpState.inboxForPlugin.length > 0) {
      const call = mcpState.inboxForPlugin.shift();
      sendJson(res, 200, { ok: true, call });
    } else {
      res._mcpHoldTs = Date.now();
      mcpState.pollerHolds.push(res);
    }
    return;
  }

  // POST /mcp/result —— plugin 完成 call 后回传结果
  if (pathname === "/mcp/result" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const callId = String(json.callId || "");
      const entry = mcpState.pendingCalls.get(callId);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: "未知 callId（可能已超时清理）" });
        return;
      }
      mcpState.pendingCalls.delete(callId);
      try {
        sendJson(entry.res, 200, {
          ok: !!json.ok,
          value: json.value,
          error: json.error || null
        });
      } catch (e) {}
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /mcp/tools —— 外部 MCP bridge 拉取工具清单。plugin 离线时返回 503
  if (pathname === "/mcp/tools" && method === "GET") {
    if (!pluginAlive()) {
      sendJson(res, 503, { ok: false, error: "WPS plugin 未连接（请确认 WPS 已打开且插件开启了 MCP 服务）" });
      return;
    }
    sendJson(res, 200, { ok: true, tools: mcpState.tools });
    return;
  }

  // POST /mcp/call —— 外部 MCP bridge 投递工具调用，挂着等 plugin 返回结果
  if (pathname === "/mcp/call" && method === "POST") {
    if (!pluginAlive()) {
      sendJson(res, 503, { ok: false, error: "WPS plugin 未连接" });
      return;
    }
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const name = String(json.name || "");
      const args = json.args || {};
      if (!name) {
        sendJson(res, 400, { ok: false, error: "name 必填" });
        return;
      }
      const callId = genCallId();
      mcpState.pendingCalls.set(callId, { res, ts: Date.now() });
      dispatchCallToPlugin({ callId, name, args });
      // 不在这里写 res；等 /mcp/result 来回写或 GC 超时
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /mcp/status —— UI / bridge 都能查：plugin 是否在线 + 工具个数
  if (pathname === "/mcp/status" && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      pluginAlive: pluginAlive(),
      toolCount: mcpState.tools.length,
      registeredAt: mcpState.pluginRegisteredAt || null
    });
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
      // open + write + fsync + close, 确保数据真正落盘后再返回路径给 WPS。
      // 之前 writeFileSync 偶发未刷新到磁盘, WPS AddPicture 拿到路径时读到 0 bytes 或空内容,
      // shape 框架建好了但里面没图. 加 fsync 排除这条 race.
      const fd = fs.openSync(filepath, "w");
      try {
        fs.writeSync(fd, buf, 0, buf.length, 0);
        try { fs.fsyncSync(fd); } catch (e) { /* fsync 失败不致命 */ }
      } finally {
        fs.closeSync(fd);
      }
      // verify: 读回 stat 确保大小正确
      const st = fs.statSync(filepath);
      if (st.size !== buf.length) {
        console.warn(`[proxy] /upload-image 大小不匹配: wrote=${buf.length} stat=${st.size}`);
      }
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: filepath, size: buf.length, verifiedSize: st.size }));
      console.log(`[proxy] /upload-image → ${filepath} (${buf.length} bytes, stat=${st.size})`);
    } catch (error) {
      console.error("[proxy] /upload-image 失败:", error.message);
      setCorsHeaders(res);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ===== 热更新桥（POST /update/manifest, /update/download, /update/apply）=====
  // plugin 侧的 updater.js 调这些端点拿 manifest / 下载 zip / 解压覆盖.
  // 走 proxy 是因为:
  //   1) 绕 CORS (OSS 不允许 file:// 同源)
  //   2) 真正落地需要 fs/path/child_process, plugin WebView 没有
  if (pathname === "/update/manifest" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      if (!url) { sendJson(res, 400, { ok: false, error: "url 必填" }); return; }
      // 简单 GET 拉 manifest. 跟 fetch-remote-image 用相同的下载封装
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const text = await new Promise((resolve, reject) => {
        const r = lib.get(url, { timeout: 15000 }, (resp) => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) { reject(new Error(`HTTP ${resp.statusCode}`)); return; }
          const chunks = [];
          resp.on("data", (c) => chunks.push(c));
          resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("timeout")); });
      });
      let manifest;
      try { manifest = JSON.parse(text); }
      catch (e) { sendJson(res, 500, { ok: false, error: "manifest 不是合法 JSON: " + e.message }); return; }
      sendJson(res, 200, { ok: true, manifest, fetchedAt: Date.now() });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /update/download —— 下载 plugin.zip 到本地临时目录
  if (pathname === "/update/download" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      const expectedSize = Number(json.expectedSize) || 0;
      if (!url) { sendJson(res, 400, { ok: false, error: "url 必填" }); return; }
      // 下载到 ~/.lingxi-ai/updates/<ts>.zip
      const UPDATE_DIR = path.join(os.homedir(), ".lingxi-ai", "updates");
      fs.mkdirSync(UPDATE_DIR, { recursive: true });
      const zipPath = path.join(UPDATE_DIR, `plugin-${Date.now()}.zip`);
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(zipPath);
        const r = lib.get(url, { timeout: 120 * 1000 }, (resp) => {
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            try { ws.close(); fs.unlinkSync(zipPath); } catch (e) {}
            reject(new Error(`HTTP ${resp.statusCode}`));
            return;
          }
          resp.pipe(ws);
          ws.on("finish", () => ws.close(resolve));
          ws.on("error", reject);
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("download timeout")); });
      });
      const st = fs.statSync(zipPath);
      if (expectedSize > 0 && st.size !== expectedSize) {
        // 大小不匹配警告但不失败（manifest 元数据可能不准）
        console.warn(`[proxy] /update/download 大小不匹配: expected=${expectedSize} actual=${st.size}`);
      }
      console.log(`[proxy] /update/download → ${zipPath} (${st.size} bytes)`);
      sendJson(res, 200, { ok: true, zipPath, size: st.size });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /update/apply —— 解压 plugin.zip 覆盖到 plugin/ 目录
  // 用 child_process 调系统自带 tar / PowerShell 解压，避免依赖外部 npm 包
  if (pathname === "/update/apply" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const zipPath = String(json.zipPath || "").trim();
      if (!zipPath || !fs.existsSync(zipPath)) {
        sendJson(res, 400, { ok: false, error: "zipPath 不存在: " + zipPath }); return;
      }
      // 目标目录 = 当前 plugin 根（proxy-server.js 在 plugin/tools/, 上一级即 plugin/）
      const pluginRoot = path.resolve(__dirname, "..");
      console.log(`[proxy] /update/apply 解压 ${zipPath} → ${pluginRoot}`);
      // 先解压到临时 sibling 目录，验证有 manifest.json 后再 rsync 过去；失败可回滚
      const tmpExtract = path.join(os.tmpdir(), `lingxi-update-${Date.now()}`);
      fs.mkdirSync(tmpExtract, { recursive: true });
      const { spawnSync } = require("child_process");
      let extractResult;
      if (process.platform === "win32") {
        // PowerShell 5+ 自带 Expand-Archive
        extractResult = spawnSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpExtract.replace(/'/g, "''")}' -Force`
        ], { encoding: "utf8" });
      } else {
        // mac / linux 自带 unzip
        extractResult = spawnSync("unzip", ["-o", zipPath, "-d", tmpExtract], { encoding: "utf8" });
      }
      if (extractResult.status !== 0) {
        try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
        sendJson(res, 500, { ok: false, error: `解压失败: ${extractResult.stderr || extractResult.stdout || "unknown"}` });
        return;
      }
      // 解压后的 zip 内层可能直接是 plugin 文件，也可能套了一层 plugin/ 目录
      let sourceRoot = tmpExtract;
      const entries = fs.readdirSync(tmpExtract);
      if (entries.length === 1 && fs.statSync(path.join(tmpExtract, entries[0])).isDirectory()) {
        const inner = path.join(tmpExtract, entries[0]);
        if (fs.existsSync(path.join(inner, "manifest.json")) || fs.existsSync(path.join(inner, "taskpane.html"))) {
          sourceRoot = inner;
        }
      }
      // 不允许覆盖 oss config / settings 等敏感本地文件——zip 不该包含它们，但加白名单兜底
      const KEEP_LOCAL = new Set([".git", "node_modules", "runtime"]);
      let filesReplaced = 0;
      function copyRecursive(src, dst) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          for (const name of fs.readdirSync(src)) {
            if (KEEP_LOCAL.has(name)) continue;
            copyRecursive(path.join(src, name), path.join(dst, name));
          }
        } else {
          fs.copyFileSync(src, dst);
          filesReplaced += 1;
        }
      }
      copyRecursive(sourceRoot, pluginRoot);
      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
      try { fs.unlinkSync(zipPath); } catch (e) {}
      console.log(`[proxy] /update/apply 完成，覆盖 ${filesReplaced} 个文件`);
      sendJson(res, 200, {
        ok: true,
        filesReplaced,
        message: `更新已写入 ${pluginRoot}（${filesReplaced} 个文件）。请重启 WPS 让新版生效。`
      });
    } catch (e) {
      console.error("[proxy] /update/apply 失败:", e);
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /fetch-remote-image —— 服务端下载远程图片 (绕开 WebView 的 CORS) 返回 base64 dataUrl。
  // 给 html2canvas 用：HTML 里 <img src="https://files.toapis.com/..."> 之类远程图片直接 fetch
  // 会被 CORS 拦截 / canvas 标污 → 截不出图。先调这个端点把图下成 dataUrl, 重写 src 再喂给 html2canvas。
  // 入参: { url, ttlMs? }   出参: { ok, dataUrl, contentType, size, cached }
  // 缓存策略: 同 url 在内存 + 磁盘 (RENDER_DIR/remote-cache/) 缓存 6h, 避免重复下载
  const REMOTE_IMAGE_CACHE_DIR = path.join(RENDER_DIR, "remote-cache");
  try { fs.mkdirSync(REMOTE_IMAGE_CACHE_DIR, { recursive: true }); } catch (e) {}
  const _remoteImageMemCache = new Map(); // url → { dataUrl, contentType, size, ts }
  const REMOTE_IMAGE_TTL_MS_DEFAULT = 6 * 60 * 60 * 1000; // 6h
  function urlHash(u) {
    return crypto.createHash("md5").update(u).digest("hex").slice(0, 16);
  }
  function tryReadDiskCache(u) {
    try {
      const hash = urlHash(u);
      const metaPath = path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".json");
      if (!fs.existsSync(metaPath)) return null;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (!meta?.ts || Date.now() - meta.ts > REMOTE_IMAGE_TTL_MS_DEFAULT) return null;
      const binPath = path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".bin");
      if (!fs.existsSync(binPath)) return null;
      const buf = fs.readFileSync(binPath);
      return { dataUrl: `data:${meta.contentType};base64,${buf.toString("base64")}`, contentType: meta.contentType, size: buf.length, ts: meta.ts };
    } catch (e) { return null; }
  }
  function writeDiskCache(u, buf, contentType) {
    try {
      const hash = urlHash(u);
      fs.writeFileSync(path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".bin"), buf);
      fs.writeFileSync(path.join(REMOTE_IMAGE_CACHE_DIR, hash + ".json"), JSON.stringify({ url: u, contentType, ts: Date.now() }));
    } catch (e) { /* 缓存写失败不致命 */ }
  }
  if (pathname === "/fetch-remote-image" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const url = String(json.url || "").trim();
      if (!url) { sendJson(res, 400, { error: "url 必填" }); return; }
      if (!/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: "仅支持 http/https URL" }); return; }
      // 1) 内存命中
      let hit = _remoteImageMemCache.get(url);
      if (hit && Date.now() - hit.ts <= REMOTE_IMAGE_TTL_MS_DEFAULT) {
        sendJson(res, 200, { ok: true, dataUrl: hit.dataUrl, contentType: hit.contentType, size: hit.size, cached: "mem" });
        return;
      }
      // 2) 磁盘命中
      hit = tryReadDiskCache(url);
      if (hit) {
        _remoteImageMemCache.set(url, hit);
        sendJson(res, 200, { ok: true, dataUrl: hit.dataUrl, contentType: hit.contentType, size: hit.size, cached: "disk" });
        return;
      }
      // 3) 现拉
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const buf = await new Promise((resolve, reject) => {
        const r = lib.get(url, { timeout: 20000 }, (resp) => {
          // 跟随 3xx 跳一次（不递归）
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            const next = new URL(resp.headers.location, url).toString();
            const nlib = next.startsWith("https:") ? https : http;
            const r2 = nlib.get(next, { timeout: 20000 }, (resp2) => {
              if (resp2.statusCode < 200 || resp2.statusCode >= 300) {
                reject(new Error(`重定向后 HTTP ${resp2.statusCode}`));
                return;
              }
              const chunks = [];
              resp2.on("data", (c) => chunks.push(c));
              resp2.on("end", () => resolve({ buf: Buffer.concat(chunks), contentType: resp2.headers["content-type"] || "image/png" }));
            });
            r2.on("error", reject);
            return;
          }
          if (resp.statusCode < 200 || resp.statusCode >= 300) {
            reject(new Error(`HTTP ${resp.statusCode}`));
            return;
          }
          const chunks = [];
          resp.on("data", (c) => chunks.push(c));
          resp.on("end", () => resolve({ buf: Buffer.concat(chunks), contentType: resp.headers["content-type"] || "image/png" }));
        });
        r.on("error", reject);
        r.on("timeout", () => { try { r.destroy(); } catch (e) {} reject(new Error("timeout")); });
      });
      const contentType = String(buf.contentType || "image/png").split(";")[0].trim();
      const dataUrl = `data:${contentType};base64,${buf.buf.toString("base64")}`;
      _remoteImageMemCache.set(url, { dataUrl, contentType, size: buf.buf.length, ts: Date.now() });
      writeDiskCache(url, buf.buf, contentType);
      console.log(`[proxy] /fetch-remote-image OK ${url} → ${buf.buf.length} bytes (${contentType})`);
      sendJson(res, 200, { ok: true, dataUrl, contentType, size: buf.buf.length, cached: "fresh" });
    } catch (e) {
      console.error(`[proxy] /fetch-remote-image 失败: ${e.message}`);
      sendJson(res, 502, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // POST /load-local-file —— 读取本机文件返回 base64，用于把活动 PDF 当附件喂给大模型
  // 入参：{ path: "...绝对路径..." }
  // 出参：{ ok, base64, name, size, mediaType }
  // 限制：只允许常见可附件类型 + 大小 ≤ 32MB（Anthropic 文档单文件上限）
  if (pathname === "/load-local-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) { sendJson(res, 400, { error: "path 必填" }); return; }
      if (!fs.existsSync(filePath)) { sendJson(res, 404, { error: "文件不存在: " + filePath }); return; }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) { sendJson(res, 400, { error: "路径不是文件" }); return; }
      const MAX_SIZE = 32 * 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        sendJson(res, 413, { error: `文件太大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 32MB` });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const MIME_MAP = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp",
        ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json"
      };
      const mediaType = MIME_MAP[ext];
      if (!mediaType) {
        sendJson(res, 415, { error: `不支持的文件类型：${ext}` });
        return;
      }
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString("base64");
      const name = path.basename(filePath);
      console.log(`[proxy] /load-local-file ${filePath} → ${stat.size} bytes, ${mediaType}`);
      sendJson(res, 200, { ok: true, base64, name, size: stat.size, mediaType });
    } catch (error) {
      console.error("[proxy] /load-local-file 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /openai-file-upload —— 把 base64 文件上传到 OpenAI Files API，返回 file_id
  // 入参：{ baseUrl, apiKey, base64, filename, purpose }
  // 出参：透传 OpenAI 响应（{ id, object, ... }）
  // OpenAI chat completion 引用 PDF 需要先走 Files API 拿 file_id（不能直接 inline base64）
  if (pathname === "/openai-file-upload" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const baseUrl = String(json.baseUrl || "").replace(/\/+$/, "");
      const apiKey = String(json.apiKey || "");
      const base64 = String(json.base64 || "");
      const filename = String(json.filename || "file.pdf");
      const purpose = String(json.purpose || "user_data");
      if (!baseUrl || !apiKey || !base64) {
        sendJson(res, 400, { error: "baseUrl / apiKey / base64 必填" });
        return;
      }
      const buf = Buffer.from(base64, "base64");
      // multipart/form-data 手搓（不引第三方依赖）
      const boundary = "----LingxiBoundary" + crypto.randomBytes(8).toString("hex");
      const guessMime = filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${guessMime}\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      const payload = Buffer.concat([head, buf, tail]);

      const targetUrl = new URL(baseUrl + "/files");
      const transport = targetUrl.protocol === "https:" ? https : http;
      const upstream = transport.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.length
        }
      }, (uRes) => {
        const chunks = [];
        uRes.on("data", (c) => chunks.push(c));
        uRes.on("end", () => {
          setCorsHeaders(res);
          res.writeHead(uRes.statusCode, { "Content-Type": "application/json" });
          res.end(Buffer.concat(chunks).toString("utf8"));
        });
      });
      upstream.on("error", (err) => {
        console.error("[proxy] /openai-file-upload upstream error:", err.message);
        sendJson(res, 502, { error: err.message });
      });
      upstream.write(payload);
      upstream.end();
    } catch (error) {
      console.error("[proxy] /openai-file-upload 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /doc-snapshot —— 备份指定文档到 backups 目录，返回 backupPath
  if (pathname === "/doc-snapshot" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const docPath = String(json.docPath || "");
      if (!docPath || !fs.existsSync(docPath)) {
        sendJson(res, 400, { error: "docPath 不存在" });
        return;
      }
      const dir = ensureDocBackupDir(docPath);
      const ext = path.extname(docPath) || ".bin";
      const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
      const backupPath = path.join(dir, `${ts}${ext}`);
      fs.copyFileSync(docPath, backupPath);
      const stat = fs.statSync(backupPath);
      gcDocBackups(dir, MAX_BACKUPS_PER_DOC);
      console.log(`[proxy] /doc-snapshot ${docPath} → ${backupPath} (${stat.size} bytes)`);
      sendJson(res, 200, {
        ok: true,
        backupPath,
        size: stat.size,
        timestamp: stat.mtimeMs
      });
    } catch (error) {
      console.error("[proxy] /doc-snapshot 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // POST /doc-restore —— 把备份文件覆盖回原文档路径
  // 关键坑：WPS Excel/Word 关文档后 Windows 释放文件句柄有滞后,前端的 doc.Close()
  // 返回了不代表 OS 锁已释放,直接 copyFileSync 会 EPERM。这里加退避重试。
  // 另外 WeChat 下载的 xwechat_files 目录里的文件可能被 WeChat 自身长期持锁,
  // 重试还失败时给出明确指引而不是堆 Node stack。
  if (pathname === "/doc-restore" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const backupPath = String(json.backupPath || "");
      const targetPath = String(json.targetPath || "");
      if (!backupPath || !fs.existsSync(backupPath)) {
        sendJson(res, 400, { error: "backupPath 不存在" });
        return;
      }
      if (!targetPath) {
        sendJson(res, 400, { error: "targetPath 必填" });
        return;
      }
      const resolvedBackup = path.resolve(backupPath);
      if (!resolvedBackup.startsWith(path.resolve(BACKUPS_ROOT) + path.sep)) {
        sendJson(res, 403, { error: "backupPath 必须位于 backups 根目录下" });
        return;
      }

      // 先把当前文件做一份 .pre-restore 备份（也可能 EPERM，吞掉但记日志）
      if (fs.existsSync(targetPath)) {
        try {
          const dir = ensureDocBackupDir(targetPath);
          const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
          const safetyPath = path.join(dir, `${ts}.pre-restore${path.extname(targetPath)}`);
          fs.copyFileSync(targetPath, safetyPath);
        } catch (e) {
          console.warn(`[proxy] /doc-restore .pre-restore 备份失败（不阻断）:`, e.code, e.message);
        }
      }

      // 退避重试：EPERM / EBUSY / EACCES 大概率是文件句柄还没释放
      const delays = [0, 150, 300, 500, 800, 1200];
      let lastErr = null;
      for (let i = 0; i < delays.length; i += 1) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        try {
          fs.copyFileSync(backupPath, targetPath);
          console.log(`[proxy] /doc-restore ${backupPath} → ${targetPath}${i > 0 ? ` (第 ${i + 1} 次成功)` : ""}`);
          sendJson(res, 200, { ok: true, retries: i });
          return;
        } catch (e) {
          lastErr = e;
          if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) break;
          console.warn(`[proxy] /doc-restore 第 ${i + 1} 次 ${e.code}，重试`);
        }
      }
      const isLikelyLocked = lastErr && ["EPERM", "EBUSY", "EACCES"].includes(lastErr.code);
      const hint = isLikelyLocked
        ? `文件仍被占用。请先在 WPS 完全关闭这份文档（关掉所有打开它的窗口）再恢复；如果文件位于「微信下载」目录（xwechat_files），需要先在微信里关闭对应聊天窗口的预览。`
        : (lastErr?.message || "未知错误");
      console.error(`[proxy] /doc-restore 最终失败:`, lastErr?.code, lastErr?.message);
      sendJson(res, 500, { error: hint, code: lastErr?.code || "" });
    } catch (error) {
      console.error("[proxy] /doc-restore 失败:", error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // GET /doc-backups?docPath=... —— 列出某文档的备份
  if (pathname === "/doc-backups" && method === "GET") {
    try {
      const docPath = parsedUrl.searchParams.get("docPath") || "";
      if (!docPath) { sendJson(res, 400, { error: "docPath 必填" }); return; }
      const dir = docBackupDir(docPath);
      const items = fs.existsSync(dir)
        ? fs.readdirSync(dir)
            .filter((n) => !n.endsWith(".pre-restore") && !n.includes(".pre-restore."))
            .map((n) => {
              const fp = path.join(dir, n);
              const st = fs.statSync(fp);
              return { backupPath: fp, name: n, size: st.size, timestamp: st.mtimeMs };
            })
            .sort((a, b) => b.timestamp - a.timestamp)
        : [];
      sendJson(res, 200, { ok: true, items });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  const targetUrl = resolveTarget(pathname, search);
  if (!targetUrl) {
    setCorsHeaders(res);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: `未知路由: ${pathname}。可用：/codex/*, /openai/*, /forward/<encoded-base>/*, /upload-image (POST), /doc-snapshot (POST), /doc-restore (POST), /doc-backups (GET)`
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
  console.log(`  POST /fetch-remote-image → 服务端代下 http(s) 图片 (绕开 CORS) 返回 dataUrl, 6h 缓存`);
  console.log(`  POST /load-local-file → 读取本机文件 base64（≤32MB，PDF/img/txt 白名单）`);
  console.log(`  POST /openai-file-upload → 上传 base64 到 OpenAI Files API 拿 file_id`);
  console.log(`  POST /doc-snapshot → 备份当前文档到 ${BACKUPS_ROOT}/<doc>/<ts>.<ext>`);
  console.log("  POST /doc-restore → 把备份覆盖回原路径（自动留 .pre-restore 兜底）");
  console.log("  GET  /doc-backups?docPath=... → 列出某文档的所有备份");
  console.log("  --- MCP 桥 ---");
  console.log("  POST /mcp/register → WPS plugin 上报工具清单");
  console.log("  GET  /mcp/poll → plugin 长轮询拿任务（25s 超时）");
  console.log("  POST /mcp/result → plugin 返回 call 结果");
  console.log("  GET  /mcp/tools → 外部 MCP bridge 拿工具清单");
  console.log("  POST /mcp/call → 外部 MCP bridge 投递工具调用");
  console.log("  GET  /mcp/status → 查询 plugin 在线 + 工具数");
});
