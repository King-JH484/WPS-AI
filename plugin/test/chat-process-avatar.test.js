const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../css/style.css"), "utf8");

function functionBody(name) {
  const start = appJs.indexOf(`function ${name}`);
  assert.ok(start >= 0, `找不到函数 ${name}`);
  const next = appJs.indexOf("\n  function ", start + 1);
  return appJs.slice(start, next > start ? next : undefined);
}

function appendHistoryCaseBody(type) {
  const body = functionBody("appendHistoryEvent");
  const match = body.match(new RegExp(`case "${type}":\\s*\\{?([\\s\\S]*?)\\n\\s*break;`));
  assert.ok(match, `找不到 appendHistoryEvent 的 ${type} 分支`);
  return match[1];
}

function cssRule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `找不到 CSS 规则 ${selector}`);
  const end = css.indexOf("\n}", start);
  assert.ok(end > start, `CSS 规则 ${selector} 未闭合`);
  return css.slice(start, end + 2);
}

test("思考过程和工具调用过程都渲染 assistant 圆头像", () => {
  [
    "appendStaticReasoningBubble",
    "appendCollapsibleToolMsg",
    "appendTransientToolBubble",
    "ensureToolAggregateBubble",
    "renderTurnSummary"
  ].forEach((name) => {
    assert.match(functionBody(name), /appendChild\(makeAvatarEl\("assistant"\)\)/, `${name} 缺少 assistant 头像`);
  });

  assert.match(appendHistoryCaseBody("reasoning"), /appendStaticReasoningBubble\(ev\.text\s*\|\|\s*""\)/, "历史回看的 reasoning 应复用带头像的静态思考气泡");
});

test("历史回看的推理内容复用静态思考气泡，避免折叠盒子空内容", () => {
  const branch = appendHistoryCaseBody("reasoning");

  assert.match(branch, /appendStaticReasoningBubble\(ev\.text\s*\|\|\s*""\)/, "历史推理回放应复用实时思考气泡，保留预览和展开正文");
  assert.doesNotMatch(branch, /innerHTML\s*=/, "历史推理回放不应单独拼 innerHTML，避免正文被 CSS 隐藏且无法展开");
  assert.doesNotMatch(branch, /WpsAiMarkdown\?\.escapeHtml/, "历史推理回放不应依赖 Markdown 转义对象存在后才显示内容");
});

test("过程气泡布局为左侧头像预留空间，不使用 stretch 把头像挤出可视区", () => {
  assert.match(css, /\.chat-msg\.(tool|reasoning|turn-summary)[\s\S]*?align-self:\s*flex-start;/, "工具/思考/汇总气泡应和 AI 消息一样从左侧起排");
  assert.doesNotMatch(css, /\.chat-msg\.(tool|reasoning|turn-summary)\s*\{[\s\S]*?align-self:\s*stretch;/, "过程气泡不应使用 stretch 布局");
  assert.match(css, /\.chat-msg\.(tool|reasoning|turn-summary)[\s\S]*?max-width:\s*calc\(100% - 48px\)/, "过程气泡应给左侧头像预留宽度");
});

test("过程气泡根节点不能裁剪左侧绝对定位头像", () => {
  assert.match(css, /\.chat-msg\.tool,[\s\S]*?\.chat-msg\.reasoning,[\s\S]*?\.chat-msg\.turn-summary\s*\{[\s\S]*?overflow:\s*visible;/, "工具/思考/汇总根气泡必须允许左侧头像溢出显示");
  assert.doesNotMatch(cssRule(".chat-msg.tool"), /overflow:\s*hidden;/, "工具根气泡 overflow:hidden 会裁掉头像");
  assert.doesNotMatch(cssRule(".chat-msg.reasoning"), /overflow:\s*hidden;/, "思考根气泡 overflow:hidden 会裁掉头像");
  assert.doesNotMatch(cssRule(".chat-msg.turn-summary"), /overflow:\s*hidden;/, "汇总根气泡 overflow:hidden 会裁掉头像");
  assert.doesNotMatch(cssRule(".chat-msg.tool.transient"), /overflow:\s*hidden;/, "瞬态工具根气泡 overflow:hidden 会裁掉头像");
});

test("推理和工具调用过程之间保留可读间距", () => {
  assert.match(css, /\.chat-msg\.tool,[\s\S]*?\.chat-msg\.reasoning,[\s\S]*?\.chat-msg\.turn-summary\s*\{[\s\S]*?margin:\s*6px 0 6px 40px;/, "过程气泡应统一保留上下 6px 间距");
  assert.match(cssRule(".chat-msg.tool.transient.done"), /margin:\s*6px 0 6px 40px;/, "完成态工具条不能贴得太近");
  assert.match(cssRule(".chat-msg.tool.transient.tool-aggregate"), /margin:\s*6px 0 6px 40px;/, "工具汇总条不能贴得太近");
});
