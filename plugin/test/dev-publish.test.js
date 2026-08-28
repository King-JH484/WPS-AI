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
  pruneAnthonyPublishXml,
  pruneAnthonyAuthAddinState,
  removeWindowsDevPublish,
  sanitizeWindowsPublish,
  windowsPublishHasPluginEntries
} = require("../tools/dev-publish.js");

test("macOS dev publish 保留安装版 anthony-ai-{host} 与其它插件、加 dev 条目、只删旧 dev 条目", () => {
  const existingXml = `<?xml version="1.0" encoding="UTF-8"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-dev-old" type="wps" url="http://127.0.0.1:3891/__anthony_dev_old/" debug="" enable="enable_dev" install="null"/>
</jsplugins>`;

  const xml = buildDevPublishXml(existingXml, {
    addonType: "wps",
    name: "anthony-ai-dev-new",
    port: 3890,
    pathPrefix: "/__anthony_dev_new"
  });

  // 安装版四条（按 host 命名）与其它插件必须保留
  assert.match(xml, /name="other-addon"/);
  assert.match(xml, /name="anthony-ai-wps"/);
  assert.match(xml, /name="anthony-ai-et"/);
  // 新 dev 条目已写入
  assert.match(xml, /name="anthony-ai-dev-new" type="wps" url="http:\/\/127\.0\.0\.1:3890\/__anthony_dev_new\/"/);
  // 旧的 dev 条目（anthony-ai-dev-*）被清掉
  assert.doesNotMatch(xml, /anthony-ai-dev-old/);
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
    name: "anthony-ai-dev-123",
    port: 3889,
    pathPrefix: "/__anthony_dev_123"
  });

  assert.match(xml, /name="anthony-ai-dev-123"/);
  assert.match(xml, /url="http:\/\/127\.0\.0\.1:3889\/__anthony_dev_123\/"/);
});

