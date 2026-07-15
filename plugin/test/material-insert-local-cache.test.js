const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

function functionBody(name) {
  const start = appJs.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = appJs.indexOf("\n  function ", start + 1);
  return appJs.slice(start, next === -1 ? undefined : next);
}

test("素材插入前将 ToAPI 等远程图片缓存到本地，并回写素材条目", () => {
  const body = functionBody("materialInsertUrl");
  assert.match(body, /\^https\?:/);
  assert.match(body, /WpsAiImageAssets\?\.ensureLocalImagePath\?\.\(raw\)/);
  assert.match(body, /WpsAiMaterialLibrary\?\.update\?\.\(item\.id/);
  assert.match(body, /url: local/);
  assert.match(body, /sourceUrl: item\.sourceUrl \|\| raw/);
  assert.match(body, /return local/);
});
