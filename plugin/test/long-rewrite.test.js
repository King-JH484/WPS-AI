const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.join(__dirname, "..");

function load(win = {}) {
  vm.runInThisContext("(function(window){" +
    fs.readFileSync(path.join(ROOT, "js", "long-rewrite.js"), "utf8") +
    "\n})")(win);
  return win.WpsAiLongRewrite;
}
function para(idx, text, start, headingLevel = 0) {
  return { idx, kind: "paragraph", text, start, end: start + text.length, headingLevel };
}

test("splitSections: heading starts a new section", () => {
  const LR = load();
  const segs = [
    para(0, "第一章", 0, 1),
    para(1, "正文A", 10),
    para(2, "第二章", 20, 1),
    para(3, "正文B", 30)
  ];
  const secs = LR.splitSections(segs);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].heading, "第一章");
  assert.deepEqual(secs[0].paragraphs, ["第一章", "正文A"]);
  assert.equal(secs[1].heading, "第二章");
});

test("splitSections: non-paragraph breaks a section", () => {
  const LR = load();
  const segs = [
    para(0, "正文A", 0),
    { idx: 1, kind: "table", text: "", start: 10, end: 20 },
    para(2, "正文B", 20)
  ];
  const secs = LR.splitSections(segs);
  assert.equal(secs.length, 2);          // 表格断节，且表格不进任何节
  assert.equal(secs[0].paragraphs.length, 1);
  assert.equal(secs[1].charStart, 20);
});

test("splitSections: long heading-less run sub-splits by maxChars", () => {
  const LR = load();
  const segs = [para(0, "x".repeat(30), 0), para(1, "y".repeat(30), 30), para(2, "z".repeat(30), 60)];
  const secs = LR.splitSections(segs, { maxChars: 40, maxParagraphs: 40 });
  assert.ok(secs.length >= 2);
});

test("splitSections: empty input -> []", () => {
  const LR = load();
  assert.deepEqual(LR.splitSections([]), []);
  assert.deepEqual(LR.splitSections(null), []);
});

test("buildOutline: 汇出非空 heading", () => {
  const LR = load();
  const secs = [
    { heading: "第一章", headingLevel: 1, paragraphs: ["a"] },
    { heading: null, headingLevel: 0, paragraphs: ["b"] },
    { heading: "第二章", headingLevel: 1, paragraphs: ["c"] }
  ];
  assert.deepEqual(LR.buildOutline(secs), [
    { level: 1, text: "第一章" }, { level: 1, text: "第二章" }
  ]);
});

test("buildSpine: 含标题/要求/大纲/术语，且约束只改本节", () => {
  const LR = load();
  const spine = LR.buildSpine({
    title: "报告", requirement: "更正式",
    outline: [{ level: 1, text: "第一章" }],
    glossary: "AI=人工智能", tone: "正式"
  });
  assert.match(spine, /报告/);
  assert.match(spine, /更正式/);
  assert.match(spine, /第一章/);
  assert.match(spine, /AI=人工智能/);
  assert.match(spine, /只.*改写|本节|这一节/);   // 有"只改本节"类约束
});

test("updateRollingSummary: 追加并受上限截断", () => {
  const LR = load();
  let s = LR.updateRollingSummary("", { index: 0, heading: "第一章", ok: true, blocks: [{ type: "paragraph", text: "新一段" }] });
  assert.match(s, /第一章/);
  const long = "x".repeat(2000);
  s = LR.updateRollingSummary(long, { index: 1, heading: "第二章", ok: true, blocks: [{ type: "paragraph", text: "y" }] }, { limit: 1200 });
  assert.ok(s.length <= 1200);
  assert.match(s, /第二章/);   // 最近的保留
});

function fakeHost(segments) {
  return { readDocumentSections: async () => ({ segments }) };
}
function fakeOpenAI(map) {
  // map: (userContent) => 返回字符串（JSON）或抛错
  return { chatCompletion: async ({ messages }) => {
    const user = messages.find((m) => m.role === "user")?.content || "";
    return map(user);
  } };
}

test("run: 每节独立调模型，产出 ok 结果 + 进度", async () => {
  const win = {};
  const LR = load(win);
  win.WpsAiHostWriter = fakeHost([
    para(0, "第一章", 0, 1), para(1, "正文A", 10),
    para(2, "第二章", 20, 1), para(3, "正文B", 30)
  ]);
  win.WpsAiOpenAI = fakeOpenAI(() => JSON.stringify({ blocks: [{ type: "paragraph", text: "改" }] }));
  const progress = [];
  const out = await LR.run({
    requirement: "更正式", parseJson: JSON.parse,
    onProgress: (d, t) => progress.push([d, t])
  });
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.ok));
  assert.equal(out.failed, 0);
  assert.deepEqual(progress[progress.length - 1], [2, 2]);
  assert.equal(typeof out.results[0].charStart, "number");
});

