const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const taskpaneHtml = fs.readFileSync(path.join(__dirname, "../taskpane.html"), "utf8");
const styleCss = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("顶栏版本号旁显示本地代理运行状态", () => {
  assert.match(taskpaneHtml, /id="brandVersion"[\s\S]*id="proxyStatusBadge"/);
  assert.match(styleCss, /\.proxy-status-badge/);
  assert.match(styleCss, /\.proxy-status-ok/);
  assert.match(appJs, /"proxyStatusBadge"/);
  assert.match(appJs, /function\s+updateProxyStatusBadge\s*\(/);
  assert.match(appJs, /正常运行/);
  assert.match(appJs, /\/healthz/);
});

test("代理未就绪时显示插件启动中全局蒙版", () => {
  assert.match(taskpaneHtml, /id="pluginStartupOverlay"[\s\S]*插件启动中/);
  assert.match(styleCss, /\.plugin-startup-overlay/);
  assert.match(styleCss, /\.plugin-startup-overlay\.hidden/);
  assert.match(appJs, /"pluginStartupOverlay"/);
  assert.match(appJs, /function\s+showPluginStartupOverlay\s*\(/);
  assert.match(appJs, /function\s+hidePluginStartupOverlay\s*\(/);
  assert.match(appJs, /showPluginStartupOverlay\("插件启动中"\)/);
  assert.match(appJs, /hidePluginStartupOverlay\(\)/);
});
