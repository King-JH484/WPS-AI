const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function loadFollow({ settings, appObj }) {
  const code = fs.readFileSync(path.join(ROOT, "js", "follow-highlight.js"), "utf8");
  const window = {
    WpsAiProviderRegistry: { loadSettings: () => settings },
    WpsAiAddon: { getApplicationSync: () => appObj }
  };
  vm.runInThisContext("(function(window){" + code + "})")(window);
  return window.WpsAiFollow;
}

test("et 修改成功后按 writtenRange 激活工作表并 Select + Goto", () => {
  const calls = [];
  const range = { Select: () => calls.push("select") };
  const sheet = {
    Activate: () => calls.push("activate"),
    Range: (addr) => { calls.push("range:" + addr); return range; }
  };
  const app = {
    ActiveWorkbook: { Worksheets: { Item: (name) => { calls.push("sheet:" + name); return sheet; } } },
    ActiveSheet: sheet,
    Goto: (r, scroll) => calls.push("goto:" + scroll)
  };
  const follow = loadFollow({ settings: { aiFollowHighlight: true }, appObj: app });
  follow.afterMutatingTool("et", "et_write_range", { sheet: "Sheet1", range: "A1" }, { sheet: "Sheet1", writtenRange: "$A$1:$C$3" });
  assert.deepEqual(calls, ["sheet:Sheet1", "activate", "range:$A$1:$C$3", "select", "goto:true"]);
});

test("wps 修改成功后 ScrollIntoView 当前选区且不改选区", () => {
  const calls = [];
  const app = {
    Selection: { Range: { some: 1 } },
    ActiveWindow: { ScrollIntoView: (r, start) => calls.push("scroll:" + start) }
  };
  const follow = loadFollow({ settings: {}, appObj: app });
  follow.afterMutatingTool("wps", "wps_insert_text", {}, {});
  assert.deepEqual(calls, ["scroll:true"]);
});

test("设置关闭时完全不动宿主", () => {
  let touched = false;
  const app = new Proxy({}, { get: () => { touched = true; return undefined; } });
  const follow = loadFollow({ settings: { aiFollowHighlight: false }, appObj: app });
  follow.afterMutatingTool("et", "et_write_range", { range: "A1" }, {});
  follow.afterMutatingTool("wps", "wps_insert_text", {}, {});
  assert.equal(touched, false);
});

test("registry.execute 在修改型工具成功后调用 WpsAiFollow", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "tools", "registry.js"), "utf8");
  assert.match(src, /WpsAiFollow\?\.afterMutatingTool\?\.\(host, name, args, result\.value\)/);
});

test("revealLocation：Word 查找命中 → 选中 + 滚动", () => {
  const calls = [];
  const app = {
    Selection: {
      Find: {
        ClearFormatting: () => calls.push("clear"),
        Execute: () => { calls.push(`find:${app.Selection.Find.Text}`); return true; }
      },
      Range: () => ({ r: 1 })
    },
    ActiveWindow: { ScrollIntoView: () => calls.push("scroll") }
  };
  const follow = loadFollow({ settings: {}, appObj: app });
  const r = follow.revealLocation("wps", { findText: "第三章 保障措施" });
  assert.equal(r.revealed, true);
  assert.ok(calls.includes("find:第三章 保障措施"));
  assert.ok(calls.includes("scroll"));
});

test("revealLocation：Word 未找到 → 抛错", () => {
  const app = { Selection: { Find: { ClearFormatting() {}, Execute: () => false } } };
  const follow = loadFollow({ settings: {}, appObj: app });
  assert.throws(() => follow.revealLocation("wps", { findText: "不存在" }), /未在文档中找到/);
});

test("revealLocation：Excel 激活工作表 + Select + Goto；PPT 跳转幻灯片", () => {
  const calls = [];
  const range = { Select: () => calls.push("select") };
  const sheet = { Name: "Sheet1", Activate: () => calls.push("activate"), Range: () => range };
  const etApp = {
    ActiveWorkbook: { Worksheets: { Item: () => sheet } },
    ActiveSheet: sheet,
    Goto: (r, scroll) => calls.push(`goto:${scroll}`)
  };
  const et = loadFollow({ settings: {}, appObj: etApp });
  const er = et.revealLocation("et", { range: "A1:C3", sheet: "Sheet1" });
  assert.equal(er.revealed, true);
  assert.deepEqual(calls, ["activate", "select", "goto:true"]);

  let gotoSlide = 0;
  const wppApp = { ActiveWindow: { View: { GotoSlide: (n) => { gotoSlide = n; } } } };
  const wpp = loadFollow({ settings: {}, appObj: wppApp });
  const wr = wpp.revealLocation("wpp", { slide: 4 });
  assert.equal(wr.revealed, true);
  assert.equal(gotoSlide, 4);
});

test("接线：reveal_location 工具注册且判为只读", () => {
  const common = fs.readFileSync(path.join(ROOT, "js", "tools", "common.js"), "utf8");
  assert.match(common, /name: "reveal_location"/);
  assert.match(common, /WpsAiFollow\.revealLocation\(host/);
  const history = fs.readFileSync(path.join(ROOT, "js", "history.js"), "utf8");
  assert.match(history, /"reveal_location"/);
});
