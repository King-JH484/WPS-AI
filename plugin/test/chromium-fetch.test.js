const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildChromiumImageHeaders,
  buildBrowserCandidates,
  isTargetImageUrl,
  pickChromiumRuntimeSpec,
  platformKey,
  resolveBrowserExecutable
} = require("../tools/chromium-fetch.js");

test("Chromium 兜底：平台 key 与 OSS runtime manifest 对齐", () => {
  assert.equal(platformKey({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(platformKey({ platform: "darwin", arch: "x64" }), "darwin-x64");
  assert.equal(platformKey({ platform: "win32", arch: "x64" }), "win-x64");
  assert.equal(platformKey({ platform: "linux", arch: "arm64" }), "linux-arm64");
});

test("Chromium 兜底：优先使用本机 Chrome / Chromium / Edge", () => {
  const candidates = buildBrowserCandidates({
    platform: "darwin",
    env: {},
    homeDir: "/Users/u"
  });

  const labels = candidates.map((item) => item.label);
  assert.deepEqual(labels.slice(0, 3), ["Google Chrome", "Chromium", "Microsoft Edge"]);
});

test("Chromium 兜底：本机浏览器优先于已下载 runtime", async () => {
  const existing = new Set([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/u/.anthony-ai/browser/chromium/test/darwin-arm64/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
  ]);

  const resolved = await resolveBrowserExecutable({
    platform: "darwin",
    arch: "arm64",
    homeDir: "/Users/u",
    runtimeRoot: "/Users/u/.anthony-ai/browser/chromium",
    fsExists: (p) => existing.has(p),
    disableDownload: true,
    runtimeManifest: {
      version: "test",
      platforms: {
        "darwin-arm64": {
          url: "https://oss.example/chromium.zip",
          sha256: "",
          executablePath: "chrome-mac/Chromium.app/Contents/MacOS/Chromium"
        }
      }
    }
  });

  assert.equal(resolved.source, "system");
  assert.equal(resolved.executablePath, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("Chromium 兜底：没有系统浏览器时使用本地已下载 runtime", async () => {
  const runtimeExe = "/Users/u/.anthony-ai/browser/chromium/test/darwin-arm64/chrome-mac/Chromium.app/Contents/MacOS/Chromium";
  const existing = new Set([runtimeExe]);

  const resolved = await resolveBrowserExecutable({
    platform: "darwin",
    arch: "arm64",
    homeDir: "/Users/u",
    runtimeRoot: "/Users/u/.anthony-ai/browser/chromium",
    fsExists: (p) => existing.has(p),
    disableDownload: true,
    runtimeManifest: {
      version: "test",
      platforms: {
        "darwin-arm64": {
          url: "https://oss.example/chromium.zip",
          sha256: "",
          executablePath: "chrome-mac/Chromium.app/Contents/MacOS/Chromium"
        }
      }
    }
  });

  assert.equal(resolved.source, "cached");
  assert.equal(resolved.executablePath, runtimeExe);
});

test("Chromium 兜底：支持从 manifest 中选择当前平台下载项", () => {
  const spec = pickChromiumRuntimeSpec({
    chromium: {
      version: "120",
      platforms: {
        "linux-x64": { url: "https://oss.example/linux.tar.xz", sha256: "a", executablePath: "chrome" }
      }
    }
  }, "linux-x64");

  assert.deepEqual(spec, {
    version: "120",
    platform: "linux-x64",
    url: "https://oss.example/linux.tar.xz",
    sha256: "a",
    executablePath: "chrome"
  });
});

test("Chromium 兜底：生产代理实际接入浏览器抓图兜底", () => {
  const proxyJs = fs.readFileSync(path.join(__dirname, "../tools/proxy-server.js"), "utf8");

  assert.match(proxyJs, /require\("\.\/chromium-fetch"\)/);
  assert.match(proxyJs, /fetchImageWithChromium\(/);
  assert.match(proxyJs, /shouldUseChromiumFallback\(/);
});

test("Chromium 兜底：CDP 请求头不强行覆盖 Sec-Fetch 系列", () => {
  const headers = buildChromiumImageHeaders(
    "https://static.www.tencent.com/uploads/demo.jpg",
    { referer: "https://www.tencent.com/" }
  );

  assert.equal(headers.Referer, "https://www.tencent.com/");
  assert.match(headers.Accept, /image\/webp/);
  assert.equal(Object.hasOwn(headers, "Sec-Fetch-Dest"), false);
  assert.equal(Object.hasOwn(headers, "Sec-Fetch-Mode"), false);
  assert.equal(Object.hasOwn(headers, "Sec-Fetch-Site"), false);
});

test("Chromium 兜底：响应 URL 可按同源路径关联目标图片请求", () => {
  assert.equal(
    isTargetImageUrl(
      "https://static.www.tencent.com/uploads/demo.jpg?imageMogr2/format/webp",
      "https://static.www.tencent.com/uploads/demo.jpg"
    ),
    true
  );
  assert.equal(
    isTargetImageUrl(
      "https://static.www.tencent.com/uploads/other.jpg",
      "https://static.www.tencent.com/uploads/demo.jpg"
    ),
    false
  );
});
