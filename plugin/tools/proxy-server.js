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
const { URL, pathToFileURL } = require("url");

// 生成图保存目录。放到用户目录下，避免 WPS/macOS 对 /var/folders 临时目录图片 AddPicture 静默失败。
const RENDER_DIR = path.join(os.homedir(), ".lingxi-ai", "render");
try { fs.mkdirSync(RENDER_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// 文档快照备份根目录：~/.lingxi-ai/backups/
// 每个文档独立子目录：<basename>-<hash6>/，文件名 <ISO 时间>-<ext>
const BACKUPS_ROOT = path.join(os.homedir(), ".lingxi-ai", "backups");
const MAX_BACKUPS_PER_DOC = 20;
try { fs.mkdirSync(BACKUPS_ROOT, { recursive: true }); } catch (e) { /* ignore */ }

const PROXY_PORT = Number(process.env.PROXY_PORT) || 3890;

// ===== 设备 SN（给灰度白名单匹配用） =====
// 进程内缓存 —— 同一次 proxy 启动只查一次系统命令。
let _deviceSnCache = null;
let _deviceSnSource = ""; // 标记 SN 是哪个来源（用于诊断）
const DEVICE_SN_FILE = path.join(os.homedir(), ".lingxi-ai", "device-sn.json");

function execSafe(cmd, args, timeoutMs = 8000) {
  const { spawnSync } = require("child_process");
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (r.error) {
      console.warn(`[device-sn] spawn ${cmd} failed:`, r.error.code || r.error.message);
      return null;
    }
    if (r.status !== 0) {
      console.warn(`[device-sn] ${cmd} exit ${r.status}:`, String(r.stderr || "").slice(0, 200));
      return null;
    }
    return String(r.stdout || "").trim();
  } catch (e) {
    console.warn(`[device-sn] ${cmd} threw:`, e.message);
    return null;
  }
}

function normalizeSn(s) {
  if (!s) return "";
  // 去掉头尾空白、首行表头（wmic 会输出 "UUID" 标题行）、各种引号
  const lines = String(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 去掉首行表头（如 "UUID" / "SerialNumber"）
  const cand = lines.length > 1 ? lines.slice(1).join(" ") : (lines[0] || "");
  return cand.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
}

async function getDeviceSn() {
  if (_deviceSnCache) return _deviceSnCache;

  // 1) 优先平台原生硬件 ID
  let sn = "";
  if (process.platform === "win32") {
    // 优先 PowerShell Get-CimInstance —— 现代 Windows（10/11）都有，且 Windows 11 22H2+ 已经把 wmic 砍了。
    // 退路：老 Windows（< 10 1809 / 没装 PowerShell）回 wmic。
    sn = normalizeSn(execSafe("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID"
    ]));
    if (sn && sn !== "0" && !/^F{8}-F{4}-F{4}-F{4}-F{12}$/i.test(sn)) {
      _deviceSnSource = "powershell-cs-uuid";
    } else {
      sn = normalizeSn(execSafe("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_BIOS).SerialNumber"
      ]));
      if (sn) _deviceSnSource = "powershell-bios-sn";
    }
    // wmic 兜底（老系统）
    if (!sn) {
      sn = normalizeSn(execSafe("wmic", ["csproduct", "get", "uuid"]));
      if (sn && sn !== "0" && !/^F{8}-F{4}-F{4}-F{4}-F{12}$/i.test(sn)) {
        _deviceSnSource = "wmic-csproduct-uuid";
      } else {
        sn = normalizeSn(execSafe("wmic", ["bios", "get", "serialnumber"]));
        if (sn) _deviceSnSource = "wmic-bios-sn";
      }
    }
  } else if (process.platform === "darwin") {
    const raw = execSafe("/bin/sh", ["-c",
      "ioreg -d2 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/{print $4}'"]);
    sn = String(raw || "").trim();
    if (sn) _deviceSnSource = "ioreg-platform-uuid";
  } else {
    // Linux：先 product_uuid（要 root，多数读不到），再 machine-id
    try { sn = fs.readFileSync("/sys/class/dmi/id/product_uuid", "utf8").trim(); _deviceSnSource = "dmi-product-uuid"; } catch (e) {}
    if (!sn) {
      try { sn = fs.readFileSync("/etc/machine-id", "utf8").trim(); _deviceSnSource = "machine-id"; } catch (e) {}
    }
  }

  // 2) 平台命令拿不到 → 用本地文件兜底（首次生成一次随机 UUID 存盘）
  if (!sn) {
    try {
      if (fs.existsSync(DEVICE_SN_FILE)) {
        const j = JSON.parse(fs.readFileSync(DEVICE_SN_FILE, "utf8"));
        if (j?.sn) { sn = j.sn; _deviceSnSource = j.source || "file-fallback"; }
      }
    } catch (e) {}
  }
  if (!sn) {
    sn = crypto.randomUUID();
    _deviceSnSource = "fallback-random";
    try {
      fs.mkdirSync(path.dirname(DEVICE_SN_FILE), { recursive: true });
      fs.writeFileSync(DEVICE_SN_FILE, JSON.stringify({ sn, source: _deviceSnSource, generatedAt: Date.now() }, null, 2));
    } catch (e) { /* 兜底失败：下次还是会生成 —— 不影响主流程 */ }
  }

  _deviceSnCache = sn;
  return sn;
}

