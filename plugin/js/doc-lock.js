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

  // 固定 token —— 之前用随机密码,unprotect 万一失败就永远卡在被锁状态,
  // 用户也不知道密码(随机只存在内存里,plugin reload 就丢)。
  // 固定 token 的代价是任何拿到源码的人都能解锁——但这本来就是 UI 锁不是密码学保护,
  // 收益是出错时还能自救:下次启动看见残留保护 → 用 token 一解就解开了。
  const LOCK_TOKEN = "lingxi-ai-doc-lock-v1";

  let state = null;

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

  function lockWord(app) {
    const doc = app.ActiveDocument;
    if (!doc) return null;
    // 检查 doc 是否已经被保护。如果是,先用我们的 token 试解 ——
    // 解开了说明是上次没清干净的残留锁(可继续);解不开是用户/别处加的锁,不动它。
    try {
      if (doc.ProtectionType != null && doc.ProtectionType !== WD_NO_PROTECTION) {
        try {
          doc.Unprotect(LOCK_TOKEN);
          // 成功 → 这是我们留下的残留锁,doc 现在已解,继续走 Protect 重新建立 fresh lock
        } catch (e) {
          // 解不开 → 用户自己的保护,我们不接手
          console.warn("[doc-lock] 文档已被外部保护，跳过 AI 锁定");
          return { kind: "wps-already-protected", doc };
        }
      }
    } catch (e) {}
    try {
      doc.Protect(WD_ALLOW_ONLY_READING, true, LOCK_TOKEN, false, false);
      return { kind: "wps-protect", doc };
    } catch (e) {
      console.error("[doc-lock] Word Protect 失败:", e?.message || e);
      return null;
    }
  }

  function unlockWord(lockInfo) {
    if (!lockInfo) return;
    if (lockInfo.kind === "wps-already-protected") return; // 不是我们加的，不动
    try { lockInfo.doc.Unprotect(LOCK_TOKEN); }
    catch (e) { console.error("[doc-lock] Word Unprotect 失败:", e?.message || e); }
  }

  // 启动时主动尝试用 token 解一次：如果上次 AI session 没干净清掉保护,这里能自救
  function clearStaleWordLock() {
    try {
      const app = getApp();
      const doc = app?.ActiveDocument;
      if (!doc) return;
      if (doc.ProtectionType != null && doc.ProtectionType !== WD_NO_PROTECTION) {
        try {
          doc.Unprotect(LOCK_TOKEN);
          console.log("[doc-lock] 清理了上次残留的 AI 锁定");
        } catch (e) { /* 不是我们的锁,正常 */ }
      }
    } catch (e) {}
  }

  function lockExcel(app) {
    // 锁住当前 sheet（UserInterfaceOnly=true → UI 拦输入，COM 仍可改）
    const sheet = app.ActiveSheet;
    if (!sheet) return null;
    // 类似 Word: 先试用 token 解残留
    try {
      if (sheet.ProtectContents) {
        try { sheet.Unprotect(LOCK_TOKEN); } catch (e) { /* 不是我们加的 */ }
      }
    } catch (e) {}
    try {
      sheet.Protect(
        LOCK_TOKEN,          // Password
        true,                // DrawingObjects
        true,                // Contents
        true,                // Scenarios
        true,                // UserInterfaceOnly  ← 关键
        true                 // AllowFormattingCells
      );
      return { kind: "et-protect-sheet", sheet };
    } catch (e) {
      // 老版本调用参数兼容性问题，退到 named 调用
      try {
        sheet.Protect({ Password: LOCK_TOKEN, UserInterfaceOnly: true });
        return { kind: "et-protect-sheet", sheet };
      } catch (e2) {
        console.error("[doc-lock] Excel Protect 失败:", e2?.message || e2);
        return null;
      }
    }
  }

  function unlockExcel(lockInfo) {
    if (!lockInfo) return;
    try { lockInfo.sheet.Unprotect(LOCK_TOKEN); }
    catch (e) { console.error("[doc-lock] Excel Unprotect 失败:", e?.message || e); }
  }

  // 进入锁定。host 必须传准 ("wps" / "et" / "wpp")
  function lock(host) {
    if (state) return state;
    const app = getApp();
    if (!app) return null;
    const prevInteractive = setInteractive(app, false);
    let docLock = null;
    if (host === "wps") {
      docLock = lockWord(app);
    } else if (host === "et") {
      docLock = lockExcel(app);
    }
    // wpp 没有靠谱的 UI 锁，跳过 docLock
    state = { app, host, prevInteractive, docLock };
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
  // 没锁 / PPT / 用户已有保护一律直接调 fn，不影响主流程。
  async function tempUnlock(fn) {
    if (!state || state.host !== "wps" || !state.docLock || state.docLock.kind !== "wps-protect") {
      return await fn();
    }
    let unlocked = false;
    let prevInteractive = null;
    try {
      state.docLock.doc.Unprotect(LOCK_TOKEN);
      unlocked = true;
    } catch (e) {
      console.error("[doc-lock] tempUnlock 时 Unprotect 失败,工具写入可能被拒:", e?.message || e);
    }
    try {
      if ("Interactive" in state.app) {
        prevInteractive = state.app.Interactive;
        if (prevInteractive === false) state.app.Interactive = true;
      }
    } catch (e) {}
    try {
      return await fn();
    } finally {
      if (prevInteractive != null) {
        try { state.app.Interactive = prevInteractive; } catch (e) {}
      }
      // 只有刚才确实 unlock 成功了才需要再 Protect 回去
      if (unlocked) {
        try {
          state.docLock.doc.Protect(WD_ALLOW_ONLY_READING, true, LOCK_TOKEN, false, false);
        } catch (e) { console.error("[doc-lock] tempUnlock 后 re-Protect 失败:", e?.message || e); }
      }
    }
  }

  function isLocked() { return !!state; }

  // 启动时 / Pane 重启时主动清掉残留的 AI 锁定（如果有）。AI 锁定的 token 是固定的,
  // Unprotect 用 token 试一下:成功说明是我们之前没清干净,清掉即可;失败是用户加的锁,不动。
  function cleanupStaleLocks() {
    clearStaleWordLock();
    // Excel sheet 残留锁的清理略复杂(要遍历所有 sheet),先不做,等用户报告再补
  }

  // 自动启动时跑一次 cleanup
  setTimeout(cleanupStaleLocks, 1500);

  global.WpsAiLock = { lock, unlock, tempUnlock, isLocked, cleanupStaleLocks, LOCK_TOKEN };
})(window);
