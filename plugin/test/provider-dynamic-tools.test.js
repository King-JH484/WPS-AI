const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const providers = ["openai.js", "openai-responses.js", "codex.js", "anthropic.js", "gemini.js"];

test("每个 provider 都在每次工具循环中重新解析工具 snapshot", () => {
  for (const file of providers) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "providers", file), "utf8");
    const loopAt = source.indexOf("for (let iter = 0; iter < maxIterations; iter += 1)");
    assert.ok(loopAt >= 0, `${file} 缺少工具循环`);
    const resolveAt = source.indexOf("resolveToolSnapshot", loopAt);
    assert.ok(resolveAt > loopAt, `${file} 未在循环内调用 resolveToolSnapshot`);
    assert.match(source.slice(resolveAt, resolveAt + 900), /toolSnapshot\.definitions/,
      `${file} 未从动态 snapshot 生成请求 schema`);
  }
});

test("provider facade 向实现层透传 resolver 与工具上下文", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "openai.js"), "utf8");
  assert.match(source, /resolveTools/);
  assert.match(source, /toolContext/);
  assert.match(source, /provider\.runWithTools\([\s\S]*resolveTools[\s\S]*toolContext/);
});
