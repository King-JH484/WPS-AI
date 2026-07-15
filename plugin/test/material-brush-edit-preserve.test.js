const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function functionBody(name, endMarker) {
  const start = appJs.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const end = appJs.indexOf(endMarker, start);
  assert.ok(end > start, `${name} end marker missing`);
  return appJs.slice(start, end);
}

test("画笔编辑保存为派生素材，不覆盖同 URL 原素材，也不沿用原图标签", () => {
  assert.match(appJs, /function retagEditedMaterialEntry\(entry,\s*opts\)/);

  const inpaint = functionBody("applyBrushInpaint", "\n  // 涂抹外接框");
  assert.match(inpaint, /allowDuplicate:\s*true/);
  assert.match(inpaint, /tags:\s*\["重绘"\]/);
  assert.match(inpaint, /retagEditedMaterialEntry\(entry,\s*\{\s*baseTags:\s*\["重绘"\]/);
  assert.doesNotMatch(inpaint, /item\.tags/);

  const noSelectionCutout = functionBody("runBrushCutoutWithoutSelection", "\n\n  // 抠出涂抹主体");
  assert.match(noSelectionCutout, /allowDuplicate:\s*true/);
  assert.match(noSelectionCutout, /tags:\s*\["抠图"\]/);
  assert.match(noSelectionCutout, /retagEditedMaterialEntry\(entry,\s*\{\s*baseTags:\s*\["抠图"\]/);
  assert.doesNotMatch(noSelectionCutout, /item\.tags/);

  const brushCutout = functionBody("aiBrushCutout", "\n\n  function closeMaterialPreview");
  assert.match(brushCutout, /allowDuplicate:\s*true/);
  assert.match(brushCutout, /tags:\s*\["抠图"\]/);
  assert.match(brushCutout, /retagEditedMaterialEntry\(entry,\s*\{\s*baseTags:\s*\["抠图"\]/);
  assert.doesNotMatch(brushCutout, /item\.tags/);
});
