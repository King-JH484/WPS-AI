const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  isEditableElement,
  readTextFromClipboardEvent,
  copySelectionToClipboard,
  cutSelectionToClipboard,
  getUndoRedoCommand,
  getSelectedText,
  shouldHandlePasteEvent,
  shouldRetryManualPaste,
  shouldUseCustomEditableContextMenu,
  shouldTrapEditShortcut,
  shouldTrapPasteShortcut,
  selectAllText,
  insertTextAtCursor
} = require("../js/edit-shortcuts.js");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("粘贴快捷键：textarea 获得焦点时拦截 Cmd+V，避免宿主继续粘贴到文档", () => {
  const textarea = { tagName: "TEXTAREA" };
  const ev = { metaKey: true, ctrlKey: false, altKey: false, key: "v", target: textarea };

  assert.equal(shouldTrapPasteShortcut(ev, textarea), true);
});

test("粘贴快捷键：非可编辑目标不拦截", () => {
  const div = { tagName: "DIV" };
  const ev = { metaKey: true, ctrlKey: false, altKey: false, key: "v", target: div };

  assert.equal(shouldTrapPasteShortcut(ev, div), false);
});

test("粘贴快捷键：Alt 组合不拦截", () => {
  const textarea = { tagName: "TEXTAREA" };
  const ev = { metaKey: true, ctrlKey: false, altKey: true, key: "v", target: textarea };

  assert.equal(shouldTrapPasteShortcut(ev, textarea), false);
});

test("编辑快捷键：textarea 获得焦点时拦截 Cmd+A/C/X", () => {
  const textarea = { tagName: "TEXTAREA" };

  for (const key of ["a", "c", "x"]) {
    const ev = { metaKey: true, ctrlKey: false, altKey: false, key, target: textarea };
    assert.equal(shouldTrapEditShortcut(ev, textarea), true);
  }
});

test("撤销重做快捷键：识别 Cmd+Z / Cmd+Shift+Z / Cmd+Y", () => {
  const textarea = { tagName: "TEXTAREA" };

  assert.equal(getUndoRedoCommand({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "z", target: textarea }, textarea), "undo");
  assert.equal(getUndoRedoCommand({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "z", target: textarea }, textarea), "redo");
  assert.equal(getUndoRedoCommand({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "y", target: textarea }, textarea), "redo");
});

test("撤销重做快捷键：非可编辑目标不拦截", () => {
  const div = { tagName: "DIV" };

  assert.equal(getUndoRedoCommand({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "z", target: div }, div), "");
});

test("selectAllText：全选 textarea 内容", () => {
  const textarea = {
    tagName: "TEXTAREA",
    value: "hello world",
    selectionStart: 6,
    selectionEnd: 6
  };

  assert.equal(selectAllText(textarea), true);

  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 11);
});

test("copySelectionToClipboard：复制选区但不修改内容", async () => {
  let copied = "";
  const textarea = {
    tagName: "TEXTAREA",
    value: "hello world",
    selectionStart: 6,
    selectionEnd: 11
  };

  assert.equal(getSelectedText(textarea), "world");
  assert.equal(await copySelectionToClipboard(textarea, async (text) => { copied = text; }), true);

  assert.equal(copied, "world");
  assert.equal(textarea.value, "hello world");
  assert.equal(textarea.selectionStart, 6);
  assert.equal(textarea.selectionEnd, 11);
});

test("cutSelectionToClipboard：复制选区后删除并触发 input", async () => {
  let copied = "";
  const events = [];
  const textarea = {
    tagName: "TEXTAREA",
    value: "hello world",
    selectionStart: 6,
    selectionEnd: 11,
    dispatchEvent(ev) { events.push(ev.type); }
  };

  assert.equal(await cutSelectionToClipboard(textarea, async (text) => { copied = text; }, function Event(type) { this.type = type; }), true);

  assert.equal(copied, "world");
  assert.equal(textarea.value, "hello ");
  assert.equal(textarea.selectionStart, 6);
  assert.equal(textarea.selectionEnd, 6);
  assert.deepEqual(events, ["input"]);
});

