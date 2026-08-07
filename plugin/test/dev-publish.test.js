const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildDevPublishXml,
  getMacAuthAddinPaths,
  getMacPublishPaths,
  getWindowsPublishPath,
  pruneLingxiPublishXml,
  pruneLingxiAuthAddinState,
  removeWindowsDevPublish,
  sanitizeWindowsPublish,
  windowsPublishHasPluginEntries
} = require("../tools/dev-publish.js");

test("macOS dev publish uses root debug URL and removes stale lingxi host URLs", () => {
  const existingXml = `<?xml version="1.0" encoding="UTF-8"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline install="null" url="http://127.0.0.1:3889/wps/" enable="enable_dev" name="lingxi-ai-wps" type="wps"/>
  <jspluginonline install="null" url="http://127.0.0.1:3889/et/" enable="enable_dev" name="lingxi-ai-et" type="et"/>
</jsplugins>`;

  const xml = buildDevPublishXml(existingXml, {
    addonType: "wps",
    name: "lingxi-ai",
    port: 3889
  });

  assert.match(xml, /name="other-addon"/);
  assert.match(xml, /<jspluginonline name="lingxi-ai" type="wps" url="http:\/\/127\.0\.0\.1:3889\/" debug="" enable="enable_dev" install="null"\/>/);
  assert.doesNotMatch(xml, /127\.0\.0\.1:3889\/wps\//);
  assert.doesNotMatch(xml, /lingxi-ai-et/);
});

test("macOS dev publish targets both WPS container variants", () => {
  const paths = getMacPublishPaths("/Users/example");

  assert.deepStrictEqual(paths, [
    "/Users/example/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml",
    "/Users/example/Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml"
  ]);
});

test("macOS dev publish can use a unique path prefix to avoid stale main-resource verification", () => {
  const xml = buildDevPublishXml("", {
    addonType: "pdf",
    name: "lingxi-ai-dev-123",
    port: 3889,
    pathPrefix: "/__lingxi_dev_123"
  });

  assert.match(xml, /name="lingxi-ai-dev-123"/);
  assert.match(xml, /url="http:\/\/127\.0\.0\.1:3889\/__lingxi_dev_123\/"/);
});

test("macOS auth cache cleanup removes stale lingxi entries and keeps other addins", () => {
  const state = {
    pdf: {
      "lingxi-current": {
        name: "lingxi-ai",
        path: "http://127.0.0.1:3889",
        md5: "old-main-resource-hash"
      },
      "lingxi-old-pdf": {
        name: "lingxi-ai-pdf",
        path: "http://127.0.0.1:3889/pdf",
        md5: "old-pdf-resource-hash"
      },
      "lingxi-dev-current": {
        name: "lingxi-ai-dev-123",
        path: "http://127.0.0.1:3889/__lingxi_dev_123",
        md5: "old-dev-resource-hash"
      },
      "other-addon": {
        name: "other-addon",
        path: "http://127.0.0.1:3999",
        md5: "keep"
      },
      namelist: "lingxi-current;lingxi-old-pdf;lingxi-dev-current;other-addon"
    },
    wps: {
      "lingxi-old-wps": {
        name: "lingxi-ai-wps",
        path: "http://127.0.0.1:3889/wps",
        md5: "old-wps-resource-hash"
      },
      namelist: "lingxi-old-wps"
    }
  };

  const cleaned = pruneLingxiAuthAddinState(state, { name: "lingxi-ai", port: 3889 });

  assert.deepStrictEqual(cleaned.pdf, {
    "other-addon": {
      name: "other-addon",
      path: "http://127.0.0.1:3999",
      md5: "keep"
    },
    namelist: "other-addon"
  });
  assert.deepStrictEqual(cleaned.wps, { namelist: "" });
});

test("macOS auth cache cleanup removes old lingxi entries even when current dev name is unique", () => {
  const state = {
    pdf: {
      "lingxi-base": {
        name: "lingxi-ai",
        path: "http://127.0.0.1:3889",
        md5: "base"
      },
      "lingxi-dev": {
        name: "lingxi-ai-dev-abc",
        path: "http://127.0.0.1:3889/__lingxi_dev_abc",
        md5: "dev"
      },
      "other-addon": {
        name: "other-addon",
        path: "http://127.0.0.1:3999",
        md5: "keep"
      },
      namelist: "lingxi-base;lingxi-dev;other-addon"
    }
  };

  const cleaned = pruneLingxiAuthAddinState(state, { name: "lingxi-ai-dev-abc", port: 3889 });

  assert.deepStrictEqual(cleaned.pdf, {
    "other-addon": {
      name: "other-addon",
      path: "http://127.0.0.1:3999",
      md5: "keep"
    },
    namelist: "other-addon"
  });
});

test("macOS auth cache cleanup targets both WPS container variants", () => {
  const paths = getMacAuthAddinPaths("/Users/example");

  assert.deepStrictEqual(paths, [
    "/Users/example/Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/authaddin.json",
    "/Users/example/Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/authaddin.json"
  ]);
});

test("macOS dev publish cleanup removes stale lingxi dev entries and keeps other addins", () => {
  const existingXml = `<?xml version="1.0" encoding="UTF-8"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-dev-old" type="pdf" url="http://127.0.0.1:3889/__lingxi_dev_old/" debug="" enable="enable_dev" install="null"/>
  <jspluginonline name="lingxi-ai" type="pdf" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
</jsplugins>`;

  const xml = pruneLingxiPublishXml(existingXml);

  assert.match(xml, /name="other-addon"/);
  assert.doesNotMatch(xml, /lingxi-ai/);
  assert.doesNotMatch(xml, /127\.0\.0\.1:3889/);
});

test("Windows publish path lives under %APPDATA%\\kingsoft\\wps\\jsaddons", () => {
  const target = getWindowsPublishPath("C:\\Users\\example\\AppData\\Roaming");
  assert.strictEqual(
    target,
    path.join("C:\\Users\\example\\AppData\\Roaming", "kingsoft", "wps", "jsaddons", "publish.xml")
  );
  assert.strictEqual(getWindowsPublishPath(""), "");
});

test("Windows dev cleanup removes lingxi online entries (wpsjs 'lingxi-ai' + static fallback 'lingxi-ai-dev') and keeps other addins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-win-publish-"));
  const target = path.join(dir, "publish.xml");
  try {
    // 混合 wpsjs debug 写的 lingxi-ai 与静态兜底写的 lingxi-ai-dev，两者都指向本地 dev 服务
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai" type="wpp" url="http://127.0.0.1:3891/" debug="" enable="enable_dev" install="null"/>
  <jspluginonline name="lingxi-ai-dev" type="et" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`, "utf8");

    const removed = removeWindowsDevPublish({ path: target });

    assert.strictEqual(removed, 1);
    const after = fs.readFileSync(target, "utf8");
    assert.match(after, /name="other-addon"/);
    assert.doesNotMatch(after, /lingxi-ai/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows dev cleanup is a no-op when publish.xml is missing or has no lingxi entry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-win-publish-noop-"));
  const target = path.join(dir, "publish.xml");
  try {
    assert.strictEqual(removeWindowsDevPublish({ path: target }), 0);

    const untouched = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
</jsplugins>
`;
    fs.writeFileSync(target, untouched, "utf8");
    assert.strictEqual(removeWindowsDevPublish({ path: target }), 0);
    assert.strictEqual(fs.readFileSync(target, "utf8"), untouched);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows dev cleanup DELETES publish.xml when only lingxi entries existed (never leaves an empty <jsplugins> shell that poisons wpsjs)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-win-publish-del-"));
  const target = path.join(dir, "publish.xml");
  try {
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai" type="wps" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`, "utf8");

    const removed = removeWindowsDevPublish({ path: target });

    assert.strictEqual(removed, 1);
    // 关键：文件被删掉，而不是写成 <jsplugins></jsplugins>（后者会让 wpsjs 每次启动写空、丢注册）
    assert.strictEqual(fs.existsSync(target), false, "publish.xml 应被删除而非留空壳");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows dev cleanup PRESERVES installed lingxi-ai-{wps,et,wpp,pdf} entries, removes only the dev lingxi-ai/lingxi-ai-dev entry (回归:退出 dev 不能删掉安装版)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-win-installed-"));
  const target = path.join(dir, "publish.xml");
  try {
    // 永久安装版的四条（带宿主后缀，serve-permanent 在 3889）+ dev 临时加的 lingxi-ai（3891）
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai" type="wps" url="http://127.0.0.1:3891/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`, "utf8");

    const removed = removeWindowsDevPublish({ path: target });

    assert.strictEqual(removed, 1);
    const after = fs.readFileSync(target, "utf8");
    // 安装版四条必须都在
    for (const n of ["lingxi-ai-wps", "lingxi-ai-et", "lingxi-ai-wpp", "lingxi-ai-pdf"]) {
      assert.match(after, new RegExp(`name="${n}"`), `${n} 应被保留`);
    }
    // dev 那条（精确 name="lingxi-ai" + 3891）必须被删
    assert.doesNotMatch(after, /name="lingxi-ai"/);
    assert.doesNotMatch(after, /127\.0\.0\.1:3891/);
    assert.strictEqual(fs.existsSync(target), true, "还有安装版条目，文件不该被删");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows dev cleanup is a no-op when only installed lingxi-ai-{host} entries exist (无 dev 条目不动安装版)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-win-installed-only-"));
  const target = path.join(dir, "publish.xml");
  try {
    const installed = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
</jsplugins>
`;
    fs.writeFileSync(target, installed, "utf8");
    assert.strictEqual(removeWindowsDevPublish({ path: target }), 0);
    assert.strictEqual(fs.readFileSync(target, "utf8"), installed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("windowsPublishHasPluginEntries: 空壳判为无条目、有 <jsplugin(online)> 判为有条目", () => {
  assert.strictEqual(windowsPublishHasPluginEntries("<jsplugins></jsplugins>"), false);
  assert.strictEqual(windowsPublishHasPluginEntries("<jsplugins>\n</jsplugins>\n"), false);
  assert.strictEqual(windowsPublishHasPluginEntries(""), false);
  assert.strictEqual(windowsPublishHasPluginEntries('<jsplugins>\n  <jspluginonline name="x"/>\n</jsplugins>'), true);
  assert.strictEqual(windowsPublishHasPluginEntries('<jsplugins>\n  <jsplugin name="offline" install="1"/>\n</jsplugins>'), true);
});

test("sanitizeWindowsPublish 删掉空壳/带换行空的毒文件，保留有条目的文件，缺文件时 no-op", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-win-sanitize-"));
  const target = path.join(dir, "publish.xml");
  try {
    // 缺文件 → no-op
    assert.strictEqual(sanitizeWindowsPublish({ path: target }), false);

    // 带换行的空壳（正是拖垮 wpsjs 的毒文件）→ 删除
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
</jsplugins>
`, "utf8");
    assert.strictEqual(sanitizeWindowsPublish({ path: target }), true);
    assert.strictEqual(fs.existsSync(target), false);

    // 有真实条目 → 保留不动
    const kept = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
</jsplugins>
`;
    fs.writeFileSync(target, kept, "utf8");
    assert.strictEqual(sanitizeWindowsPublish({ path: target }), false);
    assert.strictEqual(fs.readFileSync(target, "utf8"), kept);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