test("run: 某节解析失败不中断，标记 failed", async () => {
  const win = {};
  const LR = load(win);
  win.WpsAiHostWriter = fakeHost([para(0, "第一章", 0, 1), para(1, "第二章", 20, 1)]);
  let n = 0;
  win.WpsAiOpenAI = fakeOpenAI(() => (++n === 1 ? "не-json" : JSON.stringify({ blocks: [{ type: "paragraph", text: "ok" }] })));
  const out = await LR.run({ requirement: "x", parseJson: JSON.parse });
  assert.equal(out.results.length, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
});

test("orderResultsForWriteback: 只留 ok 且按 charStart 降序", () => {
  const LR = load();
  const ordered = LR.orderResultsForWriteback([
    { ok: true, charStart: 0, blocks: [] },
    { ok: false, charStart: 50, blocks: null },
    { ok: true, charStart: 100, blocks: [] },
    { ok: true, charStart: 30, blocks: [] }
  ]);
  assert.deepEqual(ordered.map((r) => r.charStart), [100, 30, 0]);
});

test("run: shouldStop 命中提前返回 stopped", async () => {
  const win = {};
  const LR = load(win);
  win.WpsAiHostWriter = fakeHost([para(0, "A", 0, 1), para(1, "B", 10, 1)]);
  win.WpsAiOpenAI = fakeOpenAI(() => JSON.stringify({ blocks: [{ type: "paragraph", text: "ok" }] }));
  const out = await LR.run({ requirement: "x", parseJson: JSON.parse, shouldStop: () => true });
  assert.equal(out.stopped, true);
  assert.equal(out.results.length, 0);
});

test("parseStructurePlan: 解析合法计划、丢弃越界", () => {
  const LR = load();
  const plan = LR.parseStructurePlan(JSON.stringify({ plan: [
    { op: "keep", from: 0 }, { op: "move", from: 2, to: 0 }, { op: "move", from: 9, to: 1 }
  ] }), 3);
  assert.deepEqual(plan, [{ op: "keep", from: 0 }, { op: "move", from: 2, to: 0 }]);  // from:9 越界丢弃
});
test("parseStructurePlan: 非法 JSON -> null", () => {
  const LR = load();
  assert.equal(LR.parseStructurePlan("nope", 3), null);
});

test("compileStructureMoves: move 计划 -> 带书签名与目标顺序", () => {
  const LR = load();
  const sections = [
    { charStart: 0, charEnd: 10, heading: "第一节" },
    { charStart: 10, charEnd: 20, heading: "第二节" },
    { charStart: 20, charEnd: 30, heading: "第三节" }
  ];
  const moves = LR.compileStructureMoves([{ op: "move", from: 2, to: 0 }, { op: "keep", from: 0 }, { op: "keep", from: 1 }], sections);
  assert.equal(moves.length, 3);
  assert.equal(moves[0].targetOrder, 0);          // 原第2节移到最前
  assert.ok(moves.every((m) => typeof m.name === "string" && m.name.length));
  assert.deepEqual([moves[0].charStart, moves[0].charEnd], [20, 30]);
  // heading 字段随 move 一并带出（供 reorderSectionsByBookmarks 缺书签时按标题重定位）
  assert.ok(moves.every((m) => "heading" in m), "每个 move 都应带 heading 字段");
  assert.equal(moves[0].heading, "第三节");        // 原第3节移到最前，heading 跟随
  assert.deepEqual(moves.map((m) => m.heading), ["第三节", "第一节", "第二节"]);
});

// 回归用例：文档正文里第一个标题前还有一段"引言"（无 heading）。planStructure 让模型基于
// buildOutline(sections)（只含有 heading 的节，0-based）给 from 编号，跟这里 sections 的下标
// （含引言在内的完整数组）不是同一套编号。compileStructureMoves 必须对同一份"heading 过滤后"
// 的清单取下标，否则 from 会因为引言占了下标 0 而全部错位一位，搬错节。
test("compileStructureMoves: 首个标题前有无 heading 的引言节，from 仍按大纲（heading 过滤后）编号解析", () => {
  const LR = load();
  const sections = [
    { charStart: 0, charEnd: 5, heading: null },       // 引言，无 heading，不在大纲里
    { charStart: 5, charEnd: 15, heading: "第一节" },   // 大纲 index 0
    { charStart: 15, charEnd: 25, heading: "第二节" },  // 大纲 index 1
    { charStart: 25, charEnd: 35, heading: "第三节" }   // 大纲 index 2
  ];
  // plan 的 from 是按大纲（只含 heading 的 3 节）编号的：from:2 应该指向"第三节"，
  // 而不是 sections[2]（"第二节"）——后者就是修复前会出现的错位 bug。
  const moves = LR.compileStructureMoves([{ op: "move", from: 2, to: 0 }], sections);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].heading, "第三节");
  assert.deepEqual([moves[0].charStart, moves[0].charEnd], [25, 35]);
});
