const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildClipboardReadCommand,
  buildClipboardWriteCommand,
  buildClipboardImageWriteCommand,
  normalizeClipboardText
} = require("../tools/clipboard.js");

const proxyServerJs = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

test("macOS clipboard helper uses pbpaste", () => {
  assert.deepStrictEqual(buildClipboardReadCommand("darwin"), {
    cmd: "/usr/bin/pbpaste",
    args: []
  });
});

test("macOS clipboard writer uses pbcopy", () => {
  assert.deepStrictEqual(buildClipboardWriteCommand("darwin"), {
    cmd: "/usr/bin/pbcopy",
    args: []
  });
});

test("Windows clipboard helper uses PowerShell Get-Clipboard", () => {
  const r = buildClipboardReadCommand("win32");
  assert.equal(r.cmd, "powershell.exe");
  assert.ok(r.args.join(" ").includes("Get-Clipboard"));
});

test("Windows clipboard reader forces UTF-8 output for Chinese JSON", () => {
  const r = buildClipboardReadCommand("win32");
  const command = r.args.join(" ");

  assert.match(command, /Console\]::OutputEncoding/);
  assert.match(command, /UTF8Encoding/);
  assert.ok(command.indexOf("OutputEncoding") < command.indexOf("Get-Clipboard"));
});

test("Windows clipboard writer uses PowerShell Set-Clipboard with stdin", () => {
  const r = buildClipboardWriteCommand("win32");
  assert.equal(r.cmd, "powershell.exe");
  assert.ok(r.args.join(" ").includes("Set-Clipboard"));
  assert.ok(r.args.join(" ").includes("In.ReadToEnd"));
});

test("Windows clipboard writer reads stdin as UTF-8 for Chinese JSON", () => {
  const r = buildClipboardWriteCommand("win32");
  const command = r.args.join(" ");

  assert.match(command, /Console\]::InputEncoding/);
  assert.match(command, /UTF8Encoding/);
  assert.ok(command.indexOf("InputEncoding") < command.indexOf("In.ReadToEnd"));
});

test("macOS clipboard image writer uses osascript PNG clipboard class", () => {
  const r = buildClipboardImageWriteCommand("/tmp/a.png", "image/png", "darwin");
  assert.equal(r.cmd, "/usr/bin/osascript");
  assert.ok(r.args.join("\n").includes("PNGf"));
  assert.equal(r.args[r.args.length - 1], "/tmp/a.png");
});

test("normalizeClipboardText preserves content but strips trailing NUL bytes", () => {
  assert.equal(normalizeClipboardText("hello\u0000\u0000"), "hello");
  assert.equal(normalizeClipboardText("hello\n"), "hello\n");
});

test("clipboard proxy JSON responses declare UTF-8 charset for Chinese text", () => {
  assert.match(proxyServerJs, /"Content-Type":\s*"application\/json; charset=utf-8"/);
});
