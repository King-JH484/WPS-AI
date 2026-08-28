(function attachWpsAddonAdapter(global) {
  "use strict";

  const PREVIEW_LOG_KEY = "anthony_preview_log_v1";
  const CONSOLE_BRIDGE_KEY = "anthony_console_bridge_v1";

  function getLogStore() {
    return global.WpsAiStore || global.localStorage || null;
  }

  function installLogConsoleHelpers() {
    if (typeof global.__anthonyDumpLogs !== "function") {
      global.__anthonyDumpLogs = function () {
        try {
          const store = getLogStore();
          const raw = store?.getItem?.(PREVIEW_LOG_KEY);
          const list = raw ? (JSON.parse(raw) || []) : [];
          const text = list.map((e) => {
            const t = new Date(e.ts).toISOString().slice(11, 23);
            return `${t} [${e.level}][${e.where}][${e.tag}] ${e.msg}`;
          }).join("\n");
          console.log(text || "(no logs)");
          return text;
        } catch (e) {
          console.warn("dump failed:", e);
          return "";
        }
      };
    }
    if (typeof global.__anthonyClearLogs !== "function") {
      global.__anthonyClearLogs = function () {
        try {
          const store = getLogStore();
          store?.removeItem?.(PREVIEW_LOG_KEY);
          console.log("logs cleared");
        } catch (e) {
          console.warn("clear failed:", e);
        }
      };
    }
    if (typeof global.__anthonyCopyLogs !== "function") {
      global.__anthonyCopyLogs = async function () {
        const text = global.__anthonyDumpLogs?.() || "";
        try {
          if (global.navigator?.clipboard?.writeText) {
            await global.navigator.clipboard.writeText(text);
            console.log("logs copied to clipboard (" + text.length + " chars)");
          }
        } catch (e) {
          console.warn("copy failed:", e);
        }
        return text;
      };
    }
    if (typeof global.__anthonyDumpBridge !== "function") {
      global.__anthonyDumpBridge = function () {
        try {
          const store = getLogStore();
          const raw = store?.getItem?.(CONSOLE_BRIDGE_KEY) || "";
          console.log(raw || "(no bridge log)");
          return raw;
        } catch (e) {
          console.warn("dump bridge failed:", e);
          return "";
        }
      };
    }
  }

  installLogConsoleHelpers();

  function installConsoleBridgeListener() {
    const seen = new Set();
    let lastRaw = "";
    const printBridge = (raw) => {
      if (!raw) return;
      if (raw === lastRaw) return;
      lastRaw = raw;
      try {
        const entry = JSON.parse(raw);
        if (!entry?.id || seen.has(entry.id)) return;
        seen.add(entry.id);
        if (seen.size > 200) {
          const first = seen.values().next().value;
          seen.delete(first);
        }
        console.log(`[anthony-bridge][${entry.kind || "log"}]`, entry.payload || {});
      } catch (e) {}
    };
    try {
      const store = getLogStore();
      printBridge(store?.getItem?.(CONSOLE_BRIDGE_KEY));
    } catch (e) {}
    try {
      global.addEventListener?.("storage", (ev) => {
        if (ev?.key === CONSOLE_BRIDGE_KEY) printBridge(ev.newValue);
      });
    } catch (e) {}
    try {
      global.setInterval?.(() => {
        try {
          const store = getLogStore();
          printBridge(store?.getItem?.(CONSOLE_BRIDGE_KEY));
        } catch (e) {}
      }, 500);
    } catch (e) {}
  }

  installConsoleBridgeListener();

  // 存储 TaskPane id 的 PluginStorage 键名。
  // 后缀 _v11：v10 的 80%/[1200,2200] 视觉上确实生效到 965（WPS docked 天花板），
  // 但用户反馈太宽，砍一半到 40%/[600,1100]（即 v9 参数集）。
  // bump 后强制 WPS 下次重建 pane 拿新宽度。
  const TASKPANE_STORAGE_KEY = "anthony_ai_taskpane_id_v11";

  // 默认 TaskPane 宽度 —— 按当前显示器 40% 自适应：
  //   - 40% 屏幕宽
  //   - 最少 600（笔记本 1366px 屏上保证 header 不被压惨；窄场景靠 CSS @media 适配）
  //   - 最多 1100（4K 屏上再宽就压文档可视区）
  // 常见屏幕对应宽度：1366→600 / 1440→600 / 1920→768 / 2560→1024 / 3840→1100
  // WPS docked 内部上限约 50% 主窗口宽，所以 1920 屏上 768 不会被 clamp，正好生效
  function pickDefaultTaskPaneWidth() {
    const sw = (global.screen && (global.screen.availWidth || global.screen.width)) || 1920;
    return Math.max(600, Math.min(1100, Math.round(sw * 0.4)));
  }

  // 设置 TaskPane 宽度。
  //
  // 观察：用户报告"点完模板画廊（一次 ShowDialog modal）后 pane 变宽了"。
  // 推断：ShowDialog 关闭时 WPS 主窗口会做一次 re-layout，那次 re-layout 它
  // 会重新读 pane.Width 属性应用上去。所以光是首次 set pane.Width 没用，
  // 缺一次"触发 layout"的契机。
  //
  // 现在策略：
  //   1) 立即写一次（多数版本会被 clamp）
  //   2) 50/200/500/1500ms 各重写一次（碰碰运气，部分版本第 N 次会接受）
  //   3) 1000ms 时调一次轻量"无窗 dialog"或回退到 DockPosition 切换，强行触发
  //      WPS re-layout 让属性值生效（如果 ShowDialog 有副作用就用它，没有就用切 dock）
  function applyTaskPaneWidth(pane, width, tag) {
    if (!pane) return;
    const setOnce = (label) => {
      try {
        if ("Width" in pane) {
          pane.Width = width;
          let actual = "n/a";
          try { actual = pane.Width; } catch (e) {}
          console.log(`[wps-ai] (${tag}/${label}) Width=${width} → 读回 ${actual}`);
          return;
        }
      } catch (e) {
        console.warn(`[wps-ai] (${tag}/${label}) 设 Width 失败:`, e?.message || e);
      }
      if (typeof pane.SetWidth === "function") {
        try { pane.SetWidth(width); } catch (e) {}
      }
    };
    setOnce("t0");
    setTimeout(() => setOnce("t+50"), 50);
    setTimeout(() => setOnce("t+200"), 200);
    setTimeout(() => {
      setOnce("t+500");
      // 主动触发一次 WPS layout —— DockPosition 切到同一值，部分版本会重读 Width 属性
      try {
        const cur = pane.DockPosition;
        pane.DockPosition = cur; // 重新赋同值，触发 setter side effect
      } catch (e) {}
      setOnce("after-layout-poke");
    }, 500);
    setTimeout(() => setOnce("t+1500"), 1500);
  }
  // ribbon 点击的快捷指令通过这个 key 传给 taskpane 消费
  const PENDING_ACTION_KEY = "anthony_ai_pending_action";
  const PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY = "anthony_parallel_translate_dialog_request_v1";

  function detectHostByApp(app) {
    if (!app) return "unknown";
    // PDF 在 wps 兜底前先判，否则 ActiveDocument 兜底会把 PDF 误判成 wps
    try { if (app.ActivePDF) return "pdf"; } catch (e) {}
    try { if (app.ActivePdf) return "pdf"; } catch (e) {}
    try { if (app.ActivePDFDocument) return "pdf"; } catch (e) {}
    try { if (app.ActiveWorkbook) return "et"; } catch (e) {}
    try { if (app.ActivePresentation) return "wpp"; } catch (e) {}
    try { if (app.ActiveDocument) return "wps"; } catch (e) {}
    try { if (app.Workbooks) return "et"; } catch (e) {}
    try { if (app.Presentations) return "wpp"; } catch (e) {}
    try { if (app.Documents) return "wps"; } catch (e) {}
    return "unknown";
  }

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function pickString(value) {
    return (typeof value === "string" && value.trim()) ? value.trim() : "";
  }

  function isThenable(value) {
    return value && typeof value.then === "function";
  }

  async function resolveMaybe(value) {
    return isThenable(value) ? await value : value;
  }

  function withTimeout(promise, ms, fallback) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function normalizeMaybeFileUrl(raw) {
    let value = pickString(raw);
    if (!value) return "";
    if (!/^file:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      let pathname = decodeURIComponent(url.pathname || "");
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
      return pathname || value;
    } catch (e) {
      return value.replace(/^file:\/\//i, "");
    }
  }

  const PDF_DOC_KEYS = [
    "ActivePDF", "ActivePdf", "ActivePDFDocument", "ActivePdfDoc",
    "ActiveDocument", "Document", "PDF", "Pdf"
  ];
  const PDF_PATH_KEYS = [
    "FullName", "FullPath", "FilePath", "DocumentPath", "LocalPath",
    "Path", "FolderPath", "Directory", "Dir", "Url", "URL", "Location",
    "SourceFullName", "SourcePath", "FileName", "Name", "Title"
  ];
  const PDF_PATH_METHODS = [
    "GetFullName", "GetFullPath", "GetFilePath", "GetDocumentPath",
    "GetLocalPath", "GetPath", "GetFileName", "GetName", "GetTitle"
  ];
  const PDF_BUILTIN_PROPS = [
    "FullName", "FullPath", "FilePath", "DocumentPath", "Path",
    "FileName", "Name", "Title", "Subject"
  ];

  function isAbsoluteLikePath(value) {
    return /^file:\/\//i.test(value)
      || value.startsWith("/")
      || /^[A-Za-z]:[\\/]/.test(value)
      || /^\\\\/.test(value);
  }

  function joinPathLike(dir, name) {
    const d = pickString(dir);
    const n = pickString(name);
    if (!d || !n) return "";
    if (!isAbsoluteLikePath(d)) return "";
    const sep = d.includes("\\") ? "\\" : "/";
    return d.replace(/[\\/]+$/, "") + sep + n.replace(/^[\\/]+/, "");
  }

  function normalizePdfPathCandidate(raw, carrier) {
    let value = normalizeMaybeFileUrl(raw);
    if (!value) return "";
    if (isAbsoluteLikePath(value) && /\.pdf(?:$|[?#])/i.test(value)) return value;
    const looksLikeDir = isAbsoluteLikePath(value) && (/[\\/]$/.test(value) || !/\.[a-zA-Z0-9]{1,8}$/.test(value));
    if (looksLikeDir && carrier) {
      const name = pickString(carrier.Name) || pickString(carrier.FileName) || pickString(carrier.Title);
      const joined = joinPathLike(value, name);
      if (/\.pdf(?:$|[?#])/i.test(joined)) return joined;
    }
    return "";
  }

  function getActivePdfDocFromApp(app) {
    if (!app) return null;
    for (const key of PDF_DOC_KEYS.slice(0, 4)) {
      try { if (app[key]) return app[key]; } catch (e) {}
    }
    return null;
  }

  async function getActivePdfDocFromAppAsync(app) {
    if (!app) return null;
    for (const key of PDF_DOC_KEYS) {
      try {
        const value = await resolveMaybe(app[key]);
        if (value) return value;
      } catch (e) {}
    }
    try {
      const win = await resolveMaybe(app.ActiveWindow);
      if (win) {
        for (const key of PDF_DOC_KEYS) {
          try {
            const value = await resolveMaybe(win[key]);
            if (value) return value;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  }

  async function readPdfPathFromCarrier(carrier) {
    if (!carrier) return "";
    for (const key of PDF_PATH_KEYS) {
      try {
        const path = normalizePdfPathCandidate(await resolveMaybe(carrier[key]), carrier);
        if (path) return path;
      } catch (e) {}
    }
    const pathPart = (() => {
      for (const key of ["Path", "DocumentPath", "FolderPath", "Directory", "Dir"]) {
        try {
          const value = normalizeMaybeFileUrl(pickString(carrier[key]));
          if (value) return value;
        } catch (e) {}
      }
      return "";
    })();
    const namePart = (() => {
      for (const key of ["Name", "FileName", "Title"]) {
        try {
          const value = pickString(carrier[key]);
          if (value) return value;
        } catch (e) {}
      }
      return "";
    })();
    const joined = joinPathLike(pathPart, namePart);
    if (/\.pdf(?:$|[?#])/i.test(joined)) return joined;

    for (const key of PDF_PATH_METHODS) {
      try {
        const fn = carrier[key];
        if (typeof fn !== "function") continue;
        const path = normalizePdfPathCandidate(await resolveMaybe(fn.call(carrier)), carrier);
        if (path) return path;
      } catch (e) {}
    }
    try {
      const fn = carrier.BuiltinDocumentProperties;
      if (typeof fn === "function") {
        for (const name of PDF_BUILTIN_PROPS) {
          try {
            const prop = await resolveMaybe(fn.call(carrier, name));
            const raw = prop && typeof prop === "object" ? prop.Value : prop;
            const path = normalizePdfPathCandidate(await resolveMaybe(raw), carrier);
            if (path) return path;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return "";
  }

  function getActivePdfPathFromApp(app) {
    const pdf = getActivePdfDocFromApp(app);
    if (!pdf) return "";
    const direct = normalizePdfPathCandidate(
      pickString(pdf.FullName)
      || pickString(pdf.FullPath)
      || pickString(pdf.FilePath)
      || pickString(pdf.DocumentPath)
      || pickString(pdf.Path),
      pdf
    );
    if (direct) return direct;
    const joined = joinPathLike(pickString(pdf.Path) || pickString(pdf.DocumentPath) || pickString(pdf.FolderPath), pickString(pdf.Name) || pickString(pdf.FileName) || pickString(pdf.Title));
    return /\.pdf(?:$|[?#])/i.test(joined) ? joined : "";
  }

  async function getActivePdfPathFromAppAsync(app) {
    const resolvedApp = await resolveMaybe(app || getApplicationSync());
    const pdf = await getActivePdfDocFromAppAsync(resolvedApp);
    return await readPdfPathFromCarrier(pdf) || await readPdfPathFromCarrier(resolvedApp);
  }

  async function resolvePdfPathForRibbon(app, hint, timeoutMs) {
    const hinted = pickString(hint);
    if (hinted && /\.pdf(?:$|[?#])/i.test(hinted)) return hinted;
    const t0 = Date.now();
    const resolvedApp = await resolveMaybe(app || getApplicationSync() || getApplication());
    let path = await withTimeout(getActivePdfPathFromAppAsync(resolvedApp), timeoutMs || 900, "");
    debugLog("resolvePdfPathForRibbon.step", { step: "getActivePdfPathFromAppAsync", ms: Date.now() - t0, found: !!path });
    if (!path) {
      path = await withTimeout(global.WpsAiHostPdf?.getActivePdfPath?.(), timeoutMs || 900, "");
      debugLog("resolvePdfPathForRibbon.step", { step: "WpsAiHostPdf", ms: Date.now() - t0, found: !!path, hasFn: typeof global.WpsAiHostPdf?.getActivePdfPath === "function" });
    }
    if (!path) {
      path = await withTimeout(fetchActivePdfPathFromProxy(), timeoutMs || 900, "");
      debugLog("resolvePdfPathForRibbon.step", { step: "fetchActivePdfPathFromProxy", ms: Date.now() - t0, found: !!path, path });
    }
    return pickString(path);
  }

  async function fetchActivePdfPathFromProxy() {
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const resp = await fetch(base + "/active-pdf-path", { method: "GET", cache: "no-store" });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        debugLog("fetchActivePdfPathFromProxy.bad-status", { base, status: resp.status, payload });
        return "";
      }
      return pickString(payload.path);
    } catch (e) {
      debugLog("fetchActivePdfPathFromProxy.error", { message: String(e && e.message || e) });
      return "";
    }
  }

  function getPdfPathDebugFromApp(app) {
    const pdf = getActivePdfDocFromApp(app);
    const fields = {};
    if (pdf) {
      PDF_PATH_KEYS.forEach((key) => {
        try { fields[key] = pickString(pdf[key]); } catch (e) { fields[key] = `[throw:${e?.message || e}]`; }
      });
    }
    return {
      hasApp: !!app,
      host: detectHostByApp(app),
      hasPdf: !!pdf,
      fields
    };
  }

  function summarizeProbeValue(value) {
    if (value == null) return value;
    if (isThenable(value)) return "[Promise]";
    const type = typeof value;
    if (type === "string") return value.length > 240 ? value.slice(0, 240) + "..." : value;
    if (type === "number" || type === "boolean") return value;
    if (type === "function") return "[Function]";
    try {
      const tag = Object.prototype.toString.call(value);
      return tag || "[Object]";
    } catch (e) {
      return "[Object]";
    }
  }

  // mac r3: PDF 宿主下 appFields 全为 undefined、CommandBars/CreateTaskPane 都不存在，
  // 说明拿到的 Application 是个空壳。先把宿主真实暴露的成员枚举出来，
  // 再决定 PDF 的文档路径能从哪里取；纯 typeof 检查，同步且不会抛。
  function probeHostSurface(app) {
    const out = { globals: {}, appOwn: [], appProbe: {} };
    const GLOBAL_CANDIDATES = [
      "wps", "et", "wpp", "pdf", "Application", "WpsApplication",
      "PdfApplication", "PDFApplication", "OfficeApplication", "_Application"
    ];
    for (const key of GLOBAL_CANDIDATES) {
      try {
        const value = global[key];
        if (value !== undefined && value !== null) out.globals[key] = typeof value;
      } catch (e) {}
    }
    const APP_CANDIDATES = [
      "ActivePDF", "ActiveDocument", "ActiveWindow", "Documents", "Windows",
      "CommandBars", "CreateTaskPane", "CreateTaskpane", "ShowDialog",
      "Name", "Version", "Path", "ActivePrinter", "Selection", "Api", "Enum"
    ];
    for (const key of APP_CANDIDATES) {
      try {
        const value = app ? app[key] : undefined;
        if (value !== undefined && value !== null) out.appProbe[key] = typeof value;
      } catch (e) {
        out.appProbe[key] = "[throw]";
      }
    }
    try {
      const seen = [];
      for (const key in app) { seen.push(key); if (seen.length >= 60) break; }
      out.appOwn = seen;
    } catch (e) { out.appOwn = ["[enum-throw]"]; }
    try {
      const wpsObj = global.wps;
      if (wpsObj && wpsObj !== app) {
        const wpsSeen = [];
        for (const key in wpsObj) { wpsSeen.push(key); if (wpsSeen.length >= 60) break; }
        out.wpsOwn = wpsSeen;
      }
    } catch (e) {}
    return out;
  }

  // mac r3: PDF 宿主的 Application 是标签页外壳（BrowserWindow/ThisBrowser/Prome*），
  // 没有任何文档对象，所以拿不到 PDF 路径。但标签栏显示着文件名，说明外壳知道当前文档，
  // 路径可能挂在这些外壳对象上。这里把它们的成员和字符串值扫出来找路径线索。
  let browserSurfaceLogged = false;

  function probeBrowserSurface(app) {
    const out = {};
    const PATH_HINTS = [
      "Path", "FilePath", "FullName", "FullPath", "LocalPath", "Url", "URL",
      "Location", "Title", "Name", "FileName", "DocPath", "DocumentPath",
      "CurrentPath", "ActivePath", "TabPath", "Src", "Source"
    ];
    const targets = {};
    try { if (app && app.ThisBrowser) targets.ThisBrowser = app.ThisBrowser; } catch (e) {}
    try {
      if (app && typeof app.GetBrowserWindow === "function") targets.GetBrowserWindow = app.GetBrowserWindow();
    } catch (e) { out.GetBrowserWindowThrow = String((e && e.message) || e); }
    try { if (app && app.BrowserWindow) targets.BrowserWindow = app.BrowserWindow; } catch (e) {}
    try { if (app && app.BrowserGroups) targets.BrowserGroups = app.BrowserGroups; } catch (e) {}
    try { if (app && app.Env) targets.Env = app.Env; } catch (e) {}
    try {
      if (app && typeof app.PromeName === "function") out.PromeNameCall = String(app.PromeName()).slice(0, 300);
      else if (app && app.PromeName != null) out.PromeName = String(app.PromeName).slice(0, 300);
    } catch (e) { out.PromeNameThrow = String((e && e.message) || e); }

    for (const name of Object.keys(targets)) {
      const obj = targets[name];
      const rec = { type: typeof obj, keys: [], strings: {} };
      try {
        rec.caps = {
          CreateTaskPane: hasCreateTaskPaneApi(obj),
          ActiveDocument: !!(obj && obj.ActiveDocument),
          ActivePDF: !!(obj && obj.ActivePDF),
          Documents: !!(obj && obj.Documents)
        };
      } catch (e) { rec.caps = "[throw]"; }
      if (!obj || (typeof obj !== "object" && typeof obj !== "function")) { rec.value = String(obj).slice(0, 200); out[name] = rec; continue; }
      try {
        const keys = [];
        for (const key in obj) { keys.push(key); if (keys.length >= 60) break; }
        rec.keys = keys;
      } catch (e) { rec.keys = ["[enum-throw]"]; }
      const sweep = rec.keys.concat(PATH_HINTS);
      for (const key of sweep) {
        try {
          const value = obj[key];
          if (typeof value === "string" && value) rec.strings[key] = value.slice(0, 200);
          else if (typeof value === "number" || typeof value === "boolean") rec.strings[key] = value;
        } catch (e) {}
      }
      out[name] = rec;
    }
    return out;
  }

  // mac r4: 上一轮只记录了 BrowserGroups / ThisBrowser 这两个容器本身的 caps 就下了
  // "PDF 下没有任何可用对象" 的结论 —— 但它们都带 Item 访问器，容器里的成员从没被打开过。
  // BrowserGroups.Count 在只开 PDF 时是 1、开了 docx+PDF 时是 2，很像标签/文档列表。
  // 这里把容器逐个展开，同时把 Application / wps 的完整键表和所有 *Application() 工厂
  // 的真实返回值扫出来，用来判断 PDF 独占会话里到底有没有能建任务窗格的对象。
  // 探针本身也走 JSAPI 桥，深度遍历可能上千次属性读 —— 那正是我怀疑会把 WPS 压卡死的
  // 操作。所以给整轮探测一个硬预算，用完就停，宁可少拿数据也不能把宿主拖垮。
  let probeReadBudget = 0;
  function probeSpend() {
    if (probeReadBudget <= 0) return false;
    probeReadBudget -= 1;
    return true;
  }

  function describeObj(obj, depth) {
    const rec = { type: typeof obj };
    if (obj === null || obj === undefined) { rec.value = String(obj); return rec; }
    if (typeof obj !== "object" && typeof obj !== "function") { rec.value = String(obj).slice(0, 200); return rec; }
    if (!probeSpend()) { rec.truncated = true; return rec; }
    try {
      rec.caps = {
        CreateTaskPane: hasCreateTaskPaneApi(obj),
        GetTaskPane: typeof obj.GetTaskPane === "function",
        ActiveDocument: !!obj.ActiveDocument,
        ActivePDF: !!obj.ActivePDF,
        Documents: !!obj.Documents
      };
    } catch (e) { rec.caps = "[throw]"; }
    const keys = [];
    try { for (const key in obj) { keys.push(key); if (keys.length >= 60) break; } } catch (e) { keys.push("[enum-throw]"); }
    rec.keys = keys;
    rec.strings = {};
    for (const key of keys) {
      if (!probeSpend()) { rec.truncated = true; break; }
      try {
        const value = obj[key];
        if (typeof value === "string" && value) rec.strings[key] = value.slice(0, 240);
        else if (typeof value === "number" || typeof value === "boolean") rec.strings[key] = value;
      } catch (e) {}
    }
    // 展开 Item 容器。WPS 的集合有的 0 基有的 1 基，两种都试。
    if (depth > 0 && typeof obj.Item === "function") {
      rec.items = [];
      const count = Number(obj.Count);
      const max = Number.isFinite(count) && count > 0 ? Math.min(count, 4) : 2;
      for (let i = 0; i <= max; i += 1) {
        if (!probeSpend()) { rec.truncated = true; break; }
        try {
          const child = obj.Item(i);
          if (child === null || child === undefined) continue;
          rec.items.push({ index: i, info: describeObj(child, depth - 1) });
        } catch (e) {
          rec.items.push({ index: i, error: String((e && e.message) || e).slice(0, 120) });
        }
      }
    }
    return rec;
  }

  function probeDeepHost(app) {
    probeReadBudget = 400;
    const out = { factories: {}, taskPaneLikeKeys: {} };
    // 每个 *Application() 工厂的真实返回值 —— 只开 PDF 时到底哪个还活着。
    const FACTORIES = [
      "WpsApplication", "EtApplication", "WppApplication", "PdfApplication",
      "PDFApplication", "KPdfApplication", "KsoApplication", "Application"
    ];
    for (const name of FACTORIES) {
      try {
        const holder = global.wps;
        const member = holder ? holder[name] : undefined;
        if (member === undefined) { out.factories[name] = "undefined"; continue; }
        const value = typeof member === "function" ? member.call(holder) : member;
        out.factories[name] = value
          ? { got: typeof value, createTaskPane: hasCreateTaskPaneApi(value), keys: describeObj(value, 0).keys }
          : "null";
      } catch (e) { out.factories[name] = "[throw] " + String((e && e.message) || e).slice(0, 120); }
    }
    // Application / wps 的完整键表 + 任何看起来像任务窗格的成员名（可能不叫 CreateTaskPane）。
    const roots = { Application: app, wps: global.wps };
    for (const name of Object.keys(roots)) {
      const obj = roots[name];
      out[name] = describeObj(obj, 0);
      const hits = [];
      try {
        for (const key in obj) {
          if (/task|pane|panel|dock|sidebar|side_bar/i.test(key)) hits.push(key + ":" + typeof obj[key]);
        }
      } catch (e) {}
      out.taskPaneLikeKeys[name] = hits;
    }
    // 容器展开：标签/文档列表最可能藏在这里，PDF 路径也可能。
    for (const name of ["BrowserGroups", "ThisBrowser", "Documents", "Windows"]) {
      try { if (app && app[name]) out[name] = describeObj(app[name], 2); } catch (e) {}
    }
    try { if (app?.Env && typeof app.Env.GetPID === "function") out.pid = app.Env.GetPID(); } catch (e) {}
    return out;
  }

  function logBrowserSurfaceOnce(app, site) {
    if (browserSurfaceLogged) return;
    browserSurfaceLogged = true;
    try { debugLog("pdf.browser-surface", { site, surface: probeBrowserSurface(app) }); } catch (e) {}
    try { debugLog("pdf.deep-probe", { site, deep: probeDeepHost(app) }); } catch (e) {}
  }

  // mac r5: PDF 宿主没有 CreateTaskPane，但原生 WPS AI 在同一个宿主里确实是内嵌侧边栏的，
  // 说明内嵌能力存在、只是不走标准任务窗格 API。宿主上那组 Prome*（promecefpluginhost，
  // WPS 自己的 WebView 容器框架）是唯一可能的入口。
  //
  // 探测手法：零参调用。WPS 的桥接层在参数缺失时会把参数名报出来
  //（已知样本：GetBrowserWindow() → "缺少必要参数browser."），所以零参调用的异常文本
  // 本身就是签名说明书，且因为参数不全不会真的建出东西，副作用可控。
  // PromeNewDocument 例外——它零参很可能真的新建一个文档，故不探测。
  var PROME_PROBE_SKIP = { PromeNewDocument: true };

  function probePromeApi(app) {
    var out = { present: [], signatures: {}, arity: {}, types: {} };
    if (!app) return { error: "no app" };
    var names = [];
    try {
      for (var k in app) { if (/^(Create)?Prome/i.test(k) || /Prome/i.test(k)) names.push(k); }
    } catch (e) { return { error: String((e && e.message) || e) }; }
    names.forEach(function (name) {
      var fn = null;
      try { fn = app[name]; } catch (e) { out.signatures[name] = "读取抛错: " + String((e && e.message) || e); return; }
      out.present.push(name + ":" + typeof fn);
      if (typeof fn !== "function") return;
      try { out.arity[name] = fn.length; } catch (e) {}
      if (PROME_PROBE_SKIP[name]) { out.signatures[name] = "(跳过：零参可能有副作用)"; return; }
      out.signatures[name] = probePromeSignature(app, fn);
      // r7: 上一轮 probePromeSignature 只能报出「参数类型错误(第0个)」就卡住了。
      // 这一轮用类型轮换 oracle 逐位逼近真实签名。
      try {
        out.types = out.types || {};
        out.types[name] = probePromeTypeOracle(app, fn);
      } catch (e) {
        out.types[name] = { error: String((e && e.message) || e) };
      }
    });
    return out;
  }

  // r9: Prome 全族已证死路（18 种类型在第 0 位全被拒，报错文本完全一致，
  // 说明那不是真的类型校验，而是「这个方法不对插件 JS 开放」的统一回绝）。
  // 转而枚举 Application 上剩下没试过的、名字像「能开出界面」的方法，只做零参调用读参数名，
  // 不补参数、不重试——参数不齐时桥接层不会真建出东西，副作用可控。
  function probeDialogSurface(app) {
    var TARGETS = [
      "ShowDialogEx", "ShowDialog", "OpenWebUrl", "CreatePromeFakeTab",
      "PromeAddPage", "ActivatePromeBrowserPage", "CreatePromeBrowserPage",
      "GetTaskPane", "CreateTaskPane", "GetBrowserWindow", "PromeTidyModeChange"
    ];
    var out = {};
    for (var i = 0; i < TARGETS.length; i++) {
      var name = TARGETS[i];
      var fn = null;
      try { fn = app && app[name]; } catch (e) { out[name] = "读取抛错:" + String((e && e.message) || e); continue; }
      if (typeof fn !== "function") { out[name] = "不是函数:" + typeof fn; continue; }
      try {
        var r = fn.call(app);
        out[name] = "零参调用未抛错 → " + describePromeReturn(r);
      } catch (e) {
        out[name] = String((e && e.message) || e).slice(0, 160);
      }
    }
    return out;
  }

  // r10: ShowDialogEx 是唯一「桥接层认识、且带真实参数名(url)」的候选——Prome 族报的是通用 arg0，
  // 说明那些是没有 JS 类型映射的内部方法，怎么传都被拒。所以只值得深挖 ShowDialogEx。
  // 做法：先给 url，然后按报错逐个补参数名；每一步都记录「下一个缺什么」。
  // 一旦不再报缺参（说明参数齐了、真会开窗），立刻停止并把已知签名回报。
  function probeShowDialogExSignature(app) {
    var fn = null;
    try { fn = app && app.ShowDialogEx; } catch (e) { return { error: "读取抛错:" + String((e && e.message) || e) }; }
    if (typeof fn !== "function") return { error: "不是函数:" + typeof fn };

    // 故意用一个不存在的端口：万一参数凑齐真开了窗，也加载不出内容，不会干扰用户。
    var SAFE_URL = "http://127.0.0.1:1/anthony-probe";
    var GUESS = {
      url: SAFE_URL, title: "probe", name: "probe", caption: "probe",
      width: 420, height: 720, x: 0, y: 0, id: "probe", index: 0,
      modal: false, visible: false, resizable: false, dock: 0, dockPosition: 0,
      position: 0, style: 0, flag: 0, flags: 0, type: 0, mode: 0, parent: null, cb: function () {}
    };
    var args = [];
    var names = [];
    var trail = [];
    for (var round = 0; round < 14; round++) {
      var threw = false, errText = "", ret = null;
      try { ret = fn.apply(app, args); } catch (e) { threw = true; errText = String((e && e.message) || e); }
      if (!threw) {
        trail.push("参数齐(" + names.join(",") + ") → 返回 " + describePromeReturn(ret));
        return { params: names, trail: trail, complete: true, ret: describePromeReturn(ret) };
      }
      var mMiss = errText.match(/缺少必要参数\s*([^\s.,（()）]+)/);
      if (!mMiss) {
        trail.push("停在 " + names.length + " 个参数：" + errText.slice(0, 140));
        return { params: names, trail: trail, complete: false, lastError: errText.slice(0, 200) };
      }
      var pname = mMiss[1];
      if (names.indexOf(pname) >= 0) {
        // 同名反复报 → 该位类型不对。已知参数名本身就是最有价值的产物，先收工。
        trail.push("参数 " + pname + " 类型未猜中（已知前缀: " + names.join(",") + "）");
        return { params: names, trail: trail, complete: false, stuckAt: pname };
      }
      names.push(pname);
      args.push(Object.prototype.hasOwnProperty.call(GUESS, pname) ? GUESS[pname] : "probe");
      trail.push("第" + (names.length) + "个参数名 = " + pname);
    }
    return { params: names, trail: trail, complete: false, note: "14 轮上限" };
  }

  // r6: 参数名 oracle。WPS 桥接层在缺参/类型不符时会把「下一个缺失的参数名」报出来，
  // 已知样本：GetBrowserWindow() → "缺少必要参数browser."
  // 我们按报错逐轮补参数名到 args[]（真实类型未知，用类型占位值；若报同名参数说明类型不对，
  // 则换一种占位再试）。由于参数不齐/类型不对，桥接不会真建出窗口，副作用可控。
  // 若哪一轮调用竟返回值（没报缺参），说明参数可能凑齐 → 立即停止，避免真创建东西。
  // 返回可读的签名线索，例如 "param0=browser(类型待定) → 下一缺:arg1"。
  function probePromeSignature(app, fn) {
    var PLACEHOLDERS = {
      browser: {}, url: "http://127.0.0.1:3889/probe", path: "http://127.0.0.1:3889/probe",
      name: "probe", id: "0", index: 0, width: 800, height: 600, x: 0, y: 0,
      visible: false, bool: false, parent: {}, wnd: {}, window: {}, cb: function () {}
    };
    var args = [];
    var roundNames = [];
    var seen = new Set();
    for (var round = 0; round < 12; round++) {
      var result = null, threw = false, errText = "";
      try {
        result = fn.apply(app, args);
      } catch (e) {
        threw = true;
        errText = String((e && e.message) || e);
      }
      var m = errText.match(/缺少必要参数\s*([^\s.,=)]+)/);
      if (threw && m) {
        var param = m[1];
        if (seen.has(param)) {
          // 同一参数反复报：占位类型不被接受，换一种占位再试一次，避免死循环
          var cur = args.length;
          args[cur] = (args[cur] === 0) ? {} : 0;
          if (seen.has(param + "#" + ((args[cur] === 0) ? "num" : "obj"))) { roundNames.push(param + "(重试终止)"); break; }
          seen.add(param + "#" + ((args[cur] === 0) ? "num" : "obj"));
          continue;
        }
        seen.add(param);
        roundNames.push(param);
        // 数字型 argN 给位置；名字型给对应位置。
        var idx = /^arg(\d+)$/i.test(param) ? parseInt(RegExp.$1, 10) : args.length;
        args[idx] = (param in PLACEHOLDERS) ? PLACEHOLDERS[param] : (typeof (args[idx]) === "number" ? 0 : {});
      } else if (!threw) {
        // 没有缺参报错 → 参数可能凑齐了；记录但不继续，避免真开出东西
        return "OK(arg被接受 args.length=" + args.length + ", 圆参名=[" + roundNames.join(",") + "], 返回=" + (result === null ? "null" : typeof result) + ")";
      } else {
        // 不属于「缺参」类报错：可能是类型被拒或真错误，记录下来
        return "ERROR(round=" + round + ", args=[" + roundNames.join(",") + "], " + errText.slice(0, 160) + ")";
      }
    }
    return "STOP(round=12, paramNames=[" + roundNames.join(",") + "])";
  }

  // r7: 类型轮换 oracle。上一轮拿到的报错是「参数类型错误(第N个)」——它把出错位置也报出来了，
  // 于是可以逐位试探：固定已猜对的前缀，在第 pos 位轮换候选类型，
  // 一旦报错位置前移到 pos 之后（或转为「缺少必要参数」），说明这一位的类型猜对了。
  // 调用一旦不抛错就立即停止并记录返回值——那意味着参数可能齐了，再往下会真的建出东西。
  function describePromeReturn(v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    var t = typeof v;
    if (t !== "object") return t + ":" + String(v).slice(0, 60);
    var keys = [];
    try { for (var k in v) { keys.push(k); if (keys.length >= 24) break; } } catch (e) {}
    return "object{" + keys.join(",") + "}";
  }

  function probePromeTypeOracle(app, fn) {
    var CANDS = [
      ["str.url", "http://127.0.0.1:3889/pdf/taskpane.html"],
      ["str.plain", "probe"],
      ["num.0", 0],
      ["num.1", 1],
      ["bool.true", true],
      ["obj.empty", {}],
      ["arr.empty", []],
      ["fn", function () {}],
      ["null", null]
    ];
    // r8: 上一轮 9 种纯 JS 类型在第 0 位全被拒（"参数类型错误(第0个)"），说明桥接层要的不是 JS 原生值，
    // 而是 Variant 包装值或宿主自己的对象。把这两类补进候选：
    //   wps.JS2Variant(x) —— 桥接层的值包装器
    //   app.ThisBrowser / BrowserGroups / Env / FileSystem —— 宿主活对象
    try {
      var bridge = global.wps || {};
      if (typeof bridge.JS2Variant === "function") {
        var wrapTargets = [
          ["variant.url", "http://127.0.0.1:3889/pdf/taskpane.html"],
          ["variant.num0", 0],
          ["variant.obj", {}]
        ];
        for (var wi = 0; wi < wrapTargets.length; wi++) {
          try { CANDS.push([wrapTargets[wi][0], bridge.JS2Variant(wrapTargets[wi][1])]); } catch (e) {}
        }
      }
      if (typeof bridge.WrapCallbackArg === "function") {
        try { CANDS.push(["wrapCb", bridge.WrapCallbackArg(function () {})]); } catch (e) {}
      }
    } catch (e) {}
    var hostObjs = ["ThisBrowser", "BrowserGroups", "Env", "FileSystem", "ribbonUI", "PluginStorage"];
    for (var hi = 0; hi < hostObjs.length; hi++) {
      try {
        var hv = app && app[hostObjs[hi]];
        if (hv != null) CANDS.push(["host." + hostObjs[hi], hv]);
      } catch (e) {}
    }
    var MAX_POS = 6;
    var fixed = [];
    var trail = [];
    for (var pos = 0; pos < MAX_POS; pos++) {
      var advanced = false;
      var rejected = [];
      for (var ci = 0; ci < CANDS.length; ci++) {
        var label = CANDS[ci][0];
        var val = CANDS[ci][1];
        var args = fixed.slice();
        args[pos] = val;
        var threw = false, errText = "", result = null;
        try { result = fn.apply(app, args); } catch (e) { threw = true; errText = String((e && e.message) || e); }
        if (!threw) {
          trail.push("pos" + pos + "=" + label + " → 调用成功(停止) 返回=" + describePromeReturn(result));
          return { trail: trail, acceptedCount: pos, success: true, ret: describePromeReturn(result) };
        }
        var mType = errText.match(/参数类型错误\s*[（(]\s*第\s*(\d+)\s*个/);
        var mMiss = errText.match(/缺少必要参数\s*([^\s.,（()）]+)/);
        if (mType) {
          var badIdx = parseInt(mType[1], 10);
          if (badIdx > pos) {
            fixed[pos] = val;
            trail.push("pos" + pos + "=" + label + " ✓(错误前移到第" + badIdx + "个)");
            advanced = true;
            break;
          }
          // 这一位类型还是不对，换下一个候选。但记下报错原文：
          // 若不同候选给出不同措辞，就说明桥接层其实区分了它们，是有用线索。
          rejected.push(label + "→第" + badIdx + "个");
          continue;
        }
        if (mMiss) {
          fixed[pos] = val;
          trail.push("pos" + pos + "=" + label + " ✓(转为缺参:" + mMiss[1] + ")");
          advanced = true;
          break;
        }
        // 既不是类型错也不是缺参：可能是真业务报错，这本身就是有用线索
        trail.push("pos" + pos + "=" + label + " ✗ " + errText.slice(0, 90));
      }
      if (!advanced) {
        trail.push("pos" + pos + ": " + CANDS.length + " 种候选类型都不被接受，停止 [" + rejected.join(", ") + "]");
        break;
      }
    }
    return { trail: trail, acceptedCount: fixed.length, success: false };
  }

  async function collectProbeFields(obj, keys) {
    const out = {};
    if (!obj) return out;
    for (const key of keys) {
      try {
        out[key] = summarizeProbeValue(await resolveMaybe(obj[key]));
      } catch (e) {
        out[key] = `[throw:${e?.message || e}]`;
      }
    }
    return out;
  }

  async function probePdfPath(appArg) {
    const app = await resolveMaybe(appArg || getApplicationSync() || getApplication());
    const pdf = await getActivePdfDocFromAppAsync(app);
    const builtin = {};
    if (pdf && typeof pdf.BuiltinDocumentProperties === "function") {
      for (const name of PDF_BUILTIN_PROPS) {
        try {
          const prop = await resolveMaybe(pdf.BuiltinDocumentProperties(name));
          const value = prop && typeof prop === "object" ? await resolveMaybe(prop.Value) : prop;
          builtin[name] = summarizeProbeValue(value);
        } catch (e) {
          builtin[name] = `[throw:${e?.message || e}]`;
        }
      }
    }
    const result = {
      hasApp: !!app,
      host: detectHostByApp(app),
      hasPdf: !!pdf,
      resolvedPath: await getActivePdfPathFromAppAsync(app),
      appFields: await collectProbeFields(app, ["ActivePDF", "ActivePdf", "ActivePDFDocument", "ActivePdfDoc", "ActiveDocument", "ActiveWindow", "Documents", "PDFDocuments", "PdfDocuments", "Windows"]),
      pdfFields: await collectProbeFields(pdf, PDF_PATH_KEYS.concat(["PagesCount", "CurrentPage", "ReadOnly"])),
      builtin
    };
    debugLog("pdfPath.probe", result);
    traceStatic("adapter.pdfPath.probe", result.resolvedPath || JSON.stringify({ host: result.host, hasPdf: result.hasPdf }));
    return result;
  }

  function getRibbonControlId(control) {
    if (typeof control === "string") return control;
    const keys = ["Id", "id", "ID", "Name", "name"];
    for (const key of keys) {
      try {
        let value = control?.[key];
        if (typeof value === "function") value = value.call(control);
        if (value != null && value !== "") return String(value);
      } catch (e) {}
    }
    return "";
  }
  global.__anthonyGetRibbonControlId = getRibbonControlId;

  function collectAppCandidates() {
    const candidates = [];
    const push = (label, getter) => {
      try {
        const app = getter();
        if (app) candidates.push({ label, app });
      } catch (e) {}
    };
    push("Application", () => global.Application);
    push("wps.WpsApplication", () => typeof global.wps?.WpsApplication === "function" ? global.wps.WpsApplication() : null);
    push("wps.EtApplication", () => typeof global.wps?.EtApplication === "function" ? global.wps.EtApplication() : null);
    push("wps.WppApplication", () => typeof global.wps?.WppApplication === "function" ? global.wps.WppApplication() : null);
    push("wps.PdfApplication", () => typeof global.wps?.PdfApplication === "function" ? global.wps.PdfApplication() : null);
    push("wps.PDFApplication", () => typeof global.wps?.PDFApplication === "function" ? global.wps.PDFApplication() : null);
    push("wps.KPdfApplication", () => typeof global.wps?.KPdfApplication === "function" ? global.wps.KPdfApplication() : null);
    push("wps.KpdfApplication", () => typeof global.wps?.KpdfApplication === "function" ? global.wps.KpdfApplication() : null);
    push("pdf.Application", () => global.pdf?.Application);
    push("kpdf.Application", () => global.kpdf?.Application);
    push("wps.Application", () => global.wps?.Application);
    return candidates;
  }

  function hasCreateTaskPaneApi(obj) {
    try {
      return !!(obj && (typeof obj.CreateTaskPane === "function" || typeof obj.CreateTaskpane === "function"));
    } catch (e) { return false; }
  }

  function getApplicationSync() {
    const candidates = collectAppCandidates();
    for (const item of candidates) {
      if (detectHostByApp(item.app) !== "unknown") return item.app;
    }
    // mac r3: 宿主识别失败时不要盲目返回 candidates[0]。PDF 下第一个候选是
    // global.Application，可能是浏览器外壳（只有 ShowDialog/BrowserWindow 等），
    // 而进程里若还开着 Writer/表格/演示窗口，另一个候选才是带任务窗格能力的真应用对象。
    // 这正是"首次能嵌入、重开后退回浮窗"的原因：兜底挑错了对象。
    for (const item of candidates) {
      if (hasCreateTaskPaneApi(item.app)) return item.app;
    }
    for (const item of candidates) {
      try {
        const app = item.app;
        if (app.ActiveDocument || app.ActivePDF || app.Documents) return app;
      } catch (e) {}
    }
    return candidates[0]?.app || null;
  }

  async function getAddonApi() {
    if (typeof global.wps?.WpsApplication === "function") {
      return null;
    }
    const api = global.jssdk?.api || null;
    if (!api) {
      return null;
    }
    if (typeof api.ready === "function") {
      await api.ready();
    }
    return api;
  }

  async function getApplication() {
    const sync = getApplicationSync();
    if (sync) {
      return sync;
    }
    const api = await getAddonApi();
    if (api?.Application) {
      return api.Application;
    }
    return null;
  }

  function getUrlPath() {
    let url = decodeURI(document.location.toString());
    if (url.includes("/")) {
      url = url.substring(0, url.lastIndexOf("/"));
    }
    return url;
  }

  function traceStatic(event, data) {
    try {
      if (typeof global.__anthonyTraceStatic === "function") {
        global.__anthonyTraceStatic(event, data);
        return;
      }
      const img = new Image();
      img.src = `${getUrlPath()}/__anthony_trace__.gif?event=${encodeURIComponent(event || "")}&data=${encodeURIComponent(data == null ? "" : String(data))}&ts=${Date.now()}`;
    } catch (error) {}
  }

  function debugLog(message, data) {
    try {
      const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
      const payload = JSON.stringify({
        tag: "wps-addon-adapter",
        message,
        data: data == null ? null : data
      });
      if (global.navigator?.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        global.navigator.sendBeacon(base + "/debug-log", blob);
        return;
      }
      fetch(base + "/debug-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch (error) {}
  }

  function readStorageItem(app, key) {
    try {
      return app?.PluginStorage?.getItem?.(key) || null;
    } catch (error) {
      return null;
    }
  }

  function writeStorageItem(app, key, value) {
    try {
      app?.PluginStorage?.setItem?.(key, value);
    } catch (error) {
      // PluginStorage 不可用时静默忽略
    }
  }

  function clearStorageItem(app, key) {
    try {
      app?.PluginStorage?.removeItem?.(key);
    } catch (error) {
      // 部分版本没有 removeItem，回写空串保持兼容
      writeStorageItem(app, key, "");
    }
  }

  function getTaskPaneHost(app) {
    if (hasCreateTaskPaneApi(app)) return app;
    const wpsObj = global.wps;
    if (hasCreateTaskPaneApi(wpsObj)) return wpsObj;
    // mac r3: 传进来的 app 可能是 PDF 下的浏览器外壳。再扫一遍全部候选，
    // 只要进程里有任何一个对象带 CreateTaskPane 就用它，别直接退回浮窗。
    for (const item of collectAppCandidates()) {
      if (hasCreateTaskPaneApi(item.app)) return item.app;
    }
    // 外壳对象自身没有，但它挂着的浏览器/标签对象上可能有。
    for (const key of ["ThisBrowser", "BrowserWindow", "BrowserGroups"]) {
      try {
        if (app && hasCreateTaskPaneApi(app[key])) return app[key];
      } catch (e) {}
    }
    try {
      if (app && typeof app.GetBrowserWindow === "function") {
        const win = app.GetBrowserWindow();
        if (hasCreateTaskPaneApi(win)) return win;
      }
    } catch (e) {}
    return app || wpsObj || null;
  }

  function createTaskPaneViaHost(host, url) {
    if (!host) return null;
    if (typeof host.CreateTaskPane === "function") return host.CreateTaskPane(url);
    if (typeof host.CreateTaskpane === "function") return host.CreateTaskpane(url);
    return null;
  }

  function getTaskPaneById(host, id) {
    if (!host || !id) return null;
    if (typeof host.GetTaskPane === "function") return host.GetTaskPane(id);
    if (typeof host.GetTaskpane === "function") return host.GetTaskpane(id);
    return null;
  }

  function getTaskPaneEnumHost(app, taskPaneHost) {
    return app?.Enum || taskPaneHost?.Enum || global.wps?.Enum || null;
  }

  // 上一代 storage key（按 TASKPANE_STORAGE_KEY 后缀往前推）。
  // 每次 bump v 后顺手把老 key 对应的 pane 删掉，避免老 pane 用旧宽度还活着。
  const LEGACY_TASKPANE_KEYS = [
    "anthony_ai_taskpane_id_v10",
    "anthony_ai_taskpane_id_v9",
    "anthony_ai_taskpane_id_v8",
    "anthony_ai_taskpane_id_v7",
    "anthony_ai_taskpane_id_v6",
    "anthony_ai_taskpane_id_v5",
    "anthony_ai_taskpane_id_v4",
    "anthony_ai_taskpane_id_v3",
    "anthony_ai_taskpane_id_v2",
    "anthony_ai_taskpane_id"
  ];

  function cleanupLegacyTaskPanes(app) {
    if (!app || typeof app.GetTaskPane !== "function") return;
    LEGACY_TASKPANE_KEYS.forEach((key) => {
      try {
        const oldId = readStorageItem(app, key);
        if (!oldId) return;
        let oldPane = null;
        try { oldPane = app.GetTaskPane(oldId); } catch (e) {}
        if (oldPane && typeof oldPane.Delete === "function") {
          try {
            oldPane.Delete();
            console.log(`[wps-ai] 清掉孤儿老 pane (${key}=${oldId})`);
          } catch (e) {}
        } else if (oldPane && typeof oldPane.Visible === "boolean") {
          // Delete 不可用时退而求其次：藏起来
          try { oldPane.Visible = false; } catch (e) {}
        }
        clearStorageItem(app, key);
      } catch (e) { /* ignore */ }
    });
  }

  /**
   * 优先使用 CreateTaskPane 在 WPS 内部嵌入面板；不可用时回退到 ShowDialog 弹窗。
   * 二次点击 Ribbon 按钮时切换显隐，而不是重复创建。
   */
  // 判断当前活动文档是不是已保存到磁盘且没有脏改动。
  // 给 ribbon "打开Anthony AI" 按钮做开 pane 前的早判断；不依赖 TaskPane 是否已经加载。
  // wps/wpp/et 才查；PDF / 没文档识别一律放行。
  function checkActiveDocSavedForAdapter(app) {
    try {
      const host = detectHostByApp(app);
      if (!host || !["wps", "wpp", "et"].includes(host)) return { ok: true };
      let doc = null;
      try {
        if (host === "wps") doc = app.ActiveDocument;
        else if (host === "wpp") doc = app.ActivePresentation;
        else if (host === "et") doc = app.ActiveWorkbook;
      } catch (e) { doc = null; }
      if (!doc) return { ok: true }; // 没识别到活动文档就别拦
      let fullName = "";
      try { fullName = String(doc.FullName || ""); } catch (e) { fullName = ""; }
      let path = "";
      try { path = String(doc.Path || ""); } catch (e) { path = ""; }
      const hasPath = /[/\\]/.test(fullName) || fullName.startsWith("/") || /^[A-Za-z]:/.test(fullName)
        || /[/\\]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path);
      if (!hasPath) {
        return {
          ok: false,
          hint: "当前文档还没保存到磁盘（临时文档）。请先另存为本地文件（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），再打开Anthony AI。"
        };
      }
      let savedAttr = null;
      try { savedAttr = doc.Saved; } catch (e) { savedAttr = null; }
      if (savedAttr === false) {
        return {
          ok: false,
          hint: "当前文档有未保存的修改。请先保存（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），再打开Anthony AI（保存后改动才能纳入备份/回滚记录）。"
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: true }; // 探测失败兜底放行
    }
  }

  function toggleTaskPaneWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html`;
    const taskPaneHost = getTaskPaneHost(app);
    traceStatic("adapter.toggleTaskPane.enter", detectHostByApp(app));
    debugLog("toggleTaskPane.enter", {
      url,
      hasApp: !!app,
      hasCreateTaskPane: !!taskPaneHost && (typeof taskPaneHost.CreateTaskPane === "function" || typeof taskPaneHost.CreateTaskpane === "function"),
      taskPaneHost: taskPaneHost === app ? "app" : (taskPaneHost === global.wps ? "wps" : typeof taskPaneHost),
      host: detectHostByApp(app)
    });

    if (taskPaneHost) {
      try {
        const storageHost = app || taskPaneHost;
        const existingId = readStorageItem(storageHost, TASKPANE_STORAGE_KEY);
        let pane = null;

        if (existingId) {
          try {
            pane = getTaskPaneById(taskPaneHost, existingId);
          } catch (error) {
            pane = null;
          }
        }

        if (pane && typeof pane.Visible === "boolean") {
          const wantShow = !pane.Visible;
          // 只在"打开"方向做保存校验；"关闭"方向永远放行
          if (wantShow) {
            const chk = checkActiveDocSavedForAdapter(app);
            if (!chk.ok) {
              debugLog("toggleTaskPane.blocked.unsaved", { existingId, hint: chk.hint });
              try { alert(chk.hint); } catch (e) {}
              return true;
            }
          }
          pane.Visible = wantShow;
          // 每次"显示"时把默认宽度重新写一遍 —— dev 改 pickDefaultTaskPaneWidth 后立刻
          // 生效；生产用户手动 resize 后下次开会被重置，但开发体验优先。
          if (wantShow) {
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "toggle-reshow"); } catch (e) {}
          }
          traceStatic("adapter.toggleTaskPane.reuse", `${existingId || ""}:${wantShow}`);
          debugLog("toggleTaskPane.reuse", {
            existingId,
            visible: pane.Visible,
            wantShow
          });
          return true;
        }

        // 首次创建 pane 也是"打开"方向，同样做保存校验
        const chkCreate = checkActiveDocSavedForAdapter(app);
        if (!chkCreate.ok) {
          debugLog("toggleTaskPane.blocked.create-unsaved", { hint: chkCreate.hint });
          try { alert(chkCreate.hint); } catch (e) {}
          return true;
        }

        // 新 v key 下没找到 pane（首次创建 / 版本 bump 后） → 先清扫历史 v key 下的孤儿 pane
        cleanupLegacyTaskPanes(storageHost);

        // 尝试按照官方最简形式创建
        pane = createTaskPaneViaHost(taskPaneHost, url);
        if (!pane) {
          throw new Error("CreateTaskPane 返回空对象");
        }
        if (pane.ID != null) {
          writeStorageItem(storageHost, TASKPANE_STORAGE_KEY, String(pane.ID));
        }
        
        // msoCTPDockPositionRight 枚举值通常是 2
        try {
          const enumHost = getTaskPaneEnumHost(app, taskPaneHost);
          if (enumHost && enumHost.msoCTPDockPositionRight !== undefined) {
             pane.DockPosition = enumHost.msoCTPDockPositionRight;
          } else {
             pane.DockPosition = 2; 
          }
        } catch (e) {}

        // 设置一次初始宽度即可，去掉延迟覆盖等花式操作，避免干扰原生渲染
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "creation");
        
        pane.Visible = true;
        traceStatic("adapter.toggleTaskPane.created", pane.ID != null ? String(pane.ID) : "no-id");
        debugLog("toggleTaskPane.created", {
          paneId: pane.ID != null ? String(pane.ID) : "",
          visible: pane.Visible
        });
        return true;
      } catch (error) {
        console.warn("[wps-ai] CreateTaskPane 失败，回退到 ShowDialog：", error);
        traceStatic("adapter.toggleTaskPane.create-failed", error?.message || String(error));
        // mac r3: 记录宿主到底暴露了什么，用来判断 PDF 组件是真的没有 CreateTaskPane，
        // 还是有方法但调用失败。getTaskPaneHost 在两者都没有时也会返回 app，
        // 于是 createTaskPaneViaHost 返回 null 并抛出“CreateTaskPane 返回空对象”。
        debugLog("toggleTaskPane.create-failed", {
          message: error?.message || String(error),
          hostIsApp: taskPaneHost === app,
          hostIsWps: taskPaneHost === global.wps,
          appHasCreate: !!(app && (typeof app.CreateTaskPane === "function" || typeof app.CreateTaskpane === "function")),
          wpsHasCreate: !!(global.wps && (typeof global.wps.CreateTaskPane === "function" || typeof global.wps.CreateTaskpane === "function")),
          hostHasCreate: !!(taskPaneHost && (typeof taskPaneHost.CreateTaskPane === "function" || typeof taskPaneHost.CreateTaskpane === "function"))
        });
        logBrowserSurfaceOnce(app, "toggleTaskPane");
        // r13: 这里原来挂着 Prome 签名 Oracle，已经跑完出结论——5 个 Prome 方法对 18 种候选类型
        // 在第 0 位全部拒绝且错误文本完全一致，说明不是类型校验而是「不对插件 JS 开放」。
        // 留着只会让每个会话的首次点击白跑 90 次注定失败的桥接调用，所以摘掉；
        // probePromeApi 函数本体保留，需要复查时手动调一次即可。
        clearStorageItem(app || taskPaneHost, TASKPANE_STORAGE_KEY);
      }
    }

    traceStatic("adapter.toggleTaskPane.fallback-dialog", url);
    debugLog("toggleTaskPane.fallback-dialog", { url });
    return openTaskPaneAsDialogWithApp(app);
  }

  function toggleTaskPane() {
    const app = getApplicationSync();
    if (getTaskPaneHost(app)) return toggleTaskPaneWithApp(app);
    getApplication()
      .then((resolvedApp) => {
        toggleTaskPaneWithApp(resolvedApp);
      })
      .catch(() => {
        openTaskPaneAsDialogWithApp(null);
      });
    return true;
  }

  // r12: PDF-only 会话真停靠做不到（Application 只有 26~27 个键，没有 CreateTaskPane；
  // Prome 全族 18 种参数类型全被拒、报错文本完全一致，是「不对插件 JS 开放」而非类型问题；
  // ShowDialogEx 实测只收一个 url、返回 true，没有停靠位参数）。
  // 退一步用辅助功能把浮窗贴到主窗右侧、并把主窗宽度让出来——两窗并排，不再盖住文档。
  // ShowDialog 是立即返回的，窗口要过一会儿才出现，所以重试几次。
  const PANE_SNAP_ENABLED = false;

  function snapPaneBesideDocument(paneWidthCss) {
    // 并排两窗是被否掉的方案：做不到宿主原生内嵌就保留原先的弹出浮窗，
    // 不去改文档窗宽度、不把面板钉在窗外。代码留着（Windows 侧或将来复用），默认不跑。
    if (!PANE_SNAP_ENABLED) { debugLog("snapPane.disabled", {}); return; }
    var base = null;
    try { base = global.WpsAiRuntime?.proxyBase?.(); } catch (e) {}
    base = base || "http://127.0.0.1:3890";
    var attempt = 0;
    var tick = function () {
      attempt++;
      fetch(base + "/snap-pane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paneWidth: paneWidthCss })
      })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.ok) { debugLog("snapPane.ok", { attempt: attempt, paneWidth: j.paneWidth }); return; }
          if (attempt < 6) { setTimeout(tick, 500); return; }
          debugLog("snapPane.giveup", { attempt: attempt, error: (j && j.error) || "unknown" });
        })
        .catch(function (e) {
          if (attempt < 6) { setTimeout(tick, 500); return; }
          debugLog("snapPane.error", { attempt: attempt, error: String((e && e.message) || e) });
        });
    };
    setTimeout(tick, 600);
  }

  // 面板窗高度在 ShowDialog 创建时就定死了（辅助功能事后改不动，实测 752 怎么设都不变），
  // 所以开窗前先问一次文档窗多高，让面板和文档等高——这是「像停靠」的关键一步。
  // 标题栏等边框会额外占约 32px，所以内容高度要减掉。
  const PANE_CHROME_H = 32;

  // 上一次量到的文档窗几何。等高只是锦上添花，绝不能为它推迟开窗：
  // 之前的写法是 fetch().then(开窗)，结果 ①窗口要等一次 HTTP 往返才出现；
  // ②开窗从同步变成异步，把调用方的时序全打乱了（多个入口共用同一个 ShowDialog）。
  // 现在改成：拿缓存立刻开窗，同时在后台刷新缓存供下次使用。
  var _lastDocGeom = null;

  function refreshDocWindowGeometry() {
    if (typeof fetch !== "function") return;   // 宿主 WebView / 测试沙箱可能没有 fetch
    var base = null;
    try { base = global.WpsAiRuntime?.proxyBase?.(); } catch (e) {}
    base = base || "http://127.0.0.1:3890";
    try {
      fetch(base + "/doc-window-geometry", { method: "GET" })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.ok && j.height) _lastDocGeom = j; })
        .catch(function () {});
    } catch (e) {}
  }

  function openTaskPaneAsDialogWithApp(app) {
    // CreateTaskPane 路径已经做过保存校验；这里 fallback 到 ShowDialog 也补一道，避免漏判
    {
      const chk = checkActiveDocSavedForAdapter(app);
      if (!chk.ok) {
        debugLog("openTaskPaneAsDialog.blocked.unsaved", { hint: chk.hint });
        try { alert(chk.hint); } catch (e) {}
        return true;
      }
    }
    // 用上次量到的高度立刻开窗（首次没有就退回固定尺寸），再后台刷新给下次用。
    openPaneDialogSized(app, _lastDocGeom);
    refreshDocWindowGeometry();
    return true;
  }

  function openPaneDialogSized(app, geom) {
    const url = `${getUrlPath()}/taskpane.html?pane=dialog`;
    const title = "Anthony AI";
    const dpr = global.devicePixelRatio || 1;
    const width = Math.round(420 * dpr);
    // 有文档窗高度就跟它等高，否则退回 720。
    const cssHeight = geom && geom.height ? Math.max(400, geom.height - PANE_CHROME_H) : 720;
    const height = Math.round(cssHeight * dpr);
    debugLog("openTaskPaneAsDialog.sizing", { docHeight: geom && geom.height, cssHeight, dpr });
    if (app && typeof app.ShowDialog === "function") {
      traceStatic("adapter.openDialog.app", url);
      debugLog("openTaskPaneAsDialog.app", { url, width, height });
      app.ShowDialog(url, title, width, height, false);
      snapPaneBesideDocument(420);
      return true;
    }
    if (typeof global.wps?.ShowDialog === "function") {
      traceStatic("adapter.openDialog.wps", url);
      debugLog("openTaskPaneAsDialog.wps", { url, width, height });
      global.wps.ShowDialog(url, title, width, height, false);
      snapPaneBesideDocument(420);
      return true;
    }
    traceStatic("adapter.openDialog.window", url);
    debugLog("openTaskPaneAsDialog.window-open", { url, width, height });
    global.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  function openTaskPaneAsDialog() {
    const app = getApplicationSync();
    if (app || global.wps) return openTaskPaneAsDialogWithApp(app);
    getApplication()
      .then((resolvedApp) => {
        openTaskPaneAsDialogWithApp(resolvedApp);
      })
      .catch(() => {
        openTaskPaneAsDialogWithApp(null);
      });
    return true;
  }

  function openParallelTranslateDialogWithApp(app, docPath) {
    const normalizedPath = pickString(docPath);
    if (!normalizedPath || !/\.pdf$/i.test(normalizedPath)) {
      traceStatic("adapter.openParallelTranslateDialog.no-path", JSON.stringify(getPdfPathDebugFromApp(app)));
      debugLog("openParallelTranslateDialog.no-path", getPdfPathDebugFromApp(app));
      logBrowserSurfaceOnce(app, "parallelTranslate");
    }
    try {
      localStorage.setItem(PARALLEL_TRANSLATE_DIALOG_REQUEST_KEY, JSON.stringify({
        ts: Date.now(),
        docPath: normalizedPath
      }));
    } catch (e) {}
    const url = `${getUrlPath()}/taskpane.html?mode=paralleltranslate`;
    const title = "Anthony AI 对照翻译";
    const width = Math.round(900 * (global.devicePixelRatio || 1));
    const height = Math.round(720 * (global.devicePixelRatio || 1));
    // mac r3: 这里原先传 modal=true。同一宿主里 openTaskPaneAsDialogWithApp 用 modal=false
    // 一直正常，而 modal=true 会让功能区 JS 宿主进入嵌套模态循环并卡死（PDF 点“对照翻译”无响应）。
    // 调用后没有任何依赖返回值的代码，模态没有收益，统一改为 false。
    const modal = false;
    debugLog("showDialog.geom", {
      site: "adapter.parallelTranslate", width, height, modal,
      dpr: global.devicePixelRatio || null,
      screen: global.screen ? `${global.screen.availWidth}x${global.screen.availHeight}` : null
    });
    if (app && typeof app.ShowDialog === "function") {
      traceStatic("adapter.openParallelTranslateDialog.app", normalizedPath);
      debugLog("openParallelTranslateDialog.app", { url, docPath: normalizedPath, width, height, modal });
      app.ShowDialog(url, title, width, height, modal);
      return true;
    }
    if (typeof global.wps?.ShowDialog === "function") {
      traceStatic("adapter.openParallelTranslateDialog.wps", normalizedPath);
      debugLog("openParallelTranslateDialog.wps", { url, docPath: normalizedPath, width, height, modal });
      global.wps.ShowDialog(url, title, width, height, modal);
      return true;
    }
    traceStatic("adapter.openParallelTranslateDialog.window", normalizedPath);
    debugLog("openParallelTranslateDialog.window-open", { url, docPath: normalizedPath, width, height });
    global.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  function openParallelTranslateDialogAfterChoose(app) {
    return openParallelTranslateDialogWithApp(app || getApplicationSync(), "");
  }

  function openParallelTranslateDialog(app, docPathHint) {
    const hinted = pickString(docPathHint);
    if (hinted) return openParallelTranslateDialogWithApp(app, hinted);
    debugLog("openParallelTranslateDialog.async-start", { hasApp: !!app });
    Promise.resolve()
      .then(async () => {
        const resolvedApp = await resolveMaybe(app || getApplicationSync() || getApplication());
        const path = await resolvePdfPathForRibbon(resolvedApp, "", 900);
        debugLog("openParallelTranslateDialog.async-resolved", { hasResolvedApp: !!resolvedApp, path });
        if (!path) {
          Promise.resolve()
            .then(() => withTimeout(probePdfPath(resolvedApp), 1500, null))
            .catch(() => {});
        }
        openParallelTranslateDialogWithApp(resolvedApp || getApplicationSync(), path || "");
      })
      .catch(async (e) => {
        debugLog("openParallelTranslateDialog.async-catch", { message: String(e && e.message || e), stack: String(e && e.stack || "").slice(0, 500) });
        Promise.resolve()
          .then(() => withTimeout(probePdfPath(app || getApplicationSync()), 1500, null))
          .catch(() => {});
        openParallelTranslateDialogWithApp(app || getApplicationSync(), "");
      });
    return true;
  }

  function showEntryHint() {
    if (!document.body || document.getElementById("anthonyEntryHint")) {
      return;
    }
    const wrapper = document.createElement("main");
    wrapper.id = "anthonyEntryHint";
    wrapper.style.cssText = "font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;padding:24px;line-height:1.7;color:#1f2329;";
    wrapper.innerHTML = `
      <h1 style="margin:0 0 12px;color:#1a6dff;">Anthony AI 加载项已启动</h1>
      <p>请在 WPS 顶部功能区查找 <strong>Anthony AI</strong> 选项卡，然后点击 <strong>打开Anthony AI</strong>。</p>
      <p>面板会嵌入到 WPS 右侧的任务窗格区域。再次点击同一按钮可以收起面板。</p>
      <button id="anthonyOpenBtn" type="button" style="border:0;border-radius:4px;padding:8px 16px;background:#1a6dff;color:#fff;font-weight:500;cursor:pointer;">直接打开Anthony AI</button>
    `;
    document.body.appendChild(wrapper);
    document.getElementById("anthonyOpenBtn")?.addEventListener("click", toggleTaskPane);
  }

  function setupRibbon(ribbonUI) {
    const app = getApplicationSync();
    traceStatic("adapter.setupRibbon", detectHostByApp(app));
    debugLog("setupRibbon", {
      hasRibbonUI: !!ribbonUI,
      hasApp: !!app,
      host: detectHostByApp(app)
    });
    if (app && typeof app.ribbonUI !== "object") {
      try { app.ribbonUI = ribbonUI; } catch (error) { /* readonly on some hosts */ }
    }
    if (global.wps && typeof global.wps.ribbonUI !== "object") {
      global.wps.ribbonUI = ribbonUI;
    }
    const targetRibbonUI = app?.ribbonUI || global.wps?.ribbonUI;
    if (targetRibbonUI?.ActivateTab) {
      setTimeout(() => {
        try { targetRibbonUI.ActivateTab("wpsAiTab"); } catch (e) { /* not active doc */ }
      }, 300);
    }
    return true;
  }

  // 当前活动 TaskPane 句柄（已存储 id → 通过 GetTaskPane 取回）。失败返回 null
  function getCurrentTaskPane() {
    const app = getApplicationSync();
    if (!app || typeof app.GetTaskPane !== "function") return null;
    const id = readStorageItem(app, TASKPANE_STORAGE_KEY);
    if (!id) return null;
    try { return app.GetTaskPane(id); } catch (e) { return null; }
  }

  // 读取/设置 TaskPane 的停靠位置。WPS 沿用 MSO 枚举：
  //   0=Left, 1=Top, 2=Right(默认), 3=Bottom, 4=Floating
  function getTaskPaneDockPosition() {
    const pane = getCurrentTaskPane();
    if (!pane) return null;
    try { return Number(pane.DockPosition); } catch (e) { return null; }
  }

  function setTaskPaneDockPosition(dock) {
    const pane = getCurrentTaskPane();
    if (!pane) return false;
    try {
      pane.DockPosition = dock;
      // 切到浮动：给一个看得见 resize handle 的初始尺寸，并居中到屏幕。
      // docked 状态 Width 决定的是固定一侧宽度，不动 Height/Left/Top
      if (dock === 4) {
        const W = 480, H = 720;
        try { if ("Width" in pane) pane.Width = W; } catch (e) {}
        try { if ("Height" in pane) pane.Height = H; } catch (e) {}
        // 屏幕中央：WPS pane.Left/Top 通常是相对桌面的绝对屏幕坐标
        try {
          const sw = (global.screen && global.screen.availWidth) || 1920;
          const sh = (global.screen && global.screen.availHeight) || 1080;
          if ("Left" in pane) pane.Left = Math.max(0, Math.round((sw - W) / 2));
          if ("Top" in pane) pane.Top = Math.max(0, Math.round((sh - H) / 2));
        } catch (e) { /* 不支持 Left/Top 就忍了 */ }
      }
      return true;
    } catch (e) {
      console.warn("[wps-ai] 设 DockPosition 失败:", e?.message || e);
      return false;
    }
  }

  // 浮动模式：用户拖右下抓手时，按屏幕坐标 delta 调 pane.Width/Height
  function resizeFloatingPane(width, height) {
    const pane = getCurrentTaskPane();
    if (!pane) return false;
    try {
      if ("Width" in pane && width > 200) pane.Width = Math.round(width);
      if ("Height" in pane && height > 200) pane.Height = Math.round(height);
      return true;
    } catch (e) { return false; }
  }
  function getFloatingPaneSize() {
    const pane = getCurrentTaskPane();
    if (!pane) return null;
    try { return { width: Number(pane.Width) || 0, height: Number(pane.Height) || 0 }; }
    catch (e) { return null; }
  }

  // 在停靠（右侧）与浮动两种状态间切换。返回新状态：true=floating, false=docked
  function toggleTaskPaneDock() {
    const cur = getTaskPaneDockPosition();
    const next = cur === 4 ? 2 : 4;   // floating(4) ↔ right(2)
    setTaskPaneDockPosition(next);
    return next === 4;
  }

  global.WpsAiAddon = {
    getAddonApi,
    getApplication,
    getApplicationSync,
    getUrlPath,
    toggleTaskPane,
    openTaskPane: toggleTaskPane,
    openTaskPaneAsDialog,
    setupRibbon,
    showEntryHint,
    getCurrentTaskPane,
    debugLog,
    getTaskPaneDockPosition,
    setTaskPaneDockPosition,
    toggleTaskPaneDock,
    resizeFloatingPane,
    getFloatingPaneSize,
    getActivePdfPath: getActivePdfPathFromAppAsync,
    probePdfPath
  };
  global.__anthonyProbePdfPath = function __anthonyProbePdfPath() {
    return probePdfPath(getApplicationSync()).then((result) => {
      try { console.log("[anthony] pdf path probe", result); } catch (e) {}
      return result;
    });
  };

  function handleAddinLoad(ribbonUI) {
    traceStatic("adapter.OnAddinLoad", JSON.stringify({
      hasRibbonUI: !!ribbonUI,
      host: detectHostByApp(getApplicationSync()),
      path: getUrlPath()
    }));
    debugLog("OnAddinLoad", {
      hasRibbonUI: !!ribbonUI
    });
    // r12: 加载期的 Prome/停靠能力探针已全部跑完并出结论，去掉了——
    // 结论记录在 probeDialogSurface / probeShowDialogExSignature 上方的注释里，函数留着按需调用。
    // 另外实测：同进程里再开一个 Office 文档不会让 PDF 侧长出 CreateTaskPane
    //（WPS 会用新文档顶掉 PDF 的标签，PDF 侧上下文随之挂起），所以「共存解锁停靠」这条路也不通。
    return setupRibbon(ribbonUI);
  }
  global.__anthonyOnAddinLoad = handleAddinLoad;
  global.OnAddinLoad = function OnAddinLoad(ribbonUI) {
    return handleAddinLoad(ribbonUI);
  };

  // 主面板入口是否改用独立 ShowDialog 浮窗（而非 docked taskpane）：只在能确认是 mac/linux 时才改；
  // Windows 或识别不出时保持 docked（现状）——避免回归 Windows 上工作正常的停靠面板。
  function preferDialogPaneForHost() {
    try {
      const nav = global.navigator || (typeof navigator !== "undefined" ? navigator : null);
      const s = String((nav && nav.userAgent) || "") + " " + String((nav && nav.platform) || "");
      if (/Windows|Win32|Win64|WOW64/i.test(s)) return false;
      return /Mac|Macintosh|Mac OS X|Darwin|Linux|X11|CrOS/i.test(s);
    } catch (e) { return false; }
  }

  function handleRibbonAction(control) {
    const id = getRibbonControlId(control);
    traceStatic("adapter.OnAction", id);
    debugLog("OnAction", { id, controlType: typeof control });
    if (id === "openWpsAiPane") {
      // Mac/Linux 上 docked taskpane 与文档共享 OS 键盘焦点，Cmd+V 会同时进文档造成双份插入，而 jsapi
      // 没有 ReleaseFocus 可补救（Windows 特有）。这两端改用独立 ShowDialog 浮窗（配合输入框「粘贴」按钮/
      // 右键粘贴走程序化剪贴板绕开 Cmd+V）。Windows 上 docked taskpane 工作正常、可停靠右侧，保持不变。
      if (preferDialogPaneForHost()) return openTaskPaneAsDialog();
      return toggleTaskPane();
    }

    // 「文档未保存」拦截：在还没 ensureTaskPaneVisible / writeStorageItem 之前判断，
    // 这样 alert 弹出来时 pane 完全不会打开，按钮像没点过一样。
    // 跳过校验的情况：纯展示 modal（stylePreset / outline / materialLibrary），它们不改文档。
    function blockedByUnsaved(skip) {
      if (skip) return false;
      const chk = checkActiveDocSavedForAdapter(getApplicationSync());
      if (!chk.ok) {
        try { alert(chk.hint); } catch (e) {}
        return true;
      }
      return false;
    }

    // PPT 风格按钮 → 打开 style preset modal（纯展示，不需要校验）
    if (id === "anthonyStyleBtn") {
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        kind: "open-modal",
        modal: "stylePreset",
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // 统一风格按钮 → 打开 unify modal（会改 PPT，要校验）
    if (id === "anthonyUnifyBtn") {
      if (blockedByUnsaved(false)) return true;
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        kind: "open-modal",
        modal: "unify",
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // 去 AI 味按钮 → 直接发起一个 PPT 文字改写对话（无 modal，要校验）
    if (id === "anthonyDeAiBtn") {
      if (blockedByUnsaved(false)) return true;
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        host: "wpp",
        key: "deAi",
        prompt: [
          "【任务】对当前 PPT 所有页面的文字执行「去 AI 味」改写：去掉典型的 AI 生成痕迹，让文字读起来像真人写的——简洁、克制、专业。",
          "",
          "【AI 味的典型特征——识别并清除】",
          "- 套话开头：首先 / 其次 / 再次 / 最后 / 综上所述 / 总而言之 / 在此基础上",
          "- 模板句式：「不仅...还...」「通过...来实现...」「为...提供了...的可能」",
          "- 万能修饰：非常 / 极其 / 高度 / 至关重要 / 深度 / 显著 / 创新 / 卓越 / 全方位",
          "- 互联网黑话：赋能 / 抓手 / 闭环 / 打通 / 链路 / 沉淀 / 复盘 / 体感 / 心智 / 颗粒度 / 对齐 / 拉齐",
          "- 列表狂魔：所有内容都强行编号 1/2/3——能改成自然连贯叙述的就改",
          "- 没意义的修饰词：方案「创新」、技术「先进」、效果「显著」、影响「深远」、意义「重大」",
          "- 万能结论：「实现了 X 与 Y 的有机统一」「为 X 注入了新的活力」「开启了 X 的新篇章」",
          "",
          "【流程】",
          "STEP 1. wpp_list_slides 拿整体结构。",
          "STEP 2. 对每页：wpp_read_slide 读所有形状文字。",
          "STEP 3. 逐个非空形状判断是否要改写：",
          "   - 页面标题：通常保留；如果含套话（如「关于...的若干思考」「浅谈...」），改成更直接的标题",
          "   - 正文/要点：重点改写——删套话、缩短句子、去掉万能修饰词、把『赋能/打通』换成普通词",
          "   - 不动：人名、地名、数字、专业术语、组织机构名",
          "STEP 4. 改写原则：",
          "   - 保留原意和事实信息",
          "   - 长句拆短句，主动语态",
          "   - 用具体动词替代抽象动词（『提升』要看上下文换成『提高/加快/优化』）",
          "   - 不要降级到口水化，保持商务/学术/汇报合适的语气",
          "STEP 5. 用 wpp_replace_shape_text 把改写后的文字写回对应形状（slide + shape index）。",
          "STEP 6. 自检：再 wpp_list_slides 看一遍 textPreview。",
          "",
          "【其他要求】",
          "- 进度汇报：每完成一页简短报一次「第 X 页改了 Y 处」",
          "- 完成后总结：处理了几页 / 一共改了多少处 / 哪几页改动最大",
          "",
          "现在开始 STEP 1。"
        ].join("\n"),
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // ribbon 快捷指令：id 形如 "quick.<host>.<key>"
    if (id.startsWith("quick.")) {
      const parts = id.split(".");
      const host = parts[1];
      const key = parts.slice(2).join(".");
      const action = global.WpsAiQuickActions?.findByKey?.(host, key);
      if (!action) return true;

      // 纯展示 modal（stylePreset / outline）不改文档，不需要保存校验。
      // materialLibrary 虽然是"展示"形态，但「插入到文档」按钮会写文档 → 也要校验。
      const displayOnlyModals = ["stylePreset", "outline", "parallelTranslate"];
      const isDisplayOnly = action.modal && displayOnlyModals.includes(action.modal);
      if (blockedByUnsaved(isDisplayOnly)) return true;

      const app = getApplicationSync();

      // 标记了 modal 字段的 chip：开 modal 而不是直接发送 prompt
      if (action.modal) {
        const docPath = (host === "pdf" && action.modal === "parallelTranslate")
          ? (getActivePdfPathFromApp(app) || null)
          : null;
        if (host === "pdf" && action.modal === "parallelTranslate") {
          return openParallelTranslateDialog(app, docPath);
        }
        writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
          kind: "open-modal",
          modal: action.modal,
          host,
          key,
          docPath,
          ts: Date.now()
        }));
        ensureTaskPaneVisible();
        return true;
      }

      // 把 prompt + prefill 标记扔进 PluginStorage，由 taskpane 消费。
      // PDF 场景先短超时取一次本机路径并放进 payload；taskpane 再兜底复查。
      const writePending = (docPath) => {
        writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
          host,
          key,
          label: action.label,
          prompt: action.prompt,
          prefill: !!action.prefill,
          // optionalInput：弹窗里"补充要求"允许留空，留空就只发原 prompt（续写这种"想说就说"的场景）
          optionalInput: !!action.optionalInput,
          flow: action.flow || "",
          // tone / instruction：给 selectionTone 这类带"预设要求"的 flow 用，避免要么在 prompt 里塞要么在 dispatcher 里反查
          tone: action.tone || action.label || "",
          instruction: action.instruction || "",
          // documentReport 用：标识是 summary 还是 mindmap，影响弹窗渲染方式
          reportKind: action.reportKind || "",
          attachActivePdf: !!action.attachActivePdf,
          docPath: pickString(docPath) || null,
          ts: Date.now()
        }));
      };
      if (host === "pdf" || action.attachActivePdf) {
        Promise.resolve()
          .then(async () => {
            const path = await resolvePdfPathForRibbon(app, getActivePdfPathFromApp(app), 900);
            if (!path) {
              Promise.resolve()
                .then(() => withTimeout(probePdfPath(app || getApplicationSync()), 1500, null))
                .catch(() => {});
            }
            writePending(path);
          })
          .catch(() => writePending(""));
      } else {
        writePending("");
      }
      ensureTaskPaneVisible();
      return true;
    }
    return true;
  }
  global.__anthonyOnAction = handleRibbonAction;
  global.OnAction = function OnAction(control) {
    return handleRibbonAction(control);
  };

  // 仅打开（不切换），用在 ribbon 触发动作时
  function ensureTaskPaneVisibleWithApp(app) {
    const url = `${getUrlPath()}/taskpane.html`;
    const taskPaneHost = getTaskPaneHost(app);
    traceStatic("adapter.ensureTaskPaneVisible.enter", detectHostByApp(app));
    debugLog("ensureTaskPaneVisible.enter", {
      url,
      hasApp: !!app,
      hasCreateTaskPane: !!taskPaneHost && (typeof taskPaneHost.CreateTaskPane === "function" || typeof taskPaneHost.CreateTaskpane === "function"),
      taskPaneHost: taskPaneHost === app ? "app" : (taskPaneHost === global.wps ? "wps" : typeof taskPaneHost),
      host: detectHostByApp(app)
    });
    if (preferDialogPaneForHost()) {
      traceStatic("adapter.ensureTaskPaneVisible.prefer-dialog", url);
      debugLog("ensureTaskPaneVisible.prefer-dialog", { url });
      return openTaskPaneAsDialogWithApp(app);
    }
    if (taskPaneHost) {
      const storageHost = app || taskPaneHost;
      const existingId = readStorageItem(storageHost, TASKPANE_STORAGE_KEY);
      if (existingId) {
        try {
          const pane = getTaskPaneById(taskPaneHost, existingId);
          if (pane) {
            if (!pane.Visible) pane.Visible = true;
            // ribbon 触发的 ensureTaskPaneVisible 也重新写默认宽度（同 toggleTaskPane 的考量）
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-reshow"); } catch (e) {}
            traceStatic("adapter.ensureTaskPaneVisible.reuse", existingId);
            debugLog("ensureTaskPaneVisible.reuse", {
              existingId,
              visible: pane.Visible
            });
            return true;
          }
        } catch (e) {}
      }
      // 新建前先清扫历史 v key 下的孤儿 pane
      cleanupLegacyTaskPanes(storageHost);
      try {
        const pane = createTaskPaneViaHost(taskPaneHost, url);
        if (pane?.ID != null) writeStorageItem(storageHost, TASKPANE_STORAGE_KEY, String(pane.ID));
        try {
          const enumHost = getTaskPaneEnumHost(app, taskPaneHost);
          if (enumHost && enumHost.msoCTPDockPositionRight !== undefined) {
             pane.DockPosition = enumHost.msoCTPDockPositionRight;
          } else {
             pane.DockPosition = 2; 
          }
        } catch (e) {}
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-creation");
        pane.Visible = true;
        traceStatic("adapter.ensureTaskPaneVisible.created", pane?.ID != null ? String(pane.ID) : "no-id");
        debugLog("ensureTaskPaneVisible.created", {
          paneId: pane?.ID != null ? String(pane.ID) : "",
          visible: pane?.Visible
        });
        return true;
      } catch (e) {
        traceStatic("adapter.ensureTaskPaneVisible.create-failed", e?.message || String(e));
        debugLog("ensureTaskPaneVisible.create-failed", {
          message: e?.message || String(e)
        });
        return openTaskPaneAsDialogWithApp(app);
      }
    }
    traceStatic("adapter.ensureTaskPaneVisible.no-create-task-pane", url);
    debugLog("ensureTaskPaneVisible.no-create-task-pane", { url });
    return openTaskPaneAsDialogWithApp(app);
  }

  function ensureTaskPaneVisible() {
    const app = getApplicationSync();
    if (getTaskPaneHost(app)) return ensureTaskPaneVisibleWithApp(app);
    getApplication()
      .then((resolvedApp) => {
        ensureTaskPaneVisibleWithApp(resolvedApp);
      })
      .catch(() => {
        openTaskPaneAsDialogWithApp(null);
      });
    return true;
  }

  // ribbon dynamicMenu 内容：按 category 分组返回 OOXML，每组前用 menuSeparator 加标题
  global.GetQuickMenuContent = function GetQuickMenuContent(_control) {
    const app = getApplicationSync();
    const host = detectHostByApp(app);
    const groups = global.WpsAiQuickActions?.getRibbonGroups?.(host) || [];

    if (groups.length === 0) {
      return `<menu xmlns="http://schemas.microsoft.com/office/2006/01/customui">
        <button id="quickEmpty" label="（当前宿主无可用快捷指令）" enabled="false"/>
      </menu>`;
    }

    const parts = [];
    groups.forEach((g, gi) => {
      // 每组前面插入一条带标题的分隔线（首组不加间距前缀）
      parts.push(`<menuSeparator id="sep_${escapeXml(host)}_${escapeXml(g.category)}_${gi}" title="${escapeXml(g.label)}"/>`);
      g.actions.forEach((act) => {
        const id = `quick.${host}.${act.key}`;
        parts.push(`<button id="${escapeXml(id)}" label="${escapeXml(act.label)}" onAction="OnAction"/>`);
      });
    });

    return `<menu xmlns="http://schemas.microsoft.com/office/2006/01/customui">${parts.join("")}</menu>`;
  };

  function getRibbonImage(control) {
    const id = getRibbonControlId(control);
    const asPng = (path) => String(path || "images/ai.svg").replace(/\.svg(?:$|\?)/, (match) => match.replace(".svg", ".png"));
    let resolved = "";
    if (id === "openWpsAiPane") resolved = "images/ai.png";
    else if (id === "anthonyStyleBtn") resolved = "images/icons/palette.png";
    else if (id === "anthonyUnifyBtn") resolved = "images/icons/wand.png";
    else if (id === "anthonyDeAiBtn") resolved = "images/icons/scrub.png";
    // 快捷指令按钮：id 形如 quick.<host>.<key>，按 category 取分类图标
    else if (id.startsWith("quick.")) {
      const parts = id.split(".");
      const host = parts[1];
      const key = parts.slice(2).join(".");
      const action = global.WpsAiQuickActions?.findByKey?.(host, key);
      const cat = action?.category;
      const map = global.WpsAiQuickActions?.CATEGORY_ICON || {};
      resolved = asPng(map[cat]);
    }
    else {
      resolved = "images/ai.png";
    }
    traceStatic("adapter.GetImage", JSON.stringify({ id, resolved }));
    debugLog("GetImage", { id, resolved });
    return resolved;
  }
  global.__anthonyGetImage = getRibbonImage;
  global.GetImage = function GetImage(control) {
    return getRibbonImage(control);
  };

  function getRibbonEnabled(control) {
    const id = getRibbonControlId(control);
    traceStatic("adapter.OnGetEnabled", id);
    return true;
  }
  global.__anthonyOnGetEnabled = getRibbonEnabled;
  global.OnGetEnabled = function OnGetEnabled(control) {
    return getRibbonEnabled(control);
  };

  function getRibbonVisible(control) {
    const id = getRibbonControlId(control);
    traceStatic("adapter.OnGetVisible", id);
    return true;
  }
  global.__anthonyOnGetVisible = getRibbonVisible;
  global.OnGetVisible = function OnGetVisible(control) {
    return getRibbonVisible(control);
  };

  function drainEarlyRibbonQueue() {
    const queue = Array.isArray(global.__anthonyRibbonEarlyQueue)
      ? global.__anthonyRibbonEarlyQueue.splice(0)
      : [];
    global.__anthonyRibbonEarlyQueue = [];
    queue.forEach((item) => {
      if (!item || item.type !== "action") return;
      const control = item.id || item.control;
      if (!control) return;
      try {
        handleRibbonAction(control);
      } catch (e) {
        console.warn("[wps-ai] 回放早期 ribbon 点击失败:", e?.message || e);
      }
    });
  }

  if (global.__anthonyRibbonUI) {
    try {
      handleAddinLoad(global.__anthonyRibbonUI);
    } catch (e) {
      console.warn("[wps-ai] 接管早期 ribbonUI 失败:", e?.message || e);
    }
  }
  drainEarlyRibbonQueue();

  document.addEventListener("DOMContentLoaded", () => {
    if (!/(?:^|\/)taskpane\.html(?:[?#].*)?$/i.test(window.location.pathname)) {
      showEntryHint();
    }
  });
})(window);
