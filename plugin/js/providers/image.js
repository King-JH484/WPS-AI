(function attachImageClient(global) {
  "use strict";

  const PROXY_PREFIX = "http://localhost:3890/forward/";

  function resolveBase(config) {
    const base = (config.baseUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("请在设置中填写图像生成端点的 Base URL（默认 https://toapis.com/v1）。");
    if (config.useProxy === false) return base;
    return PROXY_PREFIX + encodeURIComponent(base);
  }

  function authHeaders(config, withContentType = true) {
    const h = { Authorization: `Bearer ${config.apiKey}` };
    if (withContentType) h["Content-Type"] = "application/json";
    return h;
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort);
    });
  }

  /**
   * toapis.com / GPT-Image-2 流程：
   * 1) POST {base}/images/generations 创建任务
   *    body: { model, prompt, size:"1:1"|"16:9"...,  resolution:"1K"|"2K"|"4K", n, response_format:"url" }
   *    返回: { id, status:"queued", ... } 或同步返回 status:"completed"
   * 2) 轮询 GET {base}/images/generations/{id} 直到 status === "completed"
   *    完成后从 result.data[i].url 取图片
   */
  async function generateImage({ prompt, size, resolution, n = 1, model, signal } = {}) {
    if (!prompt || typeof prompt !== "string") throw new Error("生成图片必须提供 prompt。");

    const config = global.WpsAiProviderRegistry.getImageConfig();
    if (!config.enabled) {
      throw new Error("图像生成未启用，请在「设置 → 图像生成」中开启并填写 baseUrl/apiKey。");
    }
    if (!config.apiKey) throw new Error("请在设置中填写图像生成的 API Key。");

    const base = resolveBase(config);

    const body = {
      model: model || config.model || "gpt-image-2",
      prompt,
      size: size || config.defaultSize || "1:1",
      resolution: resolution || config.defaultResolution || "1K",
      n: Math.max(1, Math.min(4, n || 1)),
      response_format: "url"
    };

    // ---- 1) 创建任务 ----
    const createResp = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(body),
      signal
    });
    const createPayload = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      throw new Error(createPayload.error?.message || createPayload.message || `任务创建失败：${createResp.status}`);
    }

    let task = createPayload;

    // 部分服务/部分模型可能直接同步返回完成结果
    if (task?.status === "completed" && task?.result?.data) {
      return mapResultData(task.result.data);
    }
    if (task?.status === "failed") {
      throw new Error(extractFailReason(task));
    }
    if (!task?.id) {
      throw new Error("任务创建后未返回 task id，无法继续轮询。");
    }

    // ---- 2) 轮询任务状态 ----
    const taskUrl = `${base}/images/generations/${encodeURIComponent(task.id)}`;
    const start = Date.now();
    const maxWaitMs = 180_000; // 3 分钟硬上限
    let nextDelay = 1500;

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (Date.now() - start > maxWaitMs) {
        throw new Error("图像生成超时（>3 分钟）。可在 toapis 控制台用 task id 继续查询：" + task.id);
      }

      await delay(nextDelay, signal);
      nextDelay = Math.min(nextDelay + 500, 4000); // 缓慢退避，最多 4s 一次

      const statusResp = await fetch(taskUrl, {
        method: "GET",
        headers: authHeaders(config, false),
        signal
      });
      const statusPayload = await statusResp.json().catch(() => ({}));
      if (!statusResp.ok) {
        throw new Error(statusPayload.error?.message || statusPayload.message || `任务查询失败：${statusResp.status}`);
      }
      task = statusPayload;

      if (task?.status === "completed") {
        const data = task.result?.data || [];
        if (data.length === 0) throw new Error("任务完成但未返回任何图片。");
        return mapResultData(data);
      }
      if (task?.status === "failed") {
        throw new Error(extractFailReason(task));
      }
      // queued / in_progress → 继续轮询
    }
  }

  function mapResultData(data) {
    return data.map((item) => ({
      url: item.url || null,
      b64: item.b64_json || null,
      revisedPrompt: item.revised_prompt || null
    }));
  }

  function extractFailReason(task) {
    const reason = task?.failure_reason
      || task?.error?.message
      || task?.error
      || task?.metadata?.error
      || "未知错误";
    return `图像生成失败：${reason}`;
  }

  global.WpsAiImage = { generateImage };
})(window);
