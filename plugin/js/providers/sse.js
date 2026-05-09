(function attachSseUtil(global) {
  "use strict";

  async function readSse(response, handleEvent) {
    if (!response.body) {
      throw new Error("当前环境不支持 ReadableStream，无法使用流式输出。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let currentEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        currentEvent = "";
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (dataLines.length === 0) {
          continue;
        }
        const data = dataLines.join("\n");
        if (data === "[DONE]") {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (error) {
          continue;
        }
        // 跳过 null/非对象 payload，避免下游 handler 取 .choices/.delta 时崩溃
        if (parsed == null || typeof parsed !== "object") {
          continue;
        }
        await handleEvent(currentEvent || parsed.type || "", parsed);
      }
    }
  }

  global.WpsAiSse = { readSse };
})(window);
