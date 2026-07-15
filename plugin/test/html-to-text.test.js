const test = require("node:test");
const assert = require("node:assert");
const { htmlToText, decodeEntities } = require("../tools/html-to-text.js");

test("去脚本/样式、提取 title、块级转换行", () => {
  const { title, text } = htmlToText(
    "<title>报告标题</title><style>.a{color:red}</style><body><p>第一段</p><script>evil()</script><p>第二段</p></body>"
  );
  assert.strictEqual(title, "报告标题");
  assert.ok(!/evil/.test(text), "脚本内容被删");
  assert.ok(!/color:red/.test(text), "样式内容被删");
  assert.ok(text.includes("第一段"));
  assert.ok(text.includes("第二段"));
  assert.ok(text.indexOf("第一段") < text.indexOf("第二段"));
});

test("解码 HTML 实体", () => {
  const { text } = htmlToText("<p>a &amp; b &lt;c&gt; &#65; &#x42;</p>");
  assert.ok(text.includes("a & b <c>"));
  assert.ok(text.includes("A"));
  assert.ok(text.includes("B"));
});

test("br → 换行", () => {
  assert.ok(htmlToText("行一<br>行二").text.includes("\n"));
});

test("超长截断并置 truncated", () => {
  const r = htmlToText("<p>" + "字".repeat(20000) + "</p>", 100);
  assert.ok(r.text.length <= 100);
  assert.strictEqual(r.truncated, true);
});

test("无 title 返回空标题", () => {
  assert.strictEqual(htmlToText("<p>hi</p>").title, "");
});

test("大量未闭合 <script> 不卡死且脚本正文被丢弃（线性）", () => {
  const hostile = "<p>正文A</p>" + "<script>x".repeat(50000) + "<p>正文B</p>";
  const start = process.hrtime.bigint();
  const { text } = htmlToText(hostile);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1000, `应在 1s 内完成，实际 ${ms.toFixed(0)}ms`);
  assert.ok(!/x{5}/.test(text), "未闭合 script 正文被丢到结尾");
  assert.ok(text.includes("正文A"), "script 之前的正文保留");
});

test("自闭合 <svg/> 不吞掉后文正文（回归 M2）", () => {
  assert.ok(htmlToText("<svg width=1 />正文内容").text.includes("正文内容"));
  assert.ok(htmlToText("<h1>标题</h1><p>引言</p><svg viewBox='0 0 1 1'/><p>正文主体</p>").text.includes("正文主体"));
});

test("未闭合 <svg> 保留后文；未闭合 <style> 丢到结尾", () => {
  assert.ok(htmlToText("<p>前</p><svg><p>后body</p>").text.includes("后body"), "未闭合 svg 保后文");
  assert.ok(!htmlToText("<p>前</p><style>.a{color:red}后面没闭合").text.includes("color:red"), "未闭合 style 丢到结尾");
});

test("闭合的 script/style 块被整体剥离", () => {
  const { text } = htmlToText("<p>前</p><script>evil()</script><style>.a{}</style><p>后</p>");
  assert.ok(!/evil/.test(text));
  assert.ok(!/\.a\{\}/.test(text));
  assert.ok(text.includes("前") && text.includes("后"));
});

test("decodeEntities 不二次解码 &amp;lt;", () => {
  // &amp;lt; 应解成 &lt;（字面），不是 <
  assert.strictEqual(decodeEntities("&amp;lt;"), "&lt;");
});
