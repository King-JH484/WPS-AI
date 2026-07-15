const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const writerJs = fs.readFileSync(path.join(__dirname, "../js/tools/writer.js"), "utf8");

test("Word 图片插入在 AddPicture 和 HTML 失败后使用 RTF 内嵌图片兜底", () => {
  assert.match(writerJs, /function IMAGE_RTF_FILE_URL\(\)/);
  assert.match(writerJs, /async function insertByRtfPict/);
  assert.match(writerJs, /IMAGE_RTF_FILE_URL\(\)/);
  assert.match(writerJs, /strategy:\s*"range\.insert-file-rtf"/);

  const rtfPos = writerJs.indexOf("insertByRtfPict(document, app, sel, candidate, width, height)");
  const htmlPos = writerJs.indexOf("insertByHtmlFragment(document, app, sel, candidate, width, height)");
  const fieldPos = writerJs.indexOf("insertByIncludePictureField(document, app, sel, candidate, width, height)");
  assert.ok(rtfPos > -1, "should call RTF fallback");
  assert.ok(htmlPos > -1, "should still keep HTML fallback");
  assert.ok(fieldPos > -1, "should still keep INCLUDEPICTURE fallback");
  assert.ok(rtfPos < htmlPos, "RTF fallback should run before HTML fallback");
  assert.ok(htmlPos < fieldPos, "INCLUDEPICTURE should remain last");
});

test("INCLUDEPICTURE 兜底延后到所有本地候选都试完，并优先使用 JPEG 候选", () => {
  assert.match(writerJs, /function isJpegPath/);
  assert.match(writerJs, /const deferredFieldCandidates = \[\]/);
  assert.match(writerJs, /deferredFieldCandidates\.push\(candidate\)/);
  assert.match(writerJs, /const hasJpegFieldCandidate = deferredFieldCandidates\.some\(isJpegPath\)/);
  assert.match(writerJs, /hasJpegFieldCandidate \? deferredFieldCandidates\.filter\(isJpegPath\) : deferredFieldCandidates/);

  const deferPos = writerJs.indexOf("deferredFieldCandidates.push(candidate)");
  const fieldLoopPos = writerJs.indexOf("for (const candidate of orderedFieldCandidates)");
  assert.ok(deferPos > -1, "field fallback should be deferred per candidate");
  assert.ok(fieldLoopPos > deferPos, "field fallback should run after all candidates have tried non-field paths");
});

test("INCLUDEPICTURE 字段不使用 \\d 链接开关，避免生成仅链接的坏图框", () => {
  const start = writerJs.indexOf("function addIncludePictureField");
  assert.notEqual(start, -1, "addIncludePictureField should exist");
  const end = writerJs.indexOf("\n  async function insertByIncludePictureField", start);
  const body = writerJs.slice(start, end);

  assert.match(body, /const code = `"\$\{fieldCodePath\(fileName\)\}"`;/);
  assert.doesNotMatch(body, /\\\\d/);
});

test("本地 PNG 在字段兜底前先尝试系统剪贴板粘贴，保留 PNG/透明通道", () => {
  assert.match(writerJs, /function CLIPBOARD_IMAGE_URL\(\)/);
  assert.match(writerJs, /async function insertByClipboardImage/);
  assert.match(writerJs, /CLIPBOARD_IMAGE_URL\(\)/);
  assert.match(writerJs, /strategy:\s*"selection\.paste-image-clipboard"/);

  const clipboardPos = writerJs.indexOf("insertByClipboardImage(document, app, sel, candidate, width, height)");
  const fieldPos = writerJs.indexOf("for (const candidate of orderedFieldCandidates)");
  assert.ok(clipboardPos > -1, "should call clipboard image fallback");
  assert.ok(fieldPos > -1, "should keep field fallback");
  assert.ok(clipboardPos < fieldPos, "clipboard image fallback should run before INCLUDEPICTURE field fallback");
});
