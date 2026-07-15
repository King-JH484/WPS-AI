const fs = require("fs");
const path = require("path");
const os = require("os");

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getMacJsaddonsDirs(home = os.homedir()) {
  return [
    path.join(home, "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons"),
    path.join(home, "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons")
  ];
}

function getMacPublishPaths(home = os.homedir()) {
  return getMacJsaddonsDirs(home).map((dir) => path.join(dir, "publish.xml"));
}

function getMacAuthAddinPaths(home = os.homedir()) {
  return getMacJsaddonsDirs(home).map((dir) => path.join(dir, "authaddin.json"));
}

function normalizePathPrefix(pathPrefix) {
  const raw = String(pathPrefix || "").trim();
  if (!raw || raw === "/") return "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return `${prefixed.replace(/\/+$/, "")}/`;
}

function buildDevPublishXml(existingXml, options) {
  const addonType = options.addonType || "wps";
  const name = options.name || "lingxi-ai";
  const port = options.port || 3889;
  const urlPath = normalizePathPrefix(options.pathPrefix);
  const entry = `  <jspluginonline name="${escapeXml(name)}" type="${escapeXml(addonType)}" url="http://127.0.0.1:${escapeXml(port)}${escapeXml(urlPath)}" debug="" enable="enable_dev" install="null"/>`;
  const others = getNonLingxiPublishLines(existingXml);

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<jsplugins>',
    ...others,
    entry,
    '</jsplugins>',
    ''
  ].join("\n");
}

function getNonLingxiPublishLines(existingXml) {
  return String(existingXml || "")
    .split(/\r?\n/)
    .filter((line) => /jspluginonline/i.test(line) && !/lingxi-ai/i.test(line));
}

function pruneLingxiPublishXml(existingXml) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<jsplugins>',
    ...getNonLingxiPublishLines(existingXml),
    '</jsplugins>',
    ''
  ].join("\n");
}

function writeMacDevPublish(options) {
  const paths = options.paths || getMacPublishPaths(options.home);
  let count = 0;
  for (const target of paths) {
    try {
      let existingXml = "";
      if (fs.existsSync(target)) existingXml = fs.readFileSync(target, "utf8");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buildDevPublishXml(existingXml, options), "utf8");
      count += 1;
    } catch (error) {
      // Some WPS containers may not exist or may be temporarily locked.
    }
  }
  return count;
}

function removeMacDevPublish(options = {}) {
  const paths = options.paths || getMacPublishPaths(options.home);
  let count = 0;
  for (const target of paths) {
    try {
      if (!fs.existsSync(target)) continue;
      const existingXml = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, pruneLingxiPublishXml(existingXml), "utf8");
      count += 1;
    } catch (error) {
      // publish.xml 是 WPS 共享文件；退出 dev 时尽力清理，失败不阻塞进程退出。
    }
  }
  return count;
}

function isLingxiAuthEntry(entry, options) {
  if (!entry || typeof entry !== "object") return false;
  const entryName = String(entry.name || "");
  if (/^lingxi-ai(?:-|$)/.test(entryName)) return true;

  const name = options.name || "";
  return Boolean(name && (entryName === name || entryName.startsWith(`${name}-`)));
}

function pruneLingxiAuthAddinState(state, options = {}) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;

  const cleaned = {};
  for (const [host, hostState] of Object.entries(state)) {
    if (!hostState || typeof hostState !== "object" || Array.isArray(hostState)) {
      cleaned[host] = hostState;
      continue;
    }

    const nextHostState = {};
    const removedIds = new Set();
    for (const [id, value] of Object.entries(hostState)) {
      if (id === "namelist") continue;
      if (isLingxiAuthEntry(value, options)) {
        removedIds.add(id);
        continue;
      }
      nextHostState[id] = value;
    }

    if (Object.prototype.hasOwnProperty.call(hostState, "namelist")) {
      nextHostState.namelist = String(hostState.namelist || "")
        .split(";")
        .filter((id) => id && !removedIds.has(id) && Object.prototype.hasOwnProperty.call(nextHostState, id))
        .join(";");
    }
    cleaned[host] = nextHostState;
  }
  return cleaned;
}

function countLingxiAuthEntries(state, options) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return 0;
  let count = 0;
  for (const hostState of Object.values(state)) {
    if (!hostState || typeof hostState !== "object" || Array.isArray(hostState)) continue;
    for (const [id, value] of Object.entries(hostState)) {
      if (id !== "namelist" && isLingxiAuthEntry(value, options)) count += 1;
    }
  }
  return count;
}

function writeBackupOnce(target, raw) {
  const backup = `${target}.bak.lingxi-dev`;
  if (fs.existsSync(backup)) return;
  fs.writeFileSync(backup, raw, "utf8");
}

function cleanMacAuthCache(options = {}) {
  const paths = options.paths || getMacAuthAddinPaths(options.home);
  let files = 0;
  let entries = 0;

  for (const target of paths) {
    try {
      if (!fs.existsSync(target)) continue;
      const raw = fs.readFileSync(target, "utf8");
      const state = JSON.parse(raw);
      const removed = countLingxiAuthEntries(state, options);
      if (!removed) continue;
      const cleaned = pruneLingxiAuthAddinState(state, options);
      writeBackupOnce(target, raw);
      fs.writeFileSync(target, `${JSON.stringify(cleaned, null, 4)}\n`, "utf8");
      files += 1;
      entries += removed;
    } catch (error) {
      // authaddin.json 是 WPS 自己维护的缓存；解析失败或被锁定时跳过，避免影响 dev 启动。
    }
  }

  return { files, entries };
}

module.exports = {
  buildDevPublishXml,
  cleanMacAuthCache,
  getMacAuthAddinPaths,
  getMacPublishPaths,
  pruneLingxiPublishXml,
  pruneLingxiAuthAddinState,
  removeMacDevPublish,
  writeMacDevPublish
};
