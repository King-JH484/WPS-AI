// 测 proxy 启动用的 node 选择逻辑：版本门槛 + 内置 node 优先 + 无可用 node 报错（不降级）。
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { pickProxyLauncher, findBundledNode, nodeSupportsSqlite } = require("../tools/pick-node.js");

const repoRoot = path.join(__dirname, "..");

test("nodeSupportsSqlite：22.5 是门槛", () => {
  assert.equal(nodeSupportsSqlite("v22.5.0"), true);
  assert.equal(nodeSupportsSqlite("v22.11.0"), true);
  assert.equal(nodeSupportsSqlite("v23.0.0"), true);
  assert.equal(nodeSupportsSqlite("v22.4.0"), false);
  assert.equal(nodeSupportsSqlite("v20.18.0"), false);
  assert.equal(nodeSupportsSqlite("v18.19.0"), false);
  assert.equal(nodeSupportsSqlite(""), false);
});

test("findBundledNode：仓库内能找到内置 node", () => {
  const p = findBundledNode(repoRoot);
  assert.ok(p, "应找到 runtime/*/node(.exe)");
  assert.match(p, /runtime[\\/]/);
});

test("pickProxyLauncher：有内置 node 时用它并带 --experimental-sqlite", () => {
  const r = pickProxyLauncher(repoRoot, "tools/proxy-server.js");
  assert.ok(!r.error, "不应报错");
  assert.match(r.nodeBin, /node(\.exe)?$/);
  assert.equal(r.args[0], "--experimental-sqlite");
  assert.match(r.args[1], /proxy-server\.js$/);
});

test("pickProxyLauncher：无内置 node + 老当前 node → error（不降级）", () => {
  // 指向一个没有 runtime 的目录，触发回退到当前 node 分支
  const r = pickProxyLauncher(path.join(__dirname, "no-such-runtime-dir"), "tools/proxy-server.js");
  if (nodeSupportsSqlite(process.version)) {
    assert.ok(!r.error, "当前 node 够新 → 用当前 node");
    assert.equal(r.args[0], "--experimental-sqlite");
  } else {
    assert.ok(r.error, "当前 node 太老且无内置 → 报错");
  }
});
