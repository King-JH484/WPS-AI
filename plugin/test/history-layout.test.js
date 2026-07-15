const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");

function cssRule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `找不到 CSS 规则 ${selector}`);
  const end = css.indexOf("\n}", start);
  assert.ok(end > start, `CSS 规则 ${selector} 未闭合`);
  return css.slice(start, end + 2);
}

function preventsFlexShrink(rule) {
  return /flex:\s*(none|0\s+0\s+auto)\s*;/.test(rule) || /flex-shrink:\s*0\s*;/.test(rule);
}

test("改动记录列表自身滚动，不压缩历史轮次和条目高度", () => {
  const historyList = cssRule(".history-list");
  const historyTurn = cssRule(".history-turn");
  const historyEntry = cssRule(".history-entry");

  assert.match(historyList, /overflow-y:\s*auto\s*;/, "改动记录列表应作为纵向滚动容器");
  assert.match(historyList, /min-height:\s*0\s*;/, "滚动容器需要 min-height:0 才能在 TaskPane 内正确收缩");
  assert.equal(preventsFlexShrink(historyTurn), true, "历史轮次不能被 flex 压缩，否则条目多时高度会被挤没");
  assert.equal(preventsFlexShrink(historyEntry), true, "历史条目不能被 flex 压缩，否则展开后内容会被挤没");
});
