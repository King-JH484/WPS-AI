const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadStack(win = {}) {
  // compliance 复用 proofread 的分块/定位 —— 两个模块一起装
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "proofread.js"), "utf8") + "})")(win);
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "compliance.js"), "utf8") + "})")(win);
  return win;
}

test("buildChunkMessages：清单 + 正文分节，中英双语", () => {
  const win = loadStack();
  const C = win.WpsAiCompliance;
  const items = [{ text: "正文内容", start: 0, end: 4 }];
  const zh = C.buildChunkMessages("金额必须大小写并存", items, "zh");
  assert.match(zh[0].content, /合规审查员/);
  assert.match(zh[1].content, /【检查清单】/);
  assert.match(zh[1].content, /金额必须大小写并存/);
  const en = C.buildChunkMessages("rule", items, "en");
  assert.match(en[0].content, /compliance reviewer/);
});

test("run：命中问题定位加批注 + severity 计数 + 空清单拒绝", async () => {
  const comments = [];
  const win = loadStack({
    WpsAiHostWriter: {
      readDocumentStructure: async () => ({
        segments: [{ kind: "paragraph", text: "合同总价为人民币10000元，最终解释权归本公司。", start: 0, end: 23 }]
      }),
      addCommentAtRange: async (s, e, note) => { comments.push({ s, e, note }); }
    },
    WpsAiOpenAI: {
      chatCompletion: async () => JSON.stringify({
        issues: [
          { quote: "最终解释权归本公司", rule: "不得出现最终解释权表述", severity: "high", reason: "违反广告法相关规定", suggestion: "删除该表述" },
          { quote: "人民币10000元", rule: "金额须大小写并存", severity: "medium", reason: "缺少大写金额", suggestion: "补充「壹万元整」" }
        ]
      })
    }
  });
  const C = win.WpsAiCompliance;
  await assert.rejects(() => C.run({ rulesText: "  " }), /检查清单/);
  const result = await C.run({ rulesText: "不得出现最终解释权表述\n金额须大小写并存", parseJson: JSON.parse });
  assert.equal(result.total, 2);
  assert.equal(result.located, 2);
  assert.deepEqual(result.bySeverity, { high: 1, medium: 1, low: 0 });
  assert.equal(comments.length, 2);
  assert.match(comments[0].note, /合规 · 高/);
  assert.match(comments[0].note, /规则：/);
  assert.match(comments[1].note, /建议：/);
});

test("接线：quick action + app.js flow + modal 元素 + main.js 加载", () => {
  const qa = fs.readFileSync(path.join(ROOT, "js", "quick-actions.js"), "utf8");
  assert.match(qa, /key: "compliance"/);
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /payload\.flow === "compliance"/);
  assert.match(appJs, /WpsAiCompliance\.run\(/);
  assert.match(appJs, /WpsAiTaskStore\?\.add\?\.\(\{ type: "compliance"/);
  const html = fs.readFileSync(path.join(ROOT, "taskpane.html"), "utf8");
  assert.match(html, /id="complianceModal"/);
  assert.match(html, /id="complianceRulesInput"/);
  const mainJs = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.ok(mainJs.includes("js/compliance.js"));
});
