const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../taskpane.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");

test("素材库搜索和项目筛选使用弹窗内统一控件结构", () => {
  assert.match(html, /<div class="material-search-wrap">[\s\S]*id="materialSearchInput"[\s\S]*<\/div>/);
  assert.match(html, /class="material-search-icon"/);
  assert.match(html, /<label class="material-filter-select"[\s\S]*id="materialProjectFilter"[\s\S]*<\/label>/);
  assert.match(html, /<span>项目<\/span>/);
});

test("素材库筛选区和下拉控件具备统一布局样式", () => {
  assert.match(css, /\.material-library-filterbar\s*\{/);
  assert.match(css, /\.material-search-wrap\s*\{/);
  assert.match(css, /\.material-search-input:focus\s*\{/);
  assert.match(css, /\.material-filter-select\s*\{/);
  assert.match(css, /\.material-filter-select select\s*\{/);
  assert.match(css, /\.material-move-select\s*\{/);
});
