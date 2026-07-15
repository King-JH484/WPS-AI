const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("ShowDialog 独立弹窗在 early return 前安装 WPS 焦点/快捷键兜底", () => {
  const domReady = appJs.indexOf('document.addEventListener("DOMContentLoaded"');
  assert.ok(domReady >= 0, "找不到 DOMContentLoaded 初始化入口");

  const install = appJs.indexOf("installWpsFocusRelease();", domReady);
  assert.ok(install >= 0, "DOMContentLoaded 内必须调用 installWpsFocusRelease()");

  const dialogModeStart = appJs.indexOf("// ===== 预览独立窗口模式 =====", domReady);
  assert.ok(dialogModeStart >= 0, "找不到 DOMContentLoaded 内的独立弹窗分支区域");
  assert.ok(install < dialogModeStart, "installWpsFocusRelease() 必须早于独立弹窗分支区域");

  const dialogBranches = [
    "if (isPreviewDialog)",
    "if (isMaterialsDialog)",
    "if (isQuickPromptDialog)",
    "if (isFormatPreviewDialog)",
    "if (isParallelTranslateDialog)",
    "if (isSelectionPreviewDialog)",
    "if (isSettingsDialog)",
    "if (isStylePresetDialog)"
  ];

  for (const marker of dialogBranches) {
    const idx = appJs.indexOf(marker, dialogModeStart);
    assert.ok(idx >= 0, `找不到 dialog 分支：${marker}`);
    assert.ok(install < idx, `installWpsFocusRelease() 必须早于 ${marker}`);
  }
});

test("HTML 预览 iframe 渲染完成后也安装编辑快捷键兜底", () => {
  assert.match(appJs, /function\s+installWpsFocusReleaseForDocument\s*\(/, "需要有可安装到指定 document 的焦点/快捷键兜底函数");

  const finishRender = appJs.indexOf("const finishRender = (path) =>");
  assert.ok(finishRender >= 0, "找不到 HTML 预览 iframe 的 finishRender");
  const bridgeCall = appJs.indexOf("bridgeEchartsToFrame(frame)", finishRender);
  assert.ok(bridgeCall > finishRender, "无法定位 finishRender 内的图表桥接调用");

  const callInFinish = appJs.indexOf("installWpsFocusReleaseForDocument(doc, { force: true })", finishRender);
  assert.ok(callInFinish > finishRender && callInFinish < bridgeCall, "iframe finishRender 内必须给 iframe document 安装快捷键兜底");
});
