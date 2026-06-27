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
    // docPath：每条记录都跟一个具体文件挂钩。entry 里没传就尝试从 backup 模块拿
    const docPath = entry.docPath || global.WpsAiBackup?.getCurrentDocPath?.() || null;
    const full = Object.assign({ id, ts: Date.now(), turnId: currentTurn?.id || null, docPath }, entry, {
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

  // ===== Turn 概念：一次 AI 对话视为一个 turn =====
  // app.js 在 runChatTurn 入口调 startTurn；execute 触发第一个修改型工具时 lazy 抓 backup。

  let currentTurn = null;           // 内存中的"当前 turn"
  const turns = loadTurns();        // 已结束的 turn 索引，持久化

  function loadTurns() {
    try {
      const raw = localStorage.getItem("lingxi_history_turns_v1");
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function persistTurns() {
    try { localStorage.setItem("lingxi_history_turns_v1", JSON.stringify(turns)); } catch (e) {}
  }

  function newTurnId() {
    return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  // 用户按下「发送」时调用，把上一个 turn 收尾，开新的
  function startTurn(prompt) {
    if (currentTurn && currentTurn.id) {
      // 收掉上一 turn 的 UndoRecord(如果开过的话)。这样下次 Application.Undo
      // 一次性撤回上一 turn 整组改动。不收的话 UndoRecord 一直开着,新 turn 的
      // 改动会被合并进去 — 撤回时连新 turn 也跟着撤了。
      try { global.WpsAiBackup?.endUndoGroup?.(); } catch (e) {}
      turns[currentTurn.id] = currentTurn;
      persistTurns();
    }
    currentTurn = {
      id: newTurnId(),
      startedAt: Date.now(),
      prompt: prompt ? String(prompt).slice(0, 200) : "",
      backup: null      // { docPath, backupPath, size, ts, undoGroup } 由 ensureBackupForTurn 填
    };
    notify();
    return currentTurn.id;
  }

  // 修改型工具调用前调一下；同一个 turn 只会 capture 一次
  async function ensureBackupForTurn() {
    if (!currentTurn) return null;
    if (currentTurn.backup) return currentTurn.backup;  // 已经抓过
    const backup = global.WpsAiBackup;
    if (!backup) return null;
    try {
      const res = await backup.captureCurrentDoc();
      if (res?.ok) {
        currentTurn.backup = {
          docPath: res.docPath,
          backupPath: res.backupPath,
          size: res.size,
          ts: res.timestamp || Date.now(),
          // 是否启动了 UndoRecord。回退时优先走 Application.Undo,失败再走文件层。
          undoGroup: !!res.undoGroup
        };
        notify();
        return currentTurn.backup;
      }
      // 没存盘的新文档之类失败原因，记下不再重试
      currentTurn.backup = { error: res?.error || "备份失败", ts: Date.now() };
      notify();
      return null;
    } catch (e) {
      currentTurn.backup = { error: e?.message || String(e), ts: Date.now() };
      return null;
    }
  }

  // 历史 turn 加上当前 turn 一起返回
  function listTurns() {
    const out = Object.assign({}, turns);
    if (currentTurn) out[currentTurn.id] = currentTurn;
    return out;
  }

  function getCurrentTurnId() { return currentTurn?.id || null; }

  function deleteTurn(turnId) {
    delete turns[turnId];
    persistTurns();
    entries = entries.filter((e) => e.turnId !== turnId);
    persist();
    notify();
  }

  // 标记某 turn 已被恢复 —— 不删 entry，加 restoredAt 字段，UI 自己渲染"已恢复"徽章。
  // 之前用 deleteTurn 收尾恢复操作会把 entry 全删掉，重启 TaskPane 后看不到历史；现在保留可查。
  // currentTurn 被恢复时一并提前 flush 到 turns 表，保证 reload 后还能拿到这条记录。
  function markTurnRestored(turnId) {
    if (!turnId) return;
    const stamp = Date.now();
    if (turns[turnId]) {
      turns[turnId].restoredAt = stamp;
    } else if (currentTurn?.id === turnId) {
      currentTurn.restoredAt = stamp;
      turns[turnId] = Object.assign({}, currentTurn);
    } else {
      // 既不在 turns 表也不是 currentTurn —— 兜底建一条最小记录
      turns[turnId] = { id: turnId, restoredAt: stamp };
    }
    persistTurns();
    notify();
  }

  // 倒序返回（最新在前）。可选 filter.docPath：只返回该文件的记录
  function listEntries(filter) {
    let out = entries.slice();
    if (filter && filter.docPath) {
      out = out.filter((e) => pathsEqual(e.docPath, filter.docPath));
    }
    return out.reverse();
  }

  // 跨平台路径比较（大小写不敏感 + 反斜杠归一化）
  function pathsEqual(a, b) {
    if (!a || !b) return false;
    const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return norm(a) === norm(b);
  }

  // 返回所有出现过的 docPath 集合（UI 切换 / 调试用）
  function listDocPaths() {
    const set = new Set();
    entries.forEach((e) => { if (e.docPath) set.add(e.docPath); });
    return Array.from(set);
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
    et_insert_image: "插入图片",
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
    listDocPaths,
    pathsEqual,
    clear,
    size,
    subscribe,
    getFriendlyName,
    isMutatingTool,
    // turn 管理
    startTurn,
    ensureBackupForTurn,
    listTurns,
    getCurrentTurnId,
    deleteTurn,
    markTurnRestored,
    MAX_ENTRIES
  };
})(window);
