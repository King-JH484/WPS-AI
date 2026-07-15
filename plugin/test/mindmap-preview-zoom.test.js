const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("实时提炼脑图使用普通滚轮缩放，而不是 macOS 默认滚轮平移", () => {
  const createCall = appJs.match(/_mmInstance = mk\.Markmap\.create\(svgEl, \{[\s\S]*?\}, data\);/)?.[0] || "";
  assert.ok(createCall, "找不到实时脑图 Markmap.create 调用");
  assert.match(createCall, /scrollForPan:\s*false/, "必须关闭 macOS 默认的滚轮平移模式，让普通滚轮触发缩放");
  assert.match(createCall, /pan:\s*false/, "必须移除额外 wheel 平移处理，避免和滚轮缩放抢事件");
  assert.match(createCall, /zoom:\s*true/, "必须显式保留 markmap 缩放能力");
});
