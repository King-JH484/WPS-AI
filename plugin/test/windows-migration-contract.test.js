"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

test("Windows 安装器不复用旧 LingxiAI 目录并固定当前 fork", () => {
  const iss = read("installer/anthony-ai.iss");
  assert.match(iss, /DefaultDirName=\{localappdata\}\\Programs\\AnthonyAI/);
  assert.match(iss, /UsePreviousAppDir=no/);
  assert.match(iss, /PrivilegesRequired=lowest/);
  assert.doesNotMatch(iss, /PrivilegesRequiredOverridesAllowed/);
  assert.match(iss, /github\.com\/King-JH484\/WPS-AI/);
  assert.match(iss, /install-complete\.json/);
  assert.match(iss, /ResultCode <> 0/);
});

test("Windows 安装与卸载统一使用 XML DOM helper，不整文件删除 publish.xml", () => {
  for (const rel of [
    "plugin/tools/post-install-windows.bat",
    "plugin/tools/pre-uninstall-windows.bat",
    "plugin/uninstall-permanent-windows.bat"
  ]) {
    const body = read(rel);
    assert.match(body, /update-wps-publish\.ps1/);
    assert.doesNotMatch(body, /del\s+\/F\s+\/Q\s+"%PUBLISH%"/i);
    assert.doesNotMatch(body, /findstr[^\r\n]*jspluginonline/i);
  }
  const helper = read("plugin/tools/update-wps-publish.ps1");
  assert.match(helper, /System\.Xml\.XmlDocument/);
  assert.match(helper, /File\]::Replace/);
  assert.match(helper, /lingxi-ai\|anthony-ai/);
});

test("Windows 安装链引用的关键脚本全部存在", () => {
  const validator = require("child_process").spawnSync(process.execPath, [
    path.join(repo, "plugin/tools/validate-windows-package.js"), repo
  ], { encoding: "utf8" });
  assert.equal(validator.status, 0, validator.stderr || validator.stdout);
  assert.match(validator.stdout, /静态门禁通过/);
});

test("面向 Windows 的 UTF-8 bat 显式切换代码页且未损坏", () => {
  for (const rel of [
    "installer/build.bat",
    "plugin/install-permanent-windows.bat",
    "plugin/uninstall-permanent-windows.bat",
    "plugin/tools/post-install-windows.bat",
    "plugin/tools/pre-uninstall-windows.bat"
  ]) {
    const body = read(rel);
    assert.match(body, /chcp 65001/i, rel);
    assert.equal(body.includes("�"), false, `${rel} 含 Unicode 替换字符`);
  }
});

test("干净迁移要求目标用户 SID、四宿主存储确认和卸载后复检", () => {
  const body = read("plugin/tools/clean-migrate-windows.ps1");
  assert.match(body, /ConfirmStorageCleaned/);
  assert.match(body, /CurrentSid/);
  assert.match(body, /Assert-TargetUser/);
  assert.match(body, /Parse-Uninstaller/);
  assert.match(body, /before\.json/);
  assert.match(body, /after\.json/);
  assert.match(body, /remaining -ne 0/);
});
