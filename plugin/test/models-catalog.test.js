const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCatalog() {
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "models-catalog.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiModelsCatalog;
}

// models.dev 记录 → 能力对象
test("capsFromModel: modalities.input / tool_call / reasoning 正确映射", () => {
  const { capsFromModel } = loadCatalog();
  assert.deepEqual(
    capsFromModel({ modalities: { input: ["text", "image"] }, tool_call: true, reasoning: false }),
    { image: true, tools: true, thinking: false }
  );
  // 纯文本模型：image 断言为 false（可纠正正则误判）
  assert.deepEqual(
    capsFromModel({ modalities: { input: ["text"] }, tool_call: true, reasoning: true }),
    { image: false, tools: true, thinking: true }
  );
  // pdf 只正断言：input 含 pdf → pdf:true；不含则不写 pdf 键（留给插件白名单）
  assert.equal("pdf" in capsFromModel({ modalities: { input: ["text", "image"] } }), false);
  assert.equal(capsFromModel({ modalities: { input: ["text", "pdf"] } }).pdf, true);
});

test("buildOverrideRecords: 展平所有 provider + 完整 id 与裸 id 各索引一条", () => {
  const { buildOverrideRecords } = loadCatalog();
  const catalog = {
    moonshotai: {
      models: {
        "kimi-k3": { id: "kimi-k3", modalities: { input: ["text", "image", "video"] }, tool_call: true, reasoning: true }
      }
    },
    openrouter: {
      models: {
        "moonshotai/kimi-k3": { id: "moonshotai/kimi-k3", modalities: { input: ["text", "image"] }, tool_call: true }
      }
    }
  };
  const records = buildOverrideRecords(catalog);
  const byId = Object.fromEntries(records.map((r) => [r.modelId, r.capabilities]));
  // 裸 id
  assert.equal(byId["kimi-k3"].image, true);
  // 带前缀的完整 id 也在
  assert.equal(byId["moonshotai/kimi-k3"].image, true);
  // 前缀 id 会额外补一条裸 id（同样能被裸 id 查到）
  assert.ok("kimi-k3" in byId);
});

test("buildOverrideRecords: 无模态/无能力字段的模型跳过，坏结构安全", () => {
  const { buildOverrideRecords } = loadCatalog();
  assert.deepEqual(buildOverrideRecords(null), []);
  assert.deepEqual(buildOverrideRecords({ p: { models: { m: { id: "m" } } } }), []); // 没任何能力字段 → 跳过
  assert.deepEqual(buildOverrideRecords({ p: {} }), []); // 没 models
});

// 端到端：注入 override 后，capabilities 对纯文本正则模型也能按目录判为多模态
test("注入后 capabilities 用目录覆盖名字正则（含 kimi-k2 若目录标多模态则以目录为准）", () => {
  // 载入真正的 capabilities.js + models-catalog.js 到同一 window
  const context = { window: {}, console };
  context.window.window = context.window;
  vm.createContext(context);
  const capCode = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "capabilities.js"), "utf8");
  const catCode = fs.readFileSync(path.join(__dirname, "..", "js", "providers", "models-catalog.js"), "utf8");
  vm.runInContext(capCode, context);
  vm.runInContext(catCode, context);
  const caps = context.window.WpsAiCapabilities;
  const cat = context.window.WpsAiModelsCatalog;

  // 一个正则判不出图片的假模型名
  assert.equal(caps.supportsImage("acme-omni-1"), false);
  // 目录说它多模态 → 注入 override
  const records = cat.buildOverrideRecords({
    acme: { models: { "acme-omni-1": { id: "acme-omni-1", modalities: { input: ["text", "image"] } } } }
  });
  caps.setCapabilityOverrides("", records);
  assert.equal(caps.getCapabilities("acme-omni-1").image, true, "目录覆盖后应判为多模态");
});
