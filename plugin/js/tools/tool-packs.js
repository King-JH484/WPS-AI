(function attachToolPacks(global) {
  "use strict";

  const states = new Map();
  const DEFAULT_PACKS = Object.freeze(["core", "compose"]);

  function stripQuotedText(text) {
    return String(text || "")
      .replace(/“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`/g, " ")
      .replace(/\b[^\s,，。；;]*(?:probe|test|sandbox)[^\s,，。；;]*\.(?:pptx?|potx)\b/gi, " ");
  }

  function diagnosticAuthorization(text) {
    const authorized = new Set();
    const clauses = stripQuotedText(text).toLowerCase().split(/[。！？!?；;\n]+/);
    for (const clause of clauses) {
      if (!clause.trim()) continue;
      if (/不要|禁止|不许|别(?:再)?|无需|不(?:要|必|用|需|运行|执行|测试)|do\s+not|don't|without/.test(clause)) continue;
      const affirmative = /运行|执行|开始|测试|run|execute|start|test/.test(clause);
      const diagnostic = /探针|能力测试|接口测试|测试.{0,12}(?:接口|能力)|probe|capabilit(?:y|ies)\s+test|interface\s+test|test.{0,16}(?:api|interface|capabilit)/.test(clause);
      if (!affirmative || !diagnostic) continue;
      if (/母版|模板|版式|master|template|layout/.test(clause)) authorized.add("template_probe");
      if (/原生图表|图表对象|native\s+chart|chart\s+object/.test(clause)) authorized.add("chart_object_probe");
    }
    return Object.freeze(Array.from(authorized));
  }

  function keyOf(context = {}) {
    return [context.host || "*", context.conversationId || "anonymous", context.turnId || "turn"].join(":");
  }

  function inferredPacks(text) {
    const value = String(text || "").toLowerCase();
    const out = [];
    if (/母版|版式|占位符|主题|模板|master|layout|placeholder|theme|potx/.test(value)) out.push("template_native");
    if (/原生图表|可编辑图表|chart|图表/.test(value)) out.push("chart_native");
    if (/动画|转场|音频|视频|媒体|animation|transition|media/.test(value)) out.push("motion_media");
    if (/导出|打印|放映|另存|export|print|slideshow/.test(value)) out.push("delivery");
    return out;
  }

  function ensureState(context = {}) {
    const key = keyOf(context);
    let state = states.get(key);
    if (!state) {
      const enabled = new Set(DEFAULT_PACKS);
      inferredPacks(context.userText).forEach((pack) => enabled.add(pack));
      state = { key, revision: 1, enabled, diagnosticAuthorization: diagnosticAuthorization(context.userText) };
      states.set(key, state);
    }
    return state;
  }

  function beginTurn(context = {}) {
    states.delete(keyOf(context));
    return resolveTools(context, []);
  }

  function enablePack(context = {}, pack) {
    const catalog = global.WpsAiWppCapabilities?.packs || {};
    if (!catalog[pack]) throw new Error(`未知 WPP 工具包：${pack}`);
    const state = ensureState(context);
    const changed = !state.enabled.has(pack);
    if (changed) {
      state.enabled.add(pack);
      state.revision += 1;
    }
    return Object.freeze({ changed, pack, revision: state.revision, enabledPacks: Object.freeze(Array.from(state.enabled)) });
  }

  function resolveTools(context = {}, baseDefinitions = []) {
    if (context.host !== "wpp") {
      return Object.freeze({
        revision: 0,
        definitions: Object.freeze(baseDefinitions.filter((definition) => !definition.diagnosticOnly)),
        enabledPacks: Object.freeze([]),
        diagnosticAuthorization: Object.freeze([])
      });
    }
    const state = ensureState(context);
    const enrich = global.WpsAiWppCapabilities?.enrichTool || ((definition) => definition);
    const definitions = baseDefinitions.map(enrich).filter((definition) => {
      if (definition.diagnosticOnly && !state.diagnosticAuthorization.includes(definition.diagnosticOnly)) return false;
      const hosts = Array.isArray(definition.hosts) ? definition.hosts : [definition.hosts || "*"];
      if (hosts.includes("*")) return true;
      return state.enabled.has(definition.pack || "compose");
    });
    return Object.freeze({
      revision: state.revision,
      definitions: Object.freeze(definitions),
      enabledPacks: Object.freeze(Array.from(state.enabled)),
      diagnosticAuthorization: state.diagnosticAuthorization
    });
  }

  global.WpsAiToolPacks = { beginTurn, enablePack, resolveTools, inferredPacks, diagnosticAuthorization };
})(window);
