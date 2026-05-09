(function attachToolRegistry(global) {
  "use strict";

  /**
   * 统一工具注册表，桥接到各宿主的实际操作。
   *
   * 工具定义结构：
   *   {
   *     name: "et_write_range",
   *     hosts: ["et"],                      // 适用宿主，"*" 表示通用
   *     description: "...",
   *     parameters: { ... JSON Schema },    // OpenAI/Anthropic 通用
   *     handler: async (args) => result     // 实际执行
   *   }
   */

  const registry = new Map();

  function registerTool(definition) {
    if (!definition?.name) throw new Error("tool definition missing name");
    if (typeof definition.handler !== "function") throw new Error(`tool ${definition.name} missing handler`);
    registry.set(definition.name, definition);
  }

  function getDefinition(name) {
    return registry.get(name) || null;
  }

  function applicableHosts(definition) {
    if (!definition?.hosts) return ["*"];
    return Array.isArray(definition.hosts) ? definition.hosts : [definition.hosts];
  }

  /**
   * 列出当前宿主可用的工具定义（用于发给模型）。
   */
  function listForHost(host) {
    const out = [];
    registry.forEach((def) => {
      const hosts = applicableHosts(def);
      if (hosts.includes("*") || hosts.includes(host)) {
        out.push(def);
      }
    });
    return out;
  }

  function toOpenAIToolSpec(def) {
    return {
      type: "function",
      function: {
        name: def.name,
        description: def.description || "",
        parameters: def.parameters || { type: "object", properties: {} }
      }
    };
  }

  /**
   * Codex 用的 Responses API 工具结构（顶层 type/name/parameters，不嵌套 function）。
   */
  function toCodexToolSpec(def) {
    return {
      type: "function",
      name: def.name,
      description: def.description || "",
      parameters: def.parameters || { type: "object", properties: {} }
    };
  }

  function toAnthropicToolSpec(def) {
    return {
      name: def.name,
      description: def.description || "",
      input_schema: def.parameters || { type: "object", properties: {} }
    };
  }

  /**
   * 执行工具调用，返回 { ok, value, error }。永不抛错。
   */
  async function execute(name, args = {}) {
    const def = registry.get(name);
    if (!def) {
      return { ok: false, error: `未知工具：${name}` };
    }
    try {
      const value = await def.handler(args || {});
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  /**
   * 把工具结果序列化成模型能消费的字符串（JSON）。
   */
  function serializeResult(result) {
    if (!result) return JSON.stringify({ ok: false, error: "no result" });
    if (result.ok) {
      return JSON.stringify({ ok: true, value: result.value });
    }
    return JSON.stringify({ ok: false, error: result.error });
  }

  global.WpsAiToolRegistry = {
    registerTool,
    getDefinition,
    listForHost,
    toOpenAIToolSpec,
    toCodexToolSpec,
    toAnthropicToolSpec,
    execute,
    serializeResult
  };
})(window);
