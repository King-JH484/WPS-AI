const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("素材编辑成功后预览切换到新生成素材，插入使用新 entry", () => {
  assert.match(appJs, /function activateMaterialPreviewEntry\(entry\)/);
  assert.match(appJs, /materialPreviewItemId = entry\.id/);

  const addSuccessBranches = appJs.match(/if \(entry\) \{[\s\S]*?activateMaterialPreviewEntry\(entry\);[\s\S]*?renderMaterialLibrary\(\);[\s\S]*?\}/g) || [];
  assert.ok(addSuccessBranches.length >= 4, "抠图、画笔抠图、描述抠图、局部重绘成功后都应切换预览素材");
});

test("素材弹窗派发插入请求时携带素材快照，避免主面板同步延迟查不到 id", () => {
  const fn = appJs.match(/function writeMaterialDialogRequest\(key, item\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(fn, /localStorage\.setItem\(key, JSON\.stringify/);
  assert.match(fn, /id: item\.id/);
  assert.match(fn, /item: \{/);
  assert.match(fn, /url: item\.url/);
  assert.match(fn, /dataUrl: item\.dataUrl/);
});
