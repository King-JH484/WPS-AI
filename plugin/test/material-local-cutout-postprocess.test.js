const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../taskpane.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("素材预览提供独立的本地模型抠图按钮", () => {
  assert.match(html, /id="materialLocalCutoutBtn"/);
  assert.match(html, />本地模型抠图</);
  assert.match(appJs, /"materialLocalCutoutBtn"/);
  assert.match(appJs, /function localCutoutCurrentMaterial\(\)/);
  assert.match(appJs, /materialLocalCutoutBtn\?\.addEventListener\("click", localCutoutCurrentMaterial\)/);
});

test("AI 抠图结果入库前会再走本地模型输出透明 PNG", () => {
  assert.match(appJs, /async function cutoutResultToStored\(results,\s*opts\)/);
  assert.match(appJs, /await localCutoutDataUrlToStored\(dataUrl,\s*\{/);
  assert.match(appJs, /setEditProgressLabel\("本地透明化"\)/);
  assert.match(appJs, /throw new Error\("AI 抠图结果本地透明化失败/);
});
