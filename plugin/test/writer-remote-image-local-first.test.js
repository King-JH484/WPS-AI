const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const writerJs = fs.readFileSync(path.join(__dirname, "../js/tools/writer.js"), "utf8");

test("Word 插入 HTTP 图片时优先使用本地缓存候选，避免远程 URL 误报成功", () => {
  const start = writerJs.indexOf("async function writerImageCandidates");
  assert.notEqual(start, -1, "writerImageCandidates should exist");
  const end = writerJs.indexOf("\n  async function prepareWordImageInsertion", start);
  const body = writerJs.slice(start, end);

  assert.match(body, /const remote = raw/);
  assert.match(body, /const candidates = \[\]/);
  assert.match(body, /candidates\.push\(\.\.\.await localImagePathCandidates\(local\)\)/);
  assert.match(body, /candidates\.push\(remote\)/);
  assert.ok(body.indexOf("candidates.push(...await localImagePathCandidates(local))") < body.indexOf("candidates.push(remote)"));
});
