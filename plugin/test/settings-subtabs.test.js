const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const taskpane = fs.readFileSync(path.join(__dirname, "../taskpane.html"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");

function cssRule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `找不到 CSS 规则 ${selector}`);
  const end = css.indexOf("\n}", start);
  assert.ok(end > start, `CSS 规则 ${selector} 未闭合`);
  return css.slice(start, end + 2);
}

function subtabBlock(name) {
  const re = new RegExp(`<div class="settings-subtabs"[^>]*data-settings-subtabs="${name}"[\\s\\S]*?<\\/div>`);
  const m = taskpane.match(re);
  assert.ok(m, `找不到 ${name} 顶部子 tab`);
  return m[0];
}

function panel(name) {
  const re = new RegExp(`data-subtab-panel="${name}"`);
  assert.match(taskpane, re, `找不到 ${name} 子面板`);
}

test("MCP 服务使用 4 个顶部子 tab，避免四个区域纵向长滚动", () => {
  const block = subtabBlock("mcp");
  ["mcp-status", "mcp-config", "mcp-tools", "mcp-calls"].forEach((name) => {
    assert.match(block, new RegExp(`data-subtab-target="${name}"`), `MCP 缺少 ${name} tab`);
    panel(name);
  });
  assert.match(block, /data-subtab-target="mcp-status"[^>]*class="[^"]*\bactive\b/, "MCP 默认显示状态页");
  assert.match(taskpane, /data-subtab-panel="mcp-status"[^>]*class="[^"]*\bactive\b/, "MCP 状态面板默认 active");
});

test("程序信息使用顶部子 tab 分区显示", () => {
  const block = subtabBlock("about");
  ["about-basic", "about-update", "about-cache", "about-dev"].forEach((name) => {
    assert.match(block, new RegExp(`data-subtab-target="${name}"`), `程序信息缺少 ${name} tab`);
    panel(name);
  });
  assert.match(block, /data-subtab-target="about-basic"[^>]*class="[^"]*\bactive\b/, "程序信息默认显示基本信息");
  assert.match(taskpane, /data-subtab-panel="about-basic"[^>]*class="[^"]*\bactive\b/, "基本信息面板默认 active");
});

test("设置子 tab 有统一样式和绑定初始化", () => {
  assert.match(css, /\.settings-subtabs\s*\{[\s\S]*?display:\s*flex;/, "子 tab 顶部栏需要横向布局");
  assert.match(css, /\.settings-subtab-panel\.hidden\s*\{[\s\S]*?display:\s*none\s*!important;/, "非当前子面板必须隐藏");
  assert.match(appJs, /function bindSettingsSubtabs\(\)/, "缺少通用子 tab 绑定函数");
  assert.match(appJs, /bindSettingsSubtabs\(\);/, "设置窗口初始化时需要绑定子 tab");
});

test("设置子 tab 对应页面撑满面板剩余高度", () => {
  assert.match(cssRule(".settings-content"), /display:\s*flex\s*;/, "设置内容区需要成为纵向 flex 容器");
  assert.match(cssRule(".settings-content"), /flex-direction:\s*column\s*;/, "设置内容区应纵向分配高度");
  assert.match(cssRule(".settings-panel"), /display:\s*flex\s*;/, "当前设置 panel 需要撑满内容区");
  assert.match(cssRule(".settings-panel"), /flex:\s*1\s*;/, "当前设置 panel 应占满剩余高度");
  assert.match(cssRule(".settings-panel"), /min-height:\s*0\s*;/, "当前设置 panel 需要允许内部滚动区域收缩");
  assert.match(cssRule(".settings-subtab-panel"), /flex:\s*1\s*;/, "子 tab 页面应占满 panel 剩余高度");
  assert.match(cssRule(".settings-subtab-panel"), /overflow-y:\s*auto\s*;/, "子 tab 页面内容过多时应在页面内滚动");
});

test("设置左侧 tab 区域足够显示搜索提示词", () => {
  assert.match(taskpane, /id="settingsSearchInput"[^>]*placeholder="搜索设置项…"/, "设置搜索框提示词应保持完整");
  assert.match(cssRule(".settings-sidebar"), /width:\s*(1[6-9]\d|[2-9]\d{2})px\s*;/, "设置侧栏宽度至少 160px，避免搜索提示词被截断");
});

test("程序信息基本信息使用分组式排版", () => {
  assert.match(taskpane, /class="[^"]*\babout-basic-layout\b/, "基本信息需要使用整体布局容器");
  assert.match(taskpane, /class="[^"]*\babout-hero\b/, "基本信息需要有版本概览区域");
  assert.doesNotMatch(taskpane, /class="[^"]*\babout-hero-mark\b/, "基本信息不再显示左侧「灵」头像块");
  assert.match(taskpane, /class="[^"]*\babout-info-grid\b/, "基本信息需要按信息项分组展示");
  assert.match(taskpane, /class="[^"]*\babout-action-grid\b/, "导入导出操作需要独立成组");
  assert.match(cssRule(".about-basic-layout"), /display:\s*grid\s*;/, "基本信息布局应使用 grid");
  assert.match(cssRule(".about-basic-layout"), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/, "基本信息整体应为单列布局，避免左一块右一块");
  assert.match(cssRule(".about-info-grid"), /display:\s*grid\s*;/, "信息项区域应使用 grid");
});

test("Token 消耗面板包含时间筛选、趋势图、模型占比和每日明细", () => {
  assert.match(taskpane, /id="tokenUsageRange"/, "Token 面板需要时间范围选择");
  assert.match(taskpane, /id="tokenUsageTrendChart"/, "Token 面板需要趋势图容器");
  assert.match(taskpane, /id="tokenUsageModelChart"/, "Token 面板需要模型占比图容器");
  assert.match(taskpane, /id="tokenUsageDailyTable"/, "Token 面板需要每日明细容器");
  assert.match(appJs, /getDailyBreakdown\(/, "Token 面板渲染应读取每日统计");
  assert.match(appJs, /renderTokenTrendChart/, "Token 面板应渲染时间趋势图");
  assert.match(appJs, /renderTokenModelChart/, "Token 面板应渲染模型占比图");
  assert.match(cssRule(".token-usage-charts"), /display:\s*grid\s*;/, "Token 图表区域应使用 grid 布局");
  assert.match(cssRule(".token-usage-chart"), /min-height:\s*\d+px\s*;/, "Token 图表需要稳定高度");
});
