// 灵犀AI 插件热更新
//
// 流程：
//   1. checkForUpdate() —— 走 proxy 拉 manifest（避开 OSS CORS）
//   2. 比较当前版本 vs 远端版本（semver）
//   3. 若新版可用 → 调用方决定是否 downloadUpdate + applyUpdate
//   4. applyUpdate 让 proxy 把 plugin.zip 解压到当前插件目录覆盖文件
//   5. 提示用户重启 WPS（WebView 不能 reload JS module 已加载的代码）
//
// manifest.json 形态（OSS 上）：
// {
//   "version": "1.4.0",
//   "buildTime": 1735000000000,
//   "channel": "stable",
//   "pluginUrl": "https://cdn.lingxi-ai.com/wps-ai/plugin/1.4.0/plugin.zip",
//   "pluginSize": 12345678,
//   "changelog": "fix: ...\nfeat: ...",
//   "minWpsVersion": { "windows": "12.0", "mac": "5.0" }
// }
(function attachUpdater(global) {
  "use strict";

  // manifest 默认拉取地址（用户也可以在设置里覆盖到自建 mirror / 内网部署）
  const DEFAULT_MANIFEST_URL = "https://llteac-file.oss-cn-hangzhou.aliyuncs.com/wps-ai/manifest.json";
  const PROXY_BASE = "http://127.0.0.1:3890";
  // 本地缓存最近一次检查结果（避免 30 分钟内反复打 OSS）
  const LAST_CHECK_KEY = "lingxi_updater_last_check_v1";
  const CHECK_COOLDOWN_MS = 30 * 60 * 1000; // 30 分钟

  function readCurrentVersion() {
    return new Promise((resolve) => {
      fetch("./package.json", { cache: "no-cache" })
        .then((r) => r.ok ? r.json() : null)
        .then((pkg) => resolve(pkg?.version || "0.0.0"))
        .catch(() => resolve("0.0.0"));
    });
  }

  // 简易 semver 比较：a > b → 正数；a == b → 0；a < b → 负数
  // 只比 major.minor.patch，忽略 prerelease / build metadata
  function compareVersions(a, b) {
    const pa = String(a || "0").split(/[.\-+]/).map((x) => parseInt(x, 10));
    const pb = String(b || "0").split(/[.\-+]/).map((x) => parseInt(x, 10));
    for (let i = 0; i < 3; i++) {
      const ai = isNaN(pa[i]) ? 0 : pa[i];
      const bi = isNaN(pb[i]) ? 0 : pb[i];
      if (ai !== bi) return ai - bi;
    }
    return 0;
  }

  // 拉 manifest. 走 proxy 的 /update/manifest 端点(代理转发 + 缓存 5min),
  // 直接打 OSS 也行,但 WebView 跨域可能拦.
  async function fetchManifest(manifestUrl) {
    const url = manifestUrl || DEFAULT_MANIFEST_URL;
    try {
      const resp = await fetch(`${PROXY_BASE}/update/manifest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const json = await resp.json();
      if (!json?.ok) throw new Error(json?.error || "manifest 拉取失败");
      return json.manifest;
    } catch (e) {
      throw new Error(`无法获取版本信息: ${e?.message || e}`);
    }
  }

  async function checkForUpdate(opts) {
    const manifestUrl = opts?.manifestUrl;
    const force = !!opts?.force;
    // 冷却期短路：30min 内有缓存且非强制 → 直接返回缓存
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(LAST_CHECK_KEY) || "null");
        if (cached && Date.now() - cached.ts < CHECK_COOLDOWN_MS) {
          return cached.result;
        }
      } catch (e) {}
    }
    const current = await readCurrentVersion();
    const manifest = await fetchManifest(manifestUrl);
    const latest = manifest?.version || "0.0.0";
    const diff = compareVersions(latest, current);
    const result = {
      current,
      latest,
      updateAvailable: diff > 0,
      checkedAt: Date.now(),
      manifest
    };
    try {
      localStorage.setItem(LAST_CHECK_KEY, JSON.stringify({ ts: Date.now(), result }));
    } catch (e) {}
    return result;
  }

  // 下载 + 解压更新。返回 { ok, restartRequired, message } 让 UI 提示用户重启 WPS。
  async function downloadAndApply(manifest, onProgress) {
    if (!manifest?.pluginUrl) throw new Error("manifest 缺 pluginUrl");
    if (typeof onProgress === "function") onProgress({ step: "download", percent: 0 });
    // 1) proxy 下载 plugin.zip
    let downloadResp;
    try {
      downloadResp = await fetch(`${PROXY_BASE}/update/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: manifest.pluginUrl, expectedSize: manifest.pluginSize || null })
      });
    } catch (e) {
      throw new Error(`下载失败：${e?.message || e}`);
    }
    if (!downloadResp.ok) {
      const text = await downloadResp.text().catch(() => "");
      throw new Error(`下载失败 ${downloadResp.status}: ${text.slice(0, 200)}`);
    }
    const dl = await downloadResp.json();
    if (!dl?.ok || !dl?.zipPath) throw new Error(dl?.error || "下载未返回 zipPath");
    if (typeof onProgress === "function") onProgress({ step: "extract", percent: 50 });

    // 2) proxy 解压覆盖 plugin 目录
    const applyResp = await fetch(`${PROXY_BASE}/update/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zipPath: dl.zipPath })
    });
    const ap = await applyResp.json().catch(() => ({}));
    if (!applyResp.ok || !ap?.ok) {
      throw new Error(ap?.error || `apply 失败 ${applyResp.status}`);
    }
    if (typeof onProgress === "function") onProgress({ step: "done", percent: 100 });
    return {
      ok: true,
      restartRequired: true,
      message: ap?.message || "更新已安装，请重启 WPS 让新版本生效。",
      filesReplaced: ap?.filesReplaced || 0
    };
  }

  function getLastCheck() {
    try {
      return JSON.parse(localStorage.getItem(LAST_CHECK_KEY) || "null");
    } catch (e) { return null; }
  }

  function clearCache() {
    try { localStorage.removeItem(LAST_CHECK_KEY); } catch (e) {}
  }

  global.WpsAiUpdater = {
    readCurrentVersion,
    checkForUpdate,
    downloadAndApply,
    compareVersions,
    getLastCheck,
    clearCache,
    DEFAULT_MANIFEST_URL,
    CHECK_COOLDOWN_MS
  };
})(window);
