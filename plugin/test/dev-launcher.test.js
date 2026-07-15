const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const devJs = fs.readFileSync(path.join(__dirname, "../tools/dev.js"), "utf8");
const staticServerJs = fs.readFileSync(path.join(__dirname, "../tools/dev-static-server.js"), "utf8");

test("macOS dev uses the local static server instead of wpsjs hot-update server", () => {
  assert.match(devJs, /const\s+useOwnStaticServer\s*=\s*isLinux\s*\|\|\s*isMac/);
  assert.match(devJs, /useOwnStaticServer\s*\?\s*spawnLabeled\(\s*[\r\n\s]*"static"/);
  assert.match(devJs, /tools\/dev-static-server\.js/);
});

test("macOS dev publishes a unique static path and passes it to the static server", () => {
  assert.match(devJs, /createDevPathPrefix\(\)/);
  assert.match(devJs, /createDevAddonName\(devPathPrefix\)/);
  assert.match(devJs, /name:\s*devAddonName/);
  assert.match(devJs, /pathPrefix:\s*devPathPrefix/);
  assert.match(devJs, /LINGXI_DEV_PATH_PREFIX:\s*devPathPrefix/);
  assert.match(devJs, /LINGXI_DEV_ROOT:\s*macDevSnapshotRoot/);
});

test("macOS dev waits until the static server is healthy before writing publish.xml", () => {
  const proxyIndex = devJs.indexOf("const proxy = spawnLabeled");
  assert.notEqual(proxyIndex, -1);
  assert.doesNotMatch(devJs.slice(0, proxyIndex), /^\s*writeMacDebugPublish\(cwd,\s*devPathPrefix\);/m);
  assert.match(devJs, /waitForStaticServer\(STATIC_PORT,\s*devPathPrefix\)[\s\S]*^\s*writeMacDebugPublish\(cwd,\s*devPathPrefix,\s*devAddonName,\s*staticPort\);/m);
  assert.match(devJs, /cleanMacAuthCache[\s\S]*writeMacDevPublish/);
});

test("macOS dev uses the resolved static port after the listen ladder switches away from 3889", () => {
  assert.match(devJs, /const\s+staticHealth\s*=\s*await\s+waitForStaticServer\(STATIC_PORT,\s*devPathPrefix\)/);
  assert.match(devJs, /const\s+staticPort\s*=\s*Number\(staticHealth\?\.port\)\s*\|\|\s*STATIC_PORT/);
  assert.match(devJs, /writeMacDebugPublish\(cwd,\s*devPathPrefix,\s*devAddonName,\s*staticPort\)/);
  assert.match(devJs, /removeMacDevPublish\(\{\s*name:\s*devAddonName,\s*port:\s*resolvedStaticPort\s*\}\)/);
});

test("dev passes the selected proxy port to both proxy and static server", () => {
  assert.match(devJs, /spawnLabeled\(\s*[\r\n\s]*"proxy"[\s\S]*\{\s*PROXY_PORT:\s*String\(devPorts\.proxyPort\)\s*\}/);
  assert.match(devJs, /LINGXI_PROXY_PORT:\s*String\(devPorts\.proxyPort\)/);
});

test("macOS dev wakes WPS after writing publish.xml", () => {
  assert.match(devJs, /function launchMacWpsHost/);
  assert.match(devJs, /open/);
  assert.match(devJs, /\/Applications\/wpsoffice\.app/);
  assert.match(devJs, /writeMacDebugPublish\(cwd,\s*devPathPrefix,\s*devAddonName,\s*staticPort\)[\s\S]*launchMacWpsHost\(cwd\)/);
});

test("macOS dev forces a fresh WPS app instance so the new publish.xml is reloaded", () => {
  assert.match(devJs, /spawn\("open",\s*\["-na",\s*appPath\]/);
});

test("macOS dev removes temporary publish entries on shutdown", () => {
  assert.match(devJs, /removeMacDevPublish/);
  assert.match(devJs, /function cleanupMacDebugPublish/);
  assert.match(devJs, /cleanupMacDebugPublish\(\)[\s\S]*for \(const child of \[proxy,\s*hostServer/);
});

test("macOS dev serves a per-run snapshot root and cleans it on shutdown", () => {
  assert.match(devJs, /function createMacDevSnapshotRoot/);
  assert.match(devJs, /const macDevSnapshotRoot = isMac \? createMacDevSnapshotRoot\(cwd, devPathPrefix\) : ""/);
  assert.match(devJs, /function cleanupMacDevSnapshotRoot/);
  assert.match(devJs, /cleanupMacDevSnapshotRoot\(\)/);
});

test("static server strips the dev path prefix before resolving files", () => {
  assert.match(staticServerJs, /LINGXI_DEV_PATH_PREFIX/);
  assert.match(staticServerJs, /stripDevPathPrefix/);
  assert.match(staticServerJs, /safePath\(stripDevPathPrefix\(parsed\.pathname/);
});
