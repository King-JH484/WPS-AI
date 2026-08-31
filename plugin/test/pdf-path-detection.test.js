const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const pdfHostJs = fs.readFileSync(path.join(__dirname, "../js/hosts/pdf.js"), "utf8");
const backupJs = fs.readFileSync(path.join(__dirname, "../js/backup.js"), "utf8");

function loadPdfHost(overrides = {}) {
  const sandbox = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    ...overrides
  };
  sandbox.window = sandbox;
  vm.runInNewContext(pdfHostJs, sandbox);
  return sandbox;
}

function loadBackup(overrides = {}) {
  const sandbox = {
    window: null,
    crypto: { randomUUID() { return "test-uuid"; } },
    console: { log() {}, warn() {}, error() {} },
    ...overrides
  };
  sandbox.window = sandbox;
  vm.runInNewContext(backupJs, sandbox);
  return sandbox;
}

test("WpsAiHostPdf.getActivePdfPath 支持从 PdfApplication + FilePath 读取 PDF 绝对路径", async () => {
  const pdfDoc = { FilePath: "/tmp/demo.pdf" };
  const sandbox = loadPdfHost({
    wps: {
      PdfApplication() {
        return { ActivePDF: pdfDoc };
      }
    }
  });

  const pdfPath = await sandbox.WpsAiHostPdf.getActivePdfPath();
  assert.equal(pdfPath, "/tmp/demo.pdf");
});

test("WpsAiHostPdf.getActivePdfPath 在 Path+FileName 组合时返回完整路径", async () => {
  const pdfDoc = { Path: "/tmp/docs", FileName: "demo.pdf" };
  const sandbox = loadPdfHost({
    Application: { ActivePDF: pdfDoc }
  });

  const pdfPath = await sandbox.WpsAiHostPdf.getActivePdfPath();
  assert.equal(pdfPath, "/tmp/docs/demo.pdf");
});

test("WpsAiHostPdf.getActivePdfPath 支持 ActivePDF 返回 Promise", async () => {
  const sandbox = loadPdfHost({
    Application: {
      ActivePDF: Promise.resolve({ FilePath: "/tmp/async.pdf" })
    }
  });

  const pdfPath = await sandbox.WpsAiHostPdf.getActivePdfPath();
  assert.equal(pdfPath, "/tmp/async.pdf");
});

test("WpsAiHostPdf.getActivePdfPath 会绕过 unknown Application，改用 PdfApplication", async () => {
  const sandbox = loadPdfHost({
    Application: {},
    wps: {
      PdfApplication() {
        return { ActivePDF: { FilePath: "/tmp/pdf-app.pdf" } };
      }
    }
  });

  const pdfPath = await sandbox.WpsAiHostPdf.getActivePdfPath();
  assert.equal(pdfPath, "/tmp/pdf-app.pdf");
});

test("PDF 宿主桥为空时使用 adapter 的本机路径探测", async () => {
  const sandbox = loadPdfHost({
    WpsAiAddon: {
      async getApplication() { return {}; },
      async probePdfPath() { return { resolvedPath: "/tmp/fallback.pdf" }; }
    }
  });

  assert.equal(await sandbox.WpsAiHostPdf.getActivePdfPath(), "/tmp/fallback.pdf");
});

test("adapter 也取不到路径时继续请求 /active-pdf-path", async () => {
  const sandbox = loadPdfHost({
    WpsAiRuntime: { proxyBase() { return "http://127.0.0.1:3890"; } },
    WpsAiAddon: {
      async getApplication() { return {}; },
      async probePdfPath() { return { resolvedPath: null }; }
    },
    async fetch(url, init) {
      assert.equal(url, "http://127.0.0.1:3890/active-pdf-path");
      assert.equal(init.method, "GET");
      return { ok: true, async json() { return { ok: true, path: "/tmp/proxy.pdf" }; } };
    }
  });

  assert.equal(await sandbox.WpsAiHostPdf.getActivePdfPath(), "/tmp/proxy.pdf");
});

test("pageCount/readPage 在 PDF 宿主桥为空时统一回退 /pdf-extract", async () => {
  let extractCalls = 0;
  const sandbox = loadPdfHost({
    WpsAiRuntime: { proxyBase() { return "http://127.0.0.1:3890"; } },
    WpsAiAddon: {
      async getApplication() { return {}; },
      async probePdfPath() { return { resolvedPath: "/tmp/fallback.pdf" }; }
    },
    async fetch(url, init) {
      assert.equal(url, "http://127.0.0.1:3890/pdf-extract");
      assert.equal(init.method, "POST");
      extractCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, pageCount: 2, pages: [{ page: 1, text: "one" }, { page: 2, text: "two" }] };
        }
      };
    }
  });

  assert.equal(await sandbox.WpsAiHostPdf.pageCount(), 2);
  assert.equal(await sandbox.WpsAiHostPdf.readPage(2), "two");
  assert.equal(extractCalls, 1, "同一 PDF 应复用抽取结果");
});

test("readDocumentRange 的代理兜底保留页码范围", async () => {
  const sandbox = loadPdfHost({
    WpsAiAddon: {
      async getApplication() { return {}; },
      async probePdfPath() { return { resolvedPath: "/tmp/fallback.pdf" }; }
    },
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            pageCount: 3,
            pages: [{ page: 1, text: "one" }, { page: 2, text: "two" }, { page: 3, text: "three" }]
          };
        }
      };
    }
  });

  const result = await sandbox.WpsAiHostPdf.readDocumentRange({ startPage: 2, endPage: 3 });
  assert.equal(result.from, 2);
  assert.equal(result.to, 3);
  assert.equal(result.total, 3);
  assert.match(result.text, /【第 2 页】\ntwo/);
  assert.match(result.text, /【第 3 页】\nthree/);
  assert.doesNotMatch(result.text, /one/);
});

test("WpsAiBackup.getCurrentDocPath 支持 PDF 的 FilePath 字段", () => {
  const sandbox = loadBackup({
    Application: null,
    wps: {
      PdfApplication() {
        return { ActivePDF: { FilePath: "/tmp/report.pdf" } };
      }
    }
  });

  assert.equal(sandbox.WpsAiBackup.getCurrentDocPath(), "/tmp/report.pdf");
});

test("WpsAiBackup.getCurrentDocPath 支持 PDF 的 file:// 路径", () => {
  const sandbox = loadBackup({
    Application: {
      ActivePDF: { FullName: "file:///tmp/report.pdf" }
    }
  });

  assert.equal(sandbox.WpsAiBackup.getCurrentDocPath(), "/tmp/report.pdf");
});
