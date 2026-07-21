const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadImageClient({ imageConfig, fetchImpl }) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "image.js"), "utf8");
  const window = {
    WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890", forwardPrefix: () => "http://127.0.0.1:3890/forward/" },
    WpsAiProviderRegistry: { getImageConfig: () => imageConfig }
  };
  const factory = vm.runInThisContext(
    "(function(window, fetch, console, setInterval, clearInterval, DOMException){ " + code + "\n return window.WpsAiImage; })"
  );
  return factory(window, fetchImpl, console, setInterval, clearInterval, DOMException);
}

const booguConfig = {
  enabled: true, type: "boogu",
  baseUrl: "http://127.0.0.1:8000/v1", apiKey: "",
  defaultSize: "1:1", resolution: 1024, steps: 4, useProxy: false
};

// 异步端点双阶段 mock：submit → 返回 taskId；result → 直接 done（带 data）。
// 捕获提交时 payload（width/height/steps）供断言。
function booguAsyncFetch(onSubmit, resultData) {
  return async (url, opts = {}) => {
    const s = String(url);
    if (s.endsWith("/local-image/generate")) {
      const req = JSON.parse(opts.body);
      if (onSubmit) onSubmit(req);
      return { ok: true, json: async () => ({ ok: true, taskId: "limg_test" }) };
    }
    if (s.includes("/local-image/result")) {
      return { ok: true, json: async () => ({ ok: true, status: "done", data: { data: resultData || [{ url: "C:/out/boogu_0.png" }] } }) };
    }
    throw new Error("unexpected fetch " + s);
  };
}

test("generateImage: boogu 走异步端点，提交 payload 含 width/height/steps，url 指向目标", async () => {
  let req = null;
  const image = loadImageClient({ imageConfig: booguConfig, fetchImpl: booguAsyncFetch((r) => { req = r; }) });
  const r = await image.generateImage({ prompt: "一只猫", size: "1:1" });
  assert.equal(req.url, "http://127.0.0.1:8000/v1/images/generations");
  assert.equal(req.payload.width, 1024); // 1:1 @ 1024 档 → 1024×1024
  assert.equal(req.payload.height, 1024);
  assert.equal(req.payload.steps, 4);
  assert.equal(req.payload.response_format, "url");
  assert.equal("model" in req.payload, false);
  assert.deepEqual(r, [{ url: "C:/out/boogu_0.png", b64: null, revisedPrompt: null }]);
});

test("generateImage: boogu 分辨率档位=长边，比例算短边（1024 档 16:9→1024×512）", async () => {
  const grab = async (size, resolution) => {
    let req = null;
    const cfg = Object.assign({}, booguConfig, resolution ? { resolution } : {});
    const image = loadImageClient({ imageConfig: cfg, fetchImpl: booguAsyncFetch((r) => { req = r; }) });
    await image.generateImage({ prompt: "p", size });
    return req.payload;
  };
  // 1024 档：长边 1024，16:9 短边 = 1024×9/16=576 → 吸附 512
  assert.deepEqual(await grab("16:9").then((p) => [p.width, p.height]), [1024, 512]);
  assert.deepEqual(await grab("9:16").then((p) => [p.width, p.height]), [512, 1024]);
  assert.deepEqual(await grab("1:1").then((p) => [p.width, p.height]), [1024, 1024]);
  // 2K 档（1536）：16:9 → 1536 × snap(864)=768
  assert.deepEqual(await grab("16:9", 1536).then((p) => [p.width, p.height]), [1536, 768]);
  // 768 档：1:1 → 768×768
  assert.deepEqual(await grab("1:1", 768).then((p) => [p.width, p.height]), [768, 768]);
  // 显式像素忽略 resolution，直接吸附
  assert.deepEqual(await grab("800x1300", 2048).then((p) => [p.width, p.height]), [768, 1280]);
});

test("generateImage: boogu 本地无鉴权，空 apiKey 不报错；提交不带 Authorization", async () => {
  let req = null;
  const image = loadImageClient({ imageConfig: booguConfig, fetchImpl: booguAsyncFetch((r) => { req = r; }) });
  await assert.doesNotReject(() => image.generateImage({ prompt: "p" }));
  assert.deepEqual(req.headers, {}); // 空 key → 不带 Authorization
});

test("generateImage: boogu 轮询 pending→done", async () => {
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const s = String(url);
    if (s.endsWith("/local-image/generate")) return { ok: true, json: async () => ({ ok: true, taskId: "t1" }) };
    polls += 1;
    if (polls < 2) return { ok: true, json: async () => ({ ok: true, status: "pending", elapsedMs: 2000 }) };
    return { ok: true, json: async () => ({ ok: true, status: "done", data: { data: [{ url: "ok.png" }] } }) };
  };
  const image = loadImageClient({ imageConfig: booguConfig, fetchImpl });
  const r = await image.generateImage({ prompt: "p" });
  assert.equal(r[0].url, "ok.png");
  assert.ok(polls >= 2);
});

test("generateImage: boogu 代理端报 error 状态 → 抛错", async () => {
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.endsWith("/local-image/generate")) return { ok: true, json: async () => ({ ok: true, taskId: "t1" }) };
    return { ok: true, json: async () => ({ ok: true, status: "error", error: "本地生图服务 HTTP 500" }) };
  };
  const image = loadImageClient({ imageConfig: booguConfig, fetchImpl });
  await assert.rejects(() => image.generateImage({ prompt: "p" }), /Boogu 生图失败.*HTTP 500/);
});

test("editImage: boogu 明确拒绝抠图/编辑", async () => {
  const image = loadImageClient({ imageConfig: booguConfig, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(
    () => image.editImage({ imageDataUrl: "data:image/png;base64,aGk=", prompt: "去背景" }),
    /只支持生成图片，不支持抠图/
  );
});

test("接线：registry 内置 boogu + app.js UI/类型选择器/isBuiltin", () => {
  const reg = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "registry.js"), "utf8");
  assert.match(reg, /id: "boogu", type: "boogu"/);
  const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  assert.match(appJs, /p\.type === "boogu"/);
  assert.match(appJs, /type: "boogu"/);
  assert.match(appJs, /"toapis", "codex-bridge", "openai", "openrouter", "boogu"/);
  // boogu 不在支持抠图的渠道列表
  assert.doesNotMatch(appJs, /"codex-bridge", "toapis", "openai", "openrouter", "boogu"/);
});

test("接线：boogu 连通性测试走 /health（不走 /models），去掉 /v1 后缀", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  // 测试入口按 type 分派到 testBooguConnectivity
  assert.match(appJs, /if \(entry\.type === "boogu"\) return testBooguConnectivity\(entry\)/);
  assert.match(appJs, /function testBooguConnectivity/);
  // /v1 去尾 + 探 /health + 代理 forward + 直连兜底
  assert.match(appJs, /replace\(\/\\\/v1\$\/i, ""\)/);
  assert.match(appJs, /"\/health"/);
  assert.match(appJs, /"\/forward\/"/);
});
