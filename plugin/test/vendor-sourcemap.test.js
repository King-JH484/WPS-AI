const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("Ant Design Vue source map referenced by devtools exists", () => {
  const vendorDir = path.join(__dirname, "../js/vendor/ant-design-vue");
  const bundle = fs.readFileSync(path.join(vendorDir, "antd.min.js"), "utf8");
  const match = /sourceMappingURL=([^\s]+)/.exec(bundle);
  assert.ok(match, "antd.min.js should declare its source map");
  assert.equal(fs.existsSync(path.join(vendorDir, match[1])), true);
});
