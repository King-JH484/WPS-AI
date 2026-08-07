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
  // Task 6：appendTransientToolBubble / renderTurnSummary 已确认零调用方，随死码一起删除；
  // Task 7：ensureToolAggregateBubble（及整条 tool-aggregate 气泡链）同样确认零调用方，
  // 时间轴迁移后随死码一起删除。
  // 剩下几个仍是 makeAvatarEl 的活调用方，继续断言它们没漏挂头像。
  [
    "appendStaticReasoningBubble",
    "appendCollapsibleToolMsg"
  ].forEach((name) => {
    assert.match(functionBody(name), /appendChild\(makeAvatarEl\("assistant"\)\)/, `${name} 缺少 assistant 头像`);
  });

  assert.match(appendHistoryCaseBody("reasoning"), /pushHistoryTurnEvent\(\{\s*type:\s*"reasoning",\s*text:\s*ev\.text\s*\|\|\s*""\s*\}\)/, "历史回看的 reasoning 应汇入本轮步骤缓冲区，和实时时间轴共用 buildTurnSteps");
});

test("历史回看的推理内容汇入时间轴步骤缓冲区，与实时共用 buildTurnSteps，避免单独拼裸 DOM", () => {
  const branch = appendHistoryCaseBody("reasoning");

  assert.match(branch, /pushHistoryTurnEvent\(\{\s*type:\s*"reasoning",\s*text:\s*ev\.text\s*\|\|\s*""\s*\}\)/, "历史推理回放应汇入 turnEvents 缓冲区，之后统一走 buildTurnSteps→renderAssistantTurn，和实时时间轴同一条渲染路径");
  assert.doesNotMatch(branch, /innerHTML\s*=/, "历史推理回放分支本身不应单独拼 innerHTML");
  assert.doesNotMatch(branch, /WpsAiMarkdown\?\.escapeHtml/, "历史推理回放不应依赖 Markdown 转义对象存在后才显示内容");
});

test("过程气泡布局为左侧头像预留空间，不使用 stretch 把头像挤出可视区", () => {
  // Task 6：turn-summary 已删，收窄到 tool/reasoning。
  assert.match(css, /\.chat-msg\.(tool|reasoning)[\s\S]*?align-self:\s*flex-start;/, "工具/思考气泡应和 AI 消息一样从左侧起排");
  assert.doesNotMatch(css, /\.chat-msg\.(tool|reasoning)\s*\{[\s\S]*?align-self:\s*stretch;/, "过程气泡不应使用 stretch 布局");
  assert.match(css, /\.chat-msg\.(tool|reasoning)[\s\S]*?max-width:\s*calc\(100% - 48px\)/, "过程气泡应给左侧头像预留宽度");
});

test("过程气泡根节点不能裁剪左侧绝对定位头像", () => {
  // Task 6：renderTurnSummary（.chat-msg.turn-summary）已确认零调用方并删除，
  // 选择器合并列表和这里的断言一起收窄到 tool/reasoning。
  // Task 7：.chat-msg.tool.transient（瞬态工具气泡，含 tool-aggregate）随 JS 死码一起
  // 从 CSS 里删除，不再有节点会挂这个类，断言一起收窄。
  assert.match(css, /\.chat-msg\.tool,[\s\S]*?\.chat-msg\.reasoning\s*\{[\s\S]*?overflow:\s*visible;/, "工具/思考根气泡必须允许左侧头像溢出显示");
  assert.doesNotMatch(cssRule(".chat-msg.tool"), /overflow:\s*hidden;/, "工具根气泡 overflow:hidden 会裁掉头像");
  assert.doesNotMatch(cssRule(".chat-msg.reasoning"), /overflow:\s*hidden;/, "思考根气泡 overflow:hidden 会裁掉头像");
});

test("推理和工具调用过程之间保留可读间距", () => {
  // Task 6：renderTurnSummary（.chat-msg.turn-summary）已确认零调用方并删除，
  // 合并选择器列表收窄到 tool/reasoning，这里的间距断言一起收窄。
  assert.match(css, /\.chat-msg\.tool,[\s\S]*?\.chat-msg\.reasoning\s*\{[\s\S]*?margin:\s*6px 0 6px 40px;/, "工具/思考过程气泡应统一保留上下 6px 间距");
  assert.match(cssRule(".chat-msg.tool.transient.done"), /margin:\s*6px 0 6px 40px;/, "完成态工具条不能贴得太近");
  assert.match(cssRule(".chat-msg.tool.transient.tool-aggregate"), /margin:\s*6px 0 6px 40px;/, "工具汇总条不能贴得太近");
});
