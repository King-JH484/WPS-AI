const path = require('path')
const fs = require('fs')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

// 默认产物目录 + 文件名匹配规则。允许通过 CLI 传文件直接覆盖。
const RULES = [
  {
    platform: 'windows',
    dir: path.join(PROJECT_ROOT, 'installer', 'dist'),
    match: /-setup\.exe$/i
  },
  {
    platform: 'mac',
    dir: path.join(PROJECT_ROOT, 'installer-mac', 'dist'),
    // 优先 pkg（默认下载推荐），dmg 作为附加
    match: /\.(pkg|dmg)$/i,
    prefer: /\.pkg$/i
  }
]

function classifyByName(filename) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.exe')) return 'windows'
  if (lower.endsWith('.pkg') || lower.endsWith('.dmg')) return 'mac'
  return null
}

function discoverArtifacts() {
  const artifacts = []
  for (const rule of RULES) {
    if (!fs.existsSync(rule.dir)) continue
    const all = fs.readdirSync(rule.dir).filter((f) => rule.match.test(f))
    if (all.length === 0) continue

    // 同时上传所有命中文件，但 prefer 的那个作为"主链接"
    const sorted = rule.prefer
      ? all.sort((a, b) => (rule.prefer.test(b) ? 1 : 0) - (rule.prefer.test(a) ? 1 : 0))
      : all

    sorted.forEach((filename, idx) => {
      artifacts.push({
        platform: rule.platform,
        filePath: path.join(rule.dir, filename),
        filename,
        isPrimary: idx === 0
      })
    })
  }
  return artifacts
}

function resolveExplicitFiles(paths) {
  const result = []
  const perPlatform = new Map()
  for (const p of paths) {
    const filePath = path.resolve(p)
    if (!fs.existsSync(filePath)) {
      console.error(`[upload-oss] 文件不存在：${filePath}`)
      process.exit(1)
    }
    const filename = path.basename(filePath)
    const platform = classifyByName(filename)
    if (!platform) {
      console.error(`[upload-oss] 无法识别 ${filename} 属于哪个平台（需 .exe / .pkg / .dmg）。`)
      process.exit(1)
    }
    // 同平台第一个是 primary
    const isPrimary = !perPlatform.has(platform)
    perPlatform.set(platform, true)
    result.push({ platform, filePath, filename, isPrimary })
  }
  return result
}

module.exports = { discoverArtifacts, resolveExplicitFiles, PROJECT_ROOT }
