(function attachApp(global) {
  "use strict";

  const els = {};
  let currentSettings = null;
  let currentHostInfo = null;

  // ?mode=settings：当前页是不是被 Application.ShowDialog 打开的独立设置窗口
  const isSettingsDialog = /[?&]mode=settings(?:&|$)/i.test(window.location.search);
  // ?mode=preview：当前页是不是被 Application.ShowDialog 打开的独立预览窗口
  const isPreviewDialog = /[?&]mode=preview(?:&|$)/i.test(window.location.search);
  // ?mode=stylepreset：当前页是不是被 Application.ShowDialog 打开的独立 PPT 风格设置窗口
  const isStylePresetDialog = /[?&]mode=stylepreset(?:&|$)/i.test(window.location.search);

  // 独立预览窗口与主 TaskPane 之间的 IPC：用 localStorage 传 state + 结果
  const PREVIEW_DIALOG_REQUEST_KEY = "lingxi_html_preview_dialog_request_v1";
  const PREVIEW_DIALOG_RESULT_KEY = "lingxi_html_preview_dialog_result_v1";
  // 非阻塞 ShowDialog 的 WPS 版本下用：dialog 写"待执行任务"到这里 → MAIN 用 storage 事件接住
  const PREVIEW_DIALOG_PENDING_INSERT_KEY = "lingxi_html_preview_pending_insert_v1";

  // ========================================================================
  // 预览渲染诊断日志（默认开启）：每条都有 [lingxi-preview] 前缀 + 上下文标签
  //   - 关闭：在 DevTools 控制台跑 `window.__lingxiPreviewDebug = false`
  //   - 重新打开：`window.__lingxiPreviewDebug = true`
  // 哪里打了日志：
  //   ① WpsAiHtmlPreview.open / tryOpenHtmlPreviewAsDialog（参数 + ShowDialog 前后）
  //   ② 独立 dialog 窗口的 init（读 request → openHtmlPreviewInline）
  //   ③ openHtmlPreviewInline（state 替换 / in-place 合并分支）
  //   ④ renderHtmlPreviewIntoIframe（模板查找、render 结果长度、写入路径、load / 兜底）
  //   ⑤ finishRender（scale 计算、bridge）
  // 排查空白预览：照下面 5 步在 console 里看日志就能定位到哪一环断了
  // ========================================================================
  if (typeof window.__lingxiPreviewDebug === "undefined") window.__lingxiPreviewDebug = true;
  // 日志持久化到 localStorage，让 dialog 窗口关掉后，主 TaskPane 还能拿到日志
  const PREVIEW_LOG_KEY = "lingxi_preview_log_v1";
  const MAX_LOG_ENTRIES = 500;
  function _appendPersistedLog(level, where, tag, args) {
    try {
      const entry = {
        ts: Date.now(),
        level, where, tag,
        msg: args.map((a) => {
          try {
            if (a == null) return String(a);
            if (typeof a === "string") return a;
            if (a instanceof Error) return a.message + (a.stack ? ("\n" + a.stack) : "");
            return JSON.stringify(a);
          } catch (e) { return "[unserializable]"; }
        }).join(" ")
      };
      const raw = localStorage.getItem(PREVIEW_LOG_KEY);
      const list = raw ? (JSON.parse(raw) || []) : [];
      list.push(entry);
      const trimmed = list.slice(-MAX_LOG_ENTRIES);
      localStorage.setItem(PREVIEW_LOG_KEY, JSON.stringify(trimmed));
    } catch (e) { /* 满了就算了 */ }
  }
  function plog(tag, ...args) {
    if (!window.__lingxiPreviewDebug) return;
    const where = isPreviewDialog ? "DIALOG" : (isSettingsDialog ? "SETTINGS" : (isStylePresetDialog ? "STYLEPRESET" : "MAIN"));
    try { console.log(`[lingxi-preview][${where}][${tag}]`, ...args); } catch (e) {}
    _appendPersistedLog("LOG", where, tag, args);
  }
  function pwarn(tag, ...args) {
    const where = isPreviewDialog ? "DIALOG" : (isSettingsDialog ? "SETTINGS" : (isStylePresetDialog ? "STYLEPRESET" : "MAIN"));
    try { console.warn(`[lingxi-preview][${where}][${tag}]`, ...args); } catch (e) {}
    _appendPersistedLog("WARN", where, tag, args);
  }
  // 暴露 plog/pwarn 给其他模块（presentation.js 等）用，方便集中日志
  window.WpsAiLog = { log: plog, warn: pwarn };
  // 脚本版本标记 —— 用户排查"是不是装载到新代码"时直接看这一行
  const SCRIPT_VERSION = "2026-06-21-r1-image-multi-channel";
  try { console.log("[lingxi] app.js loaded version =", SCRIPT_VERSION); } catch (e) {}
  // 一旦 DOMContentLoaded 触发就立刻打 plog（确认日志系统运行 + 新代码已 load）
  document.addEventListener("DOMContentLoaded", () => {
    try { plog("scriptVersion", SCRIPT_VERSION); } catch (e) {}
  }, { once: true });
  // 暴露给用户在 DevTools 控制台手动取：__lingxiDumpLogs() / __lingxiClearLogs() / __lingxiCopyLogs()
  window.__lingxiDumpLogs = function () {
    try {
      const raw = localStorage.getItem(PREVIEW_LOG_KEY);
      const list = raw ? (JSON.parse(raw) || []) : [];
      const text = list.map((e) => {
        const t = new Date(e.ts).toISOString().slice(11, 23);
        return `${t} [${e.level}][${e.where}][${e.tag}] ${e.msg}`;
      }).join("\n");
      console.log(text || "(no logs)");
      return text;
    } catch (e) { console.warn("dump 失败:", e); return ""; }
  };
  window.__lingxiClearLogs = function () {
    try { localStorage.removeItem(PREVIEW_LOG_KEY); console.log("logs cleared"); } catch (e) {}
  };
  window.__lingxiCopyLogs = async function () {
    try {
      const text = window.__lingxiDumpLogs();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        console.log("logs copied to clipboard (" + text.length + " chars)");
      }
      return text;
    } catch (e) { console.warn("copy 失败:", e); }
  };

  function $(id) { return document.getElementById(id); }

  function bindElements() {
    [
      "authBadge",
      "brandVersion", "aboutVersion",
      "updateStatusBadge", "updateAutoCheckInput", "updateLastCheckedAt", "updateLatestVersion",
      "updateChangelog", "updateCheckNowBtn", "updateDownloadBtn",
      "message",
      // 整套 PPT 生成进度条
      "fullDeckProgress", "fullDeckProgressCount", "fullDeckProgressBarFill", "fullDeckProgressLabel",
      "settingsView", "aiView",
      "providerSelect", "operationModeSelect", "maxToolIterationsInput",
      "systemPromptInput", "systemPromptResetBtn", "showToolCallLogsInput", "splitLayersOnInsertInput",
      "signInBtn", "exchangeCodeBtn", "authCodeInput", "signOutBtn", "tokenInfo",
      "codexAuthArea", "codexSignedInArea",
      "openaiBaseUrl", "openaiApiKey", "openaiDefaultModel", "openaiUseProxy",
      "anthropicBaseUrl", "anthropicApiKey", "anthropicDefaultModel", "anthropicVersion", "anthropicUseProxy",
      "imageEnabled", "imageType",
      "imageBaseUrl", "imageApiKey", "imageModel", "imageDefaultSize", "imageDefaultResolution", "imageUseProxy",
      "imageCodexBaseUrl", "imageCodexApiKey", "imageCodexModel", "imageCodexSize", "imageCodexUseProxy",
      "saveSettingsBtn", "testChatConnBtn", "testImageConnBtn",
      "exportSettingsBtn", "importSettingsBtn", "importSettingsFile",
      // 开发者工具（dev mode 才显示）
      "devToolsSection", "devModeBadge", "openJsDebuggerBtn",
      "dumpPreviewLogsBtn", "clearPreviewLogsBtn",
      // PPT 风格 modal
      "stylePresetModal", "stylePresetCloseBtn", "styleSaveBtn",
      "styleEnabled", "styleTitleFont", "styleTitleSize", "styleTitleBold", "styleTitleColor",
      "styleBodyFont", "styleBodySize", "styleBodyColor",
      "styleScheme", "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor", "styleBackgroundColor", "styleSurfaceColor",
      "styleThemeFile",
      // PPT 风格 — 主题预览卡
      "styleSchemePreview", "styleSchemePreviewLabel", "styleSchemePreviewDesc",
      "styleSchemePreviewSwatches", "styleSchemePreviewSignature", "styleSchemePreviewHints",
      // HTML 模板预览 modal
      "htmlPreviewModal", "htmlPreviewTitle", "htmlPreviewCloseBtn", "htmlPreviewInsertBtn",
      "htmlPreviewReplaceBtn", "htmlPreviewReplaceActiveBtn", "htmlPreviewSaveBtn",
      // 组件库相关
      "htmlPreviewSaveAsCompBtn", "htmlPreviewSaveAsCompModal", "htmlPreviewSaveAsCompCloseBtn",
      "htmlPreviewSaveAsCompName", "htmlPreviewSaveAsCompDesc", "htmlPreviewSaveAsCompTip",
      "htmlPreviewSaveAsCompConfirmBtn",
      "htmlPreviewExtractCompsBtn",
      "htmlPreviewExtractReviewModal", "htmlPreviewExtractReviewTitle", "htmlPreviewExtractReviewCloseBtn",
      "htmlPreviewExtractReviewList", "htmlPreviewExtractReviewSummary",
      "htmlPreviewExtractReviewDiscardBtn", "htmlPreviewExtractReviewKeepAllBtn",
      // 编辑模式 / 标尺
      "htmlPreviewEditModeBtn", "htmlPreviewToggleRulerBtn",
      "htmlPreviewEditElModal", "htmlPreviewEditElTag", "htmlPreviewEditElCloseBtn",
      "htmlPreviewEditElText", "htmlPreviewEditElColor", "htmlPreviewEditElSize", "htmlPreviewEditElWeight",
      "htmlPreviewEditElCancelBtn", "htmlPreviewEditElApplyBtn",
      "htmlPreviewPickComponentsBtn", "htmlPreviewPickComponentsCount",
      "htmlPreviewComponentsPicker", "htmlPreviewPickComponentsCloseBtn",
      "htmlPreviewComponentsList", "htmlPreviewPickComponentsClearBtn", "htmlPreviewPickComponentsConfirmBtn",
      // 统一修改 tab
      "htmlPreviewUnifiedLog", "htmlPreviewUnifiedInput", "htmlPreviewUnifiedSendBtn",
      "htmlPreviewFrame", "htmlPreviewInfo", "htmlPreviewRendering",
      "htmlPreviewTemplate", "htmlPreviewLayout", "htmlPreviewFields",
      "htmlPreviewHistoryBtn", "htmlPreviewHistoryPanel", "htmlPreviewHistoryList",
      "htmlPreviewHistoryCloseBtn", "htmlPreviewHistoryClearBtn",
      "htmlTemplateGallery", "htmlTemplateGalleryList",
      "htmlTemplateGalleryFoot", "htmlTemplateGalleryClearBtn",
      "htmlPreviewChatInput", "htmlPreviewChatSendBtn", "htmlPreviewChatLog", "htmlPreviewChatClearBtn",
      "chatHtmlGalleryBtn",
      // 大纲 modal
      "outlineModal", "outlineCloseBtn", "outlineGenerateBtn",
      "outlineText", "outlineExtractBtn", "outlineClearBtn",
      // 统一风格 modal
      "unifyModal", "unifyCloseBtn", "unifyExecuteBtn",
      "unifyOutlineText", "unifyExtractBtn", "unifyClearBtn", "unifyAutoImage",
      "modelSelect", "refreshModelsBtn",
      "modelSelectBtn", "modelSelectLabel", "modelSelectCaps", "modelSelectPopup",
      // 新版设置弹窗
      "settingsModal", "settingsModalCloseBtn", "openSettingsModalBtn",
      "chatProvidersList", "addChatProviderBtn",
      "skillsList", "skillImportBtn", "skillImportFile",
      "mcpServerEnabledInput", "mcpStatusBadge", "mcpToolCount", "mcpLastError",
      "mcpConfigSnippet", "mcpCopyConfigBtn", "mcpToolsList",
      "presetPickerModal", "presetPickerList",
      // TaskPane 停靠/浮动切换
      "dockToggleBtn", "dockToggleIcon", "dockToggleLabel",
      "aiPanelTitle", "aiPanelHint",
      "suggestedActions", "suggestedActionsList", "suggestedActionsClear",
      "chatStream", "chatPending", "chatPendingList",
      "chatApproveAllBtn", "chatRejectAllBtn",
      "chatInput", "chatSendBtn", "chatStopBtn",
      // 改动记录
      "historyView", "historyBadge", "historyCount", "historyClearBtn",
      "historyEmpty", "historyList",
      "historyDocBar", "historyDocName",
      "historyDetailModal", "historyDetailTitle", "historyDetailBody", "historyDetailCloseBtn",
      // 纯净模式开关
      "pureModeToggle",
      // 多对话
      "newConversationBtn", "conversationsMenuBtn", "conversationsMenu",
      "conversationsMenuList", "conversationsMenuEmpty", "conversationsMenuClose",
      // AI 进度条
      "chatProgress", "chatProgressText",
      // 文档锁定 banner
      "docLockBanner", "docLockStatusText",
      // 附件
      "chatAttachBtn", "chatAttachFile", "chatAttachments", "chatAttachActiveBtn",
      // 模型能力 chip
      "capImage", "capPdf", "capThinking"
    ].forEach((id) => { els[id] = $(id); });
  }

  // 模型能力检测：图像 / PDF / 深度思考。统一走 WpsAiCapabilities，UI 与 provider 共享同一套判断
  function isMultimodalModel(name) {
    return global.WpsAiCapabilities?.supportsImage(name) || false;
  }
  function isPdfModel(name) {
    return global.WpsAiCapabilities?.supportsPdf(name) || false;
  }
  function isThinkingModel(name) {
    return global.WpsAiCapabilities?.supportsThinking(name) || false;
  }

  // 思考强度：off / low / medium / high。点 header 上的 🧠 chip 切换，存 localStorage
  const THINKING_LEVEL_KEY = "lingxi_ai_thinking_level_v1";
  const THINKING_LEVELS = ["off", "low", "medium", "high"];
  const THINKING_LEVEL_LABEL = { off: "关", low: "低", medium: "中", high: "高" };
  function readThinkingLevel() {
    try {
      const v = localStorage.getItem(THINKING_LEVEL_KEY);
      return THINKING_LEVELS.includes(v) ? v : "medium";
    } catch (e) { return "medium"; }
  }
  function writeThinkingLevel(level) {
    try { localStorage.setItem(THINKING_LEVEL_KEY, level); } catch (e) {}
  }

  // 当前会话的待发送附件
  let pendingAttachments = [];

  function genAttachId() {
    return "a-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function fmtFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  // 把单个 File 读成附件对象。图片 / PDF 读 dataURL，文本读字符串
  function readFileAsAttachment(file) {
    return new Promise((resolve, reject) => {
      const isImage = /^image\//.test(file.type);
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
      if (isImage) {
        reader.onload = () => resolve({
          id: genAttachId(),
          kind: "image",
          name: file.name,
          mediaType: file.type || "image/png",
          dataUrl: String(reader.result || ""),
          size: file.size
        });
        reader.readAsDataURL(file);
      } else if (isPdf) {
        reader.onload = () => resolve({
          id: genAttachId(),
          kind: "pdf",
          name: file.name,
          mediaType: "application/pdf",
          dataUrl: String(reader.result || ""),
          size: file.size
        });
        reader.readAsDataURL(file);
      } else {
        reader.onload = () => resolve({
          id: genAttachId(),
          kind: "text",
          name: file.name,
          mediaType: file.type || "text/plain",
          textContent: String(reader.result || ""),
          size: file.size
        });
        reader.readAsText(file, "utf-8");
      }
    });
  }

  async function addAttachments(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    // PDF 上限 32MB（跟 proxy 一致），其他 5MB
    const tooLarge = files.find((f) => {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      return f.size > (isPdf ? 32 : 5) * 1024 * 1024;
    });
    if (tooLarge) {
      const cap = (tooLarge.type === "application/pdf" || /\.pdf$/i.test(tooLarge.name)) ? "32MB" : "5MB";
      showMessage(`附件 ${tooLarge.name} 太大（>${cap}），不支持。`, "error");
      return;
    }
    try {
      const results = await Promise.all(files.map(readFileAsAttachment));
      pendingAttachments = pendingAttachments.concat(results);
      renderAttachments();
      const modelName = els.modelSelect?.value;
      const hasImage = results.some((a) => a.kind === "image");
      const hasPdf = results.some((a) => a.kind === "pdf");
      if (hasImage && !isMultimodalModel(modelName)) {
        showMessage("当前模型不支持图片输入，发送时图片附件会被忽略，仅文本附件生效。", "info");
      }
      if (hasPdf && !isPdfModel(modelName)) {
        showMessage(`当前模型「${modelName}」不支持 PDF 附件，发送时会被忽略。建议切到 Claude / GPT-4o / Codex / DeepSeek-V4 等支持 PDF 的模型。`, "info");
      }
    } catch (e) {
      showMessage(e.message || String(e), "error");
    }
  }

  // 把当前 WPS 里打开的文档（PDF 优先）作为附件读进来。
  // 仅在 WPS PDF 宿主 / 文字宿主下、且活动文档是 PDF 文件时可用。
  async function attachActivePdf({ silent = false } = {}) {
    try {
      const docPath = global.WpsAiBackup?.getCurrentDocPath?.();
      if (!docPath) {
        if (!silent) showMessage("未检测到当前文档路径（可能是未保存的临时文档？请先 Ctrl-S 保存）。", "error");
        return null;
      }
      if (!/\.pdf$/i.test(docPath)) {
        if (!silent) showMessage(`当前文档不是 PDF：${docPath}`, "error");
        return null;
      }
      // 已经附过同一份 PDF 就不重复加
      const already = pendingAttachments.find((a) => a.kind === "pdf" && a.sourcePath === docPath);
      if (already) {
        if (!silent) showMessage("当前 PDF 已经在附件列表里了。", "info");
        return already;
      }
      const resp = await fetch("http://localhost:3890/load-local-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: docPath })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `读取 PDF 失败：${resp.status}`);
      const attachment = {
        id: genAttachId(),
        kind: "pdf",
        name: payload.name || "active.pdf",
        mediaType: payload.mediaType || "application/pdf",
        dataUrl: `data:${payload.mediaType || "application/pdf"};base64,${payload.base64}`,
        size: payload.size || 0,
        sourcePath: docPath
      };
      pendingAttachments.push(attachment);
      renderAttachments();
      if (!silent) {
        const modelName = els.modelSelect?.value;
        if (!isPdfModel(modelName)) {
          showMessage(`PDF 已附加，但当前模型「${modelName}」不支持 PDF。请切到 Claude / GPT-4o / Codex / DeepSeek-V4 等支持 PDF 的模型。`, "info");
        }
      }
      return attachment;
    } catch (e) {
      if (!silent) showMessage(e.message || String(e), "error");
      return null;
    }
  }

  function removeAttachment(id) {
    pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
    renderAttachments();
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachments();
  }

  function renderAttachments() {
    if (!els.chatAttachments) return;
    els.chatAttachments.innerHTML = "";
    if (pendingAttachments.length === 0) {
      els.chatAttachments.classList.add("hidden");
      return;
    }
    els.chatAttachments.classList.remove("hidden");
    const modelName = els.modelSelect?.value;
    const multimodal = isMultimodalModel(modelName);
    const pdfReady = isPdfModel(modelName);
    pendingAttachments.forEach((att) => {
      const incompatible = (att.kind === "image" && !multimodal) || (att.kind === "pdf" && !pdfReady);
      const chip = document.createElement("div");
      chip.className = "chat-attach-chip" + (incompatible ? " warn" : "");
      let preview;
      if (att.kind === "image") preview = `<img class="chat-attach-thumb" src="${att.dataUrl}" alt="${att.name}" />`;
      else if (att.kind === "pdf") preview = `<span class="chat-attach-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg></span>`;
      else preview = `<span class="chat-attach-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>`;
      let warn = "";
      if (att.kind === "image" && !multimodal) warn = " · ⚠ 当前模型不支持图片";
      else if (att.kind === "pdf" && !pdfReady) warn = " · ⚠ 当前模型不支持 PDF";
      chip.innerHTML = `
        ${preview}
        <div class="chat-attach-meta">
          <div class="chat-attach-name" title="${att.name}">${att.name}</div>
          <div class="chat-attach-size">${fmtFileSize(att.size)}${warn}</div>
        </div>
        <button class="chat-attach-remove" type="button" title="移除" data-att-id="${att.id}">×</button>
      `;
      chip.querySelector(".chat-attach-remove").addEventListener("click", () => removeAttachment(att.id));
      els.chatAttachments.appendChild(chip);
    });
  }

  function bindAttachments() {
    if (!els.chatAttachBtn || !els.chatAttachFile) return;
    els.chatAttachBtn.addEventListener("click", () => els.chatAttachFile.click());
    els.chatAttachFile.addEventListener("change", (ev) => {
      addAttachments(ev.target.files);
      ev.target.value = "";   // 允许同名文件再选
    });
    // 「附加当前 PDF」按钮：把 WPS 里打开的 PDF 读进附件
    els.chatAttachActiveBtn?.addEventListener("click", () => attachActivePdf({ silent: false }));
    // 模型切换时重渲（更新 ⚠ 标记 + 能力 chip）
    els.modelSelect?.addEventListener("change", updateCapabilityBadges);
    // 思考强度 chip 点击 → low → medium → high → off 循环
    els.capThinking?.addEventListener("click", () => {
      const cur = readThinkingLevel();
      const order = ["low", "medium", "high", "off"];
      const next = order[(order.indexOf(cur) + 1) % order.length] || "medium";
      writeThinkingLevel(next);
      updateCapabilityBadges();
      showMessage(`思考强度切换为：${THINKING_LEVEL_LABEL[next]}`, "info");
    });

    // 自定义模型下拉：按钮点击开/关；点弹层外面关闭；Esc 关闭
    els.modelSelectBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleModelPopup();
    });
    document.addEventListener("click", (ev) => {
      if (!els.modelSelectPopup || els.modelSelectPopup.classList.contains("hidden")) return;
      if (els.modelSelectPopup.contains(ev.target) || els.modelSelectBtn?.contains(ev.target)) return;
      closeModelPopup();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !els.modelSelectPopup?.classList.contains("hidden")) {
        closeModelPopup();
      }
    });
  }

  // 在用户消息气泡下方追加一行附件缩略图 chip（live + history 回放共用）
  function appendUserAttachmentsPreview(attachments) {
    if (!attachments || attachments.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg user-attachments";
    attachments.forEach((a) => {
      const chip = document.createElement("div");
      chip.className = "user-attach-chip";
      if (a.kind === "image" && a.dataUrl) {
        chip.innerHTML = `<img class="chat-attach-thumb" src="${a.dataUrl}" alt="${a.name}"/><span>${a.name}</span>`;
      } else {
        chip.innerHTML = `<span class="chat-attach-icon">📄</span><span>${a.name}</span>`;
      }
      wrap.appendChild(chip);
    });
    els.chatStream?.appendChild(wrap);
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

    [els.modelSelect].forEach((b) => { if (b) b.disabled = isBusy; });
    if (els.suggestedActionsList) {
      els.suggestedActionsList.querySelectorAll("button").forEach((b) => { b.disabled = isBusy; });
    }
    // 文档锁定：AI 工作期间禁止用户编辑文档
    if (isBusy) lockHostDocument();
    else unlockHostDocument();
    // 文档型 host (wps/wpp/et) 下显示锁定 banner（内嵌进度），其他 host 用独立的 chat-progress。
    // 二选一避免两个指示器视觉重叠。
    const host = currentHostInfo?.host || "*";
    const useBanner = isBusy && ["wps", "wpp", "et"].includes(host);
    const useStandalone = isBusy && !useBanner;
    if (els.docLockBanner) els.docLockBanner.classList.toggle("hidden", !useBanner);
    if (els.chatProgress) {
      els.chatProgress.classList.toggle("hidden", !useStandalone);
    }
    if (!isBusy) setProgressStatus(null);
  }

  // ===== 文档锁定 / 用户操作检测 =====
  // 实际锁定逻辑在 js/doc-lock.js 的 WpsAiLock 里，这里只负责 UI 状态 +
  // 轮询给 PPT 等无法硬锁的宿主做兜底警告。

  let docLockWatcher = null;

  function lockHostDocument() {
    const host = currentHostInfo?.host || "*";
    try { global.WpsAiLock?.lock?.(host); } catch (e) {}

    // 轮询 selection（PPT 没有硬锁，需要用变化探测来弹警告；Word/Excel 也加做双保险）
    const app = global.wps?.WpsApplication?.()
      || global.wps?.EtApplication?.()
      || global.wps?.WppApplication?.()
      || global.wps?.Application
      || null;
    if (!app) return;
    let lastSig = readSelectionSig(app, host);
    let warned = false;
    docLockWatcher = setInterval(() => {
      const sig = readSelectionSig(app, host);
      if (sig && lastSig && sig !== lastSig) {
        if (!warned) {
          warned = true;
          showMessage("AI 还在操作文档，您刚才的输入可能会与 AI 冲突，建议等 AI 完成。", "error", { duration: 6000 });
        }
      }
      lastSig = sig || lastSig;
    }, 1000);
  }

  function unlockHostDocument() {
    try { global.WpsAiLock?.unlock?.(); } catch (e) {}
    if (docLockWatcher) { clearInterval(docLockWatcher); docLockWatcher = null; }
  }

  function readSelectionSig(app, host) {
    try {
      if (host === "wps") {
        const sel = app.Selection;
        if (sel) return `wps:${sel.Start || 0}:${sel.End || 0}`;
      } else if (host === "et") {
        const sel = app.Selection;
        if (sel?.Address) return `et:${sel.Address}`;
      } else if (host === "wpp") {
        const view = app.ActiveWindow?.View;
        const slideIdx = view?.Slide?.SlideIndex || 0;
        return `wpp:${slideIdx}`;
      }
    } catch (e) {}
    return null;
  }

  // AI 进度条状态文字：null 表示清空（隐藏文字但保留进度条容器结构）
  // 同步更新 chat-progress 和 doc-lock-banner 两处（两者互斥显示，但 setChatBusy 决定哪个 visible）
  function setProgressStatus(text) {
    const t = text || "";
    if (els.chatProgressText) els.chatProgressText.textContent = t;
    if (els.docLockStatusText) els.docLockStatusText.textContent = t || "AI 正在思考…";
  }

  // 进度条切到"确定百分比"模式：percent 0~100 → 进度条按 % 静态填充
  // percent = null 切回 indeterminate（默认来回滑动）
  function setProgressFill(percent) {
    // 同步 chat-progress 和 doc-lock-banner 的进度条（两者互斥显示）
    const setBar = (container, innerSel) => {
      if (!container) return;
      const inner = container.querySelector(innerSel);
      if (!inner) return;
      if (percent == null) {
        container.classList.remove("is-determinate");
        inner.style.width = "";
        inner.style.left = "";
        inner.style.transform = "";
        return;
      }
      const pct = Math.max(0, Math.min(100, +percent || 0));
      container.classList.add("is-determinate");
      inner.style.left = "0";
      inner.style.transform = "none";
      inner.style.width = `${pct}%`;
    };
    setBar(els.chatProgress, ".chat-progress-bar-inner");
    setBar(els.docLockBanner, ".doc-lock-bar-inner");
  }

  // 暴露给其他模块（如 tools/image.js）的 UI 接口
  global.WpsAiUI = {
    setProgressStatus,
    setProgressFill
  };

  // 把工具名映射成中文，复用 history 模块里的字典
  function friendlyToolName(name) {
    return global.WpsAiHistory?.getFriendlyName?.(name) || name;
  }

  // ---------------- Tabs ----------------

  function activateTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("[data-tab-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.tabPanel !== name));
    // 切到改动记录 Tab 时重新读一次当前文档路径，刷新过滤
    if (name === "history" && typeof renderHistory === "function") {
      try { renderHistory(); } catch (e) {}
    }
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
    if (els.systemPromptInput) els.systemPromptInput.value = (s.systemPrompt != null) ? s.systemPrompt : "";
    if (els.showToolCallLogsInput) els.showToolCallLogsInput.checked = !!s.showToolCallLogs;
    // splitLayersOnInsert 默认关闭（实验性，layered 模式偶发空白 slide bug 修复中）
    if (els.splitLayersOnInsertInput) els.splitLayersOnInsertInput.checked = !!s.splitLayersOnInsert;
    if (els.mcpServerEnabledInput) els.mcpServerEnabledInput.checked = !!s.mcpServerEnabled;
    if (els.updateAutoCheckInput) els.updateAutoCheckInput.checked = !!s.updateAutoCheck;

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
    els.imageType.value = img.type || "toapis";
    // toapis 渠道
    els.imageBaseUrl.value = img.baseUrl || "";
    els.imageApiKey.value = img.apiKey || "";
    els.imageModel.value = img.model || "";
    els.imageDefaultSize.value = img.defaultSize || "1:1";
    els.imageDefaultResolution.value = img.defaultResolution || "1K";
    els.imageUseProxy.checked = img.useProxy !== false;
    // codex-bridge 渠道
    els.imageCodexBaseUrl.value = img.codexBaseUrl || "";
    els.imageCodexApiKey.value = img.codexApiKey || "";
    els.imageCodexModel.value = img.codexModel || "gpt-image-1";
    els.imageCodexSize.value = img.codexSize || "1024x1024";
    els.imageCodexUseProxy.checked = img.codexUseProxy !== false;

    refreshProviderConfigVisibility();
    refreshImageChannelVisibility();
  }

  function readSettingsFromForm() {
    currentSettings.activeProvider = els.providerSelect.value;
    currentSettings.operationMode = els.operationModeSelect.value;
    const maxIter = parseInt(els.maxToolIterationsInput.value, 10);
    currentSettings.maxToolIterations = (Number.isFinite(maxIter) && maxIter > 0) ? maxIter : 50;
    if (els.systemPromptInput) currentSettings.systemPrompt = els.systemPromptInput.value;
    if (els.showToolCallLogsInput) currentSettings.showToolCallLogs = !!els.showToolCallLogsInput.checked;
    if (els.splitLayersOnInsertInput) currentSettings.splitLayersOnInsert = !!els.splitLayersOnInsertInput.checked;
    if (els.mcpServerEnabledInput) currentSettings.mcpServerEnabled = !!els.mcpServerEnabledInput.checked;
    if (els.updateAutoCheckInput) currentSettings.updateAutoCheck = !!els.updateAutoCheckInput.checked;
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
      type: els.imageType.value || "toapis",
      // toapis 字段
      baseUrl: els.imageBaseUrl.value.trim() || "https://toapis.com/v1",
      apiKey: els.imageApiKey.value.trim(),
      model: els.imageModel.value.trim() || "gpt-image-2",
      defaultSize: els.imageDefaultSize.value,
      defaultResolution: els.imageDefaultResolution.value,
      useProxy: els.imageUseProxy.checked,
      // codex-bridge 字段
      codexBaseUrl: els.imageCodexBaseUrl.value.trim(),
      codexApiKey: els.imageCodexApiKey.value.trim(),
      codexModel: els.imageCodexModel.value.trim() || "gpt-image-1",
      codexSize: els.imageCodexSize.value || "1024x1024",
      codexUseProxy: els.imageCodexUseProxy.checked
    });
  }

  // 根据当前选中的渠道，显示/隐藏对应的字段块
  function refreshImageChannelVisibility() {
    const type = (els.imageType && els.imageType.value) || "toapis";
    document.querySelectorAll("[data-image-type]").forEach((node) => {
      node.classList.toggle("hidden", node.dataset.imageType !== type);
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
    // 新版从 chatProviders 找当前激活的 entry；老路径回退 providers
    const entry = (currentSettings.chatProviders || []).find((p) => p.id === info.id);
    const cfg = entry || (currentSettings.providers || {})[info.type];
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

  // ---- 模型缓存（按 provider id 分桶，让 header 下拉能横向列出多家） ----
  // 每个 provider 上次成功 listModels 的结果存这里；refresh 按钮只刷"当前选中" provider
  const MODELS_CACHE_KEY = "lingxi_models_cache_v1";
  let modelsByProvider = {};
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    if (raw) modelsByProvider = JSON.parse(raw) || {};
  } catch (e) { modelsByProvider = {}; }
  function persistModelsCache() {
    try { localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(modelsByProvider)); } catch (e) {}
  }

  // 收集所有 enabled chatProviders 的可见模型项：
  //   每个 provider 至少一条（defaultModel），加上 modelsByProvider[providerId] 缓存
  // 返回 [{ providerId, providerLabel, providerType, modelId }, ...]
  function collectMultiProviderItems() {
    const items = [];
    (currentSettings.chatProviders || []).forEach((p) => {
      if (!p.enabled) return;
      const seen = new Set();
      const push = (m) => {
        if (!m || seen.has(m)) return;
        seen.add(m);
        items.push({ providerId: p.id, providerLabel: p.label || p.id, providerType: p.type, modelId: m });
      };
      const cached = modelsByProvider[p.id] || [];
      cached.forEach(push);
      if (p.defaultModel) push(p.defaultModel);
    });
    return items;
  }

  // 把 activeChatModel 解码到 { providerId, modelId }
  function getActiveChatModel() {
    const r = global.WpsAiProviderRegistry?.parseActiveChatModel?.(currentSettings.activeChatModel || "");
    return r || { providerId: "", modelId: "" };
  }
  function setActiveChatModel(providerId, modelId) {
    currentSettings.activeChatModel = global.WpsAiProviderRegistry.encodeActiveChatModel(providerId, modelId);
    persistSettings();
  }

  // 老接口：单 provider 给 [modelId,...]。内部转成 multi items 调 populateModelSelector
  // 兼容老的 refreshModels 调用路径
  function setModelOptions(models, selected) {
    const list = (models || []).filter(Boolean);
    const activeEntry = global.WpsAiProviderRegistry?.getActiveChatProvider?.(currentSettings) || null;
    if (activeEntry) {
      modelsByProvider[activeEntry.id] = list;
      persistModelsCache();
    }
    populateModelSelector(selected);
  }

  // 重新渲染 header 下拉：hidden select 只放当前选中模型一条（兼容 .value 读取的老代码）；
  // 真正可见的 popup 列出全部 enabled providers × 各自的 modelId
  function populateModelSelector(preferredModelId) {
    if (!els.modelSelect) return;
    const items = collectMultiProviderItems();
    const { providerId: curPid, modelId: curMid } = getActiveChatModel();

    // 选中目标：优先用 preferredModelId（refresh 后保留用户选择），否则 activeChatModel，否则第一条
    let pickedItem = null;
    if (preferredModelId) {
      pickedItem = items.find((it) => it.providerId === curPid && it.modelId === preferredModelId);
      if (!pickedItem) pickedItem = items.find((it) => it.modelId === preferredModelId);
    }
    if (!pickedItem && curPid && curMid) {
      pickedItem = items.find((it) => it.providerId === curPid && it.modelId === curMid);
    }
    if (!pickedItem) pickedItem = items[0] || null;

    // 把"模型"id 同步进隐藏 <select>.value（很多老代码读 .value）
    els.modelSelect.innerHTML = "";
    if (!pickedItem) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "（请在设置里启用至少一个供应商）";
      opt.disabled = true;
      els.modelSelect.appendChild(opt);
      els.modelSelect.value = "";
      renderMultiModelPopup(items, null);
      updateCapabilityBadges();
      return;
    }
    items.forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.modelId;
      opt.dataset.providerId = it.providerId;
      opt.textContent = it.modelId;
      els.modelSelect.appendChild(opt);
    });
    els.modelSelect.value = pickedItem.modelId;
    setActiveChatModel(pickedItem.providerId, pickedItem.modelId);
    renderMultiModelPopup(items, pickedItem);
    updateCapabilityBadges();
  }

  // 渲染下拉浮层：分组按 provider；每行 "[Provider] modelId" + 能力图标
  function renderMultiModelPopup(items, selected) {
    if (!els.modelSelectPopup || !els.modelSelectLabel || !els.modelSelectCaps) return;
    els.modelSelectPopup.innerHTML = "";

    if (items.length === 0) {
      els.modelSelectLabel.textContent = "（请在设置里启用至少一个供应商）";
      els.modelSelectCaps.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "model-select-popup-item disabled";
      empty.innerHTML = `<span class="model-select-popup-item-label">没有可用模型</span>`;
      els.modelSelectPopup.appendChild(empty);
      return;
    }

    // header 按钮上的 label = "<provider> · <model>"，能力 chip 取当前选中模型
    if (selected) {
      els.modelSelectLabel.textContent = `${selected.providerLabel} · ${selected.modelId}`;
      els.modelSelectCaps.innerHTML = capChipsHtmlForButton(selected.modelId);
    } else {
      els.modelSelectLabel.textContent = "（请选择模型）";
      els.modelSelectCaps.innerHTML = "";
    }

    // 按 provider 分组渲染：用一个分组 header + 各 model 行
    const byProvider = new Map();
    items.forEach((it) => {
      if (!byProvider.has(it.providerId)) byProvider.set(it.providerId, { label: it.providerLabel, models: [] });
      byProvider.get(it.providerId).models.push(it);
    });

    byProvider.forEach((group, providerId) => {
      const head = document.createElement("div");
      head.className = "model-select-popup-item disabled";
      head.style.cssText = "padding-top: 8px; font-size: 11px; color: #6b7480; font-weight: 600; cursor: default;";
      head.innerHTML = `<span class="model-select-popup-item-label">▾ ${group.label}</span>`;
      els.modelSelectPopup.appendChild(head);

      group.models.forEach((it) => {
        const item = document.createElement("div");
        const isSel = selected && selected.providerId === providerId && selected.modelId === it.modelId;
        item.className = "model-select-popup-item" + (isSel ? " selected" : "");
        item.setAttribute("role", "option");
        item.dataset.providerId = providerId;
        item.dataset.modelId = it.modelId;
        item.innerHTML = `
          <span class="model-select-popup-item-label" style="padding-left:14px;">${it.modelId}</span>
          <span class="model-select-popup-item-caps">${capChipsHtmlForItem(it.modelId)}</span>
        `;
        item.addEventListener("click", () => {
          setActiveChatModel(providerId, it.modelId);
          if (els.modelSelect) {
            els.modelSelect.value = it.modelId;
            els.modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
          }
          closeModelPopup();
          populateModelSelector(it.modelId);
        });
        els.modelSelectPopup.appendChild(item);
      });
    });
  }

  // SVG 图标常量：弹层每条 + header 按钮里的能力指示器
  // image=画框 / pdf=文档 / thinking=灯泡
  const CAP_ICON_SVG = {
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    pdf:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
    thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>',
    // 扳手图标表示工具调用 / function calling 能力
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
  };
  const CAP_LABEL = { image: "支持图像", pdf: "支持 PDF", thinking: "深度思考", tools: "支持工具调用（可读写文档）" };

  // 当前选中模型旁边的精简 chip 串（只显示"支持"的能力，不画占位）
  function capChipsHtmlForButton(modelId) {
    const cap = global.WpsAiCapabilities?.getCapabilities?.(modelId) || { image: false, pdf: false, thinking: false, tools: true };
    return ["image", "pdf", "thinking", "tools"]
      .filter((k) => cap[k])
      .map((k) => `<span title="${CAP_LABEL[k]}">${CAP_ICON_SVG[k]}</span>`)
      .join("");
  }

  // 弹层每条：模型名 + 四个图标（亮=支持/灰=不支持），用同位置占位让所有行对齐
  function capChipsHtmlForItem(modelId) {
    const cap = global.WpsAiCapabilities?.getCapabilities?.(modelId) || { image: false, pdf: false, thinking: false, tools: true };
    return ["image", "pdf", "thinking", "tools"]
      .map((k) => {
        const cls = cap[k] ? "cap-on" : "cap-off";
        const tip = cap[k] ? CAP_LABEL[k] : `${CAP_LABEL[k]}（不支持）`;
        return `<span class="${cls}" title="${tip}">${CAP_ICON_SVG[k]}</span>`;
      })
      .join("");
  }

  function openModelPopup() {
    if (!els.modelSelectPopup || !els.modelSelectBtn) return;
    els.modelSelectPopup.classList.remove("hidden");
    els.modelSelectBtn.setAttribute("aria-expanded", "true");
    // 滚动到当前选中项可见
    const sel = els.modelSelectPopup.querySelector(".model-select-popup-item.selected");
    if (sel) try { sel.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }
  function closeModelPopup() {
    if (!els.modelSelectPopup || !els.modelSelectBtn) return;
    els.modelSelectPopup.classList.add("hidden");
    els.modelSelectBtn.setAttribute("aria-expanded", "false");
  }
  function toggleModelPopup() {
    if (els.modelSelectPopup?.classList.contains("hidden")) openModelPopup();
    else closeModelPopup();
  }

  // 刷新 header 上的能力 chip（图像/PDF/思考）以及附件 chip 警告
  // 模型支持 → 显示 chip；不支持 → 隐藏。思考 chip 同时显示当前 level
  function updateCapabilityBadges() {
    const model = els.modelSelect?.value || "";
    const cap = global.WpsAiCapabilities?.getCapabilities?.(model) || { image: false, pdf: false, thinking: false };
    if (els.capImage) els.capImage.classList.toggle("hidden", !cap.image);
    if (els.capPdf) els.capPdf.classList.toggle("hidden", !cap.pdf);
    if (els.capThinking) {
      els.capThinking.classList.toggle("hidden", !cap.thinking);
      const level = readThinkingLevel();
      els.capThinking.dataset.level = level;
      const lbl = document.getElementById("capThinkingLevel");
      if (lbl) lbl.textContent = THINKING_LEVEL_LABEL[level] || "中";
      els.capThinking.title = `思考强度：${THINKING_LEVEL_LABEL[level]}（点击切换）`;
    }
    // 下拉按钮的 label / 能力 chip / popup 高亮交给 renderMultiModelPopup 统一管，
    // 这里只刷头部能力 chip 颜色和聊天工具栏的附件警告
    if (els.modelSelectCaps) els.modelSelectCaps.innerHTML = model ? capChipsHtmlForButton(model) : "";
    renderAttachments();
    updateAttachActiveBtn();
  }

  // 把活动 PDF 按钮的显隐 / 启用状态根据当前 host + 文档同步
  function updateAttachActiveBtn() {
    const btn = els.chatAttachActiveBtn;
    if (!btn) return;
    let show = false;
    try {
      const docPath = global.WpsAiBackup?.getCurrentDocPath?.();
      show = !!(docPath && /\.pdf$/i.test(docPath));
    } catch (e) { show = false; }
    btn.classList.toggle("hidden", !show);
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
    const previous = els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel();
    try {
      const models = await global.WpsAiOpenAI.listModels();
      setModelOptions(models, previous);
      if (!silent) showMessage(`已获取 ${models.length} 个模型。`, "success");
    } catch (error) {
      // 刷新失败不清空，只是不补，仍然展示已 cache + defaultModel
      populateModelSelector(previous);
      if (!silent) showMessage(`获取模型失败：${error.message || error}`, "error");
    } finally {
      if (!silent) setBusy(false);
    }
  }

  // ---------------- 设置弹窗 + 聊天供应商卡片 ----------------

  // 浮动模式下 8 个 resize handle 共用同一套 mouse drag 逻辑：
  //   按 screenX/screenY 的 delta 直接调 pane.Width/Height（必要时也调 Left/Top，
  //   从北/西方向拉时窗口左上角会移动）
  function bindFloatingResizeHandles() {
    const handles = document.querySelectorAll(".resize-handle");
    if (handles.length === 0) return;
    handles.forEach((h) => {
      h.addEventListener("mousedown", (ev) => startResize(ev, h.dataset.edge || "se"));
    });
  }

  function startResize(ev, edge) {
    if (!document.body.classList.contains("is-floating")) return;
    const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
    if (!pane) return;
    let initialW = 0, initialH = 0, initialLeft = 0, initialTop = 0;
    try { initialW = Number(pane.Width) || 0; } catch (e) {}
    try { initialH = Number(pane.Height) || 0; } catch (e) {}
    try { initialLeft = Number(pane.Left) || 0; } catch (e) {}
    try { initialTop = Number(pane.Top) || 0; } catch (e) {}
    const startX = ev.screenX;
    const startY = ev.screenY;
    ev.preventDefault();
    ev.stopPropagation();

    function onMove(e) {
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      let newW = initialW, newH = initialH, newL = initialLeft, newT = initialTop;
      if (edge.includes("e")) newW = Math.max(280, initialW + dx);
      if (edge.includes("w")) { newW = Math.max(280, initialW - dx); newL = initialLeft + (initialW - newW); }
      if (edge.includes("s")) newH = Math.max(240, initialH + dy);
      if (edge.includes("n")) { newH = Math.max(240, initialH - dy); newT = initialTop + (initialH - newH); }
      try { if ("Width" in pane && newW !== initialW) pane.Width = Math.round(newW); } catch (er) {}
      try { if ("Height" in pane && newH !== initialH) pane.Height = Math.round(newH); } catch (er) {}
      try { if ("Left" in pane && newL !== initialLeft) pane.Left = Math.round(newL); } catch (er) {}
      try { if ("Top" in pane && newT !== initialTop) pane.Top = Math.round(newT); } catch (er) {}
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  // 根据当前 TaskPane 停靠状态刷新「脱离/停靠」按钮的图标和文字
  function refreshDockToggleUI() {
    if (!els.dockToggleBtn || !els.dockToggleIcon || !els.dockToggleLabel) return;
    const dock = global.WpsAiAddon?.getTaskPaneDockPosition?.();
    // dock=4 浮动；其他（2 右停靠 / null 取不到）都按"已停靠"显示
    const isFloating = dock === 4;
    // 切 body class，让 resize 抓手只在浮动时显示 + 改 cursor
    document.body.classList.toggle("is-floating", isFloating);
    els.dockToggleLabel.textContent = isFloating ? "停靠" : "脱离";
    els.dockToggleBtn.title = isFloating ? "停靠回 WPS 右侧固定区" : "脱离右侧固定区，浮动窗口";
    // 切换 SVG 图标：脱离=对角箭头；停靠=向左 dock-in 箭头
    if (isFloating) {
      els.dockToggleIcon.innerHTML = `
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
        <path d="M15 8l-3 4 3 4"/>
      `;
    } else {
      els.dockToggleIcon.innerHTML = `
        <path d="M14 3h7v7"/>
        <path d="M10 14L21 3"/>
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>
      `;
    }
  }

  function openSettingsModal(panel) {
    if (!els.settingsModal) return;
    renderChatProvidersList();   // 每次打开都重渲，避免 stale
    applySettingsToForm();       // 把 currentSettings 同步进表单（图像 / 统一 / 程序）
    els.settingsModal.classList.remove("hidden");
    if (panel) switchSettingsPanel(panel);
  }

  // 把期望 dialog 尺寸根据屏幕可用区裁剪：低分辨率笔记本 (1366×768) / 多任务窗口里 1600×1000
  // 直接撑爆屏幕看不到底部按钮。规则：在 [minW/H, prefW/H] 之间挑能塞进屏幕的最大值；
  // 边距给 OS 任务栏 / WPS 主窗口标题栏留 100×140。
  function pickDialogSize(prefW, prefH, opts = {}) {
    const minW = opts.minW || 640;
    const minH = opts.minH || 480;
    const marginW = opts.marginW || 100;
    const marginH = opts.marginH || 140;
    const sw = (window.screen?.availWidth || window.screen?.width || prefW);
    const sh = (window.screen?.availHeight || window.screen?.height || prefH);
    const w = Math.max(minW, Math.min(prefW, sw - marginW));
    const h = Math.max(minH, Math.min(prefH, sh - marginH));
    return { w: Math.round(w), h: Math.round(h) };
  }

  // 用 WPS Application.ShowDialog 打开独立的设置窗口（脱离 TaskPane 宽度限制）。
  // 失败回退到 inline modal，保证最差情况下用户能改设置
  function openSettingsAsDialog() {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=settings`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        const { w, h } = pickDialogSize(960, 720);
        // 第 5 个参数 true = 模态阻塞（调用要等用户关 dialog 才返回）。
        // 之前是 false（modeless），ShowDialog 立刻返回 → 下面的 activateWpsApp 在 dialog 刚弹出来时
        // 就跑了，等用户真正关 dialog 时早就过去了 → WPS 被 OS 最小化到托盘没人拉回来。
        // 改 modal=true 后 ShowDialog 阻塞到关闭，activateWpsApp 紧接关闭跑，行为跟预览 dialog 一致。
        app.ShowDialog(url, "灵犀AI 设置", w, h, true);
        // dialog 关掉后 WPS 主窗口会被 OS 切到后台 / 最小化到托盘，主动拉回前台
        try { activateWpsApp(app); } catch (e) {}
        // 关掉后再延迟一拍重试一次，对付 WPS 演示这种关闭后还会切回后台的版本
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        // dialog 期间用户改的设置已经走 localStorage，关掉后我们重读并刷新 UI
        loadSettings();
        applySettingsToForm();
        renderProviderState();
        populateModelSelector(els.modelSelect?.value);
        return;
      }
    } catch (e) {
      console.warn("[settings] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    openSettingsModal("chat");
  }

  // 用 WPS Application.ShowDialog 打开独立的 PPT 风格设置窗口（脱离 TaskPane 宽度限制，
  // 跟"设置"dialog 一致：modal=true 阻塞到关闭，关掉后 activateWpsApp 把 WPS 拉回前台）。
  function openStylePresetAsDialog() {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=stylepreset`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        const { w, h } = pickDialogSize(720, 880);
        app.ShowDialog(url, "灵犀AI PPT 风格", w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        // dialog 期间用户在独立窗口里改 + 保存，主 TaskPane 这边重读 + 触发 UI 刷新
        loadSettings();
        return;
      }
    } catch (e) {
      console.warn("[stylepreset] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    openStylePresetModal();
  }

  // PPT 风格独立窗口里点关闭：保存表单 → 关窗
  function closeStylePresetDialogWindow() {
    try { saveStylePreset({ silent: true }); } catch (e) {}
    try { if (typeof window.close === "function") window.close(); } catch (e) {}
    setTimeout(() => { showMessage("已保存。请点窗口右上角 × 关闭。", "info"); }, 100);
  }

  // 独立窗口里点关闭：让 WPS 关掉当前 dialog；不行就提示用户手动关
  function closeSettingsDialogWindow() {
    // 保存最后一次未保存的编辑
    try { readSettingsFromForm(); persistSettings(); } catch (e) {}
    try {
      if (typeof window.close === "function") window.close();
    } catch (e) {}
    // window.close 在 WPS dialog 里可能没权限关；告诉用户手动点 X
    setTimeout(() => {
      showMessage("已保存。请点窗口右上角 × 关闭。", "info");
    }, 100);
  }

  // 监听 storage 事件：另一个窗口（settings dialog）改了 localStorage，主 TaskPane 同步
  if (!isSettingsDialog) {
    window.addEventListener("storage", (ev) => {
      if (ev.key === "wps_ai_provider_settings_v1") {
        loadSettings();
        renderProviderState();
        populateModelSelector(els.modelSelect?.value);
      }
    });
  }

  function closeSettingsModal() {
    els.settingsModal?.classList.add("hidden");
    closePresetPicker();
    // 关闭时保存一次（按用户的"实时保存"预期）
    persistSettings();
    populateModelSelector(els.modelSelect?.value);
    renderProviderState();
  }

  function switchSettingsPanel(name) {
    document.querySelectorAll(".settings-sidebar-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.settingsPanel === name);
    });
    document.querySelectorAll(".settings-panel").forEach((sec) => {
      sec.classList.toggle("hidden", sec.dataset.settingsPanel !== name);
    });
    // 切到「技能」时按需渲染（首次进入或外部新增技能后都会重渲）
    if (name === "skills") renderSkillsList();
    if (name === "mcp") renderMcpPanel();
  }

  // ============ MCP 服务 UI ============
  let _mcpStatusUnsub = null;

  // 把 WpsAiAddon.getUrlPath() (URL 形式) 转成本地 FS 路径，给 MCP 配置 JSON 用。
  // 输入示例:
  //   file:///E:/workspace/.../plugin                   → E:/workspace/.../plugin
  //   file:///Users/alice/.lingxi-ai/plugin             → /Users/alice/.lingxi-ai/plugin
  //   http://localhost:8889                             → null（dev 模式，无法反推 FS 路径）
  function detectPluginInstallPath() {
    try {
      const url = global.WpsAiAddon?.getUrlPath?.() || "";
      if (!url) return null;
      // file:// 协议 → 去前缀；空格等已被 decodeURI 解过
      const FILE_PREFIX = "file:///";
      if (url.startsWith(FILE_PREFIX)) {
        let p = url.slice(FILE_PREFIX.length);
        // Windows 盘符（"E:/..."）保持原样；其他平台前面补 /
        if (!/^[A-Za-z]:/.test(p)) p = "/" + p;
        // 去末尾斜杠
        p = p.replace(/[\\/]+$/, "");
        return p;
      }
      const FILE_PREFIX2 = "file://"; // 双斜杠形式（部分 WebView）
      if (url.startsWith(FILE_PREFIX2)) {
        return url.slice(FILE_PREFIX2.length).replace(/[\\/]+$/, "");
      }
      return null; // http/https → dev 模式，让用户手填
    } catch (e) { return null; }
  }

  function renderMcpPanel() {
    // 状态文字 + 工具数 + 错误（实时跟随 mcp-bridge 的 status）
    const bridge = global.WpsAiMcpBridge;
    if (!bridge) {
      if (els.mcpStatusBadge) els.mcpStatusBadge.textContent = "模块未加载";
      return;
    }
    applyMcpStatusToUi(bridge.getStatus());
    if (_mcpStatusUnsub) { try { _mcpStatusUnsub(); } catch (e) {} }
    _mcpStatusUnsub = bridge.onStatusChange(applyMcpStatusToUi);

    // 配置 JSON 片段：尽量从 WpsAiAddon.getUrlPath() 推 plugin 安装的本地 FS 路径，
    // 推不出来（dev 模式 http://localhost/...）就回退到占位符。
    const installRoot = detectPluginInstallPath();
    const mcpScript = installRoot
      ? `${installRoot}/tools/mcp-server.js`
      : "<填入 plugin 安装路径>/tools/mcp-server.js";
    const cfg = {
      mcpServers: {
        "wps-ai": {
          command: "node",
          args: [mcpScript],
          env: { WPS_PROXY_PORT: "3890" }
        }
      }
    };
    if (els.mcpConfigSnippet) els.mcpConfigSnippet.value = JSON.stringify(cfg, null, 2);

    // 暴露的工具清单（按当前宿主）
    renderMcpToolsList();
  }

  function applyMcpStatusToUi(st) {
    if (!st) return;
    const badge = els.mcpStatusBadge;
    if (badge) {
      badge.classList.remove("connected", "error", "disabled");
      if (!st.enabled) {
        badge.textContent = "未启用";
        badge.classList.add("disabled");
      } else if (st.connected) {
        badge.textContent = "已连接 ✓";
        badge.classList.add("connected");
      } else {
        badge.textContent = "已开启，未连接";
        badge.classList.add("error");
      }
    }
    if (els.mcpToolCount) els.mcpToolCount.textContent = String(st.toolCount || 0);
    if (els.mcpLastError) els.mcpLastError.textContent = st.lastError || "（无）";
    if (els.mcpServerEnabledInput && els.mcpServerEnabledInput.checked !== !!st.enabled) {
      els.mcpServerEnabledInput.checked = !!st.enabled;
    }
  }

  function renderMcpToolsList() {
    const host = els.mcpToolsList;
    if (!host) return;
    host.innerHTML = "";
    const reg = global.WpsAiToolRegistry;
    if (!reg?.listAll) {
      host.innerHTML = '<div class="skills-empty">工具注册表未加载</div>';
      return;
    }
    // 暴露 plugin 注册的全部工具（跨宿主），按宿主分组显示
    const defs = reg.listAll();
    if (!defs.length) {
      host.innerHTML = '<div class="skills-empty">插件未注册任何工具</div>';
      return;
    }
    // 按宿主分组：wps / wpp / et / pdf / "*"（通用）
    const groups = new Map();
    defs.forEach((d) => {
      const hosts = Array.isArray(d.hosts) ? d.hosts : (d.hosts ? [d.hosts] : ["*"]);
      hosts.forEach((h) => {
        if (!groups.has(h)) groups.set(h, []);
        groups.get(h).push(d);
      });
    });
    const HOST_LABELS = { "*": "通用", wps: "WPS 文字", wpp: "WPP 演示", et: "ET 表格", pdf: "PDF 阅读" };
    const order = ["*", "wps", "wpp", "et", "pdf"];
    order.forEach((h) => {
      const items = groups.get(h);
      if (!items?.length) return;
      const head = document.createElement("div");
      head.style.cssText = "padding:6px 8px 2px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:0.5px;text-transform:uppercase;";
      head.textContent = `${HOST_LABELS[h] || h} (${items.length})`;
      host.appendChild(head);
      items.forEach((d) => {
        const row = document.createElement("div");
        row.className = "mcp-tool-row";
        const name = document.createElement("span");
        name.className = "mcp-tool-name";
        name.textContent = d.name;
        const desc = document.createElement("span");
        desc.className = "mcp-tool-desc";
        const firstLine = String(d.description || "").split(/\r?\n/)[0].slice(0, 120);
        desc.textContent = firstLine || "（无描述）";
        row.appendChild(name);
        row.appendChild(desc);
        host.appendChild(row);
      });
    });
  }

  // ============ 技能（Skills）UI ============
  // 渲染设置面板里的技能列表：内置 + 用户导入，统一按"卡片 + 复选框 + 操作按钮"展示
  function renderSkillsList() {
    const host = els.skillsList;
    if (!host) return;
    const Skills = global.WpsAiSkills;
    if (!Skills) {
      host.innerHTML = '<div class="skills-empty">技能模块未加载</div>';
      return;
    }
    host.innerHTML = "";
    const all = Skills.list();
    if (!all.length) {
      host.innerHTML = '<div class="skills-empty">暂无技能</div>';
      return;
    }
    all.forEach((skill) => {
      const item = document.createElement("div");
      item.className = "skill-item" + (Skills.isEnabled(skill.id) ? " enabled" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Skills.isEnabled(skill.id);
      cb.title = "启用 / 停用此技能";
      cb.addEventListener("change", () => {
        Skills.setEnabled(skill.id, cb.checked);
        item.classList.toggle("enabled", cb.checked);
      });
      const body = document.createElement("div");
      body.className = "skill-item-body";
      const row1 = document.createElement("div");
      row1.className = "skill-item-row1";
      const name = document.createElement("span");
      name.className = "skill-item-name";
      name.textContent = skill.name;
      const badge = document.createElement("span");
      badge.className = "skill-item-badge" + (skill.builtin ? "" : " user");
      badge.textContent = skill.builtin ? "内置" : "自定义";
      row1.appendChild(name);
      row1.appendChild(badge);
      const desc = document.createElement("div");
      desc.className = "skill-item-desc";
      desc.textContent = skill.description || "（无描述）";
      body.appendChild(row1);
      body.appendChild(desc);

      const actions = document.createElement("div");
      actions.className = "skill-item-actions";
      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "skill-item-action";
      previewBtn.textContent = "查看";
      previewBtn.title = "查看技能全文";
      previewBtn.addEventListener("click", () => showSkillPreview(skill));
      actions.appendChild(previewBtn);
      if (!skill.builtin) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "skill-item-action danger";
        del.textContent = "删除";
        del.title = "从本地删除这条技能";
        del.addEventListener("click", () => {
          if (!confirm(`从技能库删除「${skill.name}」？此操作不可撤销。`)) return;
          Skills.removeUser(skill.id);
          renderSkillsList();
        });
        actions.appendChild(del);
      }

      item.appendChild(cb);
      item.appendChild(body);
      item.appendChild(actions);
      host.appendChild(item);
    });
  }

  // 技能全文预览：内联 overlay（window.open 在 WPS WebView 经常被拦）。
  // 支持：
  //   - markdown 渲染（有 WpsAiMarkdown 时）
  //   - contentPath 形式的内置技能（UI/UX Pro Max 44KB）懒加载
  //   - 复制全文 / 按 Esc 关闭 / 点 overlay 关闭
  let _skillPreviewOverlay = null;
  async function showSkillPreview(skill) {
    closeSkillPreview(); // 先关上次的
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay skill-preview-overlay";
    overlay.innerHTML = `
      <div class="modal-card skill-preview-card">
        <div class="modal-header">
          <h3>
            <span class="skill-preview-name"></span>
            <span class="skill-item-badge skill-preview-badge"></span>
          </h3>
          <div class="modal-header-actions">
            <button type="button" class="ghost-btn" data-act="copy" title="复制全文到剪贴板">复制全文</button>
            <button type="button" class="modal-close" data-act="close" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="modal-body skill-preview-body">
          <div class="skill-preview-desc"></div>
          <div class="skill-preview-meta"></div>
          <div class="skill-preview-content"></div>
          <div class="skill-preview-loading">加载中…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    _skillPreviewOverlay = overlay;

    const nameEl = overlay.querySelector(".skill-preview-name");
    const badgeEl = overlay.querySelector(".skill-preview-badge");
    const descEl = overlay.querySelector(".skill-preview-desc");
    const metaEl = overlay.querySelector(".skill-preview-meta");
    const contentEl = overlay.querySelector(".skill-preview-content");
    const loadingEl = overlay.querySelector(".skill-preview-loading");

    nameEl.textContent = skill.name || "未命名技能";
    badgeEl.textContent = skill.builtin ? "内置" : "自定义";
    badgeEl.classList.toggle("user", !skill.builtin);
    descEl.textContent = skill.description || "（无描述）";

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSkillPreview();
      const act = e.target?.closest?.("[data-act]")?.dataset?.act;
      if (act === "close") closeSkillPreview();
      if (act === "copy") {
        const text = contentEl.dataset.rawText || "";
        copyToClipboard(text).then((ok) => {
          showMessage(ok ? `已复制 ${text.length} 字符到剪贴板` : "复制失败", ok ? "success" : "error");
        });
      }
    });
    // Esc 关闭
    const onKey = (ev) => { if (ev.key === "Escape") closeSkillPreview(); };
    document.addEventListener("keydown", onKey);
    overlay.dataset.keyHandler = "1";
    overlay._cleanupKey = () => document.removeEventListener("keydown", onKey);

    // 加载内容（contentPath 形式异步）
    let content = "";
    try {
      if (skill.content) {
        content = skill.content;
      } else if (skill.contentPath && global.WpsAiSkills?.loadContent) {
        content = await global.WpsAiSkills.loadContent(skill);
      }
    } catch (e) {
      content = `（加载失败：${e?.message || e}）`;
    }
    loadingEl.style.display = "none";

    const chars = content.length;
    const lines = content.split(/\r?\n/).length;
    const tokens = Math.ceil(chars / 4); // 粗略估算
    metaEl.textContent = `${chars.toLocaleString()} 字符 · ${lines.toLocaleString()} 行 · ≈${tokens.toLocaleString()} tokens`;

    contentEl.dataset.rawText = content;
    // 优先 markdown 渲染（标题/列表/代码块更好看）；没加载就降级 <pre>
    if (global.WpsAiMarkdown?.renderToHtml) {
      contentEl.innerHTML = global.WpsAiMarkdown.renderToHtml(content);
      contentEl.classList.add("markdown");
    } else {
      const pre = document.createElement("pre");
      pre.textContent = content;
      contentEl.appendChild(pre);
    }
  }

  function closeSkillPreview() {
    if (!_skillPreviewOverlay) return;
    try { _skillPreviewOverlay._cleanupKey?.(); } catch (e) {}
    try { _skillPreviewOverlay.remove(); } catch (e) {}
    _skillPreviewOverlay = null;
  }

  // 文件选择 → 解析 → 入库
  function handleSkillImport(file) {
    if (!file) return;
    const Skills = global.WpsAiSkills;
    if (!Skills) { showMessage("技能模块未加载", "error"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const parsed = Skills.parseMarkdownSkill(text, file.name);
        if (!parsed.content) {
          showMessage(`「${file.name}」内容为空，已跳过`, "error");
          return;
        }
        const saved = Skills.addUser(parsed);
        showMessage(`已导入技能「${saved.name}」`, "success");
        renderSkillsList();
      } catch (e) {
        showMessage(`导入失败：${e?.message || e}`, "error");
      }
    };
    reader.onerror = () => showMessage("读取文件失败", "error");
    reader.readAsText(file, "utf-8");
  }

  // 拼成 system prompt block (async, 因为 contentPath 形式的内置 skill 要 fetch 文件)
  // opts.host 让 skill 的 hostFilter 生效（如 UI/UX Pro Max 只在 PPT 宿主注入）
  async function buildSkillsPromptBlock(opts) {
    try {
      const fn = global.WpsAiSkills?.getEnabledSkillsWithContent;
      if (!fn) return "";
      const enabled = await fn(opts || {});
      if (!enabled.length) return "";
      const blocks = enabled.map((s) => [
        `## ${s.name}`,
        s.description ? `> ${s.description}` : "",
        s.content
      ].filter(Boolean).join("\n"));
      return "\n--- 启用的技能（按场景给 AI 的精准指令）---\n" + blocks.join("\n\n");
    } catch (e) { return ""; }
  }

  // 在用户的当前一轮输入里查找 PPT 风格/视觉关键词。命中说明用户已经表达了风格意图，
  // 此时让位给设计自由度（UI/UX Pro Max 技能），不再用本地 stylePreset 锁死色板。
  function detectPptStyleIntent(text) {
    if (!text) return false;
    const s = String(text).toLowerCase();
    // 中文风格 / 设计感关键词（按 PPT 设计场景挑常出现的）
    const ZH = [
      // 风格名
      "极简", "扁平", "拟物", "玻璃", "毛玻璃", "立体", "暗黑", "深色", "亮色", "高对比",
      "霓虹", "赛博", "蒸汽波", "复古", "做旧", "波普", "野兽派", "孟菲斯",
      "水墨", "国风", "中式", "日系", "和风", "禅意", "瑞士风", "包豪斯",
      "卡通", "手绘", "插画", "杂志", "编辑", "报刊", "漫画", "像素",
      "科技", "未来", "金属", "工业", "现代", "古典", "高级",
      // 视觉特征
      "渐变", "光晕", "粒子", "网格", "卡片", "圆角", "阴影",
      // 颜色暗示
      "色调", "配色", "主色", "色板", "用红", "用蓝", "用绿", "用紫", "用黄", "用黑", "用白",
      "暖色", "冷色",
      // 通用
      "风格", "调性", "氛围", "设计感", "高端"
    ];
    if (ZH.some((k) => s.includes(k))) return true;
    // 英文 keyword
    const EN = [
      "minimalist", "minimal", "flat", "glassmorphism", "glass morphism", "neumorphism",
      "skeuomorphism", "brutalism", "claymorphism", "bento", "memphis",
      "cyberpunk", "vaporwave", "synthwave", "retro", "vintage", "y2k",
      "dark mode", "light mode", "high contrast",
      "gradient", "neon", "metallic", "futuristic", "modern", "elegant", "luxury",
      "industrial", "swiss", "bauhaus", "editorial",
      // hex 色码（用户直接给颜色就算明确指定）
      "#"
    ];
    if (EN.some((k) => s.includes(k))) return true;
    return false;
  }

  // 把 currentSettings.chatProviders 渲染成可编辑卡片列表
  function renderChatProvidersList() {
    const wrap = els.chatProvidersList;
    if (!wrap) return;
    wrap.innerHTML = "";
    (currentSettings.chatProviders || []).forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "chat-provider-card" + (p.enabled ? "" : " disabled");
      card.dataset.providerId = p.id;
      const head = document.createElement("div");
      head.className = "chat-provider-card-head";
      head.innerHTML = `
        <span class="chat-provider-card-label">${escapeHtml(p.label || p.id)}</span>
        <span class="chat-provider-card-type">${escapeHtml(p.type)}</span>
        <label class="chat-provider-card-toggle">
          <input type="checkbox" data-role="toggle" ${p.enabled ? "checked" : ""}/>
          <span>启用</span>
        </label>
        <button type="button" class="card-action-btn" data-role="test" title="测试此供应商（拉取模型列表）" aria-label="测试">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </button>
        <span class="chat-provider-card-chev">▾</span>
      `;
      head.addEventListener("click", (ev) => {
        if (ev.target.closest('[data-role="toggle"], [data-role="test"]')) return;
        card.classList.toggle("expanded");
      });
      head.querySelector('[data-role="toggle"]').addEventListener("change", (ev) => {
        p.enabled = ev.target.checked;
        card.classList.toggle("disabled", !p.enabled);
        persistSettings();
        populateModelSelector(els.modelSelect?.value);
      });
      head.querySelector('[data-role="test"]').addEventListener("click", async (ev) => {
        ev.stopPropagation();
        applyChatProviderCardEdits(card, p);
        persistSettings();
        await testSpecificProvider(p);
      });
      card.appendChild(head);

      const body = document.createElement("div");
      body.className = "chat-provider-card-body";

      if (p.type === "codex") {
        // Codex 只走 OAuth，配置项只有 defaultModel
        body.innerHTML = `
          <label class="field"><span>默认模型</span><input type="text" data-field="defaultModel" value="${escapeAttr(p.defaultModel || "")}"/></label>
          <small class="muted">Codex 走 ChatGPT OAuth 登录。请在"程序信息"导出后切换登录账号。</small>
        `;
      } else if (p.type === "anthropic") {
        body.innerHTML = `
          <label class="field"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://api.anthropic.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
          <label class="field"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-ant-..." value="${escapeAttr(p.apiKey || "")}"/></label>
          <label class="field"><span>默认模型</span><input type="text" data-field="defaultModel" placeholder="claude-sonnet-4-6" value="${escapeAttr(p.defaultModel || "")}"/></label>
          <label class="field"><span>Anthropic Version</span><input type="text" data-field="anthropicVersion" placeholder="2023-06-01" value="${escapeAttr(p.anthropicVersion || "2023-06-01")}"/></label>
          <label class="field-row"><input type="checkbox" data-field="useProxy" ${p.useProxy !== false ? "checked" : ""}/><span>通过本地 CORS 代理</span></label>
        `;
      } else {
        // openai 兼容
        body.innerHTML = `
          <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
          <label class="field"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://api.openai.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
          <label class="field"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
          <label class="field"><span>默认模型</span><input type="text" data-field="defaultModel" placeholder="gpt-4o-mini" value="${escapeAttr(p.defaultModel || "")}"/></label>
          <label class="field-row"><input type="checkbox" data-field="useProxy" ${p.useProxy !== false ? "checked" : ""}/><span>通过本地 CORS 代理</span></label>
        `;
      }

      // codex/anthropic/openai-official 是内置条目不让删；用户加的可以删
      const isBuiltin = ["codex", "anthropic", "openai-official"].includes(p.id);
      if (!isBuiltin) {
        const actions = document.createElement("div");
        actions.className = "chat-provider-card-actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => {
          if (!confirm(`确定删除 ${p.label || p.id}？`)) return;
          currentSettings.chatProviders.splice(idx, 1);
          persistSettings();
          renderChatProvidersList();
          populateModelSelector(els.modelSelect?.value);
        });
        actions.appendChild(delBtn);
        body.appendChild(actions);
      }

      // 输入变化实时写回内存（不立即 persist，避免每键击都写 localStorage）
      body.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("change", () => {
          applyChatProviderCardEdits(card, p);
          persistSettings();
        });
      });

      card.appendChild(body);
      wrap.appendChild(card);
    });
  }

  // 把单张卡片的表单值写回 chatProviders 条目
  function applyChatProviderCardEdits(card, entry) {
    card.querySelectorAll("[data-field]").forEach((inp) => {
      const key = inp.dataset.field;
      if (inp.type === "checkbox") entry[key] = inp.checked;
      else entry[key] = inp.value.trim();
    });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // ---- 预设供应商选单 ----
  function openPresetPicker() {
    const known = global.WpsAiProviderRegistry?.KNOWN_CHAT_PROVIDERS || [];
    els.presetPickerList.innerHTML = "";
    known.forEach((preset) => {
      const item = document.createElement("div");
      item.className = "preset-list-item";
      item.innerHTML = `
        <span class="preset-list-item-label">${escapeHtml(preset.label)}</span>
        <span class="preset-list-item-url">${escapeHtml(preset.baseUrl || "(OAuth)")}</span>
      `;
      item.addEventListener("click", () => addChatProviderFromPreset(preset));
      els.presetPickerList.appendChild(item);
    });
    els.presetPickerModal?.classList.remove("hidden");
  }
  function closePresetPicker() {
    els.presetPickerModal?.classList.add("hidden");
  }
  function addChatProviderFromPreset(preset) {
    // 生成不重名 id：如果列表里已经有同 id 的，追加 -2/-3/...
    let id = preset.id;
    const existing = new Set((currentSettings.chatProviders || []).map((p) => p.id));
    let counter = 2;
    while (existing.has(id)) id = `${preset.id}-${counter++}`;
    const entry = {
      id,
      type: preset.type,
      label: preset.label,
      enabled: true,
      baseUrl: preset.baseUrl || "",
      apiKey: "",
      defaultModel: preset.defaultModel || "",
      anthropicVersion: preset.anthropicVersion || "2023-06-01",
      useProxy: true
    };
    currentSettings.chatProviders = currentSettings.chatProviders || [];
    currentSettings.chatProviders.push(entry);
    persistSettings();
    closePresetPicker();
    renderChatProvidersList();
    // 自动展开新增的卡片，让用户填 API Key
    setTimeout(() => {
      const card = els.chatProvidersList.querySelector(`[data-provider-id="${CSS.escape(id)}"]`);
      if (card) card.classList.add("expanded");
    }, 0);
    populateModelSelector(els.modelSelect?.value);
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

  // 取流式输出的最近尾段，给进度文字用（类似 Claude Code 的 "…最近几个字"）。
  // - 折行成单行
  // - 超过 max 字符就截尾部，前面加省略号
  function tailForProgress(text, max = 60) {
    const s = oneLine(text);
    if (!s) return "…";
    if (s.length <= max) return s;
    return "…" + s.slice(-max);
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

  // ===== 瞬态工具调用气泡（默认行为）=====
  // 行为参照 Claude Code：tool_call 时弹一个单行气泡（工具名 + 尾部截断的参数预览），
  // tool_result 到达时直接移除（错误时变红保留一行摘要）。
  // 想看完整 JSON 详情 → 设置里勾「显示工具调用详情（开发者日志）」开关
  let _activeTransientToolBubble = null;
  function appendTransientToolBubble(name) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg tool transient";
    const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
    let frame = 0;
    const spin = document.createElement("span");
    spin.className = "tool-transient-spin";
    spin.textContent = FRAMES[0];
    const nameEl = document.createElement("span");
    nameEl.className = "tool-transient-name";
    nameEl.textContent = friendlyToolName ? friendlyToolName(name) : name;
    const preview = document.createElement("span");
    preview.className = "tool-transient-preview";
    wrap.appendChild(spin);
    wrap.appendChild(nameEl);
    wrap.appendChild(preview);
    wrap._spinTimer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      spin.textContent = FRAMES[frame];
    }, 80);
    els.chatStream.appendChild(wrap);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return wrap;
  }
  function updateTransientToolBubble(bubble, previewStr) {
    if (!bubble) return;
    const t = bubble.querySelector(".tool-transient-preview");
    if (!t) return;
    // direction:rtl + ellipsis 让"超长字符串自动只露尾部"——dir 反转字符顺序，
    // 这里再 unicode bidi 包一下让原文字符顺序保持正常
    t.textContent = "‪" + oneLine(previewStr) + "‬";
  }
  function clearTransientToolBubble(bubble, opts) {
    if (!bubble) return;
    if (bubble._spinTimer) { clearInterval(bubble._spinTimer); bubble._spinTimer = null; }
    if (opts?.errorSummary) {
      // 失败 → 把 bubble 转成静态错误条留下
      bubble.classList.add("err");
      const spin = bubble.querySelector(".tool-transient-spin");
      if (spin) spin.textContent = "⚠";
      const preview = bubble.querySelector(".tool-transient-preview");
      if (preview) preview.textContent = "‪" + oneLine(opts.errorSummary) + "‬";
      return;
    }
    bubble.remove();
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

    // 文档保存状态预检查：WPS 文档型 host (wps/wpp/et) 下未保存的临时文档，
    // tools/registry.js 在 AI 调修改型工具时会拦截，但那要等 AI 思考 + 至少一轮工具调用才报错——
    // 用户白白等 10-30s 才看到一句「请先 Ctrl-S」。这里 fail-fast 让 user message 一发出去就拒绝。
    try {
      const hi = await global.WpsAiDocument?.getHostInfo?.();
      const isDocHost = hi && ["wps", "wpp", "et"].includes(hi.host);
      if (isDocHost) {
        const dp = global.WpsAiBackup?.getCurrentDocPath?.();
        if (!dp) {
          appendChatMsg("user", userInput, { label: "我" });
          appendChatMsg(
            "assistant",
            "当前文档尚未保存到磁盘（临时文档），AI 修改类操作会被拒绝。\n\n请先按 **Ctrl-S / Cmd-S** 把文档存到磁盘后再聊：所有改动会关联到该文件路径，方便备份与回滚。",
            { label: "AI", kind: "err" }
          );
          return;
        }
      }
    } catch (e) { /* host 探测失败 fallback 到老路径（registry 兜底） */ }

    // 取走本轮附件，准备组装 user message
    const turnAttachments = pendingAttachments.slice();
    clearAttachments();

    // 把文本附件 inline 进 prompt（任何模型都能消化）
    let userPromptText = userInput;
    const textAttachments = turnAttachments.filter((a) => a.kind === "text");
    if (textAttachments.length > 0) {
      const blocks = textAttachments.map((a) => {
        const lang = (a.name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
        return `\n\n[附件：${a.name}]\n\`\`\`${lang}\n${a.textContent}\n\`\`\``;
      });
      userPromptText = userInput + blocks.join("");
    }

    // 图片附件：模型多模态才发，否则提示用户并丢弃
    const imageAttachments = turnAttachments.filter((a) => a.kind === "image");
    const pdfAttachments = turnAttachments.filter((a) => a.kind === "pdf");
    const modelName = els.modelSelect?.value || "";
    const useImages = imageAttachments.length > 0 && isMultimodalModel(modelName);
    const usePdfs = pdfAttachments.length > 0 && isPdfModel(modelName);
    if (imageAttachments.length > 0 && !useImages) {
      showMessage(`当前模型「${modelName}」不支持图片，${imageAttachments.length} 张图片已忽略，仅发送文本。`, "info");
    }
    if (pdfAttachments.length > 0 && !usePdfs) {
      showMessage(`当前模型「${modelName}」不支持 PDF 附件，${pdfAttachments.length} 个 PDF 已忽略。请切到 Claude / GPT-4o / Codex / DeepSeek-V4 等支持 PDF 的模型。`, "info");
    }

    // 构造 user message content：
    //   纯文本             → string
    //   有图片/PDF          → array of parts（image_url / file）
    let userMsgContent;
    if (useImages || usePdfs) {
      userMsgContent = [{ type: "text", text: userPromptText }];
      imageAttachments.forEach((img) => {
        if (useImages) userMsgContent.push({ type: "image_url", image_url: { url: img.dataUrl } });
      });
      pdfAttachments.forEach((pdf) => {
        if (usePdfs) userMsgContent.push({
          type: "file",
          file: { file_data: pdf.dataUrl, filename: pdf.name || "file.pdf" }
        });
      });
    } else {
      userMsgContent = userPromptText;
    }

    setChatBusy(true);
    setProgressStatus("AI 正在思考…");
    // chat 流里展示用户消息：纯文本走原路，带附件时在文本下方挂 chip 预览
    appendChatMsg("user", userInput, { label: "我" });
    if (turnAttachments.length > 0) appendUserAttachmentsPreview(turnAttachments);

    chatHistory.push({ role: "user", content: userMsgContent });

    // 开启新一轮 history turn——之后第一个修改型工具会懒抓文档备份
    try { global.WpsAiHistory?.startTurn?.(userInput); } catch (e) {}

    // 收集本轮所有 UI 事件（user / reasoning / tool_call / tool_result / assistant）
    // 切换历史对话时按这个事件流重布 chat 流，完整还原"应答过程"
    const turnEvents = [{
      type: "user", text: userInput, ts: Date.now(),
      attachments: turnAttachments.map((a) => ({
        id: a.id, kind: a.kind, name: a.name, size: a.size,
        // 图片附件存 dataUrl 让历史回显能看到缩略图；文本附件不重复存内容
        dataUrl: a.kind === "image" ? a.dataUrl : undefined
      }))
    }];
    let lastReasoningText = "";

    try {
      // 每轮 chat 前重新探测一次 host，避免用户切换宿主后工具集错位
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      const allTools = global.WpsAiToolRegistry.listForHost(currentHostInfo.host);
      const model = els.modelSelect.value || global.WpsAiOpenAI.getDefaultModel();

      // 模型工具调用能力检测。命中 denylist（如 DeepSeek R1 / 纯推理模型）→
      //   1) chat 里附一条 ai-err 提示用户「当前模型不支持工具调用」
      //   2) 不传 tools 入参，避免有的 provider 报 400 invalid_function_parameters
      //   3) 同一对话同一模型只提示一次（避免每轮刷屏）
      const supportsTools = global.WpsAiCapabilities?.supportsTools?.(model) !== false;
      const tools = supportsTools ? allTools : [];
      if (!supportsTools) {
        const noticeKey = `noToolNotice:${model}`;
        if (!window[noticeKey]) {
          window[noticeKey] = true;
          appendChatMsg(
            "assistant",
            `当前模型「${model}」不支持工具调用（function calling）。AI 无法直接读写文档，只能用自然语言指导你操作。\n\n如果想让 AI 真的改文档，换一个支持工具调用的模型（Claude 系列 / GPT-4o+ / DeepSeek-V3 chat / Qwen / Kimi / GLM 等）。`,
            { label: "AI", kind: "err" }
          );
        }
        plog?.("toolCapability", "supportsTools=false, 跳过 tools 入参", { model });
      }

      // 检测用户本轮输入是否已经显式指定 PPT 风格/视觉关键词。
      // 命中 → 让 AI 走 UI/UX Pro Max 设计自由度，不再注入用户保存的 stylePreset
      //         （锁住色板会让 AI 没法做用户要的 "cyberpunk" / "极简" / "暗黑" 等指定风格）
      // 未命中 → 用 stylePreset（用户已配过整体视觉风格，本次按它统一）
      const userSpecifiedPptStyle = currentHostInfo.host === "wpp"
        && detectPptStyleIntent(userInput);
      if (userSpecifiedPptStyle) {
        plog?.("pptStyleHint", "user input mentions design style → 让位给 UI/UX 技能，跳过 stylePreset 注入");
      }

      // 如果在 PPT 宿主且用户启用了风格预设，把要点写进系统提示
      let stylePresetNote = "";
      if (currentHostInfo.host === "wpp" && currentSettings?.stylePreset?.enabled && !userSpecifiedPptStyle) {
        const sp = currentSettings.stylePreset;
        const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
        const matched = sp.scheme && schemes[sp.scheme];
        const guidelines = global.WpsAiProviderRegistry?.DESIGN_GUIDELINES || [];
        const themeLine = matched
          ? `  · 主题：${matched.label} — ${matched.description}（${matched.design}）`
          : "  · 主题：用户自定义色板";
        const signatureLine = matched?.signatureElement
          ? `  · 标志视觉元素（封面/章节页必须体现）：${matched.signatureElement}`
          : "";
        const layoutLine = matched?.layoutHints
          ? `  · 优先版式组合（直接照做）：${matched.layoutHints}`
          : "";
        stylePresetNote = [
          "用户已启用 PPT 风格预设——本次对话生成 / 修改的所有幻灯片必须保持以下统一样式：",
          themeLine,
          `  · 标题：字体 ${sp.titleFont}，字号 ${sp.titleSize}pt，${sp.titleBold ? "加粗" : "常规"}，颜色 ${sp.titleColor}`,
          `  · 正文：字体 ${sp.bodyFont}，字号 ${sp.bodySize}pt，颜色 ${sp.bodyColor}`,
          `  · 色板：primary=${sp.primaryColor} / secondary=${sp.secondaryColor} / accent=${sp.accentColor} / background=${sp.backgroundColor} / surface=${sp.surfaceColor}`,
          signatureLine,
          layoutLine,
          sp.themeFile ? `  · 主题模板文件：${sp.themeFile}（每页生成完毕后调用 wpp_apply_theme(themePath=该路径) 套用）` : "",
          "",
          "灵犀 PPT 设计宪法（每次配版前自检）：",
          ...guidelines.map((g, i) => `  ${i + 1}. ${g}`),
          "",
          "实践：每次 wpp_add_slide 之后调一次 wpp_apply_style_preset 自动套用字体；如果有自定义文本框（wpp_add_text_box）也按上面的字体字号填；不确定时先调 wpp_get_style_preset 拿完整色板与签名元素再设计。"
        ].filter(Boolean).join("\n");
      }

      // 用户配置的系统提示词（默认是一套"去 AI 味 + 简洁 + 不堆 emoji"的规则）
      const userSystemPrompt = (currentSettings.systemPrompt || "").trim();

      // PPT 强制走 HTML 预览流程：所有「生成新幻灯片」类请求都必须先用 wpp_render_html_template
      // 打开预览让用户微调，禁止直接 wpp_add_slide / wpp_apply_template 直写。
      // 例外只有 ① 用户明确说「直接生成不要预览」「批量出 N 页」 ② 编辑/修改现有页（用 wpp_replace_shape_text 等）。
      const wppPreviewFirstNote = currentHostInfo.host === "wpp" ? [
        "",
        "【PPT 生成流程强制】",
        "1. 用户要求生成新幻灯片（不论封面/章节/内容/数据/引言）时，**必须**调 wpp_render_html_template（默认 preview=true）走预览流程；不要调 wpp_add_slide + wpp_apply_template / wpp_apply_visual_template / wpp_add_text_box 这类直写工具。",
        "2. 调用前先调一次 wpp_render_html_template(templateName=\"__list\") 拿当前可用模板和布局清单；按用户的页面类型选合适 templateName+layout。",
        "3. 工具返回 { previewOpened: true, ... } 后，告诉用户「已打开预览，请在弹窗里微调字段后点插入」，**本轮不要再调任何幻灯片工具**——等用户在弹窗里确认后插入是自动的，不需要你再做任何事。",
        "4. 用户连续要 N 页（>=3）且明确说「不要每页预览，直接出」时，才传 preview=false 跳过弹窗。",
        "5. 修改已有页面文字（不是生成新页）继续用 wpp_replace_shape_text / wpp_format_shape_text 等；不要走 HTML 模板。",
        "6. 如果 wpp_render_html_template 报「模板不存在」「布局不支持」，给用户解释当前可用模板范围，让用户选最接近的一个，不要 fallback 到直写工具。",
        ""
      ].join("\n") : "";

      // 当 HTML 预览 modal 打开时，把当前 state 注入 system prompt，让 AI 知道用户面前的是什么。
      // 用户对话里说「改成更短的标题」「副标改 X」时，AI 应该再调一次 wpp_render_html_template
      //（同 templateName + layout，data 改新值），modal 会原地更新字段不会弹新窗。
      let htmlPreviewStateNote = "";
      try {
        const st = global.WpsAiHtmlPreview?.getState?.();
        if (st && st.templateName) {
          htmlPreviewStateNote = [
            "",
            "【当前 HTML 预览弹窗状态】（用户正在看一个预览弹窗，你可以再调一次 wpp_render_html_template 用同 templateName+layout 但不同 data 来「修改预览」）",
            `  templateName: ${st.templateName}`,
            `  layout: ${st.layout}`,
            `  data（当前字段值）: ${JSON.stringify(st.data || {}, null, 2)}`,
            st.slideHint ? `  slideHint: 第 ${st.slideHint} 页（用户可点「替换原幻灯片」覆盖该页）` : "",
            "用户提出修改时（如「标题改短」「加副标」「内容多加一条」），保持 templateName/layout 不变，data 字段在当前值基础上 patch，再调一次工具即可——modal 会原地更新不弹新窗。",
            ""
          ].filter(Boolean).join("\n");
        }
      } catch (e) { /* 没开就算了 */ }

      // 启用的技能拼 system prompt block —— async（contentPath 形式的 builtin 要 fetch md）
      const skillsBlock = await buildSkillsPromptBlock({ host: currentHostInfo.host });
      // PPT 设计自由度提示：用户在本轮 prompt 指定了风格时，告诉 AI 大胆按指定风格走，
      // 不要绑死 freeform 默认 padding / 字号映射等套路。
      const pptFreeDesignNote = userSpecifiedPptStyle ? [
        "",
        "【PPT 设计自由度模式】",
        "用户本轮明确指定了视觉风格 —— 你应当**完全按用户提到的风格 / 颜色 / 调性**去设计幻灯片，跳出现有模板的死板布局：",
        "- freeform 布局优先（用 wpp_render_html_template 的 layout=freeform，自己写 html+css）",
        "- 配色、字体、装饰元素都按用户风格挑，**不要绑死本地 stylePreset 色板**",
        "- 参考已启用的「UI/UX Pro Max 设计智能」技能：50+ 风格、161 色板、字体配对、99 UX 准则随手用",
        "- 鼓励变化：封面、章节页、内容页**视觉差异要明显**，不要全部用同一个模板套",
        "- 字号映射仍按 1pt=2px (1920×1080 画布) 保持可读性",
        ""
      ].join("\n") : "";

      const systemPrompt = [
        "你是嵌入 WPS Office 的中文智能助理，可以通过工具直接读写当前打开的文档。",
        `当前宿主：${currentHostInfo.label}（${currentHostInfo.host}）。只调用与当前宿主匹配的工具。`,
        "决策原则：先用 read 类工具了解现状，再用 write/format 类工具修改。每一步告诉用户你做了什么。",
        currentHostInfo.host === "wps"
          ? "在 WPS 文字 写文本时，可以直接用 markdown（# 标题、**粗体**、- 列表、`代码`），插件会渲染为 Word 原生格式。"
          : "",
        wppPreviewFirstNote,
        htmlPreviewStateNote,
        stylePresetNote,
        pptFreeDesignNote,
        "工具失败时分析原因，必要时换实现，不要重复同一种失败调用。",
        skillsBlock,
        // 用户配置的提示词放最后，覆盖力度更强
        userSystemPrompt ? "\n--- 用户偏好（优先级高于上述默认规则）---\n" + userSystemPrompt : ""
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

      // 思考强度：模型支持深度思考时把用户选的 level 传下去（off 时不传，等同关闭）
      const thinkingLevel = isThinkingModel(model)
        ? (readThinkingLevel() === "off" ? null : readThinkingLevel())
        : null;

      await global.WpsAiOpenAI.runWithTools({
        model,
        messages,
        tools,
        signal,
        thinkingLevel,
        maxIterations: currentSettings?.maxToolIterations || 50,
        approveTool: approver || undefined,
        onEvent: async (ev) => {
          switch (ev.type) {
            case "reasoning_chunk":
              // 推理模型的"思考过程"流式输出，单独一个气泡
              hideThinking();
              // 把最近的思考尾段拼到进度文字后面，类似 Claude Code 那种"…正在推理: 最后几个字"
              setProgressStatus(`AI 正在推理: ${tailForProgress(ev.fullText)}`);
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
              // 回复阶段也带最近输出的尾段，让用户知道实时进展
              setProgressStatus(`AI 正在生成: ${tailForProgress(ev.fullText)}`);
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
              // 默认走 Claude Code 风格瞬态气泡；勾了"显示工具调用详情"才走老的折叠卡
              if (currentSettings.showToolCallLogs) {
                appendToolCallMsg(ev.name, ev.args);
              } else {
                if (_activeTransientToolBubble) clearTransientToolBubble(_activeTransientToolBubble);
                _activeTransientToolBubble = appendTransientToolBubble(ev.name);
                try { updateTransientToolBubble(_activeTransientToolBubble, JSON.stringify(ev.args)); } catch (e) {}
              }
              setProgressStatus(`AI 正在执行：${friendlyToolName(ev.name)}`);
              showThinking("正在执行工具调用");
              turnEvents.push({ type: "tool_call", name: ev.name, args: ev.args, ts: Date.now() });
              break;
            case "tool_result":
              hideThinking();
              if (currentSettings.showToolCallLogs) {
                appendToolResultMsg(ev.name, ev.result);
              } else {
                // 成功 → 移除瞬态气泡；失败 → 留一行红色摘要
                if (ev.result?.ok) {
                  clearTransientToolBubble(_activeTransientToolBubble);
                } else {
                  clearTransientToolBubble(_activeTransientToolBubble, {
                    errorSummary: (ev.result?.error || "执行失败").slice(0, 200)
                  });
                }
                _activeTransientToolBubble = null;
              }
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

  // 测试某条 chatProvider 的连通性（被 card 右侧 ⚡ 图标调用，独立于 header 选中状态）
  // 流程：临时把它设为 activeChatModel → 调 listModels → 缓存 → 提示
  // 测试完后保持选中状态（这样用户可以马上从下拉里挑这家的真实模型）
  async function testSpecificProvider(entry) {
    if (!entry) return;
    const label = entry.label || entry.id;
    if (!entry.enabled) {
      showMessage(`「${label}」未启用，先勾上「启用」再测。`, "info");
      return;
    }
    if (entry.type !== "codex" && !entry.apiKey) {
      showMessage(`「${label}」缺 API Key。`, "error");
      return;
    }
    // 让 getActiveConfig() 能拿到这条 provider
    setActiveChatModel(entry.id, entry.defaultModel || "");
    setBusy(true);
    showMessage(`正在测试供应商「${label}」...`, "info");
    try {
      const models = await global.WpsAiOpenAI.listModels();
      modelsByProvider[entry.id] = models;
      persistModelsCache();
      const picked = models.includes(entry.defaultModel) ? entry.defaultModel : (models[0] || entry.defaultModel || "");
      if (picked) setActiveChatModel(entry.id, picked);
      populateModelSelector(picked);
      const preview = models.slice(0, 5).join(" / ") + (models.length > 5 ? ` … (+${models.length - 5})` : "");
      showMessage(`供应商「${label}」连通正常，返回 ${models.length} 个模型：${preview}`, "success");
    } catch (error) {
      showMessage(`供应商「${label}」测试失败：${error.message || error}`, "error");
    } finally {
      setBusy(false);
      renderProviderState();
    }
  }

  // 老的 testChatConnection（footer 已经移除）保留兼容：测试当前激活的 chatProvider
  async function testChatConnection() {
    readSettingsFromForm();
    persistSettings();
    const activeEntry = global.WpsAiProviderRegistry?.getActiveChatProvider?.(currentSettings);
    if (!activeEntry) {
      showMessage("请先在「聊天模型」里启用至少一个供应商。", "error");
      return;
    }
    await testSpecificProvider(activeEntry);
  }

  async function testImageConnection() {
    readSettingsFromForm();
    persistSettings();

    const cfg = currentSettings.imageProvider || {};
    if (!cfg.enabled) {
      showMessage("图像生成尚未启用。请勾选「启用图像生成」。", "error");
      return;
    }

    // 根据当前渠道，挑出实际要测的 baseUrl/apiKey/model/useProxy
    const type = cfg.type || "toapis";
    const channelLabel = type === "codex-bridge" ? "Codex 桥接" : "toapis";
    const endpoint = type === "codex-bridge"
      ? { baseUrl: cfg.codexBaseUrl, apiKey: cfg.codexApiKey, model: cfg.codexModel, useProxy: cfg.codexUseProxy !== false }
      : { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, useProxy: cfg.useProxy !== false };

    if (!endpoint.baseUrl || !endpoint.apiKey) {
      showMessage(`请先填写「${channelLabel}」渠道的 Base URL 和 API Key。`, "error");
      return;
    }

    setBusy(true);
    showMessage(`正在测试图像接口（${channelLabel}）...`, "info");

    // 组装实际请求 URL（支持 useProxy）
    const PROXY_PREFIX = "http://localhost:3890/forward/";
    const base = String(endpoint.baseUrl).replace(/\/+$/, "");
    const targetBase = endpoint.useProxy === false ? base : PROXY_PREFIX + encodeURIComponent(base);

    try {
      // 优先 GET /models 探活：成本最低，几乎所有 OpenAI 兼容端点都支持
      const resp = await fetch(`${targetBase}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${endpoint.apiKey}` }
      });
      if (resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        const list = Array.isArray(payload.data) ? payload.data : [];
        const hasModel = list.some((m) => (m.id || m.name) === endpoint.model);
        if (hasModel) {
          showMessage(`图像接口连通正常（${channelLabel}），模型「${endpoint.model}」存在。`, "success");
        } else {
          showMessage(`图像接口连通正常（${channelLabel}），但模型列表里没找到「${endpoint.model}」。配置仍可保存，调用时请确认模型名拼写。`, "info", { duration: 6000 });
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

  // ----- 配置导出/导入版本管理 + 敏感字段加密 -----
  //
  // 版本规则：每次"配置字段结构发生不兼容变化"才升大版本号；只是加新字段、改默认值算
  // 向后兼容。当前版本：
  const CONFIG_VERSION = "2.0";

  // 敏感字段（导出时加密、导入时解密）。路径以 "." 分隔
  const SENSITIVE_PATHS = [
    "providers.openai.apiKey",
    "providers.anthropic.apiKey",
    "imageProvider.apiKey",
    "imageProvider.codexApiKey"
  ];

  // 简单 XOR + base64 混淆。**对抗目标：避免明文 API Key 被随手分享时泄露**。
  // 不是真正密码学：任何拿到插件源码的人都能解。可以接受，因为：
  //   - 已经在前端，谁拿到设备数据本来就能 dump localStorage
  //   - 我们只防"用户把配置导出文件直接发到群里/邮件"这种意外
  const ENC_SEED = "lingxi-ai-config-v2-seed";

  function encStr(plain) {
    if (typeof plain !== "string" || !plain) return plain;
    let out = "";
    for (let i = 0; i < plain.length; i += 1) {
      out += String.fromCharCode(plain.charCodeAt(i) ^ ENC_SEED.charCodeAt(i % ENC_SEED.length));
    }
    try {
      return "enc:v1:" + btoa(unescape(encodeURIComponent(out)));
    } catch (e) {
      return plain;
    }
  }

  function decStr(cipher) {
    if (typeof cipher !== "string" || !cipher.startsWith("enc:v1:")) return cipher;
    try {
      const raw = decodeURIComponent(escape(atob(cipher.slice("enc:v1:".length))));
      let out = "";
      for (let i = 0; i < raw.length; i += 1) {
        out += String.fromCharCode(raw.charCodeAt(i) ^ ENC_SEED.charCodeAt(i % ENC_SEED.length));
      }
      return out;
    } catch (e) {
      return cipher;
    }
  }

  function applyToSensitive(obj, transform) {
    const out = JSON.parse(JSON.stringify(obj || {}));
    SENSITIVE_PATHS.forEach((path) => {
      const parts = path.split(".");
      let p = out;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!p || typeof p !== "object") return;
        p = p[parts[i]];
      }
      if (!p || typeof p !== "object") return;
      const key = parts[parts.length - 1];
      if (p[key]) p[key] = transform(p[key]);
    });
    return out;
  }

  // "1.0" / "0.0" / "2.0" semver-ish 比较：返回 -1 / 0 / 1
  function compareConfigVersion(a, b) {
    const pa = String(a || "0.0").split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b || "0.0").split(".").map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i += 1) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  // ============================================================
  // 开发者工具：dev 模式检测 + 三个按钮的实现
  //   - 打开 JS 调试器：尝试 WPS 各家 API；失败时弹窗手把手教用户右键打开
  //   - 导出预览日志：把 __lingxiDumpLogs 的内容当 txt 下载
  //   - 清空预览日志：__lingxiClearLogs
  // ============================================================
  function detectDevMode() {
    // 1. URL 含 dev/debug 标识
    try {
      const host = window.location.hostname || "";
      const port = window.location.port || "";
      if (host === "127.0.0.1" || host === "localhost") return true;
      if (port === "3889" || port === "3890") return true; // wpsjs debug 端口
      if (/[?&]dev=1\b/i.test(window.location.search)) return true;
      if (window.location.protocol === "file:") return true; // 本地文件
    } catch (e) {}
    // 2. 用户强制开启
    if (window.__lingxiForceDevMode === true) return true;
    return false;
  }

  function setupDevToolsSection() {
    const section = els.devToolsSection;
    if (!section) return;
    const dev = detectDevMode();
    section.classList.toggle("hidden", !dev);
    if (!dev) return;
    if (els.devModeBadge) {
      const host = window.location.hostname || "";
      const port = window.location.port || "";
      els.devModeBadge.textContent = (host && port) ? `${host}:${port}` : "dev";
    }
    // 「打开 JS 调试器」按钮
    els.openJsDebuggerBtn?.addEventListener("click", tryOpenJsDebugger);
    // 「导出预览日志」：把 localStorage 里的日志当 txt 下载
    els.dumpPreviewLogsBtn?.addEventListener("click", () => {
      try {
        const text = window.__lingxiDumpLogs ? window.__lingxiDumpLogs() : "(logger not loaded)";
        if (!text) { showMessage("暂无日志可导出。", "info"); return; }
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `lingxi-preview-log-${new Date().toISOString().slice(0,19).replace(/[T:]/g,"-")}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showMessage(`已导出 ${text.length} 字符的日志。`, "success");
      } catch (e) {
        showMessage(`导出失败：${e?.message || e}`, "error");
      }
    });
    // 「清空预览日志」
    els.clearPreviewLogsBtn?.addEventListener("click", () => {
      if (!confirm("清空所有已积累的预览日志？")) return;
      try { window.__lingxiClearLogs?.(); showMessage("日志已清空。", "success"); }
      catch (e) { showMessage(`清空失败：${e?.message || e}`, "error"); }
    });
  }

  function tryOpenJsDebugger() {
    // WPS 各版本没有统一的"打开 DevTools" API。把已知能调的全试一遍；都不行就弹窗教用户。
    const app = global.WpsAiAddon?.getApplicationSync?.() || global.Application || global.wps?.Application;
    const attempts = [
      ["app.JSDebugger?.Open()", () => app?.JSDebugger?.Open?.()],
      ["app.OpenDevTools()", () => app?.OpenDevTools?.()],
      ["app.OpenWebViewDevTools()", () => app?.OpenWebViewDevTools?.()],
      ["app.Run('JSDebug')", () => app?.Run?.("JSDebug")],
      ["app.Run('JsDebugger')", () => app?.Run?.("JsDebugger")],
      ["wps.OpenDevtools()", () => global.wps?.OpenDevtools?.()],
      ["wps.openDevTools()", () => global.wps?.openDevTools?.()]
    ];
    let okBy = null;
    for (const [label, fn] of attempts) {
      try {
        const r = fn();
        if (r !== undefined) { okBy = label; break; }
      } catch (e) { /* 单次失败继续下一种 */ }
    }
    if (okBy) {
      showMessage(`已尝试打开 DevTools（${okBy}）。如果没看到面板，按下面手动方法。`, "success", { duration: 6000 });
    }
    // 不管成功与否，都把手动方法展示给用户（API 调用即使返回值非 undefined 也不保证真的打开）
    const isMac = /macintosh|mac os x/i.test(navigator.userAgent || "");
    const tip = [
      "WPS WebView 没统一的 API 打开 DevTools，常见手动方式：",
      "",
      "1. **右键 TaskPane 空白处 → 「打开 JS 调试器」**（最通用）",
      isMac ? "2. macOS: Cmd+Option+I（部分版本）" : "2. Windows: F12 或 Ctrl+Shift+I（部分版本）",
      "3. 开发模式下，wpsjs debug 启动会自动注入 DevTools 端口",
      "",
      "如果都不行，把下面命令贴到 DevTools 控制台拿日志：",
      "  __lingxiDumpLogs()      // 打印全部",
      "  __lingxiCopyLogs()      // 复制到剪贴板",
      "  __lingxiClearLogs()     // 清空"
    ].join("\n");
    try {
      // 用一个不会被自动隐藏的提示框展示这段文字
      if (els.message) {
        els.message.innerHTML = `<pre style="white-space:pre-wrap;margin:0;font-size:11px;line-height:1.5">${tip.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre>`;
        els.message.className = "message info";
        els.message.classList.remove("hidden");
        if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
        messageTimer = setTimeout(() => { els.message.classList.add("hidden"); messageTimer = null; }, 15000);
      } else {
        alert(tip);
      }
    } catch (e) { alert(tip); }
  }

  function exportSettings() {
    // 先把表单状态同步进 currentSettings（用户可能改了没保存就直接导出）
    readSettingsFromForm();
    persistSettings();

    const now = new Date();
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const safeSettings = applyToSensitive(currentSettings, encStr);
    const payload = {
      app: "lingxi-ai",
      version: CONFIG_VERSION,
      encrypted: true,
      encryptedFields: SENSITIVE_PATHS,
      exportedAt: now.toISOString(),
      settings: safeSettings
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

    showMessage(`已导出当前配置 (v${CONFIG_VERSION})。API Key 已加密。`, "info", { duration: 4500 });
  }

  function applyImportedSettings(parsed) {
    // 接受两种结构：1) 完整封装 { app, version, settings }；2) 直接是 settings 主体
    const isWrapped = parsed && typeof parsed === "object"
      && parsed.settings && typeof parsed.settings === "object";
    const incoming = isWrapped ? parsed.settings : parsed;
    // 包装内有 version 用包装的；没包装就是 "0.0"（最老的无版本号导出）
    const incomingVersion = isWrapped && typeof parsed.version !== "undefined"
      ? String(parsed.version)
      : "0.0";

    if (!incoming || typeof incoming !== "object") {
      throw new Error("文件内容不是合法的配置 JSON。");
    }

    // 版本兼容判断
    const cmp = compareConfigVersion(incomingVersion, CONFIG_VERSION);
    if (cmp > 0) {
      // 导入版本比当前插件新——结构可能有变，弹窗确认
      const proceed = confirm(
        `配置版本不兼容：\n` +
        `  导入文件版本：${incomingVersion}\n` +
        `  当前插件版本：${CONFIG_VERSION}\n\n` +
        `导入文件来自更新的插件版本，部分字段可能识别不了。继续导入？`
      );
      if (!proceed) throw new Error("已取消导入（版本不兼容）。");
    }

    // 解密：要么 wrapper 标 encrypted=true，要么字段以 enc:v1: 开头
    const wantsDecrypt = isWrapped && parsed.encrypted === true;
    const settingsToApply = wantsDecrypt
      ? applyToSensitive(incoming, decStr)
      : applyToSensitive(incoming, (s) => decStr(s));  // 即使没 wrapper 标记也试着按字段前缀解

    // 用注册表的默认值兜底，再用导入的值覆盖（防御未来字段缺失）
    const defaults = global.WpsAiProviderRegistry.DEFAULT_SETTINGS;
    const cloned = JSON.parse(JSON.stringify(defaults));

    if (typeof settingsToApply.activeProvider === "string") cloned.activeProvider = settingsToApply.activeProvider;
    if (typeof settingsToApply.operationMode === "string") cloned.operationMode = settingsToApply.operationMode;
    if (typeof settingsToApply.maxToolIterations === "number") cloned.maxToolIterations = settingsToApply.maxToolIterations;

    if (settingsToApply.providers && typeof settingsToApply.providers === "object") {
      Object.keys(cloned.providers).forEach((key) => {
        if (settingsToApply.providers[key]) {
          cloned.providers[key] = Object.assign({}, cloned.providers[key], settingsToApply.providers[key]);
        }
      });
    }
    if (settingsToApply.imageProvider && typeof settingsToApply.imageProvider === "object") {
      cloned.imageProvider = Object.assign({}, cloned.imageProvider, settingsToApply.imageProvider);
    }
    if (settingsToApply.stylePreset && typeof settingsToApply.stylePreset === "object") {
      cloned.stylePreset = Object.assign({}, cloned.stylePreset, settingsToApply.stylePreset);
    }

    currentSettings = cloned;
    persistSettings();
    applySettingsToForm();
    refreshModels({ silent: true });
    renderProviderState();

    return { incomingVersion };
  }

  function importSettings(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showMessage("读取文件失败。", "error");
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const info = applyImportedSettings(parsed);
        showMessage(`已从 ${file.name} 导入配置（来源版本 v${info.incomingVersion}）。`, "success");
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
    "paper-ink":         { darkMode: false, primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B", backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF", titleColor: "#1C1917", bodyColor: "#292524", titleFont: "宋体",            bodyFont: "宋体" },
    "8-bit-orbit":           { darkMode: true, primaryColor: "#5EDCF4", secondaryColor: "#F0A6CA", accentColor: "#F4D03F", backgroundColor: "#0A0E27", surfaceColor: "#0F1B3D", titleColor: "#FFFFFF", bodyColor: "#E2D5F2", titleFont: "Tektur", bodyFont: "Chakra Petch" },
    "biennale-yellow":       { darkMode: false, primaryColor: "#F1EE2E", secondaryColor: "#E26B4A", accentColor: "#F0DA7C", backgroundColor: "#E9E5DB", surfaceColor: "#DCD6C4", titleColor: "#1B2566", bodyColor: "#1B2566", titleFont: "Instrument Serif", bodyFont: "Archivo" },
    "block-frame":           { darkMode: false, primaryColor: "#000000", secondaryColor: "#FE90E8", accentColor: "#F7CB46", backgroundColor: "#FFFFFF", surfaceColor: "#FFFDF5", titleColor: "#000000", bodyColor: "#000000", titleFont: "Inter", bodyFont: "Space Grotesk" },
    "blue-professional":     { darkMode: false, primaryColor: "#1E2BFA", secondaryColor: "#111111", accentColor: "#1E2BFA", backgroundColor: "#FDFAE7", surfaceColor: "#FDFAE7", titleColor: "#111111", bodyColor: "#6B6B6B", titleFont: "Space Grotesk", bodyFont: "Inter" },
    "bold-poster":           { darkMode: false, primaryColor: "#D8000F", secondaryColor: "#1C1410", accentColor: "#D8000F", backgroundColor: "#FFFFFF", surfaceColor: "#F5F2EF", titleColor: "#1C1410", bodyColor: "#1C1410", titleFont: "Shrikhand", bodyFont: "Libre Baskerville" },
    "broadside":             { darkMode: true, primaryColor: "#E85D26", secondaryColor: "#F0ECE5", accentColor: "#E85D26", backgroundColor: "#111111", surfaceColor: "#1A1A18", titleColor: "#F0ECE5", bodyColor: "#888880", titleFont: "Barlow", bodyFont: "IBM Plex Mono" },
    "capsule":               { darkMode: false, primaryColor: "#E85D4E", secondaryColor: "#1E1E1E", accentColor: "#C4D94E", backgroundColor: "#F5F5F0", surfaceColor: "#FFFFFF", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Bodoni Moda", bodyFont: "Space Grotesk" },
    "cartesian":             { darkMode: false, primaryColor: "#1A1A1A", secondaryColor: "#8A8178", accentColor: "#B8B0A4", backgroundColor: "#EDE8E0", surfaceColor: "#E2DBD1", titleColor: "#1A1A1A", bodyColor: "#5A5A5A", titleFont: "Playfair Display", bodyFont: "Inter" },
    "cobalt-grid":           { darkMode: false, primaryColor: "#1F2BE0", secondaryColor: "#5560E5", accentColor: "#1F2BE0", backgroundColor: "#F0EBDE", surfaceColor: "#E6E0CE", titleColor: "#1F2BE0", bodyColor: "#1F2BE0", titleFont: "Newsreader", bodyFont: "Hanken Grotesk" },
    "coral":                 { darkMode: true, primaryColor: "#E85D5D", secondaryColor: "#F5F0E8", accentColor: "#E85D5D", backgroundColor: "#1A1A1A", surfaceColor: "#F5F0E8", titleColor: "#F5F0E8", bodyColor: "#B0B0B0", titleFont: "Bebas Neue", bodyFont: "Inter" },
    "creative-mode":         { darkMode: false, primaryColor: "#0F0F0F", secondaryColor: "#1F8A4C", accentColor: "#F06CA8", backgroundColor: "#EFE9D9", surfaceColor: "#E4DCC4", titleColor: "#0F0F0F", bodyColor: "#2A2A2A", titleFont: "Archivo Black", bodyFont: "Space Grotesk" },
    "daisy-days":            { darkMode: false, primaryColor: "#F7C8D4", secondaryColor: "#FDE68A", accentColor: "#D4A5E8", backgroundColor: "#F5F0E6", surfaceColor: "#7ECDC0", titleColor: "#3A2A1A", bodyColor: "#3A2A1A", titleFont: "Fredoka One", bodyFont: "Quicksand" },
    "editorial-forest":      { darkMode: false, primaryColor: "#2E4A2A", secondaryColor: "#E89CB1", accentColor: "#E89CB1", backgroundColor: "#EFE7D4", surfaceColor: "#E6DCC4", titleColor: "#2E4A2A", bodyColor: "#1A1A17", titleFont: "Source Serif 4", bodyFont: "Source Serif 4" },
    "editorial-tri-tone":    { darkMode: false, primaryColor: "#7A1F35", secondaryColor: "#F2B6C6", accentColor: "#F2D86A", backgroundColor: "#F2D86A", surfaceColor: "#F2B6C6", titleColor: "#7A1F35", bodyColor: "#7A1F35", titleFont: "Bricolage Grotesque", bodyFont: "Bricolage Grotesque" },
    "emerald-editorial":     { darkMode: true, primaryColor: "#3CD896", secondaryColor: "#0F1A5C", accentColor: "#F1E9D6", backgroundColor: "#3CD896", surfaceColor: "#2DC684", titleColor: "#0F1A5C", bodyColor: "#0F1A5C", titleFont: "Bodoni Moda", bodyFont: "Manrope" },
    "grove":                 { darkMode: true, primaryColor: "#C8524A", secondaryColor: "#E8E4D6", accentColor: "#C8524A", backgroundColor: "#192B1B", surfaceColor: "#1E3221", titleColor: "#E8E4D6", bodyColor: "#D4CFBF", titleFont: "Playfair Display", bodyFont: "Jost" },
    "long-table":            { darkMode: false, primaryColor: "#B53D2A", secondaryColor: "#8E2D1F", accentColor: "#B53D2A", backgroundColor: "#FAF1E2", surfaceColor: "#F2E5CF", titleColor: "#B53D2A", bodyColor: "#B53D2A", titleFont: "Bricolage Grotesque", bodyFont: "Fraunces" },
    "mat":                   { darkMode: true, primaryColor: "#C07030", secondaryColor: "#EDE6D0", accentColor: "#C07030", backgroundColor: "#232E26", surfaceColor: "#EDE6D0", titleColor: "#F0E8D2", bodyColor: "#F0E8D2", titleFont: "Bricolage Grotesque", bodyFont: "DM Sans" },
    "monochrome":            { darkMode: false, primaryColor: "#1A1A16", secondaryColor: "#5E5E54", accentColor: "#8A8A80", backgroundColor: "#FAFADF", surfaceColor: "#F2F2D2", titleColor: "#1A1A16", bodyColor: "#1A1A16", titleFont: "Lora", bodyFont: "Jost" },
    "neo-grid-bold":         { darkMode: false, primaryColor: "#0A0A0A", secondaryColor: "#8A8A85", accentColor: "#E6FF3D", backgroundColor: "#F5F4EF", surfaceColor: "#ECECE8", titleColor: "#0A0A0A", bodyColor: "#0A0A0A", titleFont: "Space Grotesk", bodyFont: "JetBrains Mono" },
    "peoples-platform":      { darkMode: false, primaryColor: "#2C2CDC", secondaryColor: "#F2A03A", accentColor: "#E83A2A", backgroundColor: "#F5F2EA", surfaceColor: "#F4E9D6", titleColor: "#2C2CDC", bodyColor: "#1A1A1A", titleFont: "Alfa Slab One", bodyFont: "DM Mono" },
    "pin-and-paper":         { darkMode: false, primaryColor: "#1F3A8A", secondaryColor: "#2D4FB8", accentColor: "#C9A66B", backgroundColor: "#EFE56A", surfaceColor: "#F8F1D6", titleColor: "#1F3A8A", bodyColor: "#1F3A8A", titleFont: "Space Grotesk", bodyFont: "DM Mono" },
    "pink-script":           { darkMode: true, primaryColor: "#ED3D8C", secondaryColor: "#FF66A8", accentColor: "#ED3D8C", backgroundColor: "#060507", surfaceColor: "#0F0D11", titleColor: "#F5EDF1", bodyColor: "#F5EDF1", titleFont: "DM Serif Display", bodyFont: "Inter" },
    "playful":               { darkMode: false, primaryColor: "#1A1A1A", secondaryColor: "#E8B88E", accentColor: "#1A1A1A", backgroundColor: "#F0C8A0", surfaceColor: "#F7DEC6", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Syne", bodyFont: "Space Grotesk" },
    "raw-grid":              { darkMode: false, primaryColor: "#0A0A0A", secondaryColor: "#F2D4CF", accentColor: "#E5EDD6", backgroundColor: "#FFFFFF", surfaceColor: "#F5F5F5", titleColor: "#0A0A0A", bodyColor: "#333333", titleFont: "Segoe UI", bodyFont: "Segoe UI" },
    "retro-windows":         { darkMode: false, primaryColor: "#000080", secondaryColor: "#808080", accentColor: "#0000A0", backgroundColor: "#C0C0C0", surfaceColor: "#D4D0C8", titleColor: "#000000", bodyColor: "#222222", titleFont: "Press Start 2P", bodyFont: "MS Sans Serif" },
    "retro-zine":            { darkMode: false, primaryColor: "#008F4D", secondaryColor: "#1A1A1A", accentColor: "#00A85D", backgroundColor: "#C8B99A", surfaceColor: "#F4EFE6", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Bebas Neue", bodyFont: "Space Grotesk" },
    "sakura-chroma":         { darkMode: false, primaryColor: "#E5392A", secondaryColor: "#E54489", accentColor: "#F09131", backgroundColor: "#F1E6CB", surfaceColor: "#E5D6B0", titleColor: "#3A2516", bodyColor: "#3A2516", titleFont: "Big Shoulders Display", bodyFont: "Albert Sans" },
    "scatterbrain":          { darkMode: false, primaryColor: "#FFE066", secondaryColor: "#FFC9C9", accentColor: "#B2F2BB", backgroundColor: "#FFE066", surfaceColor: "#A5D8FF", titleColor: "#1A1A1A", bodyColor: "#1A1A1A", titleFont: "Shrikhand", bodyFont: "Zilla Slab" },
    "signal":                { darkMode: true, primaryColor: "#1C2644", secondaryColor: "#F0ECE3", accentColor: "#C8A870", backgroundColor: "#1C2644", surfaceColor: "#F0ECE3", titleColor: "#E2DCD0", bodyColor: "#8A96A8", titleFont: "Source Serif 4", bodyFont: "DM Sans" },
    "soft-editorial":        { darkMode: false, primaryColor: "#2A241B", secondaryColor: "#E1A4C2", accentColor: "#D6DD63", backgroundColor: "#F2EEDF", surfaceColor: "#ECE6D2", titleColor: "#2A241B", bodyColor: "#5C5345", titleFont: "Cormorant Garamond", bodyFont: "Work Sans" },
    "stencil-tablet":        { darkMode: false, primaryColor: "#0A0A0A", secondaryColor: "#A06A3C", accentColor: "#C73B7A", backgroundColor: "#E2DCC9", surfaceColor: "#F4EFE0", titleColor: "#0A0A0A", bodyColor: "#0A0A0A", titleFont: "Stardos Stencil", bodyFont: "Inter" },
    "studio":                { darkMode: true, primaryColor: "#F5D200", secondaryColor: "#F0CC00", accentColor: "#F5D200", backgroundColor: "#1C1C1C", surfaceColor: "#242422", titleColor: "#F5D200", bodyColor: "#F5D200", titleFont: "Barlow", bodyFont: "Barlow" },
    "vellum":                { darkMode: true, primaryColor: "#E8D85C", secondaryColor: "#F5E168", accentColor: "#3A7878", backgroundColor: "#2A3870", surfaceColor: "#343F80", titleColor: "#E8D85C", bodyColor: "#E8D85C", titleFont: "Cormorant Garamond", bodyFont: "DM Sans" },
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
    updateSchemePreview(els.styleScheme.value);
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
    updateSchemePreview("custom");
  }

  // 主题预览卡：根据选中 scheme 渲染色块 + 签名视觉元素 + 推荐版式。
  // 数据从 global.WpsAiProviderRegistry.COLOR_SCHEMES 取（含 signatureElement / layoutHints），
  // 不依赖本文件局部的 COLOR_SCHEMES 镜像（镜像仅包含 colors/fonts）。
  function updateSchemePreview(name) {
    const card = els.styleSchemePreview;
    if (!card) return;
    if (!name || name === "custom") {
      card.classList.add("hidden");
      return;
    }
    const fullSchemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const s = fullSchemes[name];
    if (!s) {
      card.classList.add("hidden");
      return;
    }
    if (els.styleSchemePreviewLabel) els.styleSchemePreviewLabel.textContent = s.label || name;
    if (els.styleSchemePreviewDesc) els.styleSchemePreviewDesc.textContent = s.description || "";
    if (els.styleSchemePreviewSignature) els.styleSchemePreviewSignature.textContent = s.signatureElement || "（无）";
    if (els.styleSchemePreviewHints) els.styleSchemePreviewHints.textContent = s.layoutHints || "（无）";
    const swatchHost = els.styleSchemePreviewSwatches;
    if (swatchHost) {
      const swatches = [
        ["主色 primary", s.primaryColor],
        ["次色 secondary", s.secondaryColor],
        ["强调 accent", s.accentColor],
        ["底色 background", s.backgroundColor],
        ["卡片 surface", s.surfaceColor]
      ];
      swatchHost.innerHTML = "";
      for (const [title, color] of swatches) {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = color || "transparent";
        sw.title = `${title}: ${color || "—"}`;
        swatchHost.appendChild(sw);
      }
    }
    card.classList.remove("hidden");
  }

  function closeStylePresetModal() {
    els.stylePresetModal.classList.add("hidden");
  }

  function saveStylePreset(opts) {
    if (!els.styleEnabled) return; // 表单未挂载（独立窗口 init 失败）
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
    if (opts?.silent) return; // X-close 时静默保存，不弹 toast / 不关 modal
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

    div.addEventListener("click", () => openHistoryDetailModal(entry));

    return div;
  }

  function openHistoryDetailModal(entry) {
    if (!els.historyDetailModal || !els.historyDetailBody) return;
    const hasSnapshots = entry.before || entry.after;
    if (els.historyDetailTitle) {
      const status = entry.ok ? "✓" : "!";
      els.historyDetailTitle.textContent = `${status} ${entry.friendlyName || entry.toolName}`;
    }
    els.historyDetailBody.innerHTML = `
      <div class="detail-section">
        <div class="detail-meta">
          <span class="detail-meta-row"><span class="detail-label">时间</span><span>${fmtTime(entry.ts)}</span></span>
          <span class="detail-meta-row"><span class="detail-label">目标</span><span>${escapeHtml(entry.target ? entry.target.kind + " · " + entry.target.label : "—")}</span></span>
          <span class="detail-meta-row"><span class="detail-label">结果</span><span>${escapeHtml(entry.resultSummary || "")}</span></span>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-label">工具 / 入参</div>
        <pre class="detail-pre">${escapeHtml(entry.toolName)}\n${escapeHtml(JSON.stringify(entry.params || {}, null, 2))}</pre>
      </div>
      ${hasSnapshots ? `
        <div class="detail-section">
          <div class="detail-label">改动前 / 改动后</div>
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
        </div>
      ` : ""}
      ${entry.error ? `
        <div class="detail-section">
          <div class="detail-label">错误</div>
          <pre class="detail-pre error">${escapeHtml(entry.error)}</pre>
        </div>
      ` : ""}
    `;
    els.historyDetailModal.classList.remove("hidden");
    // scroll body 顶
    els.historyDetailBody.scrollTop = 0;
  }

  function closeHistoryDetailModal() {
    if (!els.historyDetailModal) return;
    els.historyDetailModal.classList.add("hidden");
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
    const iconBox = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
    const iconChat = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    const iconRestore = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
    const backupStatus = backupOk
      ? `<span class="history-turn-backup ok" title="${escapeHtml(turn.backup.backupPath)}">${iconBox} 已备份 (${formatSize(turn.backup.size)})</span>`
      : backupErr
        ? `<span class="history-turn-backup err" title="${escapeHtml(backupErr)}">未备份（出错）</span>`
        : `<span class="history-turn-backup muted">未备份</span>`;
    head.innerHTML = `
      <div class="history-turn-meta">
        <span class="history-turn-icon">${iconChat}</span>
        <span class="history-turn-prompt">${promptText}</span>
        <span class="history-turn-time">${startedAt}</span>
      </div>
      <div class="history-turn-actions">
        ${backupStatus}
        ${backupOk ? `<button type="button" class="ghost-btn history-restore-btn">${iconRestore} 恢复本轮</button>` : ""}
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

          // 判断"是不是最新有备份的 turn":只有最新 turn 才走 UndoRecord 路径
          // (Application.Undo 一次只能撤回最近一组),老 turn 仍走文件层。
          let isLatestBackedUpTurn = false;
          try {
            const allTurns = global.WpsAiHistory?.listTurns?.() || {};
            const backedUp = Object.values(allTurns)
              .filter((t) => t.backup && t.backup.backupPath)
              .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
            isLatestBackedUpTurn = backedUp[0]?.id === turn.id;
          } catch (e) {}

          const tryUndo = isLatestBackedUpTurn && !!turn.backup.undoGroup;
          const res = await backup.restoreFromBackup(turn.backup.backupPath, turn.backup.docPath, { tryUndo });
          if (res?.ok) {
            const via = res.method === "undo" ? "(免关文档)" : "";
            showMessage(`已恢复到 ${fmtTime(turn.backup.ts)} 的状态 ${via}。${res.warning || ""}`, "success");
            // 把本轮所有 entry 标记为已撤回
            global.WpsAiHistory?.deleteTurn?.(turn.id);
          } else {
            showMessage(`恢复失败：${res?.error || "未知错误"}`, "error");
            btn.disabled = false; btn.innerHTML = `${iconRestore} 恢复本轮`;
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

    // 当前文档路径（用作过滤 key）
    const currentDocPath = global.WpsAiBackup?.getCurrentDocPath?.() || null;
    const filtered = currentDocPath ? history.listEntries({ docPath: currentDocPath }) : [];
    const allEntries = history.listEntries();
    const turns = history.listTurns?.() || {};

    // badge 用全局总数（更直观地表达"AI 历史上一共做了多少改动"）
    const totalN = allEntries.length;
    const shownN = filtered.length;

    if (els.historyCount) {
      els.historyCount.textContent = currentDocPath
        ? (totalN === shownN ? `共 ${shownN} 条` : `当前文档 ${shownN} 条 / 全部 ${totalN} 条`)
        : `共 ${totalN} 条`;
    }
    if (els.historyBadge) {
      const showCount = currentDocPath ? shownN : totalN;
      els.historyBadge.textContent = showCount > 99 ? "99+" : String(showCount);
      els.historyBadge.classList.toggle("hidden", showCount === 0);
    }
    // 顶部文件信息条：当前文档已保存才显示
    if (els.historyDocBar && els.historyDocName) {
      if (currentDocPath) {
        const fname = currentDocPath.split(/[/\\]/).pop();
        els.historyDocName.textContent = fname;
        els.historyDocName.title = currentDocPath;
        els.historyDocBar.classList.remove("hidden");
      } else {
        els.historyDocBar.classList.add("hidden");
      }
    }

    if (els.historyEmpty) {
      els.historyEmpty.classList.toggle("hidden", shownN > 0);
      // 空态文案根据是否有当前文档变
      if (!currentDocPath) {
        els.historyEmpty.innerHTML = `
          <p><strong>当前文档尚未保存到磁盘</strong></p>
          <p class="muted">改动记录会按文件路径分组保存。请先按 Ctrl-S / Cmd-S 把文档存到磁盘后，AI 的操作就会关联到这个具体文件。</p>
        `;
      } else if (shownN === 0) {
        const fname = currentDocPath.split(/[/\\]/).pop();
        els.historyEmpty.innerHTML = `
          <p>当前文件还没有 AI 改动记录</p>
          <p class="muted">文件: ${escapeHtml(fname)}</p>
          ${totalN > 0 ? `<p class="muted">（其他文件累计有 ${totalN} 条历史记录）</p>` : ""}
        `;
      } else {
        // 默认文案，shownN>0 不显示
        els.historyEmpty.innerHTML = "<p>暂无改动记录。让 AI 帮你做点什么,这里就会显示。</p>";
      }
    }

    els.historyList.innerHTML = "";
    if (!currentDocPath || shownN === 0) return;

    const entries = filtered;

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
    // 改动记录详情 modal 关闭逻辑：X 按钮 + 点遮罩 + ESC
    if (els.historyDetailCloseBtn) {
      els.historyDetailCloseBtn.addEventListener("click", closeHistoryDetailModal);
    }
    if (els.historyDetailModal) {
      els.historyDetailModal.addEventListener("click", (ev) => {
        if (ev.target === els.historyDetailModal) closeHistoryDetailModal();
      });
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && els.historyDetailModal && !els.historyDetailModal.classList.contains("hidden")) {
        closeHistoryDetailModal();
      }
    });
    renderHistory();
  }

  // ---------------- 纯净模式（隐藏工具调用 / reasoning，只看 AI 对话）----------------

  const PURE_MODE_KEY = "lingxi_pure_mode";

  const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  function applyPureMode(on) {
    document.body.classList.toggle("pure-mode", !!on);
    if (els.pureModeToggle) {
      els.pureModeToggle.classList.toggle("active", !!on);
      const icon = els.pureModeToggle.querySelector(".pure-icon");
      if (icon) {
        icon.dataset.mode = on ? "on" : "off";
        icon.innerHTML = on ? EYE_OFF_SVG : EYE_OPEN_SVG;
      }
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
        if (ev.attachments && ev.attachments.length) appendUserAttachmentsPreview(ev.attachments);
        break;
      case "reasoning": {
        // 推理用一个折叠的灰色气泡，标记"推理回放"
        const wrap = document.createElement("div");
        wrap.className = "chat-msg reasoning collapsible";
        wrap.innerHTML = `
          <div class="chat-msg-header">
            <span class="chat-msg-label">
              <svg class="inline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 18h6"/>
                <path d="M10 22h4"/>
                <path d="M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z"/>
              </svg>
              推理
            </span>
          </div>
          <div class="reasoning-body">${(global.WpsAiMarkdown?.escapeHtml?.(ev.text) || "").replace(/\n/g, "<br/>")}</div>
        `;
        els.chatStream.appendChild(wrap);
        break;
      }
      case "tool_call":
        // 默认隐藏；勾了"显示工具调用详情"再回放折叠卡
        if (currentSettings.showToolCallLogs) appendToolCallMsg(ev.name, ev.args);
        break;
      case "tool_result":
        if (currentSettings.showToolCallLogs) {
          appendToolResultMsg(ev.name, ev.result || { ok: false, error: "结果丢失" });
        } else {
          // 仅失败保留一条简短错误条；成功不留痕
          const r = ev.result || { ok: false, error: "结果丢失" };
          if (!r.ok) {
            const bubble = appendTransientToolBubble(ev.name);
            clearTransientToolBubble(bubble, { errorSummary: (r.error || "执行失败").slice(0, 200) });
          }
        }
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
    if (els.systemPromptResetBtn) {
      els.systemPromptResetBtn.addEventListener("click", () => {
        const def = global.WpsAiProviderRegistry?.DEFAULT_SYSTEM_PROMPT || "";
        if (!def) return;
        if (els.systemPromptInput.value.trim() && !confirm("覆盖当前提示词为默认？")) return;
        els.systemPromptInput.value = def;
        showMessage("已恢复为默认系统提示词，记得点保存。", "info");
      });
    }
    els.testChatConnBtn.addEventListener("click", testChatConnection);
    els.testImageConnBtn.addEventListener("click", testImageConnection);
    if (els.imageType) {
      els.imageType.addEventListener("change", refreshImageChannelVisibility);
    }
    els.refreshModelsBtn.addEventListener("click", refreshModels);

    els.exportSettingsBtn.addEventListener("click", exportSettings);
    els.importSettingsBtn.addEventListener("click", () => els.importSettingsFile.click());
    els.importSettingsFile.addEventListener("change", (ev) => {
      const file = ev.target.files?.[0];
      if (file) importSettings(file);
      ev.target.value = ""; // 允许同名文件重选
    });

    // 开发者工具区：只在 dev 模式可见。dev 模式 = URL 是 127.0.0.1 / localhost / wpsjs debug 端口（3889）
    setupDevToolsSection();

    // 设置入口走 Tab Bar 上的「设置」tab，header 不再单独放 ⚙ 按钮

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

    // WPS 焦点接管 —— 修复「右侧输入框和左侧幻灯片同时有光标，粘贴只进幻灯片」。
    // 症状根因：WPS 主程序的活动文档（Word/PPT/Excel）持续持有 OS 级键盘焦点，
    // WebView 里的 JS focus() 只设置了逻辑焦点；用户敲 Ctrl+V/A 实际仍被 WPS 主窗口截获。
    // 修法：每次 chatInput 获得焦点时，调 app.CommandBars.ReleaseFocus() 让 WPS 主动让出。
    // 失败一律静默——老版本 WPS 没有这个 API 时退到原行为。
    els.chatInput.addEventListener("focus", () => {
      try {
        const app = global.WpsAiAddon?.getApplicationSync?.()
          || global.Application
          || null;
        app?.CommandBars?.ReleaseFocus?.();
      } catch (e) { /* silent */ }
    });
    // 「清空」按钮已移除，开新对话走顶部「+ 新对话」入口

    els.suggestedActionsClear.addEventListener("click", hideSuggestedActions);

    // 风格 modal
    els.stylePresetCloseBtn.addEventListener("click", closeStylePresetModal);
    els.styleSaveBtn.addEventListener("click", saveStylePreset);
    // 选了内置色板 → 自动填颜色
    els.styleScheme.addEventListener("change", () => {
      const v = els.styleScheme.value;
      if (v && v !== "custom") applyColorScheme(v);
      updateSchemePreview(v);
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
    els.outlineGenerateBtn.addEventListener("click", generateFromOutline);
    els.outlineExtractBtn.addEventListener("click", extractOutlineFromActivePpt);
    els.outlineClearBtn.addEventListener("click", () => { els.outlineText.value = ""; });

    // 统一风格 modal
    els.unifyCloseBtn.addEventListener("click", closeUnifyModal);
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
  // 但浮动模式下我们必须放手：WPS 浮动 CTP 的窗口大小由用户拖边框控制，
  // 这时还硬钉 body.width 会让内容卡死在脱离瞬间的宽度，看上去就是"无法调整大小"。
  function syncPaneWidth(reason) {
    const isFloating = global.WpsAiAddon?.getTaskPaneDockPosition?.() === 4;
    if (isFloating) {
      // 清掉之前的内联强制宽度，让 body { position:absolute; left:0; right:0 } 自然铺满
      document.documentElement.style.width = "";
      if (document.body) document.body.style.width = "";
      return;
    }
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

    if (!isSettingsDialog && !isPreviewDialog) startPaneWidthSync();

    bindElements();
    loadSettings();
    applySettingsToForm();

    // 修 #13: 监听同源其他窗口的 cache 清空广播。
    // 主 TaskPane 清空 → dialog 收到 storage 事件 → 把当前 htmlPreviewState.id 置 null（变新建模式），
    // 否则 dialog 上 Save 会去 cache.update(已删除id) 返回 null 再 fallback save，但 chat 日志 key 还指向旧 id。
    window.addEventListener("storage", (ev) => {
      if (ev.key !== "lingxi_html_cache_cleared_at") return;
      if (typeof htmlPreviewState === "undefined" || !htmlPreviewState) return;
      if (!htmlPreviewState.id) return;
      htmlPreviewState.id = null;
      try {
        if (typeof appendPreviewChatMsg === "function") {
          appendPreviewChatMsg("ai-info", "「我的历史」已被清空。当前预览已切换到新建模式，下次保存会作为新条目入库。");
        }
        if (typeof updateHtmlPreviewHistoryBadge === "function") updateHtmlPreviewHistoryBadge();
      } catch (e) {}
    });

    // 监听 dialog 派过来的「待执行插入」任务。两种 key 都听，兼容新旧 dialog 代码：
    //   - PENDING_INSERT_KEY: 最新写法 (commit ba6e7e2+)，dialog 显式写过来
    //   - RESULT_KEY: 老的 dialogOnConfirm 写法，dialog 把 result blob 写过来
    // 不论哪种 key，只要 templateName/layout 在 blob 里 + 不是 cancelled，MAIN 就调 renderAndInsertSlide。
    //
    // 关键点: 这个监听器跑在 MAIN TaskPane 上下文里，不在 ShowDialog 子窗口里，
    // jsapi 拿到的 ActivePresentation / ActiveWindow 都是用户面前真正那个窗口，AddPicture 落到正确的 slide。
    const _pendingInsertHandlerKeys = new Set([
      PREVIEW_DIALOG_PENDING_INSERT_KEY,
      PREVIEW_DIALOG_RESULT_KEY
    ]);
    plog("init", "MAIN registered pending-insert storage listener (keys=" + Array.from(_pendingInsertHandlerKeys).join(",") + ")");
    window.addEventListener("storage", async (ev) => {
      if (!_pendingInsertHandlerKeys.has(ev.key)) return;
      if (!ev.newValue) return;
      // 只让 MAIN 接，DIALOG/SETTINGS/STYLEPRESET 子窗口忽略（jsapi 在子窗口里不可靠）
      if (isPreviewDialog || isSettingsDialog || isStylePresetDialog) return;
      let blob;
      try { blob = JSON.parse(ev.newValue); }
      catch (e) { pwarn("pendingInsert", "JSON parse failed:", e?.message); return; }
      // RESULT_KEY 形态下可能是 {cancelled: true}, 跳过
      if (blob?.cancelled) { plog("pendingInsert", "blob.cancelled=true，跳过"); return; }
      if (!blob?.templateName || !blob?.layout) {
        plog("pendingInsert", "blob 缺 templateName/layout，跳过", { key: ev.key, keys: Object.keys(blob || {}) });
        return;
      }
      plog("pendingInsert", "received from dialog via " + ev.key, {
        templateName: blob.templateName,
        layout: blob.layout,
        intent: blob.intent,
        slideHint: blob.slideHint,
        activeSlideIndex: blob.activeSlideIndex
      });
      try { localStorage.removeItem(ev.key); } catch (e) {}
      const renderAndInsert = global.WpsAiRenderAndInsertSlide;
      if (typeof renderAndInsert !== "function") {
        pwarn("pendingInsert", "WpsAiRenderAndInsertSlide 未注册");
        showMessage("插入失败：插件未完整初始化", "error");
        return;
      }
      const params = {
        templateName: blob.templateName,
        layout: blob.layout,
        data: blob.data || {},
        palette: blob.palette || {},
        intent: blob.intent || "insert"
      };
      if (blob.intent === "replace" && typeof blob.slideHint === "number" && blob.slideHint > 0) {
        params.slide = blob.slideHint;
      } else if (blob.intent === "replace-active" && typeof blob.activeSlideIndex === "number" && blob.activeSlideIndex > 0) {
        params.slide = blob.activeSlideIndex;
        params.intent = "replace";
      }
      plog("pendingInsert", "calling renderAndInsert in MAIN", params);
      try {
        const r = await renderAndInsert(params);
        plog("pendingInsert", "renderAndInsert OK", { slide: r?.slide, layerCount: r?.layerCount });
        const intentLabel = blob.intent === "insert" ? "插入到末尾" : `替换第 ${r?.slide} 页`;
        showMessage(`已${intentLabel}`, "success");
      } catch (e) {
        pwarn("pendingInsert", "renderAndInsert THREW", e?.message || String(e));
        showMessage(`插入失败：${e?.message || e}`, "error");
      }
    });

    // ===== 预览独立窗口模式 =====
    // 跳过主 TaskPane 的所有初始化（chat、host 探测、ribbon），只走预览相关的 init
    if (isPreviewDialog) {
      plog("dialogInit", "preview-dialog window booted, calling bindHtmlPreviewModal");
      bindHtmlPreviewModal();
      // 读 parent 写来的 request → 调 openHtmlPreviewInline 渲染
      let req = null;
      let rawReq = null;
      try {
        rawReq = localStorage.getItem(PREVIEW_DIALOG_REQUEST_KEY);
        if (rawReq) req = JSON.parse(rawReq);
      } catch (e) { pwarn("dialogInit", "JSON parse request FAILED:", e?.message); }
      plog("dialogInit", "request read:",
        req
          ? { templateName: req.templateName, layout: req.layout, hasData: !!req.data, dataKeys: Object.keys(req.data || {}), hasPalette: !!req.palette }
          : `NULL (rawReq=${rawReq ? "non-empty" : "empty"})`
      );
      // dialog 内的 onConfirm：把结果写回 localStorage 然后关窗。
      // 修 #12: dialogOnConfirm 只在用户点按钮时触发；用户点 dialog 标题栏 X 关闭时
      // 不会触发。监听 beforeunload 兜底写一次 cancelled 状态。
      let _resultWritten = false;
      const dialogOnConfirm = (final) => {
        plog("dialogOnConfirm", "called with", final ? "data" : "null");
        const st = htmlPreviewState;
        const result = final
          ? {
              cancelled: false,
              // standalone 路径（没有 tool onConfirm）让 MAIN TaskPane 在 dialog 关掉后自己调
              // renderAndInsertSlide —— 之前在 DIALOG 里直接调 WPS API 会卡在 modal 状态导致
              // AddPicture 静默失败 / slide 看不到图。
              templateName: final.templateName || st?.templateName || null,
              layout: final.layout || st?.layout || null,
              data: final.data || {},
              palette: final.palette || {},
              intent: final.intent || "insert",
              slideHint: typeof st?.slideHint === "number" ? st.slideHint : null,
              activeSlideIndex: typeof final.activeSlideIndex === "number" ? final.activeSlideIndex : null
            }
          : { cancelled: true };
        try { localStorage.setItem(PREVIEW_DIALOG_RESULT_KEY, JSON.stringify(result)); _resultWritten = true; } catch (e) {}
        try { if (typeof window.close === "function") window.close(); } catch (e) {}
      };
      // 暴露给 doConfirm 用：dialog 的 standalone 路径（没有 tool onConfirm）也走这条路
      // 写 RESULT key + close 窗口，由 MAIN 接收 result 后实际调 renderAndInsertSlide
      window.__lingxiDialogConfirm = dialogOnConfirm;
      // 兜底：用户点 X 关 dialog → beforeunload 触发；如果还没写过 result，写 cancelled
      window.addEventListener("beforeunload", () => {
        if (_resultWritten) return;
        try {
          localStorage.setItem(PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({ cancelled: true, viaWindowClose: true }));
        } catch (e) {}
      });
      // 启动渲染
      openHtmlPreviewInline({
        templateName: req?.templateName,
        layout: req?.layout,
        data: req?.data || {},
        palette: req?.palette || {},
        slideHint: req?.slideHint || null,
        // 主 TaskPane 在 ShowDialog 之前抓住的当前选中页号，跟着 IPC 传进来
        activeSlideIndex: typeof req?.activeSlideIndex === "number" ? req.activeSlideIndex : null,
        historyMode: !!req?.historyMode,
        galleryMode: !!req?.galleryMode,
        onConfirm: dialogOnConfirm
      });
      // 关闭按钮 / cancel 按钮 → 也走 dialogOnConfirm(null)
      // closeHtmlPreviewModal 内部已经会 onConfirm(null)，所以走原路即可
      return;  // 跳过下面所有主 TaskPane 初始化
    }

    // 独立设置窗口：只跑设置相关的 init，跳过 TaskPane 的 chat / host / ribbon 等
    if (isSettingsDialog) {
      bindCollapsibleCards();
      loadVersionInfo();
      // sidebar tab 切换 / 预设选单 / 新增 / 关闭
      els.openSettingsModalBtn?.addEventListener("click", () => openSettingsModal("chat"));
      els.settingsModalCloseBtn?.addEventListener("click", () => closeSettingsDialogWindow());
      document.querySelectorAll("[data-close-modal]").forEach((node) => {
        node.addEventListener("click", () => closeSettingsDialogWindow());
      });
      document.querySelectorAll(".settings-sidebar-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchSettingsPanel(btn.dataset.settingsPanel));
      });
      els.addChatProviderBtn?.addEventListener("click", openPresetPicker);
      document.querySelectorAll("[data-close-preset-picker]").forEach((node) => {
        node.addEventListener("click", () => closePresetPicker());
      });
      els.saveSettingsBtn?.addEventListener("click", () => {
        readSettingsFromForm();
        persistSettings();
        showMessage("设置已保存。", "success");
        setTimeout(closeSettingsDialogWindow, 300);
      });
      // 导出 / 导入配置（程序信息 panel 的两个按钮）—— 之前只在主 TaskPane bindEvents 里绑，
      // 而设置实际只通过 dialog 模式打开，所以这里也得绑一份。
      els.exportSettingsBtn?.addEventListener("click", exportSettings);
      els.importSettingsBtn?.addEventListener("click", () => els.importSettingsFile?.click());
      els.importSettingsFile?.addEventListener("change", (ev) => {
        const file = ev.target.files?.[0];
        if (file) importSettings(file);
        ev.target.value = "";
      });
      // 技能导入按钮
      els.skillImportBtn?.addEventListener("click", () => els.skillImportFile?.click());
      els.skillImportFile?.addEventListener("change", (ev) => {
        const file = ev.target.files?.[0];
        if (file) handleSkillImport(file);
        ev.target.value = "";
      });
      // MCP 服务开关：复用现有 setting 持久化 + 同步切 mcp-bridge 的 start/stop
      els.mcpServerEnabledInput?.addEventListener("change", () => {
        const on = !!els.mcpServerEnabledInput.checked;
        currentSettings.mcpServerEnabled = on;
        try { persistSettings(); } catch (e) {}
        try {
          if (on) global.WpsAiMcpBridge?.start?.();
          else global.WpsAiMcpBridge?.stop?.();
        } catch (e) {}
      });
      // 热更新 UI 绑定 + 初次渲染最近一次检查结果
      els.updateCheckNowBtn?.addEventListener("click", manuallyCheckForUpdate);
      els.updateDownloadBtn?.addEventListener("click", downloadAndApplyUpdate);
      els.updateAutoCheckInput?.addEventListener("change", () => {
        currentSettings.updateAutoCheck = !!els.updateAutoCheckInput.checked;
        try { persistSettings(); } catch (e) {}
      });
      try {
        const cached = global.WpsAiUpdater?.getLastCheck?.();
        if (cached?.result) renderUpdateUi(cached.result);
      } catch (e) {}

      // 复制配置 JSON
      els.mcpCopyConfigBtn?.addEventListener("click", async () => {
        const text = els.mcpConfigSnippet?.value || "";
        const ok = await copyToClipboard(text);
        if (ok) showMessage("配置已复制到剪贴板", "success");
        else showMessage("复制失败，请手动选中文本", "error");
      });
      // 开发者工具区：dev 模式才显示。setupDevToolsSection 内部会判 detectDevMode()
      setupDevToolsSection();
      // 在独立窗口里"打开"就是直接渲染 settings panel + 让 modal 可见
      // （HTML 标签默认带 .hidden，正常模式下由 openSettingsModal 去除；dialog 模式要手动去）
      els.settingsModal?.classList.remove("hidden");
      renderChatProvidersList();
      switchSettingsPanel("chat");
      // X 关闭兜底：用户点 WPS 窗口 × 时，把最后未保存的表单写入 localStorage
      window.addEventListener("beforeunload", () => {
        try { readSettingsFromForm(); persistSettings(); } catch (e) {}
      });
      return; // 不跑下面的 TaskPane 初始化逻辑
    }

    // 独立 PPT 风格预设窗口：只跑 stylePreset 相关的 init
    if (isStylePresetDialog) {
      // 风格 modal 的所有事件绑定（跟主 TaskPane bindEvents 里的同一块）
      els.stylePresetCloseBtn?.addEventListener("click", closeStylePresetDialogWindow);
      els.styleSaveBtn?.addEventListener("click", () => {
        saveStylePreset();
        setTimeout(closeStylePresetDialogWindow, 200);
      });
      els.styleScheme?.addEventListener("change", () => {
        const v = els.styleScheme.value;
        if (v && v !== "custom") applyColorScheme(v);
        updateSchemePreview(v);
      });
      [
        "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor",
        "styleBackgroundColor", "styleSurfaceColor",
        "styleTitleColor", "styleBodyColor"
      ].forEach((id) => {
        els[id]?.addEventListener("input", markCustomScheme);
      });
      // 直接渲染 + 显示
      openStylePresetModal();
      // X 关闭兜底：用户点 WPS 窗口 × 时静默保存当前表单
      window.addEventListener("beforeunload", () => {
        try { saveStylePreset({ silent: true }); } catch (e) {}
      });
      return; // 不跑下面的 TaskPane 初始化逻辑
    }

    bindTabs();
    bindEvents();
    bindHistory();
    bindPureMode();
    bindConversations();
    bindAttachments();

    renderProviderState();
    // 启动时先按 chatProviders + defaultModel 把下拉填上（即时可见），
    // 再异步从当前 provider 拉真实模型列表，刷新缓存
    populateModelSelector(els.modelSelect?.value);
    refreshModels({ silent: true });

    // 持久化的 MCP 开关：若用户曾开过就自动起来（只在主 TaskPane，不在 settings/preview dialog）
    try {
      if (currentSettings?.mcpServerEnabled) global.WpsAiMcpBridge?.start?.();
    } catch (e) {}

    // 启动时静默检查更新（仅当用户开了「启动时自动检查更新」）
    try { startupAutoCheckUpdate(); } catch (e) {}

    // ⚙ 点击：打开独立的 WPS Dialog 窗口（脱离 TaskPane 宽度限制）
    els.openSettingsModalBtn?.addEventListener("click", () => openSettingsAsDialog());
    els.settingsModalCloseBtn?.addEventListener("click", () => closeSettingsModal());

    // 停靠/浮动 切换按钮
    els.dockToggleBtn?.addEventListener("click", () => {
      const nowFloating = global.WpsAiAddon?.toggleTaskPaneDock?.();
      if (nowFloating == null) {
        showMessage("当前 WPS 版本不支持改 TaskPane 停靠方式。", "error");
        return;
      }
      // 浮动模式：清掉 syncPaneWidth 强制设的内联固定宽度，让 body 用 CSS 100% 跟随
      // 窗口缩放（不然 WPS 改了 pane 尺寸我们也不重排，看上去就是"无法调整大小"）
      if (nowFloating) {
        document.documentElement.style.width = "";
        if (document.body) document.body.style.width = "";
      } else {
        // 切回停靠：立刻按 innerWidth 重新对齐 Mac WPS 的固定宽度模式
        syncPaneWidth("re-dock");
      }
      refreshDockToggleUI();
      showMessage(nowFloating ? "已切到浮动窗口。拖窗口边框调大小，再点一次回到右侧停靠。" : "已停靠到右侧。", "info");
    });
    refreshDockToggleUI();
    bindFloatingResizeHandles();
    document.querySelectorAll("[data-close-modal]").forEach((node) => {
      node.addEventListener("click", () => closeSettingsModal());
    });
    document.querySelectorAll(".settings-sidebar-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchSettingsPanel(btn.dataset.settingsPanel));
    });
    els.addChatProviderBtn?.addEventListener("click", openPresetPicker);
    document.querySelectorAll("[data-close-preset-picker]").forEach((node) => {
      node.addEventListener("click", () => closePresetPicker());
    });
    // Esc 关闭
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!els.presetPickerModal?.classList.contains("hidden")) { closePresetPicker(); return; }
      if (!els.settingsModal?.classList.contains("hidden")) closeSettingsModal();
    });

    if (!global.wps?.WpsApplication) {
      global.WpsAiAddon?.getAddonApi?.().catch((error) => {
        showMessage(`插件 SDK 初始化失败：${error.message || String(error)}`, "error");
      });
    }

    detectHost();

    // 监听 ribbon 快捷指令（通过 Application.PluginStorage 投递）
    startPendingActionWatcher();
    // 整套 PPT 生成进度（修 #6）
    startFullDeckProgressWatcher();

    // 加载版本号 + 绑定可折叠卡片
    loadVersionInfo();
    bindCollapsibleCards();

    // 启动能力 chip + 「附加当前 PDF」按钮的初始状态；每 1.5s 复查活动文档变化
    updateCapabilityBadges();
    setInterval(updateAttachActiveBtn, 1500);
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

  // ============ 热更新 UI ============
  let _latestManifest = null; // 最近一次 checkForUpdate 返回的 manifest，下载用

  function renderUpdateUi(result, opts) {
    // result = { current, latest, updateAvailable, manifest, checkedAt } | null
    if (!els.updateStatusBadge) return;
    if (!result) {
      els.updateStatusBadge.textContent = "未检查";
      els.updateStatusBadge.className = "badge badge-muted";
      if (els.updateLastCheckedAt) els.updateLastCheckedAt.textContent = "—";
      if (els.updateLatestVersion) els.updateLatestVersion.textContent = "—";
      if (els.updateChangelog) els.updateChangelog.style.display = "none";
      if (els.updateDownloadBtn) els.updateDownloadBtn.style.display = "none";
      return;
    }
    if (els.updateLastCheckedAt) {
      const d = new Date(result.checkedAt);
      els.updateLastCheckedAt.textContent = d.toLocaleString();
    }
    if (els.updateLatestVersion) els.updateLatestVersion.textContent = "v" + (result.latest || "—");
    if (result.updateAvailable) {
      els.updateStatusBadge.textContent = "有新版本";
      els.updateStatusBadge.className = "badge badge-warning";
      _latestManifest = result.manifest;
      if (els.updateChangelog && result.manifest?.changelog) {
        els.updateChangelog.textContent = result.manifest.changelog;
        els.updateChangelog.style.display = "block";
      } else if (els.updateChangelog) {
        els.updateChangelog.style.display = "none";
      }
      if (els.updateDownloadBtn) els.updateDownloadBtn.style.display = "";
    } else {
      els.updateStatusBadge.textContent = "已是最新";
      els.updateStatusBadge.className = "badge badge-success";
      _latestManifest = null;
      if (els.updateChangelog) els.updateChangelog.style.display = "none";
      if (els.updateDownloadBtn) els.updateDownloadBtn.style.display = "none";
    }
  }

  async function manuallyCheckForUpdate() {
    if (!global.WpsAiUpdater) {
      showMessage("热更新模块未加载", "error");
      return;
    }
    if (els.updateCheckNowBtn) els.updateCheckNowBtn.disabled = true;
    try {
      const result = await global.WpsAiUpdater.checkForUpdate({ force: true });
      renderUpdateUi(result);
      if (result.updateAvailable) {
        showMessage(`发现新版本 v${result.latest}（当前 v${result.current}）`, "success");
      } else {
        showMessage(`已是最新（v${result.current}）`, "info");
      }
    } catch (e) {
      showMessage(`检查更新失败：${e?.message || e}`, "error");
    } finally {
      if (els.updateCheckNowBtn) els.updateCheckNowBtn.disabled = false;
    }
  }

  async function downloadAndApplyUpdate() {
    if (!_latestManifest) {
      showMessage("没有可下载的更新（先点检查更新）", "info");
      return;
    }
    if (!confirm(`即将下载并安装 v${_latestManifest.version}。\n\n安装会覆盖当前插件文件，完成后需要重启 WPS 让新版本生效。继续吗？`)) return;
    const btn = els.updateDownloadBtn;
    if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
    try {
      const r = await global.WpsAiUpdater.downloadAndApply(_latestManifest, (p) => {
        if (btn && p.step === "extract") btn.textContent = "解压中…";
        if (btn && p.step === "done") btn.textContent = "已完成";
      });
      showMessage(r?.message || "更新已安装，请重启 WPS。", "success", { duration: 8000 });
      // 自动开始检查 → 渲染会清掉「有新版本」状态（也可下次启动时清掉）
      try { global.WpsAiUpdater.clearCache(); } catch (e) {}
    } catch (e) {
      showMessage(`安装失败：${e?.message || e}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "下载并安装";
        btn.style.display = "none"; // 安装完成隐藏，下次有新版再出现
      }
    }
  }

  // 启动时按设置静默检查（不抛 toast，结果直接渲染到 UI）
  async function startupAutoCheckUpdate() {
    if (!currentSettings?.updateAutoCheck) return;
    if (!global.WpsAiUpdater) return;
    try {
      const result = await global.WpsAiUpdater.checkForUpdate({ force: false });
      renderUpdateUi(result);
      if (result.updateAvailable) {
        // 顶部一条不打扰的提示
        showMessage(`发现新版本 v${result.latest}，可在设置 → 程序信息里查看`, "info", { duration: 6000 });
      }
    } catch (e) {
      plog?.("updater", "auto-check failed:", e?.message);
    }
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
      if (payload.modal === "stylePreset") openStylePresetAsDialog();
      else if (payload.modal === "outline") openOutlineModal();
      else if (payload.modal === "unify") openUnifyModal();
      return;
    }

    activateTab("ai");

    // PDF 宿主下任何 quick action 都自动把活动 PDF 当附件挂上去（前提是活动文档是 PDF）
    // —— AI 这样能直接看到 PDF 内容，不用再调 pdf_read_document 抓空字符串
    if (payload.host === "pdf" || payload.attachActivePdf) {
      await attachActivePdf({ silent: true });
    }

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

  // ===== 整套 PPT 生成进度条（修 #6）=====
  // wpp_render_full_deck 在 presentation.js 里实时写 localStorage 的 progress key
  // 主 TaskPane 轮询读取，显示进度条 + 当前页 / 总页数 + 描述
  const FULL_DECK_PROGRESS_KEY = "lingxi_full_deck_progress_v1";
  let _fullDeckProgressTimer = null;
  function pollFullDeckProgress() {
    let p = null;
    try {
      const raw = localStorage.getItem(FULL_DECK_PROGRESS_KEY);
      if (raw) p = JSON.parse(raw);
    } catch (e) {}
    const box = els.fullDeckProgress;
    if (!box) return;
    if (!p || !p.total) {
      box.classList.add("hidden");
      return;
    }
    // 数据陈旧（>2 分钟没更新）认为是死循环遗留，自动清掉
    if (Date.now() - (p.ts || 0) > 120000) {
      try { localStorage.removeItem(FULL_DECK_PROGRESS_KEY); } catch (e) {}
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (els.fullDeckProgressCount) {
      els.fullDeckProgressCount.textContent = `${p.current} / ${p.total}`;
    }
    if (els.fullDeckProgressBarFill) {
      const pct = Math.max(0, Math.min(100, (p.current / p.total) * 100));
      els.fullDeckProgressBarFill.style.width = pct.toFixed(1) + "%";
    }
    if (els.fullDeckProgressLabel) {
      els.fullDeckProgressLabel.textContent = p.label || "";
    }
  }
  function startFullDeckProgressWatcher() {
    if (_fullDeckProgressTimer) return;
    _fullDeckProgressTimer = setInterval(pollFullDeckProgress, 500);
    pollFullDeckProgress(); // 立即跑一次
  }

  function startPendingActionWatcher() {
    setTimeout(consumePendingAction, 200);
    setInterval(consumePendingAction, 800);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) consumePendingAction();
    });
  }

  // ===== HTML 模板预览 modal =====
  // wpp_render_html_template 工具调用时打开此 modal；用户可编辑字段后点「插入到幻灯片」
  // 触发真正的渲染+图片插入；可从右上「历史」面板里召回过去生成的页面继续编辑。

  let htmlPreviewState = null;
  let htmlPreviewRenderTimer = null;
  // 预览 iframe scale 计算 + 应用：壳子可能 ResizeObserver 抓变更
  let htmlPreviewResizeObserver = null;
  // 打开 modal 时记录的 TaskPane 原始宽度（用于关闭时恢复）
  let htmlPreviewOrigPaneWidth = null;
  // 期望的 TaskPane 宽度：让预览有视觉冲击力，最小 960
  const HTML_PREVIEW_PANE_WIDTH = 960;

  function tryExpandTaskPaneForPreview() {
    try {
      const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
      if (!pane) return;
      let cur = 0;
      try { cur = Number(pane.Width) || 0; } catch (e) {}
      if (cur && cur < HTML_PREVIEW_PANE_WIDTH) {
        htmlPreviewOrigPaneWidth = cur;
        try { pane.Width = HTML_PREVIEW_PANE_WIDTH; } catch (e) {}
      }
    } catch (e) { /* 不支持就算了 */ }
  }

  function tryRestoreTaskPaneAfterPreview() {
    if (!htmlPreviewOrigPaneWidth) return;
    try {
      const pane = global.WpsAiAddon?.getCurrentTaskPane?.();
      if (pane) {
        try { pane.Width = htmlPreviewOrigPaneWidth; } catch (e) {}
      }
    } catch (e) {}
    htmlPreviewOrigPaneWidth = null;
  }

  // 父窗口直接操作 iframe DOM 渲染图表 / canvas（同源即可，**无需 allow-scripts**）。
  // - 扫 [data-echarts-option] 元素 → echarts.init().setOption()
  // - 扫 canvas[data-canvas-draw] 元素 → new Function 跑代码（运行在父窗口上下文，但操作的是 iframe 内的 canvas）
  // echarts 没加载时静默；canvas 不依赖 echarts，独立工作。
  function bridgeEchartsToFrame(frame) {
    try {
      const doc = frame?.contentDocument;
      if (!doc || !doc.body) return;
      const ec = window.echarts;
      // ===== ECharts =====
      if (ec) {
        const root = doc.documentElement;
        const cs = doc.defaultView ? doc.defaultView.getComputedStyle(root) : null;
        const palette = cs ? [
          (cs.getPropertyValue("--primary") || "#1A6DFF").trim(),
          (cs.getPropertyValue("--accent")  || "#E85D2F").trim(),
          (cs.getPropertyValue("--body-color") || "#475569").trim(),
          (cs.getPropertyValue("--surface") || "#E2E8F0").trim(),
          "#7C5295", "#15803D"
        ] : null;
        doc.querySelectorAll("[data-echarts-option]").forEach((el) => {
          try {
            const opt = JSON.parse(el.getAttribute("data-echarts-option"));
            if (palette && !opt.color) opt.color = palette;
            // 容器无明确尺寸时给 100%
            if (!el.style.width && !el.clientWidth) el.style.width = "100%";
            if (!el.style.height && !el.clientHeight) el.style.height = "100%";
            const chart = ec.init(el, null, { renderer: "svg" });
            chart.setOption(opt);
          } catch (e) { /* 单格失败不阻塞其他 */ }
        });
      }
      // ===== Canvas draw =====（与 echarts 解耦，没 echarts 也能用）
      doc.querySelectorAll("canvas[data-canvas-draw]").forEach((c) => {
        try {
          const w = c.clientWidth, h = c.clientHeight;
          if (w && h) { c.width = w; c.height = h; }
          const ctx = c.getContext("2d");
          const code = c.getAttribute("data-canvas-draw");
          new Function("ctx", "canvas", "w", "h", code)(ctx, c, c.width, c.height);
        } catch (e) {}
      });
    } catch (e) { /* CORS / timing 异常沉默 */ }
  }

  function applyHtmlPreviewScale() {
    const frame = els.htmlPreviewFrame;
    if (!frame) return;
    const inner = frame.parentElement;
    if (!inner) return;
    const sw = inner.clientWidth;
    const sh = inner.clientHeight;
    if (!sw || !sh) {
      const tries = (applyHtmlPreviewScale._tries || 0) + 1;
      if (tries <= 5) {
        applyHtmlPreviewScale._tries = tries;
        setTimeout(applyHtmlPreviewScale, 80);
      } else {
        applyHtmlPreviewScale._tries = 0;
      }
      return;
    }
    applyHtmlPreviewScale._tries = 0;
    const scaleW = sw / 1920;
    const scaleH = sh / 1080;
    // 收缩到 92% 留 8% matt 视觉余量（4 边 4% 各）；编辑器选中边缘元素时按钮也有空间
    const scale = Math.min(scaleW, scaleH, 1) * 0.92;
    frame.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
    frame._lingxiScale = scale;
    // scale 算完顺手刷新标尺刻度
    renderRulers();
  }

  // ===== 画布标尺：PS 风顶/左两条标尺，刻度按 1920×1080 logical 像素 =====
  function renderRulers() {
    const frame = els.htmlPreviewFrame;
    if (!frame) return;
    const inner = frame.parentElement;
    if (!inner || !inner.classList.contains("with-ruler")) return;
    const topRuler = inner.querySelector("#rulerTop");
    const leftRuler = inner.querySelector("#rulerLeft");
    if (!topRuler || !leftRuler) return;
    const scale = frame._lingxiScale || 0.28;
    const innerW = inner.clientWidth;
    const innerH = inner.clientHeight;
    // iframe 实际可见 W/H（缩放后）+ 在 stage-inner 内的左/上偏移（居中）
    const realW = 1920 * scale;
    const realH = 1080 * scale;
    const ifrLeft = (innerW - realW) / 2;
    const ifrTop  = (innerH - realH) / 2;
    // 标尺自己占了 22px 起点
    const RULER_W = 22;
    // ===== Top ruler =====
    // 标尺 DOM 的 left=22px，宽度 = innerW - 22。iframe 的左边缘距离标尺起点 = ifrLeft - 22。
    // 1920 logical px → realW visible px。tick 在标尺内的位置 = (logicalX * scale) + (ifrLeft - 22)。
    const topParts = [];
    const STEP = 50; // 每 50 logical px 一根 tick
    for (let x = 0; x <= 1920; x += STEP) {
      const px = ifrLeft - RULER_W + x * scale;
      // 超出标尺可视区就别画
      if (px < -8 || px > innerW - RULER_W + 8) continue;
      const isMajor = x % 200 === 0;
      const isMedium = !isMajor && x % 100 === 0;
      const cls = isMajor ? "tick major" : (isMedium ? "tick medium" : "tick");
      topParts.push(`<div class="${cls}" style="left:${px}px"></div>`);
      if (isMajor) topParts.push(`<div class="label" style="left:${px}px">${x}</div>`);
    }
    topRuler.innerHTML = topParts.join("");
    // ===== Left ruler =====
    const leftParts = [];
    for (let y = 0; y <= 1080; y += STEP) {
      const py = ifrTop - RULER_W + y * scale;
      if (py < -8 || py > innerH - RULER_W + 8) continue;
      const isMajor = y % 200 === 0;
      const isMedium = !isMajor && y % 100 === 0;
      const cls = isMajor ? "tick major" : (isMedium ? "tick medium" : "tick");
      leftParts.push(`<div class="${cls}" style="top:${py}px"></div>`);
      if (isMajor) leftParts.push(`<div class="label" style="top:${py}px">${y}</div>`);
    }
    leftRuler.innerHTML = leftParts.join("");
  }

  // 中栏 tab 切换：画布 / 属性（HTML+CSS 字段）
  let _centerTabActive = "canvas";
  function switchCenterTab(tab) {
    if (tab !== "canvas" && tab !== "props") return;
    _centerTabActive = tab;
    document.querySelectorAll(".html-preview-center-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.centerTab === tab);
    });
    document.querySelectorAll("[data-center-panel]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.centerPanel !== tab);
    });
    // 切回画布时容器尺寸可能从 0 → 真实值；重新算 scale + 标尺
    if (tab === "canvas") {
      requestAnimationFrame(() => {
        applyHtmlPreviewScale();
      });
    }
  }

  // 标尺显隐：写到 localStorage，下次开预览自动还原
  const RULER_VISIBLE_KEY = "lingxi_html_preview_ruler_visible_v1";
  function applyRulerVisibility(visible) {
    const frame = els.htmlPreviewFrame;
    const inner = frame?.parentElement;
    if (!inner) return;
    inner.classList.toggle("with-ruler", visible);
    const btn = els.htmlPreviewToggleRulerBtn;
    if (btn) btn.classList.toggle("active", visible);
    try { localStorage.setItem(RULER_VISIBLE_KEY, visible ? "1" : "0"); } catch (e) {}
    if (visible) renderRulers();
  }
  function toggleRuler() {
    const frame = els.htmlPreviewFrame;
    const inner = frame?.parentElement;
    if (!inner) return;
    applyRulerVisibility(!inner.classList.contains("with-ruler"));
  }

  function setHtmlPreviewBusy(busy) {
    if (els.htmlPreviewRendering) {
      els.htmlPreviewRendering.classList.toggle("hidden", !busy);
    }
    if (els.htmlPreviewInsertBtn) {
      els.htmlPreviewInsertBtn.disabled = !!busy;
    }
  }

  function renderHtmlPreviewIntoIframe() {
    const st = htmlPreviewState;
    plog("render", "entry; st =", st ? `{${st.templateName}/${st.layout}}` : "NULL");
    if (!st) { pwarn("render", "no state, abort"); return; }
    const HtmlTpl = global.WpsAiHtmlTemplates;
    plog("render", "WpsAiHtmlTemplates module loaded?", !!HtmlTpl, "getTemplate?", typeof HtmlTpl?.getTemplate);
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    plog("render", "template found?", !!tpl, "layoutKeys =", tpl ? Object.keys(tpl.layouts || {}) : "(no tpl)");
    const layoutDef = tpl?.layouts?.[st.layout];
    if (!layoutDef) {
      pwarn("render", `unknown template/layout: ${st.templateName} / ${st.layout}`);
      els.htmlPreviewInfo.textContent = `未知模板 ${st.templateName} / ${st.layout}`;
      return;
    }
    setHtmlPreviewBusy(true);
    let html;
    try {
      html = layoutDef.render(st.data || {}, st.palette || {});
      plog("render", `layout.render returned html len = ${html ? html.length : 0}`);
    } catch (e) {
      pwarn("render", "layout.render THREW:", e?.message || e);
      const msg = String(e?.message || e);
      els.htmlPreviewInfo.textContent = `渲染异常：${msg}`;
      // 在 iframe 里也显示一份，用户不至于看着空白发懵
      try {
        const frame = els.htmlPreviewFrame;
        if (frame) frame.srcdoc = `<!doctype html><html><body style="margin:0;padding:80px;font-family:sans-serif;color:#c00;background:#fff5f5"><h2 style="font-size:48px">渲染异常</h2><pre style="font-size:24px;white-space:pre-wrap;word-break:break-all">${msg.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre><p style="font-size:20px;color:#888">templateName: ${st.templateName} / layout: ${st.layout}</p></body></html>`;
      } catch (_) {}
      setHtmlPreviewBusy(false);
      return;
    }
    if (!html || typeof html !== "string") {
      const msg = `layout ${st.templateName}/${st.layout} 渲染返回空内容`;
      els.htmlPreviewInfo.textContent = msg;
      try {
        const frame = els.htmlPreviewFrame;
        if (frame) frame.srcdoc = `<!doctype html><html><body style="margin:0;padding:80px;font-family:sans-serif;color:#c00"><h2 style="font-size:48px">${msg}</h2></body></html>`;
      } catch (_) {}
      setHtmlPreviewBusy(false);
      return;
    }
    // 强制让每次的 srcdoc 字符串不一样 —— 某些 WebView（WKWebView、旧 WebView2）发现
    // srcdoc 跟上次内容完全相同时不会重新触发 load，导致 AI 生成新内容后预览停在旧画面。
    // 在文档末尾追加一段不影响渲染的注释，每次都唯一。
    const renderTag = `${Date.now().toString(36)}-${(Math.random() * 1e6 | 0).toString(36)}`;
    html += `\n<!-- lingxi-render ${renderTag} -->`;
    // 渲染加固：
    // 渲染策略（主路径换成 document.open/write/close）：
    //   srcdoc 在多数 WPS WebView 里设置后**load 不触发 / 不真正渲染**，是空白预览的根因。
    //   document.open/write/close 是同源同步 DOM API，覆盖率最广、最可靠。
    //   流程：
    //     1. 清掉 srcdoc 属性，防止它干扰 contentDocument
    //     2. doc.open/write/close 把 html 写入 iframe 内
    //     3. 写完即同步 applyScale + bridgeEcharts + setBusy(false)（不再依赖 load 事件）
    //     4. 失败兜底（理论上不会发生）：才用 srcdoc 重试一次
    try {
      const frame = els.htmlPreviewFrame;
      // 清掉旧 listener / timeout，跟之前快速连发的 render 解耦
      if (frame._lastOnLoad) {
        try { frame.removeEventListener("load", frame._lastOnLoad); } catch (e) {}
        frame._lastOnLoad = null;
      }
      if (frame._loadTimeout) {
        clearTimeout(frame._loadTimeout);
        frame._loadTimeout = null;
      }
      // 卸掉 srcdoc 属性，避免它跟 contentDocument 抢渲染
      try { frame.removeAttribute("srcdoc"); } catch (e) {}

      const finishRender = (path) => {
        const innerW = frame.parentElement?.clientWidth;
        const innerH = frame.parentElement?.clientHeight;
        const doc = frame.contentDocument;
        const bodyChildren = doc?.body?.childElementCount;
        const stageEl = doc?.querySelector?.(".stage");
        plog("finishRender", `via=${path}; container=${innerW}x${innerH}; body.children=${bodyChildren}; stage=${!!stageEl}`);
        applyHtmlPreviewScale();
        plog("finishRender", `applied transform: ${frame.style.transform}`);
        setHtmlPreviewBusy(false);
        if (htmlPreviewState === st) {
          els.htmlPreviewInfo.textContent = `1920 × 1080 · ${st.templateName} / ${st.layout}`;
        }
        bridgeEchartsToFrame(frame);
        if (_editorEnabled && htmlPreviewState === st && st.layout === "freeform") {
          try { enableIframeEditor(); } catch (e) { console.warn("[editor] re-enable failed", e); }
        }
      };

      // 用 document.open/write/close 主动写入（同步生效）
      let written = false;
      let writeErr = null;
      try {
        const doc = frame.contentDocument;
        plog("render", "contentDocument =", !!doc, "iframe.src =", frame.src || "(empty)");
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
          written = true;
        }
      } catch (e) { writeErr = e; /* 罕见：跨域 / WebView 限制 */ }
      plog("render", `document.write path: written=${written}` + (writeErr ? ` err=${writeErr.message}` : ""));

      if (written) {
        // 同步路径成功，DOM 已就位；下一帧算 scale + 触发 chart bootstrap
        requestAnimationFrame(() => {
          if (htmlPreviewState !== st) { pwarn("render", "state changed before RAF; abort finishRender"); return; }
          finishRender("doc.write");
        });
      } else {
        // 兜底：回退到 srcdoc，监听 load + 800ms 兜底跑 finishRender
        pwarn("render", "doc.write FAILED — falling back to srcdoc + load event");
        const onLoad = () => {
          plog("render", "srcdoc onLoad fired");
          try { frame.removeEventListener("load", onLoad); } catch (e) {}
          if (frame._loadTimeout) { clearTimeout(frame._loadTimeout); frame._loadTimeout = null; }
          frame._lastOnLoad = null;
          if (htmlPreviewState === st) finishRender("srcdoc-onLoad");
        };
        frame._lastOnLoad = onLoad;
        frame.addEventListener("load", onLoad);
        frame._loadTimeout = setTimeout(() => {
          pwarn("render", "srcdoc onLoad NEVER FIRED in 800ms — running finishRender from timeout");
          try { frame.removeEventListener("load", onLoad); } catch (e) {}
          frame._lastOnLoad = null;
          frame._loadTimeout = null;
          if (htmlPreviewState === st) finishRender("srcdoc-timeout");
        }, 800);
        try { frame.srcdoc = html; plog("render", `srcdoc set, len=${html.length}`); }
        catch (e) {
          pwarn("render", "srcdoc set THREW:", e?.message);
          els.htmlPreviewInfo.textContent = `iframe 写入失败：${e?.message || e}`;
          setHtmlPreviewBusy(false);
        }
      }
    } catch (e) {
      els.htmlPreviewInfo.textContent = `iframe 写入失败：${e?.message || e}`;
      setHtmlPreviewBusy(false);
    }
  }

  function debounceHtmlPreviewRender() {
    if (htmlPreviewRenderTimer) clearTimeout(htmlPreviewRenderTimer);
    htmlPreviewRenderTimer = setTimeout(() => {
      htmlPreviewRenderTimer = null;
      renderHtmlPreviewIntoIframe();
    }, 200);
  }

  // 把字段渲染成 textarea/input；监听 input 事件，写回 state.data，触发去抖预览
  function renderHtmlPreviewFields() {
    const st = htmlPreviewState;
    const host = els.htmlPreviewFields;
    if (!host) return;
    host.innerHTML = "";
    if (!st) return;
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    const layoutDef = tpl?.layouts?.[st.layout];
    const fields = layoutDef?.fields || Object.keys(st.data || {});
    fields.forEach((fieldName) => {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.textContent = fieldName;
      label.appendChild(span);
      const cur = st.data?.[fieldName] || "";
      // freeform 的 html / css 是大块代码，给加高的 textarea；其他长字段也用 textarea
      const isCodeField = /^(html|css)$/i.test(fieldName);
      const useTextarea = isCodeField
        || String(cur).length > 40
        || String(cur).includes("\n")
        || /body|description|subtitle|items/i.test(fieldName);
      const input = document.createElement(useTextarea ? "textarea" : "input");
      if (!useTextarea) {
        input.type = "text";
      } else {
        input.rows = isCodeField ? 12 : 3;
        if (isCodeField) {
          input.style.fontFamily = "Consolas, 'Microsoft YaHei UI', monospace";
          input.style.fontSize = "11px";
        }
      }
      input.value = cur;
      input.addEventListener("input", () => {
        st.data = Object.assign({}, st.data, { [fieldName]: input.value });
        debounceHtmlPreviewRender();
      });
      // WPS WebView paste 兜底：手动从 clipboardData 取文本插入。
      // 主要服务 freeform 的 html/css 字段 —— 用户最可能在这里粘贴整段代码。
      input.addEventListener("paste", (ev) => {
        const txt = ev.clipboardData?.getData("text") || "";
        if (!txt) return;
        ev.preventDefault();
        insertAtCursor(ev.currentTarget, txt);
      });
      label.appendChild(input);
      host.appendChild(label);
    });
  }

  function updateHtmlPreviewHistoryBadge() {
    try {
      const cache = global.WpsAiHtmlCache;
      const count = cache?.list?.()?.length || 0;
      if (els.htmlPreviewHistoryBtn) {
        els.htmlPreviewHistoryBtn.textContent = `历史 (${count})`;
      }
    } catch (e) {}
  }

  function renderHtmlPreviewHistory() {
    const host = els.htmlPreviewHistoryList;
    if (!host) return;
    const cache = global.WpsAiHtmlCache;
    const entries = cache?.list?.(20) || [];
    host.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "html-preview-history-empty";
      empty.textContent = "暂无历史。生成一次 HTML 模板就会自动保存到这里。";
      host.appendChild(empty);
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "html-preview-history-item";
      const row1 = document.createElement("div");
      row1.className = "row1";
      const tpl = document.createElement("span");
      tpl.className = "tpl";
      tpl.textContent = `${entry.templateName} / ${entry.layout}`;
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = formatHtmlPreviewTs(entry.ts);
      row1.appendChild(tpl);
      row1.appendChild(ts);
      const preview = document.createElement("div");
      preview.className = "preview";
      const firstField = Object.values(entry.data || {})[0] || "";
      preview.textContent = String(firstField).slice(0, 60) || "—";
      item.appendChild(row1);
      item.appendChild(preview);
      item.addEventListener("click", () => {
        // 召回：把 state 替换成历史条目，重新渲染字段 + 预览
        htmlPreviewState = {
          id: entry.id,
          templateName: entry.templateName,
          layout: entry.layout,
          data: Object.assign({}, entry.data || {}),
          palette: Object.assign({}, entry.palette || {}),
          slideHint: entry.slideHint || null,
          onConfirm: htmlPreviewState?.onConfirm || null  // 保留原 onConfirm
        };
        els.htmlPreviewTemplate.textContent = htmlPreviewState.templateName;
        els.htmlPreviewLayout.textContent = htmlPreviewState.layout;
        renderHtmlPreviewFields();
        renderHtmlPreviewIntoIframe();
        updateHtmlPreviewActionButtons();
        // 切到新 slide → 右侧"美化当前预览"chat 也跟着切（清空旧会话）
        resetPreviewChatForState(htmlPreviewState);
        toggleHtmlPreviewHistoryPanel(false);
      });
      host.appendChild(item);
    });
  }

  function formatHtmlPreviewTs(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toggleHtmlPreviewHistoryPanel(show) {
    const panel = els.htmlPreviewHistoryPanel;
    if (!panel) return;
    if (show) {
      // 互斥：开历史就关画廊
      if (els.htmlTemplateGallery && !els.htmlTemplateGallery.classList.contains("hidden")) {
        els.htmlTemplateGallery.classList.add("hidden");
      }
      renderHtmlPreviewHistory();
      panel.classList.remove("hidden");
    } else {
      panel.classList.add("hidden");
    }
  }

  // 根据当前 state 同步「替换原幻灯片」按钮的显隐与文字
  function updateHtmlPreviewActionButtons() {
    const st = htmlPreviewState;
    const replaceBtn = els.htmlPreviewReplaceBtn;
    const replaceActiveBtn = els.htmlPreviewReplaceActiveBtn;
    const insertBtn = els.htmlPreviewInsertBtn;
    if (!replaceBtn || !insertBtn) return;
    const slideN = st?.slideHint;
    if (slideN && Number.isFinite(+slideN)) {
      replaceBtn.textContent = `替换第 ${slideN} 页`;
      replaceBtn.classList.remove("hidden");
    } else {
      replaceBtn.classList.add("hidden");
    }
    // "替换当前选中"：始终可用（只要在 WPP 宿主里都有"当前选中"概念）；
    // 当 slideHint 和当前选中可能是同一页时，仍然各自展示让用户自己挑。
    if (replaceActiveBtn) {
      if (st) replaceActiveBtn.classList.remove("hidden");
      else replaceActiveBtn.classList.add("hidden");
    }
    // 「整页存为组件」/「提取组件」/「编辑模式」只在 freeform 布局有意义
    const isFreeform = st?.layout === "freeform";
    const saveAsCompBtn = els.htmlPreviewSaveAsCompBtn;
    if (saveAsCompBtn) saveAsCompBtn.classList.toggle("hidden", !isFreeform);
    const extractBtn = els.htmlPreviewExtractCompsBtn;
    if (extractBtn) extractBtn.classList.toggle("hidden", !isFreeform);
    const editModeBtn = els.htmlPreviewEditModeBtn;
    if (editModeBtn) editModeBtn.classList.toggle("hidden", !isFreeform);
    // 切到非 freeform / 没 state → 自动退出编辑模式
    if (!isFreeform && _editorEnabled) disableIframeEditor();
    // 「选用组件」按钮的角标 = 当前 slide 已选组件数
    updatePickedComponentsCountBadge();
    // standalone（无 onConfirm）模式：是用户从历史召回打开的，需要兜底插入路径
    if (!st?.onConfirm) {
      insertBtn.textContent = slideN ? "插入到末尾（不替换）" : "插入到末尾";
    } else {
      insertBtn.textContent = "插入到幻灯片";
    }
  }

  // 主入口：打开预览 modal。
  // 在主 TaskPane 里：优先用 Application.ShowDialog 弹独立窗口（脱离 pane 宽度限制，体验最好）；
  // 不可用时退回 inline modal（原有行为）。
  // 在 preview-mode 独立窗口里：直接走 inline 行为。
  function openHtmlPreviewModal(opts) {
    opts = opts || {};
    // 修：在打开预览（弹独立 dialog 之前）抓住用户当前选中的幻灯片号。
    // 之后用户点「替换当前选中」时，renderAndInsertSlide 不再依赖
    // ActiveWindow.View.Slide（dialog 关闭后那个状态不可靠 / 偶发指向 slide 1），
    // 改用这里抓到的稳定值。
    try {
      if (typeof opts.activeSlideIndex !== "number") {
        const app = global.WpsAiAddon?.getApplicationSync?.();
        const hasApp = !!app;
        const win = app?.ActiveWindow;
        const view = win?.View;
        const slide = view?.Slide;
        const idx = slide?.SlideIndex;
        plog("captureActiveSlide", {
          hasApp,
          hasWin: !!win,
          hasView: !!view,
          hasSlide: !!slide,
          slideIndex: idx,
          captured: typeof idx === "number" && idx > 0
        });
        if (typeof idx === "number" && idx > 0) opts.activeSlideIndex = idx;
      } else {
        plog("captureActiveSlide", "skipped (opts.activeSlideIndex already set)", opts.activeSlideIndex);
      }
    } catch (e) {
      pwarn("captureActiveSlide", "exception:", e?.message || String(e));
    }
    plog("openHtmlPreviewModal", "called", {
      templateName: opts.templateName, layout: opts.layout,
      hasData: !!opts.data, dataKeys: Object.keys(opts.data || {}),
      hasPalette: !!opts.palette, slideHint: opts.slideHint,
      activeSlideIndex: opts.activeSlideIndex,
      hasOnConfirm: typeof opts.onConfirm === "function"
    });
    if (!isPreviewDialog && !isSettingsDialog) {
      // 在主 TaskPane —— 先试独立窗口
      const ok = tryOpenHtmlPreviewAsDialog(opts);
      plog("openHtmlPreviewModal", "tryDialog result =", ok);
      if (ok) return;
    }
    plog("openHtmlPreviewModal", "→ openHtmlPreviewInline (no dialog or already inside)");
    return openHtmlPreviewInline(opts);
  }

  // 用 ShowDialog 打开独立预览窗口。把 opts 序列化进 localStorage（不能序列化 onConfirm 函数，
  // 用一个 token 在 parent 这边保留 callback，等 dialog 关闭后用结果回填触发）。
  let _pendingHtmlPreviewOnConfirm = null;
  // 把 WPS 主窗口拉回前台。`Application.ShowDialog` 模态退出后，OS 焦点常被切到别的进程。
  // 各家 WPS API 不同，调一遍能找到的全部接口；任何一个生效就行。
  function activateWpsApp(app) {
    if (!app) return;
    // 1. Visible：被设成 false 时主动开启
    try { if (app.Visible === false) app.Visible = true; } catch (e) {}
    // 2. WindowState 被改成最小化(2)时强制恢复到 Normal(1) —— 之前只 prev→prev 自赋值，
    //    若已经是最小化(2) 写回 2 还是最小化，根本拉不回来。这里显式判断 minimized 才覆盖。
    //    各宿主常量：ppWindowMinimized=2 / wdWindowStateMinimize=2 / xlMinimized=-4140
    try {
      const ws = app.WindowState;
      if (ws === 2 || ws === -4140) {
        // ppWindowNormal=1 / wdWindowStateNormal=0 / xlNormal=-4143 —— 设为 1 多数 host 能恢复
        app.WindowState = 1;
      } else if (typeof ws === "number") {
        // 不是最小化时，自赋值触发一下 state 通知，能把宿主推前
        app.WindowState = ws;
      }
    } catch (e) {}
    // 3. Application.Activate() —— 部分 WPP/ET 版本有
    try { if (typeof app.Activate === "function") app.Activate(); } catch (e) {}
    // 4. ActiveWindow.Activate() + WindowState 兜底（窗口级再保险一次）
    try {
      const w = app.ActiveWindow;
      if (w) {
        if (typeof w.Activate === "function") w.Activate();
        try {
          if (w.WindowState === 2 || w.WindowState === -4140) w.WindowState = 1;
        } catch (e) {}
      }
    } catch (e) {}
    // 5. WPP 特有：ActivePresentation / Word 的 ActiveDocument / Excel 的 ActiveWorkbook 上 Activate
    try { const p = app.ActivePresentation; if (p && typeof p.Activate === "function") p.Activate(); } catch (e) {}
    try { const d = app.ActiveDocument; if (d && typeof d.Activate === "function") d.Activate(); } catch (e) {}
    try { const wb = app.ActiveWorkbook; if (wb && typeof wb.Activate === "function") wb.Activate(); } catch (e) {}
    // 6. 通过 window.focus 让 TaskPane（本身寄宿在 WPS 主窗口里）抢回焦点，间接把宿主推前
    try { if (typeof window.focus === "function") window.focus(); } catch (e) {}
  }

  function tryOpenHtmlPreviewAsDialog(opts) {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=preview`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      plog("tryDialog", "url =", url, "app =", !!app, "ShowDialog =", typeof app?.ShowDialog);
      if (!app || typeof app.ShowDialog !== "function") {
        pwarn("tryDialog", "no Application.ShowDialog API → fallback to inline modal");
        return false;
      }
      // 把可序列化的部分写到 localStorage 供 dialog 读
      const request = {
        templateName: opts.templateName || null,
        layout: opts.layout || null,
        data: opts.data || {},
        palette: opts.palette || {},
        slideHint: opts.slideHint || null,
        activeSlideIndex: typeof opts.activeSlideIndex === "number" ? opts.activeSlideIndex : null,
        historyMode: !!opts.historyMode,
        galleryMode: !!opts.galleryMode,
        ts: Date.now()
      };
      plog("tryDialog", "request blob", {
        slideHint: request.slideHint,
        activeSlideIndex: request.activeSlideIndex,
        templateName: request.templateName,
        layout: request.layout
      });
      const requestStr = JSON.stringify(request);
      try { localStorage.setItem(PREVIEW_DIALOG_REQUEST_KEY, requestStr); } catch (e) { pwarn("tryDialog", "localStorage write FAILED:", e?.message); }
      try { localStorage.removeItem(PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
      plog("tryDialog", "wrote request to localStorage, len =", requestStr.length, "tplName =", request.templateName, "layout =", request.layout);
      // 保留 onConfirm 在 parent 这边
      _pendingHtmlPreviewOnConfirm = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
      // 模态调用：第 5 个参数 = true 让 WPS 主窗口阻塞直到 dialog 关闭。
      // 非模态（false）在 WPS 演示下会**立刻返回**，导致下面的 removeItem 在 dialog 还没启动前
      // 就把 REQUEST key 删了，dialog 读到 null → 显示空白占位。
      // dialog 尺寸根据屏幕自适应：1600×1000 在 1366×768 屏上会越界，按屏幕可用区裁剪
      const { w: dW, h: dH } = pickDialogSize(1600, 1000, { minW: 960, minH: 640 });
      plog("tryDialog", "calling app.ShowDialog (modal=true, blocking)... size =", dW, "x", dH);
      app.ShowDialog(url, "灵犀AI 预览", dW, dH, true);
      plog("tryDialog", "ShowDialog returned, activating WPS");
      // dialog 关掉后，WPS 主窗口往往会被系统切到后台 —— 主动让它回到前台。
      // WPS 各版本 / 各宿主 API 不一，把能找到的全都试一遍：
      activateWpsApp(app);
      // dialog 关闭后：读结果，触发 onConfirm
      let result = null;
      try {
        const raw = localStorage.getItem(PREVIEW_DIALOG_RESULT_KEY);
        if (raw) result = JSON.parse(raw);
      } catch (e) {}
      // 注意：**不**在这里删 REQUEST key。原因：在某些 WPS 版本里 ShowDialog 是非阻塞的
      // （写 true 也未必生效），主窗口会立刻继续跑这段代码 —— 此时 dialog 可能还没启动完，
      // 删了 REQUEST 它就读不到了 → 空白预览。让 REQUEST 留在 LS 里，下次新请求会覆盖。
      // RESULT 删掉是安全的：它只在 dialog 关闭后才写，dialog 关闭意味着我们已经读完了。
      try { localStorage.removeItem(PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
      plog("tryDialog", "post-dialog: result =", result ? (result.cancelled ? "cancelled" : "ok") : "null");
      const cb = _pendingHtmlPreviewOnConfirm;
      _pendingHtmlPreviewOnConfirm = null;
      if (cb) {
        // 工具流：调原 onConfirm（tool 自己处理插入）
        if (!result || result.cancelled) {
          try { cb(null); } catch (e) {}
        } else {
          try { cb({
            data: result.data || {},
            palette: result.palette || {},
            intent: result.intent || "insert",
            activeSlideIndex: typeof result.activeSlideIndex === "number" ? result.activeSlideIndex : null
          }); } catch (e) {}
        }
      } else if (result && !result.cancelled && result.templateName && result.layout) {
        // standalone 路径：dialog 没有 tool onConfirm，由 MAIN TaskPane 在这里调 renderAndInsertSlide。
        // 之前 DIALOG 自己调会卡在 modal 状态 → WPS API 偶发静默失败。改在主上下文（dialog 已 close 后）
        // 调就是普通的 jsapi 调用环境。
        plog("tryDialog", "standalone path: MAIN 调 renderAndInsert", {
          intent: result.intent,
          activeSlideIndex: result.activeSlideIndex,
          slideHint: result.slideHint
        });
        const renderAndInsert = global.WpsAiRenderAndInsertSlide;
        if (typeof renderAndInsert !== "function") {
          pwarn("tryDialog", "WpsAiRenderAndInsertSlide 未注册，跳过插入");
          showMessage("插件未完整初始化，无法插入", "error");
        } else {
          const params = {
            templateName: result.templateName,
            layout: result.layout,
            data: result.data || {},
            palette: result.palette || {},
            intent: result.intent || "insert"
          };
          if (result.intent === "replace" && typeof result.slideHint === "number" && result.slideHint > 0) {
            params.slide = result.slideHint;
          } else if (result.intent === "replace-active" && typeof result.activeSlideIndex === "number" && result.activeSlideIndex > 0) {
            params.slide = result.activeSlideIndex;
            params.intent = "replace";
          }
          plog("tryDialog", "MAIN renderAndInsert params", params);
          (async () => {
            try {
              const r = await renderAndInsert(params);
              plog("tryDialog", "MAIN renderAndInsert OK", { slide: r?.slide, layerCount: r?.layerCount });
              showMessage(`已${result.intent === "insert" ? "插入到末尾" : `替换第 ${r?.slide} 页`}（共 ${r?.layerCount || 1} 张图）`, "success");
            } catch (e) {
              pwarn("tryDialog", "MAIN renderAndInsert THREW", e?.message || String(e));
              showMessage(`插入失败：${e?.message || e}`, "error");
            }
          })();
        }
      }
      return true;
    } catch (e) {
      console.warn("[html-preview] ShowDialog 失败，回退到 inline modal:", e?.message || e);
      _pendingHtmlPreviewOnConfirm = null;
      return false;
    }
  }

  // ====== 以下是原 openHtmlPreviewModal 主体，改名 openHtmlPreviewInline ======
  // 「原地更新」：如果 modal 已经打开且当前 state 存在，且新 opts 的 templateName+layout 一致，
  //   **而且 cacheId 也一致**（同一条历史 / 都是未保存），则只 patch data/palette/slideHint 并重渲。
  //   这样 AI 后续调 wpp_render_html_template 想「修改预览」时，效果是字段被更新而不是弹新窗；
  //   而用户点左侧历史里的另一条（同 template/layout 但不同 id）会**正确切换 state**，不会被原地合并。
  function openHtmlPreviewInline(opts) {
    if (!els.htmlPreviewModal) {
      pwarn("openInline", "els.htmlPreviewModal NOT FOUND — bindElements never ran or HTML missing");
      return;
    }
    opts = opts || {};
    plog("openInline", "entry", { templateName: opts.templateName, layout: opts.layout, hasData: !!opts.data });

    const isCurrentlyOpen = !els.htmlPreviewModal.classList.contains("hidden");
    const st = htmlPreviewState;
    // 把 null 和 undefined 当成同一种"未保存"身份处理
    const sameCacheId = (opts.cacheId || null) === (st?.id || null);
    if (isCurrentlyOpen && st && opts.templateName === st.templateName && opts.layout === st.layout && sameCacheId) {
      plog("openInline", "→ IN-PLACE MERGE (same slide), opening?", isCurrentlyOpen);
      // 原地更新：合并 data，不动 onConfirm
      st.data = Object.assign({}, st.data, opts.data || {});
      if (opts.palette) st.palette = Object.assign({}, st.palette, opts.palette);
      if (opts.slideHint != null) st.slideHint = opts.slideHint;
      if (typeof opts.onConfirm === "function" && st.onConfirm && st.onConfirm !== opts.onConfirm) {
        try { st.onConfirm(null); } catch (e) {}
        st.onConfirm = opts.onConfirm;
      } else if (typeof opts.onConfirm === "function" && !st.onConfirm) {
        st.onConfirm = opts.onConfirm;
      }
      renderHtmlPreviewFields();
      renderHtmlPreviewIntoIframe();
      updateHtmlPreviewActionButtons();
      renderHtmlTemplateGallery(); // 历史可能产生了新条目，高亮也要更新
      return;
    }

    htmlPreviewState = opts.templateName ? {
      id: opts.cacheId || null,
      templateName: opts.templateName,
      layout: opts.layout,
      data: Object.assign({}, opts.data || {}),
      palette: Object.assign({}, opts.palette || {}),
      slideHint: opts.slideHint || null,
      // 预览打开时**当前选中**的幻灯片号；后续点「替换当前选中」用它定位，
      // 不再依赖 dialog 关闭后可能不准的 ActiveWindow.View.Slide
      activeSlideIndex: typeof opts.activeSlideIndex === "number" ? opts.activeSlideIndex : null,
      onConfirm: typeof opts.onConfirm === "function" ? opts.onConfirm : null
    } : null;
    plog("openInline", "state replaced; htmlPreviewState =", htmlPreviewState ? `{${htmlPreviewState.templateName}/${htmlPreviewState.layout}}` : "null");
    if (htmlPreviewState) {
      els.htmlPreviewTemplate.textContent = htmlPreviewState.templateName;
      els.htmlPreviewLayout.textContent = htmlPreviewState.layout;
      els.htmlPreviewInfo.textContent = "正在渲染…";
    } else {
      els.htmlPreviewTemplate.textContent = "—";
      els.htmlPreviewLayout.textContent = "—";
      els.htmlPreviewInfo.textContent = "从右侧历史里挑一条预览或编辑";
      pwarn("openInline", "state is NULL — request had no templateName. iframe will show placeholder, NOT real slide.");
      if (els.htmlPreviewFrame) els.htmlPreviewFrame.srcdoc = "<!doctype html><html><body style='display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-family:sans-serif'>从历史里选一条开始</body></html>";
    }
    // 切到新 slide → 清空右侧"美化当前预览"chat（同一 slide key 时不动）
    resetPreviewChatForState(htmlPreviewState);
    updateHtmlPreviewHistoryBadge();
    updateHtmlPreviewActionButtons();
    renderHtmlPreviewFields();
    tryExpandTaskPaneForPreview();
    // 画廊永久可见，每次打开/state 切换都刷新（更新 active 高亮）
    renderHtmlTemplateGallery();
    els.htmlPreviewModal.classList.remove("hidden");
    if (opts.historyMode) {
      toggleHtmlPreviewHistoryPanel(true);
    }
    // 等 modal 显示完了再算 scale（否则 inner.clientWidth=0）
    requestAnimationFrame(() => {
      if (htmlPreviewState) renderHtmlPreviewIntoIframe();
      applyHtmlPreviewScale();
      // 监听窗口/弹窗大小变化，重新算 scale
      if (htmlPreviewResizeObserver) htmlPreviewResizeObserver.disconnect();
      try {
        htmlPreviewResizeObserver = new ResizeObserver(applyHtmlPreviewScale);
        if (els.htmlPreviewFrame?.parentElement) {
          htmlPreviewResizeObserver.observe(els.htmlPreviewFrame.parentElement);
        }
      } catch (e) {
        // 老 WebView 没 ResizeObserver，退化到 window resize
        window.addEventListener("resize", applyHtmlPreviewScale);
      }
    });
  }

  function closeHtmlPreviewModal() {
    els.htmlPreviewModal?.classList.add("hidden");
    if (htmlPreviewResizeObserver) {
      htmlPreviewResizeObserver.disconnect();
      htmlPreviewResizeObserver = null;
    }
    tryRestoreTaskPaneAfterPreview();
    // 关 modal **不**清 chat：store 按 slide key 持久化，下次切回同一 slide 还能看到。
    // 只断开当前绑定 + 清 in-flight 的 AI 上下文数组，下次 reset 会重新从 store 回放。
    _previewChatBoundKey = "";
    previewChatHistory.length = 0;
    // 关 modal 也退出编辑模式（清掉 iframe 内的注入痕迹）
    if (_editorEnabled) disableIframeEditor();
    // 用户关闭 = 取消：通知 onConfirm 为 null
    const st = htmlPreviewState;
    htmlPreviewState = null;
    if (st?.onConfirm) {
      try { st.onConfirm(null); } catch (e) {}
    }
  }

  // 模板画廊：列出所有 templates × layouts，每个一张缩略 iframe（按当前色板渲染样例数据）。
  // 点击 → 关闭画廊 + 打开预览 modal 并载入该模板/布局的初始数据。
  function buildSampleData(layoutName) {
    // 用于画廊缩略图与点击后载入的演示用数据
    switch (layoutName) {
      case "cover": return { title: "灵犀 AI\n演示文稿", subtitle: "你的副标题", tag: "2026 KEYNOTE" };
      case "section": return { number: "01", title: "章节标题", footer: "SECTION" };
      case "content": return { title: "核心要点", body: "第一条要点\n第二条要点\n第三条要点", tag: "OVERVIEW", footer: "" };
      case "stat": return { number: "98%", label: "增长率", description: "相较上一周期" };
      case "feature-grid": return {
        title: "我们的四大优势",
        items: "lightbulb|创意驱动|从用户痛点出发\nzap|快速执行|两周交付 MVP\nshield|稳定保障|99.9% SLA\nusers|协作高效|跨职能共建"
      };
      case "quote": return {
        quote: "设计的本质不是好看，\n而是把复杂变得可理解。",
        author: "Dieter Rams",
        role: "Designer"
      };
      case "comparison": return {
        title: "传统方式 vs 灵犀 AI",
        leftIcon: "x-circle",
        leftLabel: "传统方式",
        leftBody: "手工排版耗时\n配色全凭手感\n字体混用混乱\n改一处全页重排",
        rightIcon: "check-circle",
        rightLabel: "灵犀 AI",
        rightBody: "一句话生成\n色板自动统一\n字体白名单约束\n字段独立可微调"
      };
      case "metric-trio": return {
        title: "上季度关键指标",
        items: "trending-up|+247%|增长率|相较上季度\nusers|12.4M|月活|稳定增长\nactivity|99.9%|可用性|过去 30 天"
      };
      default: return {};
    }
  }

  function currentPaletteForPreview() {
    const settings = currentSettings || {};
    const sp = settings.stylePreset || {};
    const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const matched = sp.scheme && schemes[sp.scheme];
    return {
      backgroundColor: sp.backgroundColor || matched?.backgroundColor || "#FFFFFF",
      surfaceColor: sp.surfaceColor || matched?.surfaceColor || "#F4F4F5",
      primaryColor: sp.primaryColor || matched?.primaryColor || "#1A1A1A",
      secondaryColor: sp.secondaryColor || matched?.secondaryColor || "#525252",
      accentColor: sp.accentColor || matched?.accentColor || "#FF5722",
      titleColor: sp.titleColor || matched?.titleColor || "#1A1A1A",
      bodyColor: sp.bodyColor || matched?.bodyColor || "#404040",
      titleFont: sp.titleFont || matched?.titleFont || "Microsoft YaHei",
      bodyFont: sp.bodyFont || matched?.bodyFont || "Microsoft YaHei"
    };
  }

  // 组件缩略图：跟实际插入 PPT 完全一致地渲染（走 studio/freeform 同一条 render）。
  // - 整个 1920×1080 slide 背景可见（palette.backgroundColor 等）
  // - 组件流式定位到 .stage 左上角（覆盖被保存时带的 absolute top/left）
  // - 整张 slide 按 thumb 比例缩放，跟其他模板/历史卡片视觉一致
  function makeComponentThumbHtml(comp, palette) {
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const freeform = HtmlTpl?.getTemplate?.("studio")?.layouts?.freeform;
    // 让组件在 preview 里贴左上角：
    //   - .stage 直接子元素强制 position: static + 清掉 top/left/transform/margin（覆盖原本可能写死的 absolute 偏移）
    //   - .stage 自身改成 flex 列方向 + 顶端对齐 + 左对齐
    //   - 给一点点 padding 防止零像素贴边（视觉留白）
    const previewResetCss = `
      /* preview: 强制组件流式从左上角开始 */
      .stage { padding: 40px !important; display: flex !important; flex-direction: column !important; align-items: flex-start !important; justify-content: flex-start !important; gap: 24px !important; }
      .stage > * { position: static !important; top: auto !important; left: auto !important; right: auto !important; bottom: auto !important; transform: none !important; margin: 0 !important; }
    `;
    if (freeform) {
      try {
        return freeform.render({ html: comp.html || "", css: (comp.css || "") + previewResetCss }, palette || {});
      } catch (e) { /* fall through 老路径兜底 */ }
    }
    // 兜底：freeform 模块未加载时用老的 inline wrapper（保留以防回归）
    const p = palette || {};
    const bg = p.backgroundColor || "#FFFFFF";
    const bodyColor = p.bodyColor || "#404040";
    const bodyFont = (p.bodyFont || "Microsoft YaHei") + ", 'Microsoft YaHei', sans-serif";
    return `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; }
body { background: ${bg}; color: ${bodyColor}; font-family: ${bodyFont}; }
${comp.css || ""}
</style></head><body>${comp.html || ""}</body></html>`;
  }

  // 组件缩略图缩放：iframe 内是 1920×1080 完整 slide，按 thumb 尺寸等比缩放居中
  // —— 跟历史 / 模板缩略卡同一套缩放策略，组件大小比例真实反映在 slide 里的样子。
  function fitComponentThumb(ifr, thumbWrap) {
    try {
      if (!ifr || !thumbWrap) return;
      const cw = thumbWrap.clientWidth;
      const ch = thumbWrap.clientHeight;
      if (!(cw > 0 && ch > 0)) return;
      // iframe 自身必须撑到 1920×1080，否则 transform scale 是基于错误尺寸
      ifr.style.position = "absolute";
      ifr.style.top = "50%";
      ifr.style.left = "50%";
      ifr.style.width = "1920px";
      ifr.style.height = "1080px";
      ifr.style.transformOrigin = "center center";
      const sW = cw / 1920;
      const sH = ch / 1080;
      const scale = Math.min(sW, sH) * 0.99;
      ifr.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
    } catch (e) { /* sandbox/timing 异常沉默 */ }
  }

  // 通用：构造一张画廊缩略卡。卡片本身是 16:9 缩略，meta 文字默认透明 hover 时显示。
  // 内联线性 SVG 垃圾桶图标（lucide trash-2 风格）
  const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  function makeGalleryCard({ html, primaryLabel, secondaryLabel, onClick, isActive, fit, onDelete, deleteHint, extraClass }) {
    const card = document.createElement("div");
    card.className = "html-template-gallery-item"
      + (isActive ? " active" : "")
      + (extraClass ? " " + extraClass : "");
    const thumbHost = document.createElement("div");
    thumbHost.className = "html-template-gallery-thumb" + (fit === "component" ? " component-thumb-fit" : "");
    const ifr = document.createElement("iframe");
    ifr.setAttribute("sandbox", "allow-same-origin");
    thumbHost.appendChild(ifr);

    // 同套渲染策略：用 document.open/write/close 主动写入（绕过 WPS WebView 的 srcdoc 渲染 bug，
    // 比如保存后缩略图不更新就是因为 srcdoc 没真正重渲）。
    const finishScale = () => {
      // 桥接 echarts → 缩略图里的 chart / canvas 也能跑
      try { bridgeEchartsToFrame(ifr); } catch (e) {}
      if (fit === "component") {
        try { fitComponentThumb(ifr, thumbHost); } catch (e) {}
        return;
      }
      try {
        const w = thumbHost.clientWidth;
        const h = thumbHost.clientHeight;
        const sW = w > 0 ? (w / 1920) : 0;
        const sH = h > 0 ? (h / 1080) : 0;
        let scale;
        if (sW > 0 && sH > 0) scale = Math.min(sW, sH) * 0.99;
        else if (sW > 0)     scale = sW * 0.99;
        else                 scale = 0.1;
        ifr.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
      } catch (e) {}
    };

    // iframe 必须先进 DOM 才有 contentDocument。已经 appendChild 过了，可以同步写。
    let written = false;
    try {
      const doc = ifr.contentDocument;
      if (doc) {
        doc.open();
        doc.write(html);
        doc.close();
        written = true;
      }
    } catch (e) { /* 跨域 / WebView 限制 */ }

    if (written) {
      // 同步路径成功；下一帧算 scale（让浏览器先完成布局）
      requestAnimationFrame(finishScale);
    } else {
      // 兜底：srcdoc + load
      try { ifr.srcdoc = html; }
      catch (e) {
        try { ifr.srcdoc = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">渲染失败</body></html>`; }
        catch (_) {}
      }
      ifr.addEventListener("load", finishScale);
      // 兜底兜底：500ms 内还没 load 就强算一次 scale
      setTimeout(() => { if (!ifr._scaled) { ifr._scaled = true; finishScale(); } }, 500);
    }
    const meta = document.createElement("div");
    meta.className = "html-template-gallery-meta";
    const p = document.createElement("span");
    p.className = "tpl-name";
    p.textContent = primaryLabel;
    const s = document.createElement("span");
    s.className = "layout-name";
    s.textContent = secondaryLabel;
    meta.appendChild(p);
    meta.appendChild(s);
    card.appendChild(thumbHost);
    card.appendChild(meta);
    // hover 删除按钮：仅当 onDelete 给了才显示。右上角内嵌；点击时不触发卡片 onClick。
    if (typeof onDelete === "function") {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "html-template-gallery-del";
      del.title = deleteHint || "删除";
      del.innerHTML = TRASH_SVG;
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onDelete(ev);
      });
      card.appendChild(del);
    }
    if (onClick) card.addEventListener("click", onClick);
    return card;
  }

  // 当前选中的画廊 tab：history（我的历史，默认）/ components（组件）/ templates（模板）
  let _galleryActiveTab = "history";
  const GALLERY_TABS = ["history", "components", "templates"];

  // 修 #9: 画廊卡片复用缓存。key = 身份（tab+id），sig = 内容签名（ts/palette/draft）。
  // 同 key 同 sig → 复用现有 iframe DOM，避免每次缓存改动都重建 20 个 iframe（WebView 重渲 html2canvas/echarts 极慢）。
  // 同 key 不同 sig → 重建（内容真的变了）。不同 key → 新建或删除。
  const _galleryCardCache = new Map();

  function setGalleryTab(tab) {
    if (!GALLERY_TABS.includes(tab)) return;
    _galleryActiveTab = tab;
    // 同步 tab 按钮 active 高亮
    document.querySelectorAll(".gallery-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.galleryTab === tab);
    });
    renderHtmlTemplateGallery();
  }

  // 「清空所有」按钮：仅在 history / components tab 显示，按当前 tab 决定清谁
  function updateGalleryFootButton() {
    const foot = els.htmlTemplateGalleryFoot;
    const btn = els.htmlTemplateGalleryClearBtn;
    if (!foot || !btn) return;
    const host = els.htmlTemplateGalleryList;
    const hasItems = !!(host && host.querySelector(".html-template-gallery-item"));
    if (_galleryActiveTab === "history") {
      btn.textContent = "清空所有历史";
      foot.classList.toggle("hidden", !hasItems);
    } else if (_galleryActiveTab === "components") {
      btn.textContent = "清空所有组件";
      foot.classList.toggle("hidden", !hasItems);
    } else {
      foot.classList.add("hidden");
    }
  }

  function clearGalleryActiveTab() {
    if (_galleryActiveTab === "history") {
      if (!confirm("清空「我的历史」全部缓存条目？此操作不可撤销。")) return;
      const cache = global.WpsAiHtmlCache;
      let tries = 0;
      while (tries < 3) {
        const list = cache?.list?.(50) || [];
        if (!list.length) break;
        list.forEach((entry) => { try { cache.remove?.(entry.id); } catch (e) {} });
        tries += 1;
      }
      // 同步把跟历史挂钩的 chat 日志清掉
      try {
        previewChatLogByKey.forEach((_v, k) => {
          if (typeof k === "string" && k.startsWith("id::")) previewChatLogByKey.delete(k);
        });
        savePreviewChatLogsToStorage();
      } catch (e) {}
      if (htmlPreviewState?.id) htmlPreviewState.id = null;
      updateHtmlPreviewHistoryBadge();
    } else if (_galleryActiveTab === "components") {
      if (!confirm("清空全部自定义组件？此操作不可撤销。")) return;
      const comps = global.WpsAiHtmlComponents;
      const list = comps?.list?.() || [];
      list.forEach((c) => { try { comps.remove?.(c.id); } catch (e) {} });
      // 清掉所有 slide 对组件的选用引用
      pickedComponentsByKey.clear();
      savePickedComponentsToStorage();
      updatePickedComponentsCountBadge();
    } else {
      return;
    }
    renderHtmlTemplateGallery();
  }

  function renderHtmlTemplateGallery() {
    const host = els.htmlTemplateGalleryList;
    if (!host) return;
    const HtmlTpl = global.WpsAiHtmlTemplates;
    if (!HtmlTpl?.listTemplates) {
      _galleryCardCache.clear();
      host.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">HTML 模板模块未加载</div>';
      return;
    }
    const palette = currentPaletteForPreview();
    const paletteSig = JSON.stringify(palette);

    // 用当前 state 判断哪张卡是"当前"，高亮蓝边
    const curSt = htmlPreviewState;
    const curTplLayout = curSt ? `${curSt.templateName}::${curSt.layout}::${curSt.id || ""}` : "";

    // desc: 这一帧期望渲染的全部卡描述（顺序即视觉顺序）
    // 每条带 key（身份）+ sig（内容签名）+ isActive/extraClass（轻量样式）+ build（首次创建用）
    const desc = [];
    let emptyMsg = "";

    if (_galleryActiveTab === "components") {
      // ---- Tab：组件库（freeform 抽出的可复用 HTML+CSS 片段）----
      const comps = global.WpsAiHtmlComponents?.list?.() || [];
      comps.forEach((comp) => {
        desc.push({
          key: `comp::${comp.id}`,
          sig: `${comp.ts}::${paletteSig}`,
          isActive: false,
          extraClass: "",
          build: () => {
            let html;
            try { html = makeComponentThumbHtml(comp, palette); }
            catch (e) { html = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">${e?.message || e}</body></html>`; }
            return makeGalleryCard({
              html,
              primaryLabel: comp.name,
              secondaryLabel: comp.description || formatHtmlPreviewTs(comp.ts),
              isActive: false,
              fit: "component",
              onClick: () => {
                openHtmlPreviewModal({
                  templateName: "studio",
                  layout: "freeform",
                  data: { html: comp.html, css: comp.css || "" },
                  palette: currentPaletteForPreview()
                });
              },
              deleteHint: `从组件库删除「${comp.name}」`,
              onDelete: () => {
                if (!confirm(`从组件库删除「${comp.name}」？此操作不可撤销。`)) return;
                global.WpsAiHtmlComponents?.remove?.(comp.id);
                pickedComponentsByKey.forEach((arr, k) => {
                  const filtered = arr.filter((x) => x !== comp.id);
                  if (filtered.length !== arr.length) {
                    if (filtered.length) pickedComponentsByKey.set(k, filtered);
                    else pickedComponentsByKey.delete(k);
                  }
                });
                savePickedComponentsToStorage();
                updatePickedComponentsCountBadge();
                renderHtmlTemplateGallery();
              }
            });
          }
        });
      });
      if (!desc.length) emptyMsg = '组件库空空如也。<br>在 freeform 预览底部点「保存为组件」往里加。';
    } else if (_galleryActiveTab === "templates") {
      // ---- Tab：模板 × 布局（用样例数据渲染缩略图）----
      const slugs = HtmlTpl.listTemplates();
      slugs.forEach((slug) => {
        const tpl = HtmlTpl.getTemplate(slug);
        const layouts = HtmlTpl.listLayouts(slug);
        layouts.forEach((layoutName) => {
          const cardKey = `${slug}::${layoutName}::`;
          const isActive = curTplLayout === cardKey;
          desc.push({
            key: `tpl::${slug}::${layoutName}`,
            // 模板缩略图只依赖 palette；palette 变了要重建
            sig: paletteSig,
            isActive,
            extraClass: "",
            build: () => {
              let html;
              try {
                html = tpl.layouts[layoutName].render(buildSampleData(layoutName), palette);
              } catch (e) {
                html = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">${e?.message || e}</body></html>`;
              }
              return makeGalleryCard({
                html,
                primaryLabel: slug,
                secondaryLabel: layoutName,
                isActive,
                onClick: () => {
                  openHtmlPreviewModal({
                    templateName: slug,
                    layout: layoutName,
                    data: buildSampleData(layoutName),
                    palette: currentPaletteForPreview()
                  });
                }
              });
            }
          });
        });
      });
      if (!desc.length) emptyMsg = '暂无可用模板';
    } else {
      // ---- Tab：我的历史（从缓存读）----
      const cache = global.WpsAiHtmlCache;
      const entries = cache?.list?.(20) || [];
      entries.forEach((entry) => {
        const cardKey = `${entry.templateName}::${entry.layout}::${entry.id}`;
        const isActive = curTplLayout === cardKey;
        desc.push({
          key: `hist::${entry.id}`,
          // 历史卡 sig = ts（保存/编辑后 cache.update 会刷新 ts）+ palette + draft 状态
          sig: `${entry.ts}::${paletteSig}::${entry.draft ? "d" : "n"}`,
          isActive,
          extraClass: entry.draft ? "is-draft" : "",
          build: () => {
            const tpl = HtmlTpl.getTemplate(entry.templateName);
            const layoutDef = tpl?.layouts?.[entry.layout];
            let html;
            if (!layoutDef) {
              html = `<html><body style="padding:20px;font-family:sans-serif;color:#888">模板已下线：${entry.templateName} / ${entry.layout}</body></html>`;
            } else {
              try {
                const effectivePalette = Object.assign({}, palette, entry.palette || {});
                html = layoutDef.render(entry.data || {}, effectivePalette);
              } catch (e) {
                html = `<html><body style="padding:20px;font-family:sans-serif;color:#c00">${e?.message || e}</body></html>`;
              }
            }
            const firstField = Object.values(entry.data || {})[0] || "";
            const primaryLabel = entry.draft
              ? `${entry.templateName} · 草稿`
              : entry.templateName;
            return makeGalleryCard({
              html,
              primaryLabel,
              secondaryLabel: String(firstField).slice(0, 24) || formatHtmlPreviewTs(entry.ts),
              isActive,
              extraClass: entry.draft ? "is-draft" : "",
              onClick: () => {
                openHtmlPreviewModal({
                  cacheId: entry.id,
                  templateName: entry.templateName,
                  layout: entry.layout,
                  data: Object.assign({}, entry.data || {}),
                  palette: Object.assign({}, entry.palette || {}),
                  slideHint: entry.slideHint || null
                });
              },
              deleteHint: "从「我的历史」删除这条",
              onDelete: () => {
                if (!confirm(`从「我的历史」删除这条（${entry.templateName} / ${entry.layout}）？此操作不可撤销。`)) return;
                cache.remove?.(entry.id);
                const key = `id::${entry.id}`;
                if (previewChatLogByKey.has(key)) {
                  previewChatLogByKey.delete(key);
                  savePreviewChatLogsToStorage();
                }
                if (htmlPreviewState?.id === entry.id) htmlPreviewState.id = null;
                updateHtmlPreviewHistoryBadge();
                renderHtmlTemplateGallery();
              }
            });
          }
        });
      });
      if (!desc.length) emptyMsg = '暂无历史。点「保存」入库后会出现在这里。';
    }

    // ---- diff 应用：复用未变的卡，重建变了的卡，删除不再出现的卡 ----
    // 1) 清掉非卡子节点（如上次留下的空态占位 div）
    Array.from(host.children).forEach((child) => {
      if (!child.dataset || !child.dataset.galleryKey) host.removeChild(child);
    });

    // 2) 空列表：清空全部缓存 + 显示空态文案，提前退出
    if (!desc.length) {
      _galleryCardCache.forEach((e) => {
        if (e.el && e.el.parentNode) e.el.parentNode.removeChild(e.el);
      });
      _galleryCardCache.clear();
      host.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:12px">${emptyMsg}</div>`;
      updateGalleryFootButton();
      return;
    }

    // 3) 删除已不在 desc 里的缓存卡
    const desiredKeys = new Set(desc.map((d) => d.key));
    Array.from(_galleryCardCache.keys()).forEach((k) => {
      if (!desiredKeys.has(k)) {
        const cached = _galleryCardCache.get(k);
        if (cached && cached.el && cached.el.parentNode) cached.el.parentNode.removeChild(cached.el);
        _galleryCardCache.delete(k);
      }
    });

    // 4) 按 desc 顺序就位：sig 不变 → 仅更新 class；变了 → rebuild
    for (let i = 0; i < desc.length; i++) {
      const d = desc[i];
      let cached = _galleryCardCache.get(d.key);
      if (cached && cached.sig !== d.sig) {
        if (cached.el && cached.el.parentNode) cached.el.parentNode.removeChild(cached.el);
        _galleryCardCache.delete(d.key);
        cached = null;
      }
      let el;
      if (cached) {
        el = cached.el;
        // 仅切换 active / draft class，不重建 iframe
        el.className = "html-template-gallery-item"
          + (d.isActive ? " active" : "")
          + (d.extraClass ? " " + d.extraClass : "");
      } else {
        el = d.build();
        el.dataset.galleryKey = d.key;
        _galleryCardCache.set(d.key, { el, sig: d.sig });
      }
      const cur = host.children[i];
      if (cur !== el) host.insertBefore(el, cur || null);
    }
    // 5) 兜底：移除任何尾部多余节点（理论上 4 步后正好等长）
    while (host.children.length > desc.length) {
      const extra = host.children[host.children.length - 1];
      const k = extra.dataset && extra.dataset.galleryKey;
      if (k) _galleryCardCache.delete(k);
      host.removeChild(extra);
    }

    updateGalleryFootButton();
  }

  // 画廊改成永久可见的侧栏。此函数现在只用来"刷新内容"；保留签名向后兼容。
  function toggleHtmlTemplateGallery(_show) {
    if (!els.htmlTemplateGallery) return;
    renderHtmlTemplateGallery();
  }

  // ===== 独立预览 chat 会话 =====
  // 这是一个隔离的小聊天，**不进主对话历史**，**不调任何 PPT 工具**。
  // 实现：直接调当前 provider 的 streamChat，给一个强约束的 system prompt，要求 AI 只
  // 输出 JSON 描述要更新的字段；解析后直接 patch 到 htmlPreviewState.data，触发 iframe 重渲。
  // 优点：完全隔离 + 简单可控；不依赖 OpenAI tools 协议。
  //
  // 持久化：每个 slide（state key = templateName::layout::id）独立保存自己的对话历史，
  // 切换历史时自动回显。previewChatLogByKey 是真相源；previewChatHistory 是给 AI 的
  // 上下文，等于 previewChatLogByKey[currentKey] 里过滤掉纯展示型条目（如 ai-err、
  // ai-pending）的 {role,content} 序列。

  // 每条记录形状：{ role: "user"|"ai"|"ai-err"|"ai-pending", displayText: string, aiContent?: string }
  // - role: 决定气泡样式（同 appendPreviewChatMsg 的 role 参数）
  // - displayText: 实际显示在气泡里的人类可读文本
  // - aiContent: 仅对要进 AI 上下文的条目（user / ai 成功），用于喂给下一轮 LLM
  const previewChatLogByKey = new Map();
  // 给 AI 用的视图：每次提交前从当前 key 的日志里抽出 {role,content}（role 转 "user"|"assistant"）
  const previewChatHistory = [];

  // Preview 是用 Application.ShowDialog 开的独立 WebView 窗口，关闭再开是全新 JS context，
  // in-memory Map 会丢。把 chat 日志持久化到 localStorage，保证跨 dialog 开关 + 切换历史能回显。
  const PREVIEW_CHAT_LOG_KEY = "lingxi_html_preview_chat_log_v1";
  function loadPreviewChatLogsFromStorage() {
    try {
      const raw = localStorage.getItem(PREVIEW_CHAT_LOG_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((k) => {
          if (Array.isArray(parsed[k])) previewChatLogByKey.set(k, parsed[k]);
        });
      }
    } catch (e) { /* 解析失败就当没有，正常往下走 */ }
  }
  function savePreviewChatLogsToStorage() {
    try {
      const obj = {};
      previewChatLogByKey.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(PREVIEW_CHAT_LOG_KEY, JSON.stringify(obj));
    } catch (e) { /* localStorage 满了/不可用，沉默 */ }
  }
  // 模块加载就立刻读一次，给后续切换历史 + 工具回调一份热数据
  loadPreviewChatLogsFromStorage();

  // 把 text 插入到 textarea/input 当前光标位置；自动触发 input 事件。
  // 给 paste 手动处理用，WPS WebView 部分版本默认 paste 失灵的兜底。
  function insertAtCursor(el, text) {
    if (!el) return;
    const value = el.value || "";
    const start = el.selectionStart != null ? el.selectionStart : value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : value.length;
    el.value = value.slice(0, start) + text + value.slice(end);
    // setRangeText 在某些 WebView 报错，直接改 value + 手动设光标更稳
    const caret = start + text.length;
    try {
      el.selectionStart = caret;
      el.selectionEnd = caret;
    } catch (e) { /* readonly 等场景跳过 */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const PREVIEW_CHAT_EMPTY_HTML = '<div class="html-preview-chat-empty">让 AI 帮你改预览：<br>· 改文字 ——「标题改短」「数字换成 73%」<br>· 切排版 ——「换成有图标的网格」「改成大数字版式」<br>· 调配色 ——「换成深色背景」「主色改成蓝色」<br>· 整体美化 ——「美化排版」「更专业」</div>';

  // 把一条消息渲染到聊天框 DOM。不写存储 —— 那是 appendPreviewChatMsg 的事。
  function renderPreviewChatBubble(role, text) {
    const log = els.htmlPreviewChatLog;
    if (!log) return null;
    const empty = log.querySelector(".html-preview-chat-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = `html-preview-chat-msg ${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  // 给一个 state 算唯一 key（用于 per-slide chat 持久化）
  // - 已保存到缓存（有 id） → 用 id 作为身份，layout 在编辑中变化不影响 chat 归属
  // - 未保存（无 id） → 用 template+layout，保存时 saveHtmlPreviewToCache 会把日志搬到新 id key
  function previewStateKey(st) {
    if (!st) return "";
    if (st.id) return `id::${st.id}`;
    return `unsaved::${st.templateName || ""}::${st.layout || ""}`;
  }

  // 拿当前 key 的存储数组；不存在就建一个
  function currentChatLogStore() {
    const key = _previewChatBoundKey;
    if (!key) return null;
    if (!previewChatLogByKey.has(key)) previewChatLogByKey.set(key, []);
    return previewChatLogByKey.get(key);
  }

  // 写一条消息：渲染到 DOM + 存到当前 key 的日志（pending 不存）+ 同步喂给 AI 上下文
  // aiContent 给 ai 成功气泡用，作为下一轮 LLM 的 assistant content
  function appendPreviewChatMsg(role, text, aiContent) {
    const bubble = renderPreviewChatBubble(role, text);
    if (role === "ai-pending") return bubble; // 临时占位，不持久化也不进 AI 上下文
    const store = currentChatLogStore();
    if (store) {
      store.push({ role, displayText: text, aiContent: aiContent || null });
      savePreviewChatLogsToStorage();
    }
    // 同步 AI 上下文（previewChatHistory）—— user 进、ai 成功的 aiContent 进，
    // ai-err 不进（避免污染上下文）
    if (role === "user") {
      previewChatHistory.push({ role: "user", content: text });
    } else if (role === "ai" && aiContent) {
      previewChatHistory.push({ role: "assistant", content: aiContent });
    }
    return bubble;
  }

  // 把 store 重放到 DOM（切回历史会话时用）+ 同步重建 AI 上下文 previewChatHistory
  function renderPreviewChatFromStore() {
    const log = els.htmlPreviewChatLog;
    if (!log) return;
    log.innerHTML = "";
    previewChatHistory.length = 0;
    const store = currentChatLogStore();
    if (!store || !store.length) {
      log.innerHTML = PREVIEW_CHAT_EMPTY_HTML;
      return;
    }
    store.forEach((entry) => {
      renderPreviewChatBubble(entry.role, entry.displayText);
      // 给 AI 喂上下文：仅 user / ai 成功条目
      if (entry.role === "user") {
        previewChatHistory.push({ role: "user", content: entry.displayText });
      } else if (entry.role === "ai" && entry.aiContent) {
        previewChatHistory.push({ role: "assistant", content: entry.aiContent });
      }
    });
  }

  // 用户点「清空会话」时调：当前 slide 的 chat 全清
  function clearPreviewChatLog() {
    const key = _previewChatBoundKey;
    if (key) {
      previewChatLogByKey.set(key, []);
      savePreviewChatLogsToStorage();
    }
    previewChatHistory.length = 0;
    const log = els.htmlPreviewChatLog;
    if (log) log.innerHTML = PREVIEW_CHAT_EMPTY_HTML;
  }

  // 当前 chat 会话绑定的 state key
  let _previewChatBoundKey = "";
  // state 切到新 slide：先把当前 key 的 chat 留在 Map 里（已经在写时持久化了），
  // 再把新 key 的 chat 回放到 DOM。同 key 直接 return。
  function resetPreviewChatForState(newSt) {
    const key = previewStateKey(newSt);
    if (key === _previewChatBoundKey) return;
    _previewChatBoundKey = key;
    renderPreviewChatFromStore();
  }

  // 调当前 provider 出一次响应。返回累积的 raw 文本。
  async function callProviderForPreviewChat(messages, onToken) {
    const reg = global.WpsAiProviderRegistry;
    if (!reg) throw new Error("provider registry 未加载");
    const config = reg.getActiveChatProvider?.() || reg.getActiveConfig?.();
    if (!config) throw new Error("当前没有可用 provider，先在设置里配一个");
    const provider = reg.buildProvider(config);
    const model = els.modelSelect?.value || config.defaultModel || "gpt-4o-mini";
    let raw = "";
    if (provider.streamChat) {
      await provider.streamChat({
        model,
        messages,
        onToken: (tok) => {
          raw += tok;
          if (onToken) onToken(tok, raw);
        }
      });
    } else if (provider.chat) {
      const resp = await provider.chat({ model, messages });
      raw = typeof resp === "string" ? resp : (resp?.content || resp?.text || JSON.stringify(resp));
      if (onToken) onToken(raw, raw);
    } else {
      throw new Error("当前 provider 不支持 chat 接口");
    }
    return raw;
  }

  // 解析 AI 的 JSON 输出，宽容处理 markdown 围栏。
  // 修 #11: AI 经常在 JSON patch 前后塞解释文字甚至 `{"看起来像 JSON"}` 的示例，
  // 老路径用 first {/ last } 会把中间无关文本一起 parse 失败。新策略：
  //   1) 优先匹配 markdown 围栏 ```json ... ```
  //   2) 失败：扫描全文，按括号配平找出**所有顶层对象**，挑最长且能 JSON.parse 的那个
  //   3) 全部失败：fallback 到 first {/ last } 老路径（兜底，跟过去行为一致）
  function parsePreviewChatJson(raw) {
    const s = String(raw || "").trim();

    // ① markdown 围栏 — 注意 [\s\S] 避免 . 不匹配换行
    const fenceMatch = s.match(/```(?:json|JSON)?\s*([\s\S]+?)```/);
    if (fenceMatch) {
      const inner = fenceMatch[1].trim();
      try { return JSON.parse(inner); } catch (_) { /* 围栏内不是合法 JSON，往下走 */ }
    }

    // ② 扫描配平花括号，列出所有顶层 {...}
    const candidates = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(s.slice(start, i + 1));
          start = -1;
        } else if (depth < 0) {
          // 不配平就重置
          depth = 0;
          start = -1;
        }
      }
    }
    // 按长度倒序，挑第一个能 parse 的
    candidates.sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (_) {}
    }

    // ③ 兜底：老路径
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first < 0 || last < 0 || last < first) throw new Error("找不到 JSON 对象");
    return JSON.parse(s.slice(first, last + 1));
  }

  async function submitHtmlPreviewChat() {
    const ta = els.htmlPreviewChatInput;
    if (!ta) return;
    const userText = (ta.value || "").trim();
    if (!userText) return;
    const st = htmlPreviewState;
    if (!st) {
      appendPreviewChatMsg("ai-err", "当前没有预览，无法编辑。");
      return;
    }
    ta.value = "";
    appendPreviewChatMsg("user", userText);

    // 构造焦点 system prompt：让 AI 输出 JSON patch（可改字段值 + 切布局 + 调配色）
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    const fieldList = tpl?.layouts?.[st.layout]?.fields || Object.keys(st.data || {});
    const allLayouts = Object.keys(tpl?.layouts || {});
    // 列出每个布局对应的字段，方便 AI 选 layout 时知道要填什么
    const layoutSchemas = allLayouts.map((name) => {
      const fs = tpl?.layouts?.[name]?.fields || [];
      return `  - ${name}: [${fs.join(", ")}]`;
    }).join("\n");
    const paletteKeys = ["primaryColor", "accentColor", "backgroundColor", "surfaceColor", "titleColor", "bodyColor", "titleFont", "bodyFont"];

    // 用户已经在「PPT 风格设置」里挑过整套视觉风格 —— 把这个 ground truth 喂给 AI，
    // 让它默认锁住这套配色 + 字体，不要每次美化都换风格导致整组 PPT 不统一。
    const sp = currentSettings?.stylePreset || {};
    const presetEnabled = !!sp.enabled;
    const presetPaletteFull = currentPaletteForPreview();
    const presetSchemeName = presetEnabled ? (sp.scheme || "custom") : "（未启用 PPT 风格 → 用当前 state 自带 palette）";
    const styleConsistencyBlock = presetEnabled
      ? [
          `用户的**全局 PPT 风格**：${presetSchemeName}`,
          `全局风格的配色 + 字体（JSON）：${JSON.stringify(presetPaletteFull, null, 2)}`,
          "→ 默认必须用这套配色和字体，整组 PPT 视觉才能保持统一。**禁止**因为一句「美化」就换主题色或换字体。"
        ].join("\n")
      : `（用户未启用全局 PPT 风格设置，可自由配色。当前 state 的 palette: ${JSON.stringify(st.palette || {}, null, 2)}）`;

    // 用户挑选的"必须复用"组件 —— 注入它们的 html/css，让 AI 在新页里复用相同的视觉单元。
    // 整组 PPT 因此能形成"组件层级的一致性"（不是只有色板一致，而是相同的卡片样式 / 数据卡 / 时间轴样式等）。
    // 修 #8: 单组件 html+css 超过 3KB 截断尾部；总长度超 15KB 在 chat 里给警告
    const pickedIds = getPickedComponentIds();
    const pickedComponents = pickedIds.length
      ? (global.WpsAiHtmlComponents?.getMany?.(pickedIds) || [])
      : [];
    const SINGLE_LIMIT = 3000;   // 单个组件 html / css 各上限 3000 字符
    const TOTAL_WARN_LIMIT = 15000; // 总长度超此值给警告
    function truncCode(code, max) {
      const s = String(code || "");
      if (s.length <= max) return s;
      return s.slice(0, max) + `\n/* ... 已截断 ${s.length - max} 字符，仅保留前 ${max}；完整 HTML/CSS 请用 wpp_get_component 查询 */`;
    }
    let pickedTotalLen = 0;
    const componentReuseBlock = pickedComponents.length
      ? [
          `用户**手动选了 ${pickedComponents.length} 个**组件库里的组件，要求 AI 在当前页里复用它们（保持全册 PPT 视觉一致）：`,
          ...pickedComponents.map((c, i) => {
            const htmlSafe = truncCode(c.html, SINGLE_LIMIT);
            const cssSafe = truncCode(c.css, SINGLE_LIMIT);
            pickedTotalLen += htmlSafe.length + cssSafe.length;
            return [
              `\n--- 组件 ${i + 1}: ${c.name} ---`,
              c.description ? `用途说明：${c.description}` : "",
              `HTML：\n${htmlSafe}`,
              cssSafe ? `CSS：\n${cssSafe}` : "（无独立 CSS，复用 stage 默认样式）"
            ].filter(Boolean).join("\n");
          }),
          "\n→ 切到 layout=freeform，把上述组件**逐字符**搬到 freeform 的 html/css 里组合使用；可以多次复用（一个网格里铺多张同款卡），但不要改它们的 class 名 / 样式，否则就失去「复用」的意义。",
          "→ 如果用户当前页的字段已经有内容（title/body 等），把这些内容**填进**复用过来的组件占位里，不要丢；组件外多余的视觉装饰可以自由发挥。"
        ].join("\n")
      : "";
    // 注入长度警告：超 15KB 时 chat 里弹一条 ai-err，让用户知道可能爆 context
    if (pickedTotalLen > TOTAL_WARN_LIMIT) {
      try {
        appendPreviewChatMsg("ai-err",
          `⚠ 选中的 ${pickedComponents.length} 个组件总长度约 ${(pickedTotalLen / 1000).toFixed(1)} KB，` +
          `可能撞到某些模型的 context 上限（如 DeepSeek-V2 32K）。建议精简到 3-5 个核心组件。`
        );
      } catch (e) {}
    }

    const systemPrompt = [
      "你是 HTML 幻灯片预览编辑助手。可以做三件事：①改字段文字 ②切换排版布局（含 freeform 自由设计） ③调整配色。",
      "",
      `当前模板：${st.templateName}`,
      `当前布局：${st.layout}`,
      `当前可编辑字段（严格使用这些 key，区分大小写）：${fieldList.join(", ")}`,
      `当前字段值（JSON）：${JSON.stringify(st.data || {}, null, 2)}`,
      `当前配色（JSON）：${JSON.stringify(st.palette || {}, null, 2)}`,
      "",
      styleConsistencyBlock,
      ...(componentReuseBlock ? ["", componentReuseBlock] : []),
      "",
      `本模板可选的全部布局（key: [必填字段]）：\n${layoutSchemas}`,
      "",
      `配色可用 key：${paletteKeys.join(", ")}；颜色用 #RRGGBB，字体用 CSS font-family 字符串。`,
      "",
      "**只输出一段 raw JSON**，禁止任何解释、寒暄、markdown 围栏。格式：",
      '{"layout": "可选-切到新布局名", "data": {"字段名": "新值", ...}, "palette": {"primaryColor": "#xxxxxx", ...}}',
      "",
      "规则：",
      "1. **必须积极改动**：用户说「美化」「优化」「更好看」「更专业」「换个排版」「太死板了」等模糊指令时，主动做出实质改动 —— 优先考虑切 freeform 自己设计，配上协调的配色。绝对不要返回空对象让用户再说一遍。",
      "2. **切排版时内容必须 1:1 保留**：layout 字段一旦给值，必须把现有 data 里所有非空字段的**原文**完整搬到新布局的对应字段里 —— 只能在字段之间重新分配/合并/拆分，**严禁改写、概括、缩短、补充、删除任何文字**。例如：",
      "   - 原 cover (title=\"项目背景\", subtitle=\"2024 年 Q3 复盘\") → content：必须填 {\"title\": \"项目背景\", \"body\": \"2024 年 Q3 复盘\"}，title 与 subtitle 的原文一字不改。",
      "   - 切 freeform 时：把所有原文（包括 title、subtitle、body、items 里的每一行、tag、footer 等）**全部**渲染到 freeform 的 HTML 里，不能丢任何一句话。",
      "   如果用户明确说「同时把文案改得更精炼」「重写下标题」之类的指令，才可以改写文字；否则一律保留原文。",
      "3. **何时用 freeform**（重点）：现有 8 个固定 layout 表达不下原内容、或用户要求精致 / 商务 / 科技 / 杂志感等设计风格时，**直接切到 layout=freeform**，自己写完整 body HTML + CSS，不要硬塞进 stat / quote 这种小容量布局丢数据。freeform 没有字段 schema 约束，data 只有两个 key：",
      "   - `html`: 完整的 body 内容（不要包 <html>/<head>/<body>，stage 已经是 1920×1080 画布）。所有文本必须 HTML-escape（用实体 &amp; / &lt; / &gt; / &quot;）。",
      "   - `css`: 自定义 CSS（可选）。可用全局 CSS 变量：var(--bg) / var(--surface) / var(--primary) / var(--accent) / var(--title-color) / var(--body-color) / var(--title-font) / var(--body-font)。**所有颜色和字体必须用 CSS 变量引用**，不要在 freeform CSS 里硬编码 #RRGGBB 颜色或具体字体名 —— 用户切换全局 PPT 风格时，写死的颜色不会跟着变，整套幻灯片就花了。",
      "   ⚠ **字号必须匹配 PPT 标准磅值**。画布 1920×1080 = 13.333\" → **1pt = 2px**。AI 在脑子里按 PPT pt 思考，转成 px 写到 CSS 里。常用对照（pt → px）：",
      "      10pt=20px · 12pt=24px · 14pt=28px · 16pt=32px · 18pt=36px · 20pt=40px · 22pt=44px · 24pt=48px · 28pt=56px · 32pt=64px · 36pt=72px · 40pt=80px · 44pt=88px · 54pt=108px · 60pt=120px · 72pt=144px · 88pt=176px · 96pt=192px",
      "   各角色推荐字号（PPT 视觉规范 + 上述映射）：",
      "      | 角色                | PPT pt   | CSS px    | 字重    | 备注 |",
      "      | ------------------- | -------- | --------- | ------- | --- |",
      "      | 封面 hero 标题      | 60-96pt  | 120-192px | 800-900 | 单页主标题 |",
      "      | 章节标题 (slide H1) | 40-54pt  | 80-108px  | 800     | 内容页大标题 |",
      "      | 二级标题 / 副标题   | 28-36pt  | 56-72px   | 700     | |",
      "      | 章节眉签 (eyebrow)  | 14-18pt  | 28-36px   | 700     | letter-spacing 0.16em-0.3em |",
      "      | **正文** (p / li)   | **18-22pt** | **36-44px** | 400-500 | **最低 14pt = 28px** |",
      "      | 卡片描述 / 表格单元 | 16-20pt  | 32-40px   | 400     | |",
      "      | metric 数字 (KPI)   | 60-110pt | 120-220px | 900     | 突出指标 |",
      "      | metric 标签         | 16-22pt  | 32-44px   | 700     | 数字旁边的说明 |",
      "      | 页码 / 脚注 / 来源  | 11-14pt  | 22-28px   | 400-600 | |",
      "      | **绝对底线**        | **10pt** | **20px**  |         | 任何细字也**不能小于这个** |",
      "   line-height：标题 1.0-1.15，正文 1.4-1.6（行距对可读性影响大）。",
      "   freeform 视觉建议：左侧 80px 渐变竖条 / 顶部 4px 渐变条作为视觉标识；标题用 var(--title-font) 粗体；卡片用 var(--surface) 背景 + 1px var(--primary) 8% 透明边框；强调色用 var(--accent)；保持 80-100px 内边距；多卡用 grid grid-template-columns。整体气质：商务、科技、留白克制、对齐严谨（参考 Stripe / Linear / Apple Keynote 风格）。",
      "   **大量使用图表 / 可视化丰富页面**：iframe 已加载 ECharts 5 + 内联 canvas 脚本注入器，AI 应该**多用图表**让幻灯片专业：",
      "     - **ECharts 图表**：写 `<div class=\\\"chart\\\" data-echarts-option='{...JSON...}'></div>`，data-echarts-option 里放完整的 ECharts option JSON（注意是 JSON，不是 JS 对象，所有 key 加双引号，无 trailing comma）。常用：bar / line / pie / radar / gauge / funnel / scatter / treemap / sunburst / gauge。配色不写时自动用 palette 的 [primary, accent, body-color, surface] 系列。容器**必须**有明确宽高（width/height），ECharts 才能渲染。例：左边数据卡 + 右边 ECharts 柱状图比较模块。",
      "     - **Canvas 绘制**（图标 / 箭头 / 自定义图形）：写 `<canvas data-canvas-draw=\\\"...JS 代码...\\\" style=\\\"width:200px;height:100px\\\"></canvas>`。data-canvas-draw 里直接写 ctx 操作（变量名：ctx / canvas / w / h），常用于绘制连接箭头、流程图节点、自定义形状。所有颜色必须取自 CSS 变量：用 `getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()` 拿运行时值。",
      "     - **优先级**：能用 ECharts 数据可视化（柱/线/饼/雷达）就别用纯文字描述；能用 canvas 画箭头/流程节点连线就别用 SVG / 文字符号；图表大于文字。",
      "     - 示例 ECharts data-echarts-option（双引号，JSON 合法）：`{\\\"xAxis\\\":{\\\"type\\\":\\\"category\\\",\\\"data\\\":[\\\"Q1\\\",\\\"Q2\\\",\\\"Q3\\\",\\\"Q4\\\"]},\\\"yAxis\\\":{\\\"type\\\":\\\"value\\\"},\\\"series\\\":[{\\\"type\\\":\\\"bar\\\",\\\"data\\\":[120,200,150,80]}]}`",
      "   **错误示范**（不要这样写）：font-size: 14px / 12px / 16px —— 这只到 PPT 里的 7-8pt，投影时基本看不见。",
      "   **正确示范**：章节标题 font-size: 88px (=44pt PPT H1)、正文 font-size: 40px (=20pt 略大正文)、metric 数字 font-size: 160px (=80pt 巨型)。",
      "4. **切布局时也必须填全新布局的必填字段**：找不到对应原文就用最相近的字段补，宁可拼接，也不要留空导致信息丢失。",
      "5. **不切布局时**：data 只放当前布局可编辑字段里的 key；多行文本用 \\n 换行；数字字段保持字符串类型（如 \"73%\"、\"2580\"）。",
      "6. key 必须**逐字符**来自字段列表（区分大小写）。写错 key 等于这次修改作废。",
      "7. **palette 默认锁死**：用户已经配过全局 PPT 风格的话，**绝对不要**主动改 palette —— 即使用户说「美化」「更专业」也只能在 freeform / 排版 / 字段层面下功夫，配色保持现状。只有用户**显式**说「换主色」「背景改深色」「accentColor 改成蓝色」「换成 xxx 色系」时才动 palette；如果改，就给完整的协调一套（背景/卡片浅、文字/标题深、强调色突出），不要只改一个 key。",
      "8. 真没东西可改时（用户问「这是什么模板」「能改哪些」这种纯问答），才返回 {}，JSON 后**不要**加任何文字。",
      "9. 严格遵守输出格式：第一字符必须是 {，最后字符必须是 }。JSON 内字符串里的换行用 \\n，引号用 \\\"，反斜杠用 \\\\。"
    ].join("\n");

    // user 消息已经在 appendPreviewChatMsg("user", userText) 时进了 previewChatHistory
    const messages = [
      { role: "system", content: systemPrompt },
      ...previewChatHistory
    ];

    const pendingMsg = appendPreviewChatMsg("ai-pending", "AI 正在生成…");
    let raw = "";
    try {
      raw = await callProviderForPreviewChat(messages, (_tok, accumulated) => {
        if (pendingMsg) pendingMsg.textContent = accumulated.slice(-180);
      });
      if (pendingMsg) pendingMsg.remove();
    } catch (e) {
      if (pendingMsg) pendingMsg.remove();
      appendPreviewChatMsg("ai-err", `请求失败：${e?.message || e}`);
      return;
    }

    // 解析 JSON 并应用
    let patch;
    try {
      patch = parsePreviewChatJson(raw);
    } catch (e) {
      appendPreviewChatMsg("ai-err", `AI 返回不是合法 JSON：${raw.slice(0, 200)}`);
      return;
    }

    // ---- 1. 布局切换 ----
    // AI 给了 layout 字段：要切换排版。data/fields 按新布局的字段列表来过滤。
    let targetLayout = typeof patch?.layout === "string" ? patch.layout.trim() : "";
    let activeFieldList = fieldList;
    if (targetLayout && targetLayout !== st.layout) {
      // 校验：必须是当前模板存在的 layout（大小写不严格）
      const matched = allLayouts.find((l) => l === targetLayout)
        || allLayouts.find((l) => l.toLowerCase() === targetLayout.toLowerCase())
        || null;
      if (matched) {
        targetLayout = matched;
        activeFieldList = tpl?.layouts?.[matched]?.fields || [];
      } else {
        // 不存在的 layout：忽略切换，保留 data patch
        appendPreviewChatMsg("ai-err", `AI 想切到不存在的布局 "${targetLayout}"，可选：${allLayouts.join(", ")}。\n这次只应用了字段改动。`);
        targetLayout = "";
      }
    } else {
      targetLayout = "";
    }

    // ---- 2. 字段值 patch ----
    // 兼容三种壳：{data: {...}} / {fields: {...}} / 直接 {...} 平铺字段
    let candidate = patch?.data ?? patch?.fields ?? patch;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      candidate = {};
    }
    const lowerMap = {};
    activeFieldList.forEach((k) => { lowerMap[String(k).toLowerCase()] = k; });
    const patchedFields = {};
    const droppedKeys = [];
    const RESERVED = new Set(["data", "fields", "layout", "palette"]);
    Object.keys(candidate).forEach((rawKey) => {
      if (RESERVED.has(rawKey)) return; // 防嵌套壳和顶层字段误入
      const normalized = String(rawKey).trim();
      const mapped = activeFieldList.includes(normalized)
        ? normalized
        : lowerMap[normalized.toLowerCase()] || null;
      if (mapped) {
        patchedFields[mapped] = candidate[rawKey];
      } else {
        droppedKeys.push(rawKey);
      }
    });

    // ---- 3. 配色 patch ----
    const paletteAllowed = new Set(["primaryColor", "accentColor", "backgroundColor", "surfaceColor", "titleColor", "bodyColor", "titleFont", "bodyFont", "secondaryColor"]);
    const palettePatch = {};
    if (patch?.palette && typeof patch.palette === "object" && !Array.isArray(patch.palette)) {
      Object.keys(patch.palette).forEach((k) => {
        if (paletteAllowed.has(k) && patch.palette[k] != null) {
          palettePatch[k] = patch.palette[k];
        }
      });
    }

    const fieldKeys = Object.keys(patchedFields);
    const paletteKeys2 = Object.keys(palettePatch);
    const didLayout = !!targetLayout;
    const didAnything = didLayout || fieldKeys.length > 0 || paletteKeys2.length > 0;

    if (!didAnything) {
      // 给出 AI 原文 + 可用列表，让用户能继续描述
      const preview = String(raw || "").trim().slice(0, 240) || "(空)";
      const lines = ["AI 没做任何修改。"];
      if (droppedKeys.length) lines.push(`收到了不在字段列表里的 key：${droppedKeys.join(", ")}`);
      lines.push(`当前布局可改字段：${fieldList.join(", ")}`);
      lines.push(`可切布局：${allLayouts.join(", ")}`);
      lines.push(`AI 原文：${preview}`);
      appendPreviewChatMsg("ai-err", lines.join("\n"));
      return;
    }

    // 应用 patch：layout > data > palette
    if (didLayout) {
      // 修 #5: 编辑模式下切 layout 之前先确认 —— 用户在 freeform 编辑器里改了一堆元素没保存，
      // chat 让 AI 换 layout 会直接覆盖 DOM 导致改动丢失。先 confirm 一下。
      const fromFreeform = htmlPreviewState.layout === "freeform";
      const targetIsDifferent = targetLayout !== htmlPreviewState.layout;
      if (_editorEnabled && fromFreeform && targetIsDifferent) {
        // 检查当前 iframe 里有没有"在编辑过的痕迹"：transform / 改过 style 的元素，或 stage 内容跟 state.data.html 不一致
        const ifrDoc = els.htmlPreviewFrame?.contentDocument;
        const currentStageHtml = ifrDoc?.querySelector?.(".stage")?.innerHTML || "";
        const stateHtml = htmlPreviewState.data?.html || "";
        const hasUnsavedEdits = currentStageHtml.trim() && currentStageHtml.trim() !== stateHtml.trim();
        if (hasUnsavedEdits) {
          const proceed = window.confirm(
            `当前在编辑模式下，DOM 里有未保存的改动。\n切换排版到「${targetLayout}」会直接覆盖这些改动，无法恢复。\n\n确认要切换吗？\n（建议先点底部「保存」把改动入库，再让 AI 切布局。）`
          );
          if (!proceed) {
            appendPreviewChatMsg("ai-err",
              `已取消切换到 ${targetLayout}，保留当前编辑。\n` +
              `如需切换：先点底部「保存」把当前改动入「我的历史」，再让 AI 切布局。`
            );
            // 跳过 layout 切换，但仍应用 data / palette patch（如果有）
            // 为此 fallback 到 didLayout=false 分支处理
            if (fieldKeys.length) {
              htmlPreviewState.data = Object.assign({}, htmlPreviewState.data, patchedFields);
            }
            if (paletteKeys2.length) {
              htmlPreviewState.palette = Object.assign({}, htmlPreviewState.palette, palettePatch);
            }
            renderHtmlPreviewFields();
            renderHtmlPreviewIntoIframe();
            return;
          }
        }
      }

      // 切布局前先量一下旧布局**可见**字符数 —— 旧布局会渲染哪些字段（fieldList）就量这些字段的总长度。
      // 切完再量新布局可见字符数。如果缩水超过 30% 就警告用户：内容很可能丢失了。
      const measureVisibleChars = (data, fields) => {
        let n = 0;
        (fields || []).forEach((f) => {
          const v = data?.[f];
          if (v != null) n += String(v).length;
        });
        return n;
      };
      const oldVisibleChars = measureVisibleChars(htmlPreviewState.data, fieldList);

      // 切布局：保留旧 data 所有字段（即使新布局不渲染也不丢，切回去还在），AI 给的新值覆盖
      htmlPreviewState.layout = targetLayout;
      htmlPreviewState.data = Object.assign({}, htmlPreviewState.data, patchedFields);
      if (els.htmlPreviewLayout) els.htmlPreviewLayout.textContent = targetLayout;

      // freeform 是用 html 字符串渲染，按 html 长度近似量；其他 layout 按字段长度量
      const newFieldsForMeasure = targetLayout === "freeform"
        ? ["html"]
        : activeFieldList;
      const newVisibleChars = measureVisibleChars(htmlPreviewState.data, newFieldsForMeasure);

      // 内容完整性校验
      if (oldVisibleChars > 0) {
        const ratio = newVisibleChars / oldVisibleChars;
        if (ratio < 0.7 && targetLayout !== "freeform") {
          // 缩水 30%+：很可能丢内容了，强烈建议切 freeform
          appendPreviewChatMsg("ai-err",
            `⚠ 切到 ${targetLayout} 后内容明显缩水（${oldVisibleChars} 字 → ${newVisibleChars} 字，剩 ${Math.round(ratio * 100)}%）。\n` +
            `${targetLayout} 布局容量不够装下原文。建议改用 freeform 让 AI 写自由排版，可以容纳更多内容。\n` +
            `下一句对 AI 说：「换 freeform，把原内容全部保留地重新排版」`
          );
        } else if (ratio < 0.9) {
          // 缩水 10-30%：轻微提示
          appendPreviewChatMsg("ai-err",
            `⚠ 切排版后内容字数变化：${oldVisibleChars} → ${newVisibleChars}（${Math.round(ratio * 100)}%）。如发现内容丢失，可让 AI「把原内容补回，或者换 freeform 重做排版」。`
          );
        }
      }
    } else if (fieldKeys.length) {
      htmlPreviewState.data = Object.assign({}, htmlPreviewState.data, patchedFields);
    }
    if (paletteKeys2.length) {
      htmlPreviewState.palette = Object.assign({}, htmlPreviewState.palette, palettePatch);
    }
    renderHtmlPreviewFields();
    renderHtmlPreviewIntoIframe();
    // AI 切了 layout（freeform ↔ 其他）后，「保存为组件」按钮的可见性要跟着变
    if (didLayout) updateHtmlPreviewActionButtons();

    // 反馈
    const summary = [];
    if (didLayout) summary.push(`切换排版 → ${targetLayout}`);
    if (fieldKeys.length) summary.push(`更新字段：${fieldKeys.join("、")}`);
    if (paletteKeys2.length) summary.push(`调整配色：${paletteKeys2.join("、")}`);
    const tail = droppedKeys.length ? `\n（忽略了不识别的 key：${droppedKeys.join(", ")}）` : "";
    const aiContent = JSON.stringify({
      layout: didLayout ? targetLayout : undefined,
      data: patchedFields,
      palette: palettePatch
    });
    appendPreviewChatMsg("ai", `${summary.join("；")}${tail}`, aiContent);
  }

  // 兜底插入路径：state 没有 onConfirm（用户从历史召回打开、或 onConfirm 已被消费过）时，
  // 直接调模块级 renderAndInsertSlide —— 跟工具主路径走完全同一条管线，**不再**通过
  // tool.handler 重新走一遍工具调用，避免参数解析顺序不一致造成视觉差异（修 #4）。
  // intent: "insert" / "replace"（用 slideHint 目标页） / "replace-active"（用当前选中页）
  async function fallbackInsertFromState(st, intent) {
    const renderAndInsert = global.WpsAiRenderAndInsertSlide;
    if (typeof renderAndInsert !== "function") {
      pwarn("fallbackInsert", "WpsAiRenderAndInsertSlide NOT registered");
      throw new Error("renderAndInsertSlide 共享函数未加载（presentation.js 未初始化？）");
    }
    const params = {
      templateName: st.templateName,
      layout: st.layout,
      data: st.data || {},
      palette: st.palette || {},
      intent: intent || "insert"
    };
    if (intent === "replace" && st.slideHint) {
      params.slide = +st.slideHint;
    } else if (intent === "replace-active") {
      if (typeof st.activeSlideIndex === "number" && st.activeSlideIndex > 0) {
        params.slide = st.activeSlideIndex;
        params.intent = "replace";
      }
    }
    plog("fallbackInsert", "calling renderAndInsert", {
      origIntent: intent,
      finalIntent: params.intent,
      slide: params.slide,
      activeSlideIndex: st.activeSlideIndex,
      slideHint: st.slideHint
    });
    let result;
    try {
      result = await renderAndInsert(params);
      plog("fallbackInsert", "renderAndInsert returned", {
        slide: result?.slide,
        layerCount: result?.layerCount,
        picturePath: result?.picturePath
      });
    } catch (e) {
      pwarn("fallbackInsert", "renderAndInsert THREW", e?.message || String(e), e?.stack);
      throw e;
    }
    return result;
  }

  async function doConfirm(intent) {
    const st = htmlPreviewState;
    plog("doConfirm", "called", {
      intent,
      hasState: !!st,
      stateId: st?.id,
      slideHint: st?.slideHint,
      activeSlideIndex: st?.activeSlideIndex,
      hasOnConfirm: !!st?.onConfirm,
      templateName: st?.templateName,
      layout: st?.layout
    });
    if (!st) {
      closeHtmlPreviewModal();
      return;
    }
    setHtmlPreviewBusy(true);
    try {
      // 写缓存
      try {
        if (st.id) {
          global.WpsAiHtmlCache?.update?.(st.id, {
            data: st.data,
            palette: st.palette,
            slideHint: st.slideHint
          });
        } else {
          const saved = global.WpsAiHtmlCache?.save?.({
            templateName: st.templateName,
            layout: st.layout,
            data: st.data,
            palette: st.palette,
            slideHint: st.slideHint
          });
          if (saved) st.id = saved.id;
        }
      } catch (e) { /* 缓存失败不阻塞 */ }

      if (st.onConfirm) {
        // 工具流：onConfirm 走原插入路径；replace / replace-active 由 onConfirm 内部按 intent 处理
        // 把 activeSlideIndex 一并传过去，让 presentation.js 的 onConfirm 能用稳定的页号
        const onConfirm = st.onConfirm;
        st.onConfirm = null;
        await onConfirm({
          data: st.data,
          palette: st.palette,
          intent,
          activeSlideIndex: typeof st.activeSlideIndex === "number" ? st.activeSlideIndex : null
        });
      } else if (isPreviewDialog) {
        // 在独立 dialog 窗口里的 standalone 流：
        // 这个 WPS 版本下 ShowDialog 是**非阻塞**的（modal=true 不生效），
        // MAIN 的 post-dialog 代码在用户点确认之前就已经跑完了，没法接住 result。
        // 改成：① 走 dialogOnConfirm 写一份"待执行"任务到独立的 PENDING key（不是 RESULT），
        //       ② MAIN 端用 storage 事件监听这个 key，触发时调 renderAndInsertSlide。
        // 这样不依赖 ShowDialog 真的阻塞。
        plog("doConfirm", "isPreviewDialog standalone → 写 PENDING_INSERT 给 MAIN 处理");
        const pendingBlob = {
          ts: Date.now(),
          templateName: st.templateName,
          layout: st.layout,
          data: st.data,
          palette: st.palette,
          intent,
          slideHint: typeof st.slideHint === "number" ? st.slideHint : null,
          activeSlideIndex: typeof st.activeSlideIndex === "number" ? st.activeSlideIndex : null
        };
        try { localStorage.setItem(PREVIEW_DIALOG_PENDING_INSERT_KEY, JSON.stringify(pendingBlob)); } catch (e) {}
        // 用 toast 告诉用户已下发（MAIN 真正完成后会 showMessage success/error）
        showMessage("插入任务已派给主面板执行…", "info");
        return;
      } else {
        // standalone 流，在主 TaskPane 里（inline modal 模式）：直接调工具
        await fallbackInsertFromState(st, intent);
      }
      // 保留预览窗口不关，方便用户继续调字段 / 改排版 / 多次插入。
      // st.onConfirm 已经被消费成 null，下一次按钮点击会走 fallbackInsertFromState（standalone 路径），
      // 效果等同，照样能插入。
      setHtmlPreviewBusy(false);
      // 工具流插完一次后没法再"替换原幻灯片"了（slideHint 已经用过），按钮可见性按 standalone 模式刷新
      updateHtmlPreviewActionButtons();
      // 刷新画廊高亮（cache.id 可能在 doConfirm 头部刚被 save 出来）
      renderHtmlTemplateGallery();
      updateHtmlPreviewHistoryBadge();
      // 显示实际生效的页号——方便用户验证替换是否落到了正确的 slide
      const actualSlide = (intent === "replace-active" && typeof st.activeSlideIndex === "number")
        ? st.activeSlideIndex
        : (intent === "replace" ? st.slideHint : null);
      const successMsg = intent === "replace"
        ? `已替换第 ${actualSlide} 页（预览仍打开，可继续编辑）。`
        : intent === "replace-active"
          ? `已替换当前选中（第 ${actualSlide || "?"} 页，预览仍打开，可继续编辑）。`
          : "已插入到末尾（预览仍打开，可继续编辑）。";
      showMessage(successMsg, "success");
    } catch (e) {
      console.error("[html-preview] 插入失败:", e);
      const verb = intent === "replace" || intent === "replace-active" ? "替换" : "插入";
      showMessage(`${verb}失败：${e?.message || e}`, "error");
      setHtmlPreviewBusy(false);
    }
  }

  function confirmHtmlPreviewInsert() { return doConfirm("insert"); }
  function confirmHtmlPreviewReplace() { return doConfirm("replace"); }
  // 替换 WPS 演示里**当前选中**的那一页（不用 slideHint，用 ActiveWindow.View.Slide）
  function confirmHtmlPreviewReplaceActive() { return doConfirm("replace-active"); }

  // 保存按钮：把当前预览的 state 写回 localStorage 缓存
  //   - state.id 已存在（来自左侧历史 / 之前保存过） → 调 cache.update 覆盖那条
  //   - state.id 为空（AI 工具新生成的，尚未入缓存） → 调 cache.save 新建并把 id 绑回 state
  function saveHtmlPreviewToCache() {
    const st = htmlPreviewState;
    if (!st || !st.templateName || !st.layout) {
      showMessage("当前没有可保存的预览。", "error");
      return;
    }
    const cache = global.WpsAiHtmlCache;
    if (!cache) {
      showMessage("缓存模块未加载，无法保存。", "error");
      return;
    }
    const payload = {
      templateName: st.templateName,
      layout: st.layout,
      data: Object.assign({}, st.data || {}),
      palette: Object.assign({}, st.palette || {}),
      slideHint: st.slideHint || null,
      // 用户主动点保存 → 一定不是 draft 了
      draft: false
    };
    try {
      const oldKey = previewStateKey(st);
      let action;
      if (st.id) {
        const updated = cache.update(st.id, payload);
        if (updated) {
          action = "覆盖保存";
        } else {
          // 老的 id 已被清空 / 找不到，回退成 save 新建
          const saved = cache.save(payload);
          st.id = saved.id;
          action = "新建保存";
        }
      } else {
        const saved = cache.save(payload);
        st.id = saved.id;
        action = "新建保存";
      }
      // chat 会话的 binding key 跟 state.id 挂钩；新建保存让 id 从空变有值时 key 会变，
      // 要把旧 key 下的 chat 日志**搬到**新 key，下次切回这条历史还能看到原对话。
      const newKey = previewStateKey(st);
      if (newKey !== oldKey && previewChatLogByKey.has(oldKey)) {
        previewChatLogByKey.set(newKey, previewChatLogByKey.get(oldKey));
        previewChatLogByKey.delete(oldKey);
        savePreviewChatLogsToStorage();
      }
      _previewChatBoundKey = newKey;
      // 刷新左侧画廊（新条目要立刻显示 + 高亮）和顶部历史角标
      renderHtmlTemplateGallery();
      updateHtmlPreviewHistoryBadge();
      showMessage(`已${action}到「我的历史」`, "success");
    } catch (e) {
      console.error("[html-preview] 保存失败:", e);
      showMessage(`保存失败：${e?.message || e}`, "error");
    }
  }

  // ====== 组件库（freeform 幻灯片的"可复用视觉单元"集合）======
  // 每张 slide 维护一份"用户为这张挑了哪几个组件 id"的选择（持久化 localStorage）。
  // 选择会注入下一轮 chat 的 system prompt，AI 看到这些组件的 html/css 后会在新页里复用。
  const PREVIEW_PICKED_COMPONENTS_KEY = "lingxi_html_preview_picked_components_v1";
  const pickedComponentsByKey = new Map(); // key -> array<componentId>

  function loadPickedComponentsFromStorage() {
    try {
      const raw = localStorage.getItem(PREVIEW_PICKED_COMPONENTS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach((k) => {
          if (Array.isArray(parsed[k])) pickedComponentsByKey.set(k, parsed[k]);
        });
      }
    } catch (e) { /* ignore */ }
  }
  function savePickedComponentsToStorage() {
    try {
      const obj = {};
      pickedComponentsByKey.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(PREVIEW_PICKED_COMPONENTS_KEY, JSON.stringify(obj));
    } catch (e) { /* localStorage 满了，沉默 */ }
  }
  loadPickedComponentsFromStorage();

  function getPickedComponentIds() {
    const key = _previewChatBoundKey;
    if (!key) return [];
    return pickedComponentsByKey.get(key) || [];
  }
  function setPickedComponentIds(ids) {
    const key = _previewChatBoundKey;
    if (!key) return;
    if (!ids || !ids.length) pickedComponentsByKey.delete(key);
    else pickedComponentsByKey.set(key, ids);
    savePickedComponentsToStorage();
    updatePickedComponentsCountBadge();
  }
  function updatePickedComponentsCountBadge() {
    const badge = els.htmlPreviewPickComponentsCount;
    if (!badge) return;
    const n = getPickedComponentIds().length;
    badge.textContent = String(n);
    badge.classList.toggle("empty", n === 0);
  }

  // 「保存为组件」按钮：仅 freeform 布局时可用（其他 layout 是 schema 化的，已天然可复用）
  function openSaveAsComponentDialog() {
    const st = htmlPreviewState;
    const overlay = els.htmlPreviewSaveAsCompModal;
    const tip = els.htmlPreviewSaveAsCompTip;
    const confirmBtn = els.htmlPreviewSaveAsCompConfirmBtn;
    if (!overlay) return;
    if (!st) {
      showMessage("当前没有预览，无法保存为组件。", "error");
      return;
    }
    const isFreeform = st.layout === "freeform";
    if (tip) tip.style.color = isFreeform ? "" : "var(--danger, #e11d48)";
    if (confirmBtn) confirmBtn.disabled = !isFreeform;
    // 预填一个可用名字
    if (els.htmlPreviewSaveAsCompName) {
      els.htmlPreviewSaveAsCompName.value = "";
      els.htmlPreviewSaveAsCompName.placeholder = isFreeform
        ? "如：指标卡网格 / 完成清单 / 团队介绍卡"
        : "（非 freeform，无 html/css 可抽取）";
    }
    if (els.htmlPreviewSaveAsCompDesc) els.htmlPreviewSaveAsCompDesc.value = "";
    overlay.classList.remove("hidden");
    if (isFreeform && els.htmlPreviewSaveAsCompName) {
      setTimeout(() => els.htmlPreviewSaveAsCompName.focus(), 0);
    }
  }
  function closeSaveAsComponentDialog() {
    els.htmlPreviewSaveAsCompModal?.classList.add("hidden");
  }
  function confirmSaveAsComponent() {
    const st = htmlPreviewState;
    if (!st || st.layout !== "freeform") {
      showMessage("只有 freeform 布局可以保存为组件。", "error");
      return;
    }
    const name = (els.htmlPreviewSaveAsCompName?.value || "").trim();
    const desc = (els.htmlPreviewSaveAsCompDesc?.value || "").trim();
    if (!name) {
      showMessage("请填写组件名称。", "error");
      els.htmlPreviewSaveAsCompName?.focus();
      return;
    }
    // 编辑器调用时优先用 _editorPendingSaveHtml（选中元素的 outerHTML），否则用整页
    const html = String(_editorPendingSaveHtml != null ? _editorPendingSaveHtml : (st.data?.html || ""));
    const css = String(_editorPendingSaveCss != null ? _editorPendingSaveCss : (st.data?.css || ""));
    _editorPendingSaveHtml = null;
    _editorPendingSaveCss = null;
    if (!html) {
      showMessage("freeform 的 html 字段是空的，无法保存。", "error");
      return;
    }
    // 修 #19: 整页组件入库时检查大小。≥5KB 弹 confirm，让用户主动选择「拆小」还是「继续保存」。
    // 原因：组件被选用时整段 html+css 会注入 system prompt，5KB 是经验阈值（10 个组件 = 50KB，
    // 已经显著挤压上下文）。AI 抽取的"整页存为组件"最容易撞这个雷。
    const totalBytes = html.length + css.length;
    const COMPONENT_WARN = 5000;
    if (totalBytes > COMPONENT_WARN) {
      const kb = (totalBytes / 1024).toFixed(1);
      const ok = confirm(
        `这个组件 html+css 约 ${kb} KB，超过推荐阈值 ${(COMPONENT_WARN / 1024).toFixed(1)} KB。\n\n`
        + `组件被「选用」时会整段注入 AI 上下文，太大会挤压可用 token。\n\n`
        + `建议：先在编辑器里只选中关键区块（用快捷键 1-3 个元素）再保存，而不是整页存。\n\n`
        + `仍要继续保存吗？`
      );
      if (!ok) return;
    }
    try {
      const saved = global.WpsAiHtmlComponents.save({
        name, description: desc, html, css, sourceSlideId: st.id || null
      });
      closeSaveAsComponentDialog();
      showMessage(`组件「${saved.name}」已存入组件库`, "success");
      // 模板/我的历史/组件 三个 tab 共享一个 list 容器；当前在「组件」tab 就重渲
      if (_galleryActiveTab === "components") renderHtmlTemplateGallery();
    } catch (e) {
      console.error("[html-components] save 失败:", e);
      showMessage(`保存失败：${e?.message || e}`, "error");
    }
  }

  // ============================================================
  // 图层编辑模式：在 iframe 里点击元素 → 虚线选中 + 角图标（×删除 / 📦存为组件 / ✏编辑）
  //              鼠标拖元素 = 移动；拖右下角 = 调大小；
  //              ✏ 打开弹窗改文字 / 颜色 / 字号 / 字重。
  // 所有改动同步回 htmlPreviewState.data.html，下次保存/插入就是改后的版本。
  // ============================================================
  let _editorEnabled = false;
  let _editorSelectedEl = null;            // iframe 里当前选中的 DOM 元素（单选）
  let _editorSelOverlay = null;            // 选中态 overlay（虚线框 + 3 角图标 + resize 把手）
  let _editorHoverOverlay = null;          // hover 态 overlay（蓝色半透明蒙版，像浏览器 devtools）
  let _editorDragState = null;             // { mode: "move"|"resize"|"group-move", startX, startY, ... }
  let _editorJustDragged = false;          // 拖完到 click 之间的 1 帧，吃掉那次 click 防止误清选
  // 多选 / 圈选
  let _editorMultiSel = [];                // 多选元素数组（圈选后形成）
  let _editorMultiOverlay = null;          // 多选 union overlay（虚线 + 删除 + 存组件 + 拖动）
  let _editorMarqueeStart = null;          // 圈选起点 {x, y}
  let _editorMarqueeBox = null;            // 圈选过程中的虚线 div

  const EDITOR_SEL_OVERLAY_ID   = "__lingxi_editor_sel_overlay__";
  const EDITOR_HOVER_OVERLAY_ID = "__lingxi_editor_hover_overlay__";

  // 判断一个 DOM 节点是不是我们注入的编辑器装饰元素
  function isEditorChromeEl(el) {
    if (!el || !el.closest) return false;
    return !!(
      el.closest(`#${EDITOR_SEL_OVERLAY_ID}`) ||
      el.closest(`#${EDITOR_HOVER_OVERLAY_ID}`) ||
      el.closest("#__lingxi_editor_multi_overlay__") ||
      el.closest("#__lingxi_editor_marquee__")
    );
  }

  // 用 elementFromPoint 找鼠标真正下方的元素，绕过 overlay 干扰；
  // 编辑模式 CSS 已经强制所有用户内容 pointer-events:auto（哪怕装饰层原本是 none）。
  // 命中 SVG 内部 shape（rect/circle/path 等）时，**上提到 svg 根**，让用户选中整个图形组件而不是单个原子。
  function realElementAt(doc, clientX, clientY) {
    if (!doc?.elementFromPoint) return null;
    const sel = _editorSelOverlay, hov = _editorHoverOverlay;
    const selDisp = sel?.style.display, hovDisp = hov?.style.display;
    if (sel) sel.style.display = "none";
    if (hov) hov.style.display = "none";
    let el = doc.elementFromPoint(clientX, clientY);
    if (sel) sel.style.display = selDisp || "";
    if (hov) hov.style.display = hovDisp || "";
    if (!el || el === doc.documentElement || el === doc.body) return null;
    if (isEditorChromeEl(el)) return null;
    // SVG inner shape（rect/circle/path 等）→ 选整个 SVG 根，PPT 编辑场景更合理
    if (el.tagName && el.tagName.toLowerCase() !== "svg" && el.ownerSVGElement) {
      el = el.ownerSVGElement;
    }
    return el;
  }

  function enableIframeEditor() {
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    if (!doc || !doc.body) return;
    // 注入编辑器 CSS（idempotent）—— 把手做大到 96px / 64px font，1920×1080 缩到 0.3 时仍清晰
    if (!doc.getElementById("__lingxi_editor_css")) {
      const style = doc.createElement("style");
      style.id = "__lingxi_editor_css";
      style.textContent = `
        body.__lingxi_editing, body.__lingxi_editing * { cursor: crosshair !important; }
        /* 编辑模式下强制所有用户内容（含装饰层、SVG、被 pointer-events:none 标过的元素）都能被命中。
           我们自己的两个 overlay 用 id 排除掉。 */
        body.__lingxi_editing :not(#${EDITOR_SEL_OVERLAY_ID}):not(#${EDITOR_HOVER_OVERLAY_ID}) {
          pointer-events: auto !important;
        }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID},
        body.__lingxi_editing #${EDITOR_HOVER_OVERLAY_ID} { pointer-events: none !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-handle,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize { pointer-events: auto !important; }
        #${EDITOR_HOVER_OVERLAY_ID} {
          position: absolute;
          pointer-events: none;
          z-index: 999998;
          background: rgba(26, 109, 255, 0.15);
          outline: 2px solid #1A6DFF;
          outline-offset: -2px;
          box-sizing: border-box;
          transition: top 0.05s linear, left 0.05s linear, width 0.05s linear, height 0.05s linear;
        }
        #${EDITOR_SEL_OVERLAY_ID} {
          position: absolute;
          pointer-events: none;
          z-index: 999999;
          border: 4px dashed #1A6DFF;
          background: rgba(26, 109, 255, 0.06);
          box-sizing: border-box;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle {
          position: absolute;
          pointer-events: auto;
          background: #1A6DFF;
          color: #fff;
          font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          line-height: 1;
          width: 60px; height: 60px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 8px;
          border: 0;
          cursor: pointer;
          box-shadow: 0 3px 10px rgba(0,0,0,0.3);
          user-select: none;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle:hover { background: #155ad8; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle.danger { background: #e11d48; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle.danger:hover { background: #b91347; }
        /* 线性 SVG 图标：feather 风格，stroke 跟按钮背景的反白色（白） */
        #${EDITOR_SEL_OVERLAY_ID} .ed-handle svg {
          width: 30px; height: 30px;
          stroke: #fff;
          stroke-width: 2;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
          pointer-events: none; /* SVG 不抢父按钮的 click */
        }
        /* 默认：把手在元素上方外侧 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-save   { top: -70px; left: -6px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-edit   { top: -70px; left: 60px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-del    { top: -70px; right: -6px; }
        /* 上面空间不够 → 把把手贴到元素内部顶部，避免被画布上边裁掉 */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-save   { top: 6px; left: 6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-edit   { top: 6px; left: 72px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-del    { top: 6px; right: 6px; }
        /* 修 #14: 八向 resize 把手。每个方向独立 cursor + 锚点位置。
           角把手 = 圆形（明显 affordance），边把手 = 矩形（边的视觉提示） */
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize {
          position: absolute;
          background: #fff;
          border: 3px solid #1A6DFF;
          pointer-events: auto;
          box-shadow: 0 2px 6px rgba(0,0,0,0.22);
          box-sizing: border-box;
        }
        /* 四个角 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-nw,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-ne,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-se,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-sw {
          width: 26px; height: 26px; border-radius: 50%;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-nw { left: -13px; top: -13px; cursor: nwse-resize; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-ne { right: -13px; top: -13px; cursor: nesw-resize; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-se { right: -13px; bottom: -13px; cursor: nwse-resize; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-sw { left: -13px; bottom: -13px; cursor: nesw-resize; }
        /* 四条边的中点 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-n,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-s {
          left: 50%; width: 26px; height: 14px; margin-left: -13px;
          border-radius: 4px; cursor: ns-resize;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-e,
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-w {
          top: 50%; width: 14px; height: 26px; margin-top: -13px;
          border-radius: 4px; cursor: ew-resize;
        }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-n { top: -7px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-s { bottom: -7px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-w { left: -7px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-resize-e { right: -7px; }
      `;
      doc.head.appendChild(style);
    }
    doc.body.classList.add("__lingxi_editing");
    // 创建两层 overlay
    _editorHoverOverlay = doc.getElementById(EDITOR_HOVER_OVERLAY_ID);
    if (!_editorHoverOverlay) {
      _editorHoverOverlay = doc.createElement("div");
      _editorHoverOverlay.id = EDITOR_HOVER_OVERLAY_ID;
      _editorHoverOverlay.style.display = "none";
      doc.body.appendChild(_editorHoverOverlay);
    }
    // 用 document 而不是 body，确保鼠标 / 点击事件不会被某些子元素的 stopPropagation 吃掉
    doc.addEventListener("mousemove", editorOnDocMouseMove, true);
    doc.addEventListener("mouseleave", editorOnDocMouseLeave, true);
    doc.addEventListener("mousedown", editorOnDocMouseDown, true);
    doc.addEventListener("click", editorOnDocClick, true);
    _editorEnabled = true;
    updateEditModeBtnLabel();
  }

  function disableIframeEditor() {
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    if (doc) {
      doc.body?.classList.remove("__lingxi_editing");
      doc.removeEventListener("mousemove", editorOnDocMouseMove, true);
      doc.removeEventListener("mouseleave", editorOnDocMouseLeave, true);
      doc.removeEventListener("mousedown", editorOnDocMouseDown, true);
      doc.removeEventListener("click", editorOnDocClick, true);
    }
    clearEditorSelection();
    clearEditorMultiSelection();
    cleanupMarquee();
    if (_editorHoverOverlay) {
      try { _editorHoverOverlay.remove(); } catch (e) {}
      _editorHoverOverlay = null;
    }
    _editorEnabled = false;
    updateEditModeBtnLabel();
  }

  function updateEditModeBtnLabel() {
    const btn = els.htmlPreviewEditModeBtn;
    if (!btn) return;
    btn.textContent = _editorEnabled ? "退出编辑" : "编辑模式";
    btn.classList.toggle("active", _editorEnabled);
  }

  function clearEditorSelection() {
    _editorSelectedEl = null;
    if (_editorSelOverlay) {
      try { _editorSelOverlay.remove(); } catch (e) {}
      _editorSelOverlay = null;
    }
  }

  // ---- Hover：跟随鼠标，蒙版盖在元素上 ----
  function editorOnDocMouseMove(ev) {
    if (!_editorEnabled) return;
    if (_editorDragState) return; // 拖动中不更新 hover
    const doc = (ev.currentTarget && ev.currentTarget.ownerDocument) || ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    if (!target) {
      if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
      return;
    }
    positionRectTo(_editorHoverOverlay, target);
    _editorHoverOverlay.style.display = "block";
  }
  function editorOnDocMouseLeave() {
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
  }

  // ---- 点击：选中鼠标下方真实元素 ----
  function editorOnDocClick(ev) {
    if (!_editorEnabled) return;
    if (isEditorChromeEl(ev.target)) return;
    if (_editorJustDragged) { _editorJustDragged = false; ev.preventDefault(); ev.stopPropagation(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    const doc = ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    if (!target) { clearEditorSelection(); return; }
    selectEditorElement(target);
  }

  // ---- mousedown：
  //   resize 把手 → resize
  //   多选 overlay 上 → 整组拖动
  //   按在单选元素上 → 单元素拖动
  //   按在空白（body / html）上 → 开始圈选 marquee
  function editorOnDocMouseDown(ev) {
    if (!_editorEnabled) return;
    const action = ev.target?.closest?.("[data-action]")?.dataset?.action;
    if (action === "resize") {
      ev.preventDefault(); ev.stopPropagation();
      // 修 #14: 从把手 DOM 上读方向；老的单把手没有 dir → 默认 se（兼容）
      const dir = ev.target?.closest?.("[data-resize-dir]")?.dataset?.resizeDir || "se";
      startEditorDrag(ev, "resize", dir);
      return;
    }
    if (action === "multi-move") {
      ev.preventDefault(); ev.stopPropagation();
      startEditorGroupDrag(ev);
      return;
    }
    if (isEditorChromeEl(ev.target)) return;
    const doc = ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    // 单选拖动
    if (_editorSelectedEl && target && (target === _editorSelectedEl || _editorSelectedEl.contains(target))) {
      ev.preventDefault(); ev.stopPropagation();
      startEditorDrag(ev, "move");
      return;
    }
    // 按在空白处（target = null 表示击中 body / html） → 开始圈选
    if (!target) {
      ev.preventDefault(); ev.stopPropagation();
      startEditorMarquee(ev, doc);
      return;
    }
  }

  // ---- 圈选 marquee ----
  function startEditorMarquee(ev, doc) {
    if (!doc?.body) return;
    // 先清掉单选 / 多选状态
    clearEditorSelection();
    clearEditorMultiSelection();
    _editorMarqueeStart = { x: ev.clientX, y: ev.clientY, sx: doc.documentElement.scrollLeft || 0, sy: doc.documentElement.scrollTop || 0 };
    // 创建虚线 div
    const box = doc.createElement("div");
    box.id = "__lingxi_editor_marquee__";
    box.style.cssText = [
      "position: absolute",
      "pointer-events: none",
      "z-index: 999997",
      "border: 2px dashed #1A6DFF",
      "background: rgba(26, 109, 255, 0.10)",
      "box-sizing: border-box",
      "left: " + (ev.clientX + _editorMarqueeStart.sx) + "px",
      "top: " + (ev.clientY + _editorMarqueeStart.sy) + "px",
      "width: 0; height: 0"
    ].join(";");
    doc.body.appendChild(box);
    _editorMarqueeBox = box;
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    doc.addEventListener("mousemove", editorMarqueeMove, true);
    doc.addEventListener("mouseup",   editorMarqueeUp,   true);
  }
  function editorMarqueeMove(ev) {
    if (!_editorMarqueeStart || !_editorMarqueeBox) return;
    const s = _editorMarqueeStart;
    const minX = Math.min(s.x, ev.clientX);
    const minY = Math.min(s.y, ev.clientY);
    const w = Math.abs(ev.clientX - s.x);
    const h = Math.abs(ev.clientY - s.y);
    _editorMarqueeBox.style.left = (minX + s.sx) + "px";
    _editorMarqueeBox.style.top  = (minY + s.sy) + "px";
    _editorMarqueeBox.style.width  = w + "px";
    _editorMarqueeBox.style.height = h + "px";
  }
  function editorMarqueeUp(ev) {
    const s = _editorMarqueeStart;
    const box = _editorMarqueeBox;
    const doc = box?.ownerDocument || ev.target?.ownerDocument;
    if (!s || !box || !doc) { cleanupMarquee(); return; }
    doc.removeEventListener("mousemove", editorMarqueeMove, true);
    doc.removeEventListener("mouseup",   editorMarqueeUp,   true);
    const minX = Math.min(s.x, ev.clientX);
    const minY = Math.min(s.y, ev.clientY);
    const maxX = Math.max(s.x, ev.clientX);
    const maxY = Math.max(s.y, ev.clientY);
    // 移除虚线 div 前先记录矩形
    cleanupMarquee();
    // 鼠标几乎没动 → 当成"点击空白"，啥也不选
    if ((maxX - minX) < 4 && (maxY - minY) < 4) return;
    // 找出 stage 下与圈选矩形**相交**的直接子级元素（不下钻到孙子，避免过度细分）
    const stage = doc.querySelector(".stage") || doc.body;
    const hits = [];
    const rectIntersect = (r) => !(r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY);
    Array.from(stage.children).forEach((child) => {
      if (isEditorChromeEl(child)) return;
      try {
        const r = child.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && rectIntersect(r)) hits.push(child);
      } catch (e) {}
    });
    if (!hits.length) return;
    if (hits.length === 1) {
      // 只圈到 1 个 → 用单选逻辑，体验更好
      selectEditorElement(hits[0]);
      return;
    }
    _editorMultiSel = hits;
    renderMultiSelOverlay();
  }
  function cleanupMarquee() {
    _editorMarqueeStart = null;
    if (_editorMarqueeBox) {
      try { _editorMarqueeBox.remove(); } catch (e) {}
      _editorMarqueeBox = null;
    }
  }
  function clearEditorMultiSelection() {
    _editorMultiSel = [];
    if (_editorMultiOverlay) {
      try { _editorMultiOverlay.remove(); } catch (e) {}
      _editorMultiOverlay = null;
    }
  }

  // 多选 overlay：覆盖在 union bbox 上，有删除 / 存组件 / 拖动 3 个动作
  function renderMultiSelOverlay() {
    if (!_editorMultiSel.length) return;
    const doc = _editorMultiSel[0].ownerDocument;
    if (_editorMultiOverlay) { try { _editorMultiOverlay.remove(); } catch (e) {} }
    // 计算 union rect
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    _editorMultiSel.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left   < minX) minX = r.left;
      if (r.top    < minY) minY = r.top;
      if (r.right  > maxX) maxX = r.right;
      if (r.bottom > maxY) maxY = r.bottom;
    });
    const sx = doc.documentElement.scrollLeft || 0;
    const sy = doc.documentElement.scrollTop  || 0;
    const overlay = doc.createElement("div");
    overlay.id = "__lingxi_editor_multi_overlay__";
    overlay.style.cssText = [
      "position: absolute",
      "z-index: 999999",
      "border: 4px dashed #1A6DFF",
      "background: rgba(26, 109, 255, 0.08)",
      "box-sizing: border-box",
      "left: " + (minX + sx) + "px",
      "top: " + (minY + sy) + "px",
      "width: " + (maxX - minX) + "px",
      "height: " + (maxY - minY) + "px",
      "pointer-events: auto",
      "cursor: move"
    ].join(";");
    overlay.dataset.action = "multi-move";
    overlay.innerHTML =
      '<div style="position:absolute;top:-78px;left:0;display:flex;gap:10px;pointer-events:none">' +
        '<button data-action="multi-save" style="pointer-events:auto;background:#1A6DFF;color:#fff;border:0;border-radius:8px;width:60px;height:60px;font-size:32px;cursor:pointer;font-weight:700;box-shadow:0 3px 10px rgba(0,0,0,0.3)" title="把选中的多个元素整体存为一个组件">📦</button>' +
        '<button data-action="multi-del" style="pointer-events:auto;background:#e11d48;color:#fff;border:0;border-radius:8px;width:60px;height:60px;font-size:44px;cursor:pointer;font-weight:700;box-shadow:0 3px 10px rgba(0,0,0,0.3)" title="删除选中的全部元素">×</button>' +
        '<span style="pointer-events:none;color:#1A6DFF;font-size:24px;font-weight:700;line-height:60px;background:#fff;padding:0 14px;border-radius:8px;box-shadow:0 3px 10px rgba(0,0,0,0.2)">已选 ' + _editorMultiSel.length + ' 个</span>' +
      '</div>';
    doc.body.appendChild(overlay);
    _editorMultiOverlay = overlay;
    overlay.addEventListener("click", (e) => {
      const a = e.target?.dataset?.action;
      if (!a) return;
      e.stopPropagation();
      if (a === "multi-del") multiSelDeleteAll();
      else if (a === "multi-save") multiSelSaveAsComponent();
    }, true);
  }

  function multiSelDeleteAll() {
    if (!confirm(`删除选中的 ${_editorMultiSel.length} 个元素？`)) return;
    _editorMultiSel.forEach((el) => { try { el.remove(); } catch (e) {} });
    clearEditorMultiSelection();
    persistEditorChangesToState();
  }

  function multiSelSaveAsComponent() {
    if (!_editorMultiSel.length) return;
    const els0 = _editorMultiSel.slice();
    const doc = els0[0].ownerDocument;
    // 用一个 wrapper div 包住所有 outerHTML，保留视觉关系
    const wrapper = `<div class="component-bundle">${els0.map((e) => e.outerHTML).join("\n")}</div>`;
    // 合并 CSS：每个元素的相关规则拿出来，去重
    const seen = new Set();
    let mergedCss = "";
    els0.forEach((el) => {
      const css = extractCssForElement(el, doc);
      css.split("\n").forEach((rule) => {
        const norm = rule.trim();
        if (norm && !seen.has(norm)) { seen.add(norm); mergedCss += rule + "\n"; }
      });
    });
    _editorPendingSaveHtml = wrapper;
    _editorPendingSaveCss = mergedCss;
    openSaveAsComponentDialog();
    if (els.htmlPreviewSaveAsCompName) {
      els.htmlPreviewSaveAsCompName.value = `bundle-${els0[0].tagName.toLowerCase()}-x${els0.length}`;
      els.htmlPreviewSaveAsCompName.select?.();
    }
    if (els.htmlPreviewSaveAsCompDesc) {
      els.htmlPreviewSaveAsCompDesc.value = `从 ${htmlPreviewState?.templateName}/${htmlPreviewState?.layout} 抽出的 ${els0.length} 个元素组合`;
    }
  }

  // 多选拖动：所有元素同时用 transform: translate 平移
  function startEditorGroupDrag(ev) {
    if (!_editorMultiSel.length) return;
    const states = _editorMultiSel.map((el) => {
      const doc = el.ownerDocument;
      const cs = doc.defaultView.getComputedStyle(el);
      let tx = 0, ty = 0;
      const m = (el.style.transform || cs.transform || "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      if (m) { tx = parseFloat(m[1]); ty = parseFloat(m[2]); }
      return { el, startTx: tx, startTy: ty };
    });
    _editorDragState = {
      mode: "group-move",
      startX: ev.clientX, startY: ev.clientY,
      groupStates: states,
      moved: false
    };
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    const doc = _editorMultiSel[0].ownerDocument;
    doc.addEventListener("mousemove", editorOnMouseMove, true);
    doc.addEventListener("mouseup",   editorOnMouseUp,   true);
  }

  function selectEditorElement(el) {
    if (!el || el === _editorSelectedEl) return;
    clearEditorSelection();
    _editorSelectedEl = el;
    const doc = el.ownerDocument;
    if (!doc?.body) return;
    const overlay = doc.createElement("div");
    overlay.id = EDITOR_SEL_OVERLAY_ID;
    // 线性 SVG 图标（feather 风格）：
    //   save  → package（向组件库存）
    //   edit  → edit-3（铅笔）
    //   del   → trash-2
    // SVG 在 iframe 内文档里 — 不能引外部文件路径（同源限制），必须 inline。
    const ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
    const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    const ICON_DEL  = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    overlay.innerHTML =
      `<button class="ed-handle ed-save" data-action="save" title="保存为组件">${ICON_SAVE}</button>` +
      `<button class="ed-handle ed-edit" data-action="edit" title="编辑文字/颜色/字号">${ICON_EDIT}</button>` +
      `<button class="ed-handle ed-del danger" data-action="del" title="删除元素">${ICON_DEL}</button>` +
      // 修 #14: 八向 resize 把手；data-resize-dir 由 startEditorDrag 读
      '<div class="ed-resize ed-resize-nw" data-action="resize" data-resize-dir="nw" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-n"  data-action="resize" data-resize-dir="n"  title="拖动调整高度"></div>' +
      '<div class="ed-resize ed-resize-ne" data-action="resize" data-resize-dir="ne" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-e"  data-action="resize" data-resize-dir="e"  title="拖动调整宽度"></div>' +
      '<div class="ed-resize ed-resize-se" data-action="resize" data-resize-dir="se" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-s"  data-action="resize" data-resize-dir="s"  title="拖动调整高度"></div>' +
      '<div class="ed-resize ed-resize-sw" data-action="resize" data-resize-dir="sw" title="拖动调整尺寸"></div>' +
      '<div class="ed-resize ed-resize-w"  data-action="resize" data-resize-dir="w"  title="拖动调整宽度"></div>';
    doc.body.appendChild(overlay);
    _editorSelOverlay = overlay;
    positionRectTo(overlay, el);
    overlay.addEventListener("click", (e) => {
      // SVG 子元素也可能是 e.target —— 用 closest 走到带 data-action 的祖先
      const handle = e.target?.closest?.("[data-action]");
      const a = handle?.dataset?.action;
      if (!a) return;
      e.stopPropagation();
      if (a === "del") editorDeleteSelected();
      else if (a === "edit") editorOpenEditPopup();
      else if (a === "save") editorSaveSelectedAsComponent();
    }, true);
  }

  // 通用：把 overlay 元素对齐到 targetEl 的 boundingClientRect
  // 当 overlay 是选中态（有 .ed-* 把手）且元素离顶部太近 → 切到 inside 模式让把手贴元素内顶部
  function positionRectTo(overlay, targetEl) {
    if (!overlay || !targetEl) return;
    const r = targetEl.getBoundingClientRect();
    const doc = overlay.ownerDocument;
    const sx = (doc.documentElement.scrollLeft || doc.body.scrollLeft || 0);
    const sy = (doc.documentElement.scrollTop  || doc.body.scrollTop  || 0);
    overlay.style.left   = (r.left + sx) + "px";
    overlay.style.top    = (r.top  + sy) + "px";
    overlay.style.width  = r.width + "px";
    overlay.style.height = r.height + "px";
    // 智能避让：选中态 overlay 才有 ed-* 把手；元素顶部空间 < 80px（把手 60 + margin）→ 内嵌
    if (overlay.id === EDITOR_SEL_OVERLAY_ID) {
      const needAbove = 80; // 把手 60 + 上方 margin 20
      const insideMode = r.top < needAbove;
      overlay.classList.toggle("ed-handles-inside", insideMode);
    }
  }
  function positionEditorOverlay() {
    if (_editorSelectedEl && _editorSelOverlay) positionRectTo(_editorSelOverlay, _editorSelectedEl);
  }

  function startEditorDrag(ev, mode, dir) {
    const el = _editorSelectedEl;
    if (!el) return;
    const doc = el.ownerDocument;
    const cs = doc.defaultView.getComputedStyle(el);
    let curTx = 0, curTy = 0;
    const m = (el.style.transform || cs.transform || "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    if (m) { curTx = parseFloat(m[1]); curTy = parseFloat(m[2]); }
    _editorDragState = {
      mode,
      // 修 #14: dir 决定哪几个轴受影响（n/s/e/w 任意组合）。move 模式忽略 dir
      dir: dir || "se",
      startX: ev.clientX, startY: ev.clientY,
      startW: parseFloat(cs.width) || el.offsetWidth,
      startH: parseFloat(cs.height) || el.offsetHeight,
      startTx: curTx, startTy: curTy,
      moved: false
    };
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    doc.addEventListener("mousemove", editorOnMouseMove, true);
    doc.addEventListener("mouseup",   editorOnMouseUp,   true);
  }

  function editorOnMouseMove(ev) {
    const ds = _editorDragState;
    if (!ds) return;
    const dx = ev.clientX - ds.startX;
    const dy = ev.clientY - ds.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ds.moved = true;
    if (ds.mode === "group-move") {
      // 多选拖动：所有成员同时平移
      ds.groupStates.forEach((s) => {
        s.el.style.transform = `translate(${s.startTx + dx}px, ${s.startTy + dy}px)`;
      });
      renderMultiSelOverlay();
      return;
    }
    const el = _editorSelectedEl;
    if (!el) return;
    if (ds.mode === "move") {
      el.style.transform = `translate(${ds.startTx + dx}px, ${ds.startTy + dy}px)`;
    } else if (ds.mode === "resize") {
      // 修 #14: dir 里含 e/w 决定宽度改不改 + 是否要反向平移；含 n/s 决定高度
      const dir = ds.dir || "se";
      let newW = ds.startW;
      let newH = ds.startH;
      let dtx = 0, dty = 0;
      if (dir.includes("e")) {
        newW = Math.max(20, ds.startW + dx);
      } else if (dir.includes("w")) {
        // 向左拉 → 宽度减 dx；同时整体右移 dx（保持右边界不动）
        newW = Math.max(20, ds.startW - dx);
        dtx = ds.startW - newW; // 实际宽度变化量（min-clamp 后），方向已对
      }
      if (dir.includes("s")) {
        newH = Math.max(20, ds.startH + dy);
      } else if (dir.includes("n")) {
        newH = Math.max(20, ds.startH - dy);
        dty = ds.startH - newH;
      }
      if (newW !== ds.startW) el.style.width = newW + "px";
      if (newH !== ds.startH) el.style.height = newH + "px";
      // n/w 方向把元素跟着拉动的边一起平移，保持对侧边界不动
      if (dtx || dty) {
        el.style.transform = `translate(${ds.startTx + dtx}px, ${ds.startTy + dty}px)`;
      }
    }
    positionEditorOverlay();
  }
  function editorOnMouseUp() {
    const ds = _editorDragState;
    if (!ds) return;
    const moved = ds.moved;
    _editorDragState = null;
    const el = _editorSelectedEl || (ds.groupStates?.[0]?.el);
    const doc = el?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    if (doc) {
      doc.removeEventListener("mousemove", editorOnMouseMove, true);
      doc.removeEventListener("mouseup",   editorOnMouseUp,   true);
    }
    if (moved) {
      _editorJustDragged = true; // 拖完后紧接来的 click 是浏览器自动派发的，吃掉
      persistEditorChangesToState();
    }
  }

  // 删除选中元素
  function editorDeleteSelected() {
    const el = _editorSelectedEl;
    if (!el) return;
    el.remove();
    clearEditorSelection();
    persistEditorChangesToState();
  }

  // 编辑弹窗：填入当前元素的文字 / 颜色 / 字号 / 字重
  function editorOpenEditPopup() {
    const el = _editorSelectedEl;
    if (!el) return;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (els.htmlPreviewEditElTag) {
      els.htmlPreviewEditElTag.textContent = `<${el.tagName.toLowerCase()}>` + (el.className ? ` .${String(el.className).split(" ")[0]}` : "");
    }
    // 文字：只显示直接子文本（不含子元素 HTML），避免误删结构
    if (els.htmlPreviewEditElText) {
      const onlyText = (el.children.length === 0) ? el.textContent : "";
      els.htmlPreviewEditElText.value = onlyText;
      els.htmlPreviewEditElText.disabled = el.children.length > 0;
      els.htmlPreviewEditElText.placeholder = el.children.length > 0
        ? "（这个元素含子元素，不能直接改文字）"
        : "改文字内容";
    }
    if (els.htmlPreviewEditElColor) {
      // 把 rgb(x,y,z) 转 #rrggbb
      els.htmlPreviewEditElColor.value = rgbToHex(cs.color) || "#000000";
    }
    if (els.htmlPreviewEditElSize) {
      els.htmlPreviewEditElSize.value = parseInt(cs.fontSize, 10) || 16;
    }
    if (els.htmlPreviewEditElWeight) {
      els.htmlPreviewEditElWeight.value = "";
    }
    els.htmlPreviewEditElModal?.classList.remove("hidden");
  }
  function editorCloseEditPopup() {
    els.htmlPreviewEditElModal?.classList.add("hidden");
  }
  function editorApplyEditPopup() {
    const el = _editorSelectedEl;
    if (!el) { editorCloseEditPopup(); return; }
    if (els.htmlPreviewEditElText && !els.htmlPreviewEditElText.disabled) {
      el.textContent = els.htmlPreviewEditElText.value;
    }
    if (els.htmlPreviewEditElColor) el.style.color = els.htmlPreviewEditElColor.value;
    if (els.htmlPreviewEditElSize) {
      const n = parseInt(els.htmlPreviewEditElSize.value, 10);
      if (n > 0) el.style.fontSize = n + "px";
    }
    if (els.htmlPreviewEditElWeight && els.htmlPreviewEditElWeight.value) {
      el.style.fontWeight = els.htmlPreviewEditElWeight.value;
    }
    positionEditorOverlay();
    persistEditorChangesToState();
    editorCloseEditPopup();
  }
  function rgbToHex(rgb) {
    if (!rgb) return null;
    const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const h = (n) => Number(n).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }

  // 扫描 iframe 内所有 stylesheet，挑出"跟选中元素子树相关"的 CSS 规则。
  // 判定标准：规则的 selectorText 提到了元素子树用到的某个 class 或 tag 名。
  // 这样存进组件库的 css 既覆盖了视觉，又不会把整页 css 都拖进来。
  function extractCssForElement(el, doc) {
    if (!el || !doc) return "";
    const classes = new Set();
    const tags = new Set();
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      tags.add(node.tagName.toLowerCase());
      if (node.classList) node.classList.forEach((c) => classes.add(c));
      Array.from(node.children || []).forEach(walk);
    };
    walk(el);
    const matched = [];
    const seen = new Set();
    const addRule = (cssText) => {
      if (cssText && !seen.has(cssText)) { seen.add(cssText); matched.push(cssText); }
    };
    const ruleMatches = (rule) => {
      if (!rule) return false;
      // @font-face / @import 等无 selector：直接放进去（字体常被组件依赖）
      if (rule.type === 5 || rule.type === 3) return true; // CSSFontFaceRule / CSSImportRule
      const sel = rule.selectorText || "";
      if (!sel) return false;
      // skip 全局基础 selector 避免污染
      if (/^(\*|html|body|:root)(\s|,|$|\.|>|~)/.test(sel.trim())) return false;
      for (const c of classes) {
        if (sel.includes("." + c)) return true;
      }
      for (const t of tags) {
        // tag 必须在 selector 中作为独立 token 出现
        const re = new RegExp("(^|[\\s,>+~])" + t + "([\\s,.:#\\[]|$)");
        if (re.test(sel)) return true;
      }
      return false;
    };
    const walkRules = (rules) => {
      if (!rules) return;
      for (const rule of rules) {
        if (rule.cssRules /* @media / @supports / @keyframes */) {
          // @keyframes 跟动画名挂钩；scope 内任何 animation-name 引用到才算，但我们保守地全部带进去
          if (rule.type === 7 /* CSSKeyframesRule */) {
            addRule(rule.cssText);
            continue;
          }
          // @media / @supports：递归到子规则
          const inner = [];
          for (const r of rule.cssRules) if (ruleMatches(r)) inner.push(r.cssText);
          if (inner.length) addRule(`${rule.cssText.split("{")[0]}{\n  ${inner.join("\n  ")}\n}`);
        } else if (ruleMatches(rule)) {
          addRule(rule.cssText);
        }
      }
    };
    for (const sheet of doc.styleSheets || []) {
      try { walkRules(sheet.cssRules); }
      catch (e) { /* CORS 受限 stylesheet，跳过 */ }
    }
    return matched.join("\n");
  }

  // 选中元素的 outerHTML 存为组件（打开 save-as-component dialog 预填）
  function editorSaveSelectedAsComponent() {
    const el = _editorSelectedEl;
    if (!el) return;
    const html = el.outerHTML;
    const st = htmlPreviewState;
    if (!st) return;
    // 抽取跟元素相关的 CSS（class + tag 选择器匹配），存到 pending 让 confirmSaveAsComponent 用
    const doc = el.ownerDocument;
    _editorPendingSaveHtml = html;
    _editorPendingSaveCss = extractCssForElement(el, doc);
    openSaveAsComponentDialog();
    // 把 save-as-component name 默认成 element 的第一个 class 名
    if (els.htmlPreviewSaveAsCompName) {
      const firstClass = String(el.className || "").split(" ")[0];
      els.htmlPreviewSaveAsCompName.value = firstClass || el.tagName.toLowerCase();
      els.htmlPreviewSaveAsCompName.select?.();
    }
    if (els.htmlPreviewSaveAsCompDesc) {
      els.htmlPreviewSaveAsCompDesc.value = `从「${st.templateName}/${st.layout}」抽出的 ${el.tagName.toLowerCase()} 组件`;
    }
  }
  let _editorPendingSaveHtml = null;
  let _editorPendingSaveCss = null;

  // 修 #15: 把 transform: translate(...) 烘焙成 position+left+top（或叠加到原 left/top 上）。
  // 原因：拖动/组拖动用的是 transform，DOM 坐标实际没变；如果用户后续用其他工具读 offsetLeft、
  // 或这段 HTML 被复制到另一个上下文，transform 偏移可能被丢/被误读。烘焙后元素的"视觉位置 = DOM 位置"。
  // 策略：
  //   - 元素当前是 absolute/fixed → 解析原 left/top 数值（默认 0），加上 dx/dy 写回，清掉 transform
  //   - 元素是 relative/static → 强制改 relative，新增 left=dx/top=dy（不影响其他元素流式布局，跟 translate 等价）
  function bakeTransformOffsetsIn(scopeEl) {
    if (!scopeEl) return;
    const win = scopeEl.ownerDocument?.defaultView;
    if (!win) return;
    const all = scopeEl.querySelectorAll("[style*='translate']");
    all.forEach((el) => {
      const inline = el.style?.transform || "";
      const m = inline.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
      if (!m) return;
      const dx = parseFloat(m[1]) || 0;
      const dy = parseFloat(m[2]) || 0;
      if (!dx && !dy) {
        // 没位移，单纯清掉空 transform，避免遗留垃圾
        el.style.transform = inline.replace(/translate\([^)]*\)/, "").trim();
        if (!el.style.transform) el.style.removeProperty("transform");
        return;
      }
      const cs = win.getComputedStyle(el);
      const pos = cs.position;
      const isPositioned = pos === "absolute" || pos === "fixed" || pos === "relative" || pos === "sticky";
      // 原有 left/top（pixel 值；auto/% 时按 0 处理）—— 这里只在 inline style 上叠加，避免破坏作者样式表里的规则
      const baseLeft = parseFloat(el.style.left) || 0;
      const baseTop = parseFloat(el.style.top) || 0;
      if (!isPositioned) el.style.position = "relative";
      el.style.left = (baseLeft + dx) + "px";
      el.style.top = (baseTop + dy) + "px";
      // 移除 translate；保留可能存在的其他 transform 函数（如 rotate）
      const restTransform = inline.replace(/translate\([^)]*\)/, "").trim();
      if (restTransform) el.style.transform = restTransform;
      else el.style.removeProperty("transform");
    });
  }

  // 把 iframe body 当前 innerHTML（去掉 overlay）序列化回 st.data.html
  function persistEditorChangesToState() {
    const st = htmlPreviewState;
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    if (!st || !doc?.body || st.layout !== "freeform") return;
    // 临时把 overlay 摘出来再序列化
    const overlay = _editorOverlayHostInIframe;
    let overlayParent = null;
    if (overlay && overlay.parentNode) {
      overlayParent = overlay.parentNode;
      overlayParent.removeChild(overlay);
    }
    // 找回 .stage 容器（freeform 把 html 包在 .stage 里）—— 直接读 .stage.innerHTML
    const stage = doc.querySelector(".stage") || doc.body;
    // 修 #15: 序列化前先把 transform 烘焙成 left/top，让 HTML 自带正确坐标
    bakeTransformOffsetsIn(stage);
    st.data = Object.assign({}, st.data, { html: stage.innerHTML });
    if (overlayParent && overlay) overlayParent.appendChild(overlay);
    // 同步字段编辑器里 html textarea 的值
    const fieldHostHtml = els.htmlPreviewFields?.querySelector('[data-field-name="html"]');
    if (fieldHostHtml) fieldHostHtml.value = st.data.html;
  }

  function toggleEditMode() {
    if (!htmlPreviewState || htmlPreviewState.layout !== "freeform") {
      showMessage("编辑模式只能在 freeform 布局下用。先切换到 freeform 再试。", "info");
      return;
    }
    if (_editorEnabled) disableIframeEditor();
    else enableIframeEditor();
  }

  // ====== 双 tab 切换：美化当前 / 统一修改 ======
  let _previewChatActiveTab = "current"; // current | unified

  function setPreviewChatTab(tab) {
    if (tab !== "current" && tab !== "unified") return;
    _previewChatActiveTab = tab;
    document.querySelectorAll(".preview-chat-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.chatTab === tab);
    });
    // 切换面板可见性（log + input-row 各有 data-chat-panel 标记）
    document.querySelectorAll("[data-chat-panel]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.chatPanel !== tab);
    });
    // 选用组件 / count badge 只在"当前"tab 下有意义；统一修改改的是全部历史
    if (els.htmlPreviewPickComponentsBtn) {
      els.htmlPreviewPickComponentsBtn.classList.toggle("hidden", tab !== "current");
    }
  }

  // ====== 统一修改"我的历史"全部条目 ======
  // 一条用户指令循环跑全部 history 条目，每条单独跟 AI 通信，拿到 patch 后 cache.update()
  // 持久化在 localStorage 全局一份（不分 slide）
  const UNIFIED_CHAT_LOG_KEY = "lingxi_html_preview_unified_chat_log_v1";
  const unifiedChatLog = []; // [{role, text}]

  function loadUnifiedChatLog() {
    try {
      const raw = localStorage.getItem(UNIFIED_CHAT_LOG_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parsed.forEach((e) => unifiedChatLog.push(e));
    } catch (e) {}
  }
  function saveUnifiedChatLog() {
    try { localStorage.setItem(UNIFIED_CHAT_LOG_KEY, JSON.stringify(unifiedChatLog)); }
    catch (e) {}
  }
  loadUnifiedChatLog();

  function appendUnifiedChatMsg(role, text) {
    const log = els.htmlPreviewUnifiedLog;
    if (!log) return null;
    const empty = log.querySelector(".html-preview-chat-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = `html-preview-chat-msg ${role}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (role !== "ai-pending") {
      unifiedChatLog.push({ role, text });
      saveUnifiedChatLog();
    }
    return div;
  }
  function renderUnifiedChatLogFromStore() {
    const log = els.htmlPreviewUnifiedLog;
    if (!log) return;
    log.innerHTML = "";
    if (!unifiedChatLog.length) {
      log.innerHTML = '<div class="html-preview-chat-empty">让 AI <b>批量改"我的历史"全部幻灯片</b>：<br>· 全局换色 ——「所有背景换成深海军蓝」<br>· 字体统一 ——「标题字号统一加大到 80px」<br>· 装饰统一 ——「每页顶部加 4px 渐变条」<br>· 风格收敛 ——「整套都更商务一点，去掉花哨装饰」<br><br>⚠ 每条历史都会被 AI 单独处理一次，可能慢；会自动跳过 freeform 之外的固定布局。</div>';
      return;
    }
    unifiedChatLog.forEach((m) => {
      const div = document.createElement("div");
      div.className = `html-preview-chat-msg ${m.role}`;
      div.textContent = m.text;
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }

  function clearUnifiedChatLog() {
    unifiedChatLog.length = 0;
    saveUnifiedChatLog();
    renderUnifiedChatLogFromStore();
  }

  // 给一个 history entry 跑一次 AI 患者，返回 patch 或 null（跳过）
  async function unifiedPatchOne(entry, userInstruction) {
    if (!entry || !entry.templateName || !entry.layout) return null;
    if (entry.layout !== "freeform") {
      // 固定 layout 的 schema 化 data，不能像 freeform 那样自由改 —— 至少配色还能动
      // 只让 AI 输出 palette 部分
      const sysFixed = [
        "你给一张幻灯片做局部美化：**只允许调整 palette（配色 + 字体）**，data 字段不要动（固定 layout schema 不支持自由改）。",
        "",
        `当前模板：${entry.templateName}`,
        `当前布局：${entry.layout}（固定 layout）`,
        `当前 palette：${JSON.stringify(entry.palette || {}, null, 2)}`,
        "",
        "用户指令：" + userInstruction,
        "",
        "**只输出一段 raw JSON**：",
        '{"palette": {"primaryColor": "#xxxxxx", ...}}',
        "",
        "palette 可用 key：primaryColor / accentColor / backgroundColor / surfaceColor / titleColor / bodyColor / titleFont / bodyFont。",
        "如果用户指令跟配色无关（如「字号改大」、「换排版」），返回 `{}`（不改）。",
        "禁止解释、寒暄、markdown 围栏。第一字符必须是 {。"
      ].join("\n");
      let raw;
      try {
        raw = await callProviderForPreviewChat([
          { role: "system", content: sysFixed },
          { role: "user", content: userInstruction }
        ], null);
      } catch (e) { throw new Error(`AI 调用失败：${e?.message || e}`); }
      let patch;
      try {
        let s = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const f = s.indexOf("{"), l = s.lastIndexOf("}");
        patch = JSON.parse(s.slice(f, l + 1));
      } catch (e) { return null; }
      if (!patch?.palette || typeof patch.palette !== "object") return null;
      return { palette: Object.assign({}, entry.palette || {}, patch.palette) };
    }

    // freeform：HTML/CSS 都能动
    const sysFree = [
      "你给一张 freeform 幻灯片做局部美化。**保留原内容（文字 / 数字 / 列表项）一字不动**，只改 HTML 结构 / CSS / palette 来响应用户的统一修改需求。",
      "",
      "你必须输出**一段 raw JSON patch**，可以包含：",
      '  - "html": "新 body HTML"（可选，要改 HTML 时给）',
      '  - "css": "新 CSS"（可选）',
      '  - "palette": { ... }（可选，要换配色时给）',
      "不要修改的字段就不要出现在 JSON 里。",
      "",
      `当前 HTML：\n${String(entry.data?.html || "").slice(0, 8000)}`,
      `\n当前 CSS：\n${String(entry.data?.css || "").slice(0, 4000)}`,
      `\n当前 palette：${JSON.stringify(entry.palette || {}, null, 2)}`,
      "",
      "字号底线：正文 ≥24px、标题 ≥40px。颜色字体必须用 CSS 变量 var(--primary) 等。",
      "**严禁改写文字内容** —— 用户没让你改文案，只让你改视觉。",
      "禁止解释、寒暄、markdown 围栏。第一字符必须是 {，最后字符必须是 }。"
    ].join("\n");
    let raw;
    try {
      raw = await callProviderForPreviewChat([
        { role: "system", content: sysFree },
        { role: "user", content: userInstruction }
      ], null);
    } catch (e) { throw new Error(`AI 调用失败：${e?.message || e}`); }
    let patch;
    try {
      let s = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const f = s.indexOf("{"), l = s.lastIndexOf("}");
      patch = JSON.parse(s.slice(f, l + 1));
    } catch (e) { return null; }
    if (!patch || typeof patch !== "object") return null;
    const result = {};
    if (typeof patch.html === "string" || typeof patch.css === "string") {
      result.data = Object.assign({}, entry.data || {});
      if (typeof patch.html === "string") result.data.html = patch.html;
      if (typeof patch.css === "string") result.data.css = patch.css;
    }
    if (patch.palette && typeof patch.palette === "object") {
      result.palette = Object.assign({}, entry.palette || {}, patch.palette);
    }
    return Object.keys(result).length ? result : null;
  }

  // 修 #7: 统一修改 chat 状态——加可取消 + 进度条 + 退避重试
  let _unifiedAborted = false;
  function abortUnifiedModifyChat() { _unifiedAborted = true; }

  // 跑一次带退避重试的 unifiedPatchOne。429 / 5xx / network 错误指数退避，最多 3 次。
  async function unifiedPatchOneWithRetry(entry, instruction) {
    const isRateOrTransient = (msg) =>
      /\b(429|5\d\d|rate.?limit|timeout|fetch.*failed|network|ECONN|ETIMEDOUT)\b/i.test(String(msg || ""));
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (_unifiedAborted) throw new Error("用户已取消");
      try {
        return await unifiedPatchOne(entry, instruction);
      } catch (e) {
        lastErr = e;
        const msg = e?.message || String(e);
        if (!isRateOrTransient(msg) || attempt === 2) throw e;
        // 指数退避：1s → 2s → 4s
        const waitMs = (2 ** attempt) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }

  async function submitUnifiedModifyChat() {
    const ta = els.htmlPreviewUnifiedInput;
    if (!ta) return;
    const instruction = (ta.value || "").trim();
    if (!instruction) return;
    const cache = global.WpsAiHtmlCache;
    if (!cache) {
      appendUnifiedChatMsg("ai-err", "缓存模块未加载。");
      return;
    }
    const entries = cache.list?.() || [];
    if (!entries.length) {
      appendUnifiedChatMsg("ai-err", "「我的历史」没有任何条目，无可批量修改。");
      return;
    }
    ta.value = "";
    appendUnifiedChatMsg("user", instruction);

    // 修 #7: 进度条 bubble + 停止按钮
    _unifiedAborted = false;
    const pending = appendUnifiedChatMsg("ai-pending", "");
    if (pending) {
      pending.innerHTML =
        `<div class="unified-progress">` +
          `<div class="unified-progress-head">` +
            `<span class="unified-progress-label">开始处理 ${entries.length} 条历史…</span>` +
            `<button type="button" class="unified-progress-stop ghost-btn compact-btn">停止</button>` +
          `</div>` +
          `<div class="unified-progress-bar"><div class="unified-progress-bar-fill"></div></div>` +
        `</div>`;
      pending.querySelector(".unified-progress-stop")?.addEventListener("click", abortUnifiedModifyChat);
    }
    const labelEl = pending?.querySelector(".unified-progress-label");
    const fillEl = pending?.querySelector(".unified-progress-bar-fill");
    const stopBtn = pending?.querySelector(".unified-progress-stop");

    let okCount = 0, skipped = 0, failed = 0;
    const errs = [];
    for (let i = 0; i < entries.length; i++) {
      if (_unifiedAborted) break;
      const e = entries[i];
      if (labelEl) labelEl.textContent = `处理中 ${i + 1}/${entries.length}：${e.templateName} / ${e.layout}`;
      if (fillEl) fillEl.style.width = ((i / entries.length) * 100).toFixed(1) + "%";
      try {
        const patch = await unifiedPatchOneWithRetry(e, instruction);
        if (!patch) { skipped += 1; continue; }
        cache.update(e.id, patch);
        okCount += 1;
      } catch (err) {
        if (_unifiedAborted) break;
        failed += 1;
        errs.push(`${e.templateName}/${e.layout}: ${err?.message || err}`);
      }
    }
    if (fillEl) fillEl.style.width = "100%";
    if (stopBtn) stopBtn.disabled = true;
    if (pending) pending.remove();

    // 当前预览的 slide 如果在历史里，也需要 reload 一下 state 才能看到改动
    if (htmlPreviewState?.id) {
      const refreshed = cache.get?.(htmlPreviewState.id);
      if (refreshed) {
        htmlPreviewState.data = Object.assign({}, refreshed.data || {});
        htmlPreviewState.palette = Object.assign({}, refreshed.palette || {});
        if (refreshed.layout && refreshed.layout !== htmlPreviewState.layout) {
          htmlPreviewState.layout = refreshed.layout;
          if (els.htmlPreviewLayout) els.htmlPreviewLayout.textContent = refreshed.layout;
        }
        renderHtmlPreviewFields();
        renderHtmlPreviewIntoIframe();
      }
    }
    renderHtmlTemplateGallery();
    updateHtmlPreviewHistoryBadge();

    const summary = [`改动 ${okCount} 条`];
    if (skipped) summary.push(`跳过 ${skipped} 条（AI 判定与该指令无关）`);
    if (failed) summary.push(`失败 ${failed} 条`);
    if (_unifiedAborted) summary.push(`已停止（用户取消）`);
    appendUnifiedChatMsg("ai", summary.join("，") + "。" + (errs.length ? "\n失败明细：\n" + errs.slice(0, 3).join("\n") : ""));
    _unifiedAborted = false;
  }

  // 抽取后预览弹窗：列出本次入库的组件（带缩略图 + 复选框）
  // 用户可以"全部保留"（默认）或"删除未勾选"（把没选的从库里 remove 掉）
  let _extractedReviewCurrent = null; // { saved: [], dupExisting, dupBatch, saveErrs }
  function openExtractedComponentsReview(saved, info) {
    const overlay = els.htmlPreviewExtractReviewModal;
    if (!overlay) return;
    _extractedReviewCurrent = { saved, ...info };
    if (els.htmlPreviewExtractReviewTitle) {
      els.htmlPreviewExtractReviewTitle.textContent = `本次抽到 ${saved.length} 个组件`;
    }
    if (els.htmlPreviewExtractReviewSummary) {
      const bits = [];
      if (info.dupExisting?.length) bits.push(`${info.dupExisting.length} 个跟库里重复（已跳过）`);
      if (info.dupBatch?.length) bits.push(`${info.dupBatch.length} 个本批内重复（已跳过）`);
      if (info.saveErrs?.length) bits.push(`${info.saveErrs.length} 个保存失败`);
      els.htmlPreviewExtractReviewSummary.textContent = bits.length ? bits.join("，") : "全部入库成功";
    }
    renderExtractedReviewList(saved);
    overlay.classList.remove("hidden");
  }
  function closeExtractedComponentsReview() {
    els.htmlPreviewExtractReviewModal?.classList.add("hidden");
    _extractedReviewCurrent = null;
  }
  function renderExtractedReviewList(comps) {
    const host = els.htmlPreviewExtractReviewList;
    if (!host) return;
    host.innerHTML = "";
    const palette = currentPaletteForPreview();
    comps.forEach((c) => {
      const card = document.createElement("div");
      card.className = "component-picker-item selected"; // 默认全勾
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "component-picker-item-thumb component-thumb-fit";
      let thumbHtml;
      try { thumbHtml = makeComponentThumbHtml(c, palette); }
      catch (e) { thumbHtml = `<html><body style="color:#c00">${e?.message}</body></html>`; }
      const ifr = document.createElement("iframe");
      ifr.setAttribute("sandbox", "allow-same-origin");
      try { ifr.srcdoc = thumbHtml; } catch (e) {}
      ifr.addEventListener("load", () => { bridgeEchartsToFrame(ifr); fitComponentThumb(ifr, thumbWrap); });
      thumbWrap.appendChild(ifr);
      card.appendChild(thumbWrap);

      const row1 = document.createElement("div");
      row1.className = "component-picker-item-row1";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.compId = c.id;
      const name = document.createElement("span");
      name.className = "component-picker-item-name";
      name.textContent = c.name || c.id;
      row1.appendChild(cb);
      row1.appendChild(name);
      // 单条直接删除：从库里 remove，从当前 review list DOM 中拿掉
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "component-picker-item-del";
      delBtn.title = "从组件库删除这条";
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm(`从组件库删除「${c.name}」？此操作不可撤销。`)) return;
        global.WpsAiHtmlComponents?.remove?.(c.id);
        // 也把所有 slide 对它的选择引用清掉
        pickedComponentsByKey.forEach((arr, k) => {
          const filtered = arr.filter((x) => x !== c.id);
          if (filtered.length !== arr.length) {
            if (filtered.length) pickedComponentsByKey.set(k, filtered);
            else pickedComponentsByKey.delete(k);
          }
        });
        savePickedComponentsToStorage();
        card.remove();
        if (_galleryActiveTab === "components") renderHtmlTemplateGallery();
        // 全部被删了，关掉 review 弹窗
        if (!host.children.length) closeExtractedComponentsReview();
      });
      row1.appendChild(delBtn);
      card.appendChild(row1);
      if (c.description) {
        const desc = document.createElement("div");
        desc.className = "component-picker-item-desc";
        desc.textContent = c.description;
        card.appendChild(desc);
      }
      card.addEventListener("click", (ev) => {
        if (ev.target.tagName === "INPUT" || ev.target === delBtn) return;
        cb.checked = !cb.checked;
        card.classList.toggle("selected", cb.checked);
      });
      cb.addEventListener("change", () => card.classList.toggle("selected", cb.checked));
      host.appendChild(card);
    });
  }
  function discardUncheckedExtracted() {
    if (!_extractedReviewCurrent) return;
    const host = els.htmlPreviewExtractReviewList;
    const compStore = global.WpsAiHtmlComponents;
    let removed = 0;
    host?.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (!cb.checked && cb.dataset.compId) {
        compStore?.remove?.(cb.dataset.compId);
        removed += 1;
      }
    });
    if (_galleryActiveTab === "components") renderHtmlTemplateGallery();
    closeExtractedComponentsReview();
    showMessage(removed ? `已删除 ${removed} 个未勾选组件，其余保留。` : "全部保留。", "success");
  }

  // 「提取组件」按钮：让 AI 把当前 freeform 幻灯片拆成若干可复用组件，每个独立存到组件库
  async function extractComponentsFromCurrentSlide() {
    const st = htmlPreviewState;
    if (!st || st.layout !== "freeform") {
      showMessage("只有 freeform 布局可以提取组件。当前请先切到 freeform 排版。", "error");
      return;
    }
    const html = String(st.data?.html || "").trim();
    const css = String(st.data?.css || "").trim();
    if (!html) {
      showMessage("freeform 的 html 字段是空的，无可提取。", "error");
      return;
    }
    if (!global.WpsAiHtmlComponents) {
      showMessage("组件库模块未加载。", "error");
      return;
    }
    const btn = els.htmlPreviewExtractCompsBtn;
    if (btn) { btn.disabled = true; btn.textContent = "AI 提取中…"; }
    showMessage("AI 正在抽取组件，可能需要 10-30 秒…", "info", { autoHide: false });

    const systemPrompt = [
      "你是 HTML 幻灯片的**组件抽取助手**。我会给你一张幻灯片的 body HTML + CSS。",
      "任务：找出**可复用的视觉单元**，**两类都算**：",
      "  ① 信息组件：指标卡、状态徽章、完成清单项、引言块、章节眉签 + 标题、双栏对比卡、Gantt 条目、团队成员卡 等",
      "  ② 装饰组件：渐变背景条、顶部 4px 装饰线、角落几何装饰、icon 集群、分隔器、徽章圆环、底部水印、纯视觉边框 等",
      "**纯装饰、没有具体含义的视觉元素也要抽出来** —— 这些是整套 PPT 风格统一的关键，复用价值极高。",
      "",
      "每个组件必须满足：",
      "1. **自包含**：HTML + CSS 可以独立挪到其他幻灯片的 freeform 直接渲染，不依赖外部 class / 上下文。",
      "2. **通用**：能装不同内容时用占位符（`{标题}` / `{数字}` / `{描述}`），纯装饰组件不需要占位符（本来就没文字）。**不要写死当前 slide 的具体内容**（如把\"软发 iPark 二期\"写死进 HTML）。",
      "3. **语义化命名**：name 用 kebab-case 描述\"是什么\"，如 metric-card / status-pill / completed-item / quote-pull / section-eyebrow / gradient-top-bar / corner-deco-orange / icon-cluster-row。",
      "4. **描述清晰**：description 一句话说明用途和适用场景（信息组件描述\"装什么内容\"；装饰组件描述\"用在哪里\"）。",
      "5. CSS 只放该组件相关的样式，颜色 / 字体必须用 `var(--primary)` / `var(--accent)` / `var(--title-color)` / `var(--body-color)` / `var(--surface)` / `var(--bg)` / `var(--title-font)` / `var(--body-font)` 等全局变量，不要硬编码 #RRGGBB（包括装饰组件）。",
      "6. 字号要符合 PPT 演示尺寸：正文 ≥24px、标题 ≥40px、metric 数字 80-200px（不含装饰组件）。",
      "",
      "**严格只输出一段 raw JSON 数组**，禁止解释、寒暄、markdown 围栏。格式：",
      '[{"name": "metric-card", "description": "...", "html": "<div class=\\"metric-card\\">...</div>", "css": ".metric-card { ... }"}, ...]',
      "",
      "如果幻灯片真的什么都没有（白底纯文字），返回 `[]`（空数组）—— 但大部分页面都会有装饰元素可抽。",
      "组件之间不要有重叠 —— 一段 HTML 出现在某个组件里，就不要再单独抽成另一个组件。",
      "组件数量建议 3-8 个之间（含装饰），太多反而难复用。"
    ].join("\n");
    const userText = [
      `<!-- BODY HTML -->`,
      html,
      "",
      "<!-- CSS -->",
      css || "(无独立 CSS)"
    ].join("\n");

    let raw = "";
    try {
      raw = await callProviderForPreviewChat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ],
        null // 不需要流式更新 UI
      );
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "提取组件"; }
      showMessage(`AI 调用失败：${e?.message || e}`, "error");
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = "提取组件"; }

    // 解析返回的 JSON 数组（容错 markdown 围栏 / 前后多余文字）
    let arr;
    try {
      let s = String(raw || "").trim();
      s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const first = s.indexOf("[");
      const last = s.lastIndexOf("]");
      if (first < 0 || last < 0 || last < first) throw new Error("找不到 JSON 数组");
      arr = JSON.parse(s.slice(first, last + 1));
    } catch (e) {
      showMessage(`AI 返回不是合法 JSON 数组：${String(raw).slice(0, 200)}`, "error");
      return;
    }
    if (!Array.isArray(arr) || !arr.length) {
      showMessage("AI 没识别出可独立复用的组件（页面可能太简单 / 太特化）。", "info");
      return;
    }

    // 去重：跟库里已存"等价"组件 + 本批次自身重复
    const normalizeForDedup = (h, c) => {
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      return n(h) + "|||" + n(c);
    };
    const existingHashes = new Set();
    (global.WpsAiHtmlComponents.list?.() || []).forEach((c) => {
      existingHashes.add(normalizeForDedup(c.html, c.css));
    });

    const toSave = [], dupExisting = [], dupBatch = [], invalid = [];
    const batchSeen = new Set();
    arr.forEach((c, i) => {
      if (!c || typeof c !== "object") { invalid.push(`#${i + 1}: 不是对象`); return; }
      const name = String(c.name || "").trim();
      const compHtml = String(c.html || "").trim();
      const compCss = String(c.css || "").trim();
      if (!name || !compHtml) { invalid.push(`#${i + 1}: 缺 ${!name ? "name" : "html"}`); return; }
      const hash = normalizeForDedup(compHtml, compCss);
      if (existingHashes.has(hash)) { dupExisting.push(name); return; }
      if (batchSeen.has(hash)) { dupBatch.push(name); return; }
      batchSeen.add(hash);
      toSave.push({ name, description: String(c.description || "").trim(), html: compHtml, css: compCss });
    });

    if (!toSave.length) {
      const summary = [];
      if (dupExisting.length) summary.push(`${dupExisting.length} 个已在库`);
      if (dupBatch.length) summary.push(`${dupBatch.length} 个本批重复`);
      if (invalid.length) summary.push(`${invalid.length} 个格式错`);
      showMessage(`没有新组件入库：${summary.join("，")}`, "info");
      return;
    }

    // 落库
    const saved = [];
    const saveErrs = [];
    toSave.forEach((c) => {
      try {
        const s = global.WpsAiHtmlComponents.save({
          ...c,
          sourceSlideId: st.id || null
        });
        saved.push(s);
      } catch (e) {
        saveErrs.push(`${c.name}: ${e?.message || e}`);
      }
    });

    if (_galleryActiveTab === "components") renderHtmlTemplateGallery();

    if (saved.length) {
      openExtractedComponentsReview(saved, { dupExisting, dupBatch, saveErrs });
    } else {
      showMessage(`组件全部入库失败：${saveErrs.slice(0, 3).join("；")}`, "error");
    }
  }

  // 「选用组件」按钮：弹窗 + 复选框
  function openComponentsPicker() {
    const overlay = els.htmlPreviewComponentsPicker;
    if (!overlay) return;
    renderComponentPickerList();
    overlay.classList.remove("hidden");
  }
  function closeComponentsPicker() {
    els.htmlPreviewComponentsPicker?.classList.add("hidden");
  }
  function renderComponentPickerList() {
    const host = els.htmlPreviewComponentsList;
    if (!host) return;
    host.innerHTML = "";
    const compStore = global.WpsAiHtmlComponents;
    const items = compStore?.list?.() || [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "component-picker-empty";
      empty.innerHTML = "组件库空空如也。<br>在 freeform 预览底部点「保存为组件」往里加。";
      host.appendChild(empty);
      return;
    }
    const picked = new Set(getPickedComponentIds());
    const palette = currentPaletteForPreview();
    items.forEach((c) => {
      const card = document.createElement("div");
      card.className = "component-picker-item" + (picked.has(c.id) ? " selected" : "");
      // 按组件实际尺寸缩放：用 makeComponentThumbHtml + fitComponentThumb
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "component-picker-item-thumb component-thumb-fit";
      let thumbHtml;
      try { thumbHtml = makeComponentThumbHtml(c, palette); }
      catch (e) { thumbHtml = `<html><body style="padding:20px;font-family:sans-serif;color:#c00;font-size:11px">渲染失败：${e?.message || e}</body></html>`; }
      const ifr = document.createElement("iframe");
      ifr.setAttribute("sandbox", "allow-same-origin");
      try { ifr.srcdoc = thumbHtml; } catch (e) {}
      ifr.addEventListener("load", () => { bridgeEchartsToFrame(ifr); fitComponentThumb(ifr, thumbWrap); });
      thumbWrap.appendChild(ifr);
      card.appendChild(thumbWrap);

      const row1 = document.createElement("div");
      row1.className = "component-picker-item-row1";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = picked.has(c.id);
      cb.dataset.compId = c.id;
      const name = document.createElement("span");
      name.className = "component-picker-item-name";
      name.textContent = c.name || c.id;
      row1.appendChild(cb);
      row1.appendChild(name);
      card.appendChild(row1);
      if (c.description) {
        const desc = document.createElement("div");
        desc.className = "component-picker-item-desc";
        desc.textContent = c.description;
        card.appendChild(desc);
      }
      const meta = document.createElement("div");
      meta.className = "component-picker-item-meta";
      const ts = document.createElement("span");
      ts.textContent = formatHtmlPreviewTs(c.ts);
      meta.appendChild(ts);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "component-picker-item-del";
      delBtn.title = "从组件库删除这条";
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm(`从组件库删除「${c.name}」？此操作不可撤销。`)) return;
        compStore.remove(c.id);
        // 也把所有 slide 对它的引用清掉
        pickedComponentsByKey.forEach((arr, k) => {
          const filtered = arr.filter((x) => x !== c.id);
          if (filtered.length !== arr.length) {
            if (filtered.length) pickedComponentsByKey.set(k, filtered);
            else pickedComponentsByKey.delete(k);
          }
        });
        savePickedComponentsToStorage();
        renderComponentPickerList();
        updatePickedComponentsCountBadge();
      });
      meta.appendChild(delBtn);
      card.appendChild(meta);
      // 点整张卡 = 切换勾选
      card.addEventListener("click", (ev) => {
        if (ev.target === delBtn || delBtn.contains(ev.target)) return;
        cb.checked = !cb.checked;
        card.classList.toggle("selected", cb.checked);
      });
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", () => {
        card.classList.toggle("selected", cb.checked);
      });
      host.appendChild(card);
    });
  }
  function confirmComponentsPicker() {
    const host = els.htmlPreviewComponentsList;
    if (!host) return;
    const ids = Array.from(host.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.compId)
      .filter(Boolean);
    setPickedComponentIds(ids);
    closeComponentsPicker();
    if (ids.length) {
      showMessage(`已选 ${ids.length} 个组件 —— 下一次美化时 AI 会优先复用它们。`, "info");
    }
  }
  function clearComponentsPicker() {
    const host = els.htmlPreviewComponentsList;
    if (!host) return;
    host.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
      cb.closest(".component-picker-item")?.classList.remove("selected");
    });
  }

  function bindHtmlPreviewModal() {
    if (!els.htmlPreviewModal) return;
    // 幂等守卫：dialog 模式下这个函数会被显式调用一次 + IIFE 末尾 setTimeout 再调一次。
    // 不加 guard 会导致所有 click handler 重复绑定（画廊/历史 toggle 互相抵消、插入/发送触发 2 次）。
    if (bindHtmlPreviewModal._bound) return;
    bindHtmlPreviewModal._bound = true;
    els.htmlPreviewCloseBtn?.addEventListener("click", closeHtmlPreviewModal);
    els.htmlPreviewInsertBtn?.addEventListener("click", confirmHtmlPreviewInsert);
    els.htmlPreviewReplaceBtn?.addEventListener("click", confirmHtmlPreviewReplace);
    els.htmlPreviewReplaceActiveBtn?.addEventListener("click", confirmHtmlPreviewReplaceActive);
    els.htmlPreviewSaveBtn?.addEventListener("click", saveHtmlPreviewToCache);
    // 组件库
    els.htmlPreviewSaveAsCompBtn?.addEventListener("click", openSaveAsComponentDialog);
    els.htmlPreviewSaveAsCompCloseBtn?.addEventListener("click", closeSaveAsComponentDialog);
    els.htmlPreviewSaveAsCompConfirmBtn?.addEventListener("click", confirmSaveAsComponent);
    els.htmlPreviewExtractCompsBtn?.addEventListener("click", extractComponentsFromCurrentSlide);
    // 抽取后的预览/审阅弹窗
    els.htmlPreviewExtractReviewCloseBtn?.addEventListener("click", closeExtractedComponentsReview);
    els.htmlPreviewExtractReviewKeepAllBtn?.addEventListener("click", closeExtractedComponentsReview);
    els.htmlPreviewExtractReviewDiscardBtn?.addEventListener("click", discardUncheckedExtracted);
    els.htmlPreviewExtractReviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewExtractReviewModal) closeExtractedComponentsReview();
    });
    // 编辑模式
    els.htmlPreviewEditModeBtn?.addEventListener("click", toggleEditMode);
    els.htmlPreviewToggleRulerBtn?.addEventListener("click", toggleRuler);
    // 中栏 tab：画布 / 属性 切换
    document.querySelectorAll(".html-preview-center-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchCenterTab(btn.dataset.centerTab));
    });
    // 恢复上次的标尺显隐偏好（默认显示）
    try {
      const saved = localStorage.getItem(RULER_VISIBLE_KEY);
      applyRulerVisibility(saved === null ? true : saved === "1");
    } catch (e) { applyRulerVisibility(true); }
    els.htmlPreviewEditElCloseBtn?.addEventListener("click", editorCloseEditPopup);
    els.htmlPreviewEditElCancelBtn?.addEventListener("click", editorCloseEditPopup);
    els.htmlPreviewEditElApplyBtn?.addEventListener("click", editorApplyEditPopup);
    els.htmlPreviewEditElModal?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewEditElModal) editorCloseEditPopup();
    });
    els.htmlPreviewSaveAsCompModal?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewSaveAsCompModal) closeSaveAsComponentDialog();
    });
    els.htmlPreviewPickComponentsBtn?.addEventListener("click", openComponentsPicker);
    els.htmlPreviewPickComponentsCloseBtn?.addEventListener("click", closeComponentsPicker);
    els.htmlPreviewPickComponentsConfirmBtn?.addEventListener("click", confirmComponentsPicker);
    els.htmlPreviewPickComponentsClearBtn?.addEventListener("click", clearComponentsPicker);
    els.htmlPreviewComponentsPicker?.addEventListener("click", (ev) => {
      if (ev.target === els.htmlPreviewComponentsPicker) closeComponentsPicker();
    });
    // chat 工具栏的「画廊」按钮：现在 = 打开预览 modal（画廊在 modal 内左侧永久可见）
    els.chatHtmlGalleryBtn?.addEventListener("click", () => {
      openHtmlPreviewModal({});
    });
    // 画廊里直接清空缓存历史：清完就地刷新，「我的历史」区块立刻消失。
    // 一次清不干净（某些 WebView 的 localStorage 写入异步/竞争）就最多重试 3 次。
    // tab 切换：我的历史 / 模板（事件委托到侧栏 head）
    document.querySelectorAll(".gallery-tab").forEach((btn) => {
      btn.addEventListener("click", () => setGalleryTab(btn.dataset.galleryTab));
    });
    // 侧栏底部「清空所有」按钮（按当前 tab 决定清谁）
    els.htmlTemplateGalleryClearBtn?.addEventListener("click", clearGalleryActiveTab);
    // chat 双 tab 切换（美化当前 / 统一修改）
    document.querySelectorAll(".preview-chat-tab").forEach((btn) => {
      btn.addEventListener("click", () => setPreviewChatTab(btn.dataset.chatTab));
    });
    // modal 内 chat 输入
    els.htmlPreviewChatSendBtn?.addEventListener("click", submitHtmlPreviewChat);
    els.htmlPreviewChatInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.shiftKey) return;
      ev.preventDefault();
      submitHtmlPreviewChat();
    });
    // 统一修改 chat 输入
    els.htmlPreviewUnifiedSendBtn?.addEventListener("click", submitUnifiedModifyChat);
    els.htmlPreviewUnifiedInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.shiftKey) return;
      ev.preventDefault();
      submitUnifiedModifyChat();
    });
    els.htmlPreviewUnifiedInput?.addEventListener("paste", (ev) => {
      const txt = ev.clipboardData?.getData("text") || "";
      if (!txt) return;
      ev.preventDefault();
      insertAtCursor(ev.currentTarget, txt);
    });
    // 启动时回放统一修改 chat
    renderUnifiedChatLogFromStore();
    // 显式 paste 处理：WPS Application.ShowDialog 开的独立 WebView 里，textarea 默认 paste
    // 在部分版本有 bug（剪贴板内容进不来）。手动从 clipboardData 取文本插入到光标位置。
    els.htmlPreviewChatInput?.addEventListener("paste", (ev) => {
      const txt = ev.clipboardData?.getData("text") || "";
      if (!txt) return; // 没拿到文本就让默认行为继续（兜底）
      ev.preventDefault();
      insertAtCursor(ev.currentTarget, txt);
    });
    els.htmlPreviewChatClearBtn?.addEventListener("click", () => {
      // 清当前 active tab 的对话日志
      if (_previewChatActiveTab === "unified") clearUnifiedChatLog();
      else clearPreviewChatLog();
    });
    els.htmlPreviewHistoryBtn?.addEventListener("click", () => {
      const isShown = !els.htmlPreviewHistoryPanel?.classList.contains("hidden");
      toggleHtmlPreviewHistoryPanel(!isShown);
    });
    els.htmlPreviewHistoryCloseBtn?.addEventListener("click", () => toggleHtmlPreviewHistoryPanel(false));
    els.htmlPreviewHistoryClearBtn?.addEventListener("click", () => {
      if (!confirm("清空所有 HTML 模板缓存记录？此操作不可撤销。")) return;
      if (htmlPreviewState?.id) htmlPreviewState.id = null;
      let tries = 0;
      while (tries < 3) {
        global.WpsAiHtmlCache?.clear?.();
        const remaining = global.WpsAiHtmlCache?.list?.() || [];
        if (!remaining.length) break;
        tries += 1;
      }
      renderHtmlPreviewHistory();
      updateHtmlPreviewHistoryBadge();
      // 画廊里有「我的历史」区块，缓存清了也要刷一遍把那些缩略图去掉
      if (els.htmlTemplateGallery && !els.htmlTemplateGallery.classList.contains("hidden")) {
        renderHtmlTemplateGallery();
      }
    });
  }

  // 暴露给工具调用方：global.WpsAiHtmlPreview.open(opts) / getState() / ...
  // ===== 撤销 wpp_render_full_deck 批量插入 =====
  // 按 batchTag 一键删除：① 所有打了同 tag 的 WPS slide ② 缓存里所有同 tag 的 entry
  async function undoFullDeckBatch(batchTag) {
    if (!batchTag) return { ok: false, message: "batchTag 不能为空" };
    const app = global.WpsAiAddon?.getApplicationSync?.();
    const pres = app?.ActivePresentation;
    if (!pres) return { ok: false, message: "拿不到 ActivePresentation" };
    let removedSlides = 0;
    // 倒序删 slide（删 i 后 i+1...n 的 SlideIndex 全部 -1，正序删会跳过）
    try {
      const total = pres.Slides?.Count || 0;
      for (let i = total; i >= 1; i -= 1) {
        try {
          const slide = pres.Slides.Item(i);
          const tag = slide?.Tags?.Item?.("LingxiBatch");
          if (tag === batchTag) {
            slide.Delete();
            removedSlides += 1;
          }
        } catch (e) { /* 单页失败继续 */ }
      }
    } catch (e) {
      console.warn("[undoBatch] 遍历 slide 失败:", e?.message || e);
    }
    // 删缓存里同 tag 的所有 entry
    let removedCacheCount = 0;
    try { removedCacheCount = global.WpsAiHtmlCache?.removeBatch?.(batchTag) || 0; } catch (e) {}
    // 刷画廊（如果预览开着的话）
    try { renderHtmlTemplateGallery(); } catch (e) {}
    try { updateHtmlPreviewHistoryBadge?.(); } catch (e) {}
    return {
      ok: true,
      batchTag,
      removedSlides,
      removedCacheCount,
      message: `已撤销批量插入：删 ${removedSlides} 张 PPT 幻灯片、${removedCacheCount} 条缓存。`
    };
  }

  global.WpsAiHtmlPreview = {
    open: openHtmlPreviewModal,
    close: closeHtmlPreviewModal,
    isOpen: () => !els.htmlPreviewModal?.classList.contains("hidden"),
    // 暴露当前 state 的浅快照（系统 prompt 用，注意不暴露 onConfirm 等内部回调）
    getState: () => {
      const open = !els.htmlPreviewModal?.classList.contains("hidden");
      if (!open || !htmlPreviewState) return null;
      return {
        templateName: htmlPreviewState.templateName,
        layout: htmlPreviewState.layout,
        data: Object.assign({}, htmlPreviewState.data || {}),
        palette: Object.assign({}, htmlPreviewState.palette || {}),
        slideHint: htmlPreviewState.slideHint
      };
    },
    // 撤销 wpp_render_full_deck 批量插入（按 batchTag 删 slide + cache）。供 AI 工具回调 / 用户控制台直调
    undoBatch: undoFullDeckBatch,
    // 列出所有可撤销的 batch（最近优先）：调试 / 后续做 UI 列表
    listBatches: () => global.WpsAiHtmlCache?.listBatches?.() || []
  };

  // 启动时把绑定注册一次（必须在 bindElements 之后）。
  // 通过 DOMContentLoaded 兜底：如果 bindElements 已跑过就直接调；否则等 DOM ready 再调。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(bindHtmlPreviewModal, 0));
  } else {
    setTimeout(bindHtmlPreviewModal, 0);
  }
})(window);
