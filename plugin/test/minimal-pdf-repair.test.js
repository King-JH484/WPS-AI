const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const conversationsSrc = fs.readFileSync(path.join(__dirname, "../js/conversations.js"), "utf8");
const proxySrc = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

test("历史会话窗口属于独立 dialog，不启动任务窗格宽度轮询", () => {
  const start = appSrc.indexOf("function isAnyDialogWindow()");
  const end = appSrc.indexOf("function selectionPreviewIntentLabel", start);
  const body = appSrc.slice(start, end);
  assert.match(body, /isConversationsDialog/);
  assert.match(appSrc, /if \(isConversationsDialog\) \{[\s\S]*正在加载历史对话/);
  assert.match(appSrc, /历史窗口只需要 store \+ conversations/);
});

test("PDF 空键历史只展示，选中后才绑定当前 PDF", () => {
  assert.match(conversationsSrc, /includeUnscopedLegacy/);
  assert.match(appSrc, /JSON\.stringify\(\{ id: id, docKey, ts: Date\.now\(\) \}\)/);
  assert.match(appSrc, /rebindCurrentDocKey/);
});

test("历史对话请求由 PluginStorage 与 localStorage 同一轮询消费，不依赖 storage 事件", () => {
  const start = appSrc.indexOf("async function consumeConversationsDialogRequest");
  const end = appSrc.indexOf("function openConversationsAsDialog", start);
  const body = appSrc.slice(start, end);
  assert.ok(start >= 0, "历史请求消费器应为异步双存储消费器");
  assert.match(body, /PluginStorage/);
  assert.match(body, /sources = \[pluginStorage, localStorage\]/);
  assert.match(body, /WpsAiConversationMailbox\?\.inspect/);
  assert.match(appSrc, /setInterval\([^\n]*consumeConversationsDialogRequest|consumeConversationsDialogRequest\(\)[\s\S]*setInterval/);
});

test("浮动面板关闭主动 unsnap，高 CPU 检测器降为 30 秒兜底", () => {
  assert.match(appSrc, /\/pane-presence/);
  assert.match(proxySrc, /function holdPanePresence/);
  assert.match(proxySrc, /panePresence\.restore/);
  assert.match(appSrc, /beforeunload[\s\S]*pagehide/);
  assert.match(appSrc, /navigator\.sendBeacon[\s\S]*\/unsnap-pane|\/unsnap-pane[\s\S]*navigator\.sendBeacon/);
  assert.match(proxySrc, /PANE_WATCH_INTERVAL_MS = 30 \* 1000/);
  const watcherStart = proxySrc.indexOf("function startPaneCloseWatcher()");
  const watcherEnd = proxySrc.indexOf("function stopPaneCloseWatcher()", watcherStart);
  assert.doesNotMatch(proxySrc.slice(watcherStart, watcherEnd), /1500/);
  assert.match(proxySrc, /stopPaneCloseWatcher\(\);[\s\S]*restoreDocumentWindow\(\)/);
});

test("永久安装缺少 pdfjs-dist 时 /pdf-extract 回退系统 pdftotext", () => {
  assert.match(proxySrc, /function extractPdfTextWithPoppler/);
  assert.match(proxySrc, /_pdfjsLib === false/);
  assert.match(proxySrc, /if \(!pdfjs\) \{[\s\S]*extractPdfTextWithPoppler\(filePath\)/);
});
