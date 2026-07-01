// MCP 桥（plugin 侧）：开启后向 proxy-server 注册当前宿主可用工具清单，并长轮询拉取
// 来自外部 agent（Claude Code CLI 等）的工具调用，执行后回写结果。
//
// 启停由 app.js 的 setting "mcpServerEnabled" 控制：
//   - 启用 → start()：先注册工具 → 进入轮询循环
//   - 关闭 → stop()：终止轮询循环、不再注册
//
// 注册：POST /mcp/register 带 [{name, description, parameters}]
// 拉任务：GET /mcp/poll （长轮询）→ { call: {callId, name, args} | null }
// 回结果：POST /mcp/result { callId, ok, value, error }
(function attachMcpBridge(global) {
  "use strict";

  function PROXY_BASE() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }
  const REGISTER_INTERVAL_MS = 30 * 1000;  // 30s 重新注册一次（兼 keep-alive）

  let _enabled = false;
  let _pollAbort = null;
  let _registerTimer = null;
  let _status = {
    enabled: false,
    connected: false,
    lastRegisteredAt: 0,
    lastError: null,
    toolCount: 0
  };
  const _listeners = new Set();

  // 最近 N 次外部 agent 调用日志：给用户一个「谁 / 什么工具 / 是否成功 / 耗时」的可视化窗口，
  // 之前 MCP 面板只能显示当前状态，用户完全不知道有没有 agent 在调、调了什么。
  const CALL_LOG_CAP = 50;
  const _callLog = [];
  const _callListeners = new Set();
  function recordCall(entry) {
    _callLog.unshift(entry);
    if (_callLog.length > CALL_LOG_CAP) _callLog.length = CALL_LOG_CAP;
    _callListeners.forEach((cb) => { try { cb(entry, _callLog.slice()); } catch (e) {} });
  }
  function listRecentCalls() { return _callLog.slice(); }
  function onCall(cb) { _callListeners.add(cb); return () => _callListeners.delete(cb); }
  function clearCallLog() { _callLog.length = 0; _callListeners.forEach((cb) => { try { cb(null, []); } catch (e) {} }); }

  function emit() {
    _listeners.forEach((cb) => {
      try { cb({ ..._status }); } catch (e) {}
    });
  }
  function onStatusChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }

  // 拿 plugin 注册的**所有**工具（跨宿主），让外部 agent 看到完整 API surface。
  // 每条工具描述前面附上 [host: ...] 标记，agent 能据此选择合适的调用时机。
  function collectAllTools() {
    const reg = global.WpsAiToolRegistry;
    if (!reg?.listAll) return [];
    const defs = reg.listAll();
    return defs.map((d) => {
      const hosts = Array.isArray(d.hosts) ? d.hosts : (d.hosts ? [d.hosts] : ["*"]);
      const hostTag = hosts.includes("*") ? "any" : hosts.join("/");
      const descPrefix = `[host: ${hostTag}] `;
      return {
        name: d.name,
        description: descPrefix + (d.description || ""),
        hosts,
        // MCP 标准字段叫 inputSchema；本插件 def.parameters 已是 JSON Schema
        parameters: d.parameters || { type: "object", properties: {} },
        inputSchema: d.parameters || { type: "object", properties: {} }
      };
    });
  }

  async function registerOnce() {
    const tools = collectAllTools();
    try {
      const resp = await fetch(`${PROXY_BASE()}/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      _status.connected = true;
      _status.lastRegisteredAt = Date.now();
      _status.toolCount = tools.length;
      _status.lastError = null;
      emit();
      return true;
    } catch (e) {
      _status.connected = false;
      _status.lastError = e?.message || String(e);
      emit();
      return false;
    }
  }

  async function pollOnce(signal) {
    try {
      const resp = await fetch(`${PROXY_BASE()}/mcp/poll`, { signal });
      if (!resp.ok) {
        _status.connected = false;
        _status.lastError = `poll HTTP ${resp.status}`;
        emit();
        return;
      }
      _status.connected = true;
      _status.lastError = null;
      emit();
      const json = await resp.json();
      const call = json?.call;
      if (!call) return; // 25s 空 poll，回头再 poll
      handleCall(call); // 不 await，让下一轮 poll 尽快回到 server
    } catch (e) {
      if (e?.name === "AbortError") return;
      _status.connected = false;
      _status.lastError = e?.message || String(e);
      emit();
      // 错误时延一拍再 poll，防止打爆 proxy 不在线时的循环
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function handleCall(call) {
    const { callId, name, args } = call;
    const startedAt = Date.now();
    let resultBody;
    try {
      const reg = global.WpsAiToolRegistry;
      if (!reg?.execute) throw new Error("WpsAiToolRegistry 未加载");
      const r = await reg.execute(name, args || {});
      resultBody = { callId, ok: !!r?.ok, value: r?.value, error: r?.error || null };
    } catch (e) {
      resultBody = { callId, ok: false, error: e?.message || String(e) };
    }
    const elapsedMs = Date.now() - startedAt;
    // 记录到最近调用日志：args / value 都取 preview（100 字），完整数据不入 log 避免爆内存
    const preview = (v) => {
      if (v == null) return "";
      try {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return s.length > 120 ? s.slice(0, 120) + "…" : s;
      } catch (e) { return String(v).slice(0, 120); }
    };
    recordCall({
      at: startedAt,
      callId,
      name,
      argsPreview: preview(args),
      ok: !!resultBody.ok,
      error: resultBody.error || null,
      elapsedMs,
      resultPreview: resultBody.ok ? preview(resultBody.value) : ""
    });
    try {
      await fetch(`${PROXY_BASE()}/mcp/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resultBody)
      });
    } catch (e) {
      console.warn("[mcp-bridge] 回传结果失败：", e?.message || e);
    }
  }

  async function pollLoop() {
    while (_enabled) {
      const ac = new AbortController();
      _pollAbort = ac;
      await pollOnce(ac.signal);
    }
    _pollAbort = null;
  }

  function start() {
    if (_enabled) return;
    _enabled = true;
    _status.enabled = true;
    emit();
    // 立即注册一次 + 进入轮询；周期性 keep-alive
    registerOnce();
    if (_registerTimer) clearInterval(_registerTimer);
    _registerTimer = setInterval(registerOnce, REGISTER_INTERVAL_MS);
    pollLoop();
  }

  function stop() {
    if (!_enabled) return;
    _enabled = false;
    _status.enabled = false;
    _status.connected = false;
    emit();
    if (_registerTimer) { clearInterval(_registerTimer); _registerTimer = null; }
    if (_pollAbort) {
      try { _pollAbort.abort(); } catch (e) {}
      _pollAbort = null;
    }
  }

  function getStatus() { return { ..._status }; }

  global.WpsAiMcpBridge = {
    start,
    stop,
    getStatus,
    onStatusChange,
    listRecentCalls,
    onCall,
    clearCallLog,
    PROXY_BASE
  };
})(window);
