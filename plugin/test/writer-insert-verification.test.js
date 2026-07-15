const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const writerJs = fs.readFileSync(path.join(__dirname, "../js/tools/writer.js"), "utf8");

test("Word 插图不能只凭 WPS 返回 shape/field 就判定成功，必须确认图片或域计数变化", () => {
  assert.doesNotMatch(
    writerJs,
    /if\s*\(\s*verified\.inserted\s*\|\|\s*\(!\s*verified\.comparable\s*&&\s*shape\)\s*\)/
  );
  assert.doesNotMatch(
    writerJs,
    /if\s*\(\s*verified\.inserted\s*\|\|\s*fieldInserted\s*\|\|\s*\(!\s*verified\.comparable\s*&&\s*field\)\s*\)/
  );
  assert.doesNotMatch(
    writerJs,
    /if\s*\(\s*verified\.inserted\s*\|\|\s*fieldInserted\s*\)/
  );
  assert.match(writerJs, /fieldInserted && !verified\.inserted/);
  assert.match(writerJs, /field\?\.Delete\?\.\(\)/);
  assert.doesNotMatch(
    writerJs,
    /if\s*\(\s*!\s*verified\.inserted\s*&&\s*verified\.comparable\s*\)/
  );
  assert.match(writerJs, /if\s*\(\s*verified\.inserted\s*\)/);
});
