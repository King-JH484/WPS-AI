(function attachImageClient(global) {
  "use strict";

  const PROXY_PREFIX = "http://localhost:3890/forward/";

  // 把 baseUrl 包装为本地 CORS 代理转发地址（如果开启了代理）
  function wrapProxy(baseUrl, useProxy) {
    const base = (baseUrl || "").replace(/\/+$/, "");
    if (!base) return "";
    if (useProxy === false) return base;
    return PROXY_PREFIX + encodeURIComponent(base);
  }

  function authHeaders(apiKey, withContentType = true) {
    const h = { Authorization: `Bearer ${apiKey}` };
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

  // 从任务状态响应里抠出 0~100 的进度值（toapis 字段可能叫 progress / percent / ...）
  function pickProgress(task) {
    if (!task || typeof task !== "object") return null;
    const candidates = [task.progress, task.percent, task.complete_percent, task.completion_percent];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n);
      if (Number.isFinite(n) && n > 100 && n <= 1) return Math.round(n * 100); // 0~1 小数
    }
    if (Number.isFinite(+task.completed_steps) && Number.isFinite(+task.total_steps) && +task.total_steps > 0) {
      return Math.round((+task.completed_steps / +task.total_steps) * 100);
    }
    return null;
  }

  function pickStatus(task) {
    return String(task?.status || task?.state || "unknown").toLowerCase();
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

  // 把激活渠道的 imageProviders entry 拍成 endpoint。
  // 各渠道 entry 自己已经是扁平结构，这里主要补默认值 + 把 size/resolution 概念对齐。
  function resolveEndpoint(config) {
    const type = config.type || "toapis";
    if (type === "codex-bridge") {
      return {
        type,
        baseUrl: config.baseUrl || "",
        apiKey: config.apiKey || "",
        model: config.model || "gpt-image-1",
        size: config.defaultSize || "1024x1024",
        useProxy: config.useProxy !== false
      };
    }
    // toapis（默认）
    return {
      type: "toapis",
      baseUrl: config.baseUrl || "",
      apiKey: config.apiKey || "",
      model: config.model || "gpt-image-2",
      size: config.defaultSize || "1:1",
      resolution: config.defaultResolution || "1K",
      useProxy: config.useProxy !== false
    };
  }

  /**
   * toapis.com / GPT-Image-2 流程：
   * 1) POST {base}/images/generations 创建任务
   * 2) 轮询 GET {base}/images/generations/{id} 直到 status === "completed"
   */
  async function generateImageToapis({ endpoint, prompt, size, resolution, n, model, signal, onProgress }) {
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) throw new Error("请在设置中填写图像生成端点的 Base URL（默认 https://toapis.com/v1）。");

    const body = {
      model: model || endpoint.model,
      prompt,
      size: size || endpoint.size || "1:1",
      resolution: resolution || endpoint.resolution || "1K",
      n: Math.max(1, Math.min(4, n || 1)),
      response_format: "url"
    };

    let createResp;
    try {
      createResp = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : "（已走本地代理 http://localhost:3890，请确认代理服务在运行 / Base URL 域名可达）";
      throw new Error(`图像服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    const createPayload = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      throw new Error(createPayload.error?.message || createPayload.message || `任务创建失败：${createResp.status}`);
    }

    let task = createPayload;
    const start = Date.now();
    const reportProgress = (t) => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress({
          status: pickStatus(t),
          progress: pickProgress(t),
          elapsedMs: Date.now() - start,
          taskId: t?.id || null,
          prompt
        });
      } catch (e) { /* 上报失败不影响主流程 */ }
    };

    reportProgress(task);

    if (task?.status === "completed" && task?.result?.data) {
      reportProgress({ ...task, progress: 100 });
      return mapResultData(task.result.data);
    }
    if (task?.status === "failed") {
      throw new Error(extractFailReason(task));
    }
    if (!task?.id) {
      throw new Error("任务创建后未返回 task id，无法继续轮询。");
    }

    const taskUrl = `${base}/images/generations/${encodeURIComponent(task.id)}`;
    const maxWaitMs = 180_000;
    let nextDelay = 1500;

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (Date.now() - start > maxWaitMs) {
        throw new Error("图像生成超时（>3 分钟）。可在 toapis 控制台用 task id 继续查询：" + task.id);
      }

      await delay(nextDelay, signal);
      nextDelay = Math.min(nextDelay + 500, 4000);

      const statusResp = await fetch(taskUrl, {
        method: "GET",
        headers: authHeaders(endpoint.apiKey, false),
        signal
      });
      const statusPayload = await statusResp.json().catch(() => ({}));
      if (!statusResp.ok) {
        throw new Error(statusPayload.error?.message || statusPayload.message || `任务查询失败：${statusResp.status}`);
      }
      task = statusPayload;
      reportProgress(task);

      if (task?.status === "completed") {
        const data = task.result?.data || [];
        if (data.length === 0) throw new Error("任务完成但未返回任何图片。");
        reportProgress({ ...task, progress: 100 });
        return mapResultData(data);
      }
      if (task?.status === "failed") {
        throw new Error(extractFailReason(task));
      }
    }
  }

  /**
   * codex-bridge / OpenAI 兼容同步图像 API（sub2api 等中转平台）
   *   POST {base}/images/generations
   *     body: { model, prompt, size:"1024x1024"|"1792x1024"|..., n, response_format }
   *     resp: { data: [{ url } 或 { b64_json }] }
   *
   * 这条路径没有任务 id / 轮询，是阻塞调用。onProgress 在请求开始/结束时各打一次，
   * 让 UI 进度条仍然能动起来。
   */
  async function generateImageCodexBridge({ endpoint, prompt, size, n, model, signal, onProgress }) {
    const base = wrapProxy(endpoint.baseUrl, endpoint.useProxy);
    if (!base) throw new Error("请在设置中填写 Codex 桥接的 Base URL（sub2api 等中转平台地址）。");

    const body = {
      model: model || endpoint.model,
      prompt,
      size: size || endpoint.size || "1024x1024",
      n: Math.max(1, Math.min(4, n || 1)),
      response_format: "url"
    };

    const start = Date.now();
    const report = (status, progress) => {
      if (typeof onProgress !== "function") return;
      try {
        onProgress({ status, progress, elapsedMs: Date.now() - start, taskId: null, prompt });
      } catch (e) { /* ignore */ }
    };

    report("in_progress", null);

    let resp;
    try {
      resp = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      // 网络层抛错（fetch 本身就 failed）。给出比浏览器默认 "Failed to fetch" 更可操作的提示。
      if (err?.name === "AbortError") throw err;
      const proxyHint = endpoint.useProxy === false
        ? "（当前未走本地代理，浏览器 CORS 也可能拦截，建议在设置里勾上「通过本地 CORS 代理」）"
        : "（已走本地代理 http://localhost:3890，请确认代理服务在运行 / Base URL 域名可达）";
      throw new Error(`图像服务连接失败：${err?.message || err} ${proxyHint}`);
    }
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // 代理 502 的 body 里已经带可读 message（含 host、ETIMEDOUT/ENOTFOUND 等翻译过的提示）
      throw new Error(payload.error?.message || payload.message || `图像生成失败：${resp.status}`);
    }

    const data = Array.isArray(payload.data) ? payload.data : [];
    if (data.length === 0) throw new Error("接口返回成功但没有任何图片数据。");

    report("completed", 100);
    return mapResultData(data);
  }

  /**
   * 统一入口：根据全局配置的 type 字段分发到对应渠道。
   * 调用方完全无感知 - 还是传 { prompt, size, resolution, n, model, signal, onProgress }。
   * resolution 仅对 toapis 生效；codex-bridge 用 size 当 "1024x1024" 这样的实际像素值。
   */
  async function generateImage({ prompt, size, resolution, n = 1, model, signal, onProgress } = {}) {
    if (!prompt || typeof prompt !== "string") throw new Error("生成图片必须提供 prompt。");

    const config = global.WpsAiProviderRegistry.getImageConfig();
    if (!config.enabled) {
      throw new Error("图像生成未启用，请在「设置 → 图像生成」中开启并填写 baseUrl/apiKey。");
    }

    const endpoint = resolveEndpoint(config);
    if (!endpoint.apiKey) throw new Error("请在设置中填写当前渠道的 API Key。");

    if (endpoint.type === "codex-bridge") {
      return generateImageCodexBridge({ endpoint, prompt, size, n, model, signal, onProgress });
    }
    return generateImageToapis({ endpoint, prompt, size, resolution, n, model, signal, onProgress });
  }

  global.WpsAiImage = { generateImage };
})(window);
