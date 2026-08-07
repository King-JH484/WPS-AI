// 测 app.js 里的附件类型白名单纯函数 isSupportedAttachmentFile。
// app.js 是超大 IIFE、带 DOM 依赖，整体跑不动；这里按文本锚点切出目标函数源码再 eval。
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

const isSupportedAttachmentFileSrc = sliceFn(
  "const TEXT_ATTACHMENT_EXTENSIONS", "// 把单个 File 读成附件对象"
);
// 用 IIFE 包一层：先声明 TEXT_ATTACHMENT_EXTENSIONS，再返回同一作用域里的函数引用。
const isSupportedAttachmentFile = vm.runInThisContext(
  "(function () {\n" + isSupportedAttachmentFileSrc + "\nreturn isSupportedAttachmentFile;\n})()"
);

function mkFile(name, type) {
  return { name, type };
}

test("图片：MIME 以 image/ 开头 → 支持", () => {
  assert.equal(isSupportedAttachmentFile(mkFile("photo.jpg", "image/jpeg")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("shot.png", "image/png")), true);
});

test("PDF：MIME 或扩展名任一命中 → 支持", () => {
  assert.equal(isSupportedAttachmentFile(mkFile("a.pdf", "application/pdf")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("a.PDF", "")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("weird-name", "application/pdf")), true);
});

test("文本类：text/* 、 application/json 、常见文本扩展名 → 支持", () => {
  assert.equal(isSupportedAttachmentFile(mkFile("readme.txt", "text/plain")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("data.json", "application/json")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("notes.md", "")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("script.py", "")), true);
  assert.equal(isSupportedAttachmentFile(mkFile("config.YML", "")), true, "扩展名大小写不敏感");
});

test("不支持：视频/音频/压缩包/可执行文件/Office 二进制 → 拒绝", () => {
  assert.equal(isSupportedAttachmentFile(mkFile("movie.mp4", "video/mp4")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("song.mp3", "audio/mpeg")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("archive.zip", "application/zip")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("setup.exe", "application/x-msdownload")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("sheet.xlsx", "")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("deck.pptx", "")), false);
});

test("边界：空/无类型无扩展名 → 拒绝；空文件对象 → 拒绝", () => {
  assert.equal(isSupportedAttachmentFile(null), false);
  assert.equal(isSupportedAttachmentFile(mkFile("noext", "")), false);
  assert.equal(isSupportedAttachmentFile(mkFile("", "application/octet-stream")), false);
});
