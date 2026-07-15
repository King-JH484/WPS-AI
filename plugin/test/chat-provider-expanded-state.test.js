const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

function functionBody(name) {
  const start = appJs.indexOf(`function ${name}`);
  assert.ok(start >= 0, `找不到函数 ${name}`);
  const next = appJs.indexOf("\n  function ", start + 1);
  return appJs.slice(start, next > start ? next : undefined);
}

test("聊天供应商列表重渲时保留已展开的供应商卡片", () => {
  const body = functionBody("renderChatProvidersList");

  assert.match(body, /expandedProviderIds/, "重渲前应记录当前已展开供应商");
  assert.match(body, /querySelectorAll\(["']\.chat-provider-card\.expanded["']\)/, "应从现有 DOM 收集展开卡片");
  assert.match(body, /expandedProviderIds\.has\(p\.id\)/, "重建卡片时应按 provider id 恢复展开状态");
});

test("图像供应商列表重渲时保留已展开的供应商卡片", () => {
  const body = functionBody("renderImageProvidersList");

  assert.match(body, /expandedImageProviderIds/, "重渲前应记录当前已展开图像供应商");
  assert.match(body, /querySelectorAll\(["']\.chat-provider-card\.expanded["']\)/, "应从现有 DOM 收集展开卡片");
  assert.match(body, /dataset\.imageProviderId/, "应按 image provider id 收集展开状态");
  assert.match(body, /expandedImageProviderIds\.has\(p\.id\)/, "重建卡片时应按 image provider id 恢复展开状态");
});