test("insertTextAtCursor：替换选区并移动光标", () => {
  const events = [];
  const textarea = {
    tagName: "TEXTAREA",
    value: "hello world",
    selectionStart: 6,
    selectionEnd: 11,
    dispatchEvent(ev) { events.push(ev.type); }
  };

  insertTextAtCursor(textarea, "WPS", function Event(type) { this.type = type; });

  assert.equal(textarea.value, "hello WPS");
  assert.equal(textarea.selectionStart, 9);
  assert.equal(textarea.selectionEnd, 9);
  assert.deepEqual(events, ["input"]);
});

test("insertTextAtCursor：readonly textarea 不应被程序化粘贴改写", () => {
  const events = [];
  const textarea = {
    tagName: "TEXTAREA",
    readOnly: true,
    value: "readonly",
    selectionStart: 4,
    selectionEnd: 8,
    dispatchEvent(ev) { events.push(ev.type); }
  };

  assert.equal(insertTextAtCursor(textarea, "x", function Event(type) { this.type = type; }), false);

  assert.equal(textarea.value, "readonly");
  assert.equal(textarea.selectionStart, 4);
  assert.equal(textarea.selectionEnd, 8);
  assert.deepEqual(events, []);
});

test("cutSelectionToClipboard：readonly textarea 不应被剪切改写", async () => {
  let copied = "";
  const events = [];
  const textarea = {
    tagName: "TEXTAREA",
    readOnly: true,
    value: "readonly text",
    selectionStart: 0,
    selectionEnd: 8,
    dispatchEvent(ev) { events.push(ev.type); }
  };

  assert.equal(await cutSelectionToClipboard(textarea, async (text) => { copied = text; }, function Event(type) { this.type = type; }), false);

  assert.equal(copied, "");
  assert.equal(textarea.value, "readonly text");
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 8);
  assert.deepEqual(events, []);
});

test("readTextFromClipboardEvent：优先从 paste 事件读取 text/plain", () => {
  const ev = {
    clipboardData: {
      getData(type) {
        return type === "text/plain" ? "from-paste-event" : "";
      }
    }
  };

  assert.equal(readTextFromClipboardEvent(ev), "from-paste-event");
});

test("paste 事件：只有键盘 Cmd+V 已登记待处理时才接管，右键菜单粘贴交给原生", () => {
  const textarea = { tagName: "TEXTAREA" };
  const ev = { target: textarea };

  assert.equal(shouldHandlePasteEvent(ev, null, textarea), false);
  assert.equal(shouldHandlePasteEvent(ev, { target: textarea, ts: Date.now() }, textarea), true);
  assert.equal(shouldHandlePasteEvent(ev, { target: { tagName: "TEXTAREA" }, ts: Date.now() }, textarea), false);
  assert.equal(shouldHandlePasteEvent(ev, { target: textarea, ts: Date.now() - 2000 }, textarea), false);
});

test("右键菜单：可编辑输入框使用自定义菜单，避开 WPS 原生 contextmenu", () => {
  const textarea = { tagName: "TEXTAREA" };
  const div = { tagName: "DIV" };

  assert.equal(shouldUseCustomEditableContextMenu({ target: textarea }, textarea), true);
  assert.equal(shouldUseCustomEditableContextMenu({ target: div }, div), false);
  assert.equal(shouldUseCustomEditableContextMenu({ target: textarea, ctrlKey: true }, textarea), false);
});

