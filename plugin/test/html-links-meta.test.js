const test = require("node:test");
const assert = require("node:assert");
const { extractLinks, extractMeta } = require("../tools/html-to-text.js");

test("extractLinks: 解析绝对/相对链接并去重", () => {
  const html = `
    <a href="https://a.com/1">链接一</a>
    <a href="/rel">相对</a>
    <a href="https://a.com/1">重复</a>
    <a href="#top">锚点</a>
    <a href="mailto:x@y.com">邮件</a>
    <a href="javascript:void(0)">脚本</a>
  `;
  const links = extractLinks(html, "https://a.com/base/");
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes("https://a.com/1"));
  assert.ok(urls.includes("https://a.com/rel"), "相对路径解析为绝对");
  assert.strictEqual(urls.filter((u) => u === "https://a.com/1").length, 1, "去重");
  assert.ok(!urls.some((u) => /^(mailto|javascript|#)/i.test(u)), "过滤锚点/邮件/脚本");
});

test("extractLinks: 链接文本去标签", () => {
  const links = extractLinks('<a href="https://a.com/x"><b>粗</b> 文本</a>', "https://a.com");
  assert.strictEqual(links[0].text, "粗 文本");
});

test("extractLinks: limit 生效", () => {
  const html = Array.from({ length: 10 }, (_, i) => `<a href="https://a.com/${i}">l${i}</a>`).join("");
  assert.strictEqual(extractLinks(html, "https://a.com", 3).length, 3);
});

test("extractMeta: 取 description/author/og:site_name（属性顺序不敏感）", () => {
  const html = `
    <title>页面标题</title>
    <meta name="description" content="这是描述">
    <meta content="张三" name="author">
    <meta property="og:site_name" content="示例站">
    <meta property="article:published_time" content="2026-08-04">
  `;
  const meta = extractMeta(html);
  assert.strictEqual(meta.title, "页面标题");
  assert.strictEqual(meta.description, "这是描述");
  assert.strictEqual(meta.author, "张三");
  assert.strictEqual(meta.siteName, "示例站");
  assert.strictEqual(meta.published, "2026-08-04");
});

test("extractMeta: 缺失字段不出现在返回里", () => {
  const meta = extractMeta("<title>只有标题</title>");
  assert.strictEqual(meta.title, "只有标题");
  assert.ok(!("description" in meta));
  assert.ok(!("author" in meta));
});

test("extractMeta: og:description 兜底 description", () => {
  const meta = extractMeta('<meta property="og:description" content="OG 描述">');
  assert.strictEqual(meta.description, "OG 描述");
});
