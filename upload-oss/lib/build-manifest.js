// 生成 manifest.json（更新检查清单），供 plugin/js/updater.js 拉取使用
//
// 字段对齐 updater.js 注释里描述的形态：
//   version / buildTime / channel / pluginUrl / pluginSize / changelog / minWpsVersion
// canary 灰度通道现在不自动生成（要灰度时手动改 OSS 上的 manifest）。

const path = require('path')
const fs = require('fs')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

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

function buildManifest({ version, pluginUrl, pluginSize, outDir, changelog }) {
  fs.mkdirSync(outDir, { recursive: true })
  const cl = changelog != null ? changelog : extractChangelog(version)
  const manifest = {
    version,
    buildTime: Date.now(),
    channel: 'stable',
    pluginUrl,
    pluginSize,
    changelog: cl,
    minWpsVersion: { windows: '12.0', mac: '5.0' }
    // canary 字段不写：上传后用户在 OSS 控制台/单独脚本里加
  }
  const outPath = path.resolve(outDir, 'manifest.json')
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { manifestPath: outPath, manifest }
}

module.exports = { buildManifest, extractChangelog }
