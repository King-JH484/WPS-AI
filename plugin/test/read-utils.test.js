const test = require("node:test");
const assert = require("node:assert");

const { paginateText, clampIndexRange, applyListWindow } = require("../js/tools/read-utils.js");

// ---- paginateText ----

test("paginateText: 无 maxChars → 从 offset 到结尾，不截断", () => {
  const r = paginateText("abcdef", { offset: 2 });
  assert.strictEqual(r.slice, "cdef");
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.nextOffset, null);
});

test("paginateText: maxChars 未读完 → truncated + nextOffset", () => {
  const r = paginateText("abcdef", { offset: 0, maxChars: 4 });
  assert.strictEqual(r.slice, "abcd");
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.nextOffset, 4);
});

test("paginateText: maxChars 恰好读完 → 不截断，nextOffset=null", () => {
  const r = paginateText("abcdef", { offset: 4, maxChars: 2 });
  assert.strictEqual(r.slice, "ef");
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.nextOffset, null);
});

test("paginateText: offset 越界 → 空串，不截断", () => {
  const r = paginateText("abc", { offset: 99, maxChars: 10 });
  assert.strictEqual(r.slice, "");
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.nextOffset, null);
});

test("paginateText: offset 负数按 0 处理", () => {
  const r = paginateText("abcdef", { offset: -5, maxChars: 3 });
  assert.strictEqual(r.slice, "abc");
  assert.strictEqual(r.nextOffset, 3);
});

test("paginateText: 空/非字符串输入安全", () => {
  assert.strictEqual(paginateText("", {}).slice, "");
  assert.strictEqual(paginateText(null, {}).slice, "");
  assert.strictEqual(paginateText(undefined, { maxChars: 5 }).slice, "");
});

// ---- clampIndexRange (1-based, inclusive) ----

test("clampIndexRange: 缺省 → 全范围 1..count", () => {
  assert.deepStrictEqual(clampIndexRange({ count: 10 }), { from: 1, to: 10 });
});

test("clampIndexRange: 越界收敛到 [1,count]", () => {
  assert.deepStrictEqual(clampIndexRange({ from: 0, to: 99, count: 10 }), { from: 1, to: 10 });
});

test("clampIndexRange: from>to 时交换/收敛为合法区间", () => {
  const r = clampIndexRange({ from: 8, to: 3, count: 10 });
  assert.ok(r.from <= r.to);
});

test("clampIndexRange: count=0 → from=1,to=0（空区间）", () => {
  const r = clampIndexRange({ count: 0 });
  assert.ok(r.to < r.from);
});

// ---- applyListWindow ----

test("applyListWindow: limit 未取完 → truncated + nextOffset + total", () => {
  const r = applyListWindow([1, 2, 3, 4, 5], { offset: 0, limit: 2 });
  assert.deepStrictEqual(r.window, [1, 2]);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.nextOffset, 2);
});

test("applyListWindow: offset+limit 覆盖到末尾 → 不截断", () => {
  const r = applyListWindow([1, 2, 3], { offset: 1, limit: 2 });
  assert.deepStrictEqual(r.window, [2, 3]);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.nextOffset, null);
});

test("applyListWindow: 无 limit → 全部返回", () => {
  const r = applyListWindow([1, 2, 3], { offset: 1 });
  assert.deepStrictEqual(r.window, [2, 3]);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.truncated, false);
});

test("applyListWindow: 非数组输入安全", () => {
  const r = applyListWindow(null, { limit: 5 });
  assert.deepStrictEqual(r.window, []);
  assert.strictEqual(r.total, 0);
});
