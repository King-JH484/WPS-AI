const test = require("node:test");
const assert = require("node:assert");

// 与 app.js 内 detectLongRewriteIntent 同款正则契约（app.js 依赖 DOM，无法整体装载）
function detectLongRewriteIntent(text) {
  const s = String(text || "").replace(/\s+/g, "");
  const scope = /(全文|通篇|整篇|全篇|逐段|各章节|整个文档)/.test(s);
  const act = /(改写|润色|扩写|精简|缩写|重写|调整结构|重新组织|统一语气|统一术语)/.test(s);
  return scope && act;
}

test("detect: 命中全文+改写类", () => {
  assert.equal(detectLongRewriteIntent("帮我把全文润色一遍"), true);
  assert.equal(detectLongRewriteIntent("通篇改写得更正式"), true);
  assert.equal(detectLongRewriteIntent("整篇精简一下"), true);
});
test("detect: 不命中（缺范围或缺动作）", () => {
  assert.equal(detectLongRewriteIntent("润色这一段"), false);
  assert.equal(detectLongRewriteIntent("全文有多少字"), false);
  assert.equal(detectLongRewriteIntent(""), false);
});
