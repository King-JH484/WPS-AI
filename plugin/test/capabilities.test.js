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
