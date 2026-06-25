(function attachWpsAddonAdapter(global) {
  "use strict";

  // 存储 TaskPane id 的 PluginStorage 键名。
  // 后缀 _v11：v10 的 80%/[1200,2200] 视觉上确实生效到 965（WPS docked 天花板），
  // 但用户反馈太宽，砍一半到 40%/[600,1100]（即 v9 参数集）。
  // bump 后强制 WPS 下次重建 pane 拿新宽度。
  const TASKPANE_STORAGE_KEY = "lingxi_ai_taskpane_id_v11";

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
  const PENDING_ACTION_KEY = "lingxi_ai_pending_action";

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

  function getApplicationSync() {
    if (global.Application) return global.Application;
    if (typeof global.wps?.WpsApplication === "function") return global.wps.WpsApplication();
    if (typeof global.wps?.EtApplication === "function") return global.wps.EtApplication();
    if (typeof global.wps?.WppApplication === "function") return global.wps.WppApplication();
    return global.wps?.Application || null;
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

  // 上一代 storage key（按 TASKPANE_STORAGE_KEY 后缀往前推）。
  // 每次 bump v 后顺手把老 key 对应的 pane 删掉，避免老 pane 用旧宽度还活着。
  const LEGACY_TASKPANE_KEYS = [
    "lingxi_ai_taskpane_id_v10",
    "lingxi_ai_taskpane_id_v9",
    "lingxi_ai_taskpane_id_v8",
    "lingxi_ai_taskpane_id_v7",
    "lingxi_ai_taskpane_id_v6",
    "lingxi_ai_taskpane_id_v5",
    "lingxi_ai_taskpane_id_v4",
    "lingxi_ai_taskpane_id_v3",
    "lingxi_ai_taskpane_id_v2",
    "lingxi_ai_taskpane_id"
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
  function toggleTaskPane() {
    const url = `${getUrlPath()}/taskpane.html`;
    const app = getApplicationSync();

    if (app && typeof app.CreateTaskPane === "function") {
      try {
        const existingId = readStorageItem(app, TASKPANE_STORAGE_KEY);
        let pane = null;

        if (existingId && typeof app.GetTaskPane === "function") {
          try {
            pane = app.GetTaskPane(existingId);
          } catch (error) {
            pane = null;
          }
        }

        if (pane && typeof pane.Visible === "boolean") {
          const wantShow = !pane.Visible;
          pane.Visible = wantShow;
          // 每次"显示"时把默认宽度重新写一遍 —— dev 改 pickDefaultTaskPaneWidth 后立刻
          // 生效；生产用户手动 resize 后下次开会被重置，但开发体验优先。
          if (wantShow) {
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "toggle-reshow"); } catch (e) {}
          }
          return true;
        }

        // 新 v key 下没找到 pane（首次创建 / 版本 bump 后） → 先清扫历史 v key 下的孤儿 pane
        cleanupLegacyTaskPanes(app);

        // 尝试按照官方最简形式创建
        pane = app.CreateTaskPane(url);
        if (!pane) {
          throw new Error("CreateTaskPane 返回空对象");
        }
        if (pane.ID != null) {
          writeStorageItem(app, TASKPANE_STORAGE_KEY, String(pane.ID));
        }
        
        // msoCTPDockPositionRight 枚举值通常是 2
        try {
          if (app.Enum && app.Enum.msoCTPDockPositionRight !== undefined) {
             pane.DockPosition = app.Enum.msoCTPDockPositionRight;
          } else {
             pane.DockPosition = 2; 
          }
        } catch (e) {}

        // 设置一次初始宽度即可，去掉延迟覆盖等花式操作，避免干扰原生渲染
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "creation");
        
        pane.Visible = true;
        return true;
      } catch (error) {
        console.warn("[wps-ai] CreateTaskPane 失败，回退到 ShowDialog：", error);
        clearStorageItem(app, TASKPANE_STORAGE_KEY);
      }
    }

    return openTaskPaneAsDialog();
  }

  function openTaskPaneAsDialog() {
    const url = `${getUrlPath()}/taskpane.html`;
    const title = "灵犀AI";
    const width = Math.round(420 * (global.devicePixelRatio || 1));
    const height = Math.round(720 * (global.devicePixelRatio || 1));

    const app = getApplicationSync();
    if (app && typeof app.ShowDialog === "function") {
      app.ShowDialog(url, title, width, height, false);
      return true;
    }
    if (typeof global.wps?.ShowDialog === "function") {
      global.wps.ShowDialog(url, title, width, height, false);
      return true;
    }
    global.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  function showEntryHint() {
    if (!document.body || document.getElementById("lingxiEntryHint")) {
      return;
    }
    const wrapper = document.createElement("main");
    wrapper.id = "lingxiEntryHint";
    wrapper.style.cssText = "font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;padding:24px;line-height:1.7;color:#1f2329;";
    wrapper.innerHTML = `
      <h1 style="margin:0 0 12px;color:#1a6dff;">灵犀AI 加载项已启动</h1>
      <p>请在 WPS 顶部功能区查找 <strong>灵犀AI</strong> 选项卡，然后点击 <strong>打开灵犀AI</strong>。</p>
      <p>面板会嵌入到 WPS 右侧的任务窗格区域。再次点击同一按钮可以收起面板。</p>
      <button id="lingxiOpenBtn" type="button" style="border:0;border-radius:4px;padding:8px 16px;background:#1a6dff;color:#fff;font-weight:500;cursor:pointer;">直接打开灵犀AI</button>
    `;
    document.body.appendChild(wrapper);
    document.getElementById("lingxiOpenBtn")?.addEventListener("click", toggleTaskPane);
  }

  function setupRibbon(ribbonUI) {
    const app = getApplicationSync();
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
    getTaskPaneDockPosition,
    setTaskPaneDockPosition,
    toggleTaskPaneDock,
    resizeFloatingPane,
    getFloatingPaneSize
  };

  global.OnAddinLoad = function OnAddinLoad(ribbonUI) {
    return setupRibbon(ribbonUI);
  };

  global.OnAction = function OnAction(control) {
    const id = control?.Id || "";
    if (id === "openWpsAiPane") {
      return toggleTaskPane();
    }
    // PPT 风格按钮 → 打开 style preset modal
    if (id === "lingxiStyleBtn") {
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        kind: "open-modal",
        modal: "stylePreset",
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // 统一风格按钮 → 打开 unify modal
    if (id === "lingxiUnifyBtn") {
      const app = getApplicationSync();
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        kind: "open-modal",
        modal: "unify",
        ts: Date.now()
      }));
      ensureTaskPaneVisible();
      return true;
    }
    // 去 AI 味按钮 → 直接发起一个 PPT 文字改写对话（无 modal）
    if (id === "lingxiDeAiBtn") {
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

      const app = getApplicationSync();

      // 标记了 modal 字段的 chip：开 modal 而不是直接发送 prompt
      if (action.modal) {
        writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
          kind: "open-modal",
          modal: action.modal,
          host,
          key,
          ts: Date.now()
        }));
        ensureTaskPaneVisible();
        return true;
      }

      // 把 prompt + prefill 标记扔进 PluginStorage，由 taskpane 消费
      writeStorageItem(app, PENDING_ACTION_KEY, JSON.stringify({
        host,
        key,
        label: action.label,
        prompt: action.prompt,
        prefill: !!action.prefill,
        flow: action.flow || "",
        attachActivePdf: !!action.attachActivePdf,
        ts: Date.now()
      }));

      ensureTaskPaneVisible();
      return true;
    }
    return true;
  };

  // 仅打开（不切换），用在 ribbon 触发动作时
  function ensureTaskPaneVisible() {
    const url = `${getUrlPath()}/taskpane.html`;
    const app = getApplicationSync();
    if (app && typeof app.CreateTaskPane === "function") {
      const existingId = readStorageItem(app, TASKPANE_STORAGE_KEY);
      if (existingId && typeof app.GetTaskPane === "function") {
        try {
          const pane = app.GetTaskPane(existingId);
          if (pane) {
            if (!pane.Visible) pane.Visible = true;
            // ribbon 触发的 ensureTaskPaneVisible 也重新写默认宽度（同 toggleTaskPane 的考量）
            try { applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-reshow"); } catch (e) {}
            return true;
          }
        } catch (e) {}
      }
      // 新建前先清扫历史 v key 下的孤儿 pane
      cleanupLegacyTaskPanes(app);
      try {
        const pane = app.CreateTaskPane(url);
        if (pane?.ID != null) writeStorageItem(app, TASKPANE_STORAGE_KEY, String(pane.ID));
        try {
          if (app.Enum && app.Enum.msoCTPDockPositionRight !== undefined) {
             pane.DockPosition = app.Enum.msoCTPDockPositionRight;
          } else {
             pane.DockPosition = 2; 
          }
        } catch (e) {}
        applyTaskPaneWidth(pane, pickDefaultTaskPaneWidth(), "ribbon-creation");
        pane.Visible = true;
        return true;
      } catch (e) {
        return openTaskPaneAsDialog();
      }
    }
    return openTaskPaneAsDialog();
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

  global.GetImage = function GetImage(control) {
    const id = control?.Id || "";
    if (id === "openWpsAiPane") return "images/ai.svg";
    if (id === "lingxiStyleBtn") return "images/icons/palette.svg";
    if (id === "lingxiUnifyBtn") return "images/icons/wand.svg";
    if (id === "lingxiDeAiBtn") return "images/icons/scrub.svg";
    // 快捷指令按钮：id 形如 quick.<host>.<key>，按 category 取分类图标
    if (id.startsWith("quick.")) {
      const parts = id.split(".");
      const host = parts[1];
      const key = parts.slice(2).join(".");
      const action = global.WpsAiQuickActions?.findByKey?.(host, key);
      const cat = action?.category;
      const map = global.WpsAiQuickActions?.CATEGORY_ICON || {};
      return map[cat] || "images/ai.svg";
    }
    return "images/ai.svg";
  };

  global.OnGetEnabled = function OnGetEnabled() {
    return true;
  };

  global.OnGetVisible = function OnGetVisible() {
    return true;
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (!/(?:^|\/)taskpane\.html(?:[?#].*)?$/i.test(window.location.pathname)) {
      showEntryHint();
    }
  });
})(window);
