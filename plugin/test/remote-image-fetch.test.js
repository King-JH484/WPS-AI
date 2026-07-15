const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildRemoteImageHeaders,
  defaultRefererForImage,
  normalizeReferer,
  shouldUseChromiumFallback
} = require("../tools/remote-image-fetch.js");

test("远程图片代理：使用浏览器图片请求头，降低防盗链 403 概率", () => {
  const headers = buildRemoteImageHeaders(
    "https://static.www.tencent.com/uploads/demo.jpg",
    { pageUrl: "https://www.tencent.com/zh-cn/index.html" }
  );

  assert.match(headers["User-Agent"], /Mozilla\/5\.0/);
  assert.match(headers.Accept, /image\/webp/);
  assert.match(headers.Accept, /image\/png/);
  assert.doesNotMatch(headers.Accept, /image\/avif/);
  assert.doesNotMatch(headers.Accept, /image\/\*/);
  assert.equal(headers["Accept-Language"].startsWith("zh-CN"), true);
  assert.equal(headers["Sec-Fetch-Dest"], "image");
  assert.equal(headers["Sec-Fetch-Mode"], "no-cors");
  assert.equal(headers.Referer, "https://www.tencent.com/zh-cn/index.html");
});

test("远程图片代理：未传页面来源时用图片站点根地址作为 Referer 兜底", () => {
  assert.equal(
    defaultRefererForImage("https://static.www.tencent.com/uploads/demo.jpg"),
    "https://static.www.tencent.com/"
  );
  assert.equal(
    buildRemoteImageHeaders("https://static.www.tencent.com/uploads/demo.jpg").Referer,
    "https://static.www.tencent.com/"
  );
});

test("远程图片代理：HTTPS 图片不接受 HTTP referer，避免降级泄露来源", () => {
  assert.equal(
    normalizeReferer("http://www.tencent.com/", "https://static.www.tencent.com/uploads/demo.jpg"),
    ""
  );
});

test("远程图片代理：只有防盗链/浏览器画像相关失败才触发 Chromium 兜底", () => {
  assert.equal(shouldUseChromiumFallback(new Error("HTTP 403")), true);
  assert.equal(shouldUseChromiumFallback(new Error("重定向后 HTTP 406")), true);
  assert.equal(shouldUseChromiumFallback(new Error("timeout")), true);
  assert.equal(shouldUseChromiumFallback(new Error("HTTP 404")), false);
  assert.equal(shouldUseChromiumFallback(new Error("禁止访问该地址（内网/环回/元数据）")), false);
});

test("远程图片代理：/fetch-remote-image 路由实际使用浏览器图片请求头", () => {
  const proxyJs = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

  assert.match(proxyJs, /require\("\.\/remote-image-fetch"\)/);
  assert.match(proxyJs, /buildRemoteImageHeaders\(/);
  assert.match(proxyJs, /headers:\s*buildRemoteImageHeaders\(/);
});
