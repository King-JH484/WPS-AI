(function attachProviderToolResolution(global) {
  "use strict";

  function normalizeSnapshot(value, fallbackRevision) {
    if (Array.isArray(value)) {
      return Object.freeze({
        revision: fallbackRevision + 1,
        definitions: Object.freeze(value.slice()),
        enabledPacks: Object.freeze([]),
        diagnosticAuthorization: Object.freeze([])
      });
    }
    if (!value || !Array.isArray(value.definitions)) throw new Error("工具 resolver 返回了无效 snapshot");
    return Object.freeze({
      revision: Number.isFinite(value.revision) ? value.revision : fallbackRevision + 1,
      definitions: Object.freeze(value.definitions.slice()),
      enabledPacks: Object.freeze(Array.isArray(value.enabledPacks) ? value.enabledPacks.slice() : []),
      diagnosticAuthorization: Object.freeze(Array.isArray(value.diagnosticAuthorization) ? value.diagnosticAuthorization.slice() : [])
    });
  }

  function createResolver({ tools = [], resolveTools, toolContext, onEvent }) {
    const safeStaticTools = tools.filter((definition) => !definition?.diagnosticOnly);
    let lastSnapshot = Object.freeze({
      revision: 0,
      definitions: Object.freeze(safeStaticTools.slice()),
      enabledPacks: Object.freeze([]),
      diagnosticAuthorization: Object.freeze([])
    });
    let hasSuccessfulDynamicSnapshot = false;
    let consecutiveFailures = 0;
    return async function resolveToolSnapshot() {
      if (typeof resolveTools !== "function") return lastSnapshot;
      try {
        lastSnapshot = normalizeSnapshot(await resolveTools(toolContext), lastSnapshot.revision);
        hasSuccessfulDynamicSnapshot = true;
        consecutiveFailures = 0;
        return lastSnapshot;
      } catch (error) {
        consecutiveFailures += 1;
        await onEvent?.({ type: "diagnostic", code: "tool_resolution_failed", message: error?.message || String(error), attempt: consecutiveFailures });
        if (!hasSuccessfulDynamicSnapshot || consecutiveFailures >= 2) throw error;
        return lastSnapshot;
      }
    };
  }

  function executionContext(signal, toolContext, toolSnapshot) {
    const turnId = toolContext?.turnId || "";
    return Object.assign({}, toolContext || {}, {
      signal,
      toolRevision: toolSnapshot?.revision || 0,
      diagnosticTurnId: turnId,
      diagnosticAuthorization: Object.freeze(Array.isArray(toolSnapshot?.diagnosticAuthorization)
        ? toolSnapshot.diagnosticAuthorization.slice()
        : [])
    });
  }

  global.WpsAiProviderTools = { createResolver, executionContext };
})(window);
