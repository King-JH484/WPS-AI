const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadProofread(win = {}) {
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "proofread.js"), "utf8") + "})")(win);
  return win.WpsAiProofread;
}

test("buildChunks：只取 paragraph 段、按字符上限分块、保留位置", () => {
  const P = loadProofread();
  const segments = [
    { kind: "paragraph", text: "第一段", start: 0, end: 4 },
    { kind: "table", text: "表格", start: 4, end: 8 },
    { kind: "paragraph", text: "长".repeat(5000), start: 8, end: 5008 },
    { kind: "paragraph", text: "第三段", start: 5008, end: 5012 }
  ];
  const chunks = P.buildChunks(segments, 4000);
  assert.equal(chunks.length, 3); // 长段单独成块，前后段各一块
  assert.equal(chunks[0][0].text, "第一段");
  assert.equal(chunks[0][0].start, 0);
  assert.equal(chunks[2][0].text, "第三段");
  // 表格段不参与校对
  assert.ok(!chunks.flat().some((it) => it.text === "表格"));
});

test("locateQuote：精确定位 / 空白差异退化整段 / 找不到返回 null", () => {
  const P = loadProofread();
  const items = [
    { text: "本季度围绕年度目标推进各项工做，核心项目按计划交付。", start: 100, end: 126 },
    { text: "第二段内容没有问题。", start: 126, end: 136 }
  ];
  // 精确匹配：offset 正确（「本季度围绕年度目标推进」= 11 字）
  const hit = P.locateQuote(items, "各项工做");
  assert.deepEqual(hit, { start: 100 + 11, end: 100 + 15 });
  // 引文带了额外空白 → 去空白匹配退化为整段
  const fuzzy = P.locateQuote(items, "各项 工做");
  assert.equal(fuzzy.start, 100);
  // 完全不存在
  assert.equal(P.locateQuote(items, "不存在的句子"), null);
});

test("run：分块调模型 → 定位 → 加批注；单块失败跳过", async () => {
  const comments = [];
  let call = 0;
  const win = {
    WpsAiHostWriter: {
      readDocumentStructure: async () => ({
        segments: [
          { kind: "paragraph", text: "这段有一个错别字：工做。", start: 0, end: 12 },
          { kind: "paragraph", text: "长".repeat(6001), start: 12, end: 6013 } // 逼出第二块
        ]
      }),
      addCommentAtRange: async (s, e, note) => { comments.push({ s, e, note }); }
    },
    WpsAiOpenAI: {
      chatCompletion: async () => {
        call += 1;
        if (call === 1) return JSON.stringify({ issues: [{ quote: "工做", type: "typo", suggestion: "工作", reason: "错别字" }] });
        throw new Error("第二块模拟失败");
      }
    }
  };
  const P = loadProofread(win);
  const result = await P.run({ parseJson: JSON.parse });
  assert.equal(result.chunks, 2);
  assert.equal(result.total, 1);
  assert.equal(result.located, 1);
  assert.equal(result.failed, 1);
  assert.equal(comments.length, 1);
  assert.ok(comments[0].note.includes("错别字"));
  assert.ok(comments[0].note.includes("工作"));
  assert.equal(comments[0].s, "这段有一个错别字：".length); // 精确定位到「工做」
});

test("接线：writer 暴露 addCommentAtRange，app.js 有 proofread flow，quick-actions 有入口", () => {
  const writer = fs.readFileSync(path.join(ROOT, "js", "hosts", "writer.js"), "utf8");
  assert.match(writer, /addCommentAtRange,/);
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /payload\.flow === "proofread"/);
  assert.match(appJs, /WpsAiProofread\.run\(/);
  const qa = fs.readFileSync(path.join(ROOT, "js", "quick-actions.js"), "utf8");
  assert.match(qa, /key: "proofread"/);
  const mainJs = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.ok(mainJs.includes("js/proofread.js"));
});
