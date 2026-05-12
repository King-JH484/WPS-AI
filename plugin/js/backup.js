/**
 * 文档级备份 + 恢复（per-turn 粒度）。
 *
 * 双层回退策略:
 *   - 优先「内容层」: 用 Application.UndoRecord 把整个 AI turn 分组成一个 undo,
 *     回退时 Application.Undo() 一次撤回整组 → 不关文档,光标/滚动/状态都保留
 *   - 降级「文件层」: 关文档 → proxy 覆盖磁盘文件 → 重开。代价是文档关闭重开,
 *     但能跨多 turn 回退,且对 ET/WPP 这种没 UndoRecord 的宿主兜底
 *
 * 核心 API:
 *   - captureCurrentDoc()  → Save + 文件备份 + 启动 UndoRecord
 *   - endUndoGroup()       → 关掉当前 UndoRecord(turn 结束时调)
 *   - restoreFromBackup(backupPath, targetPath, opts)
 *                            opts.tryUndo=true 时先试 Undo,失败才走关闭重开
 *   - getCurrentDocPath() → 当前活动文档的绝对路径（未保存的新文档返回 null）
 *
 * 与 proxy-server.js 的 /doc-snapshot / /doc-restore 配套使用。
 * 失败一律返回 { ok:false, error }，绝不抛错影响主流程。
 */
