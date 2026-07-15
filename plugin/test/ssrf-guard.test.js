const test = require("node:test");
const assert = require("node:assert");
const { isBlockedFetchHost } = require("../tools/ssrf-guard.js");

// 传入的是 new URL(x).hostname 的形态（IPv6 带方括号、点分 IPv4 可能被规范成十六进制映射）。
function hn(u) { return new URL(u).hostname; }

test("拦截：环回 / 私有 / 0.0.0.0", () => {
  ["http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.1.1/", "http://172.16.0.1/", "http://0.0.0.0/"]
    .forEach((u) => assert.strictEqual(isBlockedFetchHost(hn(u)), true, u));
});

test("拦截：十进制/八进制/十六进制 IPv4（URL 规范化后）", () => {
  ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/"]
    .forEach((u) => assert.strictEqual(isBlockedFetchHost(hn(u)), true, u));
});

test("拦截：IPv6 映射 IPv4（元数据 / 环回）", () => {
  assert.strictEqual(isBlockedFetchHost(hn("http://[::ffff:169.254.169.254]/")), true);
  assert.strictEqual(isBlockedFetchHost(hn("http://[::ffff:127.0.0.1]/")), true);
});

test("拦截：IPv6 ULA fc00::/7 与 ::1", () => {
  assert.strictEqual(isBlockedFetchHost(hn("http://[fd00::1]/")), true);
  assert.strictEqual(isBlockedFetchHost(hn("http://[fc00::1]/")), true);
  assert.strictEqual(isBlockedFetchHost(hn("http://[::1]/")), true);
});

test("拦截：IPv6 link-local fe80::/10（回归 M3）", () => {
  ["http://[fe80::1]/", "http://[fe9f::1]/", "http://[fea0::1]/", "http://[feb0::1]/"]
    .forEach((u) => assert.strictEqual(isBlockedFetchHost(hn(u)), true, u));
});

test("拦截：localhost 及尾点 FQDN", () => {
  assert.strictEqual(isBlockedFetchHost(hn("http://localhost/")), true);
  assert.strictEqual(isBlockedFetchHost(hn("http://localhost./")), true);
  assert.strictEqual(isBlockedFetchHost(hn("http://foo.localhost/")), true);
});

test("放行：正常公网主机 / 公网 IP", () => {
  assert.strictEqual(isBlockedFetchHost(hn("https://duckduckgo.com/")), false);
  assert.strictEqual(isBlockedFetchHost(hn("https://example.com/")), false);
  assert.strictEqual(isBlockedFetchHost(hn("http://8.8.8.8/")), false);
  assert.strictEqual(isBlockedFetchHost(hn("http://172.32.0.1/")), false); // 172.32 不在 172.16/12
});
