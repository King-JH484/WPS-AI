const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// local-matting.js 是挂 window 的 IIFE，末尾 `})(window)`。用 vm 注入假 window/fetch 加载。
// 预置 window.ort，让 ensureOrt 直接短路（不走 lazy-vendor 的 <script> 加载）。
function loadMatting(fetchImpl) {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "local-matting.js"), "utf8");
  const window = {
    WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" },
    ort: {
      env: { wasm: {} },
      InferenceSession: { create: async () => ({ inputNames: ["in"], outputNames: ["out"], __fake: true }) }
    }
  };
  const factory = vm.runInThisContext(
    "(function(window, fetch, DOMException, console){ " + code + "\n return window.WpsAiLocalMatting; })"
  );
  return factory(window, fetchImpl, DOMException, console);
}

// 可控的模型响应：直到 release() 调用前一直不结束，模拟 170MB 慢下载。
function slowModelFetch() {
  const state = { calls: 0, signalsSeen: [], release: null };
  const gate = new Promise((resolve) => { state.release = resolve; });
  const impl = async (url, opts = {}) => {
    state.calls += 1;
    state.signalsSeen.push(opts && opts.signal ? "has-signal" : "no-signal");
    let done = false;
    return {
      ok: true,
      headers: { get: () => "1048576" },
      body: {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true };
            await gate;          // 卡住，直到测试放行
            done = true;
            return { done: false, value: new Uint8Array(1048576) };
          }
        })
      }
    };
  };
  return { impl, state };
}

test("模型下载不接调用方 signal（共享资源不能被单次调用的取消掐断）", async () => {
  const { impl, state } = slowModelFetch();
  const api = loadMatting(impl);
  const ac = new AbortController();
  const p = api.ensureSession(null, ac.signal);
  p.catch(() => {}); // 下面会断言它 reject
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.calls, 1);
  assert.deepEqual(state.signalsSeen, ["no-signal"], "模型 fetch 不得携带调用方 signal");
  state.release();
  await p;
});

test("一个调用方取消，只让它自己不再等；共享下载继续、不重新下载", async () => {
  const { impl, state } = slowModelFetch();
  const api = loadMatting(impl);

  const ac = new AbortController();
  const cancelled = api.ensureSession(null, ac.signal);
  const waiting = api.ensureSession(null, null); // 第二个调用方继续等

  await new Promise((r) => setTimeout(r, 10));
  ac.abort();

  // 取消方立刻拿到 AbortError
  await assert.rejects(() => cancelled, (e) => e.name === "AbortError");

  // 但下载没被掐断：仍然只发过一次请求
  assert.equal(state.calls, 1, "取消不得触发重新下载");

  // 放行后，仍在等的调用方正常拿到 session
  state.release();
  const session = await waiting;
  assert.equal(session.__fake, true);

  // 取消过之后再次调用，直接复用已建好的 session，不再下载
  const again = await api.ensureSession(null, null);
  assert.equal(again.__fake, true);
  assert.equal(state.calls, 1, "session 已建好后不得再下载");
});

test("取消后重试：session 已缓存在内存，秒返回而非重下 170MB", async () => {
  const { impl, state } = slowModelFetch();
  const api = loadMatting(impl);

  const ac = new AbortController();
  const cancelled = api.ensureSession(null, ac.signal);
  cancelled.catch(() => {});
  ac.abort();
  await assert.rejects(() => cancelled, (e) => e.name === "AbortError");

  state.release();
  // 取消后新发起的抠图：复用同一个下载，不重来
  const session = await api.ensureSession(null, null);
  assert.equal(session.__fake, true);
  assert.equal(state.calls, 1, "取消后重试不得重新下载模型");
});

test("真失败才清 promise 允许重试（不是取消）", async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 502, json: async () => ({ error: "上游挂了" }) };
    return {
      ok: true,
      headers: { get: () => "4" },
      body: null,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
    };
  };
  const api = loadMatting(impl);
  await assert.rejects(() => api.ensureSession(null, null), /模型下载失败 502/);
  // 真失败后允许重试，这次成功
  const session = await api.ensureSession(null, null);
  assert.equal(session.__fake, true);
  assert.equal(calls, 2);
});
