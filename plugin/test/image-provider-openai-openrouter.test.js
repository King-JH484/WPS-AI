const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 与 image-provider-edit.test.js 相同的加载方式：vm 里跑 IIFE，注入 mock fetch。
function loadImageClient({ imageConfig, fetchImpl }) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "image.js"), "utf8");
  const window = {
    WpsAiRuntime: {
      proxyBase: () => "http://127.0.0.1:3890",
      forwardPrefix: () => "http://127.0.0.1:3890/forward/"
    },
    WpsAiProviderRegistry: {
      getImageConfig: () => imageConfig
    }
  };
  const factory = vm.runInThisContext(
    "(function(window, fetch, console, setInterval, clearInterval, DOMException){ " + code + "\n return window.WpsAiImage; })"
  );
  return factory(window, fetchImpl, console, setInterval, clearInterval, DOMException);
}

test("generateImage: openai 官方渠道把比例 size 折算成像素白名单", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url) === "https://api.openai.com/v1/images/generations") {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, "gpt-image-1");
      // "16:9" → gpt-image-1 的宽图档
      assert.equal(body.size, "1536x1024");
      // gpt-image-1 不带 response_format（否则官方 400）
      assert.equal("response_format" in body, false);
      return { ok: true, json: async () => ({ data: [{ url: "https://oai.example.com/out.png" }] }) };
    }
    throw new Error("unexpected fetch " + url);
  };

  const image = loadImageClient({
    imageConfig: {
      enabled: true,
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-1",
      defaultSize: "1024x1024",
      useProxy: false
    },
    fetchImpl
  });

  const result = await image.generateImage({ prompt: "一只猫", size: "16:9" });
  assert.deepEqual(result, [{ url: "https://oai.example.com/out.png", b64: null, revisedPrompt: null }]);
  assert.equal(calls.length, 1);
});

test("generateImage: openai dall-e-3 竖图映射 1024x1792 且 n 强制 1、带 response_format", async () => {
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "dall-e-3");
    assert.equal(body.size, "1024x1792");
    assert.equal(body.n, 1); // 官方 dall-e-3 只允许 n=1
    assert.equal(body.response_format, "url");
    return { ok: true, json: async () => ({ data: [{ url: "https://oai.example.com/tall.png" }] }) };
  };

  const image = loadImageClient({
    imageConfig: {
      enabled: true, type: "openai",
      baseUrl: "https://api.openai.com/v1", apiKey: "sk-test",
      model: "dall-e-3", useProxy: false
    },
    fetchImpl
  });

  const result = await image.generateImage({ prompt: "海报", size: "9:16", n: 3 });
  assert.equal(result[0].url, "https://oai.example.com/tall.png");
});

test("generateImage: openrouter 走 chat/completions + modalities，dataURL 落地为本地路径", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url) === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, "google/gemini-2.5-flash-image");
      assert.deepEqual(body.modalities, ["image", "text"]);
      assert.match(body.messages[0].content, /一只狗/);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: "",
              images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } }]
            }
          }]
        })
      };
    }
    if (String(url) === "http://127.0.0.1:3890/upload-image") {
      const body = JSON.parse(opts.body);
      assert.match(body.dataUrl, /^data:image\/png;base64,aW1n$/);
      return { ok: true, json: async () => ({ path: "C:/tmp/lingxi/out.png" }) };
    }
    throw new Error("unexpected fetch " + url);
  };

  const image = loadImageClient({
    imageConfig: {
      enabled: true, type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
      model: "google/gemini-2.5-flash-image", useProxy: false
    },
    fetchImpl
  });

  const result = await image.generateImage({ prompt: "一只狗" });
  assert.equal(result[0].url, "C:/tmp/lingxi/out.png");
  assert.equal(calls.length, 2);
});

test("generateImage: openrouter 模型不出图时报可操作错误", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "I can only describe images." } }] })
  });
  const image = loadImageClient({
    imageConfig: {
      enabled: true, type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
      model: "openai/gpt-4o", useProxy: false
    },
    fetchImpl
  });
  await assert.rejects(
    () => image.generateImage({ prompt: "画个图" }),
    /模型未返回图片[\s\S]*图像输出/
  );
});

test("editImage: openrouter 把原图作为多模态输入传给 chat/completions", async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (String(url) === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(opts.body);
      const content = body.messages[0].content;
      assert.equal(content[0].type, "text");
      assert.equal(content[1].type, "image_url");
      assert.equal(content[1].image_url.url, "data:image/png;base64,aW1hZ2U=");
      assert.deepEqual(body.modalities, ["image", "text"]);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { images: [{ image_url: { url: "https://or.example.com/edited.png" } }] } }]
        })
      };
    }
    throw new Error("unexpected fetch " + url);
  };
  const image = loadImageClient({
    imageConfig: {
      enabled: true, type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-test",
      model: "google/gemini-2.5-flash-image", useProxy: false
    },
    fetchImpl
  });
  const result = await image.editImage({
    imageDataUrl: "data:image/png;base64,aW1hZ2U=",
    prompt: "移除背景"
  });
  assert.deepEqual(result, [{ url: "https://or.example.com/edited.png", b64: null, revisedPrompt: null }]);
});
