/**
 * AI 工作期间的文档硬锁定。
 *
 * 三个宿主各有"最强能用"的锁定方式：
 *
 * - Word（WPS 文字）
 *     Document.Protect(wdAllowOnlyReading=3, NoReset, password, false, false)
 *     副作用：COM 修改也被拦。所以每次工具调用前要 Unprotect → 改 → 再 Protect。
 *     由 tempUnlock(fn) 包装。
 *
 * - Excel（WPS 表格）
 *     ActiveSheet.Protect(password, ..., UserInterfaceOnly=true)
 *     UserInterfaceOnly=true 是关键：UI 锁住但 COM/VBA 仍可改。一次锁住，
 *     工具调用全部直接走，不需要解-改-再锁。
 *
 * - PowerPoint（WPS 演示）
 *     没有原生 UI 锁。降级到 Application.Interactive=false（部分版本支持）
 *     + 选区轮询警告（在 app.js）。
 *
 * 失败一律 try/catch 静默；解锁也要在 finally 路径里能跑（unlock 永远尝试
 * 还原所有曾经动过的状态）。
 */
(function attachDocLock(global) {
  "use strict";

  // wdProtectionType
  const WD_NO_PROTECTION = -1;
  const WD_ALLOW_ONLY_READING = 3;

  let state = null;

  function genPassword() {
    return "lingxi-" + Math.random().toString(36).slice(2, 10);
  }

  function getApp() {
    return global.wps?.WpsApplication?.()
      || global.wps?.EtApplication?.()
      || global.wps?.WppApplication?.()
      || global.wps?.Application
      || global.Application
      || null;
  }

  function setInteractive(app, v) {
    try {
      if ("Interactive" in app) {
        const prev = app.Interactive;
        app.Interactive = v;
        return prev;
      }
    } catch (e) {}
    return null;
  }

  function lockWord(app, password) {
    const doc = app.ActiveDocument;
    if (!doc) return null;
    // 已经被别处保护了，不动它
    try {
      if (doc.ProtectionType != null && doc.ProtectionType !== WD_NO_PROTECTION) {
        return { kind: "wps-already-protected", doc };
      }
    } catch (e) {}
    try {
      doc.Protect(WD_ALLOW_ONLY_READING, true, password, false, false);
      return { kind: "wps-protect", doc, password };
    } catch (e) {
      return null;
    }
  }

  function unlockWord(lockInfo) {
    if (!lockInfo) return;
    if (lockInfo.kind === "wps-already-protected") return; // 不是我们加的，不动
    try { lockInfo.doc.Unprotect(lockInfo.password); } catch (e) {}
  }

  function lockExcel(app, password) {
    // 锁住当前 sheet（UserInterfaceOnly=true → UI 拦输入，COM 仍可改）
    const sheet = app.ActiveSheet;
    if (!sheet) return null;
    try {
      sheet.Protect(
        password,            // Password
        true,                // DrawingObjects
        true,                // Contents
        true,                // Scenarios
        true,                // UserInterfaceOnly  ← 关键
        true                 // AllowFormattingCells
      );
      return { kind: "et-protect-sheet", sheet, password };
    } catch (e) {
      // 老版本调用参数兼容性问题，退到 named 调用
      try {
        sheet.Protect({ Password: password, UserInterfaceOnly: true });
        return { kind: "et-protect-sheet", sheet, password };
      } catch (e2) { return null; }
    }
  }

  function unlockExcel(lockInfo) {
    if (!lockInfo) return;
    try { lockInfo.sheet.Unprotect(lockInfo.password); } catch (e) {}
  }

  // 进入锁定。host 必须传准 ("wps" / "et" / "wpp")
  function lock(host) {
    if (state) return state;
    const app = getApp();
    if (!app) return null;
    const password = genPassword();
    const prevInteractive = setInteractive(app, false);
    let docLock = null;
    if (host === "wps") {
      docLock = lockWord(app, password);
    } else if (host === "et") {
      docLock = lockExcel(app, password);
    }
    // wpp 没有靠谱的 UI 锁，跳过 docLock
    state = { app, host, password, prevInteractive, docLock };
    return state;
  }

  function unlock() {
    if (!state) return;
    const { app, host, prevInteractive, docLock } = state;
    if (host === "wps") unlockWord(docLock);
    else if (host === "et") unlockExcel(docLock);
    if (prevInteractive != null) {
      try { app.Interactive = prevInteractive; } catch (e) {}
    }
    state = null;
  }

  // 给 Word 用：临时解锁执行 fn，结束后立即再锁回去。
  // Excel 不用调（UserInterfaceOnly 已经允许 COM 写）。
  // 没锁 / PPT / 异常一律直接调 fn，不影响主流程。
  async function tempUnlock(fn) {
    if (!state || state.host !== "wps" || !state.docLock || state.docLock.kind !== "wps-protect") {
      return await fn();
    }
    try { state.docLock.doc.Unprotect(state.docLock.password); } catch (e) {}
    try {
      return await fn();
    } finally {
      try {
        state.docLock.doc.Protect(WD_ALLOW_ONLY_READING, true, state.docLock.password, false, false);
      } catch (e) { /* 工具结束时可能 doc 已关，吞错 */ }
    }
  }

  function isLocked() { return !!state; }

  global.WpsAiLock = { lock, unlock, tempUnlock, isLocked };
})(window);
