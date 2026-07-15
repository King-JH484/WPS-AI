"use strict";
// 选一个能跑 proxy 的 node：node:sqlite 需要 --experimental-sqlite 且 Node >= 22.5。
// 优先用内置 runtime/*/node(.exe)（保证是我们打包的 v22.11、一定支持该 flag）；
// 找不到内置就用当前 node（仅当其版本 >= 22.5）。两者都不满足 → 返回 { error }，
// 由调用方明确报错退出，绝不"降级不带 flag 悄悄跑"（缓存不允许退回 localStorage）。
const fs = require("fs");
const path = require("path");

function nodeSupportsSqlite(ver) {
  const m = /v?(\d+)\.(\d+)/.exec(String(ver || ""));
  if (!m) return false;
  const maj = Number(m[1]), min = Number(m[2]);
  return maj > 22 || (maj === 22 && min >= 5);
}

// 在 <cwd>/runtime/*/ 下找第一个存在的 node 可执行文件
function findBundledNode(cwd) {
  const root = path.resolve(cwd, "runtime");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (e) { return null; }
  for (const d of dirs) {
    for (const rel of ["node.exe", "node", path.join("bin", "node")]) {
      const p = path.join(root, d, rel);
      try { if (fs.statSync(p).isFile()) return p; } catch (e) {}
    }
  }
  return null;
}

// 成功 → { nodeBin, args }（args 已含 --experimental-sqlite + 脚本绝对路径）。
// 没有可用 node → { error }，由调用方报错退出（绝不降级不带 flag 跑）。
function pickProxyLauncher(cwd, scriptRelPath) {
  const script = path.resolve(cwd, scriptRelPath);
  const bundled = findBundledNode(cwd);
  if (bundled) return { nodeBin: bundled, args: ["--experimental-sqlite", script] };
  if (nodeSupportsSqlite(process.version)) {
    return { nodeBin: process.execPath, args: ["--experimental-sqlite", script] };
  }
  return {
    error:
      "SQLite 存储需要 Node >= 22.5（当前 " + process.version + "），且未找到内置 runtime node。" +
      "请用内置 node 启动，或将本机 Node 升级到 22.5+（如 nvm install 22.11）后重试。"
  };
}

module.exports = { pickProxyLauncher, findBundledNode, nodeSupportsSqlite };
