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
  console.log(`  POST /load-local-file → 读取本机文件 base64（≤32MB，PDF/img/txt 白名单）`);
  console.log(`  POST /openai-file-upload → 上传 base64 到 OpenAI Files API 拿 file_id`);
  console.log(`  POST /doc-snapshot → 备份当前文档到 ${BACKUPS_ROOT}/<doc>/<ts>.<ext>`);
  console.log("  POST /doc-restore → 把备份覆盖回原路径（自动留 .pre-restore 兜底）");
  console.log("  GET  /doc-backups?docPath=... → 列出某文档的所有备份");
});
