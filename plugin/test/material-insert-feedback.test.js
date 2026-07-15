const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function functionBody(name) {
  const start = appJs.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const nextAsync = appJs.indexOf("\n  async function ", start + 1);
  const nextSync = appJs.indexOf("\n  function ", start + 1);
  const candidates = [nextAsync, nextSync].filter((idx) => idx !== -1);
  const end = candidates.length ? Math.min(...candidates) : appJs.length;
  return appJs.slice(start, end);
}

test("素材插入文档期间给用户明确进行中提示并临时禁用插入按钮", () => {
  assert.match(appJs, /function setMaterialInsertBusy\(isBusy\)/);

  const body = functionBody("insertMaterialIntoDocument");
  assert.match(body, /showMessage\("正在插入图片到文档，请稍候…", "info", \{ duration: 8000 \}\)/);
  assert.match(body, /setMaterialInsertBusy\(true\)/);
  assert.match(body, /setMaterialInsertBusy\(false\)/);

  const hintAt = body.indexOf('showMessage("正在插入图片到文档，请稍候…"');
  const executeAt = body.indexOf("WpsAiToolRegistry?.execute");
  assert.ok(hintAt >= 0 && executeAt > hintAt, "进行中提示应早于实际插入调用");
});

test("素材独立窗口派发插入请求时提示主面板正在执行", () => {
  const body = appJs.match(/function writeMaterialDialogRequest\(key, item\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(body, /key === MATERIAL_DIALOG_INSERT_KEY/);
  assert.match(body, /showMessage\(isInsertRequest \? "正在交给主面板插入图片，请稍候…" : "已派给主面板执行。", "info"/);
});
