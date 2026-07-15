// 生成 manifest.json（更新检查清单），供 plugin/js/updater.js 拉取使用
//
// 字段对齐 updater.js 注释里描述的形态：
//   version / buildTime / channel / pluginUrl / pluginSize / changelog / minWpsVersion
// 同时追加 downloads，供下载站运行时读取最新安装包 URL / size。
// canary 灰度通道现在不自动生成（要灰度时手动改 OSS 上的 manifest）。

const path = require('path')
const fs = require('fs')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

const DOWNLOAD_KEYS = [
  'windows',
  'mac',
  'linux-deb-x86_64',
  'linux-rpm-x86_64',
  'linux-tar-x86_64',
  'linux-deb-aarch64',
  'linux-rpm-aarch64',
  'linux-tar-aarch64'
]

// 从 CHANGELOG.md 抠出当前版本对应的 section（"## v1.4.0" 到下一个 "## v" 之前）
function extractChangelog(version) {
  const fp = path.join(PROJECT_ROOT, 'CHANGELOG.md')
  if (!fs.existsSync(fp)) return ''
  const raw = fs.readFileSync(fp, 'utf8')
  // 兼容 "## v1.4.0" / "## 1.4.0" 两种写法
  const re = new RegExp(`##\\s+v?${version.replace(/\./g, '\\.')}\\b([\\s\\S]*?)(?=\\n##\\s+v?\\d|$)`, 'i')
  const m = raw.match(re)
  if (!m) return ''
  return m[1].trim().slice(0, 2000) // 截断，避免 manifest 过大
}

function normalizeDownloadEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const url = typeof entry.url === 'string' ? entry.url : ''
  const filename = typeof entry.filename === 'string' ? entry.filename : ''
  const size = Number(entry.size) || 0
  const available = typeof entry.available === 'boolean' ? entry.available : !!url
  if (!url && !filename && !size) return null
  return { filename, url, size, available }
}

function buildDownloads({ urls = {}, sizes = {}, filenames = {}, previous = {} } = {}) {
  const downloads = {}
  const seen = new Set()

  for (const key of DOWNLOAD_KEYS) {
    seen.add(key)
    const prev = normalizeDownloadEntry(previous[key])
    const url = urls[key] || prev?.url || ''
    const filename = filenames[key] || prev?.filename || ''
    const size = Number(sizes[key]) || Number(prev?.size) || 0
    const available = !!url
    if (url || filename || size) downloads[key] = { filename, url, size, available }
  }

  // 保留未来新增但当前脚本还不认识的下载项，避免只发插件热更新时误删。
  for (const [key, value] of Object.entries(previous || {})) {
    if (seen.has(key)) continue
    const normalized = normalizeDownloadEntry(value)
    if (normalized) downloads[key] = normalized
  }

  return downloads
}

function buildManifest({ version, pluginUrl, pluginSize, outDir, changelog, downloads, previousCanary, chromium }) {
  fs.mkdirSync(outDir, { recursive: true })
  const cl = changelog != null ? changelog : extractChangelog(version)
  const manifest = {
    version,
    downloadVersion: version,
    buildTime: Date.now(),
    channel: 'stable',
    pluginUrl,
    pluginSize,
    changelog: cl,
    minWpsVersion: { windows: '12.0', mac: '5.0' },
    downloads: buildDownloads(downloads)
  }
  if (chromium && typeof chromium === 'object' && chromium.version && chromium.platforms) {
    manifest.chromium = chromium
  }
  // 保留 canary 灰度块：之前只在 publish-canary 里维护，stable 发布再重建 manifest
  // 会把 canary 整个吹掉，灰度用户下次探测就拿不到 canary 版本了 —— 已实证 bug。
  // 如果 canary.version <= 新 stable version，说明这次 stable 已经涵盖了 canary
  // 的改动，canary 块也没必要留了；其它情况一律带上。
  if (previousCanary && previousCanary.version) {
    // 若 canary 版本已经 <= stable 新版本，视为"canary 已落到 stable"，不再挂
    const cmp = String(previousCanary.version).localeCompare(String(version), undefined, { numeric: true, sensitivity: 'base' })
    if (cmp > 0) {
      manifest.canary = previousCanary
    }
  }
  const outPath = path.resolve(outDir, 'manifest.json')
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { manifestPath: outPath, manifest }
}

module.exports = { buildManifest, extractChangelog, buildDownloads, DOWNLOAD_KEYS }
