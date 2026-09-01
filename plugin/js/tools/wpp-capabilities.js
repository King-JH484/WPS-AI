(function attachWppCapabilities(global) {
  "use strict";

  const ADAPTERS = Object.freeze([
    Object.freeze({ id: "wps_jsapi", platforms: ["darwin", "win32"], priority: 100, state: "unverified" }),
    Object.freeze({ id: "windows_com", platforms: ["win32"], priority: 80, state: "unverified" }),
    Object.freeze({ id: "mac_ooxml", platforms: ["darwin"], priority: 60, state: "unverified" })
  ]);

  const CAPABILITIES = Object.freeze([
    Object.freeze({ key: "wpp.master.inspect", pack: "template_native", access: "read", state: "unverified" }),
    Object.freeze({ key: "wpp.master.update", pack: "template_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.layout.manage", pack: "template_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.placeholder.manage", pack: "template_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.slide.add_from_layout", pack: "template_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.theme.manage", pack: "template_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.template.export", pack: "template_native", access: "filesystem_create", state: "unverified" }),
    Object.freeze({ key: "wpp.chart.native.create", pack: "chart_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.chart.native.data", pack: "chart_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.chart.native.read", pack: "chart_native", access: "read", state: "unverified" }),
    Object.freeze({ key: "wpp.chart.native.update", pack: "chart_native", access: "write", state: "unverified" }),
    Object.freeze({ key: "wpp.chart.native.delete", pack: "chart_native", access: "write", state: "unverified" })
  ]);

  const PACKS = Object.freeze({
    core: Object.freeze({ id: "core", label: "演示基础", always: true }),
    compose: Object.freeze({ id: "compose", label: "页面创作" }),
    template_native: Object.freeze({ id: "template_native", label: "母版与模板" }),
    chart_native: Object.freeze({ id: "chart_native", label: "原生图表" }),
    motion_media: Object.freeze({ id: "motion_media", label: "动画与媒体" }),
    delivery: Object.freeze({ id: "delivery", label: "导出与放映" })
  });
  const evidence = new Map();
  const IDENTITY_FIELDS = Object.freeze(["architecture", "wpsVersion", "wpsBuild", "pluginVersion"]);
  let activeRuntimeIdentity = null;

  function normalizeRuntimeIdentity(value = {}) {
    const normalized = {};
    IDENTITY_FIELDS.forEach((field) => {
      normalized[field] = String(value?.[field] || "unknown").trim() || "unknown";
    });
    return Object.freeze(normalized);
  }

  function runtimeIdentityKey(value) {
    const identity = normalizeRuntimeIdentity(value);
    return IDENTITY_FIELDS.map((field) => identity[field]).join(":");
  }

  function evidenceKey(platform, capability, adapter, runtimeIdentity) {
    return [platform || "unknown", runtimeIdentityKey(runtimeIdentity), capability, adapter].join(":");
  }

  function recordEvidence(report) {
    const reportPlatform = report?.platform || "unknown";
    const reportIdentity = normalizeRuntimeIdentity(report?.runtimeIdentity || report?.evidence?.runtimeIdentity || {});
    activeRuntimeIdentity = reportIdentity;
    Object.entries(report?.capabilities || {}).forEach(([key, result]) => {
      if (!result?.adapter || !result?.state) return;
      evidence.set(evidenceKey(reportPlatform, key, result.adapter, reportIdentity), Object.freeze({
        state: result.state,
        reason: result.reason || "",
        evidence: result.evidence || report.evidence || {},
        observedAt: report?.evidence?.observedAt || new Date().toISOString(),
        runtimeIdentity: reportIdentity
      }));
    });
    return report;
  }

  function inferPack(name, capability) {
    const byCapability = CAPABILITIES.find((item) => item.key === capability)?.pack;
    if (byCapability) return byCapability;
    const value = String(name || "");
    if (/master|layout|placeholder|theme|template/.test(value)) return "template_native";
    if (/native_chart/.test(value)) return "chart_native";
    if (/animation|media|action|smartart/.test(value)) return "motion_media";
    if (/export|save_as|print|slideshow/.test(value)) return "delivery";
    if (/get_|read_|list_|capability_catalog|enable_tool_pack/.test(value)) return "core";
    return "compose";
  }

  function inferRisk(definition) {
    if (definition?.risk) return definition.risk;
    const name = String(definition?.name || "");
    if (/delete|remove|clear|reset/.test(name)) return "destructive";
    if (/export|save_as|template_export/.test(name)) return "filesystem_create";
    if (/get_|read_|list_|inspect|catalog|enable_tool_pack/.test(name)) return "read_only";
    return "document_write";
  }

  function enrichTool(definition) {
    if (!definition || !String(definition.name || "").startsWith("wpp_")) return definition;
    return Object.assign({}, definition, {
      pack: definition.pack || inferPack(definition.name, definition.capability),
      risk: inferRisk(definition)
    });
  }

  function catalog({ platform = "unknown", runtimeIdentity } = {}) {
    const identity = normalizeRuntimeIdentity(runtimeIdentity || activeRuntimeIdentity || {});
    return {
      platform,
      runtimeIdentity: identity,
      policy: "Only runtime probe evidence may promote an adapter capability to supported.",
      packs: Object.values(PACKS).map((item) => Object.assign({}, item)),
      capabilities: CAPABILITIES.map((capability) => {
        const adapters = ADAPTERS
          .filter((adapter) => adapter.platforms.includes(platform))
          .map((adapter) => {
            const observed = evidence.get(evidenceKey(platform, capability.key, adapter.id, identity));
            return { id: adapter.id, priority: adapter.priority, state: observed?.state || adapter.state, reason: observed?.reason || "" };
          });
        const supported = adapters.find((adapter) => adapter.state === "supported");
        const declaredState = adapters.some((adapter) => adapter.state === "unverified") ? "unverified" : capability.state;
        return { ...capability, state: supported ? "supported" : declaredState, adapters };
      })
    };
  }

  function getCapabilityStatus(platform, key, adapter = "wps_jsapi", runtimeIdentity) {
    const identity = normalizeRuntimeIdentity(runtimeIdentity || activeRuntimeIdentity || {});
    const observed = evidence.get(evidenceKey(platform, key, adapter, identity));
    if (observed) return observed;
    const declared = CAPABILITIES.find((item) => item.key === key);
    return { state: declared?.state || "unsupported", reason: declared ? "尚无当前平台运行证据" : "未知能力" };
  }

  function requireSupported(platform, key, adapter = "wps_jsapi", runtimeIdentity) {
    const status = getCapabilityStatus(platform, key, adapter, runtimeIdentity);
    if (status.state !== "supported") throw new Error(`capability_${status.state}:${key}:${status.reason || "未通过运行探针"}`);
    return status;
  }

  global.WpsAiWppCapabilities = {
    adapters: ADAPTERS,
    capabilities: CAPABILITIES,
    packs: PACKS,
    enrichTool,
    catalog,
    recordEvidence,
    normalizeRuntimeIdentity,
    getCapabilityStatus,
    requireSupported
  };
})(window);
