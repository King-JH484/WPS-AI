const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadModule() {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "js", "preserve-objects.js"),
    "utf8"
  );
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.WpsAiPreserveObjects;
}

test("classifySegment 优先级：table > image > shape > equation > empty > paragraph", () => {
  const P = loadModule();
  assert.equal(P.classifySegment({ inTable: true, hasInlineShape: true }), "table");
  assert.equal(P.classifySegment({ hasInlineShape: true }), "image");
  assert.equal(P.classifySegment({ hasAnchoredShape: true }), "shape");
  assert.equal(P.classifySegment({ hasEquation: true }), "equation");
  assert.equal(P.classifySegment({ textEmpty: true }), "empty");
  assert.equal(P.classifySegment({}), "paragraph");
});

test("isObjectKind 只认四类对象", () => {
  const P = loadModule();
  ["image", "table", "shape", "equation"].forEach((k) => assert.equal(P.isObjectKind(k), true));
  ["paragraph", "empty", "heading", undefined].forEach((k) => assert.equal(P.isObjectKind(k), false));
});

test("renderStructureWithPlaceholders：段落出原文、对象出占位符、全局顺序编号", () => {
  const P = loadModule();
  const structure = { segments: [
    { kind: "paragraph", text: "第一段", start: 0, end: 4 },
    { kind: "image", start: 4, end: 5, label: "图片" },
    { kind: "paragraph", text: "第二段", start: 5, end: 9 },
    { kind: "table", start: 9, end: 20, label: "表格" },
    { kind: "empty", text: "", start: 20, end: 21 }
  ] };
  const out = P.renderStructureWithPlaceholders(structure);
  assert.equal(out.text, "第一段\n[图片1]\n第二段\n[表格2]");
  assert.equal(out.objects.length, 2);
  assert.deepEqual(out.objects.map((o) => [o.seq, o.kind, o.label]), [[1, "image", "图片"], [2, "table", "表格"]]);
});

test("buildZones：对象把段落切成 对象数+1 个槽，空槽 hasRange=false", () => {
  const P = loadModule();
  const segs = [
    { kind: "paragraph", start: 0, end: 4 },
    { kind: "paragraph", start: 4, end: 8 },
    { kind: "image", start: 8, end: 9 },
    { kind: "paragraph", start: 9, end: 13 }
  ];
  const zones = P.buildZones(segs);
  assert.equal(zones.length, 2);
  assert.deepEqual(zones[0], { start: 0, end: 8, hasRange: true });
  assert.deepEqual(zones[1], { start: 9, end: 13, hasRange: true });
});

test("buildZones：文档以对象开头 -> 首槽为空槽", () => {
  const P = loadModule();
  const segs = [
    { kind: "table", start: 0, end: 10 },
    { kind: "paragraph", start: 10, end: 14 }
  ];
  const zones = P.buildZones(segs);
  assert.equal(zones.length, 2);
  assert.equal(zones[0].hasRange, false);
  assert.deepEqual({ start: zones[1].start, end: zones[1].end, hasRange: zones[1].hasRange }, { start: 10, end: 14, hasRange: true });
});

test("splitBlocksByPlaceholder：独立占位符 block 作为边界", () => {
  const P = loadModule();
  const blocks = [
    { type: "paragraph", text: "甲" },
    { type: "paragraph", text: "[图片1]" },
    { type: "paragraph", text: "乙" }
  ];
  const { groups, markerCount } = P.splitBlocksByPlaceholder(blocks);
  assert.equal(markerCount, 1);
  assert.equal(groups.length, 2);
  assert.equal(groups[0][0].text, "甲");
  assert.equal(groups[1][0].text, "乙");
});

test("splitBlocksByPlaceholder：行内占位符拆分文本", () => {
  const P = loadModule();
  const blocks = [{ type: "paragraph", text: "前[表格2]后" }];
  const { groups, markerCount } = P.splitBlocksByPlaceholder(blocks);
  assert.equal(markerCount, 1);
  assert.equal(groups[0][0].text, "前");
  assert.equal(groups[1][0].text, "后");
});

test("splitBlocksByPlaceholder：list/table 等非文本块整块保留、不误判", () => {
  const P = loadModule();
  const blocks = [{ type: "list", ordered: false, items: ["a", "b"] }];
  const { groups, markerCount } = P.splitBlocksByPlaceholder(blocks);
  assert.equal(markerCount, 0);
  assert.equal(groups[0][0].type, "list");
});

test("mapGroupsToZones：数量相等一一对应", () => {
  const P = loadModule();
  const zones = [
    { start: 0, end: 8, hasRange: true },
    { start: 9, end: 13, hasRange: true }
  ];
  const groups = [[{ text: "A" }], [{ text: "B" }]];
  const out = P.mapGroupsToZones(groups, zones);
  assert.equal(out.length, 2);
  assert.equal(out[0].blocks[0].text, "A");
  assert.equal(out[1].blocks[0].text, "B");
});

test("mapGroupsToZones：AI 漏写占位符 -> 缺组的槽拿不到内容（保留原文）", () => {
  const P = loadModule();
  const zones = [
    { start: 0, end: 8, hasRange: true },
    { start: 9, end: 13, hasRange: true }
  ];
  const groups = [[{ text: "只有一组" }]];
  const out = P.mapGroupsToZones(groups, zones);
  assert.equal(out.length, 2);
  assert.equal(out[0].blocks.length, 1);
  assert.equal(out[1].blocks.length, 0);
});

test("mapGroupsToZones：多余组并入最后一槽", () => {
  const P = loadModule();
  const zones = [{ start: 0, end: 8, hasRange: true }];
  const groups = [[{ text: "X" }], [{ text: "Y" }], [{ text: "Z" }]];
  const out = P.mapGroupsToZones(groups, zones);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].blocks.map((b) => b.text), ["X", "Y", "Z"]);
});

test("mapGroupsToZones：空槽内容并入最近可写槽（前优先）", () => {
  const P = loadModule();
  const zones = [
    { start: 0, end: 8, hasRange: true },
    { start: null, end: null, hasRange: false }
  ];
  const groups = [[{ text: "P" }], [{ text: "Q" }]];
  const out = P.mapGroupsToZones(groups, zones);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].blocks.map((b) => b.text), ["P", "Q"]);
});
