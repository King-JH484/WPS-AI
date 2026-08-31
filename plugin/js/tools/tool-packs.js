(function attachToolPacks(global) {
  "use strict";

  const states = new Map();
  const DEFAULT_PACKS = Object.freeze(["core", "compose"]);

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
      state = { key, revision: 1, enabled };
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
      return Object.freeze({ revision: 0, definitions: Object.freeze(baseDefinitions.slice()), enabledPacks: Object.freeze([]) });
    }
    const state = ensureState(context);
    const enrich = global.WpsAiWppCapabilities?.enrichTool || ((definition) => definition);
    const definitions = baseDefinitions.map(enrich).filter((definition) => {
      const hosts = Array.isArray(definition.hosts) ? definition.hosts : [definition.hosts || "*"];
      if (hosts.includes("*")) return true;
      return state.enabled.has(definition.pack || "compose");
    });
    return Object.freeze({
      revision: state.revision,
      definitions: Object.freeze(definitions),
      enabledPacks: Object.freeze(Array.from(state.enabled))
    });
  }

  global.WpsAiToolPacks = { beginTurn, enablePack, resolveTools, inferredPacks };
})(window);
