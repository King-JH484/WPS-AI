// 本地缓存：记录所有用 wpp_render_html_template 生成过的页面 HTML + 参数。
// 用 localStorage 存（一份 JSON），FIFO 至 MAX_ENTRIES 上限，超额淘汰最早的。
//
// 用途：用户在「HTML 模板预览」窗口可以从缓存里召回上次的页面继续微调；
// 也方便回看历史生成记录。每条记录包含：id / ts / templateName / layout / data / palette / slideHint。
//
// 不缓存 rendered PNG（dataURL 巨大；缓存 HTML 参数足够，预览时按需重渲染）。
(function attachHtmlCache(global) {
  "use strict";

  const KEY = "lingxi_html_template_cache_v1";
  const MAX_ENTRIES = 100;

  function genId() {
    return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function readAll() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch (e) {
      console.warn("[html-cache] 读取缓存失败，已清空：", e?.message || e);
      try { localStorage.removeItem(KEY); } catch (_) {}
      return [];
    }
  }

  function writeAll(entries) {
    try {
      const trimmed = entries.slice(-MAX_ENTRIES);
      localStorage.setItem(KEY, JSON.stringify({ entries: trimmed, savedAt: Date.now() }));
    } catch (e) {
      // localStorage 满了：尝试瘦身（只保留最近 30 条）后再试一次；仍失败就放弃
      try {
        const trimmed = entries.slice(-30);
        localStorage.setItem(KEY, JSON.stringify({ entries: trimmed, savedAt: Date.now() }));
      } catch (e2) {
        console.error("[html-cache] 写入失败（localStorage 可能已满）：", e2?.message || e2);
      }
    }
  }

  // 保存一条记录。返回写入后的 entry（带 id / ts）。
  // entry: { templateName, layout, data, palette, slideHint? }
  function save(entry) {
    if (!entry?.templateName || !entry?.layout) {
      throw new Error("save: templateName + layout 必填");
    }
    const entries = readAll();
    const saved = {
      id: genId(),
      ts: Date.now(),
      templateName: entry.templateName,
      layout: entry.layout,
      data: entry.data || {},
      palette: entry.palette || {},
      slideHint: entry.slideHint || null
    };
    entries.push(saved);
    writeAll(entries);
    return saved;
  }

  // 按 id 更新已有记录（用户在预览窗口微调后保存）
  function update(id, patch) {
    const entries = readAll();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const merged = Object.assign({}, entries[idx], patch, { ts: Date.now() });
    entries[idx] = merged;
    writeAll(entries);
    return merged;
  }

  // 列表（最新优先），可限制条数
  function list(limit) {
    const entries = readAll().slice().reverse();
    return typeof limit === "number" ? entries.slice(0, limit) : entries;
  }

  function get(id) {
    return readAll().find((e) => e.id === id) || null;
  }

  function remove(id) {
    const entries = readAll().filter((e) => e.id !== id);
    writeAll(entries);
  }

  function clear() {
    // 双保险：① removeItem ② 再写入显式空数组（某些 WebView 的 removeItem 持久化有问题）
    try { localStorage.removeItem(KEY); } catch (e) {}
    try { localStorage.setItem(KEY, JSON.stringify({ entries: [], savedAt: Date.now() })); } catch (e) {}
  }

  global.WpsAiHtmlCache = {
    save,
    update,
    list,
    get,
    remove,
    clear,
    MAX_ENTRIES,
    _key: KEY
  };
})(window);
