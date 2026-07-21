const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "tools", "proxy-server.js"), "utf8");

// 复现 proxy 里的判定正则（与 proxyRequest 内联逻辑保持一致），验证放宽范围精确。
const LOCAL_RE = /^(127\.|0\.0\.0\.0|localhost$|::1$|\[::1\]$|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const IMG_RE = /\/images\/generations\b/;

test("本地地址判定：回环/私网命中，公网不命中", () => {
  for (const h of ["127.0.0.1", "localhost", "192.168.1.10", "10.0.0.5", "172.16.0.1", "172.31.255.1"]) {
    assert.ok(LOCAL_RE.test(h), h + " 应判为本地");
  }
  for (const h of ["api.openai.com", "openrouter.ai", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
    assert.ok(!LOCAL_RE.test(h), h + " 不应判为本地");
  }
});

test("生图端点判定：/images/generations（含 /v1 前缀）命中", () => {
  assert.ok(IMG_RE.test("/v1/images/generations"));
  assert.ok(IMG_RE.test("/images/generations"));
  assert.ok(!IMG_RE.test("/v1/chat/completions"));
  assert.ok(!IMG_RE.test("/v1/models"));
});

test("proxy 源码：本地生图放宽首字节超时到独立变量，云端维持 300s", () => {
  // 判定两条件都在
  assert.match(src, /const isLocalHost = /);
  assert.match(src, /const isImageGen = /);
  // 命中时用 LINGXI_LOCAL_IMAGE_TIMEOUT_MS（默认 20min），否则原 FORWARD_SOCKET_TIMEOUT_MS
  assert.match(src, /LINGXI_LOCAL_IMAGE_TIMEOUT_MS\) \|\| 20 \* 60 \* 1000/);
  assert.match(src, /isLocalHost && isImageGen/);
  assert.match(src, /proxyReq\.setTimeout\(firstByteTimeout,/);
  // 默认首字节超时（云端）仍是 300s
  assert.match(src, /FORWARD_SOCKET_TIMEOUT_MS = Number\(process\.env\.LINGXI_FORWARD_TIMEOUT_MS\) \|\| 300 \* 1000/);
});
