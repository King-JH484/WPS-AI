const fs = require("fs");
const path = require("path");
const os = require("os");

const publishXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
  <jspluginonline name="lingxi-ai" type="wps" url="http://127.0.0.1:3889/" debug="" enable="enable_dev" install="null"/>
</jsplugins>
`;

const targets = [
  path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml"),
  path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml")
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, publishXml, "utf8");
  console.log(`wrote ${target}`);
}

