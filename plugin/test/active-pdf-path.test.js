const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const proxyServerJs = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

test("active PDF lsof fallback refuses ambiguous multiple PDF candidates", () => {
  assert.match(proxyServerJs, /paths\.length\s*===\s*1/);
  assert.match(proxyServerJs, /paths\.length\s*>\s*1/);
  assert.match(proxyServerJs, /ambiguous:\s*true/);
  assert.match(proxyServerJs, /result\.ambiguous\s*\?\s*409\s*:\s*404/);
});

test("active PDF path detection does not fall back to manual file picker", () => {
  assert.doesNotMatch(proxyServerJs, /choose-local-pdf/);
  assert.doesNotMatch(proxyServerJs, /chooseOpenPdfPath/);
  assert.doesNotMatch(proxyServerJs, /选择当前打开的 PDF/);
});

test("proxy healthz advertises active PDF path capability", () => {
  assert.match(proxyServerJs, /features:\s*PROXY_FEATURES/);
  assert.match(proxyServerJs, /"active-pdf-path"/);
  assert.match(proxyServerJs, /常用：[^`]*\/active-pdf-path/);
});
