const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("智能抠图 AI 回退不再把 ToAPI 渠道提前拦截", () => {
  assert.doesNotMatch(appJs, /当前渠道不支持 AI 抠图/);
  assert.match(appJs, /WpsAiImage\.editImage\(\{/);
  assert.match(appJs, /imageProviderType === "codex-bridge" \|\| imageProviderType === "toapis"/);
});
