const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findBundledNode } = require("../tools/pick-node.js");

// 回归：开发机为交叉打包会同时放多平台 runtime（node-linux-arm64 按字母序排最前），
// findBundledNode 必须按当前平台过滤，绝不能在 Windows 上选中 Linux 二进制。
function makeRuntime(dirs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "picknode-"));
  for (const [dir, rel] of dirs) {
    const full = path.join(cwd, "runtime", dir, path.dirname(rel));
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(cwd, "runtime", dir, rel), "");
  }
  return cwd;
}

test("findBundledNode 跳过其它平台的 runtime，只选当前平台", () => {
  const plat = process.platform === "win32" ? "win" : process.platform;
  const exe = process.platform === "win32" ? "node.exe" : path.join("bin", "node");
  const cwd = makeRuntime([
    // 故意让「其它平台」目录按字母序排在最前面
    ["node-aaa-other-x64", process.platform === "win32" ? path.join("bin", "node") : "node.exe"],
    ["node-linux-arm64", path.join("bin", "node")],
    [`node-${plat}-${process.arch}`, exe]
  ]);
  const picked = findBundledNode(cwd);
  assert.ok(picked, "应该找到当前平台的 node");
  assert.match(picked, new RegExp(`node-${plat}-`), `选中的必须是当前平台目录，实际: ${picked}`);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("findBundledNode 架构不完全匹配时兜底同平台其它架构", () => {
  const plat = process.platform === "win32" ? "win" : process.platform;
  const otherArch = process.arch === "x64" ? "arm64" : "x64";
  const exe = process.platform === "win32" ? "node.exe" : path.join("bin", "node");
  const cwd = makeRuntime([[`node-${plat}-${otherArch}`, exe]]);
  const picked = findBundledNode(cwd);
  assert.ok(picked, "同平台不同架构应作为兜底被选中");
  assert.match(picked, new RegExp(`node-${plat}-${otherArch}`));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("findBundledNode 没有当前平台 runtime 时返回 null（不乱选）", () => {
  const cwd = makeRuntime([["node-nonexist-platform-x64", "node"]]);
  assert.equal(findBundledNode(cwd), null);
  fs.rmSync(cwd, { recursive: true, force: true });
});
