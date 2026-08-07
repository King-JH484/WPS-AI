const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const spreadsheetJs = fs.readFileSync(path.join(__dirname, "../js/tools/spreadsheet.js"), "utf8");

function colLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// 假 sheet：记录批量赋值（Range.Formula = 2D 数组）与逐格写入，便于断言走了哪条路径。
function makeWriteSheet(opts = {}) {
  const bulkCalls = [];
  const cellWrites = [];
  const bulkThrows = !!opts.bulkThrows;
  function cellFor(row, col) {
    return {
      Row: row, Column: col,
      Address: `$${colLetter(col)}$${row}`,
      set Formula(v) { cellWrites.push({ row, col, formula: v }); },
      set Value2(v) { cellWrites.push({ row, col, value: v }); }
    };
  }
  return {
    Name: "Sheet1",
    _bulkCalls: bulkCalls,
    _cellWrites: cellWrites,
    Range(addr) {
      return {
        Address: addr,
        Cells: { Item: () => cellFor(1, 1) }, // 测试统一以 A1 为起点
        set Formula(v) { if (bulkThrows) throw new Error("bulk unsupported"); bulkCalls.push({ addr, values: v }); }
      };
    },
    Cells: { Item: (r, c) => cellFor(r, c) }
  };
}

function loadWriteRange(sheet, extraGlobals = {}) {
  const tools = new Map();
  const workbook = { ActiveSheet: sheet, Sheets: { Item() { return sheet; } } };
  const context = {
    console,
    WpsAiHostSpreadsheet: { _internal: { async getActiveWorkbook() { return workbook; }, async getApp() { return {}; } } },
    WpsAiToolRegistry: { registerTool(def) { tools.set(def.name, def); } },
    WpsAiI18n: {
      t(s, params) { let out = String(s); if (params) for (const k in params) out = out.split("{" + k + "}").join(String(params[k])); return out; }
    },
    ...extraGlobals
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(spreadsheetJs, context, { filename: "spreadsheet.js" });
  return tools.get("et_write_range");
}

test("规整矩形走一次性批量写（Range.Formula = 2D 数组）", async () => {
  const sheet = makeWriteSheet();
  const tool = loadWriteRange(sheet);
  const res = await tool.handler({ range: "A1", values: [[1, 2, 3], [4, 5, 6]] });
  assert.equal(sheet._bulkCalls.length, 1);
  assert.deepEqual(sheet._bulkCalls[0].values, [[1, 2, 3], [4, 5, 6]]);
  assert.equal(sheet._cellWrites.length, 0, "批量成功时不应逐格写");
  assert.equal(res.rows, 2);
  assert.equal(res.cols, 3);
});

test("批量赋值抛错时落逐格兜底", async () => {
  const sheet = makeWriteSheet({ bulkThrows: true });
  const tool = loadWriteRange(sheet);
  await tool.handler({ range: "A1", values: [[1, 2], [3, 4]] });
  assert.equal(sheet._bulkCalls.length, 0);
  assert.equal(sheet._cellWrites.length, 4, "2x2 逐格写 4 次");
});

test("参差行走逐格且保留缺位不覆盖右侧的跳空行为", async () => {
  const sheet = makeWriteSheet();
  const tool = loadWriteRange(sheet);
  await tool.handler({ range: "A1", values: [[1, 2, 3], [4]] });
  assert.equal(sheet._bulkCalls.length, 0, "参差不走批量");
  // 第一行 3 格 + 第二行仅 1 格（col2/col3 跳过） = 4 次
  assert.equal(sheet._cellWrites.length, 4);
  const secondRow = sheet._cellWrites.filter((w) => w.row === 2);
  assert.equal(secondRow.length, 1);
  assert.equal(secondRow[0].col, 1);
});

test("超巨区域（> 50 万单元格）写前直接拒绝并本地化提示", async () => {
  const sheet = makeWriteSheet();
  const tool = loadWriteRange(sheet);
  const rows = 1000;
  const cols = 501; // 501000 > 500000
  const values = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));
  await assert.rejects(() => tool.handler({ range: "A1", values }), /区域过大.*501000/);
  assert.equal(sheet._bulkCalls.length, 0);
  assert.equal(sheet._cellWrites.length, 0);
});

test("逐格路径能被 abort 信号中断（AbortError）", async () => {
  const sheet = makeWriteSheet({ bulkThrows: true });
  const tool = loadWriteRange(sheet);
  await assert.rejects(
    () => tool.handler({ range: "A1", values: [[1, 2], [3, 4]] }, { signal: { aborted: true } }),
    (e) => e.name === "AbortError"
  );
});
