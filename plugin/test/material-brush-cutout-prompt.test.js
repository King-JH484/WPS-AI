const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../taskpane.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");

test("画笔抠图无选区时提供描述主体或整张去背景弹窗", () => {
  assert.match(html, /id="materialCutoutChoiceModal"/);
  assert.match(html, /id="materialCutoutDescribeInput"/);
  assert.match(html, /id="materialCutoutAllBtn"/);
  assert.match(html, /id="materialCutoutDescribeBtn"/);

  assert.match(appJs, /openMaterialCutoutChoice/);
  assert.match(appJs, /runBrushCutoutWithoutSelection/);
  assert.match(appJs, /只保留用户描述的主体/);
  assert.doesNotMatch(appJs, /请先用画笔涂抹要抠出的主体。/);

  assert.match(css, /\.material-cutout-choice-card\s*\{/);
  assert.match(css, /\.material-cutout-choice-actions\s*\{/);
});
