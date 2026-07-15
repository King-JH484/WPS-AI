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
