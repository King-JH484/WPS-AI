const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const spreadsheetJs = fs.readFileSync(path.join(__dirname, "../js/tools/spreadsheet.js"), "utf8");

function loadSpreadsheetTool(fakeInternal, imageAssets, extraGlobals = {}) {
  const tools = new Map();
  const context = {
    console,
    WpsAiHostSpreadsheet: { _internal: fakeInternal },
    WpsAiImageAssets: imageAssets || null,
    WpsAiToolRegistry: {
      registerTool(definition) {
        tools.set(definition.name, definition);
      }
    },
    ...extraGlobals
  };
  context.window = context;
  if (extraGlobals.window) context.window = extraGlobals.window;
  vm.createContext(context);
  vm.runInContext(spreadsheetJs, context, { filename: "spreadsheet.js" });
  return tools.get("et_insert_image");
}

function fakeSpreadsheetEnv(sheet) {
  const workbook = {
    ActiveSheet: sheet,
    Sheets: {
      Item() {
        return sheet;
      }
    }
  };
  return {
    async getApp() {
      return { Selection: sheet.Range("B2") };
    },
    async getActiveWorkbook() {
      return workbook;
    }
  };
}

function makeSheet(overrides = {}) {
  return {
    Name: "Sheet1",
    Activate() {},
    Range(address) {
      return { Address: address, Left: 32, Top: 48 };
    },
    ...overrides
  };
}

test("ET 图片插入不能在 AddPicture 返回空且计数未变时报告成功", async () => {
  const sheet = makeSheet({
    Shapes: {
      Count: 2,
      AddPicture() {
        return null;
      }
    }
  });
  const tool = loadSpreadsheetTool(fakeSpreadsheetEnv(sheet));

  await assert.rejects(
    () => tool.handler({ cell: "B2", fileName: "/tmp/material.png", width: 240 }),
    /图片插入未确认成功/
  );
});

test("ET 图片插入缺省高度时传入原生尺寸哨兵并确认形状数量增加", async () => {
  let shapeCount = 0;
  const calls = [];
  const sheet = makeSheet({
    Shapes: {
      get Count() {
        return shapeCount;
      },
      AddPicture(fileName, linkToFile, saveWithDocument, left, top, width, height) {
        calls.push({ fileName, linkToFile, saveWithDocument, left, top, width, height });
        if (width === 240 && height === -1) {
          shapeCount += 1;
          return { Name: "Picture 1", Select() {}, ZOrder() {} };
        }
        return null;
      }
    }
  });
  const tool = loadSpreadsheetTool(fakeSpreadsheetEnv(sheet));

  const result = await tool.handler({ cell: "B2", fileName: "/tmp/material.png", width: 240 });

  assert.equal(calls[0].width, 240);
  assert.equal(calls[0].height, -1);
  assert.equal(result.shapeIndex, 1);
  assert.equal(result.confirmed, true);
});

test("ET 图片插入在 WPS 返回 shape 时不因 Shapes.Count 暂未更新误报失败", async () => {
  const sheet = makeSheet({
    Shapes: {
      Count: 0,
      AddPicture() {
        return { Name: "Picture 1", Select() {}, ZOrder() {} };
      }
    }
  });
  const tool = loadSpreadsheetTool(fakeSpreadsheetEnv(sheet));

  const result = await tool.handler({ cell: "B2", fileName: "/tmp/material.png", width: 240 });

  assert.equal(result.confirmed, true);
});

test("ET 图片插入在 Shapes.AddPicture 失败后支持方法式 Pictures().Insert 兜底", async () => {
  const calls = [];
  const picture = { Name: "Picture 1", Select() {}, ZOrder() {} };
  const sheet = makeSheet({
    Shapes: {
      Count: 0,
      AddPicture() {
        return null;
      }
    },
    Pictures() {
      return {
        Insert(fileName) {
          calls.push(fileName);
          return picture;
        }
      };
    }
  });
  const tool = loadSpreadsheetTool(fakeSpreadsheetEnv(sheet));

  const result = await tool.handler({ cell: "B2", fileName: "/tmp/material.png", width: 240 });

  assert.deepEqual(calls, ["/tmp/material.png"]);
  assert.equal(result.strategy, "pictures.insert");
  assert.equal(result.confirmed, true);
});

test("ET 图片插入在对象模型插入失败后使用剪贴板图片粘贴兜底", async () => {
  let shapeCount = 0;
  let selected = false;
  const pasteCalls = [];
  const fetchCalls = [];
  const sheet = makeSheet({
    Shapes: {
      get Count() {
        return shapeCount;
      },
      Item() {
        return { Name: "Picture 1", Select() {}, ZOrder() {} };
      },
      AddPicture() {
        return null;
      }
    },
    Range(address) {
      return {
        Address: address,
        Left: 32,
        Top: 48,
        Select() {
          selected = true;
        }
      };
    },
    Pictures() {
      return {
        Insert() {
          return null;
        }
      };
    },
    Paste(destination) {
      pasteCalls.push(destination?.Address || null);
      shapeCount += 1;
    }
  });
  const tool = loadSpreadsheetTool(
    fakeSpreadsheetEnv(sheet),
    null,
    {
      WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" },
      fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          async json() {
            return { ok: true, imagePath: "/tmp/material.png", ext: ".png" };
          }
        };
      }
    }
  );

  const result = await tool.handler({ cell: "B2", fileName: "/tmp/material.png", width: 240 });

  assert.equal(fetchCalls[0].url, "http://127.0.0.1:3890/clipboard/image");
  assert.equal(JSON.parse(fetchCalls[0].options.body).path, "/tmp/material.png");
  assert.equal(selected, true);
  assert.deepEqual(pasteCalls, ["B2"]);
  assert.equal(result.strategy, "worksheet.paste-clipboard");
  assert.equal(result.confirmed, true);
});

test("ET 图片剪贴板兜底支持 Pictures().Paste 作为唯一粘贴 API", async () => {
  let shapeCount = 0;
  const sheet = makeSheet({
    Shapes: {
      get Count() {
        return shapeCount;
      },
      Item() {
        return { Name: "Picture 1", Select() {}, ZOrder() {} };
      }
    },
    Pictures() {
      return {
        Paste() {
          shapeCount += 1;
        }
      };
    }
  });
  const tool = loadSpreadsheetTool(
    fakeSpreadsheetEnv(sheet),
    null,
    {
      WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" },
      fetch: async () => ({
        ok: true,
        async json() {
          return { ok: true, imagePath: "/tmp/material.png", ext: ".png" };
        }
      })
    }
  );

  const result = await tool.handler({ cell: "B2", fileName: "/tmp/material.png", width: 240 });

  assert.equal(result.strategy, "pictures.paste-clipboard");
  assert.equal(result.confirmed, true);
});
