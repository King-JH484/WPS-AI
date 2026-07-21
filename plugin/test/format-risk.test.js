const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadRisk() {
  const win = {};
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "format-risk.js"), "utf8") + "})")(win);
  return win.WpsAiFormatRisk;
}

test("普通正文段落 → low", () => {
  const R = loadRisk();
  assert.equal(R.assess("本季度围绕年度目标推进各项工作，核心项目按计划交付。").level, "low");
  assert.equal(R.isSensitive("这是一段普通的中文正文内容，没有任何结构符号。"), false);
});

test("markdown 表格行 / tab 分列 / 多空格分列 → high", () => {
  const R = loadRisk();
  assert.equal(R.assess("| 序号 | 工作内容 | 完成状态 |").level, "high");
  assert.equal(R.assess("姓名\t部门\t职级\t评分").level, "high");
  assert.equal(R.assess("张三    产品部    P6    优秀").level, "high");
});

test("签署栏 / 填空线 → high", () => {
  const R = loadRisk();
  const r = R.assess("甲方（签章）：____________ 日期：____年__月__日");
  assert.equal(r.level, "high");
  assert.ok(r.reasons.includes("signature_line"));
});

test("章节条款编号开头 → medium（编号敏感）", () => {
  const R = loadRisk();
  for (const s of ["第一条 租赁期限自合同签订之日起算。", "一、总体要求如下所述内容。", "（一）检查范围覆盖全部场所。", "1.2.3 子小节标题示例", "2、请各单位高度重视。"]) {
    const r = R.assess(s);
    assert.equal(r.level, "medium", s);
    assert.ok(r.reasons.includes("numbering"), s);
  }
});

test("符号密集（公式/路径类） → 命中 punctuation_dense", () => {
  const R = loadRisk();
  const r = R.assess("配置项 {a}/(b)|[c]=(d)+{e}/(f)|[g]<h> 详见附录");
  assert.ok(r.reasons.includes("punctuation_dense"));
});

test("多重信号叠加 → high", () => {
  const R = loadRisk();
  // 编号 + 符号密集
  assert.equal(R.assess("1.1 参数配置：{env}=[prod]|{region}=(cn-north)/{az}<1>").level, "high");
});

test("app.js 排版链路接入：打标 + 提示词规则", () => {
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /WpsAiFormatRisk\?\.isSensitive/);
  assert.match(appJs, /\[结构敏感\]/);
  const mainJs = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.ok(mainJs.indexOf("js/format-risk.js") > 0 && mainJs.indexOf("js/format-risk.js") < mainJs.indexOf("js/app.js"), "format-risk 要先于 app.js 加载");
});
