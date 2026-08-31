#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const pluginDir = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = path.resolve(outIndex >= 0 && args[outIndex + 1]
  ? args[outIndex + 1]
  : path.join(os.tmpdir(), "anthony-ai-storage-cleanup"));

execFileSync(process.execPath, [path.join(__dirname, "build-variants.js"), "--out", out], { stdio: "inherit" });
for (const host of ["wps", "et", "wpp", "pdf"]) {
  const dir = path.join(out, `plugin-${host}`);
  fs.copyFileSync(path.join(dir, "cleanup-storage.html"), path.join(dir, "index.html"));
}

fs.writeFileSync(path.join(out, "CLEANUP-MODE.txt"),
  "This directory contains Anthony AI storage-cleanup variants only. Do not use it as the normal plugin runtime.\n",
  "utf8");
console.log(`[OK] 四宿主存储清理变体已生成: ${out}`);
