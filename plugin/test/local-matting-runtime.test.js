const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const localMattingJs = fs.readFileSync(path.join(__dirname, "../js/local-matting.js"), "utf8");
const lazyVendorJs = fs.readFileSync(path.join(__dirname, "../js/lazy-vendor.js"), "utf8");

test("本地抠图在 WebView 不支持 WASM SIMD 时加载 legacy 非 SIMD runtime", () => {
  assert.match(lazyVendorJs, /ortLegacy/);
  assert.match(lazyVendorJs, /js\/vendor\/ort-legacy\/ort\.wasm\.min\.js/);
  assert.match(localMattingJs, /wasmSimdSupported/);
  assert.match(localMattingJs, /ensure\(useLegacy \? "ortLegacy" : "ort"\)/);
  assert.match(localMattingJs, /ORT_ASSET_DIR_LEGACY/);
  assert.match(localMattingJs, /ort-wasm\.wasm/);
  assert.match(localMattingJs, /global\.ort\.env\.wasm\.simd = false/);
});

test("本地抠图在已加载新版 ORT 的非 SIMD WebView 中强制重载 legacy runtime", async () => {
  const loaded = [];
  const window = {
    ort: {
      env: { wasm: {}, versions: { web: "1.19.2" } },
      InferenceSession: { create: async () => ({ inputNames: [], outputNames: [] }) }
    },
    WpsAiRuntime: { proxyBase: () => "http://127.0.0.1:3890" },
    WpsAiLazyVendor: {
      ensure: async (name) => {
        loaded.push(name);
        window.ort = {
          env: { wasm: {}, versions: { web: "1.17.3" } },
          InferenceSession: { create: async () => ({ inputNames: [], outputNames: [] }) }
        };
      }
    }
  };
  const sandbox = {
    window,
    WebAssembly: { validate: () => false },
    fetch: async () => ({
      ok: true,
      headers: { get: () => "" },
      arrayBuffer: async () => new ArrayBuffer(8)
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(localMattingJs, sandbox, { filename: "local-matting.js" });

  await window.WpsAiLocalMatting.ensureSession();

  assert.deepEqual(loaded, ["ortLegacy"]);
  assert.equal(window.WpsAiLocalMattingRuntime.vendor, "ortLegacy");
  assert.equal(window.WpsAiLocalMattingRuntime.simd, false);
  assert.equal(window.WpsAiLocalMattingRuntime.wasmFile, "ort-wasm.wasm");
  assert.equal(window.ort.env.wasm.simd, false);
  assert.match(window.ort.env.wasm.wasmPaths, /\/asset\/js\/vendor\/ort-legacy\/$/);
});

test("WebView 缺少 WebAssembly 时本地抠图通过 proxy 执行 ONNX 推理", () => {
  assert.match(localMattingJs, /function browserWasmSupported\(\)/);
  assert.match(localMattingJs, /localMattingInferUrl\(\)/);
  assert.match(localMattingJs, /\/local-matting-infer/);
  assert.match(localMattingJs, /Float32ArrayToBase64/);
  assert.match(localMattingJs, /base64ToFloat32Array/);
  assert.match(localMattingJs, /inferMask\(chw,\s*onProgress,\s*signal\)/);
  assert.match(localMattingJs, /browserWasmSupported\(\) \? inferMaskInBrowser/);
});
