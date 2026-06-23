const path = require('path')
const fs = require('fs')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

// 默认产物目录 + 文件名匹配规则。允许通过 CLI 传文件直接覆盖。
// 三端 build 脚本（installer/lingxi-ai.iss、installer-mac/build-dmg.sh、
// installer-linux/build.sh）全部输出到项目根 dist/，扫描规则统一指过来。
const DIST_DIR = path.join(PROJECT_ROOT, 'dist')

const RULES = [
  {
    platform: 'windows',
    dir: DIST_DIR,
    match: /-setup\.exe$/i
  },
  {
    platform: 'mac',
    dir: DIST_DIR,
    // 优先 pkg（默认下载推荐），dmg 作为附加
    match: /\.(pkg|dmg)$/i,
    prefer: /\.pkg$/i
  },
  {
    platform: 'linux',
    dir: DIST_DIR,
    // installer-linux/build.sh 产物：
    //   lingxi-ai-<v>-linux-<arch>.tar.gz / lingxi-ai_<v>_<arch>.deb / lingxi-ai-<v>-1.<arch>.rpm
    // 默认主下载放 .deb（最普及），.rpm / .tar.gz 当附加同时传
    match: /\.(deb|rpm|tar\.gz)$/i,
    prefer: /\.deb$/i
  }
]

function classifyByName(filename) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.exe')) return 'windows'
  if (lower.endsWith('.pkg') || lower.endsWith('.dmg')) return 'mac'
  if (lower.endsWith('.deb') || lower.endsWith('.rpm') || lower.endsWith('.tar.gz')) return 'linux'
  return null
}

// 把文件名映射成 release.ts 里 OSS_URLS 的 key。
// windows / mac 是单 key；linux 按 format×arch 拆 6 个：
//   lingxi-ai_<v>_amd64.deb       → linux-deb-x86_64
//   lingxi-ai_<v>_arm64.deb       → linux-deb-aarch64
//   lingxi-ai-<v>-1.x86_64.rpm    → linux-rpm-x86_64
//   lingxi-ai-<v>-1.aarch64.rpm   → linux-rpm-aarch64
//   lingxi-ai-<v>-linux-x64.tar.gz → linux-tar-x86_64
//   lingxi-ai-<v>-linux-arm64.tar.gz → linux-tar-aarch64
function deriveOssKey(filename, platform) {
  if (platform === 'windows') return 'windows'
  if (platform === 'mac') return 'mac'
  if (platform === 'linux') {
    const arch = /(_arm64|-arm64|aarch64)/i.test(filename) ? 'aarch64' : 'x86_64'
    if (/\.deb$/i.test(filename)) return `linux-deb-${arch}`
    if (/\.rpm$/i.test(filename)) return `linux-rpm-${arch}`
    if (/\.tar\.gz$/i.test(filename)) return `linux-tar-${arch}`
  }
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
        isPrimary: idx === 0,
        ossKey: deriveOssKey(filename, rule.platform)
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
    result.push({ platform, filePath, filename, isPrimary, ossKey: deriveOssKey(filename, platform) })
  }
  return result
}

module.exports = { discoverArtifacts, resolveExplicitFiles, deriveOssKey, PROJECT_ROOT }
