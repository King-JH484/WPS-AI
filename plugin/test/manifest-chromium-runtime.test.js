const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildManifest } = require("../../upload-oss/lib/build-manifest.js");

test("manifest 保留 Chromium runtime 下载配置，供客户端按需从 OSS 下载", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-manifest-"));
  const chromium = {
    version: "chromium-120",
    platforms: {
      "darwin-arm64": {
        url: "https://oss.example/chromium/darwin-arm64.zip",
        sha256: "a".repeat(64),
        executablePath: "chrome-mac/Chromium.app/Contents/MacOS/Chromium"
      }
    }
  };

  const { manifest } = buildManifest({
    version: "1.4.4",
    pluginUrl: "https://oss.example/plugin.zip",
    pluginSize: 1,
    outDir,
    chromium
  });

  assert.deepEqual(manifest.chromium, chromium);
});
