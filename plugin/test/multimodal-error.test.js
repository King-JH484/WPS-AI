// 测 app.js 里 friendlyMultimodalError：把服务端「模型不接受图片/附件」的天书翻成中文提示。
// 沿用 pdf-context.test.js 的做法：按文本锚点切出目标函数源码再 eval（app.js 整体带 DOM 跑不动）。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
function sliceFn(startMarker, endMarker) {
  const s = appSrc.indexOf(startMarker);
  assert.ok(s >= 0, "未找到起点: " + startMarker);
  const e = appSrc.indexOf(endMarker, s);
  assert.ok(e > s, "未找到终点: " + endMarker);
  return appSrc.slice(s, e).replace(/\s+$/, "");
}
const friendlyMultimodalError = vm.runInThisContext(
  "(" + sliceFn("function friendlyMultimodalError", "// 思考强度：off") + ")"
);

test("翻译用户实际遇到的报错串", () => {
  const msg = friendlyMultimodalError(
    new Error("Failed to build prompt: Unexpected item type in content."),
    { model: "some-text-only-model", hadPdfs: true }
  );
  assert.ok(msg, "应命中并返回友好文案");
  assert.match(msg, /不支持/);
  assert.match(msg, /PDF 附件/);
  assert.match(msg, /some-text-only-model/);
  assert.match(msg, /原始报错/);
});

test("DeepSeek 不认 file content part 的报错也命中", () => {
  const msg = friendlyMultimodalError(new Error("unknown variant `file`, expected `text`"), { hadImages: true });
  assert.ok(msg);
  assert.match(msg, /图片/);
});

test("图片被拒（image_url unsupported）命中", () => {
  const msg = friendlyMultimodalError({ message: "image_url is not supported by this model" }, {});
  assert.ok(msg);
  assert.match(msg, /图片 \/ 附件/); // 没给 hadImages/hadPdfs → 用通用文案
});

test("重试包裹后的报错（前缀+原文）仍命中", () => {
  const msg = friendlyMultimodalError(new Error("连续重试 3 次仍失败：Failed to build prompt: Unexpected item type in content."), {});
  assert.ok(msg);
});

test("无关的普通报错返回 null（回退原始错误）", () => {
  assert.equal(friendlyMultimodalError(new Error("network timeout"), {}), null);
  assert.equal(friendlyMultimodalError(new Error("401 Unauthorized"), {}), null);
  assert.equal(friendlyMultimodalError(new Error("rate limit exceeded"), {}), null);
});
