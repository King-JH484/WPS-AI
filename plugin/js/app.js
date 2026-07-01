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
  // ?mode=materials：当前页是不是被 Application.ShowDialog 打开的独立素材库窗口
  const isMaterialsDialog = /[?&]mode=materials(?:&|$)/i.test(window.location.search);
  // ?mode=quickprompt：当前页是不是被 Application.ShowDialog 打开的 ribbon 快捷输入窗口
  const isQuickPromptDialog = /[?&]mode=quickprompt(?:&|$)/i.test(window.location.search);
  // ?mode=formatpreview：当前页是不是被 Application.ShowDialog 打开的 AI 排版预览窗口
  const isFormatPreviewDialog = /[?&]mode=formatpreview(?:&|$)/i.test(window.location.search);
  // ?mode=selectionpreview：当前页是不是被 Application.ShowDialog 打开的选区处理预览窗口
  const isSelectionPreviewDialog = /[?&]mode=selectionpreview(?:&|$)/i.test(window.location.search);

  // 独立预览窗口与主 TaskPane 之间的 IPC：用 localStorage 传 state + 结果
  const PREVIEW_DIALOG_REQUEST_KEY = "lingxi_html_preview_dialog_request_v1";
  const PREVIEW_DIALOG_RESULT_KEY = "lingxi_html_preview_dialog_result_v1";
  // 非阻塞 ShowDialog 的 WPS 版本下用：dialog 写"待执行任务"到这里 → MAIN 用 storage 事件接住
  const PREVIEW_DIALOG_PENDING_INSERT_KEY = "lingxi_html_preview_pending_insert_v1";
  const MATERIAL_DIALOG_INSERT_KEY = "lingxi_material_dialog_insert_v1";
  const MATERIAL_DIALOG_MODIFY_KEY = "lingxi_material_dialog_modify_v1";
  const QUICK_PROMPT_DIALOG_REQUEST_KEY = "lingxi_quick_prompt_dialog_request_v1";
  const QUICK_PROMPT_DIALOG_RESULT_KEY = "lingxi_quick_prompt_dialog_result_v1";
  const FORMAT_PREVIEW_DIALOG_REQUEST_KEY = "lingxi_format_preview_dialog_request_v1";
  const FORMAT_PREVIEW_DIALOG_RESULT_KEY = "lingxi_format_preview_dialog_result_v1";
  const SELECTION_PREVIEW_DIALOG_REQUEST_KEY = "lingxi_selection_preview_dialog_request_v1";
  const SELECTION_PREVIEW_DIALOG_RESULT_KEY = "lingxi_selection_preview_dialog_result_v1";

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
    const where = isPreviewDialog ? "DIALOG" : (isSettingsDialog ? "SETTINGS" : (isStylePresetDialog ? "STYLEPRESET" : (isMaterialsDialog ? "MATERIALS" : (isQuickPromptDialog ? "QUICKPROMPT" : (isFormatPreviewDialog ? "FORMATPREVIEW" : (isSelectionPreviewDialog ? "SELECTIONPREVIEW" : "MAIN"))))));
    try { console.log(`[lingxi-preview][${where}][${tag}]`, ...args); } catch (e) {}
    _appendPersistedLog("LOG", where, tag, args);
  }
  function pwarn(tag, ...args) {
    const where = isPreviewDialog ? "DIALOG" : (isSettingsDialog ? "SETTINGS" : (isStylePresetDialog ? "STYLEPRESET" : (isMaterialsDialog ? "MATERIALS" : (isQuickPromptDialog ? "QUICKPROMPT" : (isFormatPreviewDialog ? "FORMATPREVIEW" : (isSelectionPreviewDialog ? "SELECTIONPREVIEW" : "MAIN"))))));
    try { console.warn(`[lingxi-preview][${where}][${tag}]`, ...args); } catch (e) {}
    _appendPersistedLog("WARN", where, tag, args);
  }
  // 暴露 plog/pwarn 给其他模块（presentation.js 等）用，方便集中日志
  window.WpsAiLog = { log: plog, warn: pwarn };
  // 脚本版本标记 —— 用户排查"是不是装载到新代码"时直接看这一行
  const SCRIPT_VERSION = "2026-07-01-r20-preserve-list-format";
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
      "brandVersion", "aboutVersion", "updateAvailableBadge",
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
      "imageProvidersList", "addImageProviderBtn",
      "saveSettingsBtn", "saveSettingsOnlyBtn", "testChatConnBtn",
      "exportSettingsBtn", "importSettingsBtn", "importSettingsFile",
      // 缓存管理 UI
      "cacheTotalBadge", "cacheRefreshBtn", "cacheClearSafeBtn", "cacheGroupsList",
      // 灰度更新 UI
      "updateChannelBadge", "aboutDeviceSn", "copyDeviceSnBtn",
      "aboutHomepageLink", "copyHomepageBtn",
      // 开发者工具（dev mode 才显示）
      "devToolsSection", "devModeBadge", "devScriptVersionBadge",
      "dumpPreviewLogsBtn", "clearPreviewLogsBtn", "viewPreviewLogsBtn",
      "devLogViewerModal", "devLogViewerOutput", "devLogViewerStats",
      "devLogViewerFilter", "devLogViewerWarnOnly",
      "devLogViewerCloseBtn", "devLogViewerRefreshBtn",
      "devLogViewerCopyBtn", "devLogViewerScrollBottomBtn",
      // PPT 风格 modal
      "stylePresetModal", "stylePresetCloseBtn", "styleSaveBtn",
      "styleEnabled", "styleTitleFont", "styleTitleSize", "styleTitleBold", "styleTitleColor",
      "styleBodyFont", "styleBodySize", "styleBodyColor",
      "styleScheme", "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor", "styleBackgroundColor", "styleSurfaceColor",
      "styleThemeFile",
      // PPT 风格 — 主题预览卡 + 可视化主题网格 + 实时预览
      "styleSchemePreview", "styleSchemePreviewLabel", "styleSchemePreviewDesc",
      "styleSchemePreviewSwatches", "styleSchemePreviewSignature", "styleSchemePreviewHints",
      "styleThemeGrid", "styleLivePreview", "styleLiveMeta",
      // HTML 模板预览 modal
      "htmlPreviewModal", "htmlPreviewTitle", "htmlPreviewCloseBtn", "htmlPreviewInsertBtn",
      "htmlPreviewReplaceActiveBtn", "htmlPreviewSaveBtn",
      // 组件库相关
      "htmlPreviewSaveAsCompBtn", "htmlPreviewSaveAsCompModal", "htmlPreviewSaveAsCompCloseBtn",
      "htmlPreviewSaveAsCompName", "htmlPreviewSaveAsCompDesc", "htmlPreviewSaveAsCompTip",
      "htmlPreviewSaveAsCompConfirmBtn",
      "htmlPreviewExtractCompsBtn",
      "htmlPreviewExtractReviewModal", "htmlPreviewExtractReviewTitle", "htmlPreviewExtractReviewCloseBtn",
      "htmlPreviewExtractReviewList", "htmlPreviewExtractReviewSummary",
      "htmlPreviewExtractReviewDiscardBtn", "htmlPreviewExtractReviewKeepAllBtn",
      // 编辑模式 / 标尺
      "htmlPreviewEditModeBtn", "htmlPreviewEditUndoBtn", "htmlPreviewEditRedoBtn",
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
      "chatHtmlGalleryBtn", "chatContextActions",
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
      // Ribbon 快捷输入
      "quickPromptModal", "quickPromptTitle", "quickPromptSubtitle", "quickPromptCloseBtn",
      "quickPromptBody", "quickPromptCancelBtn", "quickPromptSubmitBtn",
      // 生图素材库
      "materialLibraryModal", "materialLibraryCloseBtn", "materialLibraryRefreshBtn", "materialLibraryClearBtn",
      "materialLibraryList", "materialLibraryEmpty",
      "materialGroupList", "materialGroupNameInput", "materialGroupAddBtn",
      "materialSelectedCount", "materialMoveGroupSelect", "materialMoveBtn",
      "materialInsertBtn", "materialModifyBtn", "materialCopyBtn", "materialDeleteBtn",
      "materialPreviewModal", "materialPreviewCloseBtn", "materialPreviewImage", "materialPreviewStatus",
      "materialPreviewPrompt", "materialPreviewMeta", "materialPreviewUrl",
      "materialPreviewInsertBtn", "materialPreviewModifyBtn", "materialPreviewCopyBtn",
      // AI 排版富文本预览
      "formatPreviewModal", "formatPreviewCloseBtn", "formatPreviewMeta", "formatPreviewLoading",
      "formatPreviewContent", "formatPreviewPromptInput", "formatPreviewPresetList",
      "formatPreviewRegenerateBtn", "formatPreviewCancelBtn", "formatPreviewReplaceBtn",
      // 选区翻译/优化预览
      "selectionPreviewModal", "selectionPreviewTitle", "selectionPreviewCloseBtn", "selectionPreviewMeta",
      "selectionPreviewTranslateControls", "selectionPreviewLanguageSelect", "selectionPreviewCustomLanguageInput",
      "selectionPreviewInstructionLabel", "selectionPreviewInstructionInput", "selectionPreviewTip",
      "selectionPreviewLoading", "selectionPreviewOriginal", "selectionPreviewResult", "selectionPreviewDiff",
      "selectionPreviewRegenerateBtn", "selectionPreviewToggleDiffBtn", "selectionPreviewCopyBtn", "selectionPreviewCancelBtn", "selectionPreviewReplaceBtn",
      "selectionPreviewCompare",
      // 纯净模式开关
      "pureModeToggle",
      // 手动解除文档锁定
      "forceUnlockBtn",
      // 多对话
      "newConversationBtn", "conversationsMenuBtn", "conversationsMenu",
      "conversationsMenuList", "conversationsMenuEmpty", "conversationsMenuClose",
      // AI 进度条
      "chatProgress", "chatProgressText",
      // 文档锁定 banner
      "docLockBanner", "docLockStatusText",
      // 生图独立进度面板
      "imageGenPanel", "imageGenStatus", "imageGenPrompt", "imageGenCloseBtn",
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
        if (!silent) showMessage("未检测到当前文档路径（可能是未保存的临时文档？请先保存：Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S）。", "error");
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
      const resp = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/load-local-file", {
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
      els.saveSettingsBtn, els.testChatConnBtn, els.refreshModelsBtn
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

  // 结构化状态：状态图标 + 语义词 + 副信息计数，替代之前"AI 正在生成: xxxxxxx"截断尾巴那种。
  // state 可选：thinking / reasoning / generating / tool / retrying / done。
  // detail 是简短副信息，比如"1.2k 字符" / "翻译选中" / "第 3/5 次"，可省。
  const STATE_MAP = {
    thinking:   { icon: "◆", word: "思考中" },
    reasoning:  { icon: "◇", word: "推理" },
    generating: { icon: "✎", word: "生成回复" },
    tool:       { icon: "⚙", word: "执行工具" },
    retrying:   { icon: "↻", word: "重试" },
    done:       { icon: "✓", word: "完成" }
  };
  function setProgressState(state, detail) {
    const s = STATE_MAP[state] || STATE_MAP.thinking;
    const parts = [`${s.icon} ${s.word}`];
    if (detail) parts.push(String(detail));
    setProgressStatus(parts.join(" · "));
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

  // ===== 生图独立进度面板 =====
  // 不走 chat-progress / doc-lock-banner（那两个是单行 ellipsis，多行提示词显示不全），
  // 用专门的小面板：3 行 -webkit-line-clamp 显示提示词，状态/进度横向排列。
  let imageGenAutoHideTimer = null;
  let imageGenCurrentPrompt = "";

  function setImageGenBar(percent) {
    const panel = els.imageGenPanel;
    if (!panel) return;
    const inner = panel.querySelector(".image-gen-bar-inner");
    if (!inner) return;
    if (percent == null) {
      panel.classList.remove("is-determinate");
      inner.style.width = "";
      return;
    }
    const pct = Math.max(0, Math.min(100, +percent || 0));
    panel.classList.add("is-determinate");
    inner.style.width = `${pct}%`;
  }

  function setImageGenPanelTone(tone) {
    const panel = els.imageGenPanel;
    if (!panel) return;
    panel.classList.remove("is-failed", "is-done");
    if (tone === "failed") panel.classList.add("is-failed");
    else if (tone === "done") panel.classList.add("is-done");
  }

  function showImageGenPanel() {
    if (!els.imageGenPanel) return;
    if (imageGenAutoHideTimer) { clearTimeout(imageGenAutoHideTimer); imageGenAutoHideTimer = null; }
    els.imageGenPanel.classList.remove("hidden");
    setImageGenPanelTone(null);
    if (els.imageGenCloseBtn) els.imageGenCloseBtn.classList.add("hidden");
  }

  function hideImageGenPanel() {
    if (!els.imageGenPanel) return;
    els.imageGenPanel.classList.add("hidden");
    setImageGenBar(null);
    setImageGenPanelTone(null);
    if (els.imageGenStatus) els.imageGenStatus.textContent = "";
    if (els.imageGenPrompt) {
      els.imageGenPrompt.textContent = "";
      els.imageGenPrompt.removeAttribute("title");
    }
    imageGenCurrentPrompt = "";
  }

  function imageGenStart({ prompt } = {}) {
    showImageGenPanel();
    imageGenCurrentPrompt = String(prompt || "").trim();
    if (els.imageGenPrompt) {
      els.imageGenPrompt.textContent = imageGenCurrentPrompt || "（未填写提示词）";
      if (imageGenCurrentPrompt) els.imageGenPrompt.title = imageGenCurrentPrompt;
    }
    if (els.imageGenStatus) els.imageGenStatus.textContent = "排队中 · 0s";
    setImageGenBar(null);
  }

  function imageGenUpdate({ status, progress, elapsedMs } = {}) {
    if (!els.imageGenPanel || els.imageGenPanel.classList.contains("hidden")) return;
    const labelMap = {
      queued: "排队中", pending: "排队中",
      in_progress: "生成中", processing: "生成中", running: "生成中",
      completed: "已完成", succeeded: "已完成",
      failed: "失败"
    };
    const label = labelMap[status] || status || "生成中";
    const pct = typeof progress === "number" ? ` · ${progress}%` : "";
    const elapsed = Math.round((elapsedMs || 0) / 1000);
    if (els.imageGenStatus) els.imageGenStatus.textContent = `${label}${pct} · 已用 ${elapsed}s`;
    if (typeof progress === "number") setImageGenBar(progress);
  }

  function imageGenDone() {
    if (!els.imageGenPanel) return;
    setImageGenPanelTone("done");
    setImageGenBar(100);
    if (els.imageGenStatus) els.imageGenStatus.textContent = "已完成";
    if (els.imageGenCloseBtn) els.imageGenCloseBtn.classList.add("hidden");
    if (imageGenAutoHideTimer) clearTimeout(imageGenAutoHideTimer);
    imageGenAutoHideTimer = setTimeout(() => { hideImageGenPanel(); imageGenAutoHideTimer = null; }, 1500);
  }

  function imageGenFail(message) {
    if (!els.imageGenPanel) return;
    setImageGenPanelTone("failed");
    setImageGenBar(null);
    if (els.imageGenStatus) els.imageGenStatus.textContent = message ? `失败：${message}` : "失败";
    if (els.imageGenCloseBtn) els.imageGenCloseBtn.classList.remove("hidden");
  }

  function bindImageGenPanel() {
    els.imageGenCloseBtn?.addEventListener("click", () => hideImageGenPanel());
  }

  global.WpsAiImageUI = {
    start: imageGenStart,
    update: imageGenUpdate,
    done: imageGenDone,
    fail: imageGenFail,
    hide: hideImageGenPanel
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
    els.maxToolIterationsInput.value = s.maxToolIterations || 150;
    if (els.systemPromptInput) els.systemPromptInput.value = (s.systemPrompt != null) ? s.systemPrompt : "";
    if (els.showToolCallLogsInput) els.showToolCallLogsInput.checked = !!s.showToolCallLogs;
    // splitLayersOnInsert 默认开启（实验阶段过去后改成默认 true，让插入的 PPT 能分层选中）。
    // 之前 loadSettings 漏 merge 这条，用户的勾选保存了也读不回来 —— 已在 registry.js 修。
    if (els.splitLayersOnInsertInput) els.splitLayersOnInsertInput.checked = s.splitLayersOnInsert !== false;
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

    // 图像渠道：用动态卡片列表渲染（每条 entry 一张卡，类似 chatProviders）
    renderImageProvidersList();

    refreshProviderConfigVisibility();
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
    // 图像渠道：值是即时写回到 currentSettings.imageProviders 的（onchange 触发），
    // 这里只兜底保留对象引用即可，不再重新组装。
    if (!Array.isArray(currentSettings.imageProviders)) {
      currentSettings.imageProviders = [];
    }
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

  // ========== Codex 卡片内嵌 OAuth 登录流（4 步） ==========
  // 1. 生成授权链接（startLogin → PKCE + 跳浏览器 / 复制兜底）
  // 2. URL 显示在 readonly textarea，旁边带"复制"按钮（WebView 自带浏览器拦截时方便手动复制）
  // 3. 用户在浏览器登录后，回调 URL（带 code=）会被显示 → 复制回插件
  // 4. 粘贴到第二个 textarea → 点"完成授权"（exchangeCode）
  //
  // 已登录态：显示 token 有效期 + 退出按钮
  function renderCodexCardBody(body, p) {
    const Auth = global.WpsAiAuth;
    const tokenInfo = Auth?.getTokenInfo?.() || { authenticated: false };
    if (tokenInfo.authenticated) {
      body.innerHTML = `
        <label class="field"><span>默认模型</span><input type="text" data-field="defaultModel" value="${escapeAttr(p.defaultModel || "")}"/></label>
        <div class="codex-card-signedin">
          <div class="codex-status-row">
            <span class="codex-status-ok">已登录</span>
            <span class="muted" style="font-size:11px">${escapeHtml(tokenInfo.expiresAtText ? "Token 至 " + tokenInfo.expiresAtText : "")}</span>
          </div>
          <button type="button" class="ghost-btn compact-btn" data-codex-act="signout">退出登录</button>
        </div>
      `;
      body.querySelector('[data-codex-act="signout"]')?.addEventListener("click", () => {
        if (!confirm("确定退出 Codex 登录？")) return;
        try {
          Auth.clearAuth();
          showMessage("已退出 Codex 登录。", "info");
        } catch (e) { showMessage(`退出失败：${e?.message || e}`, "error"); }
        renderChatProvidersList();
      });
      return;
    }
    body.innerHTML = `
      <label class="field"><span>默认模型</span><input type="text" data-field="defaultModel" placeholder="gpt-5.1-codex" value="${escapeAttr(p.defaultModel || "")}"/></label>
      <div class="codex-login-steps">
        <div class="codex-step">
          <div class="codex-step-head"><span class="codex-step-no">1</span><span>生成授权链接</span></div>
          <button type="button" class="primary-btn compact-btn" data-codex-act="gen-url">生成授权链接</button>
        </div>
        <div class="codex-step" data-codex-step="url-display" hidden>
          <div class="codex-step-head"><span class="codex-step-no">2</span><span>在浏览器打开（已自动尝试 / 失败时手动复制）</span></div>
          <textarea data-codex-act="url-text" rows="2" readonly placeholder="点上一步会出现授权链接"></textarea>
          <div class="codex-step-actions">
            <button type="button" class="ghost-btn compact-btn" data-codex-act="copy-url">复制链接</button>
            <button type="button" class="ghost-btn compact-btn" data-codex-act="open-url">尝试打开浏览器</button>
          </div>
        </div>
        <div class="codex-step" data-codex-step="code-input" hidden>
          <div class="codex-step-head"><span class="codex-step-no">3</span><span>粘贴浏览器回调的 URL（带 code= 参数）或纯 code</span></div>
          <textarea data-codex-act="code-text" rows="3" placeholder="https://.../callback?code=...&state=...  或  authorization code"></textarea>
        </div>
        <div class="codex-step" data-codex-step="confirm" hidden>
          <div class="codex-step-head"><span class="codex-step-no">4</span><span>完成授权</span></div>
          <button type="button" class="primary-btn compact-btn" data-codex-act="exchange">完成授权登录</button>
        </div>
      </div>
    `;
    const stepUrl = body.querySelector('[data-codex-step="url-display"]');
    const stepCode = body.querySelector('[data-codex-step="code-input"]');
    const stepConfirm = body.querySelector('[data-codex-step="confirm"]');
    const urlTa = body.querySelector('[data-codex-act="url-text"]');
    const codeTa = body.querySelector('[data-codex-act="code-text"]');

    body.querySelector('[data-codex-act="gen-url"]')?.addEventListener("click", async () => {
      try {
        const url = await Auth.startLogin();
        if (urlTa) urlTa.value = url;
        if (stepUrl) stepUrl.hidden = false;
        if (stepCode) stepCode.hidden = false;
        if (stepConfirm) stepConfirm.hidden = false;
        showMessage("已生成授权链接。如果浏览器没自动弹出，请复制链接手动打开。", "info");
      } catch (e) {
        showMessage(`生成链接失败：${e?.message || e}`, "error");
      }
    });
    body.querySelector('[data-codex-act="copy-url"]')?.addEventListener("click", async () => {
      const txt = urlTa?.value || "";
      if (!txt) { showMessage("还没生成授权链接", "error"); return; }
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(txt); }
        else {
          urlTa.removeAttribute("readonly");
          urlTa.select(); document.execCommand("copy"); urlTa.setAttribute("readonly", "readonly");
        }
        showMessage("授权链接已复制到剪贴板", "success");
      } catch (e) { showMessage(`复制失败：${e?.message || e}`, "error"); }
    });
    body.querySelector('[data-codex-act="open-url"]')?.addEventListener("click", async () => {
      const txt = urlTa?.value || "";
      if (!txt) return;
      try {
        if (global.wps?.OAAssist?.ShellExecute) global.wps.OAAssist.ShellExecute(txt);
        else window.open(txt, "_blank");
      } catch (e) { showMessage(`打开失败：${e?.message || e}，请手动复制链接到浏览器。`, "error"); }
    });
    body.querySelector('[data-codex-act="exchange"]')?.addEventListener("click", async () => {
      const txt = (codeTa?.value || "").trim();
      if (!txt) { showMessage("请先粘贴回调 URL 或 code", "error"); return; }
      try {
        await Auth.exchangeCode(txt);
        showMessage("登录成功 ✓", "success");
        renderChatProvidersList();
        try { populateModelSelector(els.modelSelect?.value); } catch (e) {}
        try { renderProviderState(); } catch (e) {}
      } catch (e) {
        showMessage(`换 token 失败：${e?.message || e}`, "error");
      }
    });
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

  // 生图渠道也单独存一份模型列表缓存，让配置卡的"模型"输入框可以下拉选已知模型。
  const IMAGE_MODELS_CACHE_KEY = "lingxi_image_models_cache_v1";
  let imageModelsByProvider = {};
  try {
    const raw = localStorage.getItem(IMAGE_MODELS_CACHE_KEY);
    if (raw) imageModelsByProvider = JSON.parse(raw) || {};
  } catch (e) { imageModelsByProvider = {}; }
  function persistImageModelsCache() {
    try { localStorage.setItem(IMAGE_MODELS_CACHE_KEY, JSON.stringify(imageModelsByProvider)); } catch (e) {}
  }

  // 拼一段"从已拉取的模型选..."下拉 HTML。
  // 用 <select> + 第一项是占位（value=""），选中真实模型时 JS 把值复制回旁边那个 input。
  // 之所以不用 <datalist>：WPS CEF 老版本下 datalist 点击不弹下拉，相当于没启用。
  function buildModelPickerHtml(modelList, currentValue) {
    const list = (modelList || []).filter(Boolean);
    if (!list.length) return "";
    const options = list.map((m) => {
      const sel = m === currentValue ? " selected" : "";
      return `<option value="${escapeAttr(m)}"${sel}>${escapeHtml(m)}</option>`;
    }).join("");
    return `<select data-role="model-picker" class="model-picker"><option value="">从已拉取的 ${list.length} 个模型中选…</option>${options}</select>`;
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
  function openSettingsAsDialog(initialPanel) {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const panelArg = initialPanel ? `&panel=${encodeURIComponent(initialPanel)}` : "";
      const url = `${base}/taskpane.html?mode=settings${panelArg}`;
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
  if (!isSettingsDialog && !isQuickPromptDialog && !isFormatPreviewDialog && !isSelectionPreviewDialog) {
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
    // 切到「程序信息」时刷缓存面板（每次进都重扫，占用是动态的）
    if (name === "about") renderCachePanel();
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

    // 配置 JSON 片段：优先从 WpsAiAddon.getUrlPath() 推 plugin 安装的本地 FS 路径（dev 模式
    // 用 file:// 时能直接拿到）。生产安装走 http://localhost 推不出来，向 proxy 问 /install-path
    // 拿真实 mcp-server.js 的绝对路径。
    function writeMcpSnippet(mcpScript) {
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
    }
    const installRoot = detectPluginInstallPath();
    if (installRoot) {
      writeMcpSnippet(`${installRoot}/tools/mcp-server.js`);
    } else {
      writeMcpSnippet("<填入 plugin 安装路径>/tools/mcp-server.js");
      // 异步问 proxy 拿真实路径，回来后覆写片段
      fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/install-path", { method: "GET" })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.ok && data.mcpServer) writeMcpSnippet(data.mcpServer);
        })
        .catch(() => { /* proxy 离线就保留占位符 */ });
    }

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

      const cachedChatModels = modelsByProvider[p.id] || [];
      const chatModelsPicker = buildModelPickerHtml(cachedChatModels, p.defaultModel);
      const chatModelsHint = cachedChatModels.length
        ? `<small class="field-tip">从下拉选中即填进左侧输入框。可手动输入未列出的模型。</small>`
        : `<small class="field-tip">点右上角 ⚡ 测试供应商后，这里会出现"模型下拉"。</small>`;

      if (p.type === "codex") {
        // Codex 走 ChatGPT OAuth —— 直接在卡片内做完整的 4 步授权流，而不是依赖隐藏的 legacy UI
        renderCodexCardBody(body, p);
      } else if (p.type === "anthropic") {
        body.innerHTML = `
          <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://api.anthropic.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
          <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-ant-..." value="${escapeAttr(p.apiKey || "")}"/></label>
          <label class="field required"><span>默认模型</span>
            <div class="field-with-picker">
              <input type="text" data-field="defaultModel" placeholder="claude-sonnet-4-6" value="${escapeAttr(p.defaultModel || "")}"/>
              ${chatModelsPicker}
            </div>
            ${chatModelsHint}
          </label>
          <label class="field"><span>Anthropic Version</span><input type="text" data-field="anthropicVersion" placeholder="2023-06-01" value="${escapeAttr(p.anthropicVersion || "2023-06-01")}"/></label>
          <label class="field-row"><input type="checkbox" data-field="useProxy" ${p.useProxy !== false ? "checked" : ""}/><span>通过本地 CORS 代理</span></label>
        `;
      } else {
        // openai 兼容
        // 本地端点（Ollama / LM Studio / vLLM 等）追加"模型选型建议" details，
        // 提醒用户开源模型在 tool calling / 多模态上的现实差距。
        const localGuide = isLocalBaseUrl(p.baseUrl) ? renderLocalModelGuideHtml() : "";
        body.innerHTML = `
          <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
          <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://api.openai.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
          <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
          <label class="field required"><span>默认模型</span>
            <div class="field-with-picker">
              <input type="text" data-field="defaultModel" placeholder="gpt-4o-mini" value="${escapeAttr(p.defaultModel || "")}"/>
              ${chatModelsPicker}
            </div>
            ${chatModelsHint}
          </label>
          <label class="field-row"><input type="checkbox" data-field="useProxy" ${p.useProxy !== false ? "checked" : ""}/><span>通过本地 CORS 代理</span></label>
          ${localGuide}
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

      // 默认模型旁挂的"从已拉取模型选..."下拉：选中即填进 defaultModel input。
      body.querySelectorAll('[data-role="model-picker"]').forEach((picker) => {
        picker.addEventListener("change", (ev) => {
          const value = (ev.target.value || "").trim();
          if (!value) return;
          const input = picker.parentElement?.querySelector('input[data-field="defaultModel"]');
          if (input) {
            input.value = value;
            // 同步写回 entry + 持久化 + 刷新 header 下拉
            applyChatProviderCardEdits(card, p);
            persistSettings();
            populateModelSelector(els.modelSelect?.value);
          }
          ev.target.value = ""; // 重置回占位项，方便再次选
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

  // 判断 baseUrl 是不是本地端点（localhost / 私网 IP）。用来决定要不要在配置卡里
  // 展示"本地模型选型建议"小贴士。
  function isLocalBaseUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      const u = new URL(rawUrl);
      const h = u.hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "::1"
        || h.startsWith("192.168.") || h.startsWith("10.")
        || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    } catch (e) {
      // baseUrl 还没填或乱填的情况
      return /localhost|127\.0\.0\.1/i.test(String(rawUrl));
    }
  }

  // 本地模型选型建议 HTML —— 给 Ollama / LM Studio / vLLM 这类本地端点用。
  // 说明开源模型在 tool calling / 多模态两条插件强依赖的能力上的现实差距，
  // 帮用户避开"装上了但插件用不起来"的坑。
  function renderLocalModelGuideHtml() {
    return `
      <details class="local-model-guide">
        <summary>本地模型选型建议（务必看一眼）</summary>
        <div class="local-model-guide-body">
          <p class="muted" style="margin:6px 0 8px;">灵犀 AI 深度依赖<b>工具调用 (function calling)</b>来操作文档；图片识别 / 截图分析依赖<b>多模态 (vision)</b>。多数开源模型至少缺一项，挑错了"配上能聊天但用不了功能"。</p>

          <p style="margin:8px 0 4px;"><b>✓ 推荐配置（工具调用稳定，部分带视觉）</b></p>
          <ul style="margin:2px 0 8px 18px; padding:0; line-height:1.6;">
            <li><code>qwen2.5:7b-instruct</code> / <code>qwen2.5:14b-instruct</code> — 原生 function calling，中文好。<b>最低门槛首选</b>。</li>
            <li><code>qwen2.5:32b-instruct</code> — 工具调用质量最接近 GPT-4o-mini 的开源选项（需 24GB+ 显存）。</li>
            <li><code>llama3.1:8b</code> / <code>llama3.1:70b</code> — 原生 tools，英文更强。</li>
            <li><code>mistral-nemo:12b</code> / <code>mistral-small</code> — 原生 tools，速度好。</li>
            <li>视觉 + 工具：<code>qwen2.5-vl:7b</code>（截图理解 + 工具调用都有，推荐）、<code>llama3.2-vision:11b</code>（仅英文场景）。</li>
            <li>偏代码：<code>deepseek-coder-v2:16b</code>、<code>qwen2.5-coder:7b</code>。</li>
          </ul>

          <p style="margin:8px 0 4px;"><b>✗ 不建议（工具调用不稳定或不支持，插件多数功能用不了）</b></p>
          <ul style="margin:2px 0 8px 18px; padding:0; line-height:1.6;">
            <li><code>gemma2</code> / <code>gemma3</code> 全系 — Google 系列原生不带 function calling，靠模板模拟成功率低。</li>
            <li><code>phi-3</code> / <code>phi-3.5</code> — Microsoft 早期版本，tool 输出格式经常崩。</li>
            <li>任意 <b>≤3B 参数</b> 的模型 — 工具调用普遍不靠谱（含 qwen2.5:0.5b/1.5b/3b、llama3.2:1b/3b、phi3:mini）。</li>
            <li>任何 <b>非 instruct/chat 后缀</b> 的 base 模型（如 <code>llama3:8b-text</code>、<code>qwen:7b</code> 无后缀）— 没经过对话微调，根本不会调工具。</li>
            <li><code>codellama</code> / <code>starcoder2</code> — 纯代码补全模型，不调工具。</li>
            <li>纯文本模型 + 期望视觉：所有不带 <code>-vl</code> / <code>-vision</code> / <code>-v</code> 后缀的模型都不能识图，不要往里塞截图。</li>
          </ul>

          <p style="margin:8px 0 4px;"><b>常见组合 = 显存预算</b></p>
          <ul style="margin:2px 0 8px 18px; padding:0; line-height:1.6;">
            <li>6 GB 显存：<code>qwen2.5:7b-instruct-q4</code> 勉强够，能调工具但慢。</li>
            <li>12 GB 显存：<code>qwen2.5:14b-instruct-q4</code> 或 <code>qwen2.5-vl:7b</code>，是甜点档。</li>
            <li>24 GB+ 显存：<code>qwen2.5:32b</code> 或 <code>llama3.1:70b-q4</code>，质量最接近商用 API。</li>
            <li>纯 CPU / 集显：建议挂在线 API，本地跑 7B 也要十几秒/次。</li>
          </ul>

          <p class="muted" style="margin:8px 0 0;">拉模型：<code>ollama pull qwen2.5:7b-instruct</code>。Ollama 模型仓库：ollama.com/library。</p>
        </div>
      </details>
    `;
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

  // ---------------- Image providers (多渠道，互斥启用) ----------------

  // 把 currentSettings.imageProviders 渲染成卡片列表。复用 chat-provider-card 样式。
  // 启用一条会自动关闭其它条目 —— 同一时刻仅一条 enabled=true。
  function renderImageProvidersList() {
    const wrap = els.imageProvidersList;
    if (!wrap) return;
    wrap.innerHTML = "";
    const list = currentSettings.imageProviders || [];
    list.forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "chat-provider-card" + (p.enabled ? "" : " disabled");
      card.dataset.imageProviderId = p.id;

      const head = document.createElement("div");
      head.className = "chat-provider-card-head";
      head.innerHTML = `
        <span class="chat-provider-card-label">${escapeHtml(p.label || p.id)}</span>
        <span class="chat-provider-card-type">${escapeHtml(p.type)}</span>
        <label class="chat-provider-card-toggle">
          <input type="checkbox" data-role="toggle" ${p.enabled ? "checked" : ""}/>
          <span>启用</span>
        </label>
        <button type="button" class="card-action-btn" data-role="test" title="测试此渠道（拉取模型列表）" aria-label="测试">
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
        const checked = ev.target.checked;
        // 互斥：开启此条时关闭其它；关闭则单纯关闭
        currentSettings.imageProviders.forEach((other) => {
          other.enabled = (other === p) ? checked : false;
        });
        persistSettings();
        renderImageProvidersList();
      });
      head.querySelector('[data-role="test"]').addEventListener("click", async (ev) => {
        ev.stopPropagation();
        applyImageProviderCardEdits(card, p);
        persistSettings();
        await testImageProviderEntry(p);
      });
      card.appendChild(head);

      const body = document.createElement("div");
      body.className = "chat-provider-card-body";
      body.innerHTML = renderImageProviderBody(p);

      // 内置 id（toapis / codex-bridge）不让删；用户加的可以删
      const isBuiltin = ["toapis", "codex-bridge"].includes(p.id);
      if (!isBuiltin) {
        const actions = document.createElement("div");
        actions.className = "chat-provider-card-actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", () => {
          if (!confirm(`确定删除 ${p.label || p.id}？`)) return;
          currentSettings.imageProviders.splice(idx, 1);
          persistSettings();
          renderImageProvidersList();
        });
        actions.appendChild(delBtn);
        body.appendChild(actions);
      }

      body.querySelectorAll("input, select").forEach((inp) => {
        inp.addEventListener("change", () => {
          applyImageProviderCardEdits(card, p);
          persistSettings();
        });
      });

      // 模型旁挂的"从已拉取模型选..."下拉：选中即填进 model input
      body.querySelectorAll('[data-role="model-picker"]').forEach((picker) => {
        picker.addEventListener("change", (ev) => {
          const value = (ev.target.value || "").trim();
          if (!value) return;
          const input = picker.parentElement?.querySelector('input[data-field="model"]');
          if (input) {
            input.value = value;
            applyImageProviderCardEdits(card, p);
            persistSettings();
          }
          ev.target.value = "";
        });
      });

      card.appendChild(body);
      wrap.appendChild(card);
    });
  }

  function renderImageProviderBody(p) {
    const cachedImageModels = imageModelsByProvider[p.id] || [];
    const imageModelsPicker = buildModelPickerHtml(cachedImageModels, p.model);
    const imageModelsHint = cachedImageModels.length
      ? `<small class="field-tip">从下拉选中即填进左侧输入框。可手动输入未列出的模型。</small>`
      : `<small class="field-tip">点右上角 ⚡ 测试渠道后，这里会出现"模型下拉"。</small>`;

    if (p.type === "codex-bridge") {
      const sizes = ["1024x1024","1024x1792","1792x1024","512x512","256x256"];
      const sizeOpts = sizes.map((s) => `<option value="${s}" ${p.defaultSize === s ? "selected" : ""}>${s}</option>`).join("");
      return `
        <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
        <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://your-sub2api.example.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
        <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
        <label class="field required"><span>模型</span>
          <div class="field-with-picker">
            <input type="text" data-field="model" placeholder="gpt-image-1" value="${escapeAttr(p.model || "")}"/>
            ${imageModelsPicker}
          </div>
          ${imageModelsHint}
        </label>
        <label class="field"><span>默认尺寸</span><select data-field="defaultSize">${sizeOpts}</select>
          <small class="field-tip">OpenAI 风格像素尺寸，部分中转只支持子集。</small></label>
        <label class="field-row"><input type="checkbox" data-field="useProxy" ${p.useProxy !== false ? "checked" : ""}/><span>通过本地 CORS 代理</span></label>
      `;
    }
    // toapis（默认）
    const ratios = ["1:1","3:2","2:3","4:3","3:4","16:9","9:16","2:1","1:2","21:9","9:21"];
    const ratioOpts = ratios.map((s) => `<option value="${s}" ${p.defaultSize === s ? "selected" : ""}>${s}</option>`).join("");
    const resos = ["1K","2K","4K"];
    const resoOpts = resos.map((r) => `<option value="${r}" ${p.defaultResolution === r ? "selected" : ""}>${r}</option>`).join("");
    return `
      <label class="field"><span>显示名称</span><input type="text" data-field="label" value="${escapeAttr(p.label || "")}"/></label>
      <label class="field required"><span>Base URL</span><input type="text" data-field="baseUrl" placeholder="https://toapis.com/v1" value="${escapeAttr(p.baseUrl || "")}"/></label>
      <label class="field required"><span>API Key</span><input type="password" data-field="apiKey" placeholder="sk-..." value="${escapeAttr(p.apiKey || "")}"/></label>
      <label class="field required"><span>模型</span>
        <div class="field-with-picker">
          <input type="text" data-field="model" placeholder="gpt-image-2" value="${escapeAttr(p.model || "")}"/>
          ${imageModelsPicker}
        </div>
        ${imageModelsHint}
      </label>
      <label class="field"><span>默认分辨率</span><select data-field="defaultResolution">${resoOpts}</select></label>
      <label class="field"><span>默认比例</span><select data-field="defaultSize">${ratioOpts}</select>
        <small class="field-tip">不同分辨率支持的比例不同：1K 仅支持 1:1/3:2/2:3。</small></label>
      <label class="field-row"><input type="checkbox" data-field="useProxy" ${p.useProxy !== false ? "checked" : ""}/><span>通过本地 CORS 代理</span></label>
    `;
  }

  function applyImageProviderCardEdits(card, entry) {
    card.querySelectorAll("[data-field]").forEach((inp) => {
      const key = inp.dataset.field;
      if (inp.type === "checkbox") entry[key] = inp.checked;
      else entry[key] = (inp.value || "").trim();
    });
  }

  // 新增一条图像渠道。type 由用户选；id 自动去重。
  // 类型选项 —— 给 addImageProvider modal picker 用
  const IMAGE_PROVIDER_TYPES = [
    {
      type: "codex-bridge",
      label: "Codex 桥接 (sub2api)",
      desc: "OpenAI 兼容的同步图像 API（sub2api / 自建 reverse-proxy 之类）。返回 b64_json 直接落地。",
      defaults: { baseUrl: "", apiKey: "", model: "gpt-image-1", defaultSize: "1024x1024", useProxy: true }
    },
    {
      type: "toapis",
      label: "toapis.com (GPT-Image-2)",
      desc: "toapis.com 异步任务 API：创建任务 + 轮询。支持比例尺（1:1 / 16:9 等）与分辨率档（1K/2K/4K）。",
      defaults: { baseUrl: "https://toapis.com/v1", apiKey: "", model: "gpt-image-2", defaultSize: "1:1", defaultResolution: "1K", useProxy: true }
    }
  ];

  function addImageProvider() {
    // 之前用 window.prompt() 取类型，但 WPS WebView 对 native prompt 支持不稳定（很多版本直接静默不弹），
    // 改成 modal picker。复用聊天供应商的 .modal-overlay / .modal-card 样式。
    openImageProviderTypePicker((preset) => {
      const existing = new Set((currentSettings.imageProviders || []).map((p) => p.id));
      let id = preset.type;
      let n = 2;
      while (existing.has(id)) id = `${preset.type}-${n++}`;
      const labelN = n > 2 ? ` #${n - 1}` : "";
      const entry = Object.assign(
        { id, type: preset.type, label: preset.label + labelN, enabled: false },
        preset.defaults
      );
      currentSettings.imageProviders = currentSettings.imageProviders || [];
      currentSettings.imageProviders.push(entry);
      persistSettings();
      renderImageProvidersList();
      // 自动展开新卡，方便填 API Key
      setTimeout(() => {
        const card = els.imageProvidersList.querySelector(`[data-image-provider-id="${CSS.escape(id)}"]`);
        if (card) card.classList.add("expanded");
      }, 0);
    });
  }

  // 临时 modal —— 选图像渠道类型。完成后回调 onPick(preset)；用户取消直接关闭无操作。
  function openImageProviderTypePicker(onPick) {
    // 旧实例若没关掉，先清理
    const oldOverlay = document.getElementById("__lingxi_image_type_picker__");
    if (oldOverlay) try { oldOverlay.remove(); } catch (e) {}

    const overlay = document.createElement("div");
    overlay.id = "__lingxi_image_type_picker__";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h3>新增图像生成渠道</h3>
          <button class="modal-close" type="button" data-act="close" title="关闭">×</button>
        </div>
        <div class="modal-body">
          <p class="muted" style="margin:0 0 10px">挑一种渠道协议；之后可以在卡片里编辑 baseUrl / apiKey。</p>
          <div class="preset-list" data-role="list"></div>
        </div>
      </div>
    `;
    const listHost = overlay.querySelector('[data-role="list"]');
    IMAGE_PROVIDER_TYPES.forEach((preset) => {
      const item = document.createElement("div");
      item.className = "preset-list-item";
      item.innerHTML = `
        <span class="preset-list-item-label">${escapeHtml(preset.label)}</span>
        <span class="preset-list-item-url">${escapeHtml(preset.desc)}</span>
      `;
      item.addEventListener("click", () => {
        try { onPick?.(preset); } catch (e) {}
        try { overlay.remove(); } catch (e) {}
      });
      listHost.appendChild(item);
    });
    const close = () => { try { overlay.remove(); } catch (e) {} };
    overlay.querySelector('[data-act="close"]').addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  // 直接对某条 entry 做连通测试（GET /models 探活，跟 chatProvider 测试同套路）
  async function testImageProviderEntry(entry) {
    if (!entry.baseUrl || !entry.apiKey) {
      showMessage(`「${entry.label || entry.id}」缺少 Base URL 或 API Key。`, "error");
      return;
    }
    setBusy(true);
    showMessage(`正在测试「${entry.label || entry.id}」...`, "info");
    const PROXY_PREFIX = global.WpsAiRuntime?.forwardPrefix?.() || "http://127.0.0.1:3890/forward/";
    const base = String(entry.baseUrl).replace(/\/+$/, "");
    const targetBase = entry.useProxy === false ? base : PROXY_PREFIX + encodeURIComponent(base);
    try {
      const resp = await fetch(`${targetBase}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${entry.apiKey}` }
      });
      if (resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        const items = Array.isArray(payload.data) ? payload.data : [];
        const modelIds = items
          .map((m) => m.id || m.name)
          .filter((id) => typeof id === "string" && id);
        // 把模型列表缓存起来，重新渲染卡片让"模型"输入框的下拉同步
        if (modelIds.length) {
          imageModelsByProvider[entry.id] = modelIds;
          persistImageModelsCache();
          try { renderImageProvidersList(); } catch (e) {}
        }
        const hit = modelIds.includes(entry.model);
        const preview = modelIds.slice(0, 5).join(" / ") + (modelIds.length > 5 ? ` … (+${modelIds.length - 5})` : "");
        if (hit) {
          showMessage(`「${entry.label || entry.id}」连通正常，模型「${entry.model}」存在；共 ${modelIds.length} 个模型，「模型」输入框可下拉选。`, "success", { duration: 6000 });
        } else if (modelIds.length) {
          showMessage(`「${entry.label || entry.id}」连通正常，列表里没找到「${entry.model}」。返回 ${modelIds.length} 个模型：${preview}。点「模型」输入框可下拉选。`, "info", { duration: 8000 });
        } else {
          showMessage(`「${entry.label || entry.id}」连通正常，但 /models 返回空列表。配置仍可保存。`, "info", { duration: 6000 });
        }
      } else if (resp.status === 401) {
        showMessage(`「${entry.label || entry.id}」认证失败（401）。请检查 API Key。`, "error");
      } else if (resp.status === 404 || resp.status === 405) {
        showMessage(`「${entry.label || entry.id}」未暴露 /models（HTTP ${resp.status}），通常是图像专用服务，可保存后直接试用。`, "info", { duration: 6000 });
      } else {
        const payload = await resp.json().catch(() => ({}));
        showMessage(`「${entry.label || entry.id}」测试失败（${resp.status}）：${payload.error?.message || "未知错误"}`, "error");
      }
    } catch (error) {
      showMessage(`「${entry.label || entry.id}」测试失败：${error.message || error}`, "error");
    } finally {
      setBusy(false);
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
    // 模板画廊只对 PPT 有意义（HTML 幻灯片模板）—— Word/Excel/PDF 下隐藏入口，避免误导。
    // 现在画廊入口在输入框上方独立行，把整行 (chatContextActions) 一起 toggle，
    // 避免容器空着还占一行高度
    const isWpp = currentHostInfo.host === "wpp";
    if (els.chatHtmlGalleryBtn) {
      els.chatHtmlGalleryBtn.classList.toggle("hidden", !isWpp);
    }
    if (els.chatContextActions) {
      els.chatContextActions.classList.toggle("hidden", !isWpp);
    }
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

  // 微信式聊天头像：AI = 紫底 ✨ / 我 = 蓝底"我"字。
  // 仅给 user/assistant 角色挂；tool / thinking 等系统气泡不挂（系统消息不算"谁说的"）。
  function makeAvatarEl(role) {
    const a = document.createElement("div");
    a.className = `chat-msg-avatar chat-msg-avatar-${role}`;
    if (role === "user") {
      a.textContent = "我";
    } else {
      // AI：feather sparkles 线性图标，stroke=white
      a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>';
    }
    a.setAttribute("aria-hidden", "true");
    return a;
  }

  function appendChatMsg(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}${opts.kind ? " " + opts.kind : ""}`;

    // 头像（仅 user / assistant，且非 tool）。CSS 用 ::before 也行，但 SVG 要 inline 所以走 DOM
    if (role === "user" || role === "assistant") {
      div.appendChild(makeAvatarEl(role));
    }

    // 头部行：左侧标签 + 右侧动作图标（hover 显示）
    // 注：user / assistant 已经有圆头像表达"谁说的"，文字 "我"/"AI" 标签就重复了 —— 跳过。
    // 其它情况（tool / err / 系统消息）的 label 还是显示，那种不是用户角色的标记。
    const header = document.createElement("div");
    header.className = "chat-msg-header";
    const skipRoleLabel = (role === "user" || role === "assistant")
      && (opts.label === "我" || opts.label === "AI");
    if (opts.label && !skipRoleLabel) {
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

  // 从 assistant 输出里剥离 <think>...</think>（部分开源思考模型会内联进正文，
  // 我们的 provider 层没有映射到独立的 reasoning event 时会这样露出来）。
  // 尾部未闭合的 <think> 也算 —— 流式过程中常见到刚吐出一半。
  // 返回 { visible: 面向用户的正文, think: 思考内容（多段用 \n\n 分隔） }
  function splitVisibleAndThinking(text) {
    if (!text) return { visible: "", think: "" };
    const src = String(text);
    const outVisible = [];
    const outThink = [];
    let i = 0;
    while (i < src.length) {
      const openIdx = src.indexOf("<think>", i);
      if (openIdx < 0) { outVisible.push(src.slice(i)); break; }
      if (openIdx > i) outVisible.push(src.slice(i, openIdx));
      const contentStart = openIdx + 7;
      const closeIdx = src.indexOf("</think>", contentStart);
      if (closeIdx < 0) {
        // 未闭合：从 <think> 到末尾都归到思考
        outThink.push(src.slice(contentStart));
        i = src.length;
        break;
      }
      outThink.push(src.slice(contentStart, closeIdx));
      i = closeIdx + 8;
    }
    // 相邻标签会留下空行，正文两端 trim 避免顶部一片空白
    return {
      visible: outVisible.join("").replace(/^\s+|\s+$/g, ""),
      think: outThink.join("\n\n").replace(/^\s+|\s+$/g, "")
    };
  }

  function renderAssistantText(text) {
    // 剥离 <think>：非流式路径（一次性拿到全文，或历史回放）。有思考内容就先补一个
    // 折叠好的"思考过程"气泡放在正文前面，用户想看点开即可，不看不占版面。
    const { visible, think } = splitVisibleAndThinking(text);
    if (think) appendStaticReasoningBubble(think);
    const html = global.WpsAiMarkdown
      ? global.WpsAiMarkdown.renderToHtml(visible)
      : (visible || "").replace(/\n/g, "<br/>");
    return appendChatMsg("assistant", "", { label: "AI", html, copyText: visible });
  }

  // 静态渲染（历史回放 / 非流式一次性文本）的思考气泡：默认折叠，跟流式版视觉一致。
  function appendStaticReasoningBubble(thinkText) {
    if (!thinkText || !els.chatStream) return null;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg reasoning collapsible";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    const label = document.createElement("span");
    label.className = "chat-msg-label";
    label.textContent = "思考过程";
    head.appendChild(label);
    const preview = document.createElement("span");
    preview.className = "tool-preview reasoning-preview";
    preview.textContent = (thinkText.split(/\n+/).filter(Boolean).slice(-1)[0] || "").slice(0, 80);
    head.appendChild(preview);
    const chev = document.createElement("span");
    chev.className = "tool-chevron";
    chev.textContent = "▶";
    head.appendChild(chev);
    const body = document.createElement("div");
    body.className = "tool-body reasoning-body";
    body.textContent = thinkText;
    wrap.appendChild(head);
    wrap.appendChild(body);
    head.addEventListener("click", () => {
      const expanded = wrap.classList.toggle("expanded");
      chev.textContent = expanded ? "▼" : "▶";
    });
    els.chatStream.appendChild(wrap);
    return wrap;
  }

  // ---- Thinking indicator ----
  // 在 AI 思考阶段（请求未返回、或工具执行后等待下一轮）显示一个临时占位气泡。
  let thinkingTimer = null;
  function showThinking(text = "AI 正在思考") {
    hideThinking();
    const div = document.createElement("div");
    div.id = "chatThinking";
    div.className = "chat-msg assistant thinking";

    div.appendChild(makeAvatarEl("assistant"));
    // 不再渲染"AI"文字标签 —— 圆形头像本身已经标记是 AI 在说话
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
    // 顺手取消尚未触发的 delayed thinking
    if (_delayedThinkingTimer) {
      clearTimeout(_delayedThinkingTimer);
      _delayedThinkingTimer = null;
    }
  }

  // 延时插入 thinking 气泡：只有下一步事件超过 delay 还没来才显示，
  // 避免快速 tool_result → tool_call 序列里 thinking 气泡疯狂闪烁。
  let _delayedThinkingTimer = null;
  function scheduleDelayedThinking(delay = 400, text = "AI 正在思考") {
    if (_delayedThinkingTimer) clearTimeout(_delayedThinkingTimer);
    _delayedThinkingTimer = setTimeout(() => {
      _delayedThinkingTimer = null;
      showThinking(text);
    }, delay);
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

  // ---------------- WPS AI 排版富文本预览 ----------------

  let formatPreviewState = null;
  let formatPreviewBound = false;
  let formatPreviewDialogResultWritten = false;

  const FORMAT_PRESETS = [
    { key: "contract", label: "合同", prompt: "正式合同/协议风格：标题居中加粗，条款分级编号清晰（第一条 / 1.1 / a.），正文严谨、术语保留原样、不口语化；签署区/落款单独成段。" },
    { key: "tender", label: "招标文件", prompt: "招标文件规范：章节层级清晰（第一章 / 第二章 …），小节用编号标题，要求项整成项目符号或编号列表，条款分明、便于检索。" },
    { key: "gov", label: "公文报告", prompt: "正式公文/报告风格：主标题居中加粗，一级/二级小标题分级，正文首行缩进、用书面语，必要时使用编号或项目符号，落款居右。" },
    { key: "notice", label: "通知公告", prompt: "通知/公告体：主标题醒目居中，事由/正文用书面语，关键信息（时间、地点、要求）用编号列出，末尾落款（单位 + 日期）居右。" },
    { key: "paper", label: "论文", prompt: "学术论文风格：标题层级清晰，摘要 / 引言 / 方法 / 结果 / 结论 等分章节用一级标题，正文段落首行缩进，引用与编号保留。" },
    { key: "proposal", label: "方案", prompt: "项目/方案文档：分章节（背景 / 目标 / 方案 / 计划 / 风险）使用一级标题，要点列表化，必要处用引用块突出结论。" },
    { key: "resume", label: "简历", prompt: "简历风格：姓名/标题置顶居中加粗，板块（教育背景 / 工作经历 / 项目经验 / 技能）用一级标题，条目用项目符号，时间和职位简洁突出。" }
  ];

  function closeFormatPreviewModal() {
    if (isFormatPreviewDialog) {
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.formatPreviewModal?.classList.add("hidden");
    if (els.formatPreviewLoading) els.formatPreviewLoading.classList.add("hidden");
  }

  function normalizeFormatPreviewType(type) {
    const t = String(type || "paragraph").toLowerCase();
    if (["title", "subtitle", "heading", "paragraph", "bullet", "numbered", "quote", "spacer"].includes(t)) return t;
    return "paragraph";
  }

  function splitDocumentParagraphs(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function inferFallbackFormatBlocks(paragraphs, requirement = "") {
    const req = String(requirement || "");
    const formal = /公文|正式|报告|论文|严肃|规范/.test(req);
    return paragraphs.map((text, index) => {
      const clean = String(text || "").trim();
      if (!clean) return { type: "spacer", text: "" };
      if (index === 0 && clean.length <= 40) return { type: "title", text: clean };
      if (/^[一二三四五六七八九十]+[、.．]/.test(clean) || /^\d+[、.．]\s*/.test(clean)) {
        return { type: "heading", level: 2, text: clean.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "") || clean };
      }
      if (/^[(（]?[一二三四五六七八九十\d]+[)）]/.test(clean) || /^[-•*]\s+/.test(clean)) {
        return { type: "bullet", level: 1, text: clean.replace(/^[-•*]\s+/, "") };
      }
      if (!formal && clean.length <= 24 && !/[。！？!?；;]/.test(clean)) return { type: "heading", level: 3, text: clean };
      return { type: "paragraph", text: clean };
    });
  }

  function parseJsonObjectLoose(raw) {
    const s = String(raw || "").trim();
    const fence = s.match(/```(?:json|JSON)?\s*([\s\S]+?)```/);
    if (fence) {
      try { return JSON.parse(fence[1].trim()); } catch (e) {}
    }
    const candidates = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") { inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) candidates.push(s.slice(start, i + 1));
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const c of candidates) {
      try { return JSON.parse(c); } catch (e) {}
    }
    return JSON.parse(s);
  }

  // 把 block.type 翻成预览 DOM 用的标签名 + level（list 在流式阶段统一渲染成 <p>
  // 避免 ul/ol 边渲边重组导致闪屏；流完成后 renderFormatPreviewBlocks 会重画一次拿回正版样式）。
  function streamingTagForType(type, level) {
    const t = normalizeFormatPreviewType(type);
    if (t === "title") return { tag: "h1", t };
    if (t === "heading") return { tag: `h${Math.max(2, Math.min(4, Number(level || 2)))}`, t };
    if (t === "subtitle") return { tag: "p", t };
    if (t === "quote") return { tag: "blockquote", t };
    return { tag: "p", t };
  }

  function createStreamingBlockEl(block) {
    const { tag, t } = streamingTagForType(block?.type, block?.level);
    const el = document.createElement(tag);
    el.className = `format-preview-block format-preview-${t}`;
    let text = String(block?.text || "");
    if (t === "bullet") text = "• " + text;
    if (t === "numbered") text = "1. " + text;  // 流式阶段编号占位，最终 renderFormatPreviewBlocks 会换成真正的 <ol>
    el.textContent = text;
    return el;
  }

  // 原地刷新流式 block 元素：类型/层级变了就换 tag（用 replaceWith 一次性替换、不影响兄弟节点），
  // 没变就只更新 textContent —— 这样大多数 tick 只是节点 text 微调，浏览器不会重排整个面板。
  function updateStreamingBlockEl(el, block) {
    const { tag, t } = streamingTagForType(block?.type, block?.level);
    if (el.tagName.toLowerCase() !== tag.toLowerCase()) {
      const fresh = createStreamingBlockEl(block);
      fresh.classList.add("is-streaming-active");
      el.replaceWith(fresh);
      return fresh;
    }
    el.className = `format-preview-block format-preview-${t}`;
    el.classList.add("is-streaming-active");
    let text = String(block?.text || "");
    if (t === "bullet") text = "• " + text;
    if (t === "numbered") text = "1. " + text;
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  // 从 raw 里抠出"正在进行中"的那个 block —— 必须是 blocks 数组内部尚未闭合的 {…}，
  // 不是最外层 { "blocks": [ ] } 的 `{`。之前 bug：扫括号从 raw 开头开始，会把外层
  // `{` 当成"当前活跃"，然后 readPartialJsonStringField 找到的 `text` 是 blocks[0].text
  // → 第一个 block 已经落定后，活跃节点还在源源不断地重画它（用户看到"第一句话一直
  // 重复"），直到下个 block 出现才能覆盖掉。
  //
  // 修法：先跳到 blocks 数组的 `[` 之后再扫；只在 depth 从 0→1 时记录 start，
  // depth 回到 0（当前 block 闭合）就 reset。数组闭合（`]` at depth 0）也 reset。
  function extractActiveStreamingBlock(raw) {
    if (!raw) return null;
    const arrayStart = raw.indexOf("[");
    if (arrayStart < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    let lastUnclosedStart = -1;
    for (let i = arrayStart + 1; i < raw.length; i += 1) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") {
        if (depth === 0) lastUnclosedStart = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) lastUnclosedStart = -1;
      } else if (c === "]" && depth === 0) {
        lastUnclosedStart = -1;
        break;
      }
    }
    if (lastUnclosedStart < 0 || depth <= 0) return null;
    const partial = raw.slice(lastUnclosedStart);
    const typeMatch = partial.match(/"type"\s*:\s*"([^"]*)"/);
    const levelMatch = partial.match(/"level"\s*:\s*(\d+)/);
    const text = readPartialJsonStringField(partial, "text");
    return {
      type: typeMatch ? typeMatch[1] : "paragraph",
      level: levelMatch ? Number(levelMatch[1]) : 1,
      text
    };
  }

  // 从一段半截 JSON 里读 `"key":"…"` 的 value，遇到未闭合的引号也能容忍，按 JSON 转义规则解码。
  function readPartialJsonStringField(partial, key) {
    const keyToken = `"${key}"`;
    const keyIdx = partial.indexOf(keyToken);
    if (keyIdx < 0) return "";
    const colonIdx = partial.indexOf(":", keyIdx + keyToken.length);
    if (colonIdx < 0) return "";
    const quoteIdx = partial.indexOf('"', colonIdx + 1);
    if (quoteIdx < 0) return "";
    let i = quoteIdx + 1;
    let out = "";
    let escape = false;
    for (; i < partial.length; i += 1) {
      const c = partial[i];
      if (escape) {
        if (c === "n") out += "\n";
        else if (c === "t") out += "\t";
        else if (c === "r") out += "\r";
        else if (c === "u") {
          const hex = partial.slice(i + 1, i + 5);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        } else {
          out += c;
        }
        escape = false;
      } else if (c === "\\") { escape = true; }
      else if (c === '"') { break; }
      else { out += c; }
    }
    return out;
  }

  // 流式 JSON 增量解析：从 AI 边吐边写的 raw 文本里抽出已经完整的 {…} block。
  // 用括号计数器跨过字符串里的 `{` `}` 干扰；遇到第一个 `]` 视为 blocks 数组结束。
  // 每个匹配到的 {…} 用 JSON.parse 单独 parse，坏掉的就跳过——这样不至于因为一个
  // 半截 block 把已收到的全 invalid 掉。
  function extractStreamingFormatBlocks(raw) {
    if (!raw) return [];
    const arrayStart = raw.indexOf("[");
    if (arrayStart < 0) return [];
    const out = [];
    let depth = 0;
    let blockStart = -1;
    let inString = false;
    let escape = false;
    for (let i = arrayStart + 1; i < raw.length; i += 1) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") {
        if (depth === 0) blockStart = i;
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0 && blockStart >= 0) {
          try {
            const obj = JSON.parse(raw.slice(blockStart, i + 1));
            if (obj && typeof obj === "object") out.push(obj);
          } catch (e) { /* malformed block，跳过不影响其他 */ }
          blockStart = -1;
        }
      } else if (c === "]" && depth === 0) {
        break;
      }
    }
    return out;
  }

  function normalizeFormatBlocks(payload, paragraphs) {
    const rawBlocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    const requirement = String(payload?.requirement || "");
    if (!rawBlocks.length) return inferFallbackFormatBlocks(paragraphs, requirement);
    const merged = inferFallbackFormatBlocks(paragraphs, requirement);
    rawBlocks.forEach((block, i) => {
      const sourceIndex = Number.isInteger(block.sourceIndex) ? block.sourceIndex : i;
      if (sourceIndex < 0 || sourceIndex >= paragraphs.length) return;
      const original = paragraphs[sourceIndex] || paragraphs[i] || "";
      const type = normalizeFormatPreviewType(block.type);
      merged[sourceIndex] = {
        type,
        level: Math.max(1, Math.min(4, Number(block.level || 1))),
        text: String(block.text || original || "").trim(),
        sourceIndex
      };
    });
    return merged.filter((block) => block.type === "spacer" || block.text);
  }

  function renderFormatPreviewBlocks(blocks) {
    if (!els.formatPreviewContent) return;
    els.formatPreviewContent.innerHTML = "";
    if (!blocks?.length) {
      els.formatPreviewContent.innerHTML = '<p class="muted">暂无可预览内容。</p>';
      return;
    }
    // 有 structure 就走"段落 / 表格 / 图片按原顺序交织"路径：
    // 让预览跟真实文档一致，用户直观看到"表格在这里保留原样"。之前只渲染 AI 输出的
    // paragraph blocks，表格 / 图片段直接从预览里消失了。
    const structure = formatPreviewState?.structure;
    if (structure && Array.isArray(structure.segments) && structure.segments.length) {
      renderInterleavedPreview(structure, blocks);
      return;
    }
    // 老宿主 / 老逻辑：全篇 AI 排版无结构信息，直接按 blocks 渲染
    renderBlocksPlain(blocks);
  }

  function renderBlocksPlain(blocks) {
    let activeList = null;
    let activeListTag = "";
    const closeActiveList = () => { activeList = null; activeListTag = ""; };
    blocks.forEach((block) => appendBlockEl(block, {
      getActiveList: () => activeList,
      getActiveListTag: () => activeListTag,
      setActiveList: (v, tag) => { activeList = v; activeListTag = tag || ""; },
      closeActiveList
    }));
  }

  // 交织渲染：iterate segments in order；paragraph 拿对应 AI block，table / image / empty
  // 直接从 structure 拿并渲染成对应元素（<table> / 占位）。
  function renderInterleavedPreview(structure, blocks) {
    // editable index → AI block（fallback：按位置对齐；sourceIndex 缺失或越界都能兜住）
    const blockByEditIdx = new Map();
    blocks.forEach((b, i) => {
      const src = Number.isInteger(b?.sourceIndex) ? b.sourceIndex : i;
      if (!blockByEditIdx.has(src)) blockByEditIdx.set(src, b);
    });
    // 表格按 start 快速定位：某 segment.start 恰好落在 tableRange 起点附近 → 渲染这张表
    // 每张表只渲染一次（走 rendered set 去重，避免连续多个表格段落触发多次）
    const tables = Array.isArray(structure.tables) ? structure.tables : [];
    const renderedTableIndex = new Set();
    let activeList = null;
    let activeListTag = "";
    const closeActiveList = () => { activeList = null; activeListTag = ""; };

    let editIdx = 0;
    for (const seg of structure.segments) {
      if (seg.kind === "paragraph") {
        const block = blockByEditIdx.get(editIdx);
        editIdx += 1;
        if (block) {
          appendBlockEl(block, {
            getActiveList: () => activeList,
            getActiveListTag: () => activeListTag,
            setActiveList: (v, tag) => { activeList = v; activeListTag = tag || ""; },
            closeActiveList
          });
        } else {
          // AI 还没生成到这段 → 渲染成灰底 placeholder 保持位置
          closeActiveList();
          const ph = document.createElement("p");
          ph.className = "format-preview-block format-preview-pending";
          ph.textContent = seg.text || "";
          els.formatPreviewContent.appendChild(ph);
        }
      } else if (seg.kind === "table") {
        closeActiveList();
        // 找一张 range 覆盖当前 seg 起点的表；找到就渲染一次
        const table = tables.find((t) => t.start <= seg.start && seg.end <= t.end && !renderedTableIndex.has(t.tableIndex));
        if (table) {
          renderedTableIndex.add(table.tableIndex);
          els.formatPreviewContent.appendChild(buildPreviewTable(table));
        }
        // 其他属于同一表的 seg 就跳过（同 tableIndex 已在集合里）
      } else if (seg.kind === "image") {
        closeActiveList();
        const ph = document.createElement("div");
        ph.className = "format-preview-image-placeholder";
        ph.textContent = "🖼️ 图片（原样保留）";
        els.formatPreviewContent.appendChild(ph);
      } else if (seg.kind === "empty") {
        closeActiveList();
        const spacer = document.createElement("div");
        spacer.className = "format-preview-spacer";
        els.formatPreviewContent.appendChild(spacer);
      }
    }
  }

  function buildPreviewTable(t) {
    const wrap = document.createElement("table");
    wrap.className = "format-preview-table";
    const tbody = document.createElement("tbody");
    t.cells.forEach((row, ri) => {
      const tr = document.createElement("tr");
      row.forEach((cellText) => {
        // 首行当作表头，跟真实文档习惯一致，用户一眼能对上
        const cell = document.createElement(ri === 0 ? "th" : "td");
        cell.textContent = cellText;
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    wrap.appendChild(tbody);
    return wrap;
  }

  // 抽出原有 append 单个 block 的逻辑，供两条渲染路径共用
  function appendBlockEl(block, ctx) {
    const type = normalizeFormatPreviewType(block.type);
    if (type === "bullet" || type === "numbered") {
      const tag = type === "numbered" ? "ol" : "ul";
      let activeList = ctx.getActiveList();
      const activeListTag = ctx.getActiveListTag();
      if (!activeList || activeListTag !== tag) {
        activeList = document.createElement(tag);
        activeList.className = "format-preview-list";
        activeList.dataset.level = String(Math.max(1, Math.min(4, Number(block.level || 1))));
        els.formatPreviewContent.appendChild(activeList);
        ctx.setActiveList(activeList, tag);
      }
      const li = document.createElement("li");
      li.textContent = block.text;
      activeList.appendChild(li);
      return;
    }
    ctx.closeActiveList();
    if (type === "spacer") {
      const spacer = document.createElement("div");
      spacer.className = "format-preview-spacer";
      els.formatPreviewContent.appendChild(spacer);
      return;
    }
    let el;
    if (type === "title") el = document.createElement("h1");
    else if (type === "subtitle") el = document.createElement("p");
    else if (type === "heading") el = document.createElement(`h${Math.max(2, Math.min(4, Number(block.level || 2)))}`);
    else if (type === "quote") el = document.createElement("blockquote");
    else el = document.createElement("p");
    el.className = `format-preview-block format-preview-${type}`;
    el.textContent = block.text;
    els.formatPreviewContent.appendChild(el);
  }

  function setFormatPreviewBusy(on, text) {
    if (els.formatPreviewLoading) {
      els.formatPreviewLoading.classList.toggle("hidden", !on);
      const label = els.formatPreviewLoading.querySelector("span:last-child");
      if (label && text) label.textContent = text;
    }
    if (els.formatPreviewReplaceBtn) els.formatPreviewReplaceBtn.disabled = on || !formatPreviewState?.blocks?.length;
    if (els.formatPreviewRegenerateBtn) els.formatPreviewRegenerateBtn.disabled = on;
  }

  function updateFormatPreviewActionLabel() {
    if (!els.formatPreviewRegenerateBtn) return;
    const hasResult = !!formatPreviewState?.blocks?.length;
    els.formatPreviewRegenerateBtn.textContent = hasResult ? "重新生成" : "开始排版";
  }

  function renderFormatPreviewPresets() {
    if (!els.formatPreviewPresetList) return;
    els.formatPreviewPresetList.innerHTML = "";
    FORMAT_PRESETS.forEach((preset) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn compact-btn format-preview-preset-chip";
      btn.textContent = preset.label;
      btn.title = preset.prompt;
      btn.addEventListener("click", () => {
        if (els.formatPreviewPromptInput) {
          els.formatPreviewPromptInput.value = preset.prompt;
          els.formatPreviewPromptInput.focus();
        }
      });
      els.formatPreviewPresetList.appendChild(btn);
    });
  }

  function prepareFormatPreview({ text, paragraphs } = {}) {
    const sourceText = text != null ? String(text || "") : "";
    const list = Array.isArray(paragraphs) && paragraphs.length
      ? paragraphs
      : splitDocumentParagraphs(sourceText);
    if (!list.length) {
      showMessage("当前文档没有可排版的正文。", "error");
      return false;
    }
    formatPreviewState = {
      sourceText,
      paragraphs: list,
      requirement: "",
      blocks: []
    };
    renderFormatPreviewPresets();
    if (els.formatPreviewPromptInput) els.formatPreviewPromptInput.value = "";
    if (els.formatPreviewContent) els.formatPreviewContent.innerHTML = '<p class="muted">填写排版要求（或留空让 AI 自动识别），点「开始排版」生成预览。</p>';
    if (els.formatPreviewMeta) els.formatPreviewMeta.textContent = `已加载 ${list.length} 个段落，等待开始排版。`;
    els.formatPreviewModal?.classList.remove("hidden");
    setFormatPreviewBusy(false);
    updateFormatPreviewActionLabel();
    return true;
  }

  function formatPreviewRequirement() {
    return String(els.formatPreviewPromptInput?.value || "").trim();
  }

  function getSelectedFormatPreviewModel() {
    const fromSelect = String(els.modelSelect?.value || "").trim();
    if (fromSelect) return fromSelect;
    try {
      const active = global.WpsAiProviderRegistry?.parseActiveChatModel?.(currentSettings?.activeChatModel || "");
      if (active?.modelId) return active.modelId;
    } catch (e) {}
    return global.WpsAiOpenAI.getDefaultModel();
  }

  // 按每批最多 N 段 / M 字符切片。返回 [{ startIdx, paragraphs }]。
  function chunkParagraphsForFormat(paragraphs, maxParagraphs, maxChars) {
    const chunks = [];
    let i = 0;
    while (i < paragraphs.length) {
      let end = i;
      let charCount = 0;
      while (end < paragraphs.length) {
        // 每段前缀 "<idx>: " 也算，粗略按段落文本长度 + 6
        const add = paragraphs[end].length + 8;
        if (end > i && (charCount + add > maxChars || end - i >= maxParagraphs)) break;
        charCount += add;
        end += 1;
      }
      chunks.push({ startIdx: i, paragraphs: paragraphs.slice(i, end) });
      i = end;
    }
    return chunks;
  }

  // 走一批 AI 排版 —— 流式拉 JSON，用括号计数器抽出 block 增量渲染到 formatPreviewContent。
  // 返回该批的 blocks 数组，sourceIndex 是"批内相对索引"（0-based），由调用方加偏移换成全局。
  async function runFormatChunkStream({ chunkParagraphs, requirement, chunkLabel, totalParagraphs, globalStartIdx }) {
    const indexed = chunkParagraphs.map((p, i) => `${i}: ${p}`).join("\n");
    const system = [
      "你是 WPS 文字文档排版助手。你只负责判断每个原文段落应该套用哪种富文本样式，不改写正文。",
      "必须只输出 JSON 对象，不要 markdown，不要解释。",
      "JSON 格式：{\"blocks\":[{\"sourceIndex\":0,\"type\":\"title|subtitle|heading|paragraph|bullet|numbered|quote\",\"level\":1,\"text\":\"原段落文字\"}]}",
      "规则：text 尽量保持原文原句；只能去掉明显的编号前缀；不要合并、不要新增事实、不要输出 markdown 语法。",
      "heading 的 level 取 1-4；普通正文用 paragraph；项目符号用 bullet；编号条目用 numbered。",
      chunkLabel
        ? `注意：本批只是全文的一部分（${chunkLabel}），请只对给出的段落判断样式；未给出的段落不要凭空生成 block。sourceIndex 用批内的 0-based 索引。`
        : "",
      requirement
        ? `用户排版要求：${requirement}`
        : "用户未填写排版要求。请先根据原文内容识别文档类型（合同 / 招标文件 / 公文报告 / 通知 / 论文 / 方案 / 简历 / 普通文档 等），再按该类型的常规排版规范处理。"
    ].filter(Boolean).join("\n");

    const messagesForFormat = [
      { role: "system", content: system },
      { role: "user", content: `请给下面段落生成排版结构 JSON：\n\n${indexed}` }
    ];
    let raw = "";
    let tokensFiredFmt = false;
    let lastTick = 0;
    // 每批重新计数，DOM 里前批 append 的 block 保留
    let streamCommittedCount = 0;
    let streamActiveEl = null;
    const onTokenFmt = (_delta, fullText) => {
      tokensFiredFmt = true;
      raw = fullText;
      const now = Date.now();
      if (now - lastTick < 50) return;
      lastTick = now;
      if (!els.formatPreviewContent) return;

      const committed = extractStreamingFormatBlocks(fullText);
      while (streamCommittedCount < committed.length) {
        const block = committed[streamCommittedCount];
        const finalEl = createStreamingBlockEl(block);
        if (streamActiveEl) {
          streamActiveEl.replaceWith(finalEl);
          streamActiveEl = null;
        } else {
          els.formatPreviewContent.appendChild(finalEl);
        }
        streamCommittedCount += 1;
      }

      const active = extractActiveStreamingBlock(fullText);
      if (active && active.text) {
        if (!streamActiveEl) {
          streamActiveEl = createStreamingBlockEl(active);
          streamActiveEl.classList.add("is-streaming-active");
          els.formatPreviewContent.appendChild(streamActiveEl);
        } else {
          streamActiveEl = updateStreamingBlockEl(streamActiveEl, active);
        }
      } else if (streamActiveEl && !active) {
        streamActiveEl.remove();
        streamActiveEl = null;
      }

      try { els.formatPreviewContent.scrollTop = els.formatPreviewContent.scrollHeight; } catch (e) {}
      if (els.formatPreviewMeta) {
        const globalDone = (globalStartIdx || 0) + committed.length;
        els.formatPreviewMeta.textContent = chunkLabel
          ? `${chunkLabel}：已完成 ${committed.length} / ${chunkParagraphs.length} 段（全文 ${globalDone} / ${totalParagraphs}）`
          : (committed.length
              ? `正在生成… 已完成 ${committed.length} / ${chunkParagraphs.length} 段`
              : `正在接收排版结构…已收到 ${fullText.length} 字符`);
      }
    };
    let fmtLastErr = null;
    let fmtOk = false;
    for (let attempt = 1; attempt <= MAX_CHAT_RETRY_ATTEMPTS; attempt += 1) {
      tokensFiredFmt = false;
      raw = "";
      try {
        raw = await global.WpsAiOpenAI.streamChatCompletion({
          model: getSelectedFormatPreviewModel(),
          messages: messagesForFormat,
          temperature: 0.1,
          onToken: onTokenFmt
        });
        fmtOk = true;
        break;
      } catch (streamErr) {
        fmtLastErr = streamErr;
        const m = String(streamErr?.message || streamErr || "");
        const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(m);
        if (noStream) break;
        if (tokensFiredFmt) break;
        if (!isRetryableChatError(streamErr) || attempt >= MAX_CHAT_RETRY_ATTEMPTS) break;
        try { await global.WpsAiRuntime?.reprobe?.(); } catch (re) {}
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const seconds = Math.max(1, Math.round(delay / 1000));
        showMessage(`生成排版预览失败（${humanizePreviewError(streamErr).slice(0, 80)}），${seconds}s 后自动重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`, "info", { duration: Math.max(delay, 3000) });
        if (els.formatPreviewMeta) els.formatPreviewMeta.textContent = `正在重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (!fmtOk) {
      const m = String(fmtLastErr?.message || fmtLastErr || "");
      const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(m);
      if (noStream) {
        raw = await global.WpsAiOpenAI.chatCompletion({
          model: getSelectedFormatPreviewModel(),
          messages: messagesForFormat,
          temperature: 0.1
        });
      } else if (fmtLastErr) {
        throw fmtLastErr;
      }
    }
    const parsed = parseJsonObjectLoose(raw);
    return Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  }

  async function generateFormatPreview(options = {}) {
    try {
      if ((currentHostInfo?.host || "") !== "wps") {
        try { currentHostInfo = await global.WpsAiDocument.getHostInfo(); } catch (e) {}
      }
      if (!isFormatPreviewDialog && currentHostInfo?.host !== "wps") {
        showMessage("AI 排版目前只支持 WPS 文字文档。", "error");
        return;
      }
      // 结构化读取（保表格 / 图片）：如果宿主支持 readDocumentStructure，就走它 —— AI
      // 只处理 editable 段落，应用时表格 / 图片按 Range 跳过。宿主不支持或读失败退回
      // 老路径（readDocumentText + 全文替换，会丢表格但至少不 crash）。
      // 关键：结构化读取必须在弹窗模式下也跑。之前只有 options.text == null 才读，dialog
      // 走 openFormatPreviewAsDialog 时 options.text 已经从主窗口通过 localStorage 传过来
      // （readDocumentText 的扁平结果），条件短路 → structure 永远 null → 走扁平路径 →
      // 表格被 AI 当正文重排。改成：只要宿主支持 readDocumentStructure 就调（弹窗跑在同一
      // WPS 进程，WpsAiHostWriter 一样可用）。这是修 .wps / .docx 表格漏检的最后一环。
      let structure = null;
      try {
        if (global.WpsAiHostWriter?.readDocumentStructure) {
          structure = await global.WpsAiHostWriter.readDocumentStructure();
        }
      } catch (e) {
        try { global.WpsAiLog?.log?.("fmt:read-structure-error", e?.message || String(e)); } catch (_) {}
      }
      // useStructure 判据从 editable.length 改成 segments.length：
      // 之前"没有 editable 段"就退到 readDocumentText 老路径，纯表格文档 editable 为空，
      // 老路径会把表格文本当扁平正文送 AI → AI 拆成一行行 → 预览显示表格拆开的"乱码"。
      // 只要 structure 有 segments 就走结构化路径，即使 editable 为空也 OK。
      const useStructure = !!(structure && Array.isArray(structure.segments) && structure.segments.length);
      try { global.WpsAiLog?.log?.("fmt:use-structure", { useStructure, hasStructure: !!structure, segments: structure?.segments?.length || 0, editable: structure?.editable?.length || 0, tables: structure?.tables?.length || 0 }); } catch (_) {}
      const text = options.text != null
        ? String(options.text || "")
        : (formatPreviewState?.sourceText || (useStructure ? structure.editable.map((e) => e.text).join("\n\n") : await global.WpsAiHostWriter?.readDocumentText?.()));
      const paragraphs = Array.isArray(options.paragraphs) && options.paragraphs.length
        ? options.paragraphs
        : (useStructure ? structure.editable.map((e) => e.text) : splitDocumentParagraphs(text));
      if (!paragraphs.length) {
        showMessage("当前文档没有可排版的正文。", "error");
        return;
      }
      const requirement = options.requirement != null ? String(options.requirement || "") : formatPreviewRequirement();
      formatPreviewState = {
        sourceText: text,
        paragraphs,
        // 存下 structure，应用时 replaceParagraphsInPlace 用；老路径下就是 null
        structure: useStructure ? structure : null,
        requirement,
        blocks: formatPreviewState?.blocks || []
      };
      els.formatPreviewModal?.classList.remove("hidden");
      if (els.formatPreviewPromptInput && options.requirement != null) els.formatPreviewPromptInput.value = requirement;
      // 保留表格提示：结构化路径下告诉用户"另外还有 N 处表格 / 图片会被保留原样"
      const preservedCount = useStructure ? (structure.segments.length - structure.editable.length) : 0;
      if (els.formatPreviewMeta) {
        els.formatPreviewMeta.textContent = preservedCount > 0
          ? `正在分析 ${paragraphs.length} 个段落…（另 ${preservedCount} 处表格 / 图片 / 空段将原样保留）`
          : `正在分析 ${paragraphs.length} 个段落…`;
      }
      if (els.formatPreviewContent) els.formatPreviewContent.innerHTML = "";
      setFormatPreviewBusy(true, "正在生成排版预览…");
      updateFormatPreviewActionLabel();

      // 长文分批：之前 paragraphs.length > 180 或 indexed.length > 30000 直接退到本地规则
      // fallback，AI 完全没参与，用户看到的排版没那么智能。改成"自动拆分排版任务"：
      // 按每批 CHUNK_MAX_PARAGRAPHS 段 / CHUNK_MAX_CHARS 字符切片，串行走多轮 AI 调用，
      // 每批 sourceIndex 是批内相对索引，回来后加偏移换成全局，最后合并 + normalize。
      // 提示信息实时显示 "第 M/N 批"。
      const CHUNK_MAX_PARAGRAPHS = 60;
      const CHUNK_MAX_CHARS = 12000;
      const chunks = chunkParagraphsForFormat(paragraphs, CHUNK_MAX_PARAGRAPHS, CHUNK_MAX_CHARS);

      if (els.formatPreviewContent) {
        els.formatPreviewContent.innerHTML = "";
        els.formatPreviewContent.classList.add("is-streaming");
      }

      const allBlocks = [];
      for (let ci = 0; ci < chunks.length; ci += 1) {
        const chunk = chunks[ci];
        const chunkLabel = chunks.length > 1
          ? `第 ${ci + 1}/${chunks.length} 批（${chunk.paragraphs.length} 段）`
          : "";
        // 每批 AI 拿到的 sourceIndex 是"批内相对索引"（0-based），返回后加 chunk.startIdx 换成全局
        const chunkBlocks = await runFormatChunkStream({
          chunkParagraphs: chunk.paragraphs,
          requirement,
          chunkLabel,
          totalParagraphs: paragraphs.length,
          // 让流式渲染的 sourceIndex 显示成全局，方便肉眼对齐原文段落号
          globalStartIdx: chunk.startIdx
        });
        chunkBlocks.forEach((b) => {
          if (Number.isInteger(b?.sourceIndex)) b.sourceIndex += chunk.startIdx;
        });
        allBlocks.push(...chunkBlocks);
        if (els.formatPreviewMeta && chunks.length > 1) {
          els.formatPreviewMeta.textContent = `已处理 ${ci + 1}/${chunks.length} 批 · ${allBlocks.length} 段`;
        }
      }

      const parsed = { blocks: allBlocks, requirement };
      const blocks = normalizeFormatBlocks(parsed, paragraphs);
      formatPreviewState.blocks = blocks;
      renderFormatPreviewBlocks(blocks);
      // 收尾：去掉"流式中"样式
      if (els.formatPreviewContent) els.formatPreviewContent.classList.remove("is-streaming");
      if (els.formatPreviewMeta) {
        const preservedCount2 = formatPreviewState.structure
          ? (formatPreviewState.structure.segments.length - formatPreviewState.structure.editable.length)
          : 0;
        els.formatPreviewMeta.textContent = preservedCount2 > 0
          ? `已生成 ${blocks.length} 段富文本 · 应用时将保留 ${preservedCount2} 处表格 / 图片。`
          : `已生成 ${blocks.length} 个富文本段落，确认后可替换全文。`;
      }
      setFormatPreviewBusy(false);
      updateFormatPreviewActionLabel();
      showMessage("AI 排版预览已生成。", "success");
    } catch (e) {
      const paragraphs = formatPreviewState?.paragraphs || [];
      const fallback = inferFallbackFormatBlocks(paragraphs, formatPreviewRequirement());
      if (fallback.length) {
        formatPreviewState.blocks = fallback;
        renderFormatPreviewBlocks(fallback);
        if (els.formatPreviewMeta) els.formatPreviewMeta.textContent = "AI 输出解析失败，已生成本地规则预览。";
      }
      if (els.formatPreviewContent) els.formatPreviewContent.classList.remove("is-streaming");
      setFormatPreviewBusy(false);
      updateFormatPreviewActionLabel();
      showMessage(`生成排版预览失败：${humanizePreviewError(e)}`, "error");
    }
  }

  async function replaceDocumentWithFormatPreview() {
    if (!formatPreviewState?.blocks?.length) {
      showMessage("没有可替换的排版内容。", "error");
      return;
    }
    if (!confirm("确认用预览内容替换当前文档全文？此操作会覆盖原文排版。")) return;
    if (isFormatPreviewDialog) {
      try {
        localStorage.setItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({
          ts: Date.now(),
          cancelled: false,
          blocks: formatPreviewState.blocks,
          requirement: formatPreviewRequirement()
        }));
        formatPreviewDialogResultWritten = true;
        showMessage("已提交替换任务。", "info");
        setTimeout(() => { try { if (typeof window.close === "function") window.close(); } catch (e) {} }, 0);
      } catch (e) {
        showMessage(`提交替换任务失败：${e?.message || e}`, "error");
      }
      return;
    }
    try {
      setFormatPreviewBusy(true, "正在替换全文…");
      const blocksCount = formatPreviewState.blocks?.length || 0;
      const structure = formatPreviewState.structure;
      // 优先走"分段范围替换"：只动 kind=paragraph 的段落，表格 / 图片 / 空段 Range 完全
      // 跳过，保住原样。只有当结构化读取没成功（老宿主 / 读失败）时才退到全文 HTML 替换
      // 老路径（会丢表格 —— 但至少能替）。
      const canPreserve = !!(structure && Array.isArray(structure.segments) && structure.segments.length && global.WpsAiHostWriter?.replaceParagraphsInPlace);
      await recordPreviewModification({
        turnLabel: canPreserve ? "AI 排版（保留表格/图片）" : "AI 排版替换全文",
        toolName: "wps_replace_selection",
        params: {
          scope: canPreserve ? "editableParagraphs" : "document",
          source: "formatPreview",
          blocks: blocksCount,
          preserved: canPreserve ? (structure.segments.length - structure.editable.length) : 0
        },
        summary: canPreserve
          ? `AI 排版：替换 ${blocksCount} 段正文，保留 ${structure.segments.length - structure.editable.length} 个表格 / 图片 / 空段`
          : `AI 排版：替换全文 ${blocksCount} 个富文本段落`,
        modifyFn: async () => {
          if (canPreserve) {
            await global.WpsAiHostWriter.replaceParagraphsInPlace(structure.segments, formatPreviewState.blocks);
          } else if (global.WpsAiHostWriter?.replaceDocumentBlocksHtml) {
            await global.WpsAiHostWriter.replaceDocumentBlocksHtml(formatPreviewState.blocks);
          } else {
            await global.WpsAiHostWriter?.replaceDocumentBlocks?.(formatPreviewState.blocks);
          }
        }
      });
      setFormatPreviewBusy(false);
      closeFormatPreviewModal();
      renderHistory();
      showMessage(canPreserve
        ? `已按预览排版替换正文（保留 ${structure.segments.length - structure.editable.length} 处表格 / 图片）。`
        : "已按预览排版替换全文。", "success");
    } catch (e) {
      setFormatPreviewBusy(false);
      showMessage(`替换全文失败：${e?.message || e}`, "error");
    }
  }

  async function openFormatPreviewAsDialog() {
    try {
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      if (currentHostInfo?.host !== "wps") {
        showMessage("AI 排版目前只支持 WPS 文字文档。", "error");
        return;
      }
      const text = await global.WpsAiHostWriter?.readDocumentText?.();
      const paragraphs = splitDocumentParagraphs(text);
      if (!paragraphs.length) {
        showMessage("当前文档没有可排版的正文。", "error");
        return;
      }
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=formatpreview`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        try {
          localStorage.setItem(FORMAT_PREVIEW_DIALOG_REQUEST_KEY, JSON.stringify({
            ts: Date.now(),
            text,
            paragraphs
          }));
          localStorage.removeItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY);
        } catch (e) {}
        const { w, h } = pickDialogSize(1080, 760, { minW: 820, minH: 560 });
        app.ShowDialog(url, "灵犀AI 排版预览", w, h, true);
        consumeFormatPreviewDialogResult();
        startFormatPreviewDialogResultPolling();
        return;
      }
      bindFormatPreviewModal();
      prepareFormatPreview({ text, paragraphs });
    } catch (e) {
      console.warn("[format-preview] ShowDialog 失败，回退到 inline modal:", e?.message || e);
      showMessage(`打开 AI 排版预览失败：${e?.message || e}`, "error");
    }
  }

  async function consumeFormatPreviewDialogResult() {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let result = null;
    try { result = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
    if (!result || result.cancelled) return false;
    if (!Array.isArray(result.blocks) || !result.blocks.length) {
      showMessage("排版预览结果为空。", "error");
      return false;
    }
    try {
      setFormatPreviewBusy(true, "正在替换全文…");
      const blocksCount = result.blocks.length;
      // 关键：主窗口这里也要重读一次 structure —— dialog 只回传了 blocks，没带 segments。
      // 之前主窗口直接走 replaceDocumentBlocksHtml 全文清洗重建 → 表格 / 图片全丢。
      // 文档在 dialog 期间没被改动（用户只在弹窗里看预览），重读的结构跟 dialog 里生成
      // 时一致，可以直接喂给 replaceParagraphsInPlace 做"只动 paragraph、跳过 table/image"
      // 的分段替换。
      let structure = null;
      try {
        if (global.WpsAiHostWriter?.readDocumentStructure) {
          structure = await global.WpsAiHostWriter.readDocumentStructure();
        }
      } catch (e) {
        try { global.WpsAiLog?.log?.("fmt:consume-read-structure-error", e?.message || String(e)); } catch (_) {}
      }
      const canPreserve = !!(structure && Array.isArray(structure.segments) && structure.segments.length && global.WpsAiHostWriter?.replaceParagraphsInPlace);
      try { global.WpsAiLog?.log?.("fmt:consume-canPreserve", { canPreserve, hasStructure: !!structure, segments: structure?.segments?.length || 0, editable: structure?.editable?.length || 0 }); } catch (_) {}
      await recordPreviewModification({
        turnLabel: canPreserve ? "AI 排版（保留表格/图片）" : "AI 排版替换全文",
        toolName: "wps_replace_selection",
        params: {
          scope: canPreserve ? "editableParagraphs" : "document",
          source: "formatPreview",
          blocks: blocksCount,
          preserved: canPreserve ? (structure.segments.length - structure.editable.length) : 0
        },
        summary: canPreserve
          ? `AI 排版：替换 ${blocksCount} 段正文，保留 ${structure.segments.length - structure.editable.length} 个表格 / 图片 / 空段`
          : `AI 排版：替换全文 ${blocksCount} 个富文本段落`,
        modifyFn: async () => {
          if (canPreserve) {
            await global.WpsAiHostWriter.replaceParagraphsInPlace(structure.segments, result.blocks);
          } else if (global.WpsAiHostWriter?.replaceDocumentBlocksHtml) {
            await global.WpsAiHostWriter.replaceDocumentBlocksHtml(result.blocks);
          } else {
            await global.WpsAiHostWriter?.replaceDocumentBlocks?.(result.blocks);
          }
        }
      });
      setFormatPreviewBusy(false);
      renderHistory();
      showMessage(canPreserve
        ? `已按预览排版替换正文（保留 ${structure.segments.length - structure.editable.length} 处表格 / 图片）。`
        : "已按预览排版替换全文。", "success");
      return true;
    } catch (e) {
      setFormatPreviewBusy(false);
      showMessage(`替换全文失败：${e?.message || e}`, "error");
      return false;
    }
  }

  let formatPreviewDialogPollTimer = null;
  function startFormatPreviewDialogResultPolling() {
    if (isAnyDialogWindow()) return;
    if (formatPreviewDialogPollTimer) clearInterval(formatPreviewDialogPollTimer);
    let ticks = 0;
    formatPreviewDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeFormatPreviewDialogResult();
      if (ticks >= 600) {
        clearInterval(formatPreviewDialogPollTimer);
        formatPreviewDialogPollTimer = null;
      }
    }, 500);
  }

  function bindFormatPreviewModal() {
    if (formatPreviewBound) return;
    formatPreviewBound = true;
    els.formatPreviewCloseBtn?.addEventListener("click", closeFormatPreviewModal);
    els.formatPreviewCancelBtn?.addEventListener("click", closeFormatPreviewModal);
    els.formatPreviewRegenerateBtn?.addEventListener("click", () => generateFormatPreview());
    els.formatPreviewReplaceBtn?.addEventListener("click", replaceDocumentWithFormatPreview);
    els.formatPreviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.formatPreviewModal) closeFormatPreviewModal();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && els.formatPreviewModal && !els.formatPreviewModal.classList.contains("hidden")) {
        closeFormatPreviewModal();
      }
    });
  }

  // ---------------- WPS 选区翻译/优化预览 ----------------

  let selectionPreviewState = null;
  let selectionPreviewBound = false;
  let selectionPreviewDialogResultWritten = false;
  let selectionPreviewDialogPollTimer = null;
  let lastSelectionPreviewResultTs = 0;

  function isAnyDialogWindow() {
    return isPreviewDialog || isSettingsDialog || isStylePresetDialog || isMaterialsDialog
      || isQuickPromptDialog || isFormatPreviewDialog || isSelectionPreviewDialog;
  }

  function selectionPreviewIntentLabel(intent, tone) {
    if (intent === "translate") return "翻译";
    if (intent === "tone") return String(tone || "改写").trim() || "改写";
    if (intent === "documentRewrite") return String(tone || "全文润色").trim() || "全文润色";
    if (intent === "documentReport") return String(tone || "文档报告").trim() || "文档报告";
    return "优化";
  }

  function selectionPreviewTargetLanguage() {
    const value = String(els.selectionPreviewLanguageSelect?.value || "简体中文").trim();
    const custom = String(els.selectionPreviewCustomLanguageInput?.value || "").trim();
    return value === "custom" ? custom : value;
  }

  function selectionPreviewInstruction() {
    return String(els.selectionPreviewInstructionInput?.value || "").trim();
  }

  function selectedSelectionPreviewModel() {
    return getSelectedFormatPreviewModel();
  }

  // 当 listFormat 存在时按 <ul>/<ol> 渲染；否则按段落渲染。list 场景下按单行拆分，
  // 保证 AI 扩写生成的多行也每行一个 <li>；非 list 场景保留原有"按空行分段"的行为。
  function selectionPreviewParagraphHtml(text, listFormat) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (listFormat && listFormat.kind) {
      const items = normalized.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const tag = listFormat.kind === "numbered" ? "ol" : "ul";
      const lis = items.map((it) => `<li>${escapeHtmlSafe(it)}</li>`).join("");
      return `<${tag} class="selection-preview-list selection-preview-list-${listFormat.kind}">${lis}</${tag}>`;
    }
    const parts = normalized.split(/\n{2,}/);
    return parts.map((part) => `<p>${escapeHtmlSafe(part.trim() || " ")}</p>`).join("");
  }

  function renderSelectionPreviewTexts() {
    // 原文和 AI 输出都按同一 listFormat 渲染 —— 用户视觉一致
    const listFormat = selectionPreviewState?.listFormat || null;
    if (els.selectionPreviewOriginal) {
      els.selectionPreviewOriginal.innerHTML = selectionPreviewParagraphHtml(selectionPreviewState?.sourceText || "", listFormat);
    }
    if (els.selectionPreviewResult) {
      // documentReport 输出是 markdown（含标题/列表），用 markdown 渲染更好读；
      // 其它 intent 输出是纯文本（替换用），按段落 / 列表渲染避免误解析。
      const result = String(selectionPreviewState?.resultText || "");
      const intent = selectionPreviewState?.intent;
      if (intent === "documentReport" && global.WpsAiMarkdown?.renderToHtml && result) {
        els.selectionPreviewResult.innerHTML = global.WpsAiMarkdown.renderToHtml(result);
      } else {
        els.selectionPreviewResult.innerHTML = selectionPreviewParagraphHtml(result, listFormat);
      }
    }
    renderSelectionPreviewDiff();
  }

  function diffWords(original, result) {
    const a = String(original || "").match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff]/g) || [];
    const b = String(result || "").match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff]/g) || [];
    const maxCells = 18000;
    if (a.length * b.length > maxCells) {
      return [
        { type: "delete", text: original },
        { type: "insert", text: result }
      ];
    }
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    const push = (type, text) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        push("equal", a[i]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push("delete", a[i]);
        i += 1;
      } else {
        push("insert", b[j]);
        j += 1;
      }
    }
    while (i < a.length) push("delete", a[i++]);
    while (j < b.length) push("insert", b[j++]);
    return out;
  }

  function renderSelectionPreviewDiff() {
    if (!els.selectionPreviewDiff) return;
    if (!selectionPreviewState?.diffVisible) {
      els.selectionPreviewDiff.classList.add("hidden");
      return;
    }
    const pieces = diffWords(selectionPreviewState.sourceText || "", selectionPreviewState.resultText || "");
    els.selectionPreviewDiff.innerHTML = pieces.map((part) => {
      const text = escapeHtmlSafe(part.text);
      if (part.type === "delete") return `<del>${text}</del>`;
      if (part.type === "insert") return `<ins>${text}</ins>`;
      return text;
    }).join("");
    els.selectionPreviewDiff.classList.remove("hidden");
  }

  function setSelectionPreviewBusy(on, text) {
    if (els.selectionPreviewLoading) {
      els.selectionPreviewLoading.classList.toggle("hidden", !on);
      const label = els.selectionPreviewLoading.querySelector("span:last-child");
      if (label && text) label.textContent = text;
    }
    if (els.selectionPreviewReplaceBtn) els.selectionPreviewReplaceBtn.disabled = on || !selectionPreviewState?.resultText;
    if (els.selectionPreviewRegenerateBtn) els.selectionPreviewRegenerateBtn.disabled = on;
  }

  function applySelectionPreviewModeUi(intent) {
    const isTranslate = intent === "translate";
    const isTone = intent === "tone";
    const tone = selectionPreviewState?.tone || "改写";
    const isDocRewrite = intent === "documentRewrite";
    const isDocReport = intent === "documentReport";
    const reportKind = selectionPreviewState?.reportKind || "";

    let titleText;
    if (isTranslate) titleText = "翻译预览";
    else if (isDocRewrite || isDocReport) titleText = `${tone}预览`;
    else if (isTone) titleText = `${tone}预览`;
    else titleText = "优化预览";

    let metaText;
    if (isTranslate) metaText = "选择目标语言，预览翻译结果，确认后替换当前选区。";
    else if (isDocRewrite) metaText = `预览「${tone}」前后内容，确认后将替换整篇文档。点「高亮对比」可看差异。`;
    else if (isDocReport) metaText = reportKind === "mindmap"
      ? "AI 已基于整篇文档生成 markdown 大纲脑图，可复制或插入到光标位置（不会替换原文档）。"
      : "AI 已基于整篇文档生成结构化摘要，可复制或插入到光标位置（不会替换原文档）。";
    else if (isTone) metaText = `预览「${tone}」改写前后内容，确认后替换当前选区。`;
    else metaText = "预览优化前后内容，确认后替换当前选区。";

    if (els.selectionPreviewTitle) els.selectionPreviewTitle.textContent = titleText;
    if (els.selectionPreviewMeta) els.selectionPreviewMeta.textContent = metaText;
    els.selectionPreviewTranslateControls?.classList.toggle("hidden", !isTranslate);
    if (els.selectionPreviewInstructionLabel) {
      els.selectionPreviewInstructionLabel.textContent = isTranslate
        ? "翻译要求"
        : ((isTone || isDocRewrite) ? "改写要求" : (isDocReport ? "总结要求" : "优化要求"));
    }
    if (els.selectionPreviewInstructionInput) {
      els.selectionPreviewInstructionInput.placeholder = isTranslate
        ? "可选。比如：保留专业术语、使用商务书面语、人名不翻译。"
        : ((isTone || isDocRewrite)
          ? `已预设「${tone}」要求，可在这里追加补充（如：保留专有名词、控制在 300 字以内）。`
          : (isDocReport
            ? "可选。比如：每个要点不超过 20 字 / 只关注关键数据 / 加结论判断。"
            : "可选。比如：更正式、更简洁、更有逻辑、保留原意。"));
    }
    if (els.selectionPreviewTip) {
      els.selectionPreviewTip.textContent = isTranslate
        ? "自定义语言会优先生效；未填写翻译要求时按自然书面语处理。"
        : ((isTone || isDocRewrite)
          ? "改写要求会附加在预设之后；点「高亮对比」可一键看修改前后的差异。"
          : (isDocReport
            ? "结果是基于全文的概括，不会自动替换原文档；请用「复制结果」或「插入光标处」按需使用。"
            : "优化要求可以留空，AI 会保持原意并改善表达。"));
    }
    // documentReport：隐藏"原文"那一栏（避免整篇文档塞满左侧），隐藏高亮对比，露出复制按钮
    els.selectionPreviewCompare?.classList.toggle("result-only", isDocReport);
    els.selectionPreviewToggleDiffBtn?.classList.toggle("hidden", isDocReport);
    els.selectionPreviewCopyBtn?.classList.toggle("hidden", !isDocReport);
    if (els.selectionPreviewReplaceBtn) {
      if (isDocRewrite) els.selectionPreviewReplaceBtn.textContent = "替换全文";
      else if (isDocReport) els.selectionPreviewReplaceBtn.textContent = "插入光标处";
      else els.selectionPreviewReplaceBtn.textContent = "替换选区";
    }
    updateSelectionPreviewActionLabel();
  }

  function updateSelectionPreviewActionLabel() {
    if (!els.selectionPreviewRegenerateBtn) return;
    const intent = selectionPreviewState?.intent;
    const tone = selectionPreviewState?.tone;
    const hasResult = !!selectionPreviewState?.resultText;
    if (hasResult) {
      els.selectionPreviewRegenerateBtn.textContent = "重新生成";
      return;
    }
    if (intent === "translate") {
      els.selectionPreviewRegenerateBtn.textContent = "翻译";
    } else if (intent === "tone") {
      els.selectionPreviewRegenerateBtn.textContent = `开始改写为「${tone || "改写"}」`;
    } else if (intent === "documentRewrite") {
      els.selectionPreviewRegenerateBtn.textContent = `开始「${tone || "全文润色"}」`;
    } else if (intent === "documentReport") {
      const rk = selectionPreviewState?.reportKind;
      els.selectionPreviewRegenerateBtn.textContent = rk === "mindmap" ? "提炼脑图" : "生成总结";
    } else {
      els.selectionPreviewRegenerateBtn.textContent = "优化";
    }
  }

  function openSelectionPreviewInline(payload) {
    const rawIntent = String(payload?.intent || "").toLowerCase();
    let intent = "optimize";
    if (rawIntent === "translate") intent = "translate";
    else if (rawIntent === "tone") intent = "tone";
    else if (rawIntent === "documentrewrite") intent = "documentRewrite";
    else if (rawIntent === "documentreport") intent = "documentReport";
    const sourceText = String(payload?.sourceText || "");
    const presetIntents = ["tone", "documentRewrite", "documentReport"];
    selectionPreviewState = {
      intent,
      tone: presetIntents.includes(intent)
        ? (String(payload?.tone || "").trim() || (intent === "documentRewrite" ? "全文润色" : (intent === "documentReport" ? "文档报告" : "改写")))
        : "",
      presetInstruction: presetIntents.includes(intent) ? String(payload?.instruction || "") : "",
      reportKind: intent === "documentReport" ? String(payload?.reportKind || "summary") : "",
      scope: payload?.scope === "document" ? "document" : "selection",
      sourceText,
      resultText: "",
      range: payload?.range || null,
      // 记住原文的 list 格式（无序 / 有序 / null），用于：
      // 1) 预览渲染（原文 + AI 结果都按 <ul>/<ol> 显示）
      // 2) 替换时透传给 replaceRangeText / replaceSelectionText，重 apply bullet 到所有新段落
      listFormat: payload?.listFormat || null,
      diffVisible: false
    };
    applySelectionPreviewModeUi(intent);
    // tone / documentRewrite / documentReport 流的 payload.instruction 是预设要求（拼在 system prompt 里），不预填到 textarea；
    // 翻译/优化流时 instruction 是用户上次写的补充要求，正常回填。
    if (els.selectionPreviewInstructionInput) {
      els.selectionPreviewInstructionInput.value = presetIntents.includes(intent) ? "" : String(payload?.instruction || "");
    }
    if (els.selectionPreviewLanguageSelect && intent === "translate") {
      const lang = String(payload?.targetLanguage || "简体中文");
      const known = Array.from(els.selectionPreviewLanguageSelect.options).some((opt) => opt.value === lang);
      els.selectionPreviewLanguageSelect.value = known ? lang : "custom";
      if (els.selectionPreviewCustomLanguageInput) {
        els.selectionPreviewCustomLanguageInput.value = known ? "" : lang;
        els.selectionPreviewCustomLanguageInput.classList.toggle("hidden", known);
      }
    }
    els.selectionPreviewModal?.classList.remove("hidden");
    renderSelectionPreviewTexts();
    setSelectionPreviewBusy(false);
    return true;
  }

  function buildSelectionPreviewPrompt() {
    const intent = selectionPreviewState?.intent || "optimize";
    const instruction = selectionPreviewInstruction();
    const targetLanguage = selectionPreviewTargetLanguage();
    const source = selectionPreviewState?.sourceText || "";
    if (intent === "translate") {
      if (!targetLanguage) throw new Error("请先选择或输入目标语言。");
      return [
        `请把下面 WPS 文字选区内容翻译为${targetLanguage}。`,
        "要求：只输出翻译后的正文，不要解释，不要 Markdown 代码块。",
        "保留原文的段落换行；专有名词、数字、符号按上下文自然处理。",
        instruction ? `用户补充要求：${instruction}` : "",
        "",
        "【原文】",
        source
      ].filter(Boolean).join("\n");
    }
    if (intent === "tone") {
      const tone = selectionPreviewState?.tone || "改写";
      const preset = selectionPreviewState?.presetInstruction || `按「${tone}」风格改写。`;
      return [
        `请按「${tone}」风格改写下面 WPS 文字选区内容。`,
        "要求：只输出改写后的正文，不要解释，不要 Markdown 代码块。",
        "保持原意和关键事实，不新增事实；保留原文段落换行。",
        `【风格要求】${preset}`,
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【原文】",
        source
      ].filter(Boolean).join("\n");
    }
    if (intent === "documentRewrite") {
      const tone = selectionPreviewState?.tone || "全文润色";
      const preset = selectionPreviewState?.presetInstruction || "整体润色，保持结构和原意。";
      return [
        `请对下面整篇 WPS 文字文档执行「${tone}」处理。`,
        "要求：只输出处理后的全文正文，不要解释，不要 Markdown 代码块。",
        "保持章节结构、段落顺序、关键事实和数据不变；保留原文段落换行。",
        `【处理要求】${preset}`,
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【全文原文】",
        source
      ].filter(Boolean).join("\n");
    }
    if (intent === "documentReport") {
      const reportKind = selectionPreviewState?.reportKind || "summary";
      const preset = selectionPreviewState?.presetInstruction || "";
      const kindLine = reportKind === "mindmap"
        ? "请基于下面整篇 WPS 文字文档生成 markdown 大纲脑图（一级用 `# `，二级用 `## `，三级用 `### `，要点用 `- `）。"
        : "请基于下面整篇 WPS 文字文档生成结构化中文摘要（含标题、要点列表、核心结论）。";
      return [
        kindLine,
        "要求：只输出 markdown 内容，不要解释，不要外层代码块包裹（直接以标题/列表开头）。",
        preset ? `【输出要求】${preset}` : "",
        instruction ? `【用户补充要求】${instruction}` : "",
        "",
        "【全文原文】",
        source
      ].filter(Boolean).join("\n");
    }
    return [
      "请优化下面 WPS 文字选区内容。",
      "要求：只输出优化后的正文，不要解释，不要 Markdown 代码块。",
      "保持原意和关键事实，不新增事实；保留段落换行；让表达更清晰、通顺、专业。",
      instruction ? `用户优化要求：${instruction}` : "",
      "",
      "【原文】",
      source
    ].filter(Boolean).join("\n");
  }

  // 用 sequence token 让"被取消"的流式请求自然失效——晚到的 onToken / 错误都按 stale 丢弃。
  // 不依赖 provider 端是否支持 abort signal，三家 provider 行为统一。
  let selectionPreviewStreamSeq = 0;

  function stripFences(s) {
    return String(s || "").replace(/^```[a-zA-Z]*\s*/, "").replace(/\n?```$/g, "");
  }

  // "Failed to fetch" 这类错误对用户极不友好，统一翻译成可操作的中文
  function humanizePreviewError(err) {
    const raw = String(err?.message || err || "");
    if (/failed to fetch|networkerror|net::|fetch.*fail/i.test(raw)) {
      return "网络/本地代理不可达（Failed to fetch）。请确认 npm run proxy 还在跑、或重启 WPS 让 runtime 重新探到 proxy 端口。";
    }
    if (/timeout|超时/i.test(raw)) {
      return "请求超时。可能是模型加载慢或网络抖动，可点「重新生成」再试一次。";
    }
    return raw || "未知错误";
  }

  async function generateSelectionPreview() {
    if (!selectionPreviewState?.sourceText) {
      showMessage("当前没有可处理的选区内容。", "error");
      return;
    }
    const mySeq = ++selectionPreviewStreamSeq;
    const isCurrent = () => mySeq === selectionPreviewStreamSeq && !!selectionPreviewState;
    const sysPrompt = "你是 WPS 文字选区处理助手。严格按用户要求输出可直接替换选区的正文，不要解释。";
    const temperature = selectionPreviewState.intent === "translate" ? 0.1 : 0.25;
    const prompt = buildSelectionPreviewPrompt();
    const messages = [
      { role: "system", content: sysPrompt },
      { role: "user", content: prompt }
    ];

    setSelectionPreviewBusy(true, "正在流式生成预览…");
    selectionPreviewState.resultText = "";
    renderSelectionPreviewTexts();

    let lastRenderAt = 0;
    let tokensFiredThisAttempt = false;
    const onToken = (_delta, fullText) => {
      if (!isCurrent()) return;
      tokensFiredThisAttempt = true;
      selectionPreviewState.resultText = stripFences(fullText);
      const now = Date.now();
      if (now - lastRenderAt > 80) {
        lastRenderAt = now;
        renderSelectionPreviewTexts();
      }
    };

    // 一次流式 → 失败时按 isRetryableChatError 做 5 次重试（指数退避），重试前先 reprobe 一次本地端口，
    // 应对 proxy 重启换端口、WpsAiRuntime 缓存过期的"Failed to fetch"场景。
    // 流中途已经吐过 token 时不再重试（避免 UI 重影）。
    let lastErr = null;
    let runSucceeded = false;
    let finalText = "";
    for (let attempt = 1; attempt <= MAX_CHAT_RETRY_ATTEMPTS; attempt += 1) {
      if (!isCurrent()) return;
      tokensFiredThisAttempt = false;
      // 重置流式状态（首次不影响，重试时把残留也清掉）
      selectionPreviewState.resultText = "";
      renderSelectionPreviewTexts();
      try {
        finalText = await global.WpsAiOpenAI.streamChatCompletion({
          model: selectedSelectionPreviewModel(),
          messages,
          temperature,
          onToken
        });
        runSucceeded = true;
        break;
      } catch (e) {
        lastErr = e;
        if (e?.name === "AbortError") return;
        if (tokensFiredThisAttempt) break;
        // provider 真不支持 streamChat → 退到非流式分支
        const msg = String(e?.message || e || "");
        const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(msg);
        if (noStream) break;
        if (!isRetryableChatError(e) || attempt >= MAX_CHAT_RETRY_ATTEMPTS) break;
        try { await global.WpsAiRuntime?.reprobe?.(); } catch (re) {}
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const seconds = Math.max(1, Math.round(delay / 1000));
        showMessage(`生成预览失败（${humanizePreviewError(e).slice(0, 80)}），${seconds}s 后自动重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`, "info", { duration: Math.max(delay, 3000) });
        if (els.selectionPreviewLoading) {
          const label = els.selectionPreviewLoading.querySelector("span:last-child");
          if (label) label.textContent = `正在重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`;
        }
        await new Promise((r) => setTimeout(r, delay));
        if (!isCurrent()) return;
      }
    }

    if (runSucceeded) {
      if (!isCurrent()) return;
      selectionPreviewState.resultText = stripFences(String(finalText || "")).trim();
      renderSelectionPreviewTexts();
      setSelectionPreviewBusy(false);
      updateSelectionPreviewActionLabel();
      showMessage("预览已生成。", "success");
      return;
    }

    // 流式跑空了——可能 provider 不支持流式 / 重试也没成功。
    // 不支持流式 → 走一次非流式兜底；其它情况直接报错。
    if (lastErr) {
      const errMsg = String(lastErr?.message || lastErr || "");
      const noStream = /not support|不支持|streamChat is not a function|provider.streamChat/i.test(errMsg);
      if (noStream) {
        try {
          const raw = await global.WpsAiOpenAI.chatCompletion({
            model: selectedSelectionPreviewModel(),
            messages,
            temperature
          });
          if (!isCurrent()) return;
          selectionPreviewState.resultText = stripFences(String(raw || "")).trim();
          renderSelectionPreviewTexts();
          setSelectionPreviewBusy(false);
          updateSelectionPreviewActionLabel();
          showMessage("预览已生成（当前 provider 不支持流式，已切非流式）。", "info");
        } catch (e2) {
          if (!isCurrent()) return;
          setSelectionPreviewBusy(false);
          showMessage(`生成预览失败：${humanizePreviewError(e2)}`, "error");
        }
        return;
      }
    }

    if (!isCurrent()) return;
    setSelectionPreviewBusy(false);
    showMessage(`生成预览失败（重试 ${MAX_CHAT_RETRY_ATTEMPTS} 次仍不成功）：${humanizePreviewError(lastErr)}`, "error", { autoHide: false, duration: 12000 });
  }

  function closeSelectionPreviewModal(cancelled = true) {
    // 关闭时把流式 seq 推一格，让任何在途的 onToken 自动 stale 丢弃
    selectionPreviewStreamSeq += 1;
    if (isSelectionPreviewDialog && cancelled) {
      writeSelectionPreviewDialogResult({ cancelled: true });
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.selectionPreviewModal?.classList.add("hidden");
    selectionPreviewState = null;
  }

  function writeSelectionPreviewDialogResult(result) {
    if (!isSelectionPreviewDialog || selectionPreviewDialogResultWritten) return;
    selectionPreviewDialogResultWritten = true;
    const blob = Object.assign({ ts: Date.now() }, result || {});
    try { localStorage.setItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify(blob)); } catch (e) {}
  }

  async function replaceSelectionWithPreviewResult() {
    if (!selectionPreviewState?.resultText) {
      showMessage("没有可使用的结果。", "error");
      return;
    }
    const intent = selectionPreviewState.intent;
    // 替换全文前要求二次确认，避免误覆盖
    if (intent === "documentRewrite") {
      if (!confirm("确认用预览内容替换当前文档全文？此操作会覆盖原文。")) return;
    }
    const result = {
      cancelled: false,
      intent,
      tone: selectionPreviewState.tone || "",
      reportKind: selectionPreviewState.reportKind || "",
      scope: selectionPreviewState.scope || "selection",
      text: selectionPreviewState.resultText,
      range: selectionPreviewState.range || null,
      // 透传给 replaceRangeText，让替换后的段落重新拿回 bullet / numbering 格式
      listFormat: selectionPreviewState.listFormat || null
    };
    if (isSelectionPreviewDialog) {
      writeSelectionPreviewDialogResult(result);
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("已提交。", "info"); }, 100);
      return;
    }
    await applySelectionPreviewResult(result);
  }

  // 把弹窗里"非工具"的直接写入也走 history.addEntry + conversation events 一遍——
  // 这样改动记录里能看到、能一键回退，对话流里也留痕（共享给 AI 后续推理用）。
  // 用现有的 toolName 复用 FRIENDLY_NAMES 映射，不再单独定义文案。
  async function recordPreviewModification({ turnLabel, toolName, params, modifyFn, summary }) {
    const history = global.WpsAiHistory;
    const snap = global.WpsAiSnapshot;
    try { history?.startTurn?.(turnLabel); } catch (e) {}
    try { await history?.ensureBackupForTurn?.(); } catch (e) {}

    let target = null, before = null, captureAfterFn = null;
    try {
      const host = snap?.detectHost?.() || "wps";
      const pre = await snap?.captureBefore?.(host, toolName, params);
      target = pre?.target || null;
      before = pre?.before || null;
      captureAfterFn = pre?._captureAfter || null;
    } catch (e) {}

    let modErr = null;
    try {
      await modifyFn();
    } catch (e) {
      modErr = e;
    }

    let after = null;
    try {
      if (!modErr && captureAfterFn) after = await snap?.captureAfter?.(captureAfterFn);
    } catch (e) {}

    try {
      history?.addEntry?.({
        host: snap?.detectHost?.() || "wps",
        toolName,
        friendlyName: history?.getFriendlyName?.(toolName) || turnLabel,
        target,
        params,
        before,
        after,
        ok: !modErr,
        resultSummary: summary || (modErr ? null : "弹窗替换成功"),
        error: modErr ? (modErr?.message || String(modErr)) : null,
        docPath: global.WpsAiBackup?.getCurrentDocPath?.() || null,
        source: "preview-dialog"
      });
    } catch (e) { console.warn("[preview] addEntry 失败", e); }

    // 同步到当前对话事件流，让聊天流 / 后续 AI 能看到这次弹窗操作
    try {
      const Conv = global.WpsAiConversations;
      if (Conv) {
        if (!Conv.getCurrentId?.()) Conv.createNew?.({ docKey: getCurrentDocKey?.() });
        Conv.appendTurnEvents?.([
          { type: "tool_call", name: toolName, args: params, ts: Date.now(), source: "preview-dialog" },
          {
            type: "tool_result",
            name: toolName,
            result: modErr
              ? { ok: false, error: modErr?.message || String(modErr) }
              : { ok: true, value: { summary: summary || `${turnLabel} 完成` } },
            ts: Date.now(),
            source: "preview-dialog"
          }
        ]);
      }
    } catch (e) {}

    // 关掉当前 UndoRecord 让下次 Application.Undo 能一次性撤回这次弹窗操作（rollback 的两层方案之一）
    try { global.WpsAiBackup?.endUndoGroup?.(); } catch (e) {}
    if (modErr) throw modErr;
  }

  async function applySelectionPreviewResult(result) {
    if (!result?.text) return false;
    const intent = result.intent;
    const label = selectionPreviewIntentLabel(result.intent, result.tone || selectionPreviewState?.tone);
    try {
      if (intent === "documentRewrite") {
        setSelectionPreviewBusy(true, "正在替换全文…");
        await recordPreviewModification({
          turnLabel: `${label}替换全文`,
          // 借用现有工具名：history.addEntry 友好名直接复用「替换选区内容」并由 target 标识"全文"
          toolName: "wps_replace_selection",
          params: { scope: "document", textLength: result.text.length, tone: result.tone, intent },
          summary: `${label}：替换整篇文档共 ${result.text.length} 字符`,
          modifyFn: async () => {
            const writer = global.WpsAiHostWriter;
            const app = global.WpsAiAddon?.getApplicationSync?.();
            const sel = app?.Selection;
            if (sel?.WholeStory) sel.WholeStory();
            // 全文场景 keepFormat=false：单一全局快照回放会抹平多段差异化样式
            await writer?.replaceSelectionText?.(result.text, { format: "plain", keepFormat: false });
          }
        });
        setSelectionPreviewBusy(false);
        closeSelectionPreviewModal(false);
        renderHistory();
        showMessage("已替换全文（样式回退到默认）。", "success");
        return true;
      }
      if (intent === "documentReport") {
        setSelectionPreviewBusy(true, "正在插入到光标位置…");
        await recordPreviewModification({
          turnLabel: `${label}插入光标处`,
          toolName: "wps_insert_text",
          params: { reportKind: result.reportKind, textLength: result.text.length, intent },
          summary: `${label}：在光标位置插入 ${result.text.length} 字符的 markdown 内容`,
          modifyFn: async () => {
            await global.WpsAiHostWriter?.insertText?.(result.text, { format: "markdown" });
          }
        });
        setSelectionPreviewBusy(false);
        closeSelectionPreviewModal(false);
        renderHistory();
        showMessage("已插入到光标位置。", "success");
        return true;
      }
      setSelectionPreviewBusy(true, "正在替换选区…");
      await recordPreviewModification({
        turnLabel: `${label}替换选区`,
        toolName: "wps_replace_selection",
        params: { scope: "selection", textLength: result.text.length, tone: result.tone, intent, range: result.range, listFormat: result.listFormat },
        summary: `${label}：替换选区 ${result.text.length} 字符`,
        modifyFn: async () => {
          // listFormat 透传给 writer —— 让替换后的每一段都拿回原来的 bullet / numbering。
          // 之前 range.Text = "多段" 只有首段保留 list 格式，后续段变成普通段，用户投诉
          // "扩写无序列表后小黑点没了"就是这原因。
          const opts = { format: "plain", keepFormat: true, listFormat: result.listFormat || null };
          if (result.range && global.WpsAiHostWriter?.replaceRangeText) {
            await global.WpsAiHostWriter.replaceRangeText(result.range, result.text, opts);
          } else {
            await global.WpsAiHostWriter?.replaceSelectionText?.(result.text, opts);
          }
        }
      });
      setSelectionPreviewBusy(false);
      closeSelectionPreviewModal(false);
      renderHistory();
      showMessage("已替换当前选区。", "success");
      return true;
    } catch (e) {
      setSelectionPreviewBusy(false);
      showMessage(`操作失败：${e?.message || e}`, "error");
      return false;
    }
  }

  async function consumeSelectionPreviewDialogResult() {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let result = null;
    try { result = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
    if (!result || typeof result !== "object") return false;
    if (result.ts && result.ts === lastSelectionPreviewResultTs) return false;
    lastSelectionPreviewResultTs = result.ts || Date.now();
    if (result.cancelled) return true;
    return applySelectionPreviewResult(result);
  }

  function startSelectionPreviewDialogResultPolling() {
    if (isAnyDialogWindow()) return;
    if (selectionPreviewDialogPollTimer) clearInterval(selectionPreviewDialogPollTimer);
    let ticks = 0;
    selectionPreviewDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeSelectionPreviewDialogResult();
      if (ticks >= 600) {
        clearInterval(selectionPreviewDialogPollTimer);
        selectionPreviewDialogPollTimer = null;
      }
    }, 500);
  }

  async function openSelectionPreviewAsDialog(payload) {
    try {
      currentHostInfo = await global.WpsAiDocument.getHostInfo();
      if (currentHostInfo?.host !== "wps") {
        showMessage("该功能目前只支持 WPS 文字文档。", "error");
        return false;
      }
      const wantsFullDoc = payload?.scope === "document";
      let text = "";
      let range = null;
      let listFormat = null;
      if (wantsFullDoc) {
        // 全文场景：读整篇文档，不要求选中
        text = String(await global.WpsAiHostWriter?.readDocumentText?.() || "").trim();
        if (!text) {
          showMessage("当前文档没有可处理的正文。", "error");
          return false;
        }
      } else {
        const snap = await global.WpsAiHostWriter?.readSelectionSnapshot?.();
        text = String(snap?.text || "").trim();
        if (!text) {
          showMessage("请先选中文字，再使用该功能。", "error");
          return false;
        }
        range = snap?.range || null;
        listFormat = snap?.listFormat || null;   // 关键：原文是不是无序 / 有序 list 段落
      }
      const request = Object.assign({}, payload || {}, {
        ts: Date.now(),
        sourceText: text,
        range,
        listFormat
      });
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=selectionpreview`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        try { localStorage.setItem(SELECTION_PREVIEW_DIALOG_REQUEST_KEY, JSON.stringify(request)); } catch (e) {}
        try { localStorage.removeItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY); } catch (e) {}
        const { w, h } = pickDialogSize(1120, 760, { minW: 820, minH: 560 });
        app.ShowDialog(url, `灵犀AI ${selectionPreviewIntentLabel(request.intent, request.tone)}预览`, w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        await consumeSelectionPreviewDialogResult();
        startSelectionPreviewDialogResultPolling();
        return true;
      }
      return openSelectionPreviewInline(request);
    } catch (e) {
      showMessage(`打开预览失败：${e?.message || e}`, "error");
      return false;
    }
  }

  function bindSelectionPreviewModal() {
    if (selectionPreviewBound) return;
    selectionPreviewBound = true;
    els.selectionPreviewCloseBtn?.addEventListener("click", () => closeSelectionPreviewModal(true));
    els.selectionPreviewCancelBtn?.addEventListener("click", () => closeSelectionPreviewModal(true));
    els.selectionPreviewRegenerateBtn?.addEventListener("click", () => generateSelectionPreview());
    els.selectionPreviewReplaceBtn?.addEventListener("click", replaceSelectionWithPreviewResult);
    els.selectionPreviewCopyBtn?.addEventListener("click", async () => {
      const text = String(selectionPreviewState?.resultText || "").trim();
      if (!text) {
        showMessage("还没有结果可复制。", "info");
        return;
      }
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        showMessage("结果已复制到剪贴板。", "success");
      } catch (e) {
        showMessage(`复制失败：${e?.message || e}`, "error");
      }
    });
    els.selectionPreviewToggleDiffBtn?.addEventListener("click", () => {
      if (!selectionPreviewState) return;
      selectionPreviewState.diffVisible = !selectionPreviewState.diffVisible;
      if (els.selectionPreviewToggleDiffBtn) {
        els.selectionPreviewToggleDiffBtn.textContent = selectionPreviewState.diffVisible ? "隐藏高亮" : "高亮对比";
      }
      renderSelectionPreviewDiff();
    });
    els.selectionPreviewLanguageSelect?.addEventListener("change", () => {
      const custom = els.selectionPreviewLanguageSelect?.value === "custom";
      els.selectionPreviewCustomLanguageInput?.classList.toggle("hidden", !custom);
      if (custom) els.selectionPreviewCustomLanguageInput?.focus?.();
    });
    els.selectionPreviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.selectionPreviewModal) closeSelectionPreviewModal(true);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && els.selectionPreviewModal && !els.selectionPreviewModal.classList.contains("hidden")) {
        closeSelectionPreviewModal(true);
      }
    });
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
  // tool_result 到达时切到"完成态"（打勾 + 简短小结）；错误留一行红色摘要。
  // 想看完整 JSON 详情 → 设置里勾「显示工具调用详情（开发者日志）」开关。
  //
  // 合并策略（#2）：连续同名 tool_call 复用同一个气泡，头部改成 "工具名 ×N"，
  // 不再刷屏。举例：AI 连调 5 次 et_write_range 铺表格 → 一个气泡带 "×5"。
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
    const countEl = document.createElement("span");
    countEl.className = "tool-transient-count hidden";
    const preview = document.createElement("span");
    preview.className = "tool-transient-preview";
    wrap.appendChild(spin);
    wrap.appendChild(nameEl);
    wrap.appendChild(countEl);
    wrap.appendChild(preview);
    wrap._spinTimer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      spin.textContent = FRAMES[frame];
    }, 80);
    wrap._toolName = name;
    wrap._callCount = 1;
    wrap._doneCount = 0;
    els.chatStream.appendChild(wrap);
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
    return wrap;
  }
  // 同名连调时不新建气泡，直接把 ×N 累加上去
  function bumpTransientToolBubble(bubble, previewStr) {
    if (!bubble) return null;
    bubble._callCount = (bubble._callCount || 1) + 1;
    const countEl = bubble.querySelector(".tool-transient-count");
    if (countEl) {
      countEl.textContent = ` ×${bubble._callCount}`;
      countEl.classList.remove("hidden");
    }
    // 重置转圈：上一个刚完成的 bubble 可能已经 stop 掉，这里重启
    if (!bubble._spinTimer) {
      const spin = bubble.querySelector(".tool-transient-spin");
      const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
      let frame = 0;
      if (spin) {
        spin.textContent = FRAMES[0];
        bubble._spinTimer = setInterval(() => {
          frame = (frame + 1) % FRAMES.length;
          spin.textContent = FRAMES[frame];
        }, 80);
      }
      bubble.classList.remove("done");
    }
    updateTransientToolBubble(bubble, previewStr);
    return bubble;
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
    // 成功 → 不再 remove，切"完成态"：打勾图标 + 短小结留在气泡里，视觉像 Claude Code /
    // Cursor 的 "✓ toolName (summary)"。用户能看到一步步做了啥又不占版面。
    bubble.classList.add("done");
    bubble._doneCount = bubble._callCount;
    const spin = bubble.querySelector(".tool-transient-spin");
    if (spin) spin.textContent = "✓";
    const preview = bubble.querySelector(".tool-transient-preview");
    if (preview && opts?.summary) preview.textContent = "‪" + oneLine(opts.summary) + "‬";
  }
  // 一轮对话结束时的汇总卡（#4）：本轮 AI 调了几个工具、成功/失败几个、总耗时。
  // 默认折叠成一条"AI 完成 · 用了 N 个工具 · X.Xs"，点开看所有工具流水。
  // 只在工具调用数 ≥ 2 时贴，一次调用不用汇总也能看清。
  function renderTurnSummary(turnEvents) {
    if (!els.chatStream || !Array.isArray(turnEvents)) return null;
    const toolCalls = turnEvents.filter((e) => e.type === "tool_call");
    const toolResults = turnEvents.filter((e) => e.type === "tool_result");
    if (toolCalls.length < 2) return null;
    const firstTs = turnEvents[0]?.ts || Date.now();
    const lastTs = turnEvents[turnEvents.length - 1]?.ts || Date.now();
    const elapsed = Math.max(0, lastTs - firstTs);
    const okCount = toolResults.filter((r) => r.result?.ok).length;
    const failCount = toolResults.filter((r) => !r.result?.ok).length;

    // 按工具名合并计数，输出到 body
    const byName = new Map();
    toolCalls.forEach((c) => byName.set(c.name, (byName.get(c.name) || 0) + 1));
    const bodyLines = [];
    for (const [n, c] of byName.entries()) {
      const label = friendlyToolName ? friendlyToolName(n) : n;
      bodyLines.push(`${c > 1 ? `×${c}  ` : "  "}${label}`);
    }

    const wrap = document.createElement("div");
    wrap.className = "chat-msg turn-summary collapsible";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-head";
    const iconSpan = document.createElement("span");
    iconSpan.className = "turn-summary-icon";
    iconSpan.textContent = failCount === 0 ? "✓" : "⚠";
    head.appendChild(iconSpan);
    const labelSpan = document.createElement("span");
    labelSpan.className = "chat-msg-label";
    const secs = elapsed < 60000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed / 60000)}m`;
    labelSpan.textContent = failCount === 0
      ? `本轮完成 · 用了 ${toolCalls.length} 个工具 · ${secs}`
      : `本轮完成 · ${okCount} 成功 / ${failCount} 失败 · ${secs}`;
    head.appendChild(labelSpan);
    const chev = document.createElement("span");
    chev.className = "tool-chevron";
    chev.textContent = "▶";
    head.appendChild(chev);
    const body = document.createElement("pre");
    body.className = "tool-body turn-summary-body";
    body.textContent = bodyLines.join("\n");
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

  // 从 tool_result value 里派生一条人话小结，用来当"完成态"的 preview
  function summarizeToolResult(name, result) {
    if (!result || !result.ok) return "";
    const v = result.value;
    // 常见几种：字符串直接用；对象带 count/summary/message 字段的用；否则序列化前 40 字
    if (typeof v === "string") return v.slice(0, 60);
    if (v && typeof v === "object") {
      if (typeof v.summary === "string") return v.summary.slice(0, 60);
      if (typeof v.message === "string") return v.message.slice(0, 60);
      if (typeof v.count === "number") return `已处理 ${v.count} 项`;
      if (Array.isArray(v)) return `${v.length} 项`;
    }
    return "";
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

  // ===== 自动重试：网络/5xx/429 等瞬时错误时透明重试，最多 5 次 =====
  const MAX_CHAT_RETRY_ATTEMPTS = 5;

  function isRetryableChatError(error) {
    if (!error) return false;
    if (error.name === "AbortError") return false;
    const msg = String(error?.message || error || "");
    const lower = msg.toLowerCase();
    if (/aborted/i.test(msg)) return false;
    // 4xx 权限/参数类错误不重试（用户得改配置才行）
    if (/请求失败[:：]\s*(400|401|403|404|422)\b/.test(msg)) return false;
    // 网络层
    if (/failed to fetch|networkerror|network error|net::|fetch.*fail|timeout|超时|连接(中断|失败|被|关闭|重置)|connection (lost|reset|refused|closed|aborted)/i.test(lower)) return true;
    // 5xx / 429 / Cloudflare 52x
    if (/请求失败[:：]\s*(429|5\d\d)\b/.test(msg)) return true;
    if (/\b(429|500|502|503|504|520|521|522|524)\b/.test(msg)) return true;
    return false;
  }

  function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      let onAbort;
      const timer = setTimeout(() => {
        try { signal?.removeEventListener?.("abort", onAbort); } catch (e) {}
        resolve();
      }, ms);
      onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      try { signal?.addEventListener?.("abort", onAbort, { once: true }); } catch (e) {}
    });
  }

  async function runChatTurn(userInput) {
    // 上一轮还没退出就强制中止，避免请求叠加
    if (currentAbortController) {
      try { currentAbortController.abort(); } catch (e) { /* ignore */ }
    }
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // 「未配置聊天模型」预检查：用户一条都没启用时，registry 会兜底到第一条（默认 Codex），
    // 然后 Codex 因为没 OAuth 抛"请先使用 ChatGPT OAuth 登录"——这条提示对真没配置的新用户
    // 极具误导性。提前自己探一下，给一条清晰的指引。
    try {
      const list = Array.isArray(currentSettings?.chatProviders) ? currentSettings.chatProviders : [];
      const enabledList = list.filter((p) => p?.enabled);
      const isProviderReady = (p) => {
        if (!p) return false;
        if (p.type === "codex") return !!global.WpsAiAuth?.isAuthenticated?.();
        return !!(p.baseUrl && p.apiKey);
      };
      const ready = enabledList.find(isProviderReady);
      if (!ready) {
        appendChatMsg("user", userInput, { label: "我" });
        let hint;
        if (enabledList.length === 0) {
          hint = "还没启用任何聊天模型。请打开右上角「设置 → 聊天模型」，选一家供应商（OpenAI / Claude / DeepSeek / Kimi / 通义 / ChatGPT OAuth 等任选其一），填好 Base URL + API Key 后**勾上「启用」**，再发消息。";
        } else {
          const reasons = enabledList.map((p) => {
            const name = p.label || p.id;
            if (p.type === "codex") return `「${name}」：还没用 ChatGPT 账号登录授权（在设置卡片里走 OAuth 4 步流程）`;
            if (!p.baseUrl && !p.apiKey) return `「${name}」：缺 Base URL 和 API Key`;
            if (!p.baseUrl) return `「${name}」：缺 Base URL`;
            if (!p.apiKey) return `「${name}」：缺 API Key`;
            return `「${name}」：配置不完整`;
          });
          hint = "已启用的聊天模型都还没配齐：\n\n" + reasons.map((r) => `- ${r}`).join("\n") + "\n\n请打开右上角「设置 → 聊天模型」补全任意一家。";
        }
        appendChatMsg("assistant", hint, { label: "AI", kind: "err" });
        return;
      }
    } catch (e) { /* 探测失败兜底走原路径，仍由 provider 抛具体错 */ }

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
            "当前文档尚未保存到磁盘（临时文档），AI 修改类操作会被拒绝。\n\n请先保存到磁盘后再聊（Windows/Linux 用 **Ctrl+S**，macOS 用 **⌘+S**）：所有改动会关联到该文件路径，方便备份与回滚。",
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
    setProgressState("thinking");
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
      // 注意：是否提及 UI/UX Pro Max 技能要看它真的是否启用，不能硬编码"已启用"误导 AI
      // 按那套大型设计指令走。skill 没启用时只给通用自由度提示。
      const uiuxSkillEnabled = !!global.WpsAiSkills?.isEnabled?.("builtin-ui-ux-pro-max");
      const pptFreeDesignNote = userSpecifiedPptStyle ? [
        "",
        "【PPT 设计自由度模式】",
        "用户本轮明确指定了视觉风格 —— 你应当**完全按用户提到的风格 / 颜色 / 调性**去设计幻灯片，跳出现有模板的死板布局：",
        "- freeform 布局优先（用 wpp_render_html_template 的 layout=freeform，自己写 html+css）",
        "- 配色、字体、装饰元素都按用户风格挑，**不要绑死本地 stylePreset 色板**",
        uiuxSkillEnabled
          ? "- 参考已启用的「UI/UX Pro Max 设计智能」技能：50+ 风格、161 色板、字体配对、99 UX 准则随手用"
          : "",
        "- 鼓励变化：封面、章节页、内容页**视觉差异要明显**，不要全部用同一个模板套",
        "- 字号映射仍按 1pt=2px (1920×1080 画布) 保持可读性",
        ""
      ].filter(Boolean).join("\n") : "";

      const systemPrompt = [
        "你是嵌入 WPS Office 的中文智能助理，可以通过工具直接读写当前打开的文档。",
        `当前宿主：${currentHostInfo.label}（${currentHostInfo.host}）。只调用与当前宿主匹配的工具。`,
        "决策原则：先用 read 类工具了解现状，再用 write/format 类工具修改。每一步告诉用户你做了什么。",
        currentHostInfo.host === "wps"
          ? "在 WPS 文字 写普通文本时优先使用 plain 文本；只有用户明确要求标题、列表等结构化格式时，才使用 markdown 渲染。AI 排版功能由专用预览弹窗处理，不要自行用 markdown 替换全文。"
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

      // 本轮开始时间 + 使用的模型 —— 供元信息角标（#3）用
      const turnStartedAt = Date.now();
      const turnModelName = String(model || "").trim();
      const attachMetaToBubble = (bubble) => {
        if (!bubble) return;
        // 已经有就不重复挂
        if (bubble.querySelector(".chat-msg-meta")) return;
        const meta = document.createElement("span");
        meta.className = "chat-msg-meta";
        const shortModel = turnModelName.replace(/^[a-z]+\//, "").slice(0, 24) || "AI";
        const elapsedMs = Date.now() - turnStartedAt;
        const secs = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
        meta.textContent = `${shortModel} · ${secs}`;
        meta.title = `模型：${turnModelName || "(未知)"}\n耗时：${secs}`;
        // 挂在 chat-msg-header 里就能借用现有布局；找不到 header 就直接挂 bubble 末尾
        const header = bubble.querySelector(".chat-msg-header");
        (header || bubble).appendChild(meta);
      };
      const updateStreamingBubble = (fullText) => {
        // 剥离内联 <think>：部分开源思考模型（DeepSeek R1 / Qwen QwQ / Kimi 等）会把
        // 思考过程作为 <think>...</think> 直接混在 assistant 正文里。之前我们没做
        // 任何处理，用户就在气泡里看到裸的 <think> 标签或思考本体。这里拆成两路：
        //   - <think> 内容 → 更新 reasoning 气泡（跟原生 reasoning_chunk 路径同一个 UI）
        //   - 剩余正文 → 放进 assistant 气泡
        // 只剥展示的这一层，turnEvents 里 assistant_text_end 事件仍然存原始 text，
        // 不影响历史记录 / 供应商侧的 messages 拼接。
        const { visible, think } = splitVisibleAndThinking(fullText);
        if (think) updateReasoningBubble(think);
        if (!visible) {
          // 目前只吐出了 <think>，还没进入正文 —— 不用建空气泡骚扰用户
          if (streamingBubble) {
            const body = streamingBubble.querySelector(".chat-msg-body");
            if (body) body.innerHTML = "";
            streamingBubble.dataset.copyText = "";
          }
          els.chatStream.scrollTop = els.chatStream.scrollHeight;
          return;
        }
        if (!streamingBubble) {
          streamingBubble = appendChatMsg("assistant", "", { label: "AI", html: "" });
        }
        const body = streamingBubble.querySelector(".chat-msg-body");
        if (body) {
          body.innerHTML = global.WpsAiMarkdown
            ? global.WpsAiMarkdown.renderToHtml(visible)
            : (visible || "").replace(/\n/g, "<br/>");
        }
        // 让"复制 AI 回复"按钮总是拿到最新的完整 markdown 文本（剥了 think 的干净版本）
        streamingBubble.dataset.copyText = visible;
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

      // 把 runWithTools 的事件处理抽出来，方便包到自动重试循环里
      let eventsFiredThisAttempt = false;
      const handleStreamEvent = async (ev) => {
        eventsFiredThisAttempt = true;
        switch (ev.type) {
          case "reasoning_chunk":
              // 推理模型的"思考过程"流式输出，单独一个气泡
              hideThinking();
              // 把最近的思考尾段拼到进度文字后面，类似 Claude Code 那种"…正在推理: 最后几个字"
              setProgressState("reasoning", `${(ev.fullText || "").length.toLocaleString()} 字符`);
              updateReasoningBubble(ev.fullText);
              lastReasoningText = ev.fullText || lastReasoningText;
              break;
            case "reasoning_end":
              // 思考结束（即将出正文或工具调用），把思考气泡折叠收起
              finalizeReasoningBubble();
              setProgressState("thinking");
              if (lastReasoningText) {
                turnEvents.push({ type: "reasoning", text: lastReasoningText, ts: Date.now() });
                lastReasoningText = "";
              }
              break;
            case "assistant_chunk":
              // 真正答复的第一个 token：移除 thinking，封掉思考气泡，创建答复气泡
              hideThinking();
              finalizeReasoningBubble();
              setProgressState("generating", `${(ev.fullText || "").length.toLocaleString()} 字符`);
              updateStreamingBubble(ev.fullText);
              break;
            case "assistant_text_end":
              if (ev.text) {
                assistantText = ev.text;
                turnEvents.push({ type: "assistant", text: ev.text, ts: Date.now() });
              }
              // 流式回复收尾：挂上元信息角标（模型 + 耗时），仅 hover 显示
              attachMetaToBubble(streamingBubble);
              streamingBubble = null;
              break;
            case "assistant_text":
              // 非流式 provider 兜底
              hideThinking();
              finalizeReasoningBubble();
              setProgressState("generating");
              if (ev.text) {
                assistantText = ev.text;
                const bubble = renderAssistantText(ev.text);
                attachMetaToBubble(bubble);
                turnEvents.push({ type: "assistant", text: ev.text, ts: Date.now() });
              }
              streamingBubble = null;
              break;
            case "tool_call":
              hideThinking();
              finalizeReasoningBubble();
              // 上一段流式 assistant 还在，但已经切到 tool_call —— 说明这段是"过渡话"，
              // 挂 inter-tool-filler class 让它折成细线
              if (streamingBubble) streamingBubble.classList.add("inter-tool-filler");
              streamingBubble = null;
              // 默认瞬态气泡；勾了"显示工具调用详情"才走老的折叠卡
              // generate_image 有专用 imageGenPanel 显示进度，不在聊天流里再叠瞬态气泡
              if (currentSettings.showToolCallLogs) {
                appendToolCallMsg(ev.name, ev.args);
              } else if (ev.name !== "generate_image") {
                // 合并：连续同名 tool_call 直接在原气泡上 ×N；否则新建
                const argsPreview = (() => { try { return JSON.stringify(ev.args); } catch (e) { return ""; } })();
                if (_activeTransientToolBubble && _activeTransientToolBubble._toolName === ev.name) {
                  bumpTransientToolBubble(_activeTransientToolBubble, argsPreview);
                } else {
                  // 不同工具：把上一个 finalize 到完成态（不 remove，作为"上一步"留在流里）
                  if (_activeTransientToolBubble) clearTransientToolBubble(_activeTransientToolBubble);
                  _activeTransientToolBubble = appendTransientToolBubble(ev.name);
                  try { updateTransientToolBubble(_activeTransientToolBubble, argsPreview); } catch (e) {}
                }
              }
              setProgressState("tool", friendlyToolName(ev.name));
              // 不再叠 showThinking("正在执行工具调用") —— 瞬态工具气泡 / imageGenPanel /
              // 头部进度条三处已经充分表达"AI 在执行工具"，再往 chat stream 塞个 dot-typing
              // 气泡纯属噪音（尤其连调 5+ 工具时一直闪）
              turnEvents.push({ type: "tool_call", name: ev.name, args: ev.args, ts: Date.now() });
              break;
            case "tool_result":
              hideThinking();
              if (currentSettings.showToolCallLogs) {
                appendToolResultMsg(ev.name, ev.result);
              } else if (ev.name !== "generate_image") {
                if (ev.result?.ok) {
                  // 成功 → 切"完成态"（打勾 + 简短小结留在流里）。下一个不同工具来时才 finalize
                  const summary = summarizeToolResult(ev.name, ev.result);
                  clearTransientToolBubble(_activeTransientToolBubble, summary ? { summary } : undefined);
                  // 完成态的气泡还可以被同名下一次合并，所以不清 _activeTransientToolBubble
                } else {
                  clearTransientToolBubble(_activeTransientToolBubble, {
                    errorSummary: (ev.result?.error || "执行失败").slice(0, 200)
                  });
                  _activeTransientToolBubble = null; // 错误态不再复用
                }
              }
              if (ev.name === "suggest_quick_actions" && ev.result?.ok) {
                renderSuggestedActions(ev.result.value?.actions || []);
              }
              setProgressState("thinking", `刚完成 ${friendlyToolName(ev.name)}`);
              // 之前这里 showThinking("AI 正在思考") 会在 chat stream 尾巴插一个 dot-typing 气泡，
              // 下一个 tool_call / assistant_chunk 立刻 hide —— 多工具连调时闪成噪音。
              // 头部进度条已经清楚表达"◆ 思考中 · 刚完成 xxx"，chat stream 不用再叠。
              // 如果下一个事件迟迟不来（罕见），400ms 后再补上气泡，避免"AI 是不是死了"的错觉。
              scheduleDelayedThinking();
              turnEvents.push({ type: "tool_result", name: ev.name, result: ev.result, ts: Date.now() });
              break;
            case "done":
              hideThinking();
              finalizeReasoningBubble();
              streamingBubble = null;
              // 一轮对话结束：如果本轮有 2+ 工具调用，补一张折叠汇总卡贴末尾
              renderTurnSummary(turnEvents);
              _activeTransientToolBubble = null;
              setProgressState("done");
              // 半秒后清空进度条文字（避免"完成"一直停在上面），进度条本体由 setChatBusy 收
              setTimeout(() => { setProgressStatus(null); }, 500);
              break;
        }
      };

      // 包一层重试：网络/5xx/429 等瞬时错误时透明重试，最多 MAX_CHAT_RETRY_ATTEMPTS 次。
      // 一旦已经触发过任何流式事件（assistant_chunk / tool_call / …），说明响应已经在路上，
      // 重试会让 UI 出现重复/错位，这种情况下直接抛出让上层处理，不重试。
      let lastChatError = null;
      let chatAttempts = 0;
      for (let attempt = 1; attempt <= MAX_CHAT_RETRY_ATTEMPTS; attempt += 1) {
        chatAttempts = attempt;
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        eventsFiredThisAttempt = false;
        try {
          await global.WpsAiOpenAI.runWithTools({
            model,
            messages,
            tools,
            signal,
            thinkingLevel,
            maxIterations: currentSettings?.maxToolIterations || 50,
            approveTool: approver || undefined,
            onEvent: handleStreamEvent
          });
          lastChatError = null;
          break;
        } catch (e) {
          lastChatError = e;
          if (e?.name === "AbortError") throw e;
          if (eventsFiredThisAttempt || !isRetryableChatError(e)) throw e;
          if (attempt >= MAX_CHAT_RETRY_ATTEMPTS) {
            throw new Error(`连续重试 ${MAX_CHAT_RETRY_ATTEMPTS} 次仍失败：${e?.message || e}`);
          }
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          const seconds = Math.max(1, Math.round(delay / 1000));
          const reasonText = String(e?.message || e || "").slice(0, 80);
          showMessage(`AI 请求失败（${reasonText}），${seconds}s 后自动重试 (${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS})…`, "info", { duration: Math.max(delay, 3000) });
          setProgressState("retrying", `第 ${attempt + 1}/${MAX_CHAT_RETRY_ATTEMPTS} 次`);
          await sleepWithSignal(delay, signal);
          setProgressState("thinking");
        }
      }

      if (chatAttempts > 1 && !lastChatError) {
        showMessage(`第 ${chatAttempts} 次重试成功。`, "success");
      }

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
      // 写回 conversations。currentId 为空时 lazy createNew，带上当前 docKey
      // 让新对话挂到正确的文件下（docWatcher 在切文件时会先 clearCurrent）
      try {
        const Conv = global.WpsAiConversations;
        if (Conv) {
          if (!Conv.getCurrentId?.()) {
            Conv.createNew?.({ docKey: getCurrentDocKey() });
          }
          Conv.syncMessages?.(chatHistory);
          Conv.appendTurnEvents?.(turnEvents);
        }
      } catch (e) {}
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
      // 重新渲染卡片：让默认模型 input 的 datalist 同步到最新模型列表，用户可以直接下拉选
      try { renderChatProvidersList(); } catch (e) {}
      const preview = models.slice(0, 5).join(" / ") + (models.length > 5 ? ` … (+${models.length - 5})` : "");
      showMessage(`供应商「${label}」连通正常，返回 ${models.length} 个模型：${preview}。点「默认模型」输入框可下拉选择。`, "success", { duration: 6000 });
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

  // ---------------- Settings import / export ----------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  // ----- 配置导出/导入版本管理 + 敏感字段加密 -----
  //
  // 版本规则：每次"配置字段结构发生不兼容变化"才升大版本号；只是加新字段、改默认值算
  // 向后兼容。当前版本：
  const CONFIG_VERSION = "2.0";

  // 敏感字段（导出时加密、导入时解密）。路径以 "." 分隔
  // 路径里允许 "*" 段，表示"该层是个数组/对象，对所有子项应用"
  const SENSITIVE_PATHS = [
    "providers.openai.apiKey",
    "providers.anthropic.apiKey",
    "imageProvider.apiKey",      // 老版兼容
    "imageProvider.codexApiKey", // 老版兼容
    "imageProviders.*.apiKey",   // 新版多渠道
    "chatProviders.*.apiKey"     // 顺手把 chat 多渠道也覆盖（之前漏了）
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
    SENSITIVE_PATHS.forEach((path) => applyPath(out, path.split("."), transform));
    return out;
  }

  // 递归走 path 各段。遇到 "*" 段就 fan-out 到当前层全部子项（数组或对象都支持）。
  // 终止条件：parts 走完，对每个被命中的叶子值跑 transform。
  function applyPath(node, parts, transform) {
    if (!parts.length) return;
    const [head, ...rest] = parts;
    if (head === "*") {
      if (Array.isArray(node)) {
        node.forEach((child) => applyPath(child, rest, transform));
      } else if (node && typeof node === "object") {
        Object.values(node).forEach((child) => applyPath(child, rest, transform));
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (rest.length === 0) {
      if (node[head]) node[head] = transform(node[head]);
    } else {
      applyPath(node[head], rest, transform);
    }
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
  // 开发者工具：dev 模式检测 + 两个日志按钮
  //   - 导出预览日志：把 __lingxiDumpLogs 的内容当 txt 下载
  //   - 清空预览日志：__lingxiClearLogs
  // （「打开 JS 调试器」按钮已移除：dev 模式下用 WPS 自带 ribbon 按钮 / 右键菜单更可靠；
  //  生产包默认不带 enable_dev / debug，本就拿不到 DevTools 子系统）
  // ============================================================
  // dev 模式 ↔ 生产模式无法靠 URL 区分（生产安装也走 http://127.0.0.1:3889/wpp/...，
  // 跟 wpsjs debug 撞），改成问 proxy 的 /install-path 拿权威结果 —— 它知道自己是
  // 跟着 build-variants 产出的 plugin-<host>/ 跑（=生产），还是源码目录直接跑（=dev）。
  //
  // 同步路径只用作"显式 dev 信号"的快速通道：?dev=1 / file:// / window.__lingxiForceDevMode。
  // 其它走异步 proxy 查询，结果只用于显示开发者工具区。
  function quickDevSignal() {
    try {
      if (/[?&]dev=1\b/i.test(window.location.search)) return true;
      if (window.location.protocol === "file:") return true;
    } catch (e) {}
    if (window.__lingxiForceDevMode === true) return true;
    return false;
  }

  function setupDevToolsSection() {
    const section = els.devToolsSection;
    if (!section) return;
    // 默认隐藏，proxy 确认是 dev 模式才显示（fail-safe：proxy 不通时也隐藏，
    // 避免生产用户看到开发者工具）
    section.classList.add("hidden");
    const showDevTools = () => {
      section.classList.remove("hidden");
      if (els.devModeBadge) {
        const host = window.location.hostname || "";
        const port = window.location.port || "";
        els.devModeBadge.textContent = (host && port) ? `${host}:${port}` : "dev";
      }
      bindDevToolsButtons();
    };
    if (quickDevSignal()) {
      showDevTools();
      return;
    }
    // 异步问 proxy
    fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/install-path", { method: "GET" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.ok && data.mode === "dev") showDevTools(); })
      .catch(() => { /* proxy 不通 → 保持隐藏 */ });
  }

  // 开发者工具区里所有按钮的事件绑定 —— 从 setupDevToolsSection 抽出来，
  // 只在确认是 dev 模式时才调一次（避免生产模式重复绑/资源浪费）
  function bindDevToolsButtons() {
    // 脚本版本徽章：直接显示当前 app.js 的 SCRIPT_VERSION，方便用户重载后一眼确认是不是新代码
    if (els.devScriptVersionBadge) {
      els.devScriptVersionBadge.textContent = `脚本版本: ${SCRIPT_VERSION}`;
      els.devScriptVersionBadge.title = `当前加载的 app.js 版本：${SCRIPT_VERSION}\n重载插件后看这里能立刻确认新代码已生效。`;
    }
    // 「查看日志」：弹窗显示 localStorage 里的全部预览日志，支持过滤 / 仅 WARN / 复制 / 刷新
    els.viewPreviewLogsBtn?.addEventListener("click", () => {
      openDevLogViewer();
    });
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
      try {
        window.__lingxiClearLogs?.();
        showMessage("日志已清空。", "success");
        // 弹窗如果开着，顺手刷新
        if (els.devLogViewerModal && !els.devLogViewerModal.classList.contains("hidden")) {
          renderDevLogViewer();
        }
      } catch (e) { showMessage(`清空失败：${e?.message || e}`, "error"); }
    });
    // ====== 日志查看弹窗的事件 ======
    els.devLogViewerCloseBtn?.addEventListener("click", () => {
      els.devLogViewerModal?.classList.add("hidden");
    });
    els.devLogViewerRefreshBtn?.addEventListener("click", () => renderDevLogViewer());
    els.devLogViewerCopyBtn?.addEventListener("click", async () => {
      const text = els.devLogViewerOutput?.textContent || "";
      if (!text) { showMessage("当前没有可复制的内容。", "info"); return; }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          showMessage(`已复制 ${text.length} 字符。`, "success");
        } else {
          // 回退：选中 + execCommand
          const pre = els.devLogViewerOutput;
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand("copy");
          sel.removeAllRanges();
          showMessage(`已复制 ${text.length} 字符。`, "success");
        }
      } catch (e) { showMessage(`复制失败：${e?.message || e}`, "error"); }
    });
    els.devLogViewerScrollBottomBtn?.addEventListener("click", () => {
      if (els.devLogViewerOutput) els.devLogViewerOutput.scrollTop = els.devLogViewerOutput.scrollHeight;
    });
    // 过滤是即时的，input / change 都触发重渲
    els.devLogViewerFilter?.addEventListener("input", () => renderDevLogViewer({ keepScroll: true }));
    els.devLogViewerWarnOnly?.addEventListener("change", () => renderDevLogViewer({ keepScroll: true }));
    // ESC 关闭弹窗
    els.devLogViewerModal?.addEventListener("click", (ev) => {
      // 点击遮罩（不是内部 modal-card）关闭
      if (ev.target === els.devLogViewerModal) els.devLogViewerModal.classList.add("hidden");
    });
  }

  function openDevLogViewer() {
    if (!els.devLogViewerModal) return;
    els.devLogViewerModal.classList.remove("hidden");
    renderDevLogViewer();
    // 默认滚到底，看最新的几条
    setTimeout(() => {
      if (els.devLogViewerOutput) els.devLogViewerOutput.scrollTop = els.devLogViewerOutput.scrollHeight;
    }, 0);
  }

  // 从 localStorage 拉日志 → 过滤 → 渲染到 pre 里。filter 关键词不区分大小写；warnOnly 只留 WARN。
  function renderDevLogViewer(opts) {
    opts = opts || {};
    const pre = els.devLogViewerOutput;
    const stats = els.devLogViewerStats;
    if (!pre) return;
    const prevScroll = opts.keepScroll ? pre.scrollTop : null;
    let list = [];
    try {
      const raw = localStorage.getItem(PREVIEW_LOG_KEY);
      if (raw) list = JSON.parse(raw) || [];
    } catch (e) { /* 解析失败当空 */ }
    const total = list.length;
    const kwRaw = String(els.devLogViewerFilter?.value || "").trim().toLowerCase();
    const warnOnly = !!els.devLogViewerWarnOnly?.checked;
    let filtered = list;
    if (warnOnly) filtered = filtered.filter((e) => e.level === "WARN");
    if (kwRaw) {
      filtered = filtered.filter((e) => {
        const hay = `[${e.level}][${e.where}][${e.tag}] ${e.msg || ""}`.toLowerCase();
        return hay.includes(kwRaw);
      });
    }
    const text = filtered.map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 23);
      return `${t} [${e.level}][${e.where}][${e.tag}] ${e.msg}`;
    }).join("\n");
    pre.textContent = text || "(无匹配日志)";
    if (stats) {
      stats.textContent = filtered.length === total
        ? `${total} 条`
        : `${filtered.length} / ${total} 条`;
    }
    if (prevScroll != null) pre.scrollTop = prevScroll;
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
    // 新版多渠道：直接覆盖整个数组（与 chatProviders 一致）。
    if (Array.isArray(settingsToApply.imageProviders) && settingsToApply.imageProviders.length > 0) {
      cloned.imageProviders = settingsToApply.imageProviders.map((p) => Object.assign({}, p));
    } else if (settingsToApply.imageProvider && typeof settingsToApply.imageProvider === "object") {
      // 老版导出文件兼容：保留老字段，由 loadSettings 下次解析时迁移到 imageProviders
      cloned.imageProvider = Object.assign({}, cloned.imageProvider, settingsToApply.imageProvider);
    }
    if (settingsToApply.stylePreset && typeof settingsToApply.stylePreset === "object") {
      cloned.stylePreset = Object.assign({}, cloned.stylePreset, settingsToApply.stylePreset);
    }

    currentSettings = cloned;
    persistSettings();
    // 走一遍 loadSettings 触发老 imageProvider → imageProviders 迁移（同样适用于 chatProviders）
    currentSettings = global.WpsAiProviderRegistry.loadSettings();
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
    renderThemeGrid();
    updateSchemePreview(els.styleScheme.value);
    updateLivePreview();
    els.stylePresetModal.classList.remove("hidden");
  }

  // 主题网格：把全部 COLOR_SCHEMES 渲染成迷你幻灯片卡，替代 40+ 项 <select>。
  // 每张卡用主题自己的 background/primary/accent/title/body 颜色画一张缩略图，
  // 用户一眼能看出"这套配出来什么调"。点卡 = 选中 + applyColorScheme + 高亮。
  function renderThemeGrid() {
    const host = els.styleThemeGrid;
    if (!host) return;
    const fullSchemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const currentName = els.styleScheme?.value || "custom";
    host.innerHTML = "";

    // "自定义" 卡放第一位 —— 用 dashed 边框示意"无预设"
    const customCard = document.createElement("button");
    customCard.type = "button";
    customCard.className = "theme-card theme-card-custom" + (currentName === "custom" ? " selected" : "");
    customCard.dataset.scheme = "custom";
    customCard.setAttribute("role", "option");
    customCard.setAttribute("aria-selected", currentName === "custom" ? "true" : "false");
    customCard.innerHTML = `
      <div class="theme-card-thumb theme-card-thumb-custom">
        <span class="theme-card-thumb-glyph">＋</span>
      </div>
      <div class="theme-card-label">自定义</div>
      <div class="theme-card-desc">从字体/配色微调开始</div>
    `;
    customCard.addEventListener("click", () => selectScheme("custom"));
    host.appendChild(customCard);

    // 各内置主题卡
    Object.entries(fullSchemes).forEach(([name, s]) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "theme-card" + (currentName === name ? " selected" : "");
      if (s.darkMode) card.classList.add("theme-card-dark");
      card.dataset.scheme = name;
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", currentName === name ? "true" : "false");
      // 迷你幻灯片缩略图：背景 = backgroundColor；顶部装饰条 = primary；
      // 大字 "Aa" = titleColor + titleFont；副条 = accent；小色块 = secondary/surface
      card.innerHTML = `
        <div class="theme-card-thumb" style="background:${escapeAttr(s.backgroundColor || "#fff")}">
          <div class="theme-card-thumb-bar" style="background:${escapeAttr(s.primaryColor || "#000")}"></div>
          <div class="theme-card-thumb-title" style="color:${escapeAttr(s.titleColor || "#000")};font-family:${escapeAttr(s.titleFont || "sans-serif")}">Aa</div>
          <div class="theme-card-thumb-body" style="color:${escapeAttr(s.bodyColor || "#666")};font-family:${escapeAttr(s.bodyFont || "sans-serif")}">Lingxi</div>
          <div class="theme-card-thumb-accent" style="background:${escapeAttr(s.accentColor || "#f80")}"></div>
          <div class="theme-card-thumb-swatches">
            <span style="background:${escapeAttr(s.secondaryColor || "transparent")}"></span>
            <span style="background:${escapeAttr(s.surfaceColor || "transparent")}"></span>
          </div>
        </div>
        <div class="theme-card-label">${escapeHtml(s.label || name)}</div>
        <div class="theme-card-desc">${escapeHtml((s.description || "").split("·").pop().trim())}</div>
      `;
      card.title = `${s.label || name}\n${s.description || ""}`;
      card.addEventListener("click", () => selectScheme(name));
      host.appendChild(card);
    });
  }

  // 点主题卡 = 选中 + 把该主题的颜色字段写回表单 + 刷新高亮和预览
  function selectScheme(name) {
    els.styleScheme.value = name;
    if (name !== "custom") applyColorScheme(name);
    // 高亮切换
    els.styleThemeGrid?.querySelectorAll(".theme-card").forEach((c) => {
      const sel = c.dataset.scheme === name;
      c.classList.toggle("selected", sel);
      c.setAttribute("aria-selected", sel ? "true" : "false");
    });
    updateSchemePreview(name);
    updateLivePreview();
  }

  // 实时预览：把当前所有颜色/字体写到顶部那个迷你幻灯片上。
  // 任何字段改动都要调一次。
  function updateLivePreview() {
    const slide = els.styleLivePreview?.querySelector(".style-live-slide");
    if (!slide) return;
    const titleEl = slide.querySelector(".style-live-title");
    const bodyEl = slide.querySelector(".style-live-body");
    const accentEl = slide.querySelector(".style-live-accent");
    const chipEl = slide.querySelector(".style-live-chip");
    const bg = els.styleBackgroundColor.value || "#fff";
    const surface = els.styleSurfaceColor.value || "#f5f7fa";
    const primary = els.stylePrimaryColor.value || "#1f3a5f";
    const accent = els.styleAccentColor.value || "#ee6c4d";
    const titleColor = els.styleTitleColor.value || "#1f2329";
    const bodyColor = els.styleBodyColor.value || "#33363c";
    const titleFont = els.styleTitleFont.value || "Microsoft YaHei";
    const bodyFont = els.styleBodyFont.value || "Microsoft YaHei";
    const titleSize = Math.max(8, Math.min(96, parseInt(els.styleTitleSize.value, 10) || 32));
    const bodySize = Math.max(8, Math.min(72, parseInt(els.styleBodySize.value, 10) || 18));
    const titleBold = els.styleTitleBold.checked;

    slide.style.background = bg;
    slide.style.borderColor = primary + "30";
    if (accentEl) accentEl.style.background = primary;
    if (titleEl) {
      titleEl.style.color = titleColor;
      titleEl.style.fontFamily = titleFont;
      // 预览块高度有限，标题字号按比例缩到 1/2，保证大字号也能完整显示
      titleEl.style.fontSize = Math.round(titleSize * 0.55) + "px";
      titleEl.style.fontWeight = titleBold ? "700" : "500";
    }
    if (bodyEl) {
      bodyEl.style.color = bodyColor;
      bodyEl.style.fontFamily = bodyFont;
      bodyEl.style.fontSize = Math.round(bodySize * 0.7) + "px";
    }
    if (chipEl) {
      chipEl.style.background = accent;
      chipEl.style.borderColor = surface;
    }
    if (els.styleLiveMeta) {
      els.styleLiveMeta.textContent = `${titleFont} ${titleSize}pt / ${bodyFont} ${bodySize}pt`;
    }
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
  // 同时更新主题网格选中态 + 实时预览块
  function markCustomScheme() {
    els.styleScheme.value = "custom";
    updateSchemePreview("custom");
    els.styleThemeGrid?.querySelectorAll(".theme-card").forEach((c) => {
      const sel = c.dataset.scheme === "custom";
      c.classList.toggle("selected", sel);
      c.setAttribute("aria-selected", sel ? "true" : "false");
    });
    updateLivePreview();
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

    const imageGenOn = (currentSettings?.imageProviders || []).some((p) => p && p.enabled);

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
    const imageGenOn = (currentSettings?.imageProviders || []).some((p) => p && p.enabled);
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

  // 从 turn 自带 prompt 和实际执行的 entries 派生一个紧凑标题。
  // - chat 流的 prompt 通常是用户原句（可能很长）；ribbon 流是 turnLabel（已经短）
  // - entries 里能拿到 FRIENDLY_NAMES 映射的工具名，比 prompt 更能反映"AI 做了什么"
  // 策略：短 prompt 直接用；长 prompt 或空 prompt 时改用工具友好名拼出来
  function deriveTurnTitle(turn, entries) {
    const history = global.WpsAiHistory;
    const friendly = (toolName) =>
      history?.getFriendlyName?.(toolName) || toolName || "未知操作";
    const promptRaw = (turn?.prompt || "").trim();

    // 1) prompt 短且看着像人工写的标题（≤ 30 字）→ 直接用
    if (promptRaw && promptRaw.length <= 30) return promptRaw;

    // 2) 有 entries → 用工具友好名归并
    if (entries && entries.length > 0) {
      const names = entries.map((e) => friendly(e.toolName));
      const unique = [];
      const seen = new Set();
      names.forEach((n) => { if (!seen.has(n)) { seen.add(n); unique.push(n); } });
      if (unique.length === 1) {
        return entries.length === 1 ? unique[0] : `${unique[0]} ×${entries.length}`;
      }
      if (unique.length <= 3) return unique.join(" · ");
      return `${unique.slice(0, 2).join(" · ")} 等 ${unique.length} 项`;
    }

    // 3) 兜底：把长 prompt 截断
    if (promptRaw) return promptRaw.slice(0, 36) + "…";
    return "（无提示）";
  }

  function renderTurnGroup(turn, entries) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-turn";

    const head = document.createElement("div");
    head.className = "history-turn-head";
    const title = deriveTurnTitle(turn, entries);
    const promptText = escapeHtml(title);
    // 原始 prompt 不同于派生 title 时挂 tooltip，方便用户回看上下文
    const promptTooltip = (turn?.prompt && turn.prompt.trim() !== title)
      ? escapeHtml(turn.prompt) : "";
    const startedAt = turn?.startedAt ? fmtTime(turn.startedAt) : "";
    const restored = !!turn?.restoredAt;
    // 已恢复过的 turn 不再展示"恢复"按钮：再点一次没意义（备份文件已被回滚消费），还会让用户误以为能反复来
    const backupOk = turn?.backup && turn.backup.backupPath && !restored;
    const backupErr = turn?.backup && turn.backup.error;
    const restoredBadge = restored
      ? `<span class="history-turn-restored" title="已于 ${fmtTime(turn.restoredAt)} 回滚到本轮开始前的状态">已恢复 · ${fmtTime(turn.restoredAt)}</span>`
      : "";
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
        <span class="history-turn-prompt"${promptTooltip ? ` title="${promptTooltip}"` : ""}>${promptText}</span>
        <span class="history-turn-time">${startedAt}</span>
      </div>
      <div class="history-turn-actions">
        ${restoredBadge}
        ${backupStatus}
        ${backupOk ? `<button type="button" class="ghost-btn history-restore-btn">${iconRestore} 恢复本轮</button>` : ""}
      </div>
    `;
    if (restored) wrapper.classList.add("restored");
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

          // 算 undoSteps：本 turn 在按时间倒序排的"还能撤"的 turn 列表里排第几（0 = 最新）。
          // 排位 + 1 即需要 Application.Undo 几次才能跨过中间的 AI turn 回到本 turn 之前。
          // 这样老 turn 也能走免关文档的 Undo 路径，不再强制走文件层（关闭+重开）。
          // 已被 markTurnRestored 过的 turn 不计入（它们的改动已经被回滚，undo 栈里没东西要走）。
          let undoSteps = 0;
          try {
            const allTurns = global.WpsAiHistory?.listTurns?.() || {};
            const backedUp = Object.values(allTurns)
              .filter((t) => t.backup?.backupPath && t.backup.undoGroup && !t.restoredAt)
              .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
            const idx = backedUp.findIndex((t) => t.id === turn.id);
            undoSteps = idx >= 0 ? idx + 1 : (turn.backup.undoGroup ? 1 : 0);
          } catch (e) { undoSteps = turn.backup.undoGroup ? 1 : 0; }

          const tryUndo = undoSteps > 0;
          const res = await backup.restoreFromBackup(turn.backup.backupPath, turn.backup.docPath, { tryUndo, undoSteps });
          if (res?.ok) {
            let via = "";
            if (res.method === "undo") {
              via = res.undoneCount > 1 ? `(免关文档，撤销 ${res.undoneCount} 步)` : "(免关文档)";
            } else if (res.method === "file") {
              via = "(已重开文档)";
            }
            showMessage(`已恢复到 ${fmtTime(turn.backup.ts)} 的状态 ${via}。${res.warning || ""}`, "success");
            // 级联标记：本 turn 以及所有比它新的 turn 都标为"已恢复"。
            // 原因：多步 Undo / 文件还原都会把 target 之后的全部 AI 改动一并清掉
            // —— 那些 turn 的 backup 已经"对不上"现在的文档状态了，按钮再让点会乱
            // （只标 target 的话，比如撤回 B 后再点 C，会反过来把 A 的 group 撤了）。
            try {
              const allTurns = global.WpsAiHistory?.listTurns?.() || {};
              const cascade = Object.values(allTurns)
                .filter((t) => t.id && !t.restoredAt && (t.startedAt || 0) >= (turn.startedAt || 0));
              cascade.forEach((t) => global.WpsAiHistory?.markTurnRestored?.(t.id));
              // 兜底：万一上面 filter 没把 target 圈进去（缺 startedAt 之类），再补一次
              if (!cascade.some((t) => t.id === turn.id)) {
                global.WpsAiHistory?.markTurnRestored?.(turn.id);
              }
            } catch (e) {
              global.WpsAiHistory?.markTurnRestored?.(turn.id);
            }
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

    // turn 下的 entry 默认折叠：用户视角下一次"对话"是一次操作，不需要把 AI 内部
    // 的每个工具调用都铺开（5 行历史看起来像 5 次操作，造成 badge 数和"做的事"对不上）。
    // 点击 turn head 才展开看详细工具调用流；保留 entry 详情入口，不删功能。
    const sorted = entries.slice().sort((a, b) => a.ts - b.ts);
    const list = document.createElement("div");
    list.className = "history-turn-entries hidden";
    sorted.forEach((e) => list.appendChild(renderHistoryEntry(e)));
    wrapper.appendChild(list);

    // turn 标题角加个折叠角标（展开 / 收起）+ 子条目数
    const entryCountBadge = document.createElement("span");
    entryCountBadge.className = "history-turn-count";
    entryCountBadge.textContent = `${sorted.length} 步`;
    entryCountBadge.title = `本次对话中 AI 调了 ${sorted.length} 次写入型工具，点击展开`;
    head.querySelector(".history-turn-meta")?.appendChild(entryCountBadge);
    head.addEventListener("click", (ev) => {
      // 避开操作按钮的 hover 区
      if (ev.target?.closest?.(".history-turn-actions")) return;
      list.classList.toggle("hidden");
      wrapper.classList.toggle("expanded");
    });
    head.style.cursor = "pointer";

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

    // 当前文档身份（docId 优先，跨重命名 / Save As 稳定；docPath 兜底）
    const docKey = global.WpsAiBackup?.getCurrentDocKey?.() || { docId: null, docPath: null };
    const currentDocId = docKey.docId;
    const currentDocPath = docKey.docPath;
    const hasCurrentDoc = !!(currentDocId || currentDocPath);
    const filtered = hasCurrentDoc
      ? history.listEntries({ docId: currentDocId, docPath: currentDocPath })
      : [];
    const allEntries = history.listEntries();
    const turns = history.listTurns?.() || {};

    // 计数从"entry 条数"改为"turn 组数"——用户视角下一次对话是一次操作，
    // AI 内部连调几个工具不该被算成几次"改动"。
    // 之前 badge=3 但用户只觉得做了 2 次对话，就是因为某个 turn 内 AI 调了 2 个工具。
    const totalN = allEntries.length;
    const shownN = filtered.length;
    const countTurns = (list) => {
      const set = new Set();
      list.forEach((e) => set.add(e.turnId || "_loose:" + e.id));
      return set.size;
    };
    const totalTurns = countTurns(allEntries);
    const shownTurns = countTurns(filtered);

    if (els.historyCount) {
      els.historyCount.textContent = hasCurrentDoc
        ? (totalTurns === shownTurns ? `共 ${shownTurns} 轮（${shownN} 步）` : `当前文档 ${shownTurns} 轮（${shownN} 步） / 全部 ${totalTurns} 轮（${totalN} 步）`)
        : `共 ${totalTurns} 轮（${totalN} 步）`;
    }
    if (els.historyBadge) {
      const showCount = hasCurrentDoc ? shownTurns : totalTurns;
      els.historyBadge.textContent = showCount > 99 ? "99+" : String(showCount);
      els.historyBadge.classList.toggle("hidden", showCount === 0);
    }
    // 顶部文件信息条：当前文档有身份（path 或 id）才显示
    if (els.historyDocBar && els.historyDocName) {
      if (hasCurrentDoc) {
        const fname = currentDocPath ? currentDocPath.split(/[/\\]/).pop() : `(文档 ${currentDocId.slice(0, 8)}…)`;
        els.historyDocName.textContent = fname;
        // tooltip 里同时展示 path + 短 id，让高级用户能看出走的是 id 还是 path
        const tip = [];
        if (currentDocPath) tip.push(currentDocPath);
        if (currentDocId) tip.push(`docId: ${currentDocId}`);
        els.historyDocName.title = tip.join("\n");
        els.historyDocBar.classList.remove("hidden");
      } else {
        els.historyDocBar.classList.add("hidden");
      }
    }

    if (els.historyEmpty) {
      els.historyEmpty.classList.toggle("hidden", shownN > 0);
      // 空态文案根据是否有当前文档变
      if (!hasCurrentDoc) {
        els.historyEmpty.innerHTML = `
          <p><strong>当前文档尚未保存到磁盘</strong></p>
          <p class="muted">改动记录按文档身份（UUID，跨重命名 / Save As 稳定）分组保存；未保存时暂时按文件路径分组。请先保存文档（Windows/Linux 用 Ctrl+S，macOS 用 ⌘+S），AI 的操作就会关联到这个具体文档。</p>
        `;
      } else if (shownN === 0) {
        const fname = currentDocPath ? currentDocPath.split(/[/\\]/).pop() : `文档 ${currentDocId.slice(0, 8)}…`;
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
    if (!hasCurrentDoc || shownN === 0) return;

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

  // ---------------- 生图素材库 ----------------

  const materialPreviewCache = new Map();
  const MATERIAL_ALL_GROUP_ID = "all";
  const MATERIAL_DEFAULT_GROUP_ID = "default";
  let activeMaterialGroupId = MATERIAL_ALL_GROUP_ID;
  let selectedMaterialIds = new Set();
  let materialLibraryBound = false;
  let materialDialogPollTimer = null;
  let materialPreviewItemId = null;

  const MATERIAL_PREVIEW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>';

  function materialPreviewButtonHtml() {
    return `<button class="material-preview-trigger" data-role="preview" type="button" title="放大预览" aria-label="放大预览">${MATERIAL_PREVIEW_ICON}</button>`;
  }

  function materialDisplayUrl(item) {
    return item?.dataUrl || item?.url || "";
  }

  function materialFileName(item) {
    const raw = item?.url || item?.dataUrl || "";
    if (!raw) return "生成图片";
    const dataUrlMatch = raw.match(/^data:image\/([^;]+);/i);
    if (dataUrlMatch) {
      const ext = dataUrlMatch[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
      return `生成图片.${ext || "png"}`;
    }
    try {
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "生成图片");
      }
    } catch (e) {}
    return String(raw).split(/[/\\]/).pop() || "生成图片";
  }

  function materialGroupId(item) {
    return item?.groupId || MATERIAL_DEFAULT_GROUP_ID;
  }

  function materialCanPreviewDirect(url) {
    return /^data:image\//i.test(url) || /^https?:\/\//i.test(url) || /^file:\/\//i.test(url) || /^\.\//.test(url);
  }

  async function ensureMaterialPreview(item) {
    const raw = materialDisplayUrl(item);
    if (!raw) return "";
    if (item.dataUrl || materialCanPreviewDirect(raw)) return raw;
    if (materialPreviewCache.has(raw)) return materialPreviewCache.get(raw);
    try {
      const resp = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/load-local-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: raw })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(payload.error || `load-local-file ${resp.status}`);
      const dataUrl = `data:${payload.mediaType || "image/png"};base64,${payload.base64}`;
      materialPreviewCache.set(raw, dataUrl);
      return dataUrl;
    } catch (e) {
      return "";
    }
  }

  function openMaterialLibraryModal() {
    if (!global.WpsAiMaterialLibrary) {
      showMessage("素材库模块未加载。", "error");
      return;
    }
    renderMaterialLibrary();
    els.materialLibraryModal?.classList.remove("hidden");
  }

  function closeMaterialLibraryModal() {
    if (isMaterialsDialog) {
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.materialLibraryModal?.classList.add("hidden");
  }

  function openMaterialLibraryAsDialog() {
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=materials`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        rememberWriterInsertionRange();
        const { w, h } = pickDialogSize(1040, 760, { minW: 760, minH: 560 });
        app.ShowDialog(url, "灵犀AI 素材库", w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        consumeMaterialDialogRequests();
        startMaterialDialogRequestPolling();
        return;
      }
    } catch (e) {
      console.warn("[materials] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    openMaterialLibraryModal();
  }

  function materialMetaText(item) {
    const parts = [];
    if (item.size) parts.push(item.size);
    if (item.resolution) parts.push(item.resolution);
    if (item.model) parts.push(item.model);
    if (item.ts) parts.push(fmtTime(item.ts));
    return parts.join(" · ") || "生成图片";
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rememberWriterInsertionRange() {
    try {
      const app = global.WpsAiAddon?.getApplicationSync?.();
      const range = app?.Selection?.Range;
      if (!range) return;
      const start = Number(range.Start);
      const end = Number(range.End);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      global.WpsAiWriterInsertionRangeHint = { start, end, ts: Date.now() };
      try { localStorage.setItem("lingxi_writer_insertion_range_hint_v1", JSON.stringify(global.WpsAiWriterInsertionRangeHint)); } catch (e) {}
    } catch (e) {}
  }

  async function prepareWpsDocumentWrite() {
    const app = global.WpsAiAddon?.getApplicationSync?.() || await global.WpsAiAddon?.getApplication?.();
    try { activateWpsApp(app); } catch (e) {}
    await waitMs(180);
    try { activateWpsApp(app); } catch (e) {}
    await waitMs(120);
  }

  async function materialInsertUrl(item) {
    return materialDisplayUrl(item);
  }

  function materialGroups() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib?.listGroups) {
      return [
        { id: MATERIAL_ALL_GROUP_ID, name: "全部", virtual: true, count: lib?.list?.().length || 0 },
        { id: MATERIAL_DEFAULT_GROUP_ID, name: "未分组", count: 0 }
      ];
    }
    return lib.listGroups();
  }

  function materialGroupNameById(groups) {
    const map = new Map();
    groups.forEach((group) => map.set(group.id, group.name));
    return map;
  }

  function syncSelectedMaterials(allEntries) {
    const valid = new Set((allEntries || []).map((item) => item.id));
    selectedMaterialIds = new Set(Array.from(selectedMaterialIds).filter((id) => valid.has(id)));
  }

  function getSelectedMaterials() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib) return [];
    return Array.from(selectedMaterialIds).map((id) => lib.find(id)).filter(Boolean);
  }

  function getMaterialPreviewItem() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib || !materialPreviewItemId) return null;
    return lib.find?.(materialPreviewItemId) || null;
  }

  function closeMaterialPreview() {
    materialPreviewItemId = null;
    els.materialPreviewModal?.classList.add("hidden");
    if (els.materialPreviewImage) {
      els.materialPreviewImage.removeAttribute("src");
      els.materialPreviewImage.classList.add("hidden");
    }
  }

  async function openMaterialPreview(item) {
    if (!item) return;
    materialPreviewItemId = item.id || null;
    const prompt = item.prompt || item.revisedPrompt || "";
    const rawUrl = materialDisplayUrl(item);
    if (els.materialPreviewPrompt) els.materialPreviewPrompt.textContent = prompt || "未记录提示词";
    if (els.materialPreviewMeta) els.materialPreviewMeta.textContent = materialMetaText(item);
    if (els.materialPreviewUrl) {
      els.materialPreviewUrl.textContent = rawUrl || "未记录图片地址";
      els.materialPreviewUrl.title = rawUrl || "";
    }
    if (els.materialPreviewImage) {
      els.materialPreviewImage.removeAttribute("src");
      els.materialPreviewImage.alt = prompt || "素材预览";
      els.materialPreviewImage.classList.add("hidden");
    }
    if (els.materialPreviewStatus) {
      els.materialPreviewStatus.textContent = "加载中";
      els.materialPreviewStatus.classList.remove("hidden");
    }
    if (els.materialPreviewInsertBtn) els.materialPreviewInsertBtn.disabled = !rawUrl;
    if (els.materialPreviewModifyBtn) els.materialPreviewModifyBtn.disabled = false;
    if (els.materialPreviewCopyBtn) els.materialPreviewCopyBtn.disabled = !rawUrl;
    els.materialPreviewModal?.classList.remove("hidden");

    const previewUrl = await ensureMaterialPreview(item);
    if (materialPreviewItemId !== item.id) return;
    if (!previewUrl) {
      if (els.materialPreviewStatus) els.materialPreviewStatus.textContent = "无法预览";
      return;
    }
    if (els.materialPreviewImage) {
      els.materialPreviewImage.onload = () => {
        if (materialPreviewItemId !== item.id) return;
        els.materialPreviewImage?.classList.remove("hidden");
        els.materialPreviewStatus?.classList.add("hidden");
      };
      els.materialPreviewImage.onerror = () => {
        if (materialPreviewItemId !== item.id) return;
        els.materialPreviewImage?.classList.add("hidden");
        if (els.materialPreviewStatus) {
          els.materialPreviewStatus.textContent = "无法预览";
          els.materialPreviewStatus.classList.remove("hidden");
        }
      };
      els.materialPreviewImage.src = previewUrl;
    }
  }

  function renderMaterialGroups(groups) {
    if (!els.materialGroupList) return;
    els.materialGroupList.innerHTML = "";
    groups.forEach((group) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "material-group-item" + (group.id === activeMaterialGroupId ? " active" : "");
      btn.dataset.groupId = group.id;
      btn.innerHTML = `
        <span class="material-group-name">${escapeHtml(group.name)}</span>
        <span class="material-group-count">${Number(group.count || 0)}</span>
      `;
      btn.addEventListener("click", () => {
        activeMaterialGroupId = group.id;
        selectedMaterialIds.clear();
        renderMaterialLibrary();
      });
      els.materialGroupList.appendChild(btn);
    });
  }

  function renderMaterialToolbar(groups) {
    const selected = getSelectedMaterials();
    const selectedCount = selected.length;
    if (els.materialSelectedCount) {
      els.materialSelectedCount.textContent = selectedCount ? `已选择 ${selectedCount} 张` : "未选择素材";
    }
    if (els.materialMoveGroupSelect) {
      const previous = els.materialMoveGroupSelect.value || MATERIAL_DEFAULT_GROUP_ID;
      els.materialMoveGroupSelect.innerHTML = "";
      groups.filter((group) => !group.virtual).forEach((group) => {
        const option = document.createElement("option");
        option.value = group.id;
        option.textContent = group.name;
        els.materialMoveGroupSelect.appendChild(option);
      });
      const values = new Set(groups.filter((group) => !group.virtual).map((group) => group.id));
      els.materialMoveGroupSelect.value = values.has(previous) ? previous : MATERIAL_DEFAULT_GROUP_ID;
      els.materialMoveGroupSelect.disabled = selectedCount === 0;
    }
    if (els.materialMoveBtn) els.materialMoveBtn.disabled = selectedCount === 0;
    if (els.materialDeleteBtn) els.materialDeleteBtn.disabled = selectedCount === 0;
    if (els.materialInsertBtn) els.materialInsertBtn.disabled = selectedCount !== 1;
    if (els.materialModifyBtn) els.materialModifyBtn.disabled = selectedCount !== 1;
    if (els.materialCopyBtn) els.materialCopyBtn.disabled = selectedCount !== 1;
  }

  function selectMaterial(id, additive) {
    const next = additive ? new Set(selectedMaterialIds) : new Set();
    if (additive && next.has(id)) next.delete(id);
    else next.add(id);
    selectedMaterialIds = next;
    renderMaterialLibrary();
  }

  function renderMaterialLibrary() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib || !els.materialLibraryList) return;
    const groups = materialGroups();
    if (!groups.some((group) => group.id === activeMaterialGroupId)) {
      activeMaterialGroupId = MATERIAL_ALL_GROUP_ID;
    }
    const allEntries = lib.list();
    syncSelectedMaterials(allEntries);
    const groupName = materialGroupNameById(groups);
    const entries = lib.list({ groupId: activeMaterialGroupId });
    renderMaterialGroups(groups);
    renderMaterialToolbar(groups);
    els.materialLibraryList.innerHTML = "";
    if (els.materialLibraryEmpty) {
      els.materialLibraryEmpty.innerHTML = allEntries.length
        ? "<p>当前分组暂无素材。选中素材后可用「移动」放入这个分组。</p>"
        : "<p>暂无生图历史。用「AI 生成图片」生成后，会自动保存到这里。</p>";
    }
    els.materialLibraryEmpty?.classList.toggle("hidden", entries.length > 0);
    entries.forEach((item) => {
      const card = document.createElement("article");
      const selected = selectedMaterialIds.has(item.id);
      card.className = "material-card" + (selected ? " selected" : "");
      card.dataset.materialId = item.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", selected ? "true" : "false");
      const prompt = item.prompt || item.revisedPrompt || "";
      const url = materialDisplayUrl(item);
      card.innerHTML = `
        <div class="material-thumb" data-role="thumb">
          <span class="material-thumb-placeholder">加载中</span>
          ${materialPreviewButtonHtml()}
        </div>
        <div class="material-card-body">
          <div class="material-prompt" title="${escapeAttr(prompt)}">${escapeHtml(prompt || "未记录提示词")}</div>
          <div class="material-meta" title="${escapeAttr(url)}">${escapeHtml(materialMetaText(item))}</div>
          <span class="material-group-pill">${escapeHtml(groupName.get(materialGroupId(item)) || "未分组")}</span>
        </div>
      `;
      const thumb = card.querySelector('[data-role="thumb"]');
      ensureMaterialPreview(item).then((previewUrl) => {
        if (!thumb || !previewUrl) {
          if (thumb) thumb.innerHTML = `<span class="material-thumb-placeholder">无法预览</span>${materialPreviewButtonHtml()}`;
          return;
        }
        thumb.innerHTML = `<img src="${escapeAttr(previewUrl)}" alt="${escapeAttr(prompt || "生成图片")}" loading="lazy" />${materialPreviewButtonHtml()}`;
      });
      card.addEventListener("click", (ev) => {
        const previewBtn = ev.target?.closest?.('[data-role="preview"]');
        if (previewBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          openMaterialPreview(item);
          return;
        }
        selectMaterial(item.id, ev.metaKey || ev.ctrlKey || ev.shiftKey);
      });
      card.addEventListener("dblclick", (ev) => {
        if (ev.target?.closest?.('[data-role="preview"]')) return;
        insertSelectedMaterial();
      });
      card.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        selectMaterial(item.id, ev.metaKey || ev.ctrlKey || ev.shiftKey);
      });
      els.materialLibraryList.appendChild(card);
    });
  }

  function materialToolForHost(host, url) {
    if (host === "wps") return { toolName: "wps_insert_image", args: { fileName: url } };
    if (host === "wpp") return { toolName: "wpp_add_picture", args: { fileName: url, left: 80, top: 120, width: 560 } };
    if (host === "et") return { toolName: "et_insert_image", args: { fileName: url, width: 240 } };
    return null;
  }

  async function insertMaterialIntoDocument(item) {
    try {
      const url = await materialInsertUrl(item);
      if (!url) {
        showMessage("这条素材没有可用图片地址。", "error");
        return;
      }
      const hi = await global.WpsAiDocument?.getHostInfo?.();
      const host = hi?.host || currentHostInfo?.host || "wps";
      const target = materialToolForHost(host, url);
      if (!target) {
        showMessage("素材插入目前支持 WPS 文字、表格和演示。", "error");
        return;
      }
      await prepareWpsDocumentWrite();
      try { global.WpsAiHistory?.startTurn?.("从素材库插入图片"); } catch (e) {}
      setBusy(true);
      const result = await global.WpsAiToolRegistry?.execute?.(target.toolName, target.args);
      if (result?.ok) {
        showMessage("图片已插入当前文档。", "success");
        closeMaterialLibraryModal();
        renderHistory();
        return true;
      } else {
        showMessage(result?.error || "插入失败。", "error");
      }
    } catch (e) {
      showMessage(e?.message || String(e), "error");
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function modifyMaterialImage(item) {
    if (!els.chatInput) {
      showMessage("请在主面板执行单图修改。", "error");
      return;
    }
    const prompt = item.prompt || item.revisedPrompt || "";
    const previewUrl = await ensureMaterialPreview(item);
    if (previewUrl) {
      const attachment = {
        id: genAttachId(),
        kind: "image",
        name: materialFileName(item),
        mediaType: previewUrl.match(/^data:([^;]+);/)?.[1] || "image/png",
        dataUrl: previewUrl,
        size: 0,
        sourceMaterialId: item.id
      };
      pendingAttachments = pendingAttachments.filter((a) => a.sourceMaterialId !== item.id);
      pendingAttachments.push(attachment);
      renderAttachments();
    } else {
      showMessage("无法读取这张图片作为参考，已只回填修改指令。", "info");
    }
    const base = prompt ? `原图提示词：${prompt}\n` : "";
    els.chatInput.value = [
      "请基于我附加的这张参考图进行单图修改。",
      base + "修改要求：[在这里描述要修改的内容，比如：保持主体不变，换成蓝色科技风背景，增加柔和光影]",
      "",
      "完成后调用 generate_image 生成新图，并按当前宿主插入到文档中。"
    ].filter(Boolean).join("\n");
    closeMaterialLibraryModal();
    activateTab("ai");
    els.chatInput.focus();
    const start = els.chatInput.value.indexOf("[");
    const end = els.chatInput.value.indexOf("]");
    if (start >= 0 && end > start) els.chatInput.setSelectionRange(start + 1, end);
  }

  function writeMaterialDialogRequest(key, item) {
    try {
      const ts = Date.now();
      localStorage.setItem(key, JSON.stringify({ id: item.id, ts, readyAt: ts + 700 }));
      showMessage("已派给主面板执行。", "info");
      setTimeout(() => { try { if (typeof window.close === "function") window.close(); } catch (e) {} }, 0);
      return true;
    } catch (e) {
      showMessage(`派发失败：${e?.message || e}`, "error");
      return false;
    }
  }

  async function insertSelectedMaterial() {
    const selected = getSelectedMaterials();
    if (selected.length !== 1) {
      showMessage(selected.length ? "一次只能插入一张素材。" : "请先选择一张素材。", "error");
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_INSERT_KEY, selected[0]);
      return;
    }
    await insertMaterialIntoDocument(selected[0]);
  }

  async function modifySelectedMaterial() {
    const selected = getSelectedMaterials();
    if (selected.length !== 1) {
      showMessage(selected.length ? "一次只能修改一张素材。" : "请先选择一张素材。", "error");
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_MODIFY_KEY, selected[0]);
      return;
    }
    await modifyMaterialImage(selected[0]);
  }

  async function copySelectedMaterialUrl() {
    const selected = getSelectedMaterials();
    if (selected.length !== 1) {
      showMessage("请先选择一张素材。", "error");
      return;
    }
    const ok = await copyToClipboard(materialDisplayUrl(selected[0]));
    showMessage(ok ? "图片地址已复制。" : "复制失败，请手动复制。", ok ? "success" : "error");
  }

  async function insertPreviewMaterial() {
    const item = getMaterialPreviewItem();
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      closeMaterialPreview();
      renderMaterialLibrary();
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_INSERT_KEY, item);
      return;
    }
    const ok = await insertMaterialIntoDocument(item);
    if (ok) closeMaterialPreview();
  }

  async function modifyPreviewMaterial() {
    const item = getMaterialPreviewItem();
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      closeMaterialPreview();
      renderMaterialLibrary();
      return;
    }
    if (isMaterialsDialog) {
      writeMaterialDialogRequest(MATERIAL_DIALOG_MODIFY_KEY, item);
      return;
    }
    await modifyMaterialImage(item);
    closeMaterialPreview();
  }

  async function copyPreviewMaterialUrl() {
    const item = getMaterialPreviewItem();
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      closeMaterialPreview();
      renderMaterialLibrary();
      return;
    }
    const ok = await copyToClipboard(materialDisplayUrl(item));
    showMessage(ok ? "图片地址已复制。" : "复制失败，请手动复制。", ok ? "success" : "error");
  }

  function moveSelectedMaterials() {
    const lib = global.WpsAiMaterialLibrary;
    const ids = Array.from(selectedMaterialIds);
    if (!lib || !ids.length) {
      showMessage("请先选择素材。", "error");
      return;
    }
    const targetGroupId = els.materialMoveGroupSelect?.value || MATERIAL_DEFAULT_GROUP_ID;
    const moved = lib.moveEntries?.(ids, targetGroupId) || 0;
    selectedMaterialIds.clear();
    renderMaterialLibrary();
    showMessage(moved ? `已移动 ${moved} 张素材。` : "没有素材被移动。", moved ? "success" : "info");
  }

  function deleteSelectedMaterials() {
    const lib = global.WpsAiMaterialLibrary;
    const ids = Array.from(selectedMaterialIds);
    if (!lib || !ids.length) {
      showMessage("请先选择素材。", "error");
      return;
    }
    if (!confirm(`删除选中的 ${ids.length} 张素材？`)) return;
    ids.forEach((id) => lib.remove(id));
    selectedMaterialIds.clear();
    renderMaterialLibrary();
  }

  function createMaterialGroupFromInput() {
    const lib = global.WpsAiMaterialLibrary;
    const name = els.materialGroupNameInput?.value?.trim() || "";
    if (!lib || !name) {
      showMessage("请输入分组名称。", "error");
      return;
    }
    const group = lib.createGroup?.(name);
    if (!group) {
      showMessage("分组创建失败。", "error");
      return;
    }
    activeMaterialGroupId = group.id;
    if (els.materialGroupNameInput) els.materialGroupNameInput.value = "";
    selectedMaterialIds.clear();
    renderMaterialLibrary();
  }

  function resolveMaterialDialogItem(blob) {
    const lib = global.WpsAiMaterialLibrary;
    if (!blob) return null;
    const found = blob.id ? lib?.find?.(blob.id) : null;
    if (found) return found;
    if (blob.item && (blob.item.url || blob.item.dataUrl)) return blob.item;
    return null;
  }

  async function consumeMaterialDialogRequest(key, handler) {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(key) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let blob = null;
    try { blob = JSON.parse(raw); } catch (e) {}
    if (blob?.readyAt && Date.now() < Number(blob.readyAt)) return false;
    try { localStorage.removeItem(key); } catch (e) {}
    const item = resolveMaterialDialogItem(blob);
    if (!item) {
      showMessage("素材不存在或已被删除。", "error");
      return false;
    }
    await prepareWpsDocumentWrite();
    await handler(item);
    return true;
  }

  async function consumeMaterialDialogRequests() {
    await consumeMaterialDialogRequest(MATERIAL_DIALOG_INSERT_KEY, insertMaterialIntoDocument);
    await consumeMaterialDialogRequest(MATERIAL_DIALOG_MODIFY_KEY, modifyMaterialImage);
  }

  function startMaterialDialogRequestPolling() {
    if (isAnyDialogWindow()) return;
    if (materialDialogPollTimer) clearInterval(materialDialogPollTimer);
    let ticks = 0;
    materialDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeMaterialDialogRequests();
      if (ticks >= 600) {
        clearInterval(materialDialogPollTimer);
        materialDialogPollTimer = null;
      }
    }, 500);
  }

  function bindMaterialLibrary() {
    const lib = global.WpsAiMaterialLibrary;
    if (!lib) return;
    if (materialLibraryBound) return;
    materialLibraryBound = true;
    lib.subscribe(() => {
      if (!els.materialLibraryModal?.classList.contains("hidden")) renderMaterialLibrary();
    });
    els.materialLibraryCloseBtn?.addEventListener("click", closeMaterialLibraryModal);
    els.materialLibraryRefreshBtn?.addEventListener("click", renderMaterialLibrary);
    els.materialLibraryClearBtn?.addEventListener("click", () => {
      if (!lib.list().length) return;
      if (!confirm("清空全部生图素材历史？")) return;
      lib.clear();
      selectedMaterialIds.clear();
      renderMaterialLibrary();
    });
    els.materialGroupAddBtn?.addEventListener("click", createMaterialGroupFromInput);
    els.materialGroupNameInput?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      createMaterialGroupFromInput();
    });
    els.materialMoveBtn?.addEventListener("click", moveSelectedMaterials);
    els.materialInsertBtn?.addEventListener("click", insertSelectedMaterial);
    els.materialModifyBtn?.addEventListener("click", modifySelectedMaterial);
    els.materialCopyBtn?.addEventListener("click", copySelectedMaterialUrl);
    els.materialDeleteBtn?.addEventListener("click", deleteSelectedMaterials);
    els.materialPreviewCloseBtn?.addEventListener("click", closeMaterialPreview);
    els.materialPreviewInsertBtn?.addEventListener("click", insertPreviewMaterial);
    els.materialPreviewModifyBtn?.addEventListener("click", modifyPreviewMaterial);
    els.materialPreviewCopyBtn?.addEventListener("click", copyPreviewMaterialUrl);
    els.materialLibraryModal?.addEventListener("click", (ev) => {
      if (ev.target === els.materialLibraryModal) closeMaterialLibraryModal();
    });
    els.materialPreviewModal?.addEventListener("click", (ev) => {
      if (ev.target === els.materialPreviewModal) closeMaterialPreview();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (els.materialPreviewModal && !els.materialPreviewModal.classList.contains("hidden")) {
        closeMaterialPreview();
        return;
      }
      if (els.materialLibraryModal && !els.materialLibraryModal.classList.contains("hidden")) {
        closeMaterialLibraryModal();
      }
    });
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

  function bindForceUnlock() {
    if (!els.forceUnlockBtn) return;
    els.forceUnlockBtn.addEventListener("click", () => {
      try { unlockHostDocument(); } catch (e) {}
      let res = null;
      try { res = global.WpsAiLock?.forceUnlock?.(); } catch (e) {}
      const cleared = res && (res.word || res.sheet || res.interactive || res.hadLock);
      if (cleared) {
        const parts = [];
        if (res.word) parts.push("Word 保护");
        if (res.sheet) parts.push("表格保护");
        if (res.interactive) parts.push("交互锁");
        if (!parts.length && res.hadLock) parts.push("内存锁定状态");
        showMessage(`已解除：${parts.join(" / ")}。`, "success");
      } else {
        showMessage("当前没有检测到 AI 残留锁定。如果 WPS 仍提示编辑受限，可能是用户自己设置的密码保护。", "info");
      }
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
    // 新对话绑定到当前活动文档；切到别的文件就会自动隐藏
    try { global.WpsAiConversations?.createNew?.({ docKey: getCurrentDocKey() }); } catch (e) {}
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
    // 按当前打开的文件过滤；切到别的文件 / 没打开文件就只显示对应那组对话
    const docKey = getCurrentDocKey();
    // legacyDocKey：docKey 是新式 "id:<uuid>" 时把之前按裸路径存的老对话一并算命中并升级
    const legacyDocKey = docKey.startsWith("id:") ? (global.WpsAiBackup?.getCurrentDocPath?.() || "") : "";
    const list = global.WpsAiConversations?.listConversations?.({ docKey, legacyDocKey }) || [];
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

    // 首次进入：current 对话必须跟当前文档匹配才灌进 chatHistory，否则当成新会话
    try {
      const docKey = getCurrentDocKey();
      const legacyDocKey = docKey.startsWith("id:") ? (global.WpsAiBackup?.getCurrentDocPath?.() || "") : "";
      const current = global.WpsAiConversations?.getCurrentForDoc?.(docKey, legacyDocKey);
      if (current && current.messages && current.messages.length > 0) {
        current.messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
        rebuildChatStreamFromHistory();
      } else {
        // currentId 指向不属于当前文件的旧对话 → 清掉，让下次发消息走 lazy createNew
        try { global.WpsAiConversations?.clearCurrent?.(); } catch (e) {}
      }
    } catch (e) {}

    // 启动文档切换监听：每 1.5s 探一次活动文档；变了就保存旧对话 + 开新空会话
    startDocWatcher((newKey, oldKey) => {
      try { global.WpsAiConversations?.syncMessages?.(chatHistory); } catch (e) {}
      chatHistory.length = 0;
      if (els.chatStream) els.chatStream.innerHTML = "";
      if (els.chatPending) els.chatPending.classList.add("hidden");
      hideSuggestedActions?.();
      // 新文件 → 看有没有它的现存对话，有就加载、没有就空着等用户发消息时再 createNew
      const conv = global.WpsAiConversations?.getCurrentForDoc?.(newKey);
      if (conv && conv.messages && conv.messages.length > 0) {
        conv.messages.forEach((m) => chatHistory.push({ role: m.role, content: m.content }));
        rebuildChatStreamFromHistory();
      } else {
        // 不主动 createNew —— 等用户真发消息时 syncMessages 触发 lazy 创建（带新 docKey）
        // 这样切到没用过的文件就是真正"全空"，不留空壳对话
        try { global.WpsAiConversations?.clearCurrent?.(); } catch (e) {}
      }
      // 通知 UI 刷新历史 / 改动记录角标（这俩本就按 docKey 过滤）
      try { renderConversationsMenu(); } catch (e) {}
      try { renderHistory?.(); } catch (e) {}
      // HTML 模板历史 / 组件库也跟着新文件
      try {
        if (els.htmlPreviewModal && !els.htmlPreviewModal.classList.contains("hidden")) {
          renderHtmlTemplateGallery?.(); updateHtmlPreviewHistoryBadge?.();
        }
      } catch (e) {}
      const fname = newKey ? newKey.split(/[/\\]/).pop() : "新文档（未保存）";
      showMessage(`已切到「${fname}」的会话`, "info");
    });
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
    // 「保存」按钮：只保存不关闭，方便用户配完一个 provider 接着配下一个不被打断
    els.saveSettingsOnlyBtn?.addEventListener("click", saveSettings);

    // 设置 toggle 类 checkbox 自动持久化 —— 之前要点「保存」才生效，用户勾了直接关窗就丢了，
    // 现在 change 立即写 localStorage。presentation.js 用 loadSettings() 读到的就是最新值。
    const autoPersistCheckboxes = [
      "splitLayersOnInsertInput",
      "showToolCallLogsInput",
      "mcpServerEnabledInput",
      "updateAutoCheckInput"
    ];
    autoPersistCheckboxes.forEach((id) => {
      const el = els[id];
      if (!el) return;
      el.addEventListener("change", () => {
        try { readSettingsFromForm(); persistSettings(); } catch (e) {}
      });
    });
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
    if (els.addImageProviderBtn) {
      els.addImageProviderBtn.addEventListener("click", addImageProvider);
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
    // 选了内置色板 → 自动填颜色（hidden <select> 改了也走同一条路径）
    els.styleScheme.addEventListener("change", () => {
      const v = els.styleScheme.value;
      if (v && v !== "custom") applyColorScheme(v);
      updateSchemePreview(v);
      updateLivePreview();
    });
    // 手动改任意颜色 → 切回 custom（避免给人"还是某预设"的误导）
    [
      "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor",
      "styleBackgroundColor", "styleSurfaceColor",
      "styleTitleColor", "styleBodyColor"
    ].forEach((id) => {
      els[id]?.addEventListener("input", markCustomScheme);
    });
    // 字体/字号/加粗变化只刷新实时预览（不切回 custom，因为主题里这些可能是默认值）
    [
      "styleTitleFont", "styleTitleSize", "styleBodyFont", "styleBodySize"
    ].forEach((id) => {
      els[id]?.addEventListener("input", updateLivePreview);
    });
    els.styleTitleBold?.addEventListener("change", updateLivePreview);

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

    if (!isSettingsDialog && !isPreviewDialog && !isMaterialsDialog && !isQuickPromptDialog && !isFormatPreviewDialog && !isSelectionPreviewDialog) startPaneWidthSync();

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
      if (isAnyDialogWindow()) return;
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
      // 同 fallback 路径：dialog 端 doConfirm 顶部已经 cache.update 了，下游 saveToCache=true 会重复一条
      const isReplaceLike = params.intent === "replace" || params.intent === "replace-active";
      if (isReplaceLike) params.saveToCache = false;
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

    window.addEventListener("storage", (ev) => {
      if (ev.key !== MATERIAL_DIALOG_INSERT_KEY && ev.key !== MATERIAL_DIALOG_MODIFY_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeMaterialDialogRequests();
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== QUICK_PROMPT_DIALOG_RESULT_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeQuickPromptDialogResult();
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== FORMAT_PREVIEW_DIALOG_RESULT_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeFormatPreviewDialogResult();
    });

    window.addEventListener("storage", (ev) => {
      if (ev.key !== SELECTION_PREVIEW_DIALOG_RESULT_KEY) return;
      if (!ev.newValue) return;
      if (isAnyDialogWindow()) return;
      consumeSelectionPreviewDialogResult();
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

    // 独立素材库窗口：只跑素材库相关 init，插入 / 修改通过 localStorage 派给主 TaskPane 执行
    if (isMaterialsDialog) {
      bindMaterialLibrary();
      openMaterialLibraryModal();
      return;
    }

    // 独立 ribbon 快捷输入窗口：只渲染对应表单，确认后把最终 prompt 写回主 TaskPane
    if (isQuickPromptDialog) {
      bindQuickPromptModal();
      let req = null;
      try {
        const raw = localStorage.getItem(QUICK_PROMPT_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      if (req) {
        openQuickPromptInline(req);
      } else {
        showMessage("快捷操作数据已过期，请重新点击 ribbon 按钮。", "error", { autoHide: false });
      }
      window.addEventListener("beforeunload", () => {
        if (quickPromptState && !quickPromptDialogResultWritten) writeQuickPromptDialogResult({ cancelled: true, viaWindowClose: true });
      });
      return;
    }

    if (isFormatPreviewDialog) {
      bindFormatPreviewModal();
      let req = null;
      try {
        const raw = localStorage.getItem(FORMAT_PREVIEW_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      if (req?.text || req?.paragraphs) {
        prepareFormatPreview({ text: req.text || "", paragraphs: req.paragraphs || [] });
      } else {
        els.formatPreviewModal?.classList.remove("hidden");
        showMessage("排版预览数据已过期，请重新点击 ribbon 按钮。", "error", { autoHide: false });
      }
      window.addEventListener("beforeunload", () => {
        if (formatPreviewDialogResultWritten) return;
        try {
          const raw = localStorage.getItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY);
          if (!raw) localStorage.setItem(FORMAT_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({ ts: Date.now(), cancelled: true, viaWindowClose: true }));
        } catch (e) {}
      });
      return;
    }

    if (isSelectionPreviewDialog) {
      bindSelectionPreviewModal();
      let req = null;
      try {
        const raw = localStorage.getItem(SELECTION_PREVIEW_DIALOG_REQUEST_KEY);
        if (raw) req = JSON.parse(raw);
      } catch (e) {}
      if (req?.sourceText) {
        openSelectionPreviewInline(req);
      } else {
        els.selectionPreviewModal?.classList.remove("hidden");
        showMessage("选区预览数据已过期，请重新点击 ribbon 按钮。", "error", { autoHide: false });
      }
      window.addEventListener("beforeunload", () => {
        if (selectionPreviewDialogResultWritten) return;
        try {
          const raw = localStorage.getItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY);
          if (!raw) localStorage.setItem(SELECTION_PREVIEW_DIALOG_RESULT_KEY, JSON.stringify({ ts: Date.now(), cancelled: true, viaWindowClose: true }));
        } catch (e) {}
      });
      return;
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
      // 设置 dialog 模式下也要绑「+ 新增图像渠道」—— 之前漏了，按钮点了没反应
      els.addImageProviderBtn?.addEventListener("click", addImageProvider);
      document.querySelectorAll("[data-close-preset-picker]").forEach((node) => {
        node.addEventListener("click", () => closePresetPicker());
      });
      els.saveSettingsBtn?.addEventListener("click", () => {
        readSettingsFromForm();
        persistSettings();
        showMessage("设置已保存。", "success");
        setTimeout(closeSettingsDialogWindow, 300);
      });
      // dialog 模式的「保存」按钮：只持久化不关闭
      els.saveSettingsOnlyBtn?.addEventListener("click", () => {
        readSettingsFromForm();
        persistSettings();
        showMessage("设置已保存。", "success");
      });
      // dialog 模式下 toggle checkbox 也要自动持久化（用户经常 check 完直接关 X 窗口）
      [
        "splitLayersOnInsertInput",
        "showToolCallLogsInput",
        "mcpServerEnabledInput",
        "updateAutoCheckInput"
      ].forEach((id) => {
        const el = els[id];
        if (!el) return;
        el.addEventListener("change", () => {
          try { readSettingsFromForm(); persistSettings(); } catch (e) {}
        });
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
      // 设备 SN：默认隐藏（避免普通用户在程序信息面板里被一长串字符迷惑），
      // 双击版本号才展开 + 懒拉取。展开后状态记录在 dataset 上，避免重复请求 proxy。
      els.copyDeviceSnBtn?.addEventListener("click", copyDeviceSn);
      els.aboutDeviceSn?.addEventListener("click", copyDeviceSn);
      // 官网地址：点链接优先走系统默认浏览器（避免 WPS WebView 里就地跳到白屏）
      els.aboutHomepageLink?.addEventListener("click", (ev) => {
        const url = els.aboutHomepageLink.href;
        if (!url) return;
        // WPS 走 Shell.Application ShellExecute / WPS 官方 openUrl；不行退回 target="_blank" 默认行为
        try {
          const app = global.WpsAiAddon?.getApplicationSync?.();
          if (app && typeof app.OpenUrl === "function") {
            app.OpenUrl(url); ev.preventDefault(); return;
          }
        } catch (e) {}
        try {
          if (global.wps?.OpenUrl) { global.wps.OpenUrl(url); ev.preventDefault(); return; }
        } catch (e) {}
        // 兜底：让 target="_blank" 自己走 —— WebView 会试着开外部浏览器
      });
      els.copyHomepageBtn?.addEventListener("click", async () => {
        const url = els.aboutHomepageLink?.href || "https://wps-ai.llteac.cn/";
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
          else {
            const ta = document.createElement("textarea");
            ta.value = url; ta.style.position = "fixed"; ta.style.left = "-9999px";
            document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); document.body.removeChild(ta);
          }
          showMessage("官网地址已复制", "success", { duration: 2000 });
        } catch (e) {
          showMessage(`复制失败：${e?.message || e}`, "error");
        }
      });
      els.aboutVersion?.addEventListener("dblclick", () => {
        const snRow = document.querySelector(".about-device-sn");
        if (!snRow) return;
        snRow.classList.toggle("hidden");
        if (!snRow.classList.contains("hidden") && els.aboutVersion.dataset.snLoaded !== "1") {
          loadAndRenderDeviceSn();
          els.aboutVersion.dataset.snLoaded = "1";
        }
      });

      // 复制配置 JSON
      els.mcpCopyConfigBtn?.addEventListener("click", async () => {
        const text = els.mcpConfigSnippet?.value || "";
        const ok = await copyToClipboard(text);
        if (ok) showMessage("配置已复制到剪贴板", "success");
        else showMessage("复制失败，请手动选中文本", "error");
      });
      // 开发者工具区：默认隐藏，setupDevToolsSection 内部异步问 proxy /install-path 是 dev 才显示
      setupDevToolsSection();
      // 在独立窗口里"打开"就是直接渲染 settings panel + 让 modal 可见
      // （HTML 标签默认带 .hidden，正常模式下由 openSettingsModal 去除；dialog 模式要手动去）
      els.settingsModal?.classList.remove("hidden");
      renderChatProvidersList();
      // 支持 ?panel=about 之类的初始化跳转（外面点了「新版本」徽章会传 about）
      const m = window.location.search.match(/[?&]panel=([^&]+)/);
      const initialPanel = m ? decodeURIComponent(m[1]) : "chat";
      switchSettingsPanel(initialPanel);
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
        updateLivePreview();
      });
      [
        "stylePrimaryColor", "styleSecondaryColor", "styleAccentColor",
        "styleBackgroundColor", "styleSurfaceColor",
        "styleTitleColor", "styleBodyColor"
      ].forEach((id) => {
        els[id]?.addEventListener("input", markCustomScheme);
      });
      [
        "styleTitleFont", "styleTitleSize", "styleBodyFont", "styleBodySize"
      ].forEach((id) => {
        els[id]?.addEventListener("input", updateLivePreview);
      });
      els.styleTitleBold?.addEventListener("change", updateLivePreview);
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
    bindQuickPromptModal();
    bindMaterialLibrary();
    bindFormatPreviewModal();
    bindSelectionPreviewModal();
    bindPureMode();
    bindForceUnlock();
    bindImageGenPanel();
    bindCachePanel();
    bindConversations();
    bindAttachments();
    consumeMaterialDialogRequests();
    consumeQuickPromptDialogResult();
    consumeFormatPreviewDialogResult();
    consumeSelectionPreviewDialogResult();

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

    // 顶栏「新版本」呼吸徽章：直接跳设置→程序信息，让用户看 changelog + 下载
    els.updateAvailableBadge?.addEventListener("click", () => openSettingsAsDialog("about"));

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

  // ============ 缓存管理 UI ============
  //
  // 让用户看到 localStorage + proxy 侧到底攒了多少数据，可按组或单条清。
  // 分组由 WpsAiCache.CATEGORIES 决定；safe=false 的组（历史 / 设置）
  // 用橘色标记，清之前给 confirm。
  async function renderCachePanel() {
    const mod = global.WpsAiCache;
    if (!mod || !els.cacheGroupsList) return;
    els.cacheGroupsList.innerHTML = '<p class="muted" style="font-size:11px;margin:0">扫描中…</p>';
    let data;
    try { data = await mod.scan(); } catch (e) {
      els.cacheGroupsList.innerHTML = `<p class="muted" style="font-size:11px">扫描失败：${escapeHtml(String(e?.message || e))}</p>`;
      return;
    }
    if (els.cacheTotalBadge) els.cacheTotalBadge.textContent = `总计 ${mod.fmtBytes(data.grandTotalBytes)}`;

    const parts = [];
    // localStorage 分组
    for (const g of data.local.groups) {
      const chip = g.safe ? "" : `<span class="cache-group-warn" title="清了会丢历史/设置">谨慎</span>`;
      const rows = g.items.map((it) => {
        const ts = it.updatedAt ? `<span class="cache-item-ts">${fmtTime(it.updatedAt)}</span>` : "";
        return `
          <div class="cache-item" data-key="${escapeHtml(it.key)}">
            <code class="cache-item-key" title="${escapeHtml(it.key)}">${escapeHtml(it.key)}</code>
            ${ts}
            <span class="cache-item-size">${mod.fmtBytes(it.bytes)}</span>
            <button type="button" class="ghost-btn compact-btn cache-item-clear-btn" data-clear-key="${escapeHtml(it.key)}">清除</button>
          </div>`;
      }).join("");
      parts.push(`
        <div class="cache-group ${g.safe ? "" : "cache-group-unsafe"}">
          <div class="cache-group-head">
            <span class="cache-group-label">${escapeHtml(g.label)}</span>
            ${chip}
            <span class="cache-group-size">${mod.fmtBytes(g.bytes)} · ${g.items.length} 项</span>
            <button type="button" class="ghost-btn compact-btn cache-group-clear-btn" data-clear-group="${escapeHtml(g.label)}">清除本组</button>
          </div>
          <div class="cache-group-body">${rows}</div>
        </div>`);
    }
    // proxy 侧 buckets
    if (data.proxy && data.proxy.length) {
      const bucketRows = data.proxy.map((b) => {
        const chip = b.safe ? "" : `<span class="cache-group-warn" title="清了会丢改动记录恢复能力">谨慎</span>`;
        return `
          <div class="cache-item" data-bucket="${escapeHtml(b.name)}">
            <code class="cache-item-key" title="${escapeHtml(b.path || "")}">${escapeHtml(b.label)}</code>
            ${chip}
            <span class="cache-item-size">${mod.fmtBytes(b.bytes)} · ${b.itemCount} 项</span>
            <button type="button" class="ghost-btn compact-btn cache-item-clear-btn" data-clear-bucket="${escapeHtml(b.name)}">清除</button>
          </div>`;
      }).join("");
      parts.push(`
        <div class="cache-group">
          <div class="cache-group-head">
            <span class="cache-group-label">proxy 本地目录</span>
            <span class="cache-group-size">${mod.fmtBytes(data.proxy.reduce((s, b) => s + b.bytes, 0))} · ${data.proxy.length} 项</span>
          </div>
          <div class="cache-group-body">${bucketRows}</div>
        </div>`);
    }
    if (!parts.length) {
      els.cacheGroupsList.innerHTML = '<p class="muted" style="font-size:11px;margin:0">当前没有缓存数据。</p>';
      return;
    }
    els.cacheGroupsList.innerHTML = parts.join("");

    // 绑定单条 / 整组 / proxy 清除按钮
    els.cacheGroupsList.querySelectorAll(".cache-item-clear-btn[data-clear-key]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.clearKey;
        if (!confirm(`确认清除 ${key}？`)) return;
        mod.clearKey(key);
        await renderCachePanel();
      });
    });
    els.cacheGroupsList.querySelectorAll(".cache-item-clear-btn[data-clear-bucket]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.clearBucket;
        if (!confirm(`确认清除 proxy 侧 ${name} 目录？`)) return;
        const r = await mod.clearProxyBucket(name);
        showMessage(r?.ok ? `已清 ${r.removed} 项` : `清除失败：${r?.error || "未知"}`,
                    r?.ok ? "success" : "error");
        await renderCachePanel();
      });
    });
    els.cacheGroupsList.querySelectorAll(".cache-group-clear-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const label = btn.dataset.clearGroup;
        const cat = mod.CATEGORIES.find((c) => c.label === label);
        const warn = cat && !cat.safe ? "\n\n⚠ 这个组是历史 / 设置数据，清了不能恢复。" : "";
        if (!confirm(`确认清除整组「${label}」？${warn}`)) return;
        mod.clearGroup(label);
        await renderCachePanel();
      });
    });
  }

  function bindCachePanel() {
    if (els.cacheRefreshBtn) {
      els.cacheRefreshBtn.addEventListener("click", () => renderCachePanel());
    }
    if (els.cacheClearSafeBtn) {
      els.cacheClearSafeBtn.addEventListener("click", async () => {
        const mod = global.WpsAiCache;
        if (!mod) return;
        if (!confirm("清除所有安全缓存（预览中间态 / 版本检查 / 模型列表 / 运行时探测）？\n\n设置和历史不动。")) return;
        const r = mod.clearAllSafe();
        showMessage(`已清 ${r.cleared} 项`, "success");
        await renderCachePanel();
      });
    }
  }

  // 拉 package.json 拿到版本号显示在 header 和 about 两处。
  // 带 _ts 时间戳强制 URL 唯一，绕过 WPS WebView2 的磁盘级 HTTP 缓存
  // （fetch cache:"no-store" + 服务端 no-cache header 在 Win 上都不完全管用）。
  async function loadVersionInfo() {
    let v = "—";
    try {
      const resp = await fetch(`./package.json?_ts=${Date.now()}`, { cache: "no-store" });
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
    // result = { current, latest, updateAvailable, manifest, checkedAt, channel, canaryReason, deviceSn } | null
    // 顶栏「新版本」呼吸徽章：在主 TaskPane（非 dialog）展示，点了跳设置→程序信息
    if (els.updateAvailableBadge) {
      const showBadge = !!result?.updateAvailable;
      els.updateAvailableBadge.classList.toggle("hidden", !showBadge);
      if (showBadge) {
        els.updateAvailableBadge.title = `发现新版本 v${result.latest}（当前 v${result.current}），点击查看`;
      }
    }
    if (!els.updateStatusBadge) return;
    // 通道徽章一直渲染（即使没检查过也告诉用户当前在哪条通道）
    if (els.updateChannelBadge) {
      const ch = result?.channel || "stable";
      els.updateChannelBadge.textContent = ch === "canary"
        ? (result?.canaryReason === "rollout" ? "canary (rollout)" : "canary (whitelist)")
        : "stable";
      els.updateChannelBadge.className = "badge " + (ch === "canary" ? "badge-warning" : "badge-muted");
      els.updateChannelBadge.title = ch === "canary"
        ? "你的设备 SN 在灰度白名单内或落在 rollout 百分比内，会优先拿到 canary 版本"
        : "你走正式通道。灰度版本在 SN 进白名单后才会拿到";
    }
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
      // 立即刷 header / about 里的版本号，让用户不用等重启也能看到新版本落地
      // （文件已被覆盖，fetch 加了时间戳能拿到新 package.json）
      try { await loadVersionInfo(); } catch (e) {}
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

  // 设备 SN：从 proxy 拿一次后渲染到关于面板，并支持点击 / 按钮复制。
  // 灰度白名单管理员需要这个 SN 才能把当前设备加进 canary 通道。
  async function loadAndRenderDeviceSn() {
    const span = els.aboutDeviceSn;
    if (!span) return;
    const Up = global.WpsAiUpdater;
    if (!Up?.getDeviceSn) { span.textContent = "—"; return; }
    span.textContent = "读取中…";
    span.dataset.sn = "";
    try {
      const sn = await Up.getDeviceSn();
      if (sn) {
        span.textContent = sn;
        span.dataset.sn = sn;
        span.title = `点击复制 · 来源 localStorage 或 proxy /device-sn`;
      } else {
        // 区分原因：先快速 ping 一下 proxy 看是否在线
        const proxyAlive = await fetch((global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/mcp/status", { method: "GET" })
          .then((r) => r.ok).catch(() => false);
        span.textContent = proxyAlive ? "(SN 读取失败 · 看 proxy 日志)" : "(代理离线 · 启动 npm run proxy)";
        span.title = proxyAlive
          ? "proxy 在线但 /device-sn 没拿到值。看 proxy 终端 [device-sn] 日志诊断"
          : `本地代理 ${global.WpsAiRuntime?.proxyBase?.() || "127.0.0.1:3890"} 不通。dev 模式下要等 proxy 完全启动，或手动 npm run proxy`;
      }
    } catch (e) {
      span.textContent = "—";
    }
  }
  function copyDeviceSn() {
    const span = els.aboutDeviceSn;
    const sn = span?.dataset?.sn || span?.textContent?.trim();
    if (!sn || sn === "—" || sn === "读取中…" || sn === "(代理离线)") {
      showMessage("SN 还没拿到，稍后再试", "info");
      return;
    }
    // navigator.clipboard 在 WPS WebView 里部分版本不可用，做 fallback
    const ok = (txt) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(txt).then(
          () => showMessage(`已复制 SN：${txt}`, "success"),
          () => fallback(txt)
        );
      } else fallback(txt);
    };
    const fallback = (txt) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
        showMessage(`已复制 SN：${txt}`, "success");
      } catch (e) { showMessage("复制失败，请手动选中文本复制", "error"); }
    };
    ok(sn);
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

  // ---- ribbon 快捷输入弹窗 ----
  let quickPromptState = null;
  let quickPromptBound = false;
  let quickPromptDialogResultWritten = false;
  let quickPromptDialogPollTimer = null;
  let lastQuickPromptResultTs = 0;

  function hydrateQuickPromptPayload(payload) {
    const out = Object.assign({}, payload || {});
    const action = global.WpsAiQuickActions?.findByKey?.(out.host, out.key);
    if (action) {
      if (!out.label) out.label = action.label;
      if (!out.prompt) out.prompt = action.prompt;
      out.prefill = !!(out.prefill || action.prefill);
      out.optionalInput = !!(out.optionalInput || action.optionalInput);
      out.attachActivePdf = !!(out.attachActivePdf || action.attachActivePdf);
    }
    return out;
  }

  function isImageQuickPrompt(payload) {
    return payload?.key === "image";
  }

  function extractQuickPromptPlaceholders(prompt) {
    const text = String(prompt || "");
    const result = [];
    const re = /\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(text))) {
      result.push({ raw: m[0], label: m[1].trim(), index: m.index });
    }
    return result;
  }

  function cleanQuickPromptLabel(text) {
    return String(text || "")
      .replace(/^在这里(?:写|输入|描述|填写)?\s*/i, "")
      .trim() || "补充内容";
  }

  function buildImageQuickPrompt(payload, imagePrompt, insertAtCursor) {
    const host = payload?.host || currentHostInfo?.host || "wps";
    const insertRule = (() => {
      if (!insertAtCursor) {
        return "只调用 generate_image 生成图片，不要调用 wps_insert_image / wpp_add_picture / et_insert_image 等插入工具。generate_image 会自动把结果记录到素材库。";
      }
      if (host === "wpp") {
        return "再用 wpp_add_picture 把拿到的图片 URL 作为 fileName 传进去（建议参数 left=80, top=120, width=560），插入到当前幻灯片的合适位置。";
      }
      if (host === "et") {
        return "再用 et_insert_image 把拿到的图片 URL 作为 fileName 传进去（建议 width=240），插入到当前工作表。";
      }
      return "再用 wps_insert_image 把拿到的图片 URL 作为 fileName 传进去，插入到当前光标位置。";
    })();
    const sizeHint = host === "wpp"
      ? "调 generate_image 时请基于提示词内容自行决定 size：PPT 主图/封面默认 16:9；其它情况按内容判断。除非用户提示词明确写了比例/尺寸，否则不要省略 size。"
      : host === "et"
        ? "调 generate_image 时请基于提示词内容自行决定 size：表格里通常是说明/示意图，默认 4:3 或 1:1；其它情况按内容判断。除非用户提示词明确写了比例/尺寸，否则不要省略 size。"
        : "调 generate_image 时请基于提示词与当前文档语境自行决定 size：封面/章节配图用 16:9，竖向人物/插画用 9:16 或 2:3，方形小图/Logo 用 1:1，正文横向插图用 3:2。除非用户提示词明确写了比例/尺寸，否则不要省略 size。";
    return [
      "请根据下面的生图提示词生成 1 张图片。",
      "",
      "【生图提示词】",
      imagePrompt,
      "",
      "【执行要求】",
      "先调用 generate_image 拿到图片 URL。",
      sizeHint,
      insertRule
    ].join("\n");
  }

  function buildGenericQuickPrompt(payload) {
    const prompt = String(payload?.prompt || "");
    const placeholders = quickPromptState?.placeholders || extractQuickPromptPlaceholders(prompt);
    const optional = !!payload?.optionalInput;
    if (!placeholders.length || placeholders.every((ph) => !ph.raw)) {
      const extra = String(els.quickPromptBody?.querySelector('[data-quick-prompt-index="0"]')?.value || "").trim();
      if (!extra) {
        // optionalInput=true：用户没填补充要求也允许直接发，按原 prompt 走
        if (optional) return prompt;
        throw new Error("请先填写补充要求。");
      }
      return [prompt, "", "补充要求：" + extra].filter(Boolean).join("\n");
    }
    let finalPrompt = prompt;
    for (let i = 0; i < placeholders.length; i += 1) {
      const ph = placeholders[i];
      const input = els.quickPromptBody?.querySelector(`[data-quick-prompt-index="${i}"]`);
      const value = String(input?.value || "").trim();
      if (!value) {
        if (optional) continue; // 占位也允许留空，留原文不替换
        throw new Error(`请先填写「${cleanQuickPromptLabel(ph.label)}」。`);
      }
      finalPrompt = finalPrompt.replace(ph.raw, value);
    }
    return finalPrompt;
  }

  function renderQuickPromptForm(payload) {
    if (!els.quickPromptBody) return;
    const label = payload.label || "快捷操作";
    const optional = !!payload?.optionalInput;
    if (els.quickPromptTitle) els.quickPromptTitle.textContent = label;
    if (els.quickPromptSubtitle) {
      els.quickPromptSubtitle.textContent = isImageQuickPrompt(payload)
        ? "输入生图提示词，生成后可选择是否插入当前位置。"
        : (optional
          ? "可选择补充要求；不填则直接按默认指令执行。"
          : "填写必要内容后会自动发送给 AI。");
    }
    // 「补充要求」可空场景下，把"开始执行"按钮文案改成"直接执行 / 加要求执行"两态——
    // 用 placeholder 自动联动太复杂，直接长一些的提示更直观
    if (els.quickPromptSubmitBtn) {
      els.quickPromptSubmitBtn.textContent = optional ? "开始执行（可不填）" : "开始执行";
    }

    if (isImageQuickPrompt(payload)) {
      els.quickPromptBody.innerHTML = `
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptImageInput">生图提示词</label>
          <textarea id="quickPromptImageInput" class="quick-prompt-image-input" rows="7" placeholder="例如：科技感的报告封面，深蓝色背景，柔和光影，商务风格"></textarea>
        </div>
        <div class="quick-prompt-options">
          <label class="quick-prompt-option">
            <input id="quickPromptInsertAtCursor" type="checkbox" checked />
            <span>生成后插入到当前位置。不勾选时只生成图片并记录到素材库。</span>
          </label>
        </div>
      `;
      return;
    }

    const placeholders = extractQuickPromptPlaceholders(payload.prompt);
    quickPromptState.placeholders = placeholders;
    if (!placeholders.length) {
      const fieldLabel = optional ? "补充要求（可不填）" : "补充要求";
      const placeholderText = optional
        ? "想加要求就填，比如：续写 3 段 / 偏学术风格 / 围绕 XX 展开。不填就直接执行。"
        : "输入要补充给 AI 的内容";
      els.quickPromptBody.innerHTML = `
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptInput0">${escapeHtml(fieldLabel)}</label>
          <textarea id="quickPromptInput0" data-quick-prompt-index="0" class="quick-prompt-text-input" rows="4" placeholder="${escapeAttr(placeholderText)}"></textarea>
        </div>
      `;
      quickPromptState.placeholders = [{ raw: "", label: "补充要求" }];
      return;
    }

    els.quickPromptBody.innerHTML = placeholders.map((ph, i) => {
      const cleanLabel = cleanQuickPromptLabel(ph.label);
      const isShort = cleanLabel.length <= 18 && !/[，。,.\n]/.test(cleanLabel);
      const control = isShort
        ? `<input id="quickPromptInput${i}" data-quick-prompt-index="${i}" type="text" placeholder="${escapeAttr(cleanLabel)}" />`
        : `<textarea id="quickPromptInput${i}" data-quick-prompt-index="${i}" class="quick-prompt-text-input" rows="3" placeholder="${escapeAttr(cleanLabel)}"></textarea>`;
      return `
        <div class="quick-prompt-field">
          <label class="quick-prompt-label" for="quickPromptInput${i}">${escapeHtml(cleanLabel)}</label>
          ${control}
        </div>
      `;
    }).join("");
  }

  function focusQuickPromptFirstInput() {
    setTimeout(() => {
      const first = els.quickPromptBody?.querySelector("textarea, input[type='text']");
      first?.focus?.();
    }, 50);
  }

  function openQuickPromptInline(payload) {
    const hydrated = hydrateQuickPromptPayload(payload);
    if (!hydrated.prompt && !isImageQuickPrompt(hydrated)) {
      showMessage("未找到快捷操作指令。", "error", { autoHide: false });
      return false;
    }
    quickPromptState = {
      payload: hydrated,
      placeholders: extractQuickPromptPlaceholders(hydrated.prompt)
    };
    renderQuickPromptForm(hydrated);
    els.quickPromptModal?.classList.remove("hidden");
    focusQuickPromptFirstInput();
    return true;
  }

  function resetQuickPromptStateIfNeeded() {
    if (!isQuickPromptDialog) quickPromptDialogResultWritten = false;
  }

  function closeQuickPromptModal(cancelled = true) {
    if (isQuickPromptDialog && cancelled) {
      writeQuickPromptDialogResult({ cancelled: true });
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }
    els.quickPromptModal?.classList.add("hidden");
    quickPromptState = null;
  }

  function writeQuickPromptDialogResult(result) {
    if (!isQuickPromptDialog || quickPromptDialogResultWritten) return;
    quickPromptDialogResultWritten = true;
    const blob = Object.assign({ ts: Date.now() }, result || {});
    try { localStorage.setItem(QUICK_PROMPT_DIALOG_RESULT_KEY, JSON.stringify(blob)); } catch (e) {}
  }

  async function runQuickPromptResult(payload, finalPrompt) {
    const text = String(finalPrompt || "").trim();
    if (!text) return;
    activateTab("ai");
    if (payload?.host === "pdf" || payload?.attachActivePdf) {
      await attachActivePdf({ silent: true });
    }
    runChatTurn(text);
  }

  async function submitQuickPrompt() {
    if (!quickPromptState?.payload) return;
    const payload = quickPromptState.payload;
    let finalPrompt = "";
    try {
      if (isImageQuickPrompt(payload)) {
        const imagePrompt = String(els.quickPromptBody?.querySelector("#quickPromptImageInput")?.value || "").trim();
        if (!imagePrompt) throw new Error("请先填写生图提示词。");
        const insertAtCursor = !!els.quickPromptBody?.querySelector("#quickPromptInsertAtCursor")?.checked;
        finalPrompt = buildImageQuickPrompt(payload, imagePrompt, insertAtCursor);
      } else {
        finalPrompt = buildGenericQuickPrompt(payload);
      }
    } catch (e) {
      showMessage(e?.message || String(e), "error");
      return;
    }

    if (isQuickPromptDialog) {
      writeQuickPromptDialogResult({ cancelled: false, prompt: finalPrompt, payload });
      try { if (typeof window.close === "function") window.close(); } catch (e) {}
      setTimeout(() => { showMessage("已提交，请点窗口右上角 × 关闭。", "info"); }, 100);
      return;
    }

    closeQuickPromptModal(false);
    await runQuickPromptResult(payload, finalPrompt);
  }

  function bindQuickPromptModal() {
    if (quickPromptBound) return;
    quickPromptBound = true;
    els.quickPromptSubmitBtn?.addEventListener("click", submitQuickPrompt);
    els.quickPromptCancelBtn?.addEventListener("click", () => closeQuickPromptModal(true));
    els.quickPromptCloseBtn?.addEventListener("click", () => closeQuickPromptModal(true));
    els.quickPromptModal?.addEventListener("click", (ev) => {
      if (ev.target === els.quickPromptModal) closeQuickPromptModal(true);
    });
    els.quickPromptBody?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (!(ev.metaKey || ev.ctrlKey)) return;
      ev.preventDefault();
      submitQuickPrompt();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (els.quickPromptModal && !els.quickPromptModal.classList.contains("hidden")) {
        closeQuickPromptModal(true);
      }
    });
  }

  async function consumeQuickPromptDialogResult() {
    if (isAnyDialogWindow()) return false;
    let raw = "";
    try { raw = localStorage.getItem(QUICK_PROMPT_DIALOG_RESULT_KEY) || ""; } catch (e) { return false; }
    if (!raw) return false;
    let result = null;
    try { result = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(QUICK_PROMPT_DIALOG_RESULT_KEY); } catch (e) {}
    if (!result || typeof result !== "object") return false;
    if (result.ts && result.ts === lastQuickPromptResultTs) return false;
    lastQuickPromptResultTs = result.ts || Date.now();
    if (result.cancelled) return true;
    if (result.prompt) {
      await runQuickPromptResult(result.payload || {}, result.prompt);
      return true;
    }
    return false;
  }

  function startQuickPromptDialogResultPolling() {
    if (isAnyDialogWindow()) return;
    if (quickPromptDialogPollTimer) clearInterval(quickPromptDialogPollTimer);
    let ticks = 0;
    quickPromptDialogPollTimer = setInterval(() => {
      ticks += 1;
      consumeQuickPromptDialogResult();
      if (ticks >= 600) {
        clearInterval(quickPromptDialogPollTimer);
        quickPromptDialogPollTimer = null;
      }
    }, 500);
  }

  async function openQuickPromptAsDialog(payload) {
    const hydrated = hydrateQuickPromptPayload(payload);
    resetQuickPromptStateIfNeeded();
    try {
      const base = global.WpsAiAddon?.getUrlPath?.() || "";
      const url = `${base}/taskpane.html?mode=quickprompt`;
      const app = global.WpsAiAddon?.getApplicationSync?.();
      if (app && typeof app.ShowDialog === "function") {
        rememberWriterInsertionRange();
        const request = Object.assign({}, hydrated, { ts: Date.now() });
        try { localStorage.setItem(QUICK_PROMPT_DIALOG_REQUEST_KEY, JSON.stringify(request)); } catch (e) {}
        try { localStorage.removeItem(QUICK_PROMPT_DIALOG_RESULT_KEY); } catch (e) {}
        const { w, h } = pickDialogSize(isImageQuickPrompt(hydrated) ? 620 : 560, isImageQuickPrompt(hydrated) ? 480 : 420, { minW: 480, minH: 360 });
        app.ShowDialog(url, `灵犀AI ${hydrated.label || "快捷操作"}`, w, h, true);
        try { activateWpsApp(app); } catch (e) {}
        setTimeout(() => { try { activateWpsApp(app); } catch (e) {} }, 120);
        await consumeQuickPromptDialogResult();
        startQuickPromptDialogResultPolling();
        return true;
      }
    } catch (e) {
      console.warn("[quick-prompt] ShowDialog 失败，回退到 inline modal:", e?.message || e);
    }
    return openQuickPromptInline(hydrated);
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

    // 「文件未保存」早判断：ribbon 触发的 AI 动作在 doc 没存到磁盘或有未保存改动时
    // 直接弹一个独立的提示框（alert）拒绝执行，**不切 Tab、不开弹窗、不在聊天流里留任何痕迹**——
    // 用户的意图是"提示一下就完了，按钮像没点过一样"。
    // 只对 wps/wpp/et 文档型宿主生效；PDF / 未识别宿主不拦。
    // 「PPT 风格预设 / 大纲」这两个纯展示 modal 不需要文档已保存；
    // 「素材库」虽是展示形态，但里面「插入到文档」按钮会写文档，所以也要校验。
    const skipSaveCheck = payload.kind === "open-modal"
      && ["stylePreset", "outline"].includes(payload.modal);
    if (!skipSaveCheck) {
      try {
        const saveState = global.WpsAiBackup?.getCurrentDocSaveState?.();
        if (saveState && !saveState.ok) {
          try { alert(saveState.hint); } catch (e) {}
          return;
        }
      } catch (e) { /* 探测失败兜底不拦，照旧分发 */ }
    }

    // 新增 kind=open-modal：ribbon 上点 PPT 风格 / 大纲生成 PPT 等需要弹窗的动作
    if (payload.kind === "open-modal") {
      activateTab("ai");
      if (payload.modal === "stylePreset") openStylePresetAsDialog();
      else if (payload.modal === "outline") openOutlineModal();
      else if (payload.modal === "unify") openUnifyModal();
      else if (payload.modal === "materialLibrary") openMaterialLibraryAsDialog();
      return;
    }

    activateTab("ai");

    if (payload.flow === "formatPreview") {
      await openFormatPreviewAsDialog();
      return;
    }

    if (payload.flow === "selectionTranslate" || payload.flow === "selectionOptimize") {
      await openSelectionPreviewAsDialog({
        intent: payload.flow === "selectionTranslate" ? "translate" : "optimize",
        targetLanguage: payload.targetLanguage || "简体中文",
        instruction: payload.instruction || ""
      });
      return;
    }

    if (payload.flow === "selectionTone") {
      await openSelectionPreviewAsDialog({
        intent: "tone",
        tone: payload.tone || payload.label || "改写",
        instruction: payload.instruction || ""
      });
      return;
    }

    if (payload.flow === "documentRewrite") {
      await openSelectionPreviewAsDialog({
        intent: "documentRewrite",
        tone: payload.tone || payload.label || "全文润色",
        instruction: payload.instruction || "",
        scope: "document"
      });
      return;
    }

    if (payload.flow === "documentReport") {
      await openSelectionPreviewAsDialog({
        intent: "documentReport",
        reportKind: payload.reportKind || "summary",
        tone: payload.tone || payload.label || "文档报告",
        instruction: payload.instruction || "",
        scope: "document"
      });
      return;
    }

    // prefill 类动作先收集用户输入，再合成为完整指令自动发送。
    if (payload.prefill && payload.prompt) {
      await openQuickPromptAsDialog(payload);
      return;
    }

    // PDF 宿主下任何 quick action 都自动把活动 PDF 当附件挂上去（前提是活动文档是 PDF）
    // —— AI 这样能直接看到 PDF 内容，不用再调 pdf_read_document 抓空字符串
    if (payload.host === "pdf" || payload.attachActivePdf) {
      await attachActivePdf({ silent: true });
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
  // 标尺常开 —— UI 上去掉了切换按钮（标尺一直可见，跟 PS / Figma 默认行为一致）
  function applyRulerVisibility(visible) {
    const frame = els.htmlPreviewFrame;
    const inner = frame?.parentElement;
    if (!inner) return;
    inner.classList.add("with-ruler");
    renderRulers();
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

  // 当前活动文档的稳定 key —— 历史对话 / HTML 模板历史 / 组件库 都按这个关联到文档。
  //   - 优先用 backup.readDocId() 读到的 UUID（跨重命名 / Save As / 跨机同步都稳） → 返回 "id:<uuid>"
  //   - 读不到 UUID（尚未 assign / PDF / 老文档）→ 保留旧行为，返回 backup.getCurrentDocPath()
  //     原样字符串，兼容之前 localStorage 里按裸路径存的老对话
  //   - 没打开文件 → 空串
  function getCurrentDocKey() {
    try {
      const backup = global.WpsAiBackup;
      const id = backup?.readDocId?.();
      if (id) return `id:${id}`;
      const p = backup?.getCurrentDocPath?.();
      return p ? String(p) : "";
    } catch (e) { return ""; }
  }

  let _cachedDocKey = "";
  function refreshCurrentDocKey() {
    try { _cachedDocKey = getCurrentDocKey(); } catch (e) { _cachedDocKey = ""; }
    return _cachedDocKey;
  }

  // 监听文档切换：每 1.5s 探一次当前 docKey；变了就触发 onDocChanged。
  // WPS 没有原生 doc-change 事件，只能轮询。1.5s 是体感"立即响应"的上限。
  let _docWatcherTimer = null;
  let _lastDocKey = "";
  function startDocWatcher(onDocChanged) {
    if (_docWatcherTimer) return;
    _lastDocKey = getCurrentDocKey();
    _cachedDocKey = _lastDocKey;
    _docWatcherTimer = setInterval(() => {
      try {
        const now = getCurrentDocKey();
        if (now !== _lastDocKey) {
          const prev = _lastDocKey;
          _lastDocKey = now;
          _cachedDocKey = now;
          try { onDocChanged?.(now, prev); } catch (e) {}
        }
      } catch (e) {}
    }, 1500);
  }

  function updateHtmlPreviewHistoryBadge() {
    try {
      const cache = global.WpsAiHtmlCache;
      const count = cache?.list?.({ docKey: _cachedDocKey })?.length || 0;
      if (els.htmlPreviewHistoryBtn) {
        els.htmlPreviewHistoryBtn.textContent = `历史 (${count})`;
      }
    } catch (e) {}
  }

  function renderHtmlPreviewHistory() {
    const host = els.htmlPreviewHistoryList;
    if (!host) return;
    const cache = global.WpsAiHtmlCache;
    // 历史按当前 PPT 过滤；没有 docKey 标记的 legacy 条目也一并展示（兼容）
    const entries = cache?.list?.({ limit: 20, docKey: _cachedDocKey }) || [];
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

  // 根据当前 state 同步「替换当前选中」按钮的显隐
  // 之前还有一个「替换第 N 页」按钮跟着 slideHint 动态显示，跟「替换当前选中」功能重叠且容易混淆，已下掉。
  function updateHtmlPreviewActionButtons() {
    const st = htmlPreviewState;
    const replaceActiveBtn = els.htmlPreviewReplaceActiveBtn;
    const insertBtn = els.htmlPreviewInsertBtn;
    if (!insertBtn) return;
    if (replaceActiveBtn) {
      if (st) replaceActiveBtn.classList.remove("hidden");
      else replaceActiveBtn.classList.add("hidden");
    }
    // 「整页存为组件」/「提取组件」只在 freeform 布局有意义
    const isFreeform = st?.layout === "freeform";
    const saveAsCompBtn = els.htmlPreviewSaveAsCompBtn;
    if (saveAsCompBtn) saveAsCompBtn.classList.toggle("hidden", !isFreeform);
    const extractBtn = els.htmlPreviewExtractCompsBtn;
    if (extractBtn) extractBtn.classList.toggle("hidden", !isFreeform);
    // 「编辑模式」按钮在任何 layout 都显示：非 freeform 时点击会自动把当前渲染结果
    // 转成 freeform（保留视觉）再进入编辑，让用户能拖拽 / 缩放 / 改文字。
    const editModeBtn = els.htmlPreviewEditModeBtn;
    if (editModeBtn) editModeBtn.classList.toggle("hidden", !st);
    // 撤销/重做按钮：只在编辑模式开启时显示（避免无 state 时的干扰）
    const undoBtn = els.htmlPreviewEditUndoBtn;
    const redoBtn = els.htmlPreviewEditRedoBtn;
    if (undoBtn) undoBtn.classList.toggle("hidden", !st || !_editorEnabled);
    if (redoBtn) redoBtn.classList.toggle("hidden", !st || !_editorEnabled);
    // 没 state → 自动退出编辑模式
    if (!st && _editorEnabled) disableIframeEditor();
    // 「选用组件」按钮的角标 = 当前 slide 已选组件数
    updatePickedComponentsCountBadge();
    // standalone（无 onConfirm）模式：是用户从历史召回打开的，需要兜底插入路径
    // 之前 slideN 跟着「替换第 N 页」按钮一起删了，这里重新读一下 st.slideHint
    if (!st?.onConfirm) {
      const slideN = st?.slideHint;
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
        // 工具流：调原 onConfirm（tool 自己处理插入）。
        // 关键：用户在「美化当前」可能让 AI 切了 layout（cover → freeform 等），
        // result.templateName / result.layout 是 dialog 关闭时的最新值，必须透传给 onConfirm，
        // 否则 presentation.js 闭包里用旧 layout 渲染 = 用户白美化。
        if (!result || result.cancelled) {
          try { cb(null); } catch (e) {}
        } else {
          try { cb({
            templateName: result.templateName,
            layout: result.layout,
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
          // 同上：替换不要再 save 新条目（doConfirm 已经 cache.update）
          const isReplaceLike = params.intent === "replace" || params.intent === "replace-active";
          if (isReplaceLike) params.saveToCache = false;
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
    // 拉一次当前 PPT 的 docKey —— 历史/组件按它过滤。每次开预览都重新拿，
    // 用户在不同 PPT 之间切换时自动跟着走。
    refreshCurrentDocKey();
    try { renderHtmlTemplateGallery(); updateHtmlPreviewHistoryBadge(); } catch (e) {}

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
      // ---- Tab：组件库（freeform 抽出的可复用 HTML+CSS 片段；只显示当前 PPT 或无 docKey 的 legacy 组件）----
      const comps = global.WpsAiHtmlComponents?.list?.({ docKey: _cachedDocKey }) || [];
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
      // ---- Tab：我的历史（从缓存读；只显示当前 PPT 或无 docKey 的 legacy 历史）----
      const cache = global.WpsAiHtmlCache;
      const entries = cache?.list?.({ limit: 20, docKey: _cachedDocKey }) || [];
      plog("gallery", "history tab; docKey=" + (_cachedDocKey || "(empty)")
        + " entries=" + entries.length
        + " curStateId=" + (curSt?.id || "(none)")
        + " ids=[" + entries.map((e) => e.id).join(",") + "]");
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
    // 替换 / 替换当前选中：doConfirm 顶部已经 cache.update(st.id) 了，这里再 saveToCache=true 会写重复
    // 一条历史。仅"插入到末尾"且没绑定到现有 cache 时才让 renderAndInsertSlide 内部 save 新条目。
    const isReplaceLike = params.intent === "replace" || params.intent === "replace-active";
    if (isReplaceLike || st.id) {
      params.saveToCache = false;
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
    // 关键修：插入 / 替换前**强制把编辑模式 DOM 序列化回 st.data.html**。
    // 之前只在「保存」按钮里加了这道兜底，但用户大部分时间是直接点「插入到末尾」/「替换当前选中」，
    // 那两条路径走 doConfirm 但完全没调 persist → 用户改动全丢，看到的 PPT 还是 AI 原始生成的版本。
    // persistEditorChangesToState 内部已经判断 st.layout==="freeform" 才操作，非 freeform 直接 return，无副作用。
    try { persistEditorChangesToState(); } catch (e) {}
    setHtmlPreviewBusy(true);
    try {
      // 写缓存
      try {
        if (st.id) {
          global.WpsAiHtmlCache?.update?.(st.id, {
            layout: st.layout,        // "美化当前"切换 layout 后要持久化到 cache，否则历史里召回还是旧 layout
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
            slideHint: st.slideHint,
            docKey: _cachedDocKey || st.docKey || ""
          });
          if (saved) st.id = saved.id;
        }
      } catch (e) { /* 缓存失败不阻塞 */ }

      if (st.onConfirm) {
        // 工具流：onConfirm 走原插入路径；replace / replace-active 由 onConfirm 内部按 intent 处理
        // 把 activeSlideIndex 一并传过去，让 presentation.js 的 onConfirm 能用稳定的页号
        // 关键修：把 templateName + layout 也传过去 —— 用户在「美化当前」里让 AI 切了 layout
        // （cover → freeform 之类）后，原 onConfirm 闭包里的 templateName/layout 是旧值，
        // 插入时还是按旧 layout 渲染，等于把美化结果全丢了。
        const onConfirm = st.onConfirm;
        st.onConfirm = null;
        await onConfirm({
          templateName: st.templateName,
          layout: st.layout,
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
        // 关键修复：之前忘了在 early return 前关「渲染中」徽章，导致用户看到永久"渲染中..."。
        // MAIN 已经接管渲染，dialog 这边的 busy 应该立刻收掉。
        setHtmlPreviewBusy(false);
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
    // 关键修：保存前强制把当前 iframe 的 DOM 序列化回 st.data.html。
    // 之前依赖 drag/resize/delete/apply 4 个调用点各自触发 persist，但有些路径漏触发
    // （键盘 nudge、撤销重做、快速 mouseup 没抓到等），保存时 st.data 还是旧的 → 用户感觉"保存没生效"。
    // 这里兜底，无论编辑模式开没开都过一遍：persistEditorChangesToState 内部已经判断了
    // st.layout==="freeform" 才操作，非 freeform 直接 return，无副作用。
    try { persistEditorChangesToState(); } catch (e) {}
    plog("save", "after persist; st.layout=" + st.layout
      + " st.id=" + (st.id || "(none)")
      + " htmlLen=" + String(st.data?.html || "").length
      + " htmlHead=" + String(st.data?.html || "").slice(0, 80).replace(/\n/g, "\\n")
      + " _cachedDocKey=" + (_cachedDocKey || "(empty)"));
    const payload = {
      templateName: st.templateName,
      layout: st.layout,
      data: Object.assign({}, st.data || {}),
      palette: Object.assign({}, st.palette || {}),
      slideHint: st.slideHint || null,
      // 新建保存兜底带上 docKey，避免画廊按当前 PPT 过滤后看不到这条新条目
      // （cache.update 路径不依赖这个字段，会保留原 entry 的 docKey）
      docKey: _cachedDocKey || "",
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
          plog("save", "cache.update OK id=" + st.id
            + " writtenHtmlLen=" + String(updated.data?.html || "").length
            + " ts=" + updated.ts
            + " docKey=" + (updated.docKey || "(empty)"));
        } else {
          // 老的 id 已被清空 / 找不到，回退成 save 新建
          const saved = cache.save(payload);
          st.id = saved.id;
          action = "新建保存";
          plog("save", "cache.update returned null → fallback save; new id=" + saved.id);
        }
      } else {
        const saved = cache.save(payload);
        st.id = saved.id;
        action = "新建保存";
        plog("save", "cache.save (new) id=" + saved.id
          + " docKey=" + (saved.docKey || "(empty)"));
      }
      // 读回去验证写入有没有真正落地（排查"localStorage 写后又被旁路覆盖"的可能）
      try {
        const verify = cache.get?.(st.id);
        plog("save", "verify cache.get; htmlLen=" + String(verify?.data?.html || "").length
          + " ts=" + verify?.ts
          + " docKey=" + (verify?.docKey || "(empty)")
          + " match=" + (verify?.data?.html === st.data?.html ? "Y" : "N"));
      } catch (e) {}
      // chat 会话的 binding key 跟 state.id 挂钩；新建保存让 id 从空变有值时 key 会变，
      // 要把旧 key 下的 chat 日志**搬到**新 key，下次切回这条历史还能看到原对话。
      const newKey = previewStateKey(st);
      if (newKey !== oldKey && previewChatLogByKey.has(oldKey)) {
        previewChatLogByKey.set(newKey, previewChatLogByKey.get(oldKey));
        previewChatLogByKey.delete(oldKey);
        savePreviewChatLogsToStorage();
      }
      _previewChatBoundKey = newKey;
      // 关键：清掉这条历史在 gallery 里的缓存卡片，让 renderHtmlTemplateGallery
      // 强制重建（不走 sig diff 复用）—— 之前用户报"保存了但历史里那张缩略图没更新"，
      // 多数情况是 sig 算出来一样（ts 同帧没变 / iframe srcdoc 浏览器缓存）卡没重建。
      // 显式清缓存后会用最新 entry.data 重新渲染 iframe srcdoc，缩略图同步。
      try {
        if (_galleryCardCache && st.id) {
          const cardKey = `hist::${st.id}`;
          const cached = _galleryCardCache.get(cardKey);
          if (cached?.el?.parentNode) cached.el.parentNode.removeChild(cached.el);
          _galleryCardCache.delete(cardKey);
        }
      } catch (e) {}
      // 刷新左侧画廊（新条目要立刻显示 + 高亮）和顶部历史角标
      renderHtmlTemplateGallery();
      updateHtmlPreviewHistoryBadge();
      // 视觉反馈：让刚保存的那张卡短暂高亮（蓝边 + 微缩放），让用户一眼看到"那张更新了"
      try {
        const host = els.htmlTemplateGalleryList;
        const card = host?.querySelector(`[data-gallery-key="hist::${st.id}"]`);
        if (card) {
          card.classList.add("just-saved");
          card.scrollIntoView({ block: "nearest", behavior: "smooth" });
          setTimeout(() => { try { card.classList.remove("just-saved"); } catch (e) {} }, 1500);
        }
      } catch (e) {}
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
        name, description: desc, html, css, sourceSlideId: st.id || null,
        docKey: _cachedDocKey || ""
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
  // 对齐参考线 + 吸附（参考 PS / Figma 的 smart guide）
  let _editorGuideLayer = null;            // iframe 内承载参考线 + 坐标 hint 的 div
  let _editorPosHint = null;               // 拖动时光标边的小坐标徽章
  const SNAP_PX = 6;                       // 吸附阈值（iframe 内 1920×1080 像素）
  const GUIDE_COLOR_STAGE = "#FF3B5C";     // 画布边/中线参考线 = 红
  const GUIDE_COLOR_EL = "#22D3EE";        // 元素对齐参考线 = 青

  const EDITOR_SEL_OVERLAY_ID   = "__lingxi_editor_sel_overlay__";
  const EDITOR_HOVER_OVERLAY_ID = "__lingxi_editor_hover_overlay__";
  const EDITOR_GUIDE_LAYER_ID   = "__lingxi_editor_guides__";
  const EDITOR_POS_HINT_ID      = "__lingxi_editor_poshint__";

  // 判断一个 DOM 节点是不是我们注入的编辑器装饰元素
  function isEditorChromeEl(el) {
    if (!el || !el.closest) return false;
    return !!(
      el.closest(`#${EDITOR_SEL_OVERLAY_ID}`) ||
      el.closest(`#${EDITOR_HOVER_OVERLAY_ID}`) ||
      el.closest(`#${EDITOR_GUIDE_LAYER_ID}`) ||
      el.closest(`#${EDITOR_POS_HINT_ID}`) ||
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
    plog("editor", "enableIframeEditor: hasIfr=" + !!ifr + " hasDoc=" + !!doc + " hasBody=" + !!doc?.body);
    if (!doc || !doc.body) return;
    // 注入编辑器 CSS（idempotent）—— 把手做大到 96px / 64px font，1920×1080 缩到 0.3 时仍清晰
    if (!doc.getElementById("__lingxi_editor_css")) {
      const style = doc.createElement("style");
      style.id = "__lingxi_editor_css";
      style.textContent = `
        body.__lingxi_editing, body.__lingxi_editing * { cursor: crosshair !important; }
        /* 编辑模式下强制所有用户内容（含装饰层、SVG、被 pointer-events:none 标过的元素）都能被命中。
           我们自己注入的所有"chrome"装饰层都要排除掉，否则它们会用 !important 抢走 pointer-events
           → 用户点击落到装饰层上 → 进 isEditorChromeEl 拦截 → 一直 "chrome el, ignore"。
           特别是 guide layer 占满 1920×1080，第一次拖动后只清 innerHTML 不移除节点，
           会永久挡住所有 mousedown。 */
        body.__lingxi_editing :not(#${EDITOR_SEL_OVERLAY_ID}):not(#${EDITOR_HOVER_OVERLAY_ID}):not(#${EDITOR_GUIDE_LAYER_ID}):not(#${EDITOR_POS_HINT_ID}):not(#__lingxi_editor_marquee__):not(#__lingxi_editor_multi_overlay__) {
          pointer-events: auto !important;
        }
        /* 反向兜底：装饰层本体显式 none（被上面 :not 排除后会用各自 inline / 这条规则的 none） */
        body.__lingxi_editing #${EDITOR_GUIDE_LAYER_ID},
        body.__lingxi_editing #${EDITOR_POS_HINT_ID},
        body.__lingxi_editing #__lingxi_editor_marquee__ {
          pointer-events: none !important;
        }
        /* resize 把手 / 操作按钮的 cursor 用 !important 抢回（顶上面那条 crosshair）。
           八向 resize 显示对应方向箭头；3 个图标按钮显示 pointer；选中框本体（hover/sel overlay 边线）显示 move */
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-handle { cursor: pointer !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-nw,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-se { cursor: nwse-resize !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-ne,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-sw { cursor: nesw-resize !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-n,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-s { cursor: ns-resize !important; }
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-e,
        body.__lingxi_editing #${EDITOR_SEL_OVERLAY_ID} .ed-resize-w { cursor: ew-resize !important; }
        /* 被选中元素本身 hover 时改 move 光标（暗示可拖动）—— 用类名标记，selectEditorElement 时挂 */
        body.__lingxi_editing .__lingxi_selected_move { cursor: move !important; }
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
        /* 默认：3 个把手在元素上方外侧，save/edit 贴左侧，del 贴右侧。
           适合较宽元素（≥ 220px）；窄元素会让 edit 和 del 互相挤压重叠（bug 已修，见 narrow 模式）。 */
        #${EDITOR_SEL_OVERLAY_ID} .ed-save   { top: -70px; left: -6px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-edit   { top: -70px; left: 60px; }
        #${EDITOR_SEL_OVERLAY_ID} .ed-del    { top: -70px; right: -6px; }
        /* 窄元素模式：3 个把手都左对齐，固定间距，跟元素宽度解耦 ——
           del 不再用 right:-6px 跟元素右边走，避免跟 edit 在窄宽下重叠。
           工具栏总宽 ~196px（60×3 + 8×2 间距），向元素右侧外伸属正常表现。 */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-narrow .ed-save  { top: -70px; left: -6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-narrow .ed-edit  { top: -70px; left: 60px; right: auto; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-narrow .ed-del   { top: -70px; left: 130px; right: auto; }
        /* 上面空间不够 → 把把手贴到元素内部顶部，避免被画布上边裁掉 */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-save   { top: 6px; left: 6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-edit   { top: 6px; left: 72px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside .ed-del    { top: 6px; right: 6px; }
        /* 内嵌 + 窄：把手仍按窄模式左对齐，但 top 改成内嵌的 6px */
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside.ed-handles-narrow .ed-save  { top: 6px; left: 6px; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside.ed-handles-narrow .ed-edit  { top: 6px; left: 72px; right: auto; }
        #${EDITOR_SEL_OVERLAY_ID}.ed-handles-inside.ed-handles-narrow .ed-del   { top: 6px; left: 142px; right: auto; }
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
    doc.addEventListener("keydown", editorOnKeyDown, true);
    _editorEnabled = true;
    updateEditModeBtnLabel();
    // 进入编辑模式：把"初始状态"压栈，给第一次操作前留个还原点
    clearEditorUndoStacks();
    pushEditorUndoSnapshot();
    // 撤销/重做按钮可见性跟随编辑模式
    try { updateHtmlPreviewActionButtons(); } catch (e) {}
  }

  // Ctrl/Cmd + Z 撤销；Ctrl/Cmd + Y 或 Ctrl+Shift+Z 重做
  function editorOnKeyDown(ev) {
    if (!_editorEnabled) return;
    const isUndo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === "z" || ev.key === "Z");
    const isRedo = ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || ev.key === "Y"))
      || ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === "z" || ev.key === "Z"));
    if (isUndo) { ev.preventDefault(); editorUndo(); }
    else if (isRedo) { ev.preventDefault(); editorRedo(); }
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
      doc.removeEventListener("keydown", editorOnKeyDown, true);
    }
    clearEditorSelection();
    clearEditorMultiSelection();
    cleanupMarquee();
    _editorDestroyGuides();
    // 退出编辑模式：清撤销栈，按钮收回 disabled 状态 + 隐藏
    clearEditorUndoStacks();
    try { updateHtmlPreviewActionButtons(); } catch (e) {}
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
    if (_editorSelectedEl) {
      try { _editorSelectedEl.classList.remove("__lingxi_selected_move"); } catch (e) {}
    }
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
    if (!target) { plog("editor", "click: empty → clear selection"); clearEditorSelection(); return; }
    plog("editor", "click: select " + target.tagName + (target.className ? "." + String(target.className).split(" ")[0] : ""));
    selectEditorElement(target);
  }

  // ---- mousedown：
  //   resize 把手 → resize
  //   多选 overlay 上 → 整组拖动
  //   按在单选元素上 → 单元素拖动
  //   按在空白（body / html）上 → 开始圈选 marquee
  function editorOnDocMouseDown(ev) {
    if (!_editorEnabled) { plog("editor", "mousedown: editor disabled, ignore"); return; }
    const action = ev.target?.closest?.("[data-action]")?.dataset?.action;
    if (action === "resize") {
      ev.preventDefault(); ev.stopPropagation();
      const dir = ev.target?.closest?.("[data-resize-dir]")?.dataset?.resizeDir || "se";
      plog("editor", "mousedown: resize dir=" + dir);
      startEditorDrag(ev, "resize", dir);
      return;
    }
    if (action === "multi-move") {
      ev.preventDefault(); ev.stopPropagation();
      plog("editor", "mousedown: multi-move");
      startEditorGroupDrag(ev);
      return;
    }
    if (isEditorChromeEl(ev.target)) { plog("editor", "mousedown: chrome el, ignore"); return; }
    const doc = ev.target?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    const target = realElementAt(doc, ev.clientX, ev.clientY);
    // 单选拖动
    if (_editorSelectedEl && target && (target === _editorSelectedEl || _editorSelectedEl.contains(target))) {
      ev.preventDefault(); ev.stopPropagation();
      plog("editor", "mousedown: move (selected) targetTag=" + (target?.tagName || "(none)"));
      startEditorDrag(ev, "move");
      return;
    }
    // 按在空白处（target = null 表示击中 body / html） → 开始圈选
    if (!target) {
      ev.preventDefault(); ev.stopPropagation();
      plog("editor", "mousedown: empty space → marquee");
      startEditorMarquee(ev, doc);
      return;
    }
    plog("editor", "mousedown: no-op (target=" + target.tagName + " selected=" + (_editorSelectedEl?.tagName || "(none)") + ") — click will select");
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
    pushEditorUndoSnapshot();
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
    pushEditorUndoSnapshot();
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
    // 加 move 光标提示，hover 在元素本体上就能看出是"可拖动"
    try { el.classList.add("__lingxi_selected_move"); } catch (e) {}
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
    // 智能避让：选中态 overlay 才有 ed-* 把手
    if (overlay.id === EDITOR_SEL_OVERLAY_ID) {
      // 元素顶部空间 < 80px（把手 60 + margin）→ 内嵌
      const needAbove = 80;
      const insideMode = r.top < needAbove;
      overlay.classList.toggle("ed-handles-inside", insideMode);
      // 元素宽度 < 220px（3 个 60px 把手 + 间距）→ 启动窄模式：3 个把手左对齐固定间距，
      // 不再让 del 跟着元素右边走，避免跟 edit 在窄宽下重叠遮挡（用户报的 bug）。
      const needWidth = 220;
      const narrowMode = r.width < needWidth;
      overlay.classList.toggle("ed-handles-narrow", narrowMode);
    }
  }
  function positionEditorOverlay() {
    if (_editorSelectedEl && _editorSelOverlay) positionRectTo(_editorSelOverlay, _editorSelectedEl);
  }

  // ========== Smart guides + 吸附（参考 PS / Figma） ==========
  //
  // 设计：拖动期间扫描 stage 内所有元素的 6 个锚点（left/cx/right + top/cy/bottom）
  // 加上画布的 6 个锚点。被拖元素的对应锚点距离任意目标 ≤ SNAP_PX 时吸附到它，
  // 并在 iframe 内画一条参考线（画布=红色，元素对齐=青色）。
  // Shift 临时关闭吸附（跟 Figma 一致）。

  function _editorGetSnapTargets(excludeEls) {
    const frame = els.htmlPreviewFrame;
    const doc = frame?.contentDocument;
    if (!doc) return { xs: [], ys: [] };
    const stage = doc.querySelector(".stage") || doc.body;
    const stageR = stage.getBoundingClientRect();
    const xs = [
      { v: stageR.left,                          kind: "stage" },
      { v: (stageR.left + stageR.right) / 2,     kind: "stage" },
      { v: stageR.right,                         kind: "stage" }
    ];
    const ys = [
      { v: stageR.top,                           kind: "stage" },
      { v: (stageR.top + stageR.bottom) / 2,     kind: "stage" },
      { v: stageR.bottom,                        kind: "stage" }
    ];
    const skip = new Set(excludeEls || []);
    // 只看 stage 的 1 级 + 2 级子元素，避免文字节点把锚点数量打爆（性能 + 视觉清晰度）
    const candidates = [];
    Array.from(stage.children).forEach((c) => {
      if (!isEditorChromeEl(c)) candidates.push(c);
      Array.from(c.children || []).forEach((cc) => {
        if (!isEditorChromeEl(cc)) candidates.push(cc);
      });
    });
    candidates.forEach((el) => {
      if (skip.has(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      xs.push({ v: r.left,                kind: "el", el });
      xs.push({ v: (r.left + r.right)/2,  kind: "el", el });
      xs.push({ v: r.right,               kind: "el", el });
      ys.push({ v: r.top,                 kind: "el", el });
      ys.push({ v: (r.top + r.bottom)/2,  kind: "el", el });
      ys.push({ v: r.bottom,              kind: "el", el });
    });
    return { xs, ys };
  }

  // 对一组"被拖元素锚点"找最近吸附目标，返回 { snap: 像素调整, hits: [{ v, kind }] }
  // anchors 是当前要测的位置数组（如 [left, cx, right] 在水平方向）
  function _editorComputeSnap(anchors, candidates) {
    let best = null;  // { d, delta }
    let hits = [];
    for (const a of anchors) {
      for (const c of candidates) {
        const d = Math.abs(c.v - a);
        if (d > SNAP_PX) continue;
        if (!best || d < best.d - 0.001) {
          best = { d, delta: c.v - a };
          hits = [{ v: c.v, kind: c.kind }];
        } else if (Math.abs(d - best.d) < 0.5) {
          // 同距离的额外吸附点也画线（如左右两条同时对齐）
          if (!hits.some((h) => Math.abs(h.v - c.v) < 0.5)) {
            hits.push({ v: c.v, kind: c.kind });
          }
        }
      }
    }
    return { delta: best ? best.delta : 0, hits };
  }

  function _editorEnsureGuideLayer() {
    const frame = els.htmlPreviewFrame;
    const doc = frame?.contentDocument;
    if (!doc) return null;
    if (_editorGuideLayer && _editorGuideLayer.ownerDocument === doc) return _editorGuideLayer;
    let layer = doc.getElementById(EDITOR_GUIDE_LAYER_ID);
    if (!layer) {
      layer = doc.createElement("div");
      layer.id = EDITOR_GUIDE_LAYER_ID;
      layer.style.cssText = "position:absolute;top:0;left:0;width:1920px;height:1080px;pointer-events:none;z-index:99999998";
      doc.body.appendChild(layer);
    }
    _editorGuideLayer = layer;
    return layer;
  }

  // 画一条参考线。orient: "v"=竖线（按 X 位置）/ "h"=横线
  function _editorDrawGuide(orient, position, kind) {
    const layer = _editorEnsureGuideLayer();
    if (!layer) return;
    const color = kind === "stage" ? GUIDE_COLOR_STAGE : GUIDE_COLOR_EL;
    const line = layer.ownerDocument.createElement("div");
    if (orient === "v") {
      line.style.cssText = `position:absolute;top:0;bottom:0;left:${position}px;width:0;border-left:1px dashed ${color};box-shadow:0 0 0 0.5px ${color}`;
    } else {
      line.style.cssText = `position:absolute;left:0;right:0;top:${position}px;height:0;border-top:1px dashed ${color};box-shadow:0 0 0 0.5px ${color}`;
    }
    layer.appendChild(line);
  }

  function _editorClearGuides() {
    if (_editorGuideLayer) _editorGuideLayer.innerHTML = "";
  }
  function _editorDestroyGuides() {
    if (_editorGuideLayer) { try { _editorGuideLayer.remove(); } catch (e) {} _editorGuideLayer = null; }
    if (_editorPosHint)    { try { _editorPosHint.remove(); }    catch (e) {} _editorPosHint    = null; }
  }

  // 拖动时光标右下角的小坐标提示徽章："w × h · x,y"
  function _editorShowPosHint(x, y, w, h) {
    const frame = els.htmlPreviewFrame;
    const doc = frame?.contentDocument;
    if (!doc) return;
    if (!_editorPosHint) {
      _editorPosHint = doc.createElement("div");
      _editorPosHint.id = EDITOR_POS_HINT_ID;
      _editorPosHint.style.cssText = [
        "position:absolute","z-index:99999999","pointer-events:none",
        "background:#0F172A","color:#fff",
        "padding:6px 12px","border-radius:6px",
        "font:600 18px/1.2 ui-monospace,Menlo,Consolas,monospace",
        "white-space:nowrap","box-shadow:0 4px 12px rgba(0,0,0,0.35)"
      ].join(";");
      doc.body.appendChild(_editorPosHint);
    }
    _editorPosHint.style.left = (x + 12) + "px";
    _editorPosHint.style.top  = (y + 12) + "px";
    _editorPosHint.textContent = `${Math.round(w)} × ${Math.round(h)} · ${Math.round(x)}, ${Math.round(y)}`;
  }

  function startEditorDrag(ev, mode, dir) {
    const el = _editorSelectedEl;
    if (!el) return;
    // 拖 / resize 开始前先快照当前状态进 undo 栈
    pushEditorUndoSnapshot();
    const doc = el.ownerDocument;
    const cs = doc.defaultView.getComputedStyle(el);
    let curTx = 0, curTy = 0;
    const m = (el.style.transform || cs.transform || "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    if (m) { curTx = parseFloat(m[1]); curTy = parseFloat(m[2]); }
    // 快照拖动起点的 bbox + 全部吸附目标。吸附目标排除自己（拖动时不能跟自己对齐）。
    const startBbox = el.getBoundingClientRect();
    const snapTargets = _editorGetSnapTargets([el]);
    _editorDragState = {
      mode,
      // 修 #14: dir 决定哪几个轴受影响（n/s/e/w 任意组合）。move 模式忽略 dir
      dir: dir || "se",
      startX: ev.clientX, startY: ev.clientY,
      startW: parseFloat(cs.width) || el.offsetWidth,
      startH: parseFloat(cs.height) || el.offsetHeight,
      startTx: curTx, startTy: curTy,
      startBbox: { l: startBbox.left, t: startBbox.top, r: startBbox.right, b: startBbox.bottom, w: startBbox.width, h: startBbox.height },
      snapTargets,
      moved: false
    };
    if (_editorHoverOverlay) _editorHoverOverlay.style.display = "none";
    _editorEnsureGuideLayer();
    doc.addEventListener("mousemove", editorOnMouseMove, true);
    doc.addEventListener("mouseup",   editorOnMouseUp,   true);
  }

  function editorOnMouseMove(ev) {
    const ds = _editorDragState;
    if (!ds) return;
    const dx = ev.clientX - ds.startX;
    const dy = ev.clientY - ds.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ds.moved = true;
    // 拖动期间持 shift 暂时禁用吸附，跟 Figma/PS 一致
    const snapOn = !ev.shiftKey && ds.snapTargets;

    if (ds.mode === "group-move") {
      // 多选拖动：所有成员同时平移（暂不上吸附；多选 union 锚点意义有限）
      ds.groupStates.forEach((s) => {
        s.el.style.transform = `translate(${s.startTx + dx}px, ${s.startTy + dy}px)`;
      });
      renderMultiSelOverlay();
      return;
    }
    const el = _editorSelectedEl;
    if (!el) return;

    _editorClearGuides();

    if (ds.mode === "move") {
      // 提议 bbox（不含吸附）
      const propL = ds.startBbox.l + dx;
      const propT = ds.startBbox.t + dy;
      const propR = propL + ds.startBbox.w;
      const propB = propT + ds.startBbox.h;
      let snapDx = 0, snapDy = 0;
      let hitsX = [], hitsY = [];
      if (snapOn) {
        const sx = _editorComputeSnap(
          [propL, (propL + propR) / 2, propR],
          ds.snapTargets.xs
        );
        const sy = _editorComputeSnap(
          [propT, (propT + propB) / 2, propB],
          ds.snapTargets.ys
        );
        snapDx = sx.delta;
        snapDy = sy.delta;
        hitsX = sx.hits;
        hitsY = sy.hits;
      }
      el.style.transform = `translate(${ds.startTx + dx + snapDx}px, ${ds.startTy + dy + snapDy}px)`;
      // 画吸附时命中的参考线
      hitsX.forEach((h) => _editorDrawGuide("v", h.v, h.kind));
      hitsY.forEach((h) => _editorDrawGuide("h", h.v, h.kind));
      // 坐标 hint：相对画布 0,0 的 x/y
      const finalL = propL + snapDx;
      const finalT = propT + snapDy;
      const stage = el.ownerDocument.querySelector(".stage");
      const sR = stage?.getBoundingClientRect();
      const relX = sR ? finalL - sR.left : finalL;
      const relY = sR ? finalT - sR.top  : finalT;
      _editorShowPosHint(finalL + ds.startBbox.w, finalT + ds.startBbox.h, ds.startBbox.w, ds.startBbox.h);
      // 顺手在 hint 后塞画布相对坐标
      if (_editorPosHint) {
        _editorPosHint.textContent = `${Math.round(ds.startBbox.w)} × ${Math.round(ds.startBbox.h)} · 画布 ${Math.round(relX)}, ${Math.round(relY)}`;
      }
    } else if (ds.mode === "resize") {
      // 修 #14: dir 里含 e/w 决定宽度改不改 + 是否要反向平移；含 n/s 决定高度
      const dir = ds.dir || "se";
      let newW = ds.startW;
      let newH = ds.startH;
      let dtx = 0, dty = 0;
      if (dir.includes("e")) {
        newW = Math.max(20, ds.startW + dx);
      } else if (dir.includes("w")) {
        newW = Math.max(20, ds.startW - dx);
        dtx = ds.startW - newW;
      }
      if (dir.includes("s")) {
        newH = Math.max(20, ds.startH + dy);
      } else if (dir.includes("n")) {
        newH = Math.max(20, ds.startH - dy);
        dty = ds.startH - newH;
      }
      // 计算 resize 后实际 bbox（基于原 startBbox 修正），然后对正被拖的边吸附
      const propL = ds.startBbox.l + dtx;
      const propT = ds.startBbox.t + dty;
      let propR = propL + newW;
      let propB = propT + newH;
      let propLFinal = propL, propTFinal = propT;
      if (snapOn) {
        // 仅吸附被拖的那条边对应的锚点（se 句柄就吸右下，nw 句柄就吸左上）
        const xAnchors = [];
        if (dir.includes("e")) xAnchors.push(propR);
        if (dir.includes("w")) xAnchors.push(propL);
        const yAnchors = [];
        if (dir.includes("s")) yAnchors.push(propB);
        if (dir.includes("n")) yAnchors.push(propT);
        if (xAnchors.length) {
          const sx = _editorComputeSnap(xAnchors, ds.snapTargets.xs);
          if (sx.delta) {
            if (dir.includes("e")) { newW += sx.delta; propR += sx.delta; }
            else if (dir.includes("w")) {
              // 左边界往右吸 = 减宽 + 整体右移
              newW -= sx.delta; propLFinal += sx.delta; dtx += sx.delta;
            }
          }
          sx.hits.forEach((h) => _editorDrawGuide("v", h.v, h.kind));
        }
        if (yAnchors.length) {
          const sy = _editorComputeSnap(yAnchors, ds.snapTargets.ys);
          if (sy.delta) {
            if (dir.includes("s")) { newH += sy.delta; propB += sy.delta; }
            else if (dir.includes("n")) {
              newH -= sy.delta; propTFinal += sy.delta; dty += sy.delta;
            }
          }
          sy.hits.forEach((h) => _editorDrawGuide("h", h.v, h.kind));
        }
      }
      if (newW !== ds.startW) el.style.width = Math.max(20, newW) + "px";
      if (newH !== ds.startH) el.style.height = Math.max(20, newH) + "px";
      if (dtx || dty) {
        el.style.transform = `translate(${ds.startTx + dtx}px, ${ds.startTy + dty}px)`;
      }
      const stage = el.ownerDocument.querySelector(".stage");
      const sR = stage?.getBoundingClientRect();
      const relX = sR ? propLFinal - sR.left : propLFinal;
      const relY = sR ? propTFinal - sR.top  : propTFinal;
      _editorShowPosHint(propR, propB, newW, newH);
      if (_editorPosHint) {
        _editorPosHint.textContent = `${Math.round(newW)} × ${Math.round(newH)} · 画布 ${Math.round(relX)}, ${Math.round(relY)}`;
      }
    }
    positionEditorOverlay();
  }
  function editorOnMouseUp() {
    const ds = _editorDragState;
    if (!ds) { plog("editor", "mouseup: no drag state (click without drag)"); return; }
    const moved = ds.moved;
    plog("editor", "mouseup: mode=" + ds.mode + " moved=" + moved + " willPersist=" + (moved ? "Y" : "N"));
    _editorDragState = null;
    const el = _editorSelectedEl || (ds.groupStates?.[0]?.el);
    const doc = el?.ownerDocument || els.htmlPreviewFrame?.contentDocument;
    if (doc) {
      doc.removeEventListener("mousemove", editorOnMouseMove, true);
      doc.removeEventListener("mouseup",   editorOnMouseUp,   true);
    }
    // 清理参考线 + 坐标 hint（不论是否真的拖动了）
    _editorClearGuides();
    if (_editorPosHint) { try { _editorPosHint.remove(); } catch (e) {} _editorPosHint = null; }
    if (moved) {
      // 拖完后浏览器可能（且仅在距离很小时）派发一次合成 click，我们吃掉避免误清选。
      // 关键：100ms 后自动失效。Chrome 在拖动距离 > ~5px 后压根不发这次 click，
      // 没有 setTimeout 的话 _editorJustDragged 会卡住 true 直到下次用户真的点击 ——
      // 那次真实点击被吃掉 → 用户感觉"拖完后再点别的没反应"。
      _editorJustDragged = true;
      setTimeout(() => { _editorJustDragged = false; }, 100);
      persistEditorChangesToState();
      // bake 完元素 left/top 改了，sel overlay 必须跟着复位到元素新 bbox 上 ——
      // 否则用户按习惯往旧 overlay 位置的 save/edit/del 按钮点，触发 isEditorChromeEl=true
      // → "mousedown: chrome el, ignore" → 用户感觉拖完之后再也点不动了，必须退出再进编辑模式。
      try { positionEditorOverlay(); } catch (e) {}
    }
  }

  // 删除选中元素
  function editorDeleteSelected() {
    const el = _editorSelectedEl;
    if (!el) return;
    pushEditorUndoSnapshot();
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
    pushEditorUndoSnapshot();
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
      // 关键修：base 用 inline 优先，inline 为空时回退到 computed style（含 CSS 类规则）。
      // 之前只读 inline.style.left 永远拿 0，导致首次拖 CSS-positioned 元素时
      // bake 把 left:200px 的元素直接重置到 left:dx（变成 50px 之类），
      // 用户保存后看历史缩略图，元素跑到完全错误位置 = 用户报的"变回原来的样子"。
      const inlineLeft = el.style.left;
      const inlineTop = el.style.top;
      // computed.left 对未定位元素是 "auto"；parseFloat("auto") 返回 NaN，|| 0 落空
      const csLeftPx = parseFloat(cs.left);
      const csTopPx  = parseFloat(cs.top);
      const baseLeft = inlineLeft ? parseFloat(inlineLeft) : (isFinite(csLeftPx) ? csLeftPx : 0);
      const baseTop  = inlineTop  ? parseFloat(inlineTop)  : (isFinite(csTopPx)  ? csTopPx  : 0);
      if (!isPositioned) el.style.position = "relative";
      el.style.left = (baseLeft + dx) + "px";
      el.style.top = (baseTop + dy) + "px";
      // 移除 translate；保留可能存在的其他 transform 函数（如 rotate）
      const restTransform = inline.replace(/translate\([^)]*\)/, "").trim();
      if (restTransform) el.style.transform = restTransform;
      else el.style.removeProperty("transform");
    });
  }

  // ========== 撤销 / 重做（编辑模式）==========
  // 简单 push/pop 栈：每次"实质性编辑"（drag end / resize end / delete / apply popup）
  // 前 pushUndo 当前 stage.innerHTML，撤销 = pop undo 推 redo 还原 DOM。
  // 不录碎屑（mousemove 期间的中间态），所以不会乱炸。栈深 50。
  const EDITOR_UNDO_LIMIT = 50;
  let _editorUndoStack = [];
  let _editorRedoStack = [];
  let _editorSuspendCapture = false; // restoreSnapshot 期间避免再 pushUndo

  function getEditorStageHtml() {
    const doc = els.htmlPreviewFrame?.contentDocument;
    const stage = doc?.querySelector(".stage") || doc?.body;
    return stage ? stage.innerHTML : "";
  }
  function setEditorStageHtml(html) {
    const doc = els.htmlPreviewFrame?.contentDocument;
    const stage = doc?.querySelector(".stage") || doc?.body;
    if (!stage) return;
    // 退出当前选中 / overlay 状态后再写，否则 overlay DOM 会被吃掉
    try { clearEditorSelection(); } catch (e) {}
    try { clearEditorMultiSelection?.(); } catch (e) {}
    stage.innerHTML = html;
  }
  function pushEditorUndoSnapshot() {
    if (_editorSuspendCapture) return;
    if (!htmlPreviewState || htmlPreviewState.layout !== "freeform") return;
    const snap = getEditorStageHtml();
    if (!snap) return;
    // 跟栈顶一样就不重复入（避免 drag 多次相邻同状态污染）
    if (_editorUndoStack.length && _editorUndoStack[_editorUndoStack.length - 1] === snap) return;
    _editorUndoStack.push(snap);
    if (_editorUndoStack.length > EDITOR_UNDO_LIMIT) _editorUndoStack.shift();
    // 一旦有新编辑就清掉 redo（线性编辑，不分支）
    _editorRedoStack = [];
    updateEditorUndoRedoButtons();
  }
  function editorUndo() {
    if (!_editorUndoStack.length) return;
    const current = getEditorStageHtml();
    const prev = _editorUndoStack.pop();
    if (current) _editorRedoStack.push(current);
    _editorSuspendCapture = true;
    try {
      setEditorStageHtml(prev);
      persistEditorChangesToState();
    } finally {
      _editorSuspendCapture = false;
    }
    updateEditorUndoRedoButtons();
  }
  function editorRedo() {
    if (!_editorRedoStack.length) return;
    const current = getEditorStageHtml();
    const next = _editorRedoStack.pop();
    if (current) _editorUndoStack.push(current);
    _editorSuspendCapture = true;
    try {
      setEditorStageHtml(next);
      persistEditorChangesToState();
    } finally {
      _editorSuspendCapture = false;
    }
    updateEditorUndoRedoButtons();
  }
  function updateEditorUndoRedoButtons() {
    if (els.htmlPreviewEditUndoBtn) els.htmlPreviewEditUndoBtn.disabled = _editorUndoStack.length === 0;
    if (els.htmlPreviewEditRedoBtn) els.htmlPreviewEditRedoBtn.disabled = _editorRedoStack.length === 0;
  }
  function clearEditorUndoStacks() {
    _editorUndoStack = [];
    _editorRedoStack = [];
    updateEditorUndoRedoButtons();
  }

  // 把 iframe body 当前 innerHTML（去掉 overlay）序列化回 st.data.html
  function persistEditorChangesToState() {
    const st = htmlPreviewState;
    const ifr = els.htmlPreviewFrame;
    const doc = ifr?.contentDocument;
    if (!st) { plog("persist", "skipped: no state"); return; }
    if (!doc?.body) { plog("persist", "skipped: iframe contentDocument unavailable"); return; }
    if (st.layout !== "freeform") { plog("persist", "skipped: layout=" + st.layout + " (not freeform)"); return; }
    // 找回 .stage 容器（freeform 把 html 包在 .stage 里）—— 直接读 .stage.innerHTML
    const stage = doc.querySelector(".stage") || doc.body;
    // 序列化前先把 transform 烘焙成 left/top，让 HTML 自带正确坐标
    try { bakeTransformOffsetsIn(stage); }
    catch (e) { pwarn("persist", "bakeTransformOffsetsIn threw: " + (e?.message || e)); }
    // sel / hover 两层 overlay 是直接 append 到 doc.body，**不是 .stage 的子节点**，
    // stage.innerHTML 天然不会序列化到它们 —— 之前那段 detach/reattach 既多余又会
    // 顺手清掉 sel overlay 的事件/位置状态，导致第一次拖完后下一次点击没响应。
    const before = String(st.data?.html || "");
    const captured = stage.innerHTML;
    st.data = Object.assign({}, st.data, { html: captured });
    // bake 完元素改了 left/top，sel overlay 的位置要按新的 bbox 重定位
    try { positionEditorOverlay(); } catch (e) {}
    plog("persist", "captured stage.innerHTML"
      + " beforeLen=" + before.length
      + " afterLen=" + captured.length
      + " changed=" + (before === captured ? "N" : "Y")
      + " head=" + captured.slice(0, 80).replace(/\n/g, "\\n"));
    // 同步字段编辑器里 html textarea 的值
    const fieldHostHtml = els.htmlPreviewFields?.querySelector('[data-field-name="html"]');
    if (fieldHostHtml) fieldHostHtml.value = st.data.html;
  }

  function toggleEditMode() {
    if (!htmlPreviewState) return;
    if (_editorEnabled) { disableIframeEditor(); return; }
    // 非 freeform 自动转换：把当前渲染的 HTML/CSS 拍下来塞进 freeform，
    // 之后编辑器随便拖随便改。保留视觉，但失去字段表单（不再能改 title/items 这种结构化字段）。
    if (htmlPreviewState.layout !== "freeform") {
      const ok = convertCurrentLayoutToFreeform();
      if (!ok) {
        showMessage("无法切换到自由编辑模式 —— 当前布局渲染失败，请重试", "error");
        return;
      }
      showMessage("已转为自由编辑模式 —— 可拖动、缩放、改文字。原字段表单不再可用。", "info");
    }
    enableIframeEditor();
    // 一次性提示：操作要点（吸附 / Shift 临时禁用 / Esc 退出选中等）
    if (!localStorage.getItem("__lingxi_editor_tips_seen__")) {
      showMessage("拖动会自动吸附（边/中心/对齐 6px 内）。按住 Shift 可临时禁用吸附。", "info");
      try { localStorage.setItem("__lingxi_editor_tips_seen__", "1"); } catch (e) {}
    }
  }

  // 把当前 state 的非 freeform layout 渲染结果"展平"成 freeform，让编辑器接管。
  // 实现：调 layoutDef.render 拿完整 HTML doc → DOMParser 解析 → 抽 <style> 内容 + .stage 的 innerHTML
  // → 写回 state.data 为 { html, css }，layout 改成 "freeform"，再 re-render。
  // 不修改用户原 data（保存在 _preFreeformData，给"撤销转换"留口子，目前未实现 UI）。
  function convertCurrentLayoutToFreeform() {
    const st = htmlPreviewState;
    if (!st || st.layout === "freeform") return true;
    const HtmlTpl = global.WpsAiHtmlTemplates;
    const tpl = HtmlTpl?.getTemplate?.(st.templateName);
    const layoutDef = tpl?.layouts?.[st.layout];
    if (!layoutDef) return false;
    let fullDoc;
    try { fullDoc = layoutDef.render(st.data || {}, st.palette || {}); }
    catch (e) { console.warn("[convert-freeform] render failed:", e); return false; }
    if (!fullDoc || typeof fullDoc !== "string") return false;

    // 解析出 <style> 内容（拼接所有 <style> 块）+ <body> 里 .stage 的 innerHTML
    let cssOut = "";
    let htmlOut = "";
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(fullDoc, "text/html");
      doc.querySelectorAll("style").forEach((s) => { cssOut += s.textContent + "\n"; });
      const stage = doc.querySelector(".stage");
      if (stage) htmlOut = stage.innerHTML;
      else htmlOut = doc.body ? doc.body.innerHTML : "";
    } catch (e) {
      console.warn("[convert-freeform] parse failed:", e);
      // 兜底：用正则粗解（不严谨但能凑合）
      const styleMatch = fullDoc.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
      cssOut = styleMatch ? styleMatch[1] : "";
      const stageMatch = fullDoc.match(/<div class="stage"[^>]*>([\s\S]*)<\/div>\s*<\/body>/i);
      htmlOut = stageMatch ? stageMatch[1] : "";
    }
    if (!htmlOut) return false;

    // 备份原 data 让以后能"还原"
    st._preFreeformData = st.data;
    st._preFreeformLayout = st.layout;
    st.layout = "freeform";
    st.data = { html: htmlOut, css: cssOut };
    // 切换后重渲染 iframe + 字段表单
    renderHtmlPreviewFields();
    renderHtmlPreviewIntoIframe();
    updateHtmlPreviewActionButtons();
    return true;
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
    // 去重也按当前 PPT 作用域，跨 PPT 重复不算重复（不同 PPT 内容可以同名同结构）
    (global.WpsAiHtmlComponents.list?.({ docKey: _cachedDocKey }) || []).forEach((c) => {
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
          sourceSlideId: st.id || null,
          docKey: _cachedDocKey || ""
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
    // 注：「替换第 N 页」按钮已下掉，按当前选中替换走 confirmHtmlPreviewReplaceActive
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
    // 撤销 / 重做按钮 + Ctrl+Z / Ctrl+Y 快捷键
    els.htmlPreviewEditUndoBtn?.addEventListener("click", editorUndo);
    els.htmlPreviewEditRedoBtn?.addEventListener("click", editorRedo);
    // 中栏 tab：画布 / 属性 切换
    document.querySelectorAll(".html-preview-center-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchCenterTab(btn.dataset.centerTab));
    });
    // 标尺常开：去掉切换按钮后直接挂上，不再读 localStorage
    applyRulerVisibility(true);
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
