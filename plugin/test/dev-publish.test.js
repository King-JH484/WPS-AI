const test = require("node:test");
const assert = require("node:assert");

const {
  buildDevPublishXml,
  getMacAuthAddinPaths,
  getMacPublishPaths,
  pruneLingxiPublishXml,
  pruneLingxiAuthAddinState
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
