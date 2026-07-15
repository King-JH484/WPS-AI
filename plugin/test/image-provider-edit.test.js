const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

test("editImage: toapis 渠道走上传图片 + generations 编辑任务", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url).endsWith("/toapis-upload-image")) {
      const body = JSON.parse(opts.body);
      assert.equal(body.baseUrl, "https://toapis.com/v1");
      assert.equal(body.apiKey, "tok");
      assert.equal(body.imageMime, "image/png");
      assert.equal(body.imageBase64, "aGVsbG8=");
      return { ok: true, json: async () => ({ success: true, data: { url: "https://files.toapis.com/u/input.png" } }) };
    }
    if (String(url) === "https://toapis.com/v1/images/generations") {
      const body = JSON.parse(opts.body);
      assert.deepEqual(body.image_urls, ["https://files.toapis.com/u/input.png"]);
      assert.equal(body.model, "gpt-image-2");
      assert.equal(body.prompt, "移除背景");
      assert.equal(body.size, "auto");
      assert.equal(body.quality, "medium");
      assert.equal(body.output_format, "png");
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          result: { data: [{ url: "https://files.toapis.com/u/out.png" }] }
        })
      };
    }
    throw new Error("unexpected fetch " + url);
  };

  const image = loadImageClient({
    imageConfig: {
      enabled: true,
      type: "toapis",
      baseUrl: "https://toapis.com/v1",
      apiKey: "tok",
      model: "gpt-image-2",
      defaultSize: "1:1",
      defaultResolution: "1K",
      useProxy: false
    },
    fetchImpl
  });

  const result = await image.editImage({
    imageDataUrl: "data:image/png;base64,aGVsbG8=",
    prompt: "移除背景",
    background: "transparent"
  });

  assert.deepEqual(result, [{ url: "https://files.toapis.com/u/out.png", b64: null, revisedPrompt: null }]);
  assert.equal(calls.length, 2);
});

test("editImage: toapis 局部重绘上传 mask 并传 mask_url", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (String(url).endsWith("/toapis-upload-image")) {
      const body = JSON.parse(opts.body);
      const isMask = body.imageBase64 === "bWFzaw==";
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            url: isMask
              ? "https://files.toapis.com/u/mask.png"
              : "https://files.toapis.com/u/input.png"
          }
        })
      };
    }
    if (String(url) === "https://toapis.com/v1/images/generations") {
      const body = JSON.parse(opts.body);
      assert.deepEqual(body.image_urls, ["https://files.toapis.com/u/input.png"]);
      assert.equal(body.mask_url, "https://files.toapis.com/u/mask.png");
      assert.equal(body.quality, "medium");
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          result: { data: [{ url: "https://files.toapis.com/u/out.png" }] }
        })
      };
    }
    throw new Error("unexpected fetch " + url);
  };

  const image = loadImageClient({
    imageConfig: {
      enabled: true,
      type: "toapis",
      baseUrl: "https://toapis.com/v1",
      apiKey: "tok",
      model: "gpt-image-2",
      useProxy: false
    },
    fetchImpl
  });

  const result = await image.editImage({
    imageDataUrl: "data:image/png;base64,aW1hZ2U=",
    maskDataUrl: "data:image/png;base64,bWFzaw==",
    prompt: "重绘涂抹区域"
  });

  assert.deepEqual(result, [{ url: "https://files.toapis.com/u/out.png", b64: null, revisedPrompt: null }]);
  assert.equal(calls.length, 3);
});
