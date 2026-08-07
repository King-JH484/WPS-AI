const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadCapabilities() {
  const code = fs.readFileSync(path.join(__dirname, "../js/providers/capabilities.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: "capabilities.js" });
  return sandbox.window.WpsAiCapabilities;
}

test("detects local Ollama thinking models", () => {
  const capabilities = loadCapabilities();
  assert.equal(capabilities.supportsThinking("qwen3.5:9b"), true);
  assert.equal(capabilities.supportsThinking("qwen35:9b"), true);
  assert.equal(capabilities.supportsThinking("openbmb/minicpm5:latest"), true);
});

test("detects local Ollama vision models without enabling text-only ones", () => {
  const capabilities = loadCapabilities();
  assert.equal(capabilities.supportsImage("qwen3.5:9b"), true);
  assert.equal(capabilities.supportsImage("qwen35:9b"), true);
  assert.equal(capabilities.supportsImage("openbmb/minicpm5:latest"), false);
});

test("provider capability overrides take precedence over model-name guesses", () => {
  const capabilities = loadCapabilities();
  capabilities.setCapabilityOverrides("ollama", [
    { modelId: "plain-local:latest", capabilities: { image: true, thinking: true, tools: false } },
    { modelId: "qwen3.5:9b", capabilities: { image: false } }
  ]);

  assert.equal(capabilities.getCapabilities("plain-local:latest", "ollama").image, true);
  assert.equal(capabilities.getCapabilities("plain-local:latest", "ollama").thinking, true);
  assert.equal(capabilities.getCapabilities("plain-local:latest", "ollama").tools, false);
  assert.equal(capabilities.getCapabilities("qwen3.5:9b", "ollama").image, false);
  assert.equal(capabilities.getCapabilities("qwen3.5:9b").image, true);
});

test("Kimi K3+ 原生多模态识别为图片模型；K2 及更早不误报", () => {
  const capabilities = loadCapabilities();
  // K3（2026-07 起）原生多模态
  assert.equal(capabilities.supportsImage("kimi-k3"), true);
  assert.equal(capabilities.supportsImage("kimi-k4"), true);
  assert.equal(capabilities.supportsImage("kimi-k10"), true);
  // 视觉专用变体历来支持
  assert.equal(capabilities.supportsImage("kimi-vl"), true);
  // K2 及更早是纯文本，别误报（否则会把图片发过去被服务端拒）
  assert.equal(capabilities.supportsImage("kimi-k2"), false);
  assert.equal(capabilities.supportsImage("kimi-k2-instruct"), false);
  assert.equal(capabilities.supportsImage("moonshot-v1-8k"), false);
  assert.equal(capabilities.supportsImage("kimi-latest"), false);
});

test("能力覆盖分层：models.dev 全局 + 供应商专属按键合并（专属胜出，其余保留全局）", () => {
  const caps = loadCapabilities();
  // models.dev 用全局键铺满四项
  caps.setCapabilityOverride("", "acme-1", { image: false, pdf: true, tools: true, thinking: false });
  // 用户手动只改 image=true（供应商专属）
  caps.setCapabilityOverride("myprov", "acme-1", { image: true });
  const c = caps.getCapabilities("acme-1", "myprov");
  assert.equal(c.image, true, "专属 image 覆盖全局");
  assert.equal(c.pdf, true, "全局 pdf 仍生效（未被专属清掉）");
  assert.equal(c.tools, true);
  // 换个没有专属覆盖的 provider → 只吃全局
  assert.equal(caps.getCapabilities("acme-1", "other").image, false);
});

test("clearCapabilityOverride：清单键回到下层；清整条回到全局/正则", () => {
  const caps = loadCapabilities();
  caps.setCapabilityOverride("", "acme-2", { image: false });
  caps.setCapabilityOverride("p", "acme-2", { image: true, pdf: true });
  assert.equal(caps.getCapabilities("acme-2", "p").image, true);
  // 只清 image 键 → 回到全局 image:false，pdf 专属仍在
  caps.clearCapabilityOverride("p", "acme-2", "image");
  assert.equal(caps.getCapabilities("acme-2", "p").image, false);
  assert.equal(caps.getCapabilities("acme-2", "p").pdf, true);
  // 清整条 → pdf 也回落（全局没 pdf → 走正则，acme-2 正则判 false）
  caps.clearCapabilityOverride("p", "acme-2");
  assert.equal(caps.getCapabilities("acme-2", "p").pdf, false);
});

test("学到的 force-off 纠正 models.dev 假阳性（⑤ 的内核）", () => {
  const caps = loadCapabilities();
  // 目录说支持图片
  caps.setCapabilityOverride("", "acme-omni", { image: true });
  assert.equal(caps.getCapabilities("acme-omni", "gw").image, true);
  // 但该网关实际拒绝了 → 学到专属 image:false
  caps.setCapabilityOverride("gw", "acme-omni", { image: false });
  assert.equal(caps.getCapabilities("acme-omni", "gw").image, false, "专属 force-off 压过全局");
  // 别的网关不受影响
  assert.equal(caps.getCapabilities("acme-omni", "gw2").image, true);
});
