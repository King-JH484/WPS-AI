const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const mainJs = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

test("焦点快捷键兜底不再包含调试诊断脚本和日志", () => {
  assert.doesNotMatch(mainJs, /focus-diagnostic\.js/);
  assert.doesNotMatch(appJs, /FOCUSDIAG|focusDiag|focus-diag|WpsAiFocusDiagnostic|焦点诊断/);
});
