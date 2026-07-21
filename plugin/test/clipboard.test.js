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
    args: [],
    env: { LC_CTYPE: "en_US.UTF-8" }
  });
});

test("macOS clipboard writer uses pbcopy", () => {
  assert.deepStrictEqual(buildClipboardWriteCommand("darwin"), {
    cmd: "/usr/bin/pbcopy",
    args: [],
    env: { LC_CTYPE: "en_US.UTF-8" }
  });
});

// pbpaste/pbcopy 按 LC_CTYPE/LANG 决定编码，未设置时用非 UTF-8 的系统默认 → 中文乱码。
// 代理由 launchd 拉起，不继承登录 shell 的 locale，plist 里也只有端口变量，
// 所以线上必然没有 LC_CTYPE——必须由我们显式钉死，否则 mac 粘贴中文就是乱码。
test("macOS 剪贴板读写强制 UTF-8 locale（否则中文乱码）", () => {
  for (const build of [buildClipboardReadCommand, buildClipboardWriteCommand]) {
    const cmd = build("darwin");
    assert.ok(cmd.env, "darwin 命令必须带 env 覆盖");
    assert.match(String(cmd.env.LC_CTYPE), /UTF-8$/i);
  }
});

test("非 darwin 平台不注入 mac 的 locale 覆盖", () => {
  assert.equal(buildClipboardReadCommand("win32").env, undefined);
  assert.equal(buildClipboardReadCommand("linux", { DISPLAY: ":0" }).env, undefined);
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
