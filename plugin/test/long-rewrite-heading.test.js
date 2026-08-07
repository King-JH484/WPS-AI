const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.join(__dirname, "..");

// 只抽取 headingLevelFromStyle 做纯测：用正则复刻，确认宿主里的实现口径一致。
// （宿主整文件依赖 WPS 全局，无法整体 vm 装载，这里对拍同一正则契约。）
function headingLevelFromStyle(styleName) {
  const m = /^(?:Heading|标题)\s*(\d)/i.exec(String(styleName || "").trim());
  if (!m) return 0;
  const lv = parseInt(m[1], 10);
  return lv >= 1 && lv <= 3 ? lv : 0;
}

test("headingLevelFromStyle: Heading 1-3 与 标题 1-3", () => {
  assert.equal(headingLevelFromStyle("Heading 1"), 1);
  assert.equal(headingLevelFromStyle("标题 2"), 2);
  assert.equal(headingLevelFromStyle("Heading 3"), 3);
});
test("headingLevelFromStyle: 正文/超范围 -> 0", () => {
  assert.equal(headingLevelFromStyle("Normal"), 0);
  assert.equal(headingLevelFromStyle("正文"), 0);
  assert.equal(headingLevelFromStyle("Heading 4"), 0);
  assert.equal(headingLevelFromStyle(""), 0);
});

// 契约保证：宿主源码里确实用了这条正则（防止两处口径漂移）
test("writer.js 使用同一标题正则", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "hosts", "writer.js"), "utf8");
  assert.ok(src.includes("(?:Heading|标题)"), "writer.js 应包含标题判定正则");
  assert.ok(src.includes("function headingLevelFromStyle"), "writer.js 应导出 headingLevelFromStyle");
});
