#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repo = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const required = [
  "installer/anthony-ai.iss",
  "installer/build.bat",
  "plugin/runtime/node-win-x64/node.exe",
  "plugin/tools/post-install-windows.bat",
  "plugin/tools/pre-uninstall-windows.bat",
  "plugin/tools/update-wps-publish.ps1",
  "plugin/tools/stop-user-processes.ps1",
  "plugin/tools/remove-product-autostart.ps1",
  "plugin/tools/clean-migrate-windows.ps1",
  "plugin/tools/prepare-storage-cleanup.js",
  "plugin/tools/serve-storage-cleanup.js",
  "plugin/tools/write-install-marker.ps1",
  "plugin/tools/resolve-windows-install-user.ps1",
  "plugin/tools/cleanup-install-dir.ps1",
  "plugin/tools/pick-ports.ps1",
  "plugin/tools/rewrite-proxy-port.ps1",
  "plugin/tools/register-task.ps1",
  "plugin/tools/probe-windows-service.ps1",
  "plugin/tools/probe-windows-routes.ps1",
  "plugin/tools/build-variants.js",
  "plugin/tools/serve-permanent.js",
  "plugin/tools/service-runner.js",
  "plugin/tools/service-watchdog.ps1",
  "plugin/tools/run-hidden.vbs",
  "plugin/tools/proxy-server.js",
  "plugin/tools/mcp-server.js",
  "plugin/tools/zip-extract.js",
  "plugin/tools/pick-node.js"
];

const failures = [];
for (const rel of required) {
  const file = path.join(repo, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) failures.push(`缺少必需文件: ${rel}`);
}

function read(rel) { return fs.readFileSync(path.join(repo, rel), "utf8"); }
function requireText(rel, pattern, message) {
  const body = read(rel);
  if (!pattern.test(body)) failures.push(`${rel}: ${message}`);
  if (body.includes("\uFFFD")) failures.push(`${rel}: 包含 Unicode 替换字符，疑似编码损坏`);
}

requireText("installer/anthony-ai.iss", /UsePreviousAppDir=no/, "必须禁止复用旧 LingxiAI 安装目录");
requireText("installer/anthony-ai.iss", /DefaultDirName=\{localappdata\}\\Programs\\AnthonyAI/, "必须固定按用户安装目录");
requireText("installer/anthony-ai.iss", /King-JH484\/WPS-AI/, "仓库 URL 必须指向当前 fork");
requireText("installer/anthony-ai.iss", /install-complete\.json/, "必须检查完整成功标记");
requireText("plugin/tools/post-install-windows.bat", /update-wps-publish\.ps1/, "安装必须使用共享 XML DOM 修改器");
requireText("plugin/tools/pre-uninstall-windows.bat", /update-wps-publish\.ps1/, "卸载必须使用共享 XML DOM 修改器");
requireText("plugin/tools/post-install-windows.bat", /if errorlevel 1/, "关键步骤必须传播失败");
requireText("plugin/tools/probe-windows-routes.ps1", /exit 1/, "路由失败必须返回非零");
requireText("plugin/tools/probe-windows-service.ps1", /ProxyPort/, "必须同时探活代理端口");

const iss = read("installer/anthony-ai.iss");
for (const rel of required.filter((x) => x.startsWith("plugin/"))) {
  const packagedRel = rel.replace(/^plugin\//, "").replace(/\//g, "\\");
  if (rel.includes("runtime/node-win-x64/node.exe") && !iss.includes("runtime\\node-win-x64")) {
    failures.push("installer/anthony-ai.iss: 未确认打包 Windows Node runtime");
    break;
  }
}

if (failures.length) {
  failures.forEach((item) => console.error(`[X] ${item}`));
  process.exit(1);
}

console.log(`[OK] Windows 安装包静态门禁通过，共检查 ${required.length} 个必需文件`);
