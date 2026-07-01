/**
 * 缓存管理：扫 localStorage 里 lingxi_* 键的大小 + 类别，让用户选择性清除。
 * 同时聚合 proxy 侧的备份 / 临时更新目录（走 /cache/stats + /cache/clear）。
 *
 * localStorage 键分类规则（substr match，第一命中即为该类）：
 *   history      → 改动记录 / turn 快照（清了就丢历史 + 恢复不了）
 *   chat         → 对话记录（清了 chat 流从空开始）
 *   preview      → 预览弹窗中间态（安全清）
 *   updater      → 版本检查缓存（下次自动重拉）
 *   models       → 模型列表缓存（下次配置页会重拉）
 *   settings / provider / user / enabled / thinking / operation / auto → 设置（谨慎清）
 *   device_sn / runtime / port → 设备 SN / runtime 端口探测（自动重拉）
 *   default      → 其它
 *
 * WpsAiCache.scan()  → { totalBytes, groups: [{ label, safe, items: [{key, bytes, updatedAt|null}] }], proxy: [...] }
 * WpsAiCache.clearKey(key)
 * WpsAiCache.clearGroup(groupLabel)
 * WpsAiCache.clearProxyBucket(name)
 * WpsAiCache.clearAllSafe()   // 安全组一键清（不动 settings / history）
 */
(function attachCache(global) {
  "use strict";

  function proxyBase() { return global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890"; }

  const CATEGORIES = [
    { key: "history",  label: "改动记录 / 快照",  safe: false,
      match: (k) => /history|turn|snapshot/i.test(k) },
    { key: "chat",     label: "对话记录",          safe: false,
      match: (k) => /chat|conversation|unified_chat/i.test(k) },
    { key: "preview",  label: "预览弹窗中间态",     safe: true,
      match: (k) => /preview|quick_prompt|dialog_(request|result)|picked_components|full_deck_progress|progress/i.test(k) },
    { key: "updater",  label: "版本检查缓存",       safe: true,
      match: (k) => /updater|last_check/i.test(k) },
    { key: "models",   label: "模型列表缓存",       safe: true,
      match: (k) => /models_cache|image_models_cache/i.test(k) },
    { key: "settings", label: "应用设置",           safe: false,
      match: (k) => /settings|provider|api_key|thinking|operation|auto|enabled|current_provider|user|pure_mode|split_layers|max_tool|system_prompt/i.test(k) },
    { key: "runtime",  label: "设备 SN / 运行时",   safe: true,
      match: (k) => /device_sn|runtime|proxy_port|editor_tips|cache_cleared_at|insertion_range_hint/i.test(k) },
    { key: "other",    label: "其它",              safe: true,
      match: () => true }
  ];

  // 单位字节数格式化。跟 app.js 里 formatSize 一致格式，避免 UI 不一致。
  function fmtBytes(n) {
    if (n == null || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  // 只统计我们自己的 key —— lingxi_ 前缀 / __lingxi_ / lingxi- 全都算
  function isOurKey(k) {
    if (!k) return false;
    return /^(lingxi[_-]|__lingxi)/i.test(k);
  }

  // JS String 里存的其实是 UTF-16，字节数走 Blob 拿最准。老 WebView 没 Blob 兜底用长度*2。
  function bytesOf(str) {
    if (str == null) return 0;
    try {
      return new Blob([str]).size;
    } catch (e) {
      return String(str).length * 2;
    }
  }

  // 有些 value 是 JSON 且带 ts 字段，抽出来显示"最近写入时间"
  function extractTimestamp(str) {
    if (!str || str[0] !== "{") return null;
    try {
      const j = JSON.parse(str);
      const ts = j?.ts || j?.timestamp || j?.updatedAt || j?.checkedAt || j?.startedAt;
      return typeof ts === "number" && ts > 1_000_000_000_000 ? ts : null;
    } catch (e) { return null; }
  }

  function categorize(key) {
    for (const cat of CATEGORIES) {
      if (cat.match(key)) return cat;
    }
    return CATEGORIES[CATEGORIES.length - 1];
  }

  // 扫 localStorage 一次，返回结构化数据供 UI 渲染
  function scanLocalStorage() {
    const groups = new Map();
    for (const cat of CATEGORIES) groups.set(cat.key, { label: cat.label, safe: cat.safe, items: [], bytes: 0 });
    let totalBytes = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!isOurKey(key)) continue;
      const val = localStorage.getItem(key) || "";
      const bytes = bytesOf(val);
      totalBytes += bytes;
      const cat = categorize(key);
      const g = groups.get(cat.key);
      g.items.push({ key, bytes, updatedAt: extractTimestamp(val) });
      g.bytes += bytes;
    }
    // 每组内按大小倒序
    for (const g of groups.values()) g.items.sort((a, b) => b.bytes - a.bytes);
    return { totalBytes, groups: Array.from(groups.values()).filter((g) => g.items.length > 0) };
  }

  async function fetchProxyStats() {
    try {
      const resp = await fetch(`${proxyBase()}/cache/stats`, { cache: "no-store" });
      if (!resp.ok) return [];
      const json = await resp.json();
      if (!json?.ok || !Array.isArray(json.buckets)) return [];
      return json.buckets; // [{ name, label, path, bytes, itemCount, safe }]
    } catch (e) { return []; }
  }

  async function scan() {
    const local = scanLocalStorage();
    const proxy = await fetchProxyStats();
    const proxyTotal = proxy.reduce((s, b) => s + (b.bytes || 0), 0);
    return {
      local,
      proxy,
      grandTotalBytes: local.totalBytes + proxyTotal
    };
  }

  function clearKey(key) {
    try { localStorage.removeItem(key); return true; } catch (e) { return false; }
  }

  function clearGroup(groupKeyOrLabel) {
    // 支持传 groupKey 或 label，两种都能匹配
    const target = CATEGORIES.find((c) => c.key === groupKeyOrLabel || c.label === groupKeyOrLabel);
    if (!target) return { cleared: 0 };
    const toDel = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (isOurKey(key) && categorize(key) === target) toDel.push(key);
    }
    toDel.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
    return { cleared: toDel.length };
  }

  async function clearProxyBucket(name) {
    try {
      const resp = await fetch(`${proxyBase()}/cache/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  }

  // 一键清"安全组"——预览中间态 / updater / models / runtime / other
  // 不动 settings / history / chat（用户可能不希望丢）
  function clearAllSafe() {
    let cleared = 0;
    for (const cat of CATEGORIES) {
      if (!cat.safe) continue;
      cleared += clearGroup(cat.key).cleared;
    }
    return { cleared };
  }

  global.WpsAiCache = {
    scan,
    scanLocalStorage,
    fetchProxyStats,
    clearKey,
    clearGroup,
    clearProxyBucket,
    clearAllSafe,
    fmtBytes,
    CATEGORIES
  };
})(window);
