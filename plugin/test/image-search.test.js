const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  filterResultsBySite,
  inferSiteFilter,
  pageUrlCandidates,
  parseSiteImageResults,
  parseBingImageResults,
  shouldUseImageSearchFallback
} = require("../tools/image-search.js");

test("图片搜索：DuckDuckGo i.js 403 时触发备用图源", () => {
  assert.equal(shouldUseImageSearchFallback(new Error("HTTP 403")), true);
  assert.equal(shouldUseImageSearchFallback(new Error("timeout")), true);
  assert.equal(shouldUseImageSearchFallback(new Error("未取得搜索令牌(vqd)，图源接口可能已变更")), true);
  assert.equal(shouldUseImageSearchFallback(new Error("HTTP 404")), false);
});

test("图片搜索：解析 Bing 图片页的 iusc 元数据", () => {
  const html = `
    <a class="iusc" m='{"murl":"https://img.example.com/a.jpg","turl":"https://thumb.example.com/a.jpg","t":"示例图","purl":"https://source.example.com/page","mw":1200,"mh":800}'></a>
    <a class="iusc" m="{&quot;murl&quot;:&quot;https://img.example.com/b.png&quot;,&quot;turl&quot;:&quot;https://thumb.example.com/b.png&quot;,&quot;t&quot;:&quot;第二张&quot;,&quot;purl&quot;:&quot;https://source.example.com/b&quot;,&quot;mw&quot;:640,&quot;mh&quot;:480}"></a>
  `;

  assert.deepEqual(parseBingImageResults(html, 5), [
    {
      url: "https://img.example.com/a.jpg",
      thumbnail: "https://thumb.example.com/a.jpg",
      title: "示例图",
      source: "https://source.example.com/page",
      width: 1200,
      height: 800
    },
    {
      url: "https://img.example.com/b.png",
      thumbnail: "https://thumb.example.com/b.png",
      title: "第二张",
      source: "https://source.example.com/b",
      width: 640,
      height: 480
    }
  ]);
});

test("图片搜索：代理 DuckDuckGo 失败后有 Bing 兜底路径", () => {
  const proxyJs = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

  assert.match(proxyJs, /searchImages\(/);
});

test("图片搜索：从查询词或 URL 推断站点约束", () => {
  assert.equal(inferSiteFilter("抓取 https://www.tencent.com/zh-cn/index.html 的图片"), "tencent.com");
  assert.equal(inferSiteFilter("tencent.com logo"), "tencent.com");
  assert.equal(inferSiteFilter("site:static.www.tencent.com 腾讯"), "static.www.tencent.com");
  assert.equal(inferSiteFilter("蓝色科技背景"), "");
});

test("图片搜索：裸域名优先尝试 www 主页，避免证书不匹配", () => {
  assert.deepEqual(pageUrlCandidates("tencent.com", "tencent.com"), [
    "https://www.tencent.com/",
    "https://tencent.com/"
  ]);
  assert.deepEqual(pageUrlCandidates("https://www.tencent.com/zh-cn/index.html", "tencent.com"), [
    "https://www.tencent.com/zh-cn/index.html"
  ]);
});

test("图片搜索：指定站点时过滤掉 Pexels 等离站结果", () => {
  const results = filterResultsBySite([
    { url: "https://images.pexels.com/photos/a.jpg", source: "https://www.pexels.com/photo/a" },
    { url: "https://static.www.tencent.com/uploads/a.jpg", source: "https://www.tencent.com/zh-cn/index.html" },
    { url: "https://images.pexels.com/photos/embedded.jpg", source: "https://www.tencent.com/news" },
    { url: "https://cdn.example.com/a.jpg", source: "https://www.tencent.com/news" }
  ], "tencent.com");

  assert.deepEqual(results.map((it) => it.url), [
    "https://static.www.tencent.com/uploads/a.jpg"
  ]);
});

test("图片搜索：从目标网页 HTML 解析同域图片，忽略离站图片", () => {
  const html = `
    <meta property="og:image" content="/brand/cover.png">
    <img src="https://static.www.tencent.com/uploads/a.jpg" alt="腾讯图片">
    <img src="https://images.pexels.com/photos/wrong.jpg" alt="离站图片">
    <source srcset="/img/small.jpg 1x, /img/large.jpg 2x">
  `;

  const results = parseSiteImageResults(html, "https://www.tencent.com/zh-cn/index.html", "tencent.com", 10);

  assert.deepEqual(results.map((it) => it.url), [
    "https://www.tencent.com/brand/cover.png",
    "https://static.www.tencent.com/uploads/a.jpg",
    "https://www.tencent.com/img/small.jpg"
  ]);
});
