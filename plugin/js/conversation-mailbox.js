(function initConversationMailbox(global) {
  "use strict";

  const DEFAULT_TTL_MS = 30 * 1000;

  function inspect(raw, currentDocKey, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
    if (!raw) return { action: "none", request: null };
    let request = null;
    try { request = JSON.parse(String(raw)); } catch (e) { return { action: "clear", request: null }; }
    if (!request || typeof request !== "object" || !request.id) {
      return { action: "clear", request: null };
    }
    const ts = Number(request.ts) || 0;
    if (!ts || now - ts > ttlMs) return { action: "clear", request };

    const requestedDocKey = String(request.docKey || "");
    const activeDocKey = String(currentDocKey || "");
    if (requestedDocKey && requestedDocKey !== activeDocKey) {
      return { action: "keep", request };
    }
    return { action: "consume", request };
  }

  const api = { DEFAULT_TTL_MS, inspect };
  global.WpsAiConversationMailbox = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