(function attachBackup(global) {
  "use strict";

  const PROXY_BASE = "http://127.0.0.1:3890";

  // ---- 当前应用 / 当前文档抓取 ----

  function getApp() {
    return global.wps?.WpsApplication?.()
      || global.wps?.EtApplication?.()
      || global.wps?.WppApplication?.()
      || global.wps?.Application
      || global.Application
      || null;
  }

  // 按宿主返回 ActiveDocument / ActiveWorkbook / ActivePresentation
  // 同时返回宿主标识，方便后续做 host-specific 调用
  function getActiveDoc() {
    const app = getApp();
    if (!app) return { app: null, doc: null, host: "*" };
    try { if (app.ActiveDocument) return { app, doc: app.ActiveDocument, host: "wps" }; } catch (e) {}
    try { if (app.ActiveWorkbook) return { app, doc: app.ActiveWorkbook, host: "et" }; } catch (e) {}
    try { if (app.ActivePresentation) return { app, doc: app.ActivePresentation, host: "wpp" }; } catch (e) {}
    return { app, doc: null, host: "*" };
  }

  // 当前文档的绝对路径（未保存过的"文档1"返回 null）
  function getCurrentDocPath() {
    const { doc } = getActiveDoc();
    if (!doc) return null;
    let fullName = null, p = null, n = null;
    try { fullName = doc.FullName; } catch (e) {}
    try { p = doc.Path; } catch (e) {}
    try { n = doc.Name; } catch (e) {}
    fullName = (fullName != null) ? String(fullName) : "";
    p = (p != null) ? String(p) : "";
    n = (n != null) ? String(n) : "";

    // 1) FullName 含路径分隔符即视为绝对路径
    if (/[/\\]/.test(fullName)) return fullName;
    // 2) FullName 已经是个绝对路径但 OS 路径符识别不到（比如 Mac 纯 UNIX 路径已被 1 覆盖；这里兜底）
    if (fullName.startsWith("/") || /^[A-Za-z]:/.test(fullName)) return fullName;
    // 3) 退路：拼 Path + Name；Path 必须看起来像绝对路径
    if (p && n && (/[/\\]/.test(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p))) {
      const sep = p.includes("\\") ? "\\" : "/";
      const tail = p.endsWith("/") || p.endsWith("\\") ? "" : sep;
      return `${p}${tail}${n}`;
    }
    return null;
  }

  // ---- UndoRecord helpers (MSO Word 风格,WPS Writer 也支持;ET/WPP 不支持就 silent fail) ----

  // 标记一个"我们启动了 UndoRecord"的全局位,防止重复 End
  let undoRecordOpen = false;

  function tryStartUndoGroup(app, name) {
    if (!app) return false;
    try {
      const ur = app.UndoRecord;
      if (ur && typeof ur.StartCustomRecord === "function") {
        ur.StartCustomRecord(name || "灵犀AI 操作");
        undoRecordOpen = true;
        return true;
      }
    } catch (e) { /* 不支持就算了 */ }
    return false;
  }

  function tryEndUndoGroup(app) {
    if (!app) return false;
    try {
      const ur = app.UndoRecord;
      if (ur && typeof ur.EndCustomRecord === "function") {
        ur.EndCustomRecord();
        undoRecordOpen = false;
        return true;
      }
    } catch (e) { /* */ }
    return false;
  }

  function tryUndoOnce(app) {
    if (!app) return false;
    // 各宿主的 Undo 入口不太一样:Writer/ET 多用 Application.Undo,
    // 没有的话退到 SendKeys ^z 当兜底(虽然不优雅但比关文档强)
    try { if (typeof app.Undo === "function") { app.Undo(); return true; } } catch (e) {}
    try {
      const { doc } = getActiveDoc();
      if (doc && typeof doc.Undo === "function") { doc.Undo(); return true; }
    } catch (e) {}
    return false;
  }

  // 外部调用:turn 结束时把 UndoRecord 关掉,这样下一次 Undo 一次性撤回整组
  function endUndoGroup() {
    if (!undoRecordOpen) return false;
    const { app } = getActiveDoc();
    return tryEndUndoGroup(app);
  }

  // ---- snapshot ----

  async function captureCurrentDoc() {
    const { app, doc, host } = getActiveDoc();
    if (!doc) return { ok: false, error: "未检测到打开的文档" };

    // 1. 取路径——未保存的新文档没路径，跳过备份
    const docPath = getCurrentDocPath();
    if (!docPath) {
      // 把能拿到的字段也带回去，方便排错
      let fullName = "", p = "", n = "";
      try { fullName = String(doc.FullName || ""); } catch (e) {}
      try { p = String(doc.Path || ""); } catch (e) {}
      try { n = String(doc.Name || ""); } catch (e) {}
      return { ok: false, error: `无法获取文档路径（未保存到磁盘？）。FullName="${fullName}" Path="${p}" Name="${n}"` };
    }

    // 2. 开 UndoRecord(在 Save 之前,这样 Save 不会进 undo 组里 — 不影响)
    //    这一步是"内容层回退"的关键。开成功就标记 undoGroup=true,回退时优先走 Undo。
    const undoGroup = tryStartUndoGroup(app, `灵犀AI - ${new Date().toISOString()}`);

    // 3. 让 WPS 把文档存盘（不弹保存框）
    try {
      if (typeof doc.Save === "function") doc.Save();
    } catch (e) {
      return { ok: false, error: `Save 失败：${e?.message || e}` };
    }

    // 4. POST 给代理做实际文件复制(作为 Undo 失效场景的兜底)
    try {
      const resp = await fetch(`${PROXY_BASE}/doc-snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docPath })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, error: `代理返回 ${resp.status}：${text.slice(0, 200)}` };
      }
      const json = await resp.json();
      return {
        ok: true,
        docPath,
        host,
        backupPath: json.backupPath,
        size: json.size,
        timestamp: json.timestamp || Date.now(),
        undoGroup
      };
    } catch (e) {
      return { ok: false, error: `代理连不上：${e?.message || e}` };
    }
  }

  // ---- restore ----

  // 双层回退:
  //   0. opts.tryUndo=true 时先试 Application.Undo() 撤回整组改动 → 不关文档,
  //      光标/视图/状态全保留。失败才走文件层。
  //   1. 文件层:关文档 → 代理覆盖磁盘 → 重开。
  async function restoreFromBackup(backupPath, targetPath, opts) {
    opts = opts || {};
    if (!backupPath || !targetPath) return { ok: false, error: "backupPath / targetPath 必填" };

    const { app, doc, host } = getActiveDoc();

    // ---- 0. 先试「内容层」: Application.Undo,不关文档 ----
    if (opts.tryUndo && app) {
      tryEndUndoGroup(app);
      const undone = tryUndoOnce(app);
      if (undone) {
        return { ok: true, method: "undo", reopened: false };
      }
      // Undo 不支持或失败 → 继续走文件层
    }

    // ---- 1. 文件层(降级): 关 → 覆盖 → 重开 ----
    let needReopen = false;
    if (doc) {
      const curPath = getCurrentDocPath();
      if (curPath && pathsEqual(curPath, targetPath)) {
        try {
          // Save=false：丢弃当前未保存改动（用户已确认要回退）
          doc.Close(false);
          needReopen = true;
        } catch (e) {
          return { ok: false, error: `关闭当前文档失败：${e?.message || e}` };
        }
      }
    }

    // 2. 让代理做文件覆盖
    try {
      const resp = await fetch(`${PROXY_BASE}/doc-restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupPath, targetPath })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, error: `代理返回 ${resp.status}：${text.slice(0, 200)}` };
      }
    } catch (e) {
      return { ok: false, error: `代理连不上：${e?.message || e}` };
    }

    // 3. 重新打开
    if (needReopen && app) {
      try {
        if (host === "wps" && app.Documents?.Open) app.Documents.Open(targetPath);
        else if (host === "et" && app.Workbooks?.Open) app.Workbooks.Open(targetPath);
        else if (host === "wpp" && app.Presentations?.Open) app.Presentations.Open(targetPath);
        else if (app.Documents?.Open) app.Documents.Open(targetPath);
      } catch (e) {
        return { ok: true, method: "file", reopened: false, warning: `恢复完成但未能自动重开文档：${e?.message || e}` };
      }
    }

    return { ok: true, method: "file", reopened: needReopen };
  }

  function pathsEqual(a, b) {
    if (!a || !b) return false;
    const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return norm(a) === norm(b);
  }

  // 列出某文档已有备份（用于排错 / UI 展示）
  async function listBackups(docPath) {
    if (!docPath) return { ok: false, error: "docPath 必填" };
    try {
      const url = `${PROXY_BASE}/doc-backups?docPath=${encodeURIComponent(docPath)}`;
      const resp = await fetch(url);
      if (!resp.ok) return { ok: false, error: `${resp.status}` };
      return await resp.json();
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  global.WpsAiBackup = {
    captureCurrentDoc,
    endUndoGroup,
    restoreFromBackup,
    getCurrentDocPath,
    listBackups
  };
})(window);
