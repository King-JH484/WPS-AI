(function attachCapabilities(global) {
  "use strict";

  // 模型能力检测：根据 model id 模式判断
  //   image:    多模态图像输入
  //   pdf:      原生 PDF 附件支持
  //   thinking: 深度思考 / reasoning（可调强度的）
  //
  // 命名约定按各家命名风格 + 通用关键字兜底。新模型默认不识别 → 保守返回 false，
  // 用户可以在 UI 里手动覆盖（未实现）。

  function lc(s) { return String(s || "").toLowerCase(); }

  function supportsImage(modelId) {
    const s = lc(modelId);
    if (!s) return false;
    return /(^|[-_/])(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o|chatgpt-5)/.test(s)
      || /(^|[-_/])(o3|o4)([-_]|$)/.test(s)
      || /(claude-3|claude-4|claude-opus|claude-sonnet|claude-haiku)/.test(s)
      || /(gemini.*(pro|flash|vision))/.test(s)
      || /(qwen.*(vl|vision))/.test(s)
      || /(deepseek.*(vl|vision|v4))/.test(s)
      || /(yi-?vision|moonshot-?v1-?vision|glm-4v|kimi-vl)/.test(s)
      || /(vision|multimodal|-vl-|-vl$)/.test(s);
  }

  // PDF 附件支持（白名单，按已验证的协议级支持来）
  //   Anthropic Claude 3.5+ / 4 系：document content block 原生
  //   OpenAI 官方 gpt-4o / gpt-4.1 / gpt-5 / o3+：Files API
  //   Gemini 1.5+ / 2：inline_data 或 file_data
  //   Codex Responses API：input_file 原生
  //
  // 注意：DeepSeek / Kimi / Qwen-VL / GLM-4V 这些 OpenAI 兼容服务的多模态能力
  //       目前仅限 image_url（图片）。它们 chat completions 不接受 type:"file"
  //       内容部分（DeepSeek 会回 "unknown variant `file`, expected `text`"）。
  //       这些模型用户要处理 PDF 得走 Claude / GPT-4o / Codex 等。
  function supportsPdf(modelId) {
    const s = lc(modelId);
    if (!s) return false;
    // Anthropic Claude 3.5+ / 3.7 / 4
    if (/claude-3-5|claude-3\.5|claude-3-7|claude-3\.7|claude-(opus|sonnet|haiku)-[345]|claude-[45]/.test(s)) return true;
    // OpenAI 4o / 4.1 / 5 / o3 / o4
    if (/(gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|chatgpt-5)/.test(s)) return true;
    if (/(^|[-_/])(o3|o4)([-_]|$)/.test(s)) return true;
    // Gemini 1.5+ / 2.x
    if (/gemini-(1\.5|2)/.test(s)) return true;
    // 显式带 pdf / document 标签的（少数厂商命名）
    if (/[-_](pdf|document)([-_]|$)/.test(s)) return true;
    return false;
  }

  // 深度思考 / reasoning 支持
  // OpenAI：o1, o3, o4, gpt-5 系列原生 reasoning
  // Anthropic：claude-3-7-sonnet 起（extended thinking）、claude-4 系列
  // DeepSeek：deepseek-reasoner / deepseek-r1 / v4 reasoning
  // Qwen：qwq / qwen-3 thinking
  // 通过模型名识别，命中即视为支持
  function supportsThinking(modelId) {
    const s = lc(modelId);
    if (!s) return false;
    if (/(^|[-_/])o[134]([-_]|$)/.test(s)) return true;
    if (/gpt-5/.test(s)) return true;
    if (/claude-3-7|claude-3\.7|claude-(opus|sonnet)-[45]|claude-[45].*sonnet|claude-[45].*opus/.test(s)) return true;
    if (/deepseek-(reasoner|r1)|deepseek.*-r\d|deepseek.*think/.test(s)) return true;
    if (/qwq|qwen.*think|qwen-3/.test(s)) return true;
    if (/gemini-.*think|gemini-2\.0-flash-thinking/.test(s)) return true;
    if (/thinking|reasoning|reasoner/.test(s)) return true;
    return false;
  }

  // 返回完整能力快照
  function getCapabilities(modelId) {
    return {
      image: supportsImage(modelId),
      pdf: supportsPdf(modelId),
      thinking: supportsThinking(modelId)
    };
  }

  // 给定 provider 类型 + 用户选的 thinking level（low/medium/high），返回该 provider
  // 对应 API 应该传的参数对象。runWithTools 拿这个塞进 body。
  // 未启用 thinking → 返回 null
  function buildThinkingParams(providerType, level, modelId) {
    if (!supportsThinking(modelId)) return null;
    const lv = ["low", "medium", "high"].includes(level) ? level : "medium";

    if (providerType === "anthropic") {
      // Anthropic extended thinking: budget_tokens 控制思考长度
      const budget = { low: 1024, medium: 4000, high: 16000 }[lv];
      return { thinking: { type: "enabled", budget_tokens: budget } };
    }

    if (providerType === "openai") {
      // Chat completions reasoning_effort 仅 o-系列 / gpt-5 支持
      return { reasoning_effort: lv };
    }

    if (providerType === "codex") {
      // Responses API: reasoning.effort
      return { reasoning: { effort: lv } };
    }

    return null;
  }

  global.WpsAiCapabilities = {
    supportsImage,
    supportsPdf,
    supportsThinking,
    getCapabilities,
    buildThinkingParams
  };
})(window);
