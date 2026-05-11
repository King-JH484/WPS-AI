/**
 * 文档级备份 + 恢复（per-turn 粒度）。
 *
 * 三个核心 API：
 *   - captureCurrentDoc()  → 让 WPS 把当前文档 Save 一下，把磁盘文件 POST
 *                            给 proxy 备份；返回 { ok, docPath, backupPath, size }
 *   - restoreFromBackup(backupPath, targetPath) → 让 WPS 关掉当前文档，
 *                            proxy 把 backup 拷回原路径，再让 WPS 重新打开
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
    try {
      const full = doc.FullName || doc.Path && doc.Name ? null : null;
      const candidate1 = doc.FullName;
      if (candidate1 && typeof candidate1 === "string" && /[/\\]/.test(candidate1)) {
        return String(candidate1);
      }
      // 退路：拼 Path + Name
      const p = doc.Path;
      const n = doc.Name;
      if (p && n && /[/\\]/.test(p)) return `${p}${p.endsWith("\\") || p.endsWith("/") ? "" : (p.includes("\\") ? "\\" : "/")}${n}`;
    } catch (e) {}
    return null;
  }

  // ---- snapshot ----

  async function captureCurrentDoc() {
    const { doc, host } = getActiveDoc();
    if (!doc) return { ok: false, error: "未检测到打开的文档" };

    // 1. 取路径——未保存的新文档没路径，跳过备份
    const docPath = getCurrentDocPath();
    if (!docPath) {
      return { ok: false, error: "当前文档尚未保存，无路径可备份" };
    }

    // 2. 让 WPS 把文档存盘（不弹保存框）
    try {
      if (typeof doc.Save === "function") doc.Save();
    } catch (e) {
      return { ok: false, error: `Save 失败：${e?.message || e}` };
    }

    // 3. POST 给代理做实际文件复制
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
        timestamp: json.timestamp || Date.now()
      };
    } catch (e) {
      return { ok: false, error: `代理连不上：${e?.message || e}` };
    }
  }

  // ---- restore ----

  // 关文档 → 让代理覆盖文件 → 重开
  async function restoreFromBackup(backupPath, targetPath) {
    if (!backupPath || !targetPath) return { ok: false, error: "backupPath / targetPath 必填" };

    const { app, doc, host } = getActiveDoc();

    // 1. 如果当前打开的就是目标文档，先关掉（不保存当前未存的改动）
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
        return { ok: true, reopened: false, warning: `恢复完成但未能自动重开文档：${e?.message || e}` };
      }
    }

    return { ok: true, reopened: needReopen };
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
    restoreFromBackup,
    getCurrentDocPath,
    listBackups
  };
})(window);
