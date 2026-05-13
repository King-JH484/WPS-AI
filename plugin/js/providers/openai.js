(function attachOpenAIProvider(global) {
  "use strict";

  const PROXY_PREFIX = "http://localhost:3890/forward/";

  function resolveBase(config) {
    const base = (config.baseUrl || "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("请在设置中填写 OpenAI 兼容服务的 Base URL。");
    }
    if (config.useProxy === false) {
      return base;
    }
    return PROXY_PREFIX + encodeURIComponent(base);
  }

  function buildHeaders(config, { stream = false } = {}) {
    if (!config.apiKey) {
      throw new Error("请在设置中填写 API Key。");
    }
    const headers = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    };
    if (stream) {
      headers.Accept = "text/event-stream";
    }
    return headers;
  }

  function fallbackModels() {
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-3.5-turbo"
    ];
  }

  // OpenAI chat/completions 引用 PDF 必须先把 base64 上传到 Files API 拿 file_id。
  // 通过本地 proxy /openai-file-upload 走（避免 multipart 在浏览器里手搓）。
  // 缓存：同一份 base64 + provider 只上传一次，复用 file_id。
  const fileIdCache = new Map(); // sha8(base64) → file_id
  function shortHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(16);
  }

  async function ensureFileId({ config, base64, filename }) {
    const sample = base64.slice(0, 256) + ":" + base64.length;
    const key = (config.baseUrl || "") + "::" + shortHash(sample);
    if (fileIdCache.has(key)) return fileIdCache.get(key);
    const res = await fetch("http://localhost:3890/openai-file-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: (config.baseUrl || "").replace(/\/+$/, ""),
        apiKey: config.apiKey,
        base64, filename: filename || "file.pdf", purpose: "user_data"
      })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error?.message || payload.error || `上传文件失败：${res.status}`);
    const fileId = payload.id;
    if (!fileId) throw new Error("Files API 未返回 file_id");
    fileIdCache.set(key, fileId);
    return fileId;
  }

  // OpenAI 官方需要走 Files API，其他 OpenAI 兼容服务（DeepSeek/Kimi/Ollama 等）多数没有
  // /v1/files 端点，强行上传会 404。这里按 baseUrl 选路径：
  //   - api.openai.com 域名：上传 → 拿 file_id → 替换 part.file.file_id
  //   - 其他域名：保持 inline file_data，让 provider 自行处理（支持的会消化，不支持的会回 4xx）
  function isOfficialOpenAI(baseUrl) {
    return /(^|\/\/)api\.openai\.com\b/i.test(String(baseUrl || ""));
  }

  async function resolveAttachments(messages, config) {
    const needUpload = isOfficialOpenAI(config.baseUrl);
    const out = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) { out.push(msg); continue; }
      const parts = [];
      for (const part of msg.content) {
        if (needUpload && part?.type === "file" && part.file?.file_data && !part.file.file_id) {
          const m = /^data:application\/pdf;base64,(.+)$/i.exec(String(part.file.file_data));
          if (m) {
            try {
              const fileId = await ensureFileId({ config, base64: m[1], filename: part.file.filename || "file.pdf" });
              parts.push({ type: "file", file: { file_id: fileId } });
              continue;
            } catch (e) {
              // 上传失败（端点 404 / 鉴权问题）→ 降级到 inline file_data，让 provider 直接吃
              console.warn("[openai-compat] Files API 上传失败，降级 inline file_data:", e.message);
            }
          }
        }
        parts.push(part);
      }
      out.push({ ...msg, content: parts });
    }
    return out;
  }

  function normalizeModelIds(payload) {
    const source = Array.isArray(payload)
      ? payload
      : payload.data || payload.models || payload.items || [];
    return source
      .map((m) => (typeof m === "string" ? m : m.id || m.name))
      .filter((id) => typeof id === "string")
      .sort((a, b) => a.localeCompare(b));
  }

  function createOpenAIProvider(config) {
    const base = () => resolveBase(config);

    return {
      type: "openai",
      label: config.label || "OpenAI 兼容",
      defaultModel: config.defaultModel || "gpt-4o-mini",
      requiresOAuth: false,

      async ensureReady() {
        if (!config.apiKey) {
          throw new Error("请在设置中填写 API Key。");
        }
        if (!config.baseUrl) {
          throw new Error("请在设置中填写 Base URL。");
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
        const models = normalizeModelIds(payload);
        if (models.length === 0) {
          throw new Error("模型接口返回空列表");
        }
        return models;
      },

      getFallbackModels: fallbackModels,

      async chat({ model, messages }) {
        const url = `${base()}/chat/completions`;
        const resolved = await resolveAttachments(messages, config);
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(config),
          body: JSON.stringify({ model, messages: resolved, stream: false })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        return payload.choices?.[0]?.message?.content || "";
      },

      async streamChat({ model, messages, onToken }) {
        const url = `${base()}/chat/completions`;
        const resolved = await resolveAttachments(messages, config);
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(config, { stream: true }),
          body: JSON.stringify({ model, messages: resolved, stream: true })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error?.message || `请求失败：${response.status}`);
        }
        let fullText = "";
        await global.WpsAiSse.readSse(response, (_eventType, payload) => {
          if (!payload) return;
          const delta = payload.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            onToken?.(delta, fullText);
          }
        });
        return fullText;
      },

      /**
       * Tool-use 流式循环：
       * - 每轮 /chat/completions 用 stream:true，边接收边触发 assistant_chunk 事件
       * - tool_calls 通过 delta 累积（按 index 拼接 name/arguments）
       * - 文本结束时 emit assistant_text_end；如果有 tool_calls 则执行并继续下一轮
       */
      async runWithTools({ model, messages, tools = [], maxIterations = 50, onEvent, approveTool, signal, thinkingLevel }) {
        const url = `${base()}/chat/completions`;
        const conversation = await resolveAttachments(messages.slice(), config);
        const toolSpecs = tools.map((def) => global.WpsAiToolRegistry.toOpenAIToolSpec(def));
        const thinkingParams = global.WpsAiCapabilities?.buildThinkingParams("openai", thinkingLevel, model);

        for (let iter = 0; iter < maxIterations; iter += 1) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const body = {
            model,
            messages: conversation,
            stream: true
          };
          if (toolSpecs.length > 0) body.tools = toolSpecs;
          if (thinkingParams) Object.assign(body, thinkingParams);

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

          let fullText = "";
          let reasoningText = ""; // DeepSeek deepseek-reasoner: delta.reasoning_content
          let finishReason = null;
          const toolCallsByIndex = {};

          await global.WpsAiSse.readSse(response, async (_eventType, payload) => {
            if (!payload) return;
            const choice = payload.choices?.[0];
            if (!choice) return;
            const delta = choice.delta || {};

            // DeepSeek reasoning 模型的思考过程 token，独立于 content 流
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              reasoningText += delta.reasoning_content;
              await onEvent?.({ type: "reasoning_chunk", delta: delta.reasoning_content, fullText: reasoningText });
            }

            if (typeof delta.content === "string" && delta.content.length > 0) {
              fullText += delta.content;
              await onEvent?.({ type: "assistant_chunk", delta: delta.content, fullText });
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsByIndex[idx]) {
                  toolCallsByIndex[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
                }
                if (tc.id) toolCallsByIndex[idx].id = tc.id;
                if (tc.function?.name) toolCallsByIndex[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCallsByIndex[idx].function.arguments += tc.function.arguments;
              }
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          });

          // 按 index 排序得到完整 tool_calls 数组
          const sortedKeys = Object.keys(toolCallsByIndex).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
          const toolCalls = sortedKeys.map((k) => toolCallsByIndex[k]).filter((tc) => tc.function.name);

          // assistant message 进 conversation。
          // DeepSeek reasoner 要求把上一轮的 reasoning_content 带回，否则下轮报错。
          const assistantMessage = { role: "assistant", content: fullText || null };
          if (reasoningText) assistantMessage.reasoning_content = reasoningText;
          if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
          conversation.push(assistantMessage);

          if (reasoningText) {
            await onEvent?.({ type: "reasoning_end", text: reasoningText });
          }

          if (fullText) {
            await onEvent?.({ type: "assistant_text_end", text: fullText });
          }

          if (toolCalls.length === 0) {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }

          for (const call of toolCalls) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(call.function?.arguments || "{}"); } catch (e) { parsedArgs = {}; }

            await onEvent?.({ type: "tool_call", id: call.id, name: call.function?.name, args: parsedArgs });

            const decision = approveTool ? await approveTool({ id: call.id, name: call.function?.name, args: parsedArgs }) : { approved: true };
            let result;
            if (!decision.approved) {
              result = { ok: false, error: decision.reason || "用户拒绝执行该工具" };
            } else {
              result = await global.WpsAiToolRegistry.execute(call.function?.name, parsedArgs);
            }
            await onEvent?.({ type: "tool_result", id: call.id, name: call.function?.name, result });

            conversation.push({
              role: "tool",
              tool_call_id: call.id,
              content: global.WpsAiToolRegistry.serializeResult(result)
            });
          }

          if (finishReason === "stop") {
            await onEvent?.({ type: "done", text: fullText });
            return { content: fullText, iterations: iter + 1 };
          }
        }

        await onEvent?.({ type: "done", text: "", aborted: true });
        throw new Error(`工具调用循环达到上限（${maxIterations}），仍未结束。`);
      }
    };
  }

  global.WpsAiProviderRegistry?.register("openai", createOpenAIProvider);
})(window);
