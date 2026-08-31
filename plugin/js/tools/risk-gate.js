(function attachRiskGate(global) {
  "use strict";

  function riskOf(definition = {}, context = {}) {
    const action = context.args?.action;
    return (action && definition.riskByAction?.[action]) || definition.risk || "document_write";
  }

  function requiresApproval(definition = {}, context = {}) {
    const risk = riskOf(definition, context);
    if (risk === "read_only") return false;
    if (risk === "destructive") return true;
    if (risk === "filesystem_create" && context.args?.overwrite === true) return true;
    return context.operationMode !== "direct";
  }

  global.WpsAiRiskGate = { riskOf, requiresApproval };
})(window);
