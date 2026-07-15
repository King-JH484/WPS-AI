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
  const modelPath = path.join(process.env.HOME || "", ".lingxi-ai", "models", "isnet-general-use.onnx");
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
