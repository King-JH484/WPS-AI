(function attachAnthonyStorageCleanup(global) {
  "use strict";

  const EXACT_KEYS = [
    "wps_ai_provider_settings_v1",
    "wps_ai_access_token", "wps_ai_refresh_token", "wps_ai_expires_at",
    "wps_ai_code_verifier", "wps_ai_oauth_state",
    "wpsAiChatFoldMiddle", "wpsAiProviderHealthV1",
    "wpsAiCacheAutoCleanPolicy", "wpsAiCacheAutoCleanLastRunAt", "wpsAiMcpBridgeToken"
  ];
  const PRODUCT_KEY_RE = /^(?:(?:__)?(?:lingxi|anthony)[_-])/i;
  const PLUGIN_STORAGE_KEYS = (() => {
    const keys = new Set(EXACT_KEYS);
    const suffixes = [
      "ai_pending_action", "conversations_dialog_request_v1",
      "quick_prompt_dialog_request_v1", "quick_prompt_dialog_result_v1",
      "format_preview_dialog_request_v1", "format_preview_dialog_result_v1",
      "selection_preview_dialog_request_v1", "selection_preview_dialog_result_v1",
      "parallel_translate_dialog_request_v1"
    ];
    for (const brand of ["lingxi", "anthony"]) {
      suffixes.forEach((suffix) => keys.add(`${brand}_${suffix}`));
      keys.add(`${brand}_ai_taskpane_id`);
      for (let version = 2; version <= 20; version += 1) keys.add(`${brand}_ai_taskpane_id_v${version}`);
    }
    return Array.from(keys);
  })();

  function isProductKey(key) {
    return PRODUCT_KEY_RE.test(String(key || "")) || EXACT_KEYS.includes(String(key || ""));
  }

  function clearLocalStorage(storage) {
    const removed = [];
    if (!storage) return removed;
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
    for (const key of keys.filter(isProductKey)) {
      storage.removeItem(key);
      removed.push(key);
    }
    return removed.sort();
  }

  async function maybeResolve(value) {
    try {
      if (typeof value === "function") value = value();
      if (value && typeof value.then === "function") value = await value;
      return value || null;
    } catch (_) { return null; }
  }

  async function findPluginStorage() {
    const wps = global.wps || {};
    const candidates = [
      global.Application,
      wps.Application,
      wps.WpsApplication,
      wps.EtApplication,
      wps.WppApplication,
      wps.PdfApplication,
      wps.PDFApplication,
      wps.KPdfApplication,
      wps.KpdfApplication,
      wps
    ];
    for (const candidate of candidates) {
      const app = await maybeResolve(candidate);
      if (app && app.PluginStorage) return app.PluginStorage;
    }
    return null;
  }

  function removePluginKey(storage, key) {
    if (!storage) return false;
    try {
      if (typeof storage.removeItem === "function") storage.removeItem(key);
      else if (typeof storage.setItem === "function") storage.setItem(key, "");
      else return false;
      return true;
    } catch (_) { return false; }
  }

  async function runCleanup(options = {}) {
    const local = clearLocalStorage(options.localStorage || global.localStorage);
    const pluginStorage = options.pluginStorage || await findPluginStorage();
    const plugin = [];
    for (const key of PLUGIN_STORAGE_KEYS) {
      if (removePluginKey(pluginStorage, key)) plugin.push(key);
    }
    return {
      ok: true,
      hostPath: String(global.location?.pathname || ""),
      localStorageRemoved: local,
      pluginStorageAttempted: plugin,
      pluginStorageAvailable: !!pluginStorage
    };
  }

  global.AnthonyStorageCleanup = { EXACT_KEYS, PLUGIN_STORAGE_KEYS, isProductKey, clearLocalStorage, runCleanup };

  if (global.document) {
    runCleanup().then((result) => {
      const output = global.document.getElementById("result");
      if (output) {
        output.className = result.pluginStorageAvailable ? "ok" : "error";
        output.textContent = [
          result.pluginStorageAvailable ? "清理完成" : "localStorage 已清理，但本宿主未暴露 PluginStorage",
          `宿主路径：${result.hostPath}`,
          `localStorage 删除 ${result.localStorageRemoved.length} 个键`,
          `PluginStorage 尝试删除 ${result.pluginStorageAttempted.length} 个已知键`,
          "日志仅包含键名，不包含任何键值。"
        ].join("\n");
      }
      global.document.body.dataset.status = result.pluginStorageAvailable ? "complete" : "partial";
    }).catch((error) => {
      const output = global.document.getElementById("result");
      if (output) { output.className = "error"; output.textContent = `清理失败：${error?.message || error}`; }
      global.document.body.dataset.status = "failed";
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
