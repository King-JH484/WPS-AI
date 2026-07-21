const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadTemplates(storeInit) {
  const store = Object.assign({}, storeInit || {});
  const win = {
    WpsAiStore: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    }
  };
  const code = fs.readFileSync(path.join(ROOT, "js", "format-templates.js"), "utf8");
  vm.runInThisContext("(function(window){" + code + "})")(win);
  return { T: win.WpsAiFormatTemplates, store };
}

test("内置模板完整：通用无样式，合同/公文/论文/通知带样式且字段合法", () => {
  const { T } = loadTemplates();
  const all = T.getAll();
  const ids = all.map((t) => t.id);
  assert.deepEqual(ids, ["default", "contract", "gov", "paper", "notice"]);
  assert.equal(T.getById("default").styles, null);
  for (const id of ["contract", "gov", "paper", "notice"]) {
    const tpl = T.getById(id);
    assert.ok(tpl.styles && tpl.styles.title && tpl.styles.paragraph, `${id} 应有 title/paragraph 样式`);
    assert.ok(tpl.requirement.length > 10, `${id} 应有默认排版要求`);
    assert.equal(tpl.styles.title.align, "center", `${id} 标题应居中`);
  }
  // 公文正文：仿宋 16pt（三号）首行缩进两字符
  const gov = T.getById("gov");
  assert.equal(gov.styles.paragraph.font, "仿宋");
  assert.equal(gov.styles.paragraph.size, 16);
  assert.equal(gov.styles.paragraph.firstLineIndentChars, 2);
});

test("自定义模板 CRUD：保存/覆盖/删除/持久化，内置 id 不可覆盖", () => {
  const { T, store } = loadTemplates();
  const id = T.newCustomId();
  const saved = T.saveCustom({
    id, name: "我的合同",
    requirement: "自定义要求",
    styles: { title: { font: "黑体", size: 20, bold: true, align: "center" }, paragraph: { font: "宋体", size: 12, lineSpacing: 1.5, firstLineIndentChars: 2 } }
  });
  assert.ok(saved && !saved.builtin);
  assert.equal(T.getById(id).name, "我的合同");
  assert.ok(store["lingxi_format_templates_v1"].includes("我的合同"), "应持久化到 store");
  // 同 id 覆盖
  T.saveCustom({ id, name: "我的合同 v2", styles: { title: { size: 18 } } });
  assert.equal(T.getById(id).name, "我的合同 v2");
  assert.equal(T.getAll().filter((t) => t.id === id).length, 1);
  // 内置 id 不可覆盖
  assert.equal(T.saveCustom({ id: "contract", name: "劫持" }), null);
  // 删除
  assert.equal(T.deleteCustom(id), true);
  assert.equal(T.getById(id), null);
});

test("sanitize：非法字段被剔除，越界值被丢弃", () => {
  const { T } = loadTemplates();
  const saved = T.saveCustom({
    id: T.newCustomId(), name: "边界",
    styles: {
      title: { font: "  黑体  ", size: 999, bold: "yes", align: "middle" },
      paragraph: { size: 12, lineSpacing: 9, firstLineIndentChars: 2 }
    }
  });
  assert.equal(saved.styles.title.font, "黑体");
  assert.equal(saved.styles.title.size, undefined); // 999 越界丢弃
  assert.equal(saved.styles.title.bold, undefined); // 非 boolean 丢弃
  assert.equal(saved.styles.title.align, undefined); // 非法对齐丢弃
  assert.equal(saved.styles.paragraph.lineSpacing, undefined); // 9 越界丢弃
  assert.equal(saved.styles.paragraph.firstLineIndentChars, 2);
});

test("P1-1 中文数字转换 + 标题自动编号（剥旧前缀 / h2 随 h1 重置）", () => {
  const { T } = loadTemplates();
  assert.equal(T.toZh(1), "一");
  assert.equal(T.toZh(10), "十");
  assert.equal(T.toZh(11), "十一");
  assert.equal(T.toZh(21), "二十一");
  const blocks = [
    { type: "heading", level: 1, text: "一、总体要求", sourceIndex: 0 },
    { type: "heading", level: 2, text: "（三）检查范围", sourceIndex: 1 },
    { type: "paragraph", text: "正文", sourceIndex: 2 },
    { type: "heading", level: 2, text: "1.2 时间安排", sourceIndex: 3 },
    { type: "heading", level: 1, text: "第五章 保障措施", sourceIndex: 4 },
    { type: "heading", level: 2, text: "工作专班", sourceIndex: 5 }
  ];
  const out = T.applyHeadingNumbering(blocks, { h1: "{zh}、", h2: "（{zh}）" });
  assert.equal(out[0].text, "一、总体要求");        // 旧「一、」剥掉重编
  assert.equal(out[1].text, "（一）检查范围");      // 旧「（三）」矫正为（一）
  assert.equal(out[3].text, "（二）时间安排");      // 同章第二节
  assert.equal(out[4].text, "二、保障措施");        // 「第五章」剥掉，实际是第二个 h1
  assert.equal(out[5].text, "（一）工作专班");      // h2 随新 h1 重置
  assert.equal(out[4].sourceIndex, 4);              // sourceIndex 保留（范围替换映射依赖）
  assert.equal(blocks[0].text, "一、总体要求");     // 纯函数不改入参
  // 论文式 {n}.{m}
  const paper = T.applyHeadingNumbering(blocks, { h1: "{n} ", h2: "{n}.{m} " });
  assert.equal(paper[0].text, "1 总体要求");
  assert.equal(paper[3].text, "1.2 时间安排");
  assert.equal(paper[4].text, "2 保障措施");
});

test("P1-1 resolveWriteOptions：样式/编号/页面设置齐套，非法页边距剔除", () => {
  const { T } = loadTemplates();
  const gov = T.resolveWriteOptions("gov");
  assert.ok(gov.styleMap && gov.numbering && gov.page);
  assert.equal(gov.numbering.h1, "{zh}、");
  assert.equal(gov.page.marginTopCm, 3.7);
  assert.equal(T.resolveWriteOptions("default").numbering, null);
  // 论文模板一级标题带段前分页
  assert.equal(T.getById("paper").styles.heading1.pageBreakBefore, true);
});

test("writer.js 三条替换路径接入 styleMap；app.js 传递 + dialog 回传 templateId", () => {
  const writer = fs.readFileSync(path.join(ROOT, "js", "hosts", "writer.js"), "utf8");
  assert.match(writer, /function templateStyleFor\(styleMap, type, level\)/);
  assert.match(writer, /function applyBlockStyle\(sel, type, level, styleMap\)/);
  assert.match(writer, /async function replaceDocumentBlocks\(blocks, options = \{\}\)/);
  assert.match(writer, /async function replaceParagraphsInPlace\(segments, blocks, options = \{\}\)/);
  assert.match(writer, /CharacterUnitFirstLineIndent/);
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /replaceParagraphsInPlace\(structure\.segments, formatPreviewState\.blocks, writeOpts\)/);
  assert.match(appJs, /replaceParagraphsInPlace\(structure\.segments, result\.blocks, writeOpts\)/);
  assert.match(appJs, /templateId: currentFormatTemplateId\(\)/);
  assert.match(appJs, /resolveWriteOptions\?\.\(result\.templateId/);
  // P1-1：writer 侧编号预处理 + 页面设置 + 段前分页
  assert.match(writer, /preprocessBlocksForTemplate\(blocks, options\)/);
  assert.match(writer, /applyTemplatePageSetup\(/);
  assert.match(writer, /PageBreakBefore/);
});