// ===== 文档备份辅助函数 =====

function sendJson(res, code, body) {
  setCorsHeaders(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function trimDebugValue(value, max = 900) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > max ? raw.slice(0, max) + "..." : raw;
}

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function localImagePathInfo(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error("图片文件不存在: " + resolved);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("路径不是文件: " + resolved);
  if (stat.size <= 0) throw new Error("图片文件为空: " + resolved);
  const ext = path.extname(resolved).toLowerCase();
  const realPath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  const safePath = ensureSafeRenderPath(realPath, stat, ext);
  const jpegPath = ensureJpegRenderPath(safePath || realPath, stat, ext);
  return { path: resolved, realPath, safePath, jpegPath, size: stat.size, ext, platform: process.platform };
}

function safeBaseName(filePath, ext) {
  const raw = path.basename(filePath, ext || path.extname(filePath));
  return raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "image";
}

function isInsideDir(filePath, dir) {
  try {
    const rel = path.relative(dir, filePath);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch (e) {
    return false;
  }
}

function ensureSafeRenderPath(realPath, stat, ext) {
  try {
    const renderRoot = fs.realpathSync.native ? fs.realpathSync.native(RENDER_DIR) : fs.realpathSync(RENDER_DIR);
    if (realPath === renderRoot || isInsideDir(realPath, renderRoot)) return realPath;
  } catch (e) {}
  const suffix = ext || path.extname(realPath) || ".png";
  const hash = crypto
    .createHash("sha256")
    .update(`${realPath}:${stat.size}:${Number(stat.mtimeMs || 0)}`)
    .digest("hex")
    .slice(0, 16);
  const target = path.join(RENDER_DIR, `${safeBaseName(realPath, suffix)}-${hash}${suffix}`);
  try {
    const existing = fs.existsSync(target) ? fs.statSync(target) : null;
    if (!existing || existing.size !== stat.size) {
      fs.copyFileSync(realPath, target);
      const fd = fs.openSync(target, "r");
      try { fs.fsyncSync(fd); } catch (e) {}
      finally { fs.closeSync(fd); }
    }
  } catch (e) {
    throw new Error(`复制图片到稳定目录失败: ${e.message || e}`);
  }
  return target;
}

function ensureJpegRenderPath(inputPath, stat, ext) {
  if (!inputPath || ![".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(String(ext || "").toLowerCase())) {
    return "";
  }
  if (process.platform !== "darwin") return "";
  const hash = crypto
    .createHash("sha256")
    .update(`${inputPath}:${stat.size}:${Number(stat.mtimeMs || 0)}:jpeg`)
    .digest("hex")
    .slice(0, 16);
  const target = path.join(RENDER_DIR, `${safeBaseName(inputPath, path.extname(inputPath))}-${hash}.jpg`);
  try {
    const existing = fs.existsSync(target) ? fs.statSync(target) : null;
    if (existing && existing.size > 0) return target;
    const { spawnSync } = require("child_process");
    const r = spawnSync("/usr/bin/sips", ["-s", "format", "jpeg", inputPath, "--out", target], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    if (r.error || r.status !== 0) {
      console.warn("[proxy] sips 转 JPEG 失败:", r.error?.message || r.stderr || r.status);
      return "";
    }
    const outStat = fs.statSync(target);
    if (!outStat.isFile() || outStat.size <= 0) return "";
    const fd = fs.openSync(target, "r");
    try { fs.fsyncSync(fd); } catch (e) {}
    finally { fs.closeSync(fd); }
    return target;
  } catch (e) {
    console.warn("[proxy] JPEG 兜底生成失败:", e.message);
    return "";
  }
}

function writeImageHtmlFile(imagePath) {
  const info = localImagePathInfo(imagePath);
  const src = pathToFileURL(info.safePath || info.realPath).href;
  const hash = crypto
    .createHash("sha256")
    .update(`${info.safePath || info.realPath}:${info.size}`)
    .digest("hex")
    .slice(0, 16);
  const htmlPath = path.join(RENDER_DIR, `insert-image-${hash}.html`);
  const html = [
    "<!doctype html>",
    "<html>",
    "<head><meta charset=\"utf-8\"></head>",
    "<body>",
    `<img src="${escapeHtmlAttr(src)}" style="max-width:100%;height:auto;" />`,
    "</body>",
    "</html>"
  ].join("");
  const fd = fs.openSync(htmlPath, "w");
  try {
    fs.writeSync(fd, html, 0, "utf8");
    try { fs.fsyncSync(fd); } catch (e) {}
  } finally {
    fs.closeSync(fd);
  }
  return { htmlPath, imagePath: info.safePath || info.realPath, size: info.size };
}

function writeHtmlFragmentFile(html) {
  const raw = String(html || "");
  if (!raw.trim()) throw new Error("html 必填");
  if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024) throw new Error("html 过大");
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const htmlPath = path.join(RENDER_DIR, `insert-html-${hash}-${Date.now()}.html`);
  const normalized = /<html[\s>]/i.test(raw)
    ? raw
    : [
        "<!doctype html>",
        "<html>",
        "<head><meta charset=\"utf-8\"></head>",
        /<body[\s>]/i.test(raw) ? raw : `<body>${raw}</body>`,
        "</html>"
      ].join("");
  const fd = fs.openSync(htmlPath, "w");
  try {
    fs.writeSync(fd, normalized, 0, "utf8");
    try { fs.fsyncSync(fd); } catch (e) {}
  } finally {
    fs.closeSync(fd);
  }
  return { htmlPath, size: Buffer.byteLength(normalized, "utf8") };
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
// 单个转发请求的 socket 超时。覆盖最慢的同步图像生成（sub2api 等中转 60-120s 常见），
// 留些余量取 180s。toapis 是异步轮询每次都很快，不会被这个值影响。
const FORWARD_SOCKET_TIMEOUT_MS = 180 * 1000;

/**
 * 判断 IPv4 是否落在常见 Cloudflare 边缘段。
 * 用于 ECONNRESET 错误归因 —— 落在 CF 段且 TLS 没握成功，几乎 100% 是 JA3 拦截。
 * 段来源：https://www.cloudflare.com/ips-v4
 *   104.16.0.0/12  → 104.16.0.0 ~ 104.31.255.255
 *   104.21.0.0/16  → 含在 /12 内（example.com 解到的 104.21.11.126 就在这）
 *   172.64.0.0/13  → 172.64.0.0 ~ 172.71.255.255
 *   162.158.0.0/15 → 162.158.0.0 ~ 162.159.255.255
 *   188.114.96.0/20
 *   190.93.240.0/20
 *   197.234.240.0/22
 *   198.41.128.0/17 → 198.41.128.0 ~ 198.41.255.255
 *   141.101.64.0/18
 *   108.162.192.0/18
 *   173.245.48.0/20
 *   131.0.72.0/22
 * 这里只判最常见几段，未命中也不致命 —— 仍然给出 "TLS 握手阶段被 RST" 通用提示。
 */
function isCloudflareIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 104 && b >= 16 && b <= 31) return true;            // 104.16.0.0/12
  if (a === 172 && b >= 64 && b <= 71) return true;            // 172.64.0.0/13
  if (a === 162 && (b === 158 || b === 159)) return true;      // 162.158.0.0/15
  if (a === 198 && b === 41) return true;                      // 198.41.128.0/17 近似
  if (a === 141 && b >= 101 && b <= 101) return true;          // 141.101.64.0/18 近似
  if (a === 108 && b === 162) return true;                     // 108.162.192.0/18 近似
  if (a === 173 && b === 245) return true;                     // 173.245.48.0/20 近似
  if (a === 131 && b === 0) return true;                       // 131.0.72.0/22 近似
  if (a === 188 && b === 114) return true;                     // 188.114.96.0/20 近似
  if (a === 190 && b === 93) return true;                      // 190.93.240.0/20 近似
  return false;
}

function proxyRequest(targetUrl, method, headers, body, clientRes, extraOptions = {}) {
  const url = new URL(targetUrl);

  // Content-Length 必须自己算并写回：browser 的 Content-Length 被 PASSTHROUGH 过滤了，
  // Node http.request 不见 Content-Length 会自动用 Transfer-Encoding: chunked 发 body。
  // 很多 OpenAI 兼容中转（Cloudflare 前端 / sub2api 等）严格拒绝 chunked POST，
  // 表现就是建连接后立刻 RST（read ECONNRESET）。
  const outHeaders = Object.assign({}, headers);
  if (body && body.length > 0) {
    outHeaders["Content-Length"] = String(body.length);
  } else {
    delete outHeaders["Content-Length"];
    delete outHeaders["content-length"];
  }

  const options = Object.assign({
    hostname: url.hostname,
    // 协议正确的默认端口：http 走 80、https 走 443。之前一律 || 443 会让 http URL
    // 错连 443 而 ETIMEDOUT。
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers: outHeaders
  }, extraOptions);

  // DEBUG: 打印发送到远端的请求头
  console.log(`[proxy] → 请求头:`, JSON.stringify(headers, null, 2));

  const transport = url.protocol === "https:" ? https : http;
  let timedOut = false;
  // socket 生命周期标记 —— 错误处理时用来区分"TLS 握手阶段被 RST"vs"应用层 RST"，
  // 两种 ECONNRESET 病因和解法完全不同，必须分开提示。
  let tcpConnected = false;
  let tlsHandshakeDone = false;
  let remoteAddress = null;
  const proxyReq = transport.request(options, (proxyRes) => {
    // socket 信息只在收到响应那一刻肯定有
    const sock = proxyRes.socket;
    if (sock) {
      console.log(`[proxy] socket ${sock.remoteAddress}:${sock.remotePort} ALPN=${sock.alpnProtocol || "h1.1"}`);
    }
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

  // 显式超时：socket 在 180s 内没有任何数据收发就主动断开，配清晰错误体回客户端。
  // 不设这个会用 OS 默认（Windows 约 21s 才能拿到 ETIMEDOUT，期间用户只能干等）。
  proxyReq.setTimeout(FORWARD_SOCKET_TIMEOUT_MS, () => {
    timedOut = true;
    try { proxyReq.destroy(new Error(`socket timeout after ${FORWARD_SOCKET_TIMEOUT_MS / 1000}s`)); } catch (e) {}
  });

  // socket 生命周期诊断：让 ECONNRESET 时能看清 DNS 解到哪、TCP 是否真连上、TLS 是否真握上
  proxyReq.on("socket", (sock) => {
    sock.on("lookup", (err, address, family, host) => {
      if (err) console.warn(`[proxy] DNS ${host} 解析失败:`, err.message);
      else {
        console.log(`[proxy] DNS ${host} → ${address} (IPv${family})`);
        remoteAddress = address;
      }
    });
    sock.on("connect", () => {
      tcpConnected = true;
      if (sock.remoteAddress) remoteAddress = sock.remoteAddress;
      console.log(`[proxy] TCP 连上 ${sock.remoteAddress}:${sock.remotePort}`);
    });
    sock.on("secureConnect", () => {
      tlsHandshakeDone = true;
      console.log(`[proxy] TLS 握手成功 ${sock.remoteAddress}:${sock.remotePort} ALPN=${sock.alpnProtocol || "(none)"} cipher=${(sock.getCipher?.() || {}).name || "?"}`);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[proxy] 转发请求失败: ${targetUrl}`, err.message);
    // 网络层常见错误码翻译成可读提示。带上 host 让用户能快速定位 Base URL 是否写错。
    const code = err.code || "";
    const hostHint = `${url.protocol}//${url.hostname}${url.port ? ":" + url.port : ""}`;
    let friendly = err.message;
    if (timedOut || /timeout/i.test(err.message)) {
      friendly = `连接 ${hostHint} 超时（>${FORWARD_SOCKET_TIMEOUT_MS / 1000}s）。检查 Base URL 是否正确、远端是否在线。`;
    } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      friendly = `DNS 解析失败：${hostHint}。请检查 Base URL 域名拼写。`;
    } else if (code === "ECONNREFUSED") {
      friendly = `连接被拒绝：${hostHint}。远端服务可能没在监听该端口。`;
    } else if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      friendly = `网络不可达：${hostHint}（${code}）。检查防火墙/VPN/代理。`;
    } else if (code === "ECONNRESET" || code === "EPIPE") {
      // 关键分流：HTTPS 场景下，TCP 已连但 TLS 没握成功 == TLS 握手阶段被 RST，
      // 99% 是远端按 TLS 指纹 (JA3) 拒了我们的 Node OpenSSL ClientHello。
      // 这种情况换 baseUrl / 走 IP 直连才有救，重试或换 model/key 都没用，必须明确告知。
      const isHttps = url.protocol === "https:";
      const isTlsStageReset = isHttps && tcpConnected && !tlsHandshakeDone;
      const cfLike = isCloudflareIp(remoteAddress);
      if (isTlsStageReset && cfLike) {
        friendly = `图像服务被 Cloudflare 边缘按 TLS 指纹拦了（远端 IP ${remoteAddress} 属 CF 段，TCP 连上后 TLS 握手就被 RST）。`
          + `这是 CF 边缘 SSL/TLS 终止层做的，跟控制台「防护」开关无关、关不掉。`
          + `解决：把 baseUrl 换到一个不挂 CF 的端点（自建 sub2api、siliconflow、openrouter、或源站 IP+端口直连），或在 WPS 设置里关掉「通过本地 CORS 代理」让浏览器 TLS 栈直连（前提是该端点配了 CORS）。`;
      } else if (isTlsStageReset) {
        friendly = `TCP 已连上 ${remoteAddress || hostHint} 但 TLS 握手被远端 RST（${code}）。`
          + `常见原因：远端按 TLS 指纹拦截（典型 CF/WAF）、SNI 不匹配、或要求客户端证书。`
          + `用 curl/Apifox 直连同一 URL 对照，如果它们能通而代理不通，多半是 TLS 指纹问题，要换 baseUrl。`;
      } else {
        friendly = `远端 ${hostHint} 主动重置了连接（${code}）。常见原因：API Key 无效 / 路径写错 / 中转网关拒绝当前请求 (例如不支持 Transfer-Encoding: chunked)。`;
      }
    } else if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      friendly = `TLS 证书校验失败：${hostHint}（${code}）。`;
    }
    setCorsHeaders(clientRes);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
    }
    try {
      clientRes.end(JSON.stringify({ error: { message: `代理转发失败：${friendly}`, code } }));
    } catch (e) {
      try { clientRes.end(); } catch (_) {}
    }
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

  // POST /debug-log —— 插件侧把关键调试日志打到 proxy 终端，避免 WPS WebView 控制台不可见。
  if (pathname === "/debug-log" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const tag = String(json.tag || "plugin");
      const message = String(json.message || "");
      const data = json.data == null ? "" : ` ${trimDebugValue(json.data)}`;
      console.log(`[plugin-debug] ${tag}: ${message}${data}`);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      console.warn("[plugin-debug] 记录失败:", e.message);
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // POST /local-image-info —— 返回本地图片真实路径等信息，供 Writer 避开 macOS /var symlink 等路径坑。
  if (pathname === "/local-image-info" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "path 必填" });
        return;
      }
      const result = localImagePathInfo(filePath);
      console.log(`[proxy] /local-image-info ${filePath} → real=${result.realPath}; safe=${result.safePath}; jpeg=${result.jpegPath || "-"} (${result.size} bytes)`);
      sendJson(res, 200, { ok: true, path: filePath, ...result });
    } catch (e) {
      console.error("[proxy] /local-image-info 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /image-html-file —— 为 Writer Range.InsertFile 生成一个引用本地图片的临时 HTML 文件。
  if (pathname === "/image-html-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const filePath = String(json.path || "");
      if (!filePath) {
        sendJson(res, 400, { ok: false, error: "path 必填" });
        return;
      }
      const result = writeImageHtmlFile(filePath);
      console.log(`[proxy] /image-html-file ${filePath} → ${result.htmlPath}; image=${result.imagePath}`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error("[proxy] /image-html-file 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /html-file —— 为 Writer Range.InsertFile 生成一个临时 HTML 文件。
  if (pathname === "/html-file" && method === "POST") {
    try {
      const body = await readBody(req);
      const json = JSON.parse(body.toString("utf8"));
      const result = writeHtmlFragmentFile(String(json.html || ""));
      console.log(`[proxy] /html-file → ${result.htmlPath} (${result.size} bytes)`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error("[proxy] /html-file 失败:", e.message);
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

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
      const m = /^data:(image\/(?:png|jpeg|jpg|svg\+xml|webp|gif));base64,(.+)$/i.exec(dataUrl);
      if (!m) {
        setCorsHeaders(res);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid dataUrl" }));
        return;
      }
      const mime = m[1].toLowerCase();
      const ext = mime.includes("svg") ? "svg"
        : (mime.includes("jpeg") || mime.includes("jpg")) ? "jpg"
        : mime.includes("webp") ? "webp"
        : mime.includes("gif") ? "gif"
        : "png";
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

  // GET /device-sn —— 返回当前设备的稳定唯一标识，给灰度（canary）白名单匹配用。
  // 不依赖网络 / 用户登录，跟着硬件走（重装系统、清空 localStorage 都不变）。
  // 平台命令：
  //   Windows: wmic csproduct get uuid       → 主板 UUID（重装系统不变）
  //            wmic bios get serialnumber    → BIOS 序列号（兜底）
  //   macOS:   ioreg -d2 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}'
  //   Linux:   cat /sys/class/dmi/id/product_uuid（需要 root）/ /etc/machine-id（兜底）
  // 全部失败 → 生成一次性 UUID 存到 ~/.lingxi-ai/device-sn.json，下次直接读这个文件。
  if (pathname === "/device-sn" && method === "GET") {
    try {
      const sn = await getDeviceSn();
      console.log(`[device-sn] → ${sn} (source=${_deviceSnSource})`);
      sendJson(res, 200, { ok: true, sn, source: _deviceSnSource });
    } catch (e) {
      console.error("[device-sn] failed:", e);
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
    return;
  }

  // GET /install-path —— 返回 plugin 的本地 FS 路径，给 MCP 配置 / 应用内显示用。
  // dev 模式下 plugin 加载走 http://localhost，前端从 URL 推不出 FS 路径；统一改成问 proxy。
  //   pluginRoot:    proxy-server.js 的上一级（dev = plugin/，生产 = ~/.lingxi-ai/）
  //   mcpServer:     mcp-server.js 绝对路径
  //   hostVariants:  生产模式下的 plugin-wps/-et/-wpp/-pdf 实际存在的目录列表
  if (pathname === "/install-path" && method === "GET") {
    try {
      const pluginRoot = path.resolve(__dirname, "..");
      const mcpCandidates = [
        path.resolve(__dirname, "mcp-server.js"),               // 跟 proxy-server.js 同目录（推荐）
        path.join(pluginRoot, "plugin-wpp", "tools", "mcp-server.js"),  // host 变体兜底
        path.join(pluginRoot, "plugin-wps", "tools", "mcp-server.js"),
        path.join(pluginRoot, "tools", "mcp-server.js")          // dev 模式
      ];
      const mcpServer = mcpCandidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || mcpCandidates[0];
      const HOSTS = ["wps", "et", "wpp", "pdf"];
      const hostVariants = HOSTS
        .map((h) => path.join(pluginRoot, `plugin-${h}`))
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
      const mode = hostVariants.length > 0 ? "production" : "dev";
      sendJson(res, 200, { ok: true, pluginRoot, mcpServer, hostVariants, mode });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
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
  // 早期版本调 PowerShell Expand-Archive / unzip。中文 Windows 上 PowerShell 的
  // 编码 / PATH / 转义太脆弱，错误一旦丢就只剩「解压失败: unknown」。
  // 现在统一走 zip-extract.js 纯 JS 实现（zlib 内置），零依赖、跨平台、错误可读。
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
      try {
        const { extractZip } = require("./zip-extract");
        const r = extractZip(zipPath, tmpExtract);
        console.log(`[proxy] /update/apply 解压完成: ${r.fileCount}/${r.entryCount} 文件`);
      } catch (extractErr) {
        try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
        console.error("[proxy] /update/apply 解压失败:", extractErr);
        sendJson(res, 500, { ok: false, error: `解压失败: ${extractErr?.message || String(extractErr)}` });
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
      // 关键：生产安装的实际加载路径不是 pluginRoot 本身，而是它兄弟目录
      // plugin-wps / plugin-et / plugin-wpp / plugin-pdf（由 post-install 跑 build-variants.js 生成）。
      // serve-permanent.js 把 WPS 的 http://127.0.0.1:3889/<host>/* 映射到 <pluginRoot>/plugin-<host>/。
      // 之前直接 copyRecursive(sourceRoot, pluginRoot) → 文件落在 <pluginRoot>/ 根目录而不是 plugin-<host>/，
      // 用户重启 WPS 后看到的还是老 plugin-<host>/ 里的旧代码。
      //
      // 检测策略：pluginRoot 下有任意 plugin-<host>/ 子目录 → 生产模式 → 同步覆盖所有 host 变体
      // + 把 zip 里的 tools/proxy-server.js / serve-permanent.js 也覆盖到 pluginRoot/tools/（跑这俩的就是它）
      const HOSTS = ["wps", "et", "wpp", "pdf"];
      const hostDirs = HOSTS
        .map((h) => path.join(pluginRoot, `plugin-${h}`))
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
      const targets = [];
      if (hostDirs.length > 0) {
        // 生产模式：覆盖每个 plugin-<host>/，再把 tools/* 单独覆盖到 pluginRoot/tools/
        hostDirs.forEach((d) => targets.push({ src: sourceRoot, dst: d, label: path.basename(d) }));
        // tools/ 单独处理：只覆盖 zip 里的 tools/ 到 pluginRoot/tools/（不是整个 sourceRoot）
        const zipTools = path.join(sourceRoot, "tools");
        const targetTools = path.join(pluginRoot, "tools");
        if (fs.existsSync(zipTools) && fs.existsSync(targetTools)) {
          targets.push({ src: zipTools, dst: targetTools, label: "tools/ (服务脚本)" });
        }
        console.log(`[proxy] /update/apply 生产模式，写入 ${targets.length} 个目标目录`);
      } else {
        // dev 模式：单 plugin/ 目录
        targets.push({ src: sourceRoot, dst: pluginRoot, label: "plugin/" });
        console.log(`[proxy] /update/apply dev 模式，写入 ${pluginRoot}`);
      }
      const perTarget = [];
      for (const t of targets) {
        const before = filesReplaced;
        copyRecursive(t.src, t.dst);
        perTarget.push(`${t.label}: ${filesReplaced - before} 文件`);
      }
      try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
      try { fs.unlinkSync(zipPath); } catch (e) {}
      console.log(`[proxy] /update/apply 完成，覆盖 ${filesReplaced} 个文件（${perTarget.join(" / ")}）`);
      // 关键：proxy 自己刚被覆盖的新代码还在磁盘上，运行中的还是老代码。
      // 用 child_process 起一个临时 shim，shim 等 2 秒（让老 proxy 退干净 + 端口释放）
      // 后再 spawn 真正的 proxy，避免新旧两个进程抢同一端口。
      // Mac/Linux 的 launchd / systemd 本身就会保活；Windows 计划任务是 AtLogOn 触发，
      // proxy 自己退出后没人拉它，所以 Windows 必须靠这条路径接管。
      let restartScheduled = false;
      const myPath = __filename; // 现在已经是新代码的文件路径
      try {
        const { spawn } = require("child_process");
        // shim 用 -e 内联跑：等 2s → spawn 新 proxy → 自己退
        const shim = [
          "setTimeout(() => {",
          "  const { spawn } = require('child_process');",
          `  const c = spawn(process.execPath, [${JSON.stringify(myPath)}], {`,
          "    detached: true, stdio: 'ignore',",
          `    cwd: ${JSON.stringify(path.dirname(myPath))}`,
          "  });",
          "  c.unref();",
          "  process.exit(0);",
          "}, 2000);"
        ].join("\n");
        const child = spawn(process.execPath, ["-e", shim], {
          detached: true,
          stdio: "ignore",
          env: process.env
        });
        child.unref();
        restartScheduled = true;
        console.log(`[proxy] /update/apply 已起 shim (pid=${child.pid})，2s 后 spawn 新 proxy；自己 1500ms 后退出`);
      } catch (e) {
        console.warn(`[proxy] /update/apply 自重启 spawn 失败：${e?.message || e}（继续退出，依赖宿主保活）`);
      }
      sendJson(res, 200, {
        ok: true,
        filesReplaced,
        targets: perTarget,
        restartScheduled,
        message: `更新已写入（${perTarget.join(" / ")}）。后台服务已自动重启加载新代码。请完全退出 WPS 后重新打开让 TaskPane 也用上新版。`
      });
      // 给响应一点时间真正发出去，再让自己退出（Mac/Linux 上 launchd/systemd 会再起一份，
      // Windows 上由刚才 spawn 的 detached child 接管）
      if (restartScheduled) {
        res.on("finish", () => {
          setTimeout(() => {
            console.log("[proxy] 自重启：退出旧进程");
            process.exit(0);
          }, 1500);
        });
      }
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

  // 自定义端点（/forward/*，主要是 OpenAI 兼容中转 / 图像 sub2api）很多走 Cloudflare 前置 WAF，
  // 看到 WebView UA（"Mozilla/... WPSOffice/..."）会直接 RST。这类端点跟 curl 一样
  // 不需要浏览器 UA，强制改成 curl 风格的 UA 并清掉 Accept-Language 之类不必要字段，
  // 把请求外观对齐到用户在终端测试通过的 curl。
  // 不影响 /codex/* 和 /openai/*：那两条历史路径就需要真实浏览器 UA / 特殊原 header。
  if (pathname.startsWith("/forward/")) {
    // HTTP header 名不区分大小写，但 Node http.request 会把所有 key 当成独立条目
    // 都发出去 —— 之前同时存在 "user-agent: Mozilla..." 和 "User-Agent: curl/..."
    // 上游看到的是 Mozilla 那条。必须先把所有大小写变体都干掉再设。
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === "user-agent" || lk === "accept" || lk === "accept-encoding"
          || lk === "accept-language" || lk === "connection") {
        delete headers[k];
      }
    }
    headers["User-Agent"] = "Apifox/1.0.0 (https://apifox.com)";
    headers["Accept"] = "*/*";
    // 关键：Node http.request 默认 Connection: close。example.com 等 CF 前置 WAF
    // 对 POST + Connection: close 直接 RST，这就是之前换了 UA 还 ECONNRESET 的真因。
    // 显式 keep-alive 后跟成功的 curl 头对齐。
    headers["Connection"] = "keep-alive";
  }

  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : null;

  // /forward/* 端点的 TLS 选项调成尽量贴近 Chrome，让 CF 边缘的 JA3 评分有机会放过。
  // 注意：Node OpenSSL 没法改 TLS 扩展顺序（JA3 真正的核心差异），所以不保证生效；
  // 这是相对低成本的一次性尝试，不行就只能换端点。
  //
  // 背景：
  //   - family: 4    Node 18+ 默认 IPv6 优先，有些 CF 站点 IPv6 路由不健康（TCP 通但应用层 RST）
  //   - ciphers      Chrome TLS 1.3 + 1.2 的 cipher 顺序
  //   - ALPNProtocols  Chrome 优先 h2 再 http/1.1（CF 见到 ALPN=h2 通常更宽容）
  //   - ecdhCurve    Chrome 的曲线顺序 X25519 > P-256 > P-384
  //   - minVersion   强制 TLS 1.2 起，避免 OpenSSL 默认握出 TLS 1.0/1.1 被一些 CF 站点拒
  const extraOpts = pathname.startsWith("/forward/") ? {
    family: 4,
    ALPNProtocols: ["h2", "http/1.1"],
    ciphers: [
      "TLS_AES_128_GCM_SHA256",
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
      "ECDHE-ECDSA-AES128-GCM-SHA256",
      "ECDHE-RSA-AES128-GCM-SHA256",
      "ECDHE-ECDSA-AES256-GCM-SHA384",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "ECDHE-ECDSA-CHACHA20-POLY1305",
      "ECDHE-RSA-CHACHA20-POLY1305",
      "ECDHE-RSA-AES128-SHA",
      "ECDHE-RSA-AES256-SHA",
      "AES128-GCM-SHA256",
      "AES256-GCM-SHA384",
      "AES128-SHA",
      "AES256-SHA"
    ].join(":"),
    ecdhCurve: "X25519:P-256:P-384",
    minVersion: "TLSv1.2"
  } : {};
  proxyRequest(targetUrl, method, headers, body, res, extraOpts);
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`[proxy] CORS 代理服务器已启动: http://127.0.0.1:${PROXY_PORT}`);
  console.log("[proxy] 路由映射:");
  ROUTE_MAP.forEach((route) => {
    console.log(`  ${route.prefix}* → ${route.target}*`);
  });
  console.log("  /forward/<urlencoded-base>/* → <base>/* (通用转发，用于自定义端点)");
  console.log("  POST /debug-log → 插件调试日志写到当前终端");
  console.log("  POST /local-image-info → 本地图片真实路径信息（Writer 插图路径兜底）");
  console.log("  POST /image-html-file → 为 Writer InsertFile 生成本地图片 HTML 兜底文件");
  console.log(`  POST /upload-image → 落地图片到 ${RENDER_DIR}/<random>.png|jpg|svg|webp|gif`);
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
