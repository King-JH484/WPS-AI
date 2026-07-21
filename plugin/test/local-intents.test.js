const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadIntents(appObj) {
  const win = { WpsAiAddon: { getApplicationSync: () => appObj } };
  vm.runInThisContext("(function(window){" + fs.readFileSync(path.join(ROOT, "js", "local-intents.js"), "utf8") + "})")(win);
  return win.WpsAiLocalIntents;
}

test("正向命中：保存/跳页/插表/撤销/重做（含变体与句尾标点）", () => {
  const L = loadIntents(null);
  assert.equal(L.match("保存", "wps").key, "save");
  assert.equal(L.match("保存文档。", "wps").key, "save");
  assert.deepEqual(L.match("跳到第3页", "wps").params, { page: 3 });
  assert.deepEqual(L.match("翻到第 12 页！", "wps").params, { page: 12 });
  assert.deepEqual(L.match("插入3x4表格", "wps").params, { rows: 3, cols: 4 });
  assert.deepEqual(L.match("插入 3×4 的表格", "wps").params, { rows: 3, cols: 4 });
  assert.deepEqual(L.match("插入3行4列的表格", "wps").params, { rows: 3, cols: 4 });
  assert.equal(L.match("撤销", "et").key, "undo");
  assert.equal(L.match("重做", "wpp").key, "redo");
});

test("绝不误命中：带附加语义的句子全部放行给模型", () => {
  const L = loadIntents(null);
  const mustMiss = [
    "帮我保存一份总结到文档里",
    "保存之前先帮我检查一遍错别字",
    "跳到第3页然后把标题改成红色",
    "插入3x4表格并填入销售数据",
    "撤销刚才那次排版然后重新排一次",
    "第3页写了什么",
    "把表格插入到第二章后面",
    "这个文档怎么保存为 PDF"
  ];
  for (const s of mustMiss) assert.equal(L.match(s, "wps"), null, `不应命中：${s}`);
  // 宿主过滤：跳页/插表只在 wps
  assert.equal(L.match("跳到第3页", "et"), null);
  assert.equal(L.match("插入3x4表格", "wpp"), null);
  // 参数越界
  assert.equal(L.match("插入99行99列表格", "wps"), null);
});

test("execute：保存/跳页/插表走对应 COM 调用", async () => {
  const calls = [];
  const appObj = {
    ActiveDocument: {
      Save: () => calls.push("save"),
      Tables: { Add: (r, rows, cols) => calls.push(`table:${rows}x${cols}`) },
      Undo: () => calls.push("undo")
    },
    Selection: {
      GoTo: (what, which, n) => calls.push(`goto:${what},${which},${n}`),
      Range: { r: 1 }
    }
  };
  const L = loadIntents(appObj);
  assert.match((await L.execute({ key: "save", params: {} })).message, /保存/);
  assert.match((await L.execute({ key: "gotoPage", params: { page: 5 } })).message, /5/);
  assert.match((await L.execute({ key: "insertTable", params: { rows: 2, cols: 3 } })).message, /2×3/);
  assert.deepEqual(calls, ["save", "goto:1,1,5", "table:2x3"]);
});

test("接线：runChatTurn 前置路由（无 quickAction、无附件才走）", () => {
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  assert.match(appJs, /WpsAiLocalIntents\?\.match\?\.\(userInput/);
  assert.match(appJs, /!quickAction && pendingAttachments\.length === 0/);
  const mainJs = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.ok(mainJs.includes("js/local-intents.js"));
});
