(function attachAnthropicProvider(global) {
  "use strict";

  const PROXY_PREFIX = "http://localhost:3890/forward/";

  function resolveBase(config) {
    const base = (config.baseUrl || "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("请在设置中填写 Anthropic Claude 服务的 Base URL。");
    }
    if (config.useProxy === false) {
      return base;
    }
    return PROXY_PREFIX + encodeURIComponent(base);
  }

  function buildHeaders(config, { stream = false } = {}) {
    if (!config.apiKey) {
      throw new Error("请在设置中填写 Anthropic API Key。");
    }
    const headers = {
      "x-api-key": config.apiKey,
      "anthropic-version": config.anthropicVersion || "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json"
    };
    if (stream) {
      headers.Accept = "text/event-stream";
    }
    return headers;
  }

  function fallbackModels() {
    return [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest"
    ];
  }

  function splitMessages(messages) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    return { system, conversation };
  }

  function createAnthropicProvider(config) {
    const base = () => resolveBase(config);

    return {
      type: "anthropic",
      label: config.label || "Anthropic Claude",
      defaultModel: config.defaultModel || "claude-sonnet-4-6",
      requiresOAuth: false,

      async ensureReady() {
        if (!config.apiKey) {
          throw new Error("请在设置中填写 Anthropic API Key。");
        }
      },

      async listModels() {
        const url = `${base()}/models`;
        const response = await fetch(url, {
          method: "GET",
          headers: buildHeaders(config)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `获取模型列表失败：${response.status}`);
        }
        const data = Array.isArray(payload.data) ? payload.data : [];
        const models = data
          .map((m) => m.id || m.name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        if (models.length === 0) {
          throw new Error("模型接口返回空列表");
        }
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages, maxTokens = 4096 }) {
        const { system, conversation } = splitMessages(messages);
        const url = `${base()}/messages`;
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(config),
          body: JSON.stringify({
            model,
            system: system || undefined,
            messages: conversation,
            max_tokens: maxTokens,
            stream: false
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        return (payload.content || [])
          .filter((block) => block.type === "text")
          .map((block) => block.text || "")
          .join("");
      },

      async streamChat({ model, messages, onToken, maxTokens = 4096 }) {
        const { system, conversation } = splitMessages(messages);
        const url = `${base()}/messages`;
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(config, { stream: true }),
          body: JSON.stringify({
            model,
            system: system || undefined,
            messages: conversation,
            max_tokens: maxTokens,
            stream: true
          })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        let fullText = "";
        await global.WpsAiSse.readSse(response, (eventType, payload) => {
          if (!payload) return;
          if (eventType === "content_block_delta") {
            const delta = payload.delta?.text || "";
            if (delta) {
              fullText += delta;
              onToken?.(delta, fullText);
            }
          }
        });
        return fullText;
      },

      /**
       * Anthropic 工具调用流式循环。
       * 协议：content_block_start 给出每个块的类型（text / tool_use），
       *      content_block_delta 给 text_delta（文字）或 input_json_delta（工具参数 JSON 片段），
       *      message_delta 给 stop_reason。
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, maxTokens = 4096, signal }) {
        const url = `${base()}/messages`;
        const { system, conversation: initial } = splitMessages(messages);

        const conversation = initial.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content
        }));

        const toolSpecs = tools.map((def) => global.WpsAiToolRegistry.toAnthropicToolSpec(def));

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const body = {
            model,
            system: system || undefined,
            messages: conversation,
            max_tokens: maxTokens,
            stream: true
          };
          if (toolSpecs.length > 0) body.tools = toolSpecs;

          const response = await fetch(url, {
            method: "POST",
            headers: buildHeaders(config, { stream: true }),
            body: JSON.stringify(body),
            signal
          });

          if (!response.ok) {
            const errPayload = await response.json().catch(() => ({}));
            throw new Error(errPayload.error?.message || `请求失败：${response.status}`);
          }

          const blockAcc = []; // index → {type, text|tool_use accumulator}
          let stopReason = null;
          let fullText = "";

          await global.WpsAiSse.readSse(response, async (eventType, payload) => {
            if (!payload) return;
            const t = eventType || payload.type;

            if (t === "content_block_start") {
              const idx = payload.index ?? 0;
              const block = payload.content_block || {};
              if (block.type === "text") {
                blockAcc[idx] = { type: "text", text: "" };
              } else if (block.type === "tool_use") {
                blockAcc[idx] = { type: "tool_use", id: block.id, name: block.name, inputJson: "" };
              }
              return;
            }

            if (t === "content_block_delta") {
              const idx = payload.index ?? 0;
              const delta = payload.delta || {};
              const block = blockAcc[idx];
              if (!block) return;

              if (delta.type === "text_delta" && typeof delta.text === "string") {
                block.text = (block.text || "") + delta.text;
                fullText += delta.text;
                await onEvent?.({ type: "assistant_chunk", delta: delta.text, fullText });
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                block.inputJson = (block.inputJson || "") + delta.partial_json;
              }
              return;
            }

            if (t === "message_delta") {
              if (payload.delta?.stop_reason) {
                stopReason = payload.delta.stop_reason;
              }
            }
          });

          // 把累积块还原成 Anthropic 格式的 content 数组，回写到 conversation
          const contentBlocks = blockAcc.filter(Boolean).map((b) => {
            if (b.type === "text") return { type: "text", text: b.text || "" };
            if (b.type === "tool_use") {
              let input = {};
              try { input = JSON.parse(b.inputJson || "{}"); } catch (e) { input = {}; }
              return { type: "tool_use", id: b.id, name: b.name, input };
            }
            return null;
          }).filter(Boolean);

          conversation.push({ role: "assistant", content: contentBlocks });

          if (fullText) {
            await onEvent?.({ type: "assistant_text_end", text: fullText });
          }

          const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
          if (toolUses.length === 0) {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }

          const toolResultBlocks = [];
          for (const use of toolUses) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const args = use.input || {};
            await onEvent?.({ type: "tool_call", id: use.id, name: use.name, args });

            const decision = approveTool ? await approveTool({ id: use.id, name: use.name, args }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(use.name, args);
            }
            await onEvent?.({ type: "tool_result", id: use.id, name: use.name, result });

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: global.WpsAiToolRegistry.serializeResult(result),
              is_error: !result.ok
            });
          }

          conversation.push({ role: "user", content: toolResultBlocks });

          if (stopReason && stopReason !== "tool_use") {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}）。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("anthropic", createAnthropicProvider);
})(window);
