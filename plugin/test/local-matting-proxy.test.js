const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const proxyJs = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

test("proxy 提供本地抠图 ONNX 推理接口给无 WebAssembly 的 WebView 使用", () => {
  assert.match(proxyJs, /pathname === "\/local-matting-infer"/);
  assert.match(proxyJs, /getLocalMattingOrt/);
  assert.match(proxyJs, /getLocalMattingSession/);
  assert.match(proxyJs, /"ort-node"/);
  assert.match(proxyJs, /"ort\.node\.min\.js"/);
  assert.match(proxyJs, /ort-wasm\.wasm/);
  assert.match(proxyJs, /inputBase64/);
  assert.match(proxyJs, /maskBase64/);
});

test("proxy /local-matting-infer 返回 1024x1024 float32 蒙版", { timeout: 60000 }, async (t) => {
  const modelPath = path.join(process.env.HOME || "", ".anthony-ai", "models", "isnet-general-use.onnx");
  if (!fs.existsSync(modelPath)) {
    t.skip("本机尚未缓存 isnet-general-use.onnx");
    return;
  }
  const port = 4390 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ["--experimental-sqlite", path.join(__dirname, "../tools/proxy-server.js")], {
    env: Object.assign({}, process.env, { PROXY_PORT: String(port), PROXY_PORT_LADDER_SIZE: "1" }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  const onData = (buf) => { logs += String(buf); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  t.after(() => {
    try { child.kill("SIGTERM"); } catch (e) {}
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const r = await fetch(base + "/healthz");
      if (r.ok) break;
    } catch (e) {}
    if (Date.now() > deadline) throw new Error("proxy 未启动：" + logs.slice(-1000));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const input = new Float32Array(3 * 1024 * 1024);
  const resp = await fetch(base + "/local-matting-infer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      size: 1024,
      modelName: "isnet-general-use.onnx",
      inputBase64: Buffer.from(input.buffer).toString("base64")
    })
  });
  const json = await resp.json();
  assert.equal(resp.status, 200, json.error || logs.slice(-1000));
  assert.equal(json.ok, true);
  assert.equal(json.runtime.vendor, "ort-node");
  const mask = Buffer.from(json.maskBase64, "base64");
  assert.equal(mask.byteLength, 1024 * 1024 * 4);
});

// 回归：/model-file 的缓存落盘不能绑在客户端连接上。
// 曾经 clientRes 一 close 就 up.destroy() + cleanupTmp()，导致 170MB 模型下到一半被丢弃；
// 慢网下 WebView 请求必然先超时 → 每次抠图都从零重下、永远收敛不了。
// 断开后必须继续下完并 rename 到 cachePath，下次直接命中缓存。
test("/model-file 客户端断开后仍继续下载并落盘（不丢弃已下载部分）", () => {
  // 限定在 downloadModelStreamThrough 内（文件里另有无关的 clientRes close 处理器）
  const fnStart = proxyJs.indexOf("function downloadModelStreamThrough");
  assert.ok(fnStart > 0, "找不到 downloadModelStreamThrough");
  const fn = proxyJs.slice(fnStart, proxyJs.indexOf("\n}", fnStart));
  const closeHandler = /clientRes\.on\("close",[\s\S]*?\n    \}\);/.exec(fn);
  assert.ok(closeHandler, "找不到 clientRes close 处理器");
  const body = closeHandler[0];
  // 断开只能标记「不再往客户端写」，不能中断上游、更不能删临时文件
  assert.match(body, /clientGone = true/);
  assert.doesNotMatch(body, /cleanupTmp\(\)/, "客户端断开不得删除已下载的临时文件");
  assert.doesNotMatch(body, /up\.destroy\(\)/, "客户端断开不得中断上游下载");
  // 断开后 end 仍要走到 rename 落盘，且不再向已断开的客户端 end()
  assert.match(proxyJs, /if \(failed\) \{ cleanupTmp\(\);/);
  assert.match(proxyJs, /if \(!clientGone\) \{ try \{ clientRes\.end\(\); \} catch \(e\) \{\} \}/);
  assert.match(proxyJs, /const okClient = clientGone \? true : clientRes\.write\(chunk\);/);
});
