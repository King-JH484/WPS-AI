/**
 * WpsAiRuntime
 *
 * 解决"代理 / 静态服务默认端口被占用，自动切换后前端不知道用哪个端口"的问题。
 *
 * 前提：proxy-server.js 在 EADDRINUSE 时按 +1 自动爬端口梯子；它在 /healthz 返回
 *       { service: "lingxi-ai-proxy/v1", port, pid } 并带响应头 X-Lingxi-Service。
 *
 * 启动顺序：
 *   1. 立刻把 proxyBase 默认成 "http://127.0.0.1:3890"（同步默认值），
 *      保证模块级 const PROXY_BASE = WpsAiRuntime.proxyBase() 这种"加载时就读"的代码能拿到值。
 *   2. 拿上次缓存的端口先试一下（lingxi_runtime_proxy_port_v1）。
 *   3. 同时按 3890..3890+LADDER_SIZE 爬一遍 /healthz，谁带 X-Lingxi-Service: lingxi-ai-proxy/v1
 *      就是我们；命中后更新 proxyBase + 写缓存。
 *   4. 探测期间所有 fetch 用旧值，无大碍（默认 3890 就是 80% 场景）。探完才切。
 *
 * 暴露：
 *   WpsAiRuntime.proxyBase()        → "http://127.0.0.1:<resolved port>"
 *   WpsAiRuntime.proxyUrl(path)     → proxyBase + path（自动处理前导 /）
 *   WpsAiRuntime.forwardPrefix()    → proxyBase + "/forward/"
 *   WpsAiRuntime.resolvedPort()     → number
 *   WpsAiRuntime.ready              → Promise<resolvedPort>，等首次探测完
 */
(function attachWpsAiRuntime(global) {
  "use strict";

  const DEFAULT_PORT = 3890;
  const LADDER_SIZE = 20;
  const PROBE_TIMEOUT_MS = 600;
  const SERVICE_SIG = "lingxi-ai-proxy/v1";
  const CACHE_KEY = "lingxi_runtime_proxy_port_v1";

  let currentPort = DEFAULT_PORT;
  let probedOnce = false;
  let lastProbeTs = 0;

  // 启动时先读上次缓存——同步路径下 proxyBase() 就能直接返回上次成功的端口
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      const p = Number(cached?.port);
      if (Number.isFinite(p) && p > 0) currentPort = p;
    }
  } catch (e) {}

  function buildBase(port) {
    return `http://127.0.0.1:${port}`;
  }

  async function probePort(port) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const resp = await fetch(`${buildBase(port)}/healthz`, {
        method: "GET",
        signal: ctrl.signal,
        cache: "no-store"
      });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const sig = resp.headers.get("X-Lingxi-Service") || "";
      if (sig !== SERVICE_SIG) return null;
      const data = await resp.json().catch(() => null);
      return data && Number.isFinite(Number(data.port)) ? Number(data.port) : port;
    } catch (e) {
      return null;
    }
  }

  async function probeAll() {
    // 先试当前/缓存的，没命中再爬梯子。命中即停。
    const triedSet = new Set();
    const tryAndCommit = async (port) => {
      if (triedSet.has(port)) return false;
      triedSet.add(port);
      const found = await probePort(port);
      if (found != null) {
        if (found !== currentPort) {
          currentPort = found;
          try { localStorage.setItem(CACHE_KEY, JSON.stringify({ port: found, ts: Date.now() })); } catch (e) {}
        }
        return true;
      }
      return false;
    };

    if (await tryAndCommit(currentPort)) return currentPort;
    for (let i = 0; i < LADDER_SIZE; i += 1) {
      const p = DEFAULT_PORT + i;
      if (await tryAndCommit(p)) return currentPort;
    }
    // 全没探到，保持当前 currentPort（多半就是默认 3890）。打日志让用户知道。
    try { console.warn("[WpsAiRuntime] /healthz 探测失败，保持端口", currentPort, "代理服务可能未启动。"); } catch (e) {}
    return currentPort;
  }

  const readyPromise = (async () => {
    const port = await probeAll();
    probedOnce = true;
    lastProbeTs = Date.now();
    return port;
  })();

  function proxyBase() {
    return buildBase(currentPort);
  }
  function proxyUrl(p) {
    const path = String(p || "");
    if (!path) return proxyBase();
    return path.startsWith("/") ? proxyBase() + path : proxyBase() + "/" + path;
  }
  function forwardPrefix() {
    return proxyBase() + "/forward/";
  }
  function resolvedPort() {
    return currentPort;
  }
  function isProbed() {
    return probedOnce;
  }
  async function reprobe() {
    // 用户场景：proxy 重启后用了新端口，前端如果还在跑可以手动让 Runtime 重探一次。
    if (Date.now() - lastProbeTs < 1000) return currentPort; // 节流
    return probeAll();
  }

  global.WpsAiRuntime = {
    proxyBase,
    proxyUrl,
    forwardPrefix,
    resolvedPort,
    isProbed,
    reprobe,
    ready: readyPromise
  };
})(window);
