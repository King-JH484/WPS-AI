/**
 * AI 改动记录：每次 AI 调用写入型工具，把"改了什么"记下来。
 *
 * 数据条目结构：
 *   {
 *     id: 'h-1683...',           // 唯一 id
 *     ts: 1683830400000,         // 时间戳 ms
 *     host: 'wps'|'et'|'wpp',
 *     toolName: 'wpp_apply_template',
 *     friendlyName: '套用 PPT 模板',  // 人话名
 *     target: { kind, label },         // { kind:'slide', label:'第 3 页' }
 *     params: {...},                   // 工具入参（裁剪后）
 *     before: {...} | null,            // 调用前快照
 *     after:  {...} | null,            // 调用后快照
 *     ok: true | false,
 *     resultSummary: '...',            // 结果一两句话
 *     error: null | '...'
 *   }
 *
 * 存储：localStorage key 'lingxi_history_v1'，限 MAX_ENTRIES 条，FIFO 淘汰。
 * 序列化时单条 > 64KB 的 before/after 会被截断，避免占满 storage。
 */
(function attachHistory(global) {
  "use strict";

  const STORAGE_KEY = "lingxi_history_v1";
  const MAX_ENTRIES = 200;
  const MAX_SNAPSHOT_BYTES = 64 * 1024;

  // 内存里的条目列表（按写入顺序，最新在末尾）
  let entries = [];
  // 订阅者，UI 用来重渲染
  const listeners = new Set();

  // ---- 持久化 ----

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed;
    } catch (e) {
      console.warn("[history] load failed", e);
      entries = [];
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (e) {
      // localStorage 满了 → 砍一半重试
      if (e?.name === "QuotaExceededError" && entries.length > 20) {
        entries = entries.slice(-Math.floor(entries.length / 2));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch (_) {}
      }
    }
  }

  function truncateSnapshot(snap) {
    if (!snap) return snap;
    try {
      const s = JSON.stringify(snap);
      if (s.length <= MAX_SNAPSHOT_BYTES) return snap;
      return { _truncated: true, _originalBytes: s.length, _excerpt: s.slice(0, MAX_SNAPSHOT_BYTES) + "…" };
    } catch (e) {
      return { _error: "snapshot 不可序列化" };
    }
  }

  function notify() {
    listeners.forEach((fn) => { try { fn(); } catch (e) {} });
  }

  // ---- 公共 API ----

  function addEntry(entry) {
    const id = "h-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const full = Object.assign({ id, ts: Date.now() }, entry, {
      before: truncateSnapshot(entry.before),
      after: truncateSnapshot(entry.after)
    });
    entries.push(full);
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(-MAX_ENTRIES);
    }
    persist();
    notify();
    return full;
  }

  function listEntries() {
    // 倒序返回（最新在前）
    return entries.slice().reverse();
  }

  function clear() {
    entries = [];
    persist();
    notify();
  }

  function size() { return entries.length; }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // ---- 工具名 → 人话映射 ----

  const FRIENDLY_NAMES = {
    // 演示
    wpp_apply_template: "套用 PPT 模板（A 类）",
    wpp_apply_visual_template: "套用 PPT 视觉模板（B 类）",
    wpp_render_chart: "插入数据图表",
    wpp_add_slide: "添加幻灯片",
    wpp_delete_slide: "删除幻灯片",
    wpp_duplicate_slide: "复制幻灯片",
    wpp_move_slide: "移动幻灯片",
    wpp_replace_shape_text: "替换形状文字",
    wpp_set_title: "设置标题",
    wpp_set_notes: "设置演讲者备注",
    wpp_add_text_box: "添加文本框",
    wpp_add_shape: "添加形状",
    wpp_add_picture: "添加图片",
    wpp_set_slide_background: "设置幻灯片背景",
    wpp_set_slide_layout: "切换版式",
    wpp_select_slide: "选中幻灯片",
    wpp_set_slide_transition: "设置切换动画",
    wpp_apply_style_preset: "统一应用风格预设",
    // 表格
    et_write_range: "写入单元格区域",
    et_apply_style: "应用表格样式",
    et_autofit_columns: "自动调整列宽",
    et_autofit_rows: "自动调整行高",
    et_clear_range: "清空单元格区域",
    et_set_formula: "设置公式",
    // 文字
    wps_replace_selection: "替换选区内容",
    wps_insert_text: "插入文字",
    wps_insert_image: "插入图片",
    wps_apply_paragraph_style: "应用段落样式",
    wps_insert_paragraph: "插入段落",
    wps_remove_paragraph: "删除段落",
    // 通用
    generate_image: "生成图片"
  };

  function getFriendlyName(toolName) {
    return FRIENDLY_NAMES[toolName] || toolName;
  }

  // 哪些工具会"改动文档"——只有这些才记录
  // 读取型 / 信息查询型不记录（防噪音）
  function isMutatingTool(toolName) {
    if (!toolName) return false;
    // 黑名单关键字：所有以 _get_ / _list_ / _read_ 开头的视为只读
    if (/(^|_)(get|list|read)_/.test(toolName)) return false;
    if (/^wpp_get_/.test(toolName)) return false;
    // 显式只读
    const readonly = new Set([
      "wpp_list_slides", "wpp_read_slide", "wpp_get_notes",
      "wpp_get_presentation_info", "wpp_get_style_preset"
    ]);
    if (readonly.has(toolName)) return false;
    // 其余默认为修改型
    return true;
  }

  load();

  global.WpsAiHistory = {
    addEntry,
    listEntries,
    clear,
    size,
    subscribe,
    getFriendlyName,
    isMutatingTool,
    MAX_ENTRIES
  };
})(window);
