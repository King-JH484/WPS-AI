const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const taskpane = fs.readFileSync(path.join(__dirname, "../taskpane.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");

function functionBody(name) {
  const start = appJs.indexOf(`function ${name}`);
  assert.ok(start >= 0, `找不到函数 ${name}`);
  const next = appJs.indexOf("\n  function ", start + 1);
  return appJs.slice(start, next > start ? next : undefined);
}

test("本地模型推荐在聊天供应商列表上方有独立容器", () => {
  const guideSlotIndex = taskpane.indexOf('id="localModelGuideSlot"');
  const providersIndex = taskpane.indexOf('id="chatProvidersList"');

  assert.ok(guideSlotIndex >= 0, "聊天模型设置应提供独立的本地模型推荐容器");
  assert.ok(providersIndex >= 0, "聊天模型设置应保留供应商列表容器");
  assert.ok(guideSlotIndex < providersIndex, "本地模型推荐应显示在所有供应商卡片上方");
  assert.match(css, /\.local-model-guide-slot\s*\{/, "独立容器需要可控的间距样式");
});

test("聊天供应商卡片渲染不再把本地模型推荐塞进 Ollama 卡片", () => {
  const body = functionBody("renderChatProvidersList");

  assert.match(body, /renderLocalModelGuideSlot\(\)/, "供应商列表重渲时应同步刷新置顶推荐");
  assert.doesNotMatch(body, /const\s+localGuide\s*=/, "卡片体内不应再生成 localGuide");
  assert.doesNotMatch(body, /\$\{localGuide\}/, "卡片体内不应再插入 localGuide");
});
