const fs = require("fs");
const path = require("path");
const os = require("os");

// NOTE: wpsjs debug（dev 模式）默认跑在 3891；
//       serve-permanent（永久安装）跑在 3889。
//       通过 --port <n> 参数覆盖，默认使用 dev 端口 3891。
const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? process.argv[portArg + 1] : "3891";

const publishXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai" type="wps" url="http://127.0.0.1:${port}/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`;

const targets = [
  path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml"),
  path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml")
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, publishXml, "utf8");
  console.log(`[install-mac-publish] wrote (port=${port}) → ${target}`);
}