test("macOS auth cache cleanup removes stale anthony entries and keeps other addins", () => {
  const state = {
    pdf: {
      "anthony-current": {
        name: "anthony-ai",
        path: "http://127.0.0.1:3889",
        md5: "old-main-resource-hash"
      },
      "anthony-old-pdf": {
        name: "anthony-ai-pdf",
        path: "http://127.0.0.1:3889/pdf",
        md5: "old-pdf-resource-hash"
      },
      "anthony-dev-current": {
        name: "anthony-ai-dev-123",
        path: "http://127.0.0.1:3889/__anthony_dev_123",
        md5: "old-dev-resource-hash"
      },
      "other-addon": {
        name: "other-addon",
        path: "http://127.0.0.1:3999",
        md5: "keep"
      },
      namelist: "anthony-current;anthony-old-pdf;anthony-dev-current;other-addon"
    },
    wps: {
      "anthony-old-wps": {
        name: "anthony-ai-wps",
        path: "http://127.0.0.1:3889/wps",
        md5: "old-wps-resource-hash"
      },
      namelist: "anthony-old-wps"
    }
  };

  const cleaned = pruneAnthonyAuthAddinState(state, { name: "anthony-ai", port: 3889 });

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

test("macOS auth cache cleanup removes old anthony entries even when current dev name is unique", () => {
  const state = {
    pdf: {
      "anthony-base": {
        name: "anthony-ai",
        path: "http://127.0.0.1:3889",
        md5: "base"
      },
      "anthony-dev": {
        name: "anthony-ai-dev-abc",
        path: "http://127.0.0.1:3889/__anthony_dev_abc",
        md5: "dev"
      },
      "other-addon": {
        name: "other-addon",
        path: "http://127.0.0.1:3999",
        md5: "keep"
      },
      namelist: "anthony-base;anthony-dev;other-addon"
    }
  };

  const cleaned = pruneAnthonyAuthAddinState(state, { name: "anthony-ai-dev-abc", port: 3889 });

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

test("macOS dev publish cleanup removes stale anthony dev entries and keeps other addins", () => {
  const existingXml = `<?xml version="1.0" encoding="UTF-8"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-dev-old" type="pdf" url="http://127.0.0.1:3889/__anthony_dev_old/" debug="" enable="enable_dev" install="null"/>
  <jspluginonline name="anthony-ai" type="pdf" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
</jsplugins>`;

  const xml = pruneAnthonyPublishXml(existingXml);

  assert.match(xml, /name="other-addon"/);
  assert.doesNotMatch(xml, /anthony-ai/);
  assert.doesNotMatch(xml, /127\.0\.0\.1:3889/);
});

test("macOS dev 退出清理 PRESERVES 安装版 anthony-ai-{host}，只删 dev 条目（回归:退出 dev 不删安装版）", () => {
  const existingXml = `<?xml version="1.0" encoding="UTF-8"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-dev-abc123" type="wps" url="http://127.0.0.1:3890/__anthony_dev_abc123/" debug="" enable="enable_dev" install="null"/>
</jsplugins>`;

  const xml = pruneAnthonyPublishXml(existingXml);

  // 安装版四条 + 其它插件都保留
  assert.match(xml, /name="other-addon"/);
  for (const n of ["anthony-ai-wps", "anthony-ai-et", "anthony-ai-wpp", "anthony-ai-pdf"]) {
    assert.match(xml, new RegExp(`name="${n}"`), `${n} 应被保留`);
  }
  // 只有 dev 条目（anthony-ai-dev-*）被删
  assert.doesNotMatch(xml, /anthony-ai-dev-abc123/);
});

test("Windows publish path lives under %APPDATA%\\kingsoft\\wps\\jsaddons", () => {
  const target = getWindowsPublishPath("C:\\Users\\example\\AppData\\Roaming");
  assert.strictEqual(
    target,
    path.join("C:\\Users\\example\\AppData\\Roaming", "kingsoft", "wps", "jsaddons", "publish.xml")
  );
  assert.strictEqual(getWindowsPublishPath(""), "");
});

test("Windows dev cleanup removes anthony online entries (wpsjs 'anthony-ai' + static fallback 'anthony-ai-dev') and keeps other addins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-win-publish-"));
  const target = path.join(dir, "publish.xml");
  try {
    // 混合 wpsjs debug 写的 anthony-ai 与静态兜底写的 anthony-ai-dev，两者都指向本地 dev 服务
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="other-addon" type="wps" url="http://127.0.0.1:3999/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai" type="wpp" url="http://127.0.0.1:3891/" debug="" enable="enable_dev" install="null"/>
  <jspluginonline name="anthony-ai-dev" type="et" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`, "utf8");

    const removed = removeWindowsDevPublish({ path: target });

    assert.strictEqual(removed, 1);
    const after = fs.readFileSync(target, "utf8");
    assert.match(after, /name="other-addon"/);
    assert.doesNotMatch(after, /anthony-ai/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows dev cleanup is a no-op when publish.xml is missing or has no anthony entry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-win-publish-noop-"));
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

test("Windows dev cleanup DELETES publish.xml when only anthony entries existed (never leaves an empty <jsplugins> shell that poisons wpsjs)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-win-publish-del-"));
  const target = path.join(dir, "publish.xml");
  try {
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="anthony-ai" type="wps" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
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

test("Windows dev cleanup PRESERVES installed anthony-ai-{wps,et,wpp,pdf} entries, removes only the dev anthony-ai/anthony-ai-dev entry (回归:退出 dev 不能删掉安装版)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-win-installed-"));
  const target = path.join(dir, "publish.xml");
  try {
    // 永久安装版的四条（带宿主后缀，serve-permanent 在 3889）+ dev 临时加的 anthony-ai（3891）
    fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="anthony-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-pdf" type="pdf" url="http://127.0.0.1:3889/pdf/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai" type="wps" url="http://127.0.0.1:3891/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`, "utf8");

    const removed = removeWindowsDevPublish({ path: target });

    assert.strictEqual(removed, 1);
    const after = fs.readFileSync(target, "utf8");
    // 安装版四条必须都在
    for (const n of ["anthony-ai-wps", "anthony-ai-et", "anthony-ai-wpp", "anthony-ai-pdf"]) {
      assert.match(after, new RegExp(`name="${n}"`), `${n} 应被保留`);
    }
    // dev 那条（精确 name="anthony-ai" + 3891）必须被删
    assert.doesNotMatch(after, /name="anthony-ai"/);
    assert.doesNotMatch(after, /127\.0\.0\.1:3891/);
    assert.strictEqual(fs.existsSync(target), true, "还有安装版条目，文件不该被删");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows dev cleanup is a no-op when only installed anthony-ai-{host} entries exist (无 dev 条目不动安装版)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-win-installed-only-"));
  const target = path.join(dir, "publish.xml");
  try {
    const installed = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="anthony-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" enable="enable" install="null"/>
  <jspluginonline name="anthony-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  enable="enable" install="null"/>
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anthony-win-sanitize-"));
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