test("聊天输入框右键菜单：阻止原生 contextmenu 并走自定义粘贴入口", () => {
  assert.match(appJs, /function\s+installChatInputContextMenu\s*\(/);
  assert.match(appJs, /addEventListener\("contextmenu"/);
  assert.match(appJs, /ev\.preventDefault\(\)/);
  assert.match(appJs, /pasteClipboardIntoInput\(target/);
});

test("手动粘贴：剪贴板第一次读取为空时允许短时间重试，避免快捷键被吞", () => {
  const textarea = { tagName: "TEXTAREA" };
  const pending = { target: textarea, ts: 1000, attempts: 1 };

  assert.equal(shouldRetryManualPaste(pending, { now: 1100, maxAttempts: 3 }), true);
  assert.equal(shouldRetryManualPaste({ ...pending, attempts: 3 }, { now: 1100, maxAttempts: 3 }), false);
  assert.equal(shouldRetryManualPaste(pending, { now: 2500, maxAgeMs: 1200, maxAttempts: 3 }), false);
  assert.equal(shouldRetryManualPaste(null, { now: 1100, maxAttempts: 3 }), false);
});

test("手动粘贴：启动期代理未就绪时默认允许更长重试窗口", () => {
  const textarea = { tagName: "TEXTAREA" };

  assert.equal(shouldRetryManualPaste({ target: textarea, ts: 1000, attempts: 5 }, { now: 5200 }), true);
  assert.equal(shouldRetryManualPaste({ target: textarea, ts: 1000, attempts: 8 }, { now: 5200 }), false);
  assert.equal(shouldRetryManualPaste({ target: textarea, ts: 1000, attempts: 1 }, { now: 10000 }), false);
});

test("手动粘贴：app 的 Cmd+V fallback 使用重试调度，不因第一次空读直接丢失", () => {
  assert.match(appJs, /function scheduleManualPasteAttempt\(/);
  assert.match(appJs, /shouldRetryManualPaste\(/);
  assert.match(appJs, /setTimeout\(\(\)\s*=>\s*scheduleManualPasteAttempt\(pending\),\s*delayMs\)/);
});

test("剪贴板代理：不要等待完整 runtime.ready，失败后重新探测端口再重试", () => {
  assert.match(appJs, /async function readClipboardTextViaProxy\(/);
  assert.doesNotMatch(appJs, /WpsAiRuntime\?\.ready/);
  assert.match(appJs, /WpsAiRuntime\?\.reprobe\?\.\(\)/);
  assert.match(appJs, /CLIPBOARD_PROXY_RETRY_DELAYS_MS/);
});

test("剪贴板读取：navigator.clipboard.readText 不允许启动期无限等待", () => {
  assert.match(appJs, /NAVIGATOR_CLIPBOARD_READ_TIMEOUT_MS/);
  assert.match(appJs, /function\s+readNavigatorClipboardTextWithTimeout\s*\(/);
  assert.match(appJs, /Promise\.race\(\[/);
  assert.doesNotMatch(appJs, /await\s+navigator\.clipboard\?\.readText\?\.\(\)/);
});

test("启动期粘贴保护：不等待 WpsAiStore.init 完成才绑定", () => {
  const guardPos = appJs.indexOf("installStartupPasteGuards();");
  const storeInitPos = appJs.indexOf("await global.WpsAiStore.init()");

  assert.notEqual(guardPos, -1);
  assert.notEqual(storeInitPos, -1);
  assert.ok(guardPos < storeInitPos, "paste guards should install before store init can wait on proxy");
  assert.match(appJs, /function\s+installStartupPasteGuards\s*\(/);
  assert.match(appJs, /installChatInputContextMenu\(els\.chatInput\)/);
});

test("启动期一键粘贴：按钮点击不等待 WpsAiStore.init 完成才绑定", () => {
  const startupBindPos = appJs.indexOf("bindStartupChatPasteButton();");
  const storeInitPos = appJs.indexOf("await global.WpsAiStore.init()");

  assert.notEqual(startupBindPos, -1);
  assert.notEqual(storeInitPos, -1);
  assert.ok(startupBindPos < storeInitPos, "chat paste button should be bound before store init can wait on proxy");
  assert.match(appJs, /function\s+bindStartupChatPasteButton\s*\(/);
  assert.match(appJs, /__lingxiPasteBtnBound/);
  assert.match(appJs, /pasteClipboardIntoInput\(target\)/);
});

test("isEditableElement：contenteditable 也算可编辑", () => {
  assert.equal(isEditableElement({ tagName: "DIV", isContentEditable: true }), true);
});
