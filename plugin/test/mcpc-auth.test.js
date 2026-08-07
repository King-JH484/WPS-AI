const test = require("node:test");
const assert = require("node:assert");
const { makeTokenGate } = require("../tools/mcp-client-manager.js");

test("TOFU：首个带 token 的请求建立信任并落盘", () => {
  let persisted = null;
  const gate = makeTokenGate(() => null, (t) => { persisted = t; });
  const r = gate.check("Bearer abc123");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.established, true);
  assert.strictEqual(persisted, "abc123");
  assert.strictEqual(gate.current(), "abc123");
});

test("建立后：匹配放行，不匹配/缺失 401", () => {
  const gate = makeTokenGate(() => "sekret", () => {});
  assert.strictEqual(gate.check("Bearer sekret").ok, true);
  assert.strictEqual(gate.check("Bearer wrong").ok, false);
  assert.strictEqual(gate.check("").ok, false);
  assert.strictEqual(gate.check(undefined).ok, false);
});

test("未建立且无 token → 拒绝，不建立空信任", () => {
  const gate = makeTokenGate(() => null, () => {});
  assert.strictEqual(gate.check("").ok, false);
  assert.strictEqual(gate.current(), null);
});

test("从文件加载已有 token：攻击者无 token 被拒", () => {
  const gate = makeTokenGate(() => "file-token", () => {});
  assert.strictEqual(gate.check("Bearer file-token").ok, true);
  assert.strictEqual(gate.check("Bearer attacker").ok, false);
});
