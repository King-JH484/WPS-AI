// 测 conversations.js 的事件压缩 / 体积裁剪（防止巨型 PPT 一轮撑爆 localStorage）。
// 两个都是纯函数，按文本锚点从源码切出来 eval。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "conversations.js"), "utf8");
function sliceFn(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, "未找到起点: " + startMarker);
  const e = src.indexOf(endMarker, s);
  assert.ok(e > s, "未找到终点: " + endMarker);
  return src.slice(s, e).replace(/\s+$/, "");
}
const sanitizeEvent = vm.runInThisContext("(" + sliceFn("function sanitizeEvent", "// 按总体积裁") + ")");
const trimEventsBySize = vm.runInThisContext("(" + sliceFn("function trimEventsBySize", "// 追加本轮事件流") + ")");

test("sanitizeEvent：tool_result 保留 {ok,error}、丢弃巨大 value", () => {
  const big = "x".repeat(500000);
  const out = sanitizeEvent({ type: "tool_result", ts: 1, name: "wpp_render", result: { ok: true, value: big, error: null } });
  assert.equal(out.type, "tool_result");
  assert.equal(out.result.ok, true);
  assert.ok(!("value" in out.result)); // 巨大 value 被丢弃
  assert.ok(JSON.stringify(out).length < 2000);
});

test("sanitizeEvent：失败结果保留错误摘要", () => {
  const out = sanitizeEvent({ type: "tool_result", ts: 1, name: "x", result: { ok: false, error: "AddPicture 返回 null" } });
  assert.equal(out.result.ok, false);
  assert.match(out.result.error, /AddPicture/);
});

test("sanitizeEvent：reasoning 去 base64 + 截断", () => {
  const dataUrl = "data:image/png;base64," + "A".repeat(300000);
  const out = sanitizeEvent({ type: "reasoning", ts: 1, text: "看图 " + dataUrl });
  assert.ok(!/base64,[A-Za-z0-9]/.test(out.text)); // base64 被剥掉
  assert.ok(out.text.length <= 6100);
});

test("sanitizeEvent：tool_call 超大 args 压成字符串", () => {
  const out = sanitizeEvent({ type: "tool_call", ts: 1, name: "t", args: { blob: "y".repeat(50000) } });
  assert.equal(out.name, "t");
  assert.ok(JSON.stringify(out).length < 3000);
});

test("trimEventsBySize：超预算从最旧丢弃", () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ type: "reasoning", ts: i, text: "z".repeat(5000) }));
  const conv = { events };
  trimEventsBySize(conv, 100000);
  assert.ok(JSON.stringify(conv.events).length <= 100000);
  assert.ok(conv.events.length < 200);
  assert.equal(conv.events[conv.events.length - 1].ts, 199); // 保留最新
});

test("trimEventsBySize：预算内不动", () => {
  const conv = { events: [{ type: "assistant", ts: 1, text: "hi" }] };
  trimEventsBySize(conv, 600000);
  assert.equal(conv.events.length, 1);
});
