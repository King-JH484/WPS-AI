(function attachAiClient(global) {
  "use strict";

  function getProvider() {
    const registry = global.WpsAiProviderRegistry;
    if (!registry) {
      throw new Error("Provider 注册表未加载。");
    }
    const config = registry.getActiveConfig();
    return { provider: registry.buildProvider(config), config };
  }

  async function listModels() {
    const { provider } = getProvider();
    return provider.listModels();
  }

  function getFallbackModels() {
    try {
      const { provider } = getProvider();
      return provider.getFallbackModels();
    } catch (error) {
      return ["gpt-4o-mini"];
    }
  }

  function getDefaultModel() {
    try {
      const { provider } = getProvider();
      return provider.defaultModel;
    } catch (error) {
      return "gpt-4o-mini";
    }
  }

  async function chatCompletion({ model, messages, temperature }) {
    const { provider } = getProvider();
    await provider.ensureReady?.();
    return provider.chat({ model: model || provider.defaultModel, messages, temperature });
  }

  async function streamChatCompletion({ model, messages, temperature, onToken }) {
    const { provider } = getProvider();
    await provider.ensureReady?.();
    return provider.streamChat({ model: model || provider.defaultModel, messages, temperature, onToken });
  }

  async function runWithTools({ model, messages, tools, onEvent, approveTool, maxIterations, signal }) {
    const { provider } = getProvider();
    await provider.ensureReady?.();
    if (typeof provider.runWithTools !== "function") {
      throw new Error(`当前 provider（${provider.label}）不支持工具调用。`);
    }
    return provider.runWithTools({
      model: model || provider.defaultModel,
      messages,
      tools: tools || [],
      onEvent,
      approveTool,
      maxIterations,
      signal
    });
  }

  function getActiveProviderInfo() {
    try {
      const { provider, config } = getProvider();
      return {
        id: config.id,
        type: provider.type,
        label: provider.label,
        requiresOAuth: Boolean(provider.requiresOAuth),
        defaultModel: provider.defaultModel
      };
    } catch (error) {
      return null;
    }
  }

  global.WpsAiOpenAI = {
    getFallbackModels,
    getDefaultModel,
    listModels,
    chatCompletion,
    streamChatCompletion,
    runWithTools,
    getActiveProviderInfo
  };
})(window);
