(function attachApp(global) {
  "use strict";

  const els = {};
  let currentSettings = null;
  let currentHostInfo = null;

  function $(id) { return document.getElementById(id); }

  function bindElements() {
    [
      "authBadge",
      "brandVersion", "aboutVersion",
      "message",
      "settingsView", "aiView",
      "providerSelect", "operationModeSelect", "maxToolIterationsInput",
      "signInBtn", "exchangeCodeBtn", "authCodeInput", "signOutBtn", "tokenInfo",
      "codexAuthArea", "codexSignedInArea",
      "openaiBaseUrl", "openaiApiKey", "openaiDefaultModel", "openaiUseProxy",
      "anthropicBaseUrl", "anthropicApiKey", "anthropicDefaultModel", "anthropicVersion", "anthropicUseProxy",
      "imageEnabled", "imageBaseUrl", "imageApiKey", "imageModel", "imageDefaultSize", "imageDefaultResolution", "imageUseProxy",
      "saveSettingsBtn", "testChatConnBtn", "testImageConnBtn",
      "exportSettingsBtn", "importSettingsBtn", "importSettingsFile",
      // PPT 风格 modal
      "stylePresetModal", "stylePresetCloseBtn", "styleSaveBtn", "styleCancelBtn",
      "styleEnabled", "styleTitleFont", "styleTitleSize", "styleTitleBold", "styleTitleColor",
      "styleBodyFont", "styleBodySize", "styleBodyColor",
      "styleScheme", "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor", "styleBackgroundColor", "styleSurfaceColor",
      "styleThemeFile",
      // 大纲 modal
      "outlineModal", "outlineCloseBtn", "outlineGenerateBtn", "outlineCancelBtn",
      "outlineText", "outlineExtractBtn", "outlineClearBtn",
      // 统一风格 modal
      "unifyModal", "unifyCloseBtn", "unifyExecuteBtn", "unifyCancelBtn",
      "unifyOutlineText", "unifyExtractBtn", "unifyClearBtn", "unifyAutoImage",
      "modelSelect", "refreshModelsBtn", "settingsToggleBtn",
      "aiPanelTitle", "aiPanelHint",
      "suggestedActions", "suggestedActionsList", "suggestedActionsClear",
      "chatStream", "chatPending", "chatPendingList",
      "chatApproveAllBtn", "chatRejectAllBtn",
      "chatInput", "chatSendBtn", "chatStopBtn", "chatClearBtn",
      // 改动记录
      "historyView", "historyBadge", "historyCount", "historyClearBtn",
      "historyEmpty", "historyList",
      // 纯净模式开关
      "pureModeToggle",
      // 多对话
      "newConversationBtn", "conversationsMenuBtn", "conversationsMenu",
      "conversationsMenuList", "conversationsMenuEmpty", "conversationsMenuClose",
      // AI 进度条
      "chatProgress", "chatProgressText"
    ].forEach((id) => { els[id] = $(id); });
  }

  let messageTimer = null;
  function showMessage(text, type = "info", { autoHide = true, duration } = {}) {
    if (!els.message) return;
    if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
    els.message.textContent = text;
    els.message.className = `message ${type}`;
    els.message.classList.toggle("hidden", !text);
    if (text && autoHide) {
      const ms = duration ?? (type === "error" ? 5000 : 3000);
      messageTimer = setTimeout(() => {
        els.message.classList.add("hidden");
        messageTimer = null;
      }, ms);
    }
  }

  function setBusy(isBusy) {
    [
      els.signInBtn, els.exchangeCodeBtn, els.signOutBtn,
      els.saveSettingsBtn, els.testChatConnBtn, els.testImageConnBtn, els.refreshModelsBtn
    ].forEach((b) => { if (b) b.disabled = isBusy; });
  }

  function setChatBusy(isBusy) {
    // Send 与 Stop 按钮互斥：忙碌时显示 Stop，否则显示 Send
    if (els.chatSendBtn) els.chatSendBtn.classList.toggle("hidden", isBusy);
    if (els.chatStopBtn) els.chatStopBtn.classList.toggle("hidden", !isBusy);

    [els.chatClearBtn, els.modelSelect].forEach((b) => { if (b) b.disabled = isBusy; });
    if (els.suggestedActionsList) {
      els.suggestedActionsList.querySelectorAll("button").forEach((b) => { b.disabled = isBusy; });
    }
    // 进度条：忙就显示+动画跑，闲就藏
    if (els.chatProgress) {
      els.chatProgress.classList.toggle("hidden", !isBusy);
      if (!isBusy) setProgressStatus(null);
    }
  }

  // AI 进度条状态文字：null 表示清空（隐藏文字但保留进度条容器结构）
  function setProgressStatus(text) {
    if (!els.chatProgressText) return;
    els.chatProgressText.textContent = text || "";
  }

  // 把工具名映射成中文，复用 history 模块里的字典
  function friendlyToolName(name) {
    return global.WpsAiHistory?.getFriendlyName?.(name) || name;
  }

  // ---------------- Tabs ----------------

  function activateTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("[data-tab-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.tabPanel !== name));
  }

  function bindTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
  }

  // ---------------- Settings ----------------

  function loadSettings() {
    currentSettings = global.WpsAiProviderRegistry.loadSettings();
    return currentSettings;
  }

  function persistSettings() {
    global.WpsAiProviderRegistry.saveSettings(currentSettings);
  }

  function applySettingsToForm() {
    const s = currentSettings;
    els.providerSelect.value = s.activeProvider;
    els.operationModeSelect.value = s.operationMode;
    els.maxToolIterationsInput.value = s.maxToolIterations || 50;

    const oa = s.providers.openai;
    els.openaiBaseUrl.value = oa.baseUrl || "";
    els.openaiApiKey.value = oa.apiKey || "";
    els.openaiDefaultModel.value = oa.defaultModel || "";
    els.openaiUseProxy.checked = oa.useProxy !== false;

    const an = s.providers.anthropic;
    els.anthropicBaseUrl.value = an.baseUrl || "";
    els.anthropicApiKey.value = an.apiKey || "";
    els.anthropicDefaultModel.value = an.defaultModel || "";
    els.anthropicVersion.value = an.anthropicVersion || "2023-06-01";
    els.anthropicUseProxy.checked = an.useProxy !== false;

    const img = s.imageProvider || {};
    els.imageEnabled.checked = !!img.enabled;
    els.imageBaseUrl.value = img.baseUrl || "";
    els.imageApiKey.value = img.apiKey || "";
    els.imageModel.value = img.model || "";
    els.imageDefaultSize.value = img.defaultSize || "1:1";
    els.imageDefaultResolution.value = img.defaultResolution || "1K";
    els.imageUseProxy.checked = img.useProxy !== false;

    refreshProviderConfigVisibility();
  }

  function readSettingsFromForm() {
    currentSettings.activeProvider = els.providerSelect.value;
    currentSettings.operationMode = els.operationModeSelect.value;
    const maxIter = parseInt(els.maxToolIterationsInput.value, 10);
    currentSettings.maxToolIterations = (Number.isFinite(maxIter) && maxIter > 0) ? maxIter : 50;
    Object.assign(currentSettings.providers.openai, {
      baseUrl: els.openaiBaseUrl.value.trim(),
      apiKey: els.openaiApiKey.value.trim(),
      defaultModel: els.openaiDefaultModel.value.trim() || "gpt-4o-mini",
      useProxy: els.openaiUseProxy.checked
    });
    Object.assign(currentSettings.providers.anthropic, {
      baseUrl: els.anthropicBaseUrl.value.trim(),
      apiKey: els.anthropicApiKey.value.trim(),
      defaultModel: els.anthropicDefaultModel.value.trim() || "claude-sonnet-4-6",
      anthropicVersion: els.anthropicVersion.value.trim() || "2023-06-01",
      useProxy: els.anthropicUseProxy.checked
    });
    currentSettings.imageProvider = Object.assign({}, currentSettings.imageProvider, {
      enabled: els.imageEnabled.checked,
      baseUrl: els.imageBaseUrl.value.trim() || "https://toapis.com/v1",
      apiKey: els.imageApiKey.value.trim(),
      model: els.imageModel.value.trim() || "gpt-image-2",
      defaultSize: els.imageDefaultSize.value,
      defaultResolution: els.imageDefaultResolution.value,
      useProxy: els.imageUseProxy.checked
    });
  }

  function refreshProviderConfigVisibility() {
    const active = els.providerSelect.value;
    document.querySelectorAll(".provider-config").forEach((node) => {
      node.classList.toggle("hidden", node.dataset.provider !== active);
    });
    refreshCodexAuthArea();
  }

  function refreshCodexAuthArea() {
    if (!els.codexAuthArea || !els.codexSignedInArea) return;
    const tokenInfo = global.WpsAiAuth.getTokenInfo();
    els.codexAuthArea.classList.toggle("hidden", tokenInfo.authenticated);
    els.codexSignedInArea.classList.toggle("hidden", !tokenInfo.authenticated);
    if (els.tokenInfo) {
      els.tokenInfo.textContent = tokenInfo.expiresAtText
        ? `Token 有效期至：${tokenInfo.expiresAtText}`
        : "已登录";
    }
  }

  // ---------------- Header status ----------------

  function isProviderReady(info) {
    if (!info) return false;
    if (info.type === "codex") return global.WpsAiAuth.isAuthenticated();
    const cfg = currentSettings.providers[info.id];
    return Boolean(cfg && cfg.apiKey && cfg.baseUrl);
  }

  function renderProviderState() {
    const info = global.WpsAiOpenAI.getActiveProviderInfo();
    if (!info) {
      els.authBadge.textContent = "未配置";
      els.authBadge.className = "badge badge-muted";
      els.authBadge.title = "请在设置中配置服务";
      return;
    }

    const ready = isProviderReady(info);
    els.authBadge.textContent = ready ? (info.type === "codex" ? "已登录" : "就绪") : "未配置";
    els.authBadge.className = ready ? "badge badge-success" : "badge badge-muted";
    els.authBadge.title = `${info.label}${ready ? "（已就绪）" : "（未配置）"}`;
  }

  // ---------------- Models ----------------

  function setModelOptions(models, selected) {
    els.modelSelect.innerHTML = "";
    const list = (models || []).filter(Boolean);
    if (list.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（请先在设置中配置并测试连通）";
      opt.disabled = true;
      els.modelSelect.appendChild(opt);
      els.modelSelect.value = "";
      return;
    }
    const unique = Array.from(new Set([selected, ...list])).filter(Boolean);
    unique.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      els.modelSelect.appendChild(opt);
    });
    els.modelSelect.value = unique.includes(selected) ? selected : unique[0] || "";
  }

  function showLoadingModels(text = "（加载模型中...）") {
    els.modelSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = text;
    opt.disabled = true;
    els.modelSelect.appendChild(opt);
  }

  /**
   * 模型列表只显示当前 provider 实际返回的模型，不再回落到硬编码 fallback。
   * 失败时下拉显示占位提示。选中策略：当前下拉值 → 设置里的默认模型 → 列表第一项。
   */
  async function refreshModels({ silent = false } = {}) {
    if (!silent) {
      setBusy(true);
      showMessage("正在获取模型列表...", "info");
    }
    // 优先保持当前选中；启动时 modelSelect.value 是空，回落到设置里的 defaultModel
    const previous = els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel();
    showLoadingModels();
    try {
      const models = await global.WpsAiOpenAI.listModels();
      setModelOptions(models, previous);
      if (!silent) showMessage(`已获取 ${models.length} 个模型。`, "success");
    } catch (error) {
      setModelOptions([], "");
      if (!silent) showMessage(`获取模型失败：${error.message || error}`, "error");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  // ---------------- Host detection + quick actions ----------------

  const QUICK_ACTIONS = (window.WpsAiQuickActions && window.WpsAiQuickActions.QUICK_ACTIONS) || {};

  const HOST_TITLES = {
    wps: {
      title: "WPS 文字 助手",
      hint: "对话让 AI 读写文档；顶部 ribbon 写作 / 润色 / 翻译 / 文档 / 图像 6 组快捷入口"
    },
    et: {
      title: "WPS 表格 助手",
      hint: "对话让 AI 读写单元格、行列、工作表；顶部 ribbon 美化 / 数据 / 智能 3 组快捷入口"
    },
    wpp: {
      title: "WPS 演示 助手",
      hint: "对话让 AI 读写幻灯片；顶部 ribbon 生成 / 改写 / 校对 4 组快捷入口；「PPT 风格」按钮设置统一样式，「大纲生成 PPT」打开大纲弹窗"
    },
    unknown: {
      title: "AI 助手",
      hint: "未识别到 WPS 宿主，请在 WPS 文字 / 表格 / 演示 中打开本插件"
    }
  };

  function renderQuickActions() {
    // 静态快捷指令已搬到顶部 ribbon 顶层按钮组，面板内不再重复渲染 chip。
    // 仍负责更新 AI Tab 的标题/副标题（宿主 + 操作模式）。
    const host = currentHostInfo?.host || "unknown";
    const meta = HOST_TITLES[host] || HOST_TITLES.unknown;
    els.aiPanelTitle.textContent = meta.title;
    const modeText = currentSettings?.operationMode === "direct" ? "直接写入" : "预览确认";
    els.aiPanelHint.textContent = `${meta.hint} · 当前模式：${modeText}`;
  }

  // ---- AI 推荐操作（由 suggest_quick_actions 工具调用动态渲染） ----

  function renderSuggestedActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) {
      hideSuggestedActions();
      return;
    }
    els.suggestedActionsList.innerHTML = "";
    actions.forEach((act) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-action-chip suggested-chip";
      btn.textContent = act.label;
      btn.title = act.prompt;
      btn.addEventListener("click", () => {
        if (els.chatSendBtn.disabled) return;
        runChatTurn(act.prompt);
      });
      els.suggestedActionsList.appendChild(btn);
    });
    els.suggestedActions.classList.remove("hidden");
  }

  function hideSuggestedActions() {
    els.suggestedActions.classList.add("hidden");
    els.suggestedActionsList.innerHTML = "";
  }

  async function detectHost() {
    try {
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
    } catch (error) {
      currentHostInfo = { host: "unknown", label: "未知宿主" };
    }
    renderQuickActions();
    renderProviderState();
  }

  // ---------------- Chat (Tool Use) ----------------

  const chatHistory = [];

  // 复用：图标按钮 SVG 字符串
  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>';
  const ICON_REFILL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4 9 9l-3-3-3 3"/><path d="M14 4h-4M14 4v4"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 5"/></svg>';

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fallthrough to execCommand */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function makeActionBtn(icon, title, handler) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-action-btn";
    btn.title = title;
    btn.innerHTML = icon;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handler(btn);
    });
    return btn;
  }

  function flashCopied(btn) {
    const oldHtml = btn.innerHTML;
    btn.innerHTML = ICON_CHECK;
    btn.classList.add("copied");
    setTimeout(() => {
      btn.innerHTML = oldHtml;
      btn.classList.remove("copied");
    }, 900);
  }

  function appendChatMsg(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}${opts.kind ? " " + opts.kind : ""}`;

    // 头部行：左侧标签 + 右侧动作图标（hover 显示）
    const header = document.createElement("div");
    header.className = "chat-msg-header";
    if (opts.label) {
      const labelEl = document.createElement("span");
      labelEl.className = "chat-msg-label";
      labelEl.textContent = opts.label;
      header.appendChild(labelEl);
    }

    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";

    if (role === "user") {
      actions.appendChild(makeActionBtn(ICON_COPY, "复制", async (btn) => {
        const ok = await copyToClipboard(div.dataset.copyText || "");
        if (ok) flashCopied(btn);
      }));
      actions.appendChild(makeActionBtn(ICON_REFILL, "回填到输入框", () => {
        if (els.chatInput) {
          els.chatInput.value = div.dataset.copyText || "";
          els.chatInput.focus();
        }
      }));
    } else if (role === "assistant" && opts.kind !== "err") {
      actions.appendChild(makeActionBtn(ICON_COPY, "复制", async (btn) => {
        const ok = await copyToClipboard(div.dataset.copyText || "");
        if (ok) flashCopied(btn);
      }));
    }

    header.appendChild(actions);
    div.appendChild(header);

    // 内容主体（独立一行，块级）
    const body = document.createElement("div");
    body.className = "chat-msg-body";
    if (opts.html) {
      body.innerHTML = opts.html;
    } else {
      body.textContent = text;
    }
    div.appendChild(body);

    // 把可复制的纯文本存到 dataset；流式气泡后续会更新这个值
    div.dataset.copyText = opts.copyText != null ? opts.copyText : (text || "");

    els.chatStream.appendChild(div);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return div;
  }

  function renderAssistantText(text) {
    const html = global.WpsAiMarkdown
      ? global.WpsAiMarkdown.renderToHtml(text)
      : (text || "").replace(/\n/g, "<br/>");
    return appendChatMsg("assistant", "", { label: "AI", html, copyText: text });
  }

  // ---- Thinking indicator ----
  // 在 AI 思考阶段（请求未返回、或工具执行后等待下一轮）显示一个临时占位气泡。
  let thinkingTimer = null;
  function showThinking(text = "AI 正在思考") {
    hideThinking();
    const div = document.createElement("div");
    div.id = "chatThinking";
    div.className = "chat-msg assistant thinking";

    const label = document.createElement("span");
    label.className = "chat-msg-label";
    label.textContent = "AI";
    div.appendChild(label);

    const body = document.createElement("span");
    body.className = "thinking-body";
    body.innerHTML = `<span class="dot-typing"><span></span><span></span><span></span></span><span class="thinking-text">${text}</span>`;
    div.appendChild(body);

    els.chatStream.appendChild(div);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
  }

  function hideThinking() {
    const node = document.getElementById("chatThinking");
    if (node) node.remove();
  }

  function oneLine(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }

  /**
   * 折叠式工具消息：默认单行（工具名 + 单行预览 + 折叠箭头），点击展开完整 JSON。
   */
  function appendCollapsibleToolMsg({ kind, label, name, summary, fullText }) {
    const wrap = document.createElement("div");
    wrap.className = `chat-msg tool collapsible ${kind || ""}`;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";

    const labelSpan = document.createElement("span");
    labelSpan.className = "chat-msg-label";
    labelSpan.textContent = label;
    head.appendChild(labelSpan);

    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name-inline";
    nameSpan.textContent = name;
    head.appendChild(nameSpan);

    const previewSpan = document.createElement("span");
    previewSpan.className = "tool-preview";
    previewSpan.textContent = summary;
    head.appendChild(previewSpan);

    const chev = document.createElement("span");
    chev.className = "tool-chevron";
    chev.textContent = "▶";
    head.appendChild(chev);

    const body = document.createElement("pre");
    body.className = "tool-body";
    body.textContent = fullText;

    wrap.appendChild(head);
    wrap.appendChild(body);

    head.addEventListener("click", () => {
      const expanded = wrap.classList.toggle("expanded");
      chev.textContent = expanded ? "▼" : "▶";
    });

    els.chatStream.appendChild(wrap);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return wrap;
  }

  function appendToolCallMsg(name, args) {
    let pretty = "";
    let preview = "";
    try {
      pretty = JSON.stringify(args, null, 2);
      preview = oneLine(JSON.stringify(args));
    } catch (e) {
      pretty = String(args);
      preview = oneLine(pretty);
    }
    return appendCollapsibleToolMsg({
      label: "调用",
      name,
      summary: preview,
      fullText: pretty
    });
  }

  function appendToolResultMsg(name, result) {
    const ok = !!result.ok;
    let pretty;
    let preview;
    if (!ok) {
      pretty = result.error || "执行失败";
      preview = oneLine(pretty);
    } else {
      try {
        pretty = JSON.stringify(result.value, null, 2);
        preview = oneLine(JSON.stringify(result.value));
      } catch (e) {
        pretty = String(result.value);
        preview = oneLine(pretty);
      }
    }
    return appendCollapsibleToolMsg({
      kind: ok ? "ok" : "err",
      label: ok ? "结果" : "失败",
      name,
      summary: preview,
      fullText: pretty
    });
  }

  function showPendingApproval(calls) {
    return new Promise((resolve) => {
      els.chatPendingList.innerHTML = "";
      calls.forEach((call) => {
        let pretty;
        try { pretty = JSON.stringify(call.args, null, 2); } catch (e) { pretty = String(call.args); }
        const preview = oneLine(pretty);

        // 折叠式卡片：默认收起，点击头部展开/收起完整 JSON
        const item = document.createElement("div");
        item.className = "chat-pending-item collapsible";

        const head = document.createElement("button");
        head.type = "button";
        head.className = "pending-head";

        const nameSpan = document.createElement("span");
        nameSpan.className = "pending-name";
        nameSpan.textContent = call.name;
        head.appendChild(nameSpan);

        const previewSpan = document.createElement("span");
        previewSpan.className = "pending-preview";
        previewSpan.textContent = preview;
        head.appendChild(previewSpan);

        const chev = document.createElement("span");
        chev.className = "pending-chevron";
        chev.textContent = "▶";
        head.appendChild(chev);

        const body = document.createElement("pre");
        body.className = "pending-body";
        body.textContent = pretty;

        item.appendChild(head);
        item.appendChild(body);

        head.addEventListener("click", () => {
          const expanded = item.classList.toggle("expanded");
          chev.textContent = expanded ? "▼" : "▶";
        });

        els.chatPendingList.appendChild(item);
      });
      els.chatPending.classList.remove("hidden");

      const cleanup = () => {
        els.chatPending.classList.add("hidden");
        els.chatApproveAllBtn.removeEventListener("click", onApprove);
        els.chatRejectAllBtn.removeEventListener("click", onReject);
      };
      const onApprove = () => { cleanup(); resolve({ approved: true }); };
      const onReject = () => { cleanup(); resolve({ approved: false, reason: "用户取消执行" }); };
      els.chatApproveAllBtn.addEventListener("click", onApprove);
      els.chatRejectAllBtn.addEventListener("click", onReject);
    });
  }

  async function buildChatApprover() {
    if (currentSettings.operationMode === "direct") return null;

    let pendingBatch = [];
    let pendingPromise = null;
    let pendingResolver = null;

    return async function approveTool(call) {
      pendingBatch.push(call);
      if (!pendingPromise) {
        pendingPromise = new Promise((resolve) => { pendingResolver = resolve; });
        setTimeout(async () => {
          const calls = pendingBatch.slice();
          pendingBatch = [];
          const result = await showPendingApproval(calls);
          pendingResolver(result);
          pendingPromise = null;
          pendingResolver = null;
        }, 0);
      }
      return pendingPromise;
    };
  }

  let currentAbortController = null;

  function stopChat() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    hideThinking();
    setChatBusy(false);
    appendChatMsg("assistant", "（已停止）", { label: "AI", kind: "err" });
  }

  async function runChatTurn(userInput) {
    // 上一轮还没退出就强制中止，避免请求叠加
    if (currentAbortController) {
      try { currentAbortController.abort(); } catch (e) { /* ignore */ }
    }
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    setChatBusy(true);
    setProgressStatus("AI 正在思考…");
    appendChatMsg("user", userInput, { label: "我" });
    chatHistory.push({ role: "user", content: userInput });

    // 开启新一轮 history turn——之后第一个修改型工具会懒抓文档备份
    try { global.WpsAiHistory?.startTurn?.(userInput); } catch (e) {}

    // 收集本轮所有 UI 事件（user / reasoning / tool_call / tool_result / assistant）
    // 切换历史对话时按这个事件流重布 chat 流，完整还原"应答过程"
    const turnEvents = [{ type: "user", text: userInput, ts: Date.now() }];
    let lastReasoningText = "";

    try {
      // 每轮 chat 前重新探测一次 host，避免用户切换宿主后工具集错位
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      const tools = global.WpsAiToolRegistry.listForHost(currentHostInfo.host);
      const model = els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel();

      // 如果在 PPT 宿主且用户启用了风格预设，把要点写进系统提示
      let stylePresetNote = "";
      if (currentHostInfo.host === "wpp" && currentSettings?.stylePreset?.enabled) {
        const sp = currentSettings.stylePreset;
        stylePresetNote = [
          "用户已启用 PPT 风格预设——本次对话生成 / 修改的所有幻灯片必须保持以下统一样式：",
          `  · 标题：字体 ${sp.titleFont}，字号 ${sp.titleSize}pt，${sp.titleBold ? "加粗" : "常规"}，颜色 ${sp.titleColor}`,
          `  · 正文：字体 ${sp.bodyFont}，字号 ${sp.bodySize}pt，颜色 ${sp.bodyColor}`,
          `  · 强调色：${sp.accentColor}`,
          sp.themeFile ? `  · 主题模板：${sp.themeFile}（每页生成完毕后调用 wpp_apply_theme(themePath=该路径) 套用）` : "",
          "实践：每次 wpp_add_slide 之后调一次 wpp_apply_style_preset 自动套用预设；如果有自定义文本框（wpp_add_text_box）也按上面的字体字号填。"
        ].filter(Boolean).join("\n");
      }

      const systemPrompt = [
        "你是嵌入 WPS Office 的中文智能助理，可以通过工具直接读写当前打开的文档。",
        `当前宿主：${currentHostInfo.label}（${currentHostInfo.host}）。只调用与当前宿主匹配的工具。`,
        "决策原则：先用 read 类工具了解现状，再用 write/format 类工具修改。每一步告诉用户你做了什么。",
        currentHostInfo.host === "wps"
          ? "在 WPS 文字 写文本时，可以直接用 markdown（# 标题、**粗体**、- 列表、`代码`），插件会渲染为 Word 原生格式。"
          : "",
        stylePresetNote,
        "工具失败时分析原因，必要时换实现，不要重复同一种失败调用。"
      ].filter(Boolean).join("\n");

      const messages = [
        { role: "system", content: systemPrompt },
        ...chatHistory.map((m) => ({ role: m.role, content: m.content }))
      ];

      const approver = await buildChatApprover();
      let assistantText = "";
      // 流式 chunk 累积进同一个气泡；下一个 tool_call 或 done 时清空标记
      let streamingBubble = null;
      // 思考过程独立气泡（DeepSeek reasoner 等推理模型）
      let reasoningBubble = null;

      const updateStreamingBubble = (fullText) => {
        if (!streamingBubble) {
          streamingBubble = appendChatMsg("assistant", "", { label: "AI", html: "" });
        }
        const body = streamingBubble.querySelector(".chat-msg-body");
        if (body) {
          body.innerHTML = global.WpsAiMarkdown
            ? global.WpsAiMarkdown.renderToHtml(fullText)
            : (fullText || "").replace(/\n/g, "<br/>");
        }
        // 让"复制 AI 回复"按钮总是拿到最新的完整 markdown 文本
        streamingBubble.dataset.copyText = fullText || "";
        els.chatStream.scrollTop = els.chatStream.scrollHeight;
      };

      const ensureReasoningBubble = () => {
        if (reasoningBubble) return reasoningBubble;
        const wrap = document.createElement("div");
        wrap.className = "chat-msg reasoning collapsible expanded";

        const head = document.createElement("button");
        head.type = "button";
        head.className = "tool-head";
        const label = document.createElement("span");
        label.className = "chat-msg-label";
        label.textContent = "思考中";
        head.appendChild(label);
        const preview = document.createElement("span");
        preview.className = "tool-preview reasoning-preview";
        preview.textContent = "";
        head.appendChild(preview);
        const chev = document.createElement("span");
        chev.className = "tool-chevron";
        chev.textContent = "▼";
        head.appendChild(chev);

        const body = document.createElement("div");
        body.className = "tool-body reasoning-body";

        wrap.appendChild(head);
        wrap.appendChild(body);
        head.addEventListener("click", () => {
          const expanded = wrap.classList.toggle("expanded");
          chev.textContent = expanded ? "▼" : "▶";
        });

        els.chatStream.appendChild(wrap);
        els.chatStream.scrollTop = els.chatStream.scrollHeight;
        reasoningBubble = wrap;
        return wrap;
      };

      const updateReasoningBubble = (fullText) => {
        const wrap = ensureReasoningBubble();
        const body = wrap.querySelector(".reasoning-body");
        const preview = wrap.querySelector(".reasoning-preview");
        if (body) body.textContent = fullText;
        if (preview) {
          // 头部预览只显示最后一行（流式时让用户能看到最近的思考）
          const lastLine = fullText.split(/\n+/).filter(Boolean).slice(-1)[0] || "";
          preview.textContent = lastLine;
        }
        els.chatStream.scrollTop = els.chatStream.scrollHeight;
      };

      const finalizeReasoningBubble = () => {
        if (!reasoningBubble) return;
        // 思考结束：标题改成"已完成"，自动折叠（用户可点开查看）
        const label = reasoningBubble.querySelector(".chat-msg-label");
        if (label) label.textContent = "思考过程";
        const chev = reasoningBubble.querySelector(".tool-chevron");
        reasoningBubble.classList.remove("expanded");
        if (chev) chev.textContent = "▶";
        reasoningBubble = null;
      };

      // 第一轮请求开始前先把 thinking 占位气泡显示出来
      showThinking("AI 正在思考");

      await global.WpsAiOpenAI.runWithTools({
        model,
        messages,
        tools,
        signal,
        maxIterations: currentSettings?.maxToolIterations || 50,
        approveTool: approver || undefined,
        onEvent: async (ev) => {
          switch (ev.type) {
            case "reasoning_chunk":
              // 推理模型的"思考过程"流式输出，单独一个气泡
              hideThinking();
              setProgressStatus("AI 正在推理…");
              updateReasoningBubble(ev.fullText);
              lastReasoningText = ev.fullText || lastReasoningText;
              break;
            case "reasoning_end":
              // 思考结束（即将出正文或工具调用），把思考气泡折叠收起
              finalizeReasoningBubble();
              setProgressStatus("AI 正在思考…");
              if (lastReasoningText) {
                turnEvents.push({ type: "reasoning", text: lastReasoningText, ts: Date.now() });
                lastReasoningText = "";
              }
              break;
            case "assistant_chunk":
              // 真正答复的第一个 token：移除 thinking，封掉思考气泡，创建答复气泡
              hideThinking();
              finalizeReasoningBubble();
              setProgressStatus("AI 正在生成回复…");
              updateStreamingBubble(ev.fullText);
              break;
            case "assistant_text_end":
              if (ev.text) {
                assistantText = ev.text;
                turnEvents.push({ type: "assistant", text: ev.text, ts: Date.now() });
              }
              streamingBubble = null;
              break;
            case "assistant_text":
              // 非流式 provider 兜底
              hideThinking();
              finalizeReasoningBubble();
              setProgressStatus("AI 正在生成回复…");
              if (ev.text) {
                assistantText = ev.text;
                renderAssistantText(ev.text);
                turnEvents.push({ type: "assistant", text: ev.text, ts: Date.now() });
              }
              streamingBubble = null;
              break;
            case "tool_call":
              hideThinking();
              finalizeReasoningBubble();
              streamingBubble = null;
              appendToolCallMsg(ev.name, ev.args);
              setProgressStatus(`AI 正在执行：${friendlyToolName(ev.name)}`);
              showThinking("正在执行工具调用");
              turnEvents.push({ type: "tool_call", name: ev.name, args: ev.args, ts: Date.now() });
              break;
            case "tool_result":
              hideThinking();
              appendToolResultMsg(ev.name, ev.result);
              if (ev.name === "suggest_quick_actions" && ev.result?.ok) {
                renderSuggestedActions(ev.result.value?.actions || []);
              }
              setProgressStatus(`已完成：${friendlyToolName(ev.name)},继续思考…`);
              showThinking("AI 正在思考");
              turnEvents.push({ type: "tool_result", name: ev.name, result: ev.result, ts: Date.now() });
              break;
            case "done":
              hideThinking();
              finalizeReasoningBubble();
              streamingBubble = null;
              setProgressStatus(null);
              break;
          }
        }
      });

      hideThinking();

      if (assistantText) {
        chatHistory.push({ role: "assistant", content: assistantText });
      }
    } catch (error) {
      hideThinking();
      // 用户主动中止时，AbortError 不当成错误展示（已经在 stopChat 里展示过"已停止"）
      const isAbort = error?.name === "AbortError" || /aborted/i.test(error?.message || "");
      if (!isAbort) {
        appendChatMsg("assistant", `错误：${error.message || error}`, { label: "AI", kind: "err" });
      }
    } finally {
      hideThinking();
      setChatBusy(false);
      currentAbortController = null;
      // 每轮结束把 chatHistory + 本轮事件流同步到当前 conversation
      try { global.WpsAiConversations?.syncMessages?.(chatHistory); } catch (e) {}
      try { global.WpsAiConversations?.appendTurnEvents?.(turnEvents); } catch (e) {}
    }
  }

  // ---------------- Settings actions ----------------

  function saveSettings() {
    readSettingsFromForm();
    persistSettings();
    renderProviderState();
    // 设置变更后静默刷新模型列表（保存配置常常意味着 provider/baseUrl/key 改了）
    refreshModels({ silent: true });
    showMessage("设置已保存。", "success");
  }

  async function testChatConnection() {
    readSettingsFromForm();
    persistSettings();
    setBusy(true);
    showMessage("正在测试对话接口...", "info");
    try {
      const models = await global.WpsAiOpenAI.listModels();
      showMessage(`对话接口连通正常，发现 ${models.length} 个模型。`, "success");
      setModelOptions(models, els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel());
    } catch (error) {
      showMessage(`对话接口测试失败：${error.message || error}`, "error");
    } finally {
      setBusy(false);
      renderProviderState();
    }
  }

  async function testImageConnection() {
    readSettingsFromForm();
    persistSettings();

    const cfg = currentSettings.imageProvider || {};
    if (!cfg.enabled) {
      showMessage("图像生成尚未启用。请勾选「启用图像生成」。", "error");
      return;
    }
    if (!cfg.baseUrl || !cfg.apiKey) {
      showMessage("请先填写图像 baseUrl 和 API Key。", "error");
      return;
    }

    setBusy(true);
    showMessage("正在测试图像接口...", "info");

    // 组装实际请求 URL（支持 useProxy）
    const PROXY_PREFIX = "http://localhost:3890/forward/";
    const base = String(cfg.baseUrl).replace(/\/+$/, "");
    const targetBase = cfg.useProxy === false ? base : PROXY_PREFIX + encodeURIComponent(base);

    try {
      // 优先 GET /models 探活：成本最低，几乎所有 OpenAI 兼容端点都支持
      const resp = await fetch(`${targetBase}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.apiKey}` }
      });
      if (resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        const list = Array.isArray(payload.data) ? payload.data : [];
        const hasModel = list.some((m) => (m.id || m.name) === cfg.model);
        if (hasModel) {
          showMessage(`图像接口连通正常，模型「${cfg.model}」存在。`, "success");
        } else {
          showMessage(`图像接口连通正常，但模型列表里没找到「${cfg.model}」。配置仍可保存，调用时请确认模型名拼写。`, "info", { duration: 6000 });
        }
      } else if (resp.status === 401) {
        showMessage(`图像接口认证失败（401）。请检查 API Key。`, "error");
      } else if (resp.status === 404 || resp.status === 405) {
        // 端点不暴露 /models（部分图像专用服务），降级提示
        showMessage(`图像接口未暴露 /models（HTTP ${resp.status}）。这通常是图像专用服务的正常情况，配置可保存后直接试用。`, "info", { duration: 6000 });
      } else {
        const payload = await resp.json().catch(() => ({}));
        showMessage(`图像接口测试失败（${resp.status}）：${payload.error?.message || "未知错误"}`, "error");
      }
    } catch (error) {
      showMessage(`图像接口测试失败：${error.message || error}`, "error");
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Settings import / export ----------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  function exportSettings() {
    // 先把表单状态同步进 currentSettings（用户可能改了没保存就直接导出）
    readSettingsFromForm();
    persistSettings();

    const now = new Date();
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const payload = {
      app: "lingxi-ai",
      version: 1,
      exportedAt: now.toISOString(),
      settings: currentSettings
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lingxi-ai-settings-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);

    showMessage("已导出当前配置（含 API Key，请勿公开分享）。", "info", { duration: 4500 });
  }

  function applyImportedSettings(parsed) {
    // 接受两种结构：1) 完整封装 { app, version, settings }；2) 直接是 settings 主体
    const incoming = parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object"
      ? parsed.settings
      : parsed;

    if (!incoming || typeof incoming !== "object") {
      throw new Error("文件内容不是合法的配置 JSON。");
    }

    // 用注册表的默认值兜底，再用导入的值覆盖（防御未来字段缺失）
    const defaults = global.WpsAiProviderRegistry.DEFAULT_SETTINGS;
    const cloned = JSON.parse(JSON.stringify(defaults));

    if (typeof incoming.activeProvider === "string") cloned.activeProvider = incoming.activeProvider;
    if (typeof incoming.operationMode === "string") cloned.operationMode = incoming.operationMode;

    if (incoming.providers && typeof incoming.providers === "object") {
      Object.keys(cloned.providers).forEach((key) => {
        if (incoming.providers[key]) {
          cloned.providers[key] = Object.assign({}, cloned.providers[key], incoming.providers[key]);
        }
      });
    }
    if (incoming.imageProvider && typeof incoming.imageProvider === "object") {
      cloned.imageProvider = Object.assign({}, cloned.imageProvider, incoming.imageProvider);
    }

    currentSettings = cloned;
    persistSettings();
    applySettingsToForm();
    refreshModels({ silent: true });
    renderProviderState();
  }

  function importSettings(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showMessage("读取文件失败。", "error");
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        applyImportedSettings(parsed);
        showMessage(`已从 ${file.name} 导入配置。`, "success");
      } catch (error) {
        showMessage(`导入失败：${error.message || error}`, "error");
      }
    };
    reader.readAsText(file, "utf-8");
  }

  // ---------------- PPT 风格 / 大纲 modal ----------------

  // 12 套主题预设（与 registry.js 的 COLOR_SCHEMES 镜像；前端单独存一份避免跨文件依赖）
  // 与 registry.js 中的 COLOR_SCHEMES 保持同步——配色经过对比度核对，并附设计灵感来源
  const COLOR_SCHEMES = {
    "bold-signal":       { darkMode: false, primaryColor: "#1A1A1A", secondaryColor: "#525252", accentColor: "#FF5722", backgroundColor: "#FAFAFA", surfaceColor: "#F4F4F5", titleColor: "#1A1A1A", bodyColor: "#404040", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "electric-studio":   { darkMode: false, primaryColor: "#2563EB", secondaryColor: "#1E3A8A", accentColor: "#F97316", backgroundColor: "#FFFFFF", surfaceColor: "#F1F5F9", titleColor: "#0F172A", bodyColor: "#475569", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "creative-voltage":  { darkMode: false, primaryColor: "#C2410C", secondaryColor: "#1E40AF", accentColor: "#EAB308", backgroundColor: "#FAF3E7", surfaceColor: "#FCE7C5", titleColor: "#1C1917", bodyColor: "#57534E", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "dark-botanical":    { darkMode: true,  primaryColor: "#2D4A38", secondaryColor: "#4A6B53", accentColor: "#B8916D", backgroundColor: "#0F1A14", surfaceColor: "#1F2D24", titleColor: "#EFE8D7", bodyColor: "#A9B3A4", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "notebook-tabs":     { darkMode: false, primaryColor: "#1E40AF", secondaryColor: "#B91C1C", accentColor: "#B45309", backgroundColor: "#FAFAF2", surfaceColor: "#F5F0DC", titleColor: "#1C1917", bodyColor: "#44403C", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "pastel-geometry":   { darkMode: false, primaryColor: "#8B7CF6", secondaryColor: "#FBA774", accentColor: "#5EEAD4", backgroundColor: "#FFFCF7", surfaceColor: "#F3EEFF", titleColor: "#312E81", bodyColor: "#4F4870", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "split-pastel":      { darkMode: false, primaryColor: "#EC4899", secondaryColor: "#06B6D4", accentColor: "#FACC15", backgroundColor: "#FFFFFF", surfaceColor: "#FFE4ED", titleColor: "#831843", bodyColor: "#4A2A4A", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "vintage-editorial": { darkMode: false, primaryColor: "#5C2A2A", secondaryColor: "#8B6F47", accentColor: "#C8553D", backgroundColor: "#F0E8D6", surfaceColor: "#E0D4BC", titleColor: "#1C0D02", bodyColor: "#3A2E1F", titleFont: "宋体",            bodyFont: "宋体" },
    "neon-cyber":        { darkMode: true,  primaryColor: "#6366F1", secondaryColor: "#8B5CF6", accentColor: "#22D3EE", backgroundColor: "#0A0E1A", surfaceColor: "#131829", titleColor: "#F8FAFC", bodyColor: "#94A3B8", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "terminal-green":    { darkMode: true,  primaryColor: "#4ADE80", secondaryColor: "#FBBF24", accentColor: "#F87171", backgroundColor: "#0D1117", surfaceColor: "#161B22", titleColor: "#E6EDF3", bodyColor: "#8B949E", titleFont: "Consolas",         bodyFont: "Consolas" },
    "swiss-modern":      { darkMode: false, primaryColor: "#000000", secondaryColor: "#525252", accentColor: "#DC2626", backgroundColor: "#FFFFFF", surfaceColor: "#F4F4F5", titleColor: "#000000", bodyColor: "#262626", titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei" },
    "paper-ink":         { darkMode: false, primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B", backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF", titleColor: "#1C1917", bodyColor: "#292524", titleFont: "宋体",            bodyFont: "宋体" }
  };

  function openStylePresetModal() {
    const sp = currentSettings.stylePreset || {};
    els.styleEnabled.checked = !!sp.enabled;
    els.styleTitleFont.value = sp.titleFont || "Microsoft YaHei";
    els.styleTitleSize.value = sp.titleSize || 32;
    els.styleTitleBold.checked = sp.titleBold !== false;
    els.styleTitleColor.value = sp.titleColor || "#1f2329";
    els.styleBodyFont.value = sp.bodyFont || "Microsoft YaHei";
    els.styleBodySize.value = sp.bodySize || 18;
    els.styleBodyColor.value = sp.bodyColor || "#33363c";
    // 兼容老版本保存的 scheme 名（navy/techDark/minimal/warmth），不再支持时回退 custom
    const validSchemes = new Set(Object.keys(COLOR_SCHEMES).concat(["custom"]));
    els.styleScheme.value = validSchemes.has(sp.scheme) ? sp.scheme : "custom";
    els.stylePrimaryColor.value = sp.primaryColor || "#1f3a5f";
    els.styleSecondaryColor.value = sp.secondaryColor || "#3d5a80";
    els.styleAccentColor.value = sp.accentColor || "#ee6c4d";
    els.styleBackgroundColor.value = sp.backgroundColor || "#ffffff";
    els.styleSurfaceColor.value = sp.surfaceColor || "#f5f7fa";
    els.styleThemeFile.value = sp.themeFile || "";
    els.stylePresetModal.classList.remove("hidden");
  }

  function applyColorScheme(name) {
    const scheme = COLOR_SCHEMES[name];
    if (!scheme) return;
    els.stylePrimaryColor.value = scheme.primaryColor;
    els.styleSecondaryColor.value = scheme.secondaryColor;
    els.styleAccentColor.value = scheme.accentColor;
    els.styleBackgroundColor.value = scheme.backgroundColor;
    els.styleSurfaceColor.value = scheme.surfaceColor;
    els.styleTitleColor.value = scheme.titleColor;
    els.styleBodyColor.value = scheme.bodyColor;
    if (scheme.titleFont) els.styleTitleFont.value = scheme.titleFont;
    if (scheme.bodyFont) els.styleBodyFont.value = scheme.bodyFont;
  }

  // 任何颜色字段被手动改动后，scheme 自动切回 custom（避免误以为还是预设）
  function markCustomScheme() {
    els.styleScheme.value = "custom";
  }

  function closeStylePresetModal() {
    els.stylePresetModal.classList.add("hidden");
  }

  function saveStylePreset() {
    currentSettings.stylePreset = {
      enabled: els.styleEnabled.checked,
      titleFont: els.styleTitleFont.value.trim() || "Microsoft YaHei",
      titleSize: parseInt(els.styleTitleSize.value, 10) || 32,
      titleBold: els.styleTitleBold.checked,
      titleColor: els.styleTitleColor.value || "#1f2329",
      bodyFont: els.styleBodyFont.value.trim() || "Microsoft YaHei",
      bodySize: parseInt(els.styleBodySize.value, 10) || 18,
      bodyColor: els.styleBodyColor.value || "#33363c",
      scheme: els.styleScheme.value || "custom",
      primaryColor: els.stylePrimaryColor.value || "#1f3a5f",
      secondaryColor: els.styleSecondaryColor.value || "#3d5a80",
      accentColor: els.styleAccentColor.value || "#ee6c4d",
      backgroundColor: els.styleBackgroundColor.value || "#ffffff",
      surfaceColor: els.styleSurfaceColor.value || "#f5f7fa",
      themeFile: els.styleThemeFile.value.trim()
    };
    persistSettings();
    closeStylePresetModal();
    showMessage("PPT 风格预设已保存。下次 AI 生成幻灯片会按此色板和样式。", "success");
  }

  function openOutlineModal() {
    if (!els.outlineText.value) {
      els.outlineText.value = "";
    }
    els.outlineModal.classList.remove("hidden");
    setTimeout(() => els.outlineText.focus(), 50);
  }

  function closeOutlineModal() {
    els.outlineModal.classList.add("hidden");
  }

  function generateFromOutline() {
    const outline = els.outlineText.value.trim();
    if (!outline) {
      showMessage("请先输入大纲。", "error");
      return;
    }

    const imageGenOn = !!currentSettings?.imageProvider?.enabled;

    const prompt = [
      "【任务】根据下面的大纲，生成一份**正式商用风格**的 PPT。要求高级感版式，使用色板和形状装饰，不是单调的「标题+正文」模板感。",
      "",
      "【大纲】",
      outline,
      "",
      "【关键规则——这些步骤一个都不能漏】",
      "STEP 1. 取参数：调 wpp_get_presentation_info 拿到 slideWidth、slideHeight。",
      "STEP 1b. **必须先调 wpp_get_style_preset 拿到色板**（primaryColor / secondaryColor / accentColor / backgroundColor / surfaceColor），后面所有页都按这套颜色走，绝对不要自己临时编颜色。",
      "",
      "**生成幻灯片的优先策略：用模板，少手工拼**。两套模板可选：",
      "",
      "**方案 A——wpp_apply_template**：纯 PPT 形状拼，文字全可编辑，视觉中等。适合大多数页：",
      "  - 封面 → wpp_apply_template(templateName='cover-split' 或 'cover-band', title=主标题, subtitle=副标题/日期)",
      "  - 章节分隔 → wpp_apply_template(templateName='section-fullbleed', title=H1 标题, chapter='第 X 章')",
      "  - 内容页 → wpp_apply_template(templateName='content-sidebar', title=H2, body=要点用 \\n 分隔)",
      "  - 数据强调 → wpp_apply_template(templateName='stat-hero', number='98%', label=标签, description=描述)",
      "  - 引言 → wpp_apply_template(templateName='quote-block', quote=引文, author=作者)",
      "  - 对比 → wpp_apply_template(templateName='two-column', leftTitle, leftBody, rightTitle, rightBody)",
      "  - 结尾 → wpp_apply_template(templateName='closing-thanks')",
      "",
      "**方案 B——wpp_apply_visual_template**：背景是渲染好的 SVG 图（含渐变/光斑/巨型水印），文字仍是真文本框可编辑。**视觉权重高的页用这个**：",
      "  - 封面（强烈推荐用 B）→ wpp_apply_visual_template(templateName='v-cover-gradient', title, subtitle?)",
      "  - 章节分隔（强烈推荐用 B）→ wpp_apply_visual_template(templateName='v-section-modern', title, chapter='01')",
      "  - 大数字数据页（强烈推荐用 B）→ wpp_apply_visual_template(templateName='v-stat-bigtype', number, label, description?)",
      "  - 现代风格内容页（可选 B）→ wpp_apply_visual_template(templateName='v-content-modern', title, body)",
      "",
      "**选择策略**：封面 / 章节分隔 / 数据强调三类用方案 B（视觉决定第一印象）；普通内容页用方案 A 即可（避免每页都铺图浪费）。",
      "**模板省略 slide 参数会自动追加一张新幻灯片**，一次调用就完成版式+文字。",
      "STEP 2. 封面页：**优先用方案 B** —— wpp_apply_visual_template(templateName='v-cover-gradient', title=主标题, subtitle=副标题或日期)。视觉上比方案 A 更精致。",
      "STEP 3. 目录页：把大纲所有 H1 加序号拼成多行字符串（如 \"1. 项目背景\\n2. 解决方案\\n...\"），调 wpp_apply_template(templateName='content-sidebar', title='目录', body=该字符串)。",
      "STEP 4. 正文页（按大纲遍历），**全部用模板**：",
      "   - 每个 H1 → **方案 B** wpp_apply_visual_template(templateName='v-section-modern', title=H1 标题, chapter='01' 之类两位数字)",
      "   - 该 H1 下每组二级要点 → 方案 A wpp_apply_template(templateName='content-sidebar', title=H2, body=多行要点)",
      "   - 大纲里出现「数字 + 单位」（如 \"用户增长 98%\"）→ **方案 B** wpp_apply_visual_template(templateName='v-stat-bigtype', number='98%', label='用户增长', description='与去年同期相比')",
      "   - 大纲出现「方案 A vs 方案 B」式对比 → 方案 A wpp_apply_template(templateName='two-column', leftTitle=A, leftBody=A 的描述, rightTitle=B, rightBody=B 的描述)",
      "   - 大纲出现明显引用 → 方案 A wpp_apply_template(templateName='quote-block', quote=引文, author=出处)",
      "   - 大纲出现两组及以上数字对比、占比构成、趋势变化、多维度评分 → 该页用 content-sidebar 后**追加** wpp_render_chart 给右半边加图表（chartType 自选 bar/line/donut/radar/gauge/heatmap），左半边正文相应精简",
      "   - 每页正文 ≤ 6 行，超出拆成多页",
      "STEP 5. 结尾页：wpp_apply_template(templateName='closing-thanks')。",
      "STEP 6. **统一字体（不能漏！）**：调一次 wpp_apply_style_preset，**不传任何参数**→对所有幻灯片统一套用字体字号颜色。",
      "STEP 7. **统一动画（不能漏！）**：调一次 wpp_set_slide_transition({ effect: 'fade', speed: 'medium' })，**不传 slide 参数**→对所有页加 fade 切换。",
      "STEP 8. 自检：调 wpp_list_slides 看一遍每页的 textPreview，**确认没有空白页**。如果发现空白或缺失标题的页，立刻 wpp_replace_shape_text / wpp_add_text_box 补救。",
      "",
      "【其他要求】",
      "- 进度汇报：每完成一个 STEP 就简短说一句「STEP X 完成」",
      "- 工具失败：分析返回的 warning 字段或 error，换实现，不重复同一失败调用",
      "- 最后总结：生成了几页、风格是否统一、动画是否加上、有无空白页残留",
      "",
      "现在按 STEP 1 开始。"
    ].join("\n");

    closeOutlineModal();
    activateTab("ai");
    runChatTurn(prompt);
  }

  // ---- 统一 PPT 风格 modal ----

  function openUnifyModal() {
    els.unifyModal.classList.remove("hidden");
    setTimeout(() => els.unifyOutlineText.focus(), 50);
  }

  function closeUnifyModal() {
    els.unifyModal.classList.add("hidden");
  }

  function buildUnifyPrompt(outline, autoImage) {
    const imageGenOn = !!currentSettings?.imageProvider?.enabled;
    const imagesEnabled = autoImage && imageGenOn;
    return [
      "【任务】对**当前已存在的** PPT 进行统一化和高级化处理：套用色板、加装饰、统一字体、按内容判断配图、加切换动画、检查空白页。",
      "",
      "【参考大纲】（用来辅助你理解每页的主题）",
      outline || "（用户未提供，请直接基于幻灯片现有文字判断每页主题）",
      "",
      "【流程：必须按顺序执行】",
      "STEP 1. 调 wpp_get_presentation_info 拿 slideWidth、slideHeight、slideCount。",
      "STEP 1b. **必须调 wpp_get_style_preset 拿色板**（primaryColor / accentColor / backgroundColor / surfaceColor），后面所有装饰都用这套颜色。",
      "STEP 2. 调 wpp_list_slides 拿到每页的 index / title / textPreview / shapeCount / layout / placeholderRole。",
      "STEP 3. 调 wpp_apply_style_preset（不传参数）→ 对所有页统一字体字号颜色。",
      "STEP 3b. **加装饰元素提升高级感**（先看 shapeCount，> 5 的页已装饰过则跳过）：",
      "   - 章节分隔页（layout='sectionHeader' 或 占位符只有标题）：直接 wpp_set_slide_background(slide=N, color=primaryColor)，并把标题文字改成白色大字号",
      "   - 内容页：wpp_add_shape(slide=N, shape='rectangle', left=0, top=0, width=8, height=slideHeight, fillColor=primaryColor) 左侧主色装饰条；标题下方再来一条 wpp_add_shape(rectangle, left=50, top=88, width=60, height=3, fillColor=accentColor)",
      "   - 数据/统计页（textPreview 含百分比或大数字）：可以 wpp_add_shape 加圆形或矩形包裹数字让它更突出",
      "   - 注意：本工具不删除既有形状；只在已有版式上叠加装饰，避免改坏用户原排版",
      "",
      "STEP 3c. **数据可视化图表（重要）**：逐页判断「这页适不适合用图表替代纯文字」。",
      "   - **强烈建议加图表**的情形：textPreview 出现两个或以上数字（销售额对比、季度趋势、市场份额、转化率/完成率等）；列举多组比较数据；对比两个方案的多维度评分；占比构成（30% / 50% / 20%）；时间序列（2021、2022、2023…）。",
      "   - **不要加图表**的情形：纯叙事段落、引言/愿景类、封面 / 目录 / 章节分隔页 / 结尾页、本页已有图表（shape Name 含 chart 或 lingxi-chart）。",
      "   - **图表类型选择**：",
      "     · 几组数据对比（不同公司/产品/时段的同一指标）→ chartType='bar'",
      "     · 时间序列趋势、增长曲线 → chartType='line'",
      "     · 占比构成（部分 vs 整体，加起来=100%）→ chartType='donut'",
      "     · 多维度评分对比（产品/方案的几个维度）→ chartType='radar'",
      "     · 单个完成率 / 达成率 / 健康度 → chartType='gauge'",
      "     · 二维矩阵（行×列 的强度，比如月份×渠道的表现）→ chartType='heatmap'",
      "   - **数据提取**：直接从 textPreview 解析。如果数字不全或含糊，可以**编合理的示意数据**（标注「示意」），别为了硬塞图表瞎编关键业务数字。",
      "   - **调用方式**：先 wpp_render_chart(slide=N, chartType=类型, data=结构化数据, title=简短中文标题)，**靠右半边**（默认就是右侧，不用传 left/top）。然后**适当缩短原文字内容**（如果原本是大段数字罗列，让左半边只留要点），用 wpp_replace_shape_text 改正文。",
      "   - **节制原则**：整个 PPT 加图表的页数 ≤ slideCount * 0.4，避免堆图反而花哨。优先选数据最强、最有「展示价值」的几页。",
      "   - **darkMode**：图表会自动跟随当前色板，不用关心。",
      "",
      imagesEnabled ? [
        "STEP 4. **逐页判断是否需要配图**：",
        "   - **需要配图**的情形（典型）：内容偏抽象（说概念/价值/愿景）、整页全是文字大段落、列举的产品/方案、流程描述。",
        "   - **不需要配图**的情形：封面（已有背景）、目录页、章节分隔页（sectionHeader / titleOnly / title）、Q&A/结尾页、文字已经少且页面有图。",
        "   - 判断方式：结合大纲对应行 + textPreview + layout 综合看。",
        "   - 对每个**需要配图**的页面：",
        "     a. 用一句话英文 prompt 描述与该页主题相关的商业风格图片（抽象/几何/渐变/科技感，避免人脸/Logo/文字）",
        "     b. 调 generate_image(prompt=英文prompt, size='4:3' 或 '16:9' 与页面比例匹配, resolution='2K')",
        "     c. 调 wpp_add_picture(slide=该页号, fileName=URL, left=Math.floor(slideWidth*0.55), top=Math.floor(slideHeight*0.18), width=Math.floor(slideWidth*0.4), height=Math.floor(slideHeight*0.6)) — 把图放在右半边，留出左半边给文字",
        "     d. 每页插图前先报一句「为第 X 页生成配图」",
        "   - 注意：**最多给 60% 的内容页配图**，过度堆图反而花哨。"
      ].join("\n") : "STEP 4. 跳过配图（用户未勾选自动配图，或图像生成未启用）。",
      "",
      "STEP 5. 调 wpp_set_slide_transition({ effect: 'fade', speed: 'medium' })（不传 slide → 全部页加 fade 切换）。",
      "STEP 6. 自检：再调一次 wpp_list_slides，看是否有空白页或缺标题的页。如有，用 wpp_add_text_box / wpp_replace_shape_text 补一下。",
      "",
      "【其他要求】",
      "- 进度汇报：每完成一个 STEP 短报一次，配图过程报每页处理进度",
      "- 不要新建幻灯片（除非自检发现某页确实需要补救）",
      "- 完成后总结：处理了几页 / 加了几张图 / 哪几页改动 / 是否成功统一",
      "",
      "现在按 STEP 1 开始。"
    ].join("\n");
  }

  function executeUnify() {
    const outline = els.unifyOutlineText.value.trim();
    const autoImage = !!els.unifyAutoImage.checked;
    const prompt = buildUnifyPrompt(outline, autoImage);
    closeUnifyModal();
    activateTab("ai");
    runChatTurn(prompt);
  }

  async function extractOutlineToTextarea(targetEl) {
    try {
      const app = await global.WpsAiAddon?.getApplication?.();
      const pres = app?.ActivePresentation;
      if (!pres) throw new Error("未检测到打开的演示文稿。");
      const count = pres.Slides?.Count || 0;
      if (count === 0) throw new Error("当前演示文稿没有幻灯片。");
      const lines = [];
      for (let i = 1; i <= count; i += 1) {
        const slide = pres.Slides.Item(i);
        let title = "";
        const shapes = slide.Shapes;
        const cnt = shapes?.Count || 0;
        for (let j = 1; j <= cnt; j += 1) {
          const sh = shapes.Item(j);
          try {
            if (sh.PlaceholderFormat) {
              const t = sh.PlaceholderFormat.Type;
              if (t === 13 || t === 15 || t === 16) {
                title = String(sh.TextFrame?.TextRange?.Text || "").trim();
                if (title) break;
              }
            }
          } catch (e) {}
        }
        lines.push(`# ${title || "幻灯片 " + i}`);
      }
      targetEl.value = lines.join("\n");
      showMessage(`已从当前 PPT 提取 ${count} 个标题。`, "success");
    } catch (error) {
      showMessage(`提取失败：${error.message || error}`, "error");
    }
  }

  const extractOutlineFromActivePpt = () => extractOutlineToTextarea(els.outlineText);
  const extractOutlineForUnify = () => extractOutlineToTextarea(els.unifyOutlineText);

  // ---------------- 改动记录 (History Tab) ----------------

  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderSnapshotHtml(snap) {
    if (!snap) return `<pre class="muted">无快照</pre>`;
    if (snap._truncated) return `<pre>${escapeHtml(snap._excerpt || "")}\n\n[已截断，原始 ${snap._originalBytes} 字节]</pre>`;
    try {
      return `<pre>${escapeHtml(JSON.stringify(snap, null, 2))}</pre>`;
    } catch (e) { return `<pre class="muted">快照不可序列化</pre>`; }
  }

  function renderHistoryEntry(entry) {
    const div = document.createElement("div");
    div.className = "history-entry" + (entry.ok ? "" : " is-error");
    div.dataset.entryId = entry.id;
    const statusCls = entry.ok ? "ok" : "err";
    const statusTxt = entry.ok ? "✓" : "!";
    const targetLine = entry.target ? `${entry.target.kind} · ${entry.target.label}` : "—";

    div.innerHTML = `
      <div class="history-entry-head">
        <span class="history-status ${statusCls}" title="${entry.ok ? "成功" : "失败"}">${statusTxt}</span>
        <span class="history-entry-name">${escapeHtml(entry.friendlyName || entry.toolName)}</span>
        <span class="history-entry-time">${fmtTime(entry.ts)}</span>
      </div>
      <div class="history-entry-target">📍 ${escapeHtml(targetLine)}</div>
      <div class="history-entry-summary">${escapeHtml(entry.resultSummary || "")}</div>
    `;

    div.addEventListener("click", (ev) => {
      // 已经展开就收起
      const open = div.querySelector(".history-entry-detail");
      if (open) { open.remove(); return; }
      const detail = document.createElement("div");
      detail.className = "history-entry-detail";
      const hasSnapshots = entry.before || entry.after;
      detail.innerHTML = `
        <div class="detail-section">
          <span class="detail-label">工具 / 入参</span>
          <pre>${escapeHtml(entry.toolName)}\n${escapeHtml(JSON.stringify(entry.params || {}, null, 2))}</pre>
        </div>
        ${hasSnapshots ? `
          <div class="history-diff">
            <div class="history-diff-col">
              <span class="detail-label before">改动前</span>
              ${renderSnapshotHtml(entry.before)}
            </div>
            <div class="history-diff-col">
              <span class="detail-label after">改动后</span>
              ${renderSnapshotHtml(entry.after)}
            </div>
          </div>
        ` : ""}
        ${entry.error ? `
          <div class="detail-section">
            <span class="detail-label">错误</span>
            <pre>${escapeHtml(entry.error)}</pre>
          </div>
        ` : ""}
      `;
      div.appendChild(detail);
    });

    return div;
  }

  function renderTurnGroup(turn, entries) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-turn";

    const head = document.createElement("div");
    head.className = "history-turn-head";
    const promptText = turn?.prompt ? escapeHtml(turn.prompt) : "（无提示）";
    const startedAt = turn?.startedAt ? fmtTime(turn.startedAt) : "";
    const backupOk = turn?.backup && turn.backup.backupPath;
    const backupErr = turn?.backup && turn.backup.error;
    const backupStatus = backupOk
      ? `<span class="history-turn-backup ok" title="${escapeHtml(turn.backup.backupPath)}">📦 已备份 (${formatSize(turn.backup.size)})</span>`
      : backupErr
        ? `<span class="history-turn-backup err" title="${escapeHtml(backupErr)}">⚠ 未备份</span>`
        : `<span class="history-turn-backup muted">未备份</span>`;
    head.innerHTML = `
      <div class="history-turn-meta">
        <span class="history-turn-icon">💬</span>
        <span class="history-turn-prompt">${promptText}</span>
        <span class="history-turn-time">${startedAt}</span>
      </div>
      <div class="history-turn-actions">
        ${backupStatus}
        ${backupOk ? `<button type="button" class="ghost-btn history-restore-btn">↶ 恢复本轮</button>` : ""}
      </div>
    `;
    wrapper.appendChild(head);

    if (backupOk) {
      head.querySelector(".history-restore-btn").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm(`确认恢复到本轮对话开始前的状态？\n\n这会丢弃 AI 本轮做的所有改动以及之后所有未保存的内容。`)) return;
        const btn = ev.target;
        btn.disabled = true; btn.textContent = "恢复中...";
        try {
          const backup = global.WpsAiBackup;
          if (!backup) throw new Error("WpsAiBackup 未加载");
          const res = await backup.restoreFromBackup(turn.backup.backupPath, turn.backup.docPath);
          if (res?.ok) {
            showMessage(`已恢复到 ${fmtTime(turn.backup.ts)} 的状态。${res.warning || ""}`, "success");
            // 把本轮所有 entry 标记为已撤回
            global.WpsAiHistory?.deleteTurn?.(turn.id);
          } else {
            showMessage(`恢复失败：${res?.error || "未知错误"}`, "error");
            btn.disabled = false; btn.textContent = "↶ 恢复本轮";
          }
        } catch (e) {
          showMessage(`恢复失败：${e?.message || e}`, "error");
          btn.disabled = false; btn.textContent = "↶ 恢复本轮";
        }
      });
    }

    // turn 下的所有 entry（按时间正序展示，方便阅读 AI 一步一步做了啥）
    const sorted = entries.slice().sort((a, b) => a.ts - b.ts);
    const list = document.createElement("div");
    list.className = "history-turn-entries";
    sorted.forEach((e) => list.appendChild(renderHistoryEntry(e)));
    wrapper.appendChild(list);

    return wrapper;
  }

  function formatSize(bytes) {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderHistory() {
    const history = global.WpsAiHistory;
    if (!history || !els.historyList) return;
    const entries = history.listEntries();        // 已按时间倒序
    const turns = history.listTurns?.() || {};
    const n = entries.length;

    if (els.historyCount) els.historyCount.textContent = `共 ${n} 条`;
    if (els.historyBadge) {
      els.historyBadge.textContent = n > 99 ? "99+" : String(n);
      els.historyBadge.classList.toggle("hidden", n === 0);
    }
    if (els.historyEmpty) els.historyEmpty.classList.toggle("hidden", n > 0);

    els.historyList.innerHTML = "";

    // 按 turnId 分组：无 turnId 的归为 "_loose"
    const groups = new Map();
    entries.forEach((e) => {
      const key = e.turnId || "_loose";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });

    // 排序：turn 按其 startedAt 倒序；loose 放最后
    const turnIds = Array.from(groups.keys()).sort((a, b) => {
      if (a === "_loose") return 1;
      if (b === "_loose") return -1;
      const ta = turns[a]?.startedAt || 0;
      const tb = turns[b]?.startedAt || 0;
      return tb - ta;
    });

    turnIds.forEach((tid) => {
      const turn = tid === "_loose" ? { id: "_loose", prompt: "未归属对话的改动", backup: null } : turns[tid];
      els.historyList.appendChild(renderTurnGroup(turn || { id: tid, prompt: "" }, groups.get(tid)));
    });
  }

  function bindHistory() {
    const history = global.WpsAiHistory;
    if (!history) return;
    history.subscribe(renderHistory);
    if (els.historyClearBtn) {
      els.historyClearBtn.addEventListener("click", () => {
        if (history.size() === 0) return;
        if (!confirm(`清空全部 ${history.size()} 条改动记录？`)) return;
        history.clear();
      });
    }
    renderHistory();
  }

  // ---------------- 纯净模式（隐藏工具调用 / reasoning，只看 AI 对话）----------------

  const PURE_MODE_KEY = "lingxi_pure_mode";

  function applyPureMode(on) {
    document.body.classList.toggle("pure-mode", !!on);
    if (els.pureModeToggle) {
      els.pureModeToggle.classList.toggle("active", !!on);
      const icon = els.pureModeToggle.querySelector(".pure-icon");
      if (icon) icon.textContent = on ? "👁‍🗨" : "👁";
      els.pureModeToggle.title = on
        ? "当前为纯净模式：已隐藏工具调用与推理过程。点击切回完整视图。"
        : "纯净模式：隐藏工具调用与推理过程";
    }
  }

  function bindPureMode() {
    if (!els.pureModeToggle) return;
    let on = false;
    try { on = localStorage.getItem(PURE_MODE_KEY) === "1"; } catch (e) {}
    applyPureMode(on);

    els.pureModeToggle.addEventListener("click", () => {
      const next = !document.body.classList.contains("pure-mode");
      applyPureMode(next);
      try { localStorage.setItem(PURE_MODE_KEY, next ? "1" : "0"); } catch (e) {}
    });
  }

  // ---------------- 多对话管理 ----------------

  // 渲染单条历史消息为简洁文本气泡（不还原工具调用）—— 退路用，没有事件流时使用
  function appendSimpleMessage(role, content) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    appendChatMsg(role, text, { label: role === "user" ? "我" : "AI" });
  }

  // 单条事件 → chat 气泡（复用 live 渲染函数，确保和当时看到的视觉一致）
  function appendHistoryEvent(ev) {
    if (!ev) return;
    switch (ev.type) {
      case "user":
        appendChatMsg("user", ev.text || "", { label: "我" });
        break;
      case "reasoning": {
        // 推理用一个折叠的灰色气泡，标记"推理回放"
        const wrap = document.createElement("div");
        wrap.className = "chat-msg reasoning collapsible";
        wrap.innerHTML = `
          <div class="chat-msg-header">
            <span class="chat-msg-label">🤔 推理</span>
          </div>
          <div class="reasoning-body">${(global.WpsAiMarkdown?.escapeHtml?.(ev.text) || "").replace(/\n/g, "<br/>")}</div>
        `;
        els.chatStream.appendChild(wrap);
        break;
      }
      case "tool_call":
        appendToolCallMsg(ev.name, ev.args);
        break;
      case "tool_result":
        appendToolResultMsg(ev.name, ev.result || { ok: false, error: "结果丢失" });
        break;
      case "assistant":
        renderAssistantText(ev.text || "");
        break;
    }
  }

  function rebuildChatStreamFromHistory() {
    if (!els.chatStream) return;
    els.chatStream.innerHTML = "";
    if (els.chatPending) els.chatPending.classList.add("hidden");
    hideSuggestedActions?.();

    // 优先用事件流重放（完整应答过程）；没有则退到只用 messages
    const conv = global.WpsAiConversations?.getCurrent?.();
    const events = conv?.events;
    if (Array.isArray(events) && events.length > 0) {
      events.forEach(appendHistoryEvent);
    } else {
      chatHistory.forEach((m) => appendSimpleMessage(m.role, m.content));
    }
  }

  function startNewConversation({ silent } = {}) {
    // 当前对话已经自动 sync 过了；这里只需要清状态 + 开新的
    chatHistory.length = 0;
    if (els.chatStream) els.chatStream.innerHTML = "";
    if (els.chatPending) els.chatPending.classList.add("hidden");
    hideSuggestedActions?.();
    try { global.WpsAiConversations?.createNew?.(); } catch (e) {}
    if (!silent) showMessage("已开始新对话。", "info");
  }

  function switchToConversation(id) {
    const conv = global.WpsAiConversations?.listConversations?.().find((c) => c.id === id);
    if (!conv) return;
    // 把当前的先保存（即使没改也无所谓，syncMessages 会更新 updatedAt）
    try { global.WpsAiConversations.syncMessages(chatHistory); } catch (e) {}
    // 切换并加载（loadAsActive 现在返回 { messages, events }）
    const loaded = global.WpsAiConversations.loadAsActive(id);
    if (!loaded) return;
    const messages = loaded.messages || (Array.isArray(loaded) ? loaded : []);
    chatHistory.length = 0;
    messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
    rebuildChatStreamFromHistory();
    closeConversationsMenu();
    showMessage(`已切换到对话「${conv.title}」`, "info");
  }

  function deleteConversation(id) {
    const conv = global.WpsAiConversations?.listConversations?.().find((c) => c.id === id);
    if (!conv) return;
    if (!confirm(`确认删除对话「${conv.title}」？此操作不可撤销。`)) return;
    const isCurrent = global.WpsAiConversations.getCurrentId?.() === id;
    global.WpsAiConversations.deleteById(id);
    if (isCurrent) {
      // 当前被删了：清屏开新对话
      chatHistory.length = 0;
      if (els.chatStream) els.chatStream.innerHTML = "";
    }
    // 不主动关闭菜单，方便连续删
  }

  function escapeHtmlSafe(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderConversationsMenu() {
    if (!els.conversationsMenuList) return;
    const list = global.WpsAiConversations?.listConversations?.() || [];
    const currentId = global.WpsAiConversations?.getCurrentId?.();
    els.conversationsMenuList.innerHTML = "";
    if (list.length === 0) {
      if (els.conversationsMenuEmpty) els.conversationsMenuEmpty.classList.remove("hidden");
      return;
    }
    if (els.conversationsMenuEmpty) els.conversationsMenuEmpty.classList.add("hidden");

    list.forEach((c) => {
      const item = document.createElement("div");
      item.className = "conversation-item" + (c.id === currentId ? " active" : "");
      item.dataset.id = c.id;
      const count = (c.messages || []).filter((m) => m.role === "user").length;
      const time = c.updatedAt ? fmtTime(c.updatedAt) : "";
      item.innerHTML = `
        <div class="conversation-item-main">
          <div class="conversation-item-title">${escapeHtmlSafe(c.title || "新对话")}</div>
          <div class="conversation-item-meta">${count} 轮 · ${escapeHtmlSafe(time)}</div>
        </div>
        <button type="button" class="conversation-item-delete icon-btn" title="删除此对话">×</button>
      `;
      item.querySelector(".conversation-item-main").addEventListener("click", () => switchToConversation(c.id));
      item.querySelector(".conversation-item-delete").addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteConversation(c.id);
      });
      els.conversationsMenuList.appendChild(item);
    });
  }

  function openConversationsMenu() {
    renderConversationsMenu();
    els.conversationsMenu?.classList.remove("hidden");
    document.addEventListener("click", closeConversationsMenuOutside, { capture: true });
  }

  function closeConversationsMenu() {
    els.conversationsMenu?.classList.add("hidden");
    document.removeEventListener("click", closeConversationsMenuOutside, { capture: true });
  }

  function closeConversationsMenuOutside(ev) {
    if (!els.conversationsMenu || els.conversationsMenu.classList.contains("hidden")) return;
    const wrap = els.conversationsMenuBtn?.closest(".conversation-menu-wrap");
    if (wrap && wrap.contains(ev.target)) return;
    closeConversationsMenu();
  }

  function bindConversations() {
    if (els.newConversationBtn) {
      els.newConversationBtn.addEventListener("click", () => startNewConversation());
    }
    if (els.conversationsMenuBtn) {
      els.conversationsMenuBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (els.conversationsMenu?.classList.contains("hidden")) openConversationsMenu();
        else closeConversationsMenu();
      });
    }
    if (els.conversationsMenuClose) {
      els.conversationsMenuClose.addEventListener("click", closeConversationsMenu);
    }
    // 订阅 conversations 变化以刷新菜单
    global.WpsAiConversations?.subscribe?.(() => {
      if (els.conversationsMenu && !els.conversationsMenu.classList.contains("hidden")) {
        renderConversationsMenu();
      }
    });

    // 首次进入：如果有上次 current，把它的 messages 灌进 chatHistory
    try {
      const current = global.WpsAiConversations?.getCurrent?.();
      if (current && current.messages && current.messages.length > 0) {
        current.messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
        rebuildChatStreamFromHistory();
      }
    } catch (e) {}
  }

  // ---------------- Bindings ----------------

  function bindEvents() {
    els.providerSelect.addEventListener("change", refreshProviderConfigVisibility);
    els.operationModeSelect.addEventListener("change", () => renderProviderState());

    els.signInBtn.addEventListener("click", async () => {
      setBusy(true);
      try {
        const url = await global.WpsAiAuth.startLogin();
        showMessage(`已尝试打开授权页。若未弹出，请复制以下链接到浏览器：${url}`, "info");
      } catch (error) {
        showMessage(error.message || String(error), "error");
      } finally { setBusy(false); }
    });

    els.exchangeCodeBtn.addEventListener("click", async () => {
      setBusy(true);
      try {
        await global.WpsAiAuth.exchangeCode(els.authCodeInput.value);
        els.authCodeInput.value = "";
        refreshCodexAuthArea();
        renderProviderState();
        showMessage("登录成功。", "success");
      } catch (error) {
        showMessage(error.message || String(error), "error");
      } finally { setBusy(false); }
    });

    els.signOutBtn.addEventListener("click", () => {
      global.WpsAiAuth.clearAuth();
      refreshCodexAuthArea();
      renderProviderState();
      showMessage("已退出登录。", "info");
    });

    els.saveSettingsBtn.addEventListener("click", saveSettings);
    els.testChatConnBtn.addEventListener("click", testChatConnection);
    els.testImageConnBtn.addEventListener("click", testImageConnection);
    els.refreshModelsBtn.addEventListener("click", refreshModels);

    els.exportSettingsBtn.addEventListener("click", exportSettings);
    els.importSettingsBtn.addEventListener("click", () => els.importSettingsFile.click());
    els.importSettingsFile.addEventListener("change", (ev) => {
      const file = ev.target.files?.[0];
      if (file) importSettings(file);
      ev.target.value = ""; // 允许同名文件重选
    });

    els.settingsToggleBtn.addEventListener("click", () => activateTab("settings"));

    els.chatSendBtn.addEventListener("click", async () => {
      const text = els.chatInput.value.trim();
      if (!text) return;
      els.chatInput.value = "";
      await runChatTurn(text);
    });
    els.chatStopBtn.addEventListener("click", stopChat);
    els.chatInput.addEventListener("keydown", (ev) => {
      // Enter 发送，Shift+Enter 换行；Cmd/Ctrl+Enter 也兼容老快捷键。
      // 中文输入法候选拼字时按 Enter 选词，不要触发发送：isComposing / keyCode 229 都识别一下。
      if (ev.key !== "Enter") return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.shiftKey) return; // Shift+Enter 留给原生换行
      ev.preventDefault();
      els.chatSendBtn.click();
    });
    els.chatClearBtn.addEventListener("click", () => {
      // 「清空」= 把当前对话先收尾存档，再开新对话；不会真删历史
      try { global.WpsAiConversations?.syncMessages?.(chatHistory); } catch (e) {}
      startNewConversation({ silent: true });
    });

    els.suggestedActionsClear.addEventListener("click", hideSuggestedActions);

    // 风格 modal
    els.stylePresetCloseBtn.addEventListener("click", closeStylePresetModal);
    els.styleCancelBtn.addEventListener("click", closeStylePresetModal);
    els.styleSaveBtn.addEventListener("click", saveStylePreset);
    // 选了内置色板 → 自动填颜色
    els.styleScheme.addEventListener("change", () => {
      const v = els.styleScheme.value;
      if (v && v !== "custom") applyColorScheme(v);
    });
    // 手动改任意颜色 → 切回 custom（避免给人"还是某预设"的误导）
    [
      "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor",
      "styleBackgroundColor", "styleSurfaceColor",
      "styleTitleColor", "styleBodyColor"
    ].forEach((id) => {
      els[id]?.addEventListener("input", markCustomScheme);
    });

    // 大纲 modal
    els.outlineCloseBtn.addEventListener("click", closeOutlineModal);
    els.outlineCancelBtn.addEventListener("click", closeOutlineModal);
    els.outlineGenerateBtn.addEventListener("click", generateFromOutline);
    els.outlineExtractBtn.addEventListener("click", extractOutlineFromActivePpt);
    els.outlineClearBtn.addEventListener("click", () => { els.outlineText.value = ""; });

    // 统一风格 modal
    els.unifyCloseBtn.addEventListener("click", closeUnifyModal);
    els.unifyCancelBtn.addEventListener("click", closeUnifyModal);
    els.unifyExecuteBtn.addEventListener("click", executeUnify);
    els.unifyExtractBtn.addEventListener("click", extractOutlineForUnify);
    els.unifyClearBtn.addEventListener("click", () => { els.unifyOutlineText.value = ""; });

    // 点击 modal 遮罩层（card 之外）也关闭
    [els.stylePresetModal, els.outlineModal, els.unifyModal].forEach((m) => {
      if (!m) return;
      m.addEventListener("click", (ev) => {
        if (ev.target === m) m.classList.add("hidden");
      });
    });
  }

  // ---------------- Init ----------------

  // Mac WPS 的 TaskPane WebView 在宿主重设 pane 宽度后，window.innerWidth 不一定及时
  // 跟进，导致 body width:100% 只填到初始宽度，pane 右侧露白。这里直接读 innerWidth +
  // 强制 body/html 跟随；前 5 秒每 500ms 兜一次（应对 delayed-200ms 那批后续 resize）。
  function syncPaneWidth(reason) {
    const w = window.innerWidth;
    const cw = document.documentElement.clientWidth;
    const bw = document.body ? document.body.offsetWidth : 0;
    document.documentElement.style.width = w + "px";
    if (document.body) document.body.style.width = w + "px";
    console.log(`[lingxi-ui] syncPaneWidth(${reason}) innerWidth=${w} html=${cw} body=${bw}`);
  }

  function startPaneWidthSync() {
    syncPaneWidth("init");
    window.addEventListener("resize", () => syncPaneWidth("resize"));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      syncPaneWidth(`poll-${ticks}`);
      if (ticks >= 10) clearInterval(timer);
    }, 500);
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("authBadge")) return;

    startPaneWidthSync();

    bindElements();
    bindTabs();
    bindEvents();
    bindHistory();
    bindPureMode();
    bindConversations();

    loadSettings();
    applySettingsToForm();
    showLoadingModels();
    renderProviderState();
    // 启动时立即从当前 provider 拉真实模型列表；不再用 fallback 占位
    refreshModels({ silent: true });

    if (!global.wps?.WpsApplication) {
      global.WpsAiAddon?.getAddonApi?.().catch((error) => {
        showMessage(`插件 SDK 初始化失败：${error.message || String(error)}`, "error");
      });
    }

    detectHost();

    // 监听 ribbon 快捷指令（通过 Application.PluginStorage 投递）
    startPendingActionWatcher();

    // 加载版本号 + 绑定可折叠卡片
    loadVersionInfo();
    bindCollapsibleCards();
  });

  // 拉 package.json 拿到版本号显示在 header 和 about 两处
  async function loadVersionInfo() {
    let v = "—";
    try {
      const resp = await fetch("./package.json", { cache: "no-cache" });
      if (resp.ok) {
        const pkg = await resp.json();
        if (pkg?.version) v = pkg.version;
      }
    } catch (e) { /* 静默 */ }
    if (els.brandVersion) els.brandVersion.textContent = `v${v}`;
    if (els.aboutVersion) els.aboutVersion.textContent = `v${v}`;
  }

  function bindCollapsibleCards() {
    document.querySelectorAll(".collapsible-card .card-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cardId = btn.getAttribute("data-toggle-card");
        const card = cardId ? document.getElementById(cardId) : btn.closest(".collapsible-card");
        if (!card) return;
        card.classList.toggle("expanded");
      });
    });
  }

  // ---- ribbon 快捷指令消费 ----
  // ribbon 上点了快捷指令后，adapter 会写入 PluginStorage["lingxi_ai_pending_action"]，
  // 这边轮询读取并触发对应 chip 的 prompt（自动发送，等同于在面板里点击该 chip）。
  const PENDING_ACTION_KEY = "lingxi_ai_pending_action";
  let lastConsumedActionTs = 0;

  async function getPluginStorage() {
    try {
      const app = await global.WpsAiAddon?.getApplication?.();
      return app?.PluginStorage || null;
    } catch (e) {
      return null;
    }
  }

  async function consumePendingAction() {
    const storage = await getPluginStorage();
    if (!storage?.getItem) return;
    let raw = "";
    try { raw = storage.getItem(PENDING_ACTION_KEY) || ""; } catch (e) { return; }
    if (!raw) return;

    let payload;
    try { payload = JSON.parse(raw); } catch (e) { payload = null; }
    if (!payload || typeof payload !== "object") {
      try { storage.removeItem?.(PENDING_ACTION_KEY); } catch (e) {}
      return;
    }
    if (payload.ts && payload.ts === lastConsumedActionTs) return;
    lastConsumedActionTs = payload.ts || 0;

    // 标记已消费
    try {
      if (storage.removeItem) storage.removeItem(PENDING_ACTION_KEY);
      else storage.setItem(PENDING_ACTION_KEY, "");
    } catch (e) {}

    // 新增 kind=open-modal：ribbon 上点 PPT 风格 / 大纲生成 PPT 等需要弹窗的动作
    if (payload.kind === "open-modal") {
      activateTab("ai");
      if (payload.modal === "stylePreset") openStylePresetModal();
      else if (payload.modal === "outline") openOutlineModal();
      else if (payload.modal === "unify") openUnifyModal();
      return;
    }

    activateTab("ai");

    // ribbon 入口默认自动发送（prefill 类不进 ribbon）；若 payload 带 prefill 也兜底
    if (payload.prefill && payload.prompt) {
      els.chatInput.value = payload.prompt;
      els.chatInput.focus();
      const caret = payload.prompt.indexOf("[");
      const caretEnd = payload.prompt.indexOf("]");
      if (caret >= 0 && caretEnd > caret) {
        els.chatInput.setSelectionRange(caret + 1, caretEnd);
      }
      return;
    }
    if (payload.prompt) {
      runChatTurn(payload.prompt);
    }
  }

  function startPendingActionWatcher() {
    setTimeout(consumePendingAction, 200);
    setInterval(consumePendingAction, 800);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) consumePendingAction();
    });
  }
})(window);
