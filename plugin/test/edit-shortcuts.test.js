const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const editShortcuts = require("../js/edit-shortcuts.js");
const {
  isEditableElement,
  readTextFromClipboardEvent,
  copySelectionToClipboard,
  cutSelectionToClipboard,
  getUndoRedoCommand,
  getSelectedText,
  shouldHandlePasteEvent,
  shouldUseCustomEditableContextMenu,
  shouldTrapEditShortcut,
  shouldTrapPasteShortcut,
  selectAllText,
  insertTextAtCursor
} = editShortcuts;

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

test("手动粘贴重试机制已移除：shouldRetryManualPaste 不再导出，app.js 也不再引用嵌套重试", () => {
  assert.equal(typeof editShortcuts.shouldRetryManualPaste, "undefined");
  assert.doesNotMatch(appJs, /shouldRetryManualPaste/);
  assert.doesNotMatch(appJs, /function\s+scheduleManualPasteAttempt\(/);
  assert.doesNotMatch(appJs, /function\s+queueManualPasteAttempt\(/);
});

test("Ctrl+V：keydown 分支不再拦截原生粘贴（release + focus 之后放行，交给 paste 事件）", () => {
  const vBranchMatch = appJs.match(/if \(k === "v"\) \{([\s\S]*?)\n {6}\}/);
  assert.ok(vBranchMatch, "应能在 app.js 中找到 k === \"v\" 分支");
  const body = vBranchMatch[1];
  assert.doesNotMatch(body, /ev\.preventDefault\(\)/);
  assert.doesNotMatch(body, /ev\.stopPropagation\(\)/);
  assert.doesNotMatch(body, /stopImmediatePropagation/);
  assert.match(body, /release\(\)/);
  assert.match(body, /window\.focus\(\)/);
  assert.match(body, /pendingManualPaste = \{ target: editEl, ts: Date\.now\(\), handled: false, timer: null \}/);
  assert.match(body, /setTimeout\(\(\)\s*=>\s*runPasteSafetyFallback\(pendingManualPaste\),\s*300\)/);
});

test("粘贴单次兜底：runPasteSafetyFallback 只跑一次（先 navigator.clipboard 单次超时，再单次代理请求），没有嵌套重试", () => {
  assert.match(appJs, /function runPasteSafetyFallback\(pending\)/);
  const fnMatch = appJs.match(/function runPasteSafetyFallback\(pending\) \{[\s\S]*?\n    \}/);
  assert.ok(fnMatch, "应能提取 runPasteSafetyFallback 函数体");
  const body = fnMatch[0];
  assert.match(body, /readNavigatorClipboardTextWithTimeout\(\)/);
  assert.match(body, /readClipboardTextViaProxy\(\{\s*delays:\s*\[0\]\s*\}\)/);
  // 单次兜底里不应该再调用自己或旧的重试调度函数
  assert.doesNotMatch(body, /setTimeout/);
});

test("粘贴事件到达即取消兜底：先清 timer/标记 handled/清空 pendingManualPaste，再判断 txt，杜绝原生+兜底双重插入", () => {
  // 提取 paste 监听器回调体
  const pasteMatch = appJs.match(/onDoc\("paste", \(ev\) => \{([\s\S]*?)\n {4}\}, true\);/);
  assert.ok(pasteMatch, "应能提取 paste 事件监听器");
  const body = pasteMatch[1];
  // 取消兜底的三件事必须出现在 `if (txt && target)` 之前
  const cancelPos = body.indexOf("pendingManualPaste = null;");
  const txtBranchPos = body.indexOf("if (txt && target)");
  assert.ok(cancelPos !== -1, "应无条件清空 pendingManualPaste");
  assert.ok(txtBranchPos !== -1, "应保留 txt && target 快速插入分支");
  assert.ok(cancelPos < txtBranchPos, "取消兜底必须在 txt 分支之前，且不在其内部");
  assert.match(body, /pendingManualPaste\.handled = true;[\s\S]*if \(pendingManualPaste\.timer\) clearTimeout\(pendingManualPaste\.timer\);/);
  assert.match(body, /hidePasteMask\(\);/);
  // 聊天框粘贴图片 → 附件分支：必须在取消兜底之后、文本分支之前，命中后 return，
  // 不会再落入文本插入分支（不会跟文本粘贴叠加，也不会被兜底二次插入）。
  const imageBranchPos = body.indexOf("isChatAttachmentInput(target)");
  assert.ok(imageBranchPos !== -1, "应保留聊天框粘贴图片→附件分支");
  assert.ok(imageBranchPos > cancelPos && imageBranchPos < txtBranchPos, "图片附件分支应在取消兜底之后、文本分支之前");
  const imageBranchBody = body.slice(imageBranchPos, txtBranchPos);
  assert.match(imageBranchBody, /return;/, "命中图片粘贴后应 return，不再走文本插入分支");
  // preventDefault 只应在 txt 命中（文本分支内）或图片附件命中时调用；
  // 文本分支内的 preventDefault 必须发生在真正插入文本之前。
  const txtBranchBody = body.slice(txtBranchPos);
  const pdPosInTxtBranch = txtBranchBody.indexOf("ev.preventDefault()");
  const insertPosInTxtBranch = txtBranchBody.indexOf("insertClipboardTextInto");
  assert.ok(pdPosInTxtBranch > -1 && pdPosInTxtBranch < insertPosInTxtBranch, "preventDefault 只在 txt && target 分支内，且发生在插入之前");
});

test("剪贴板代理单次请求带超时，避免挂起的 fetch 拖慢粘贴", () => {
  assert.match(appJs, /CLIPBOARD_PROXY_FETCH_TIMEOUT_MS/);
  assert.match(appJs, /new AbortController\(\)/);
  assert.match(appJs, /controller\.abort\(\)/);
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

test("isEditableElement：contenteditable 也算可编辑", () => {
  assert.equal(isEditableElement({ tagName: "DIV", isContentEditable: true }), true);
});
