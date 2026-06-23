const path = require('path')
const fs = require('fs')

const SITE_RELEASE = path.resolve(__dirname, '..', '..', 'site', 'utils', 'release.ts')

const BLOCK_RE = /\/\/ region OSS_URLS_BEGIN[\s\S]*?\/\/ endregion OSS_URLS_END/

// 自动同步的全部 OSS_URLS key —— 新增平台/架构时往这里加。
// 顺序就是写入文件里的顺序，保持稳定方便人工 review。
const KEYS = [
  'windows',
  'mac',
  'linux-deb-x86_64',
  'linux-rpm-x86_64',
  'linux-tar-x86_64',
  'linux-deb-aarch64',
  'linux-rpm-aarch64',
  'linux-tar-aarch64'
]

// 含连字符的 key 要带引号才是合法 TS 对象键
function formatKey(k) {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : `"${k}"`
}

// TS 类型 Record<...> 的字面量联合
function typeUnion() {
  return KEYS.map((k) => `'${k}'`).join(' | ')
}

function buildBlock(urls) {
  const entries = KEYS.map((k) => `  ${formatKey(k)}: ${JSON.stringify(urls[k] || '')}`).join(',\n')
  return `// region OSS_URLS_BEGIN
// 该区块由 upload-oss 工具自动维护，请勿手动编辑。
export const OSS_URLS: Record<${typeUnion()}, string> = {
${entries}
}
// endregion OSS_URLS_END`
}

function readCurrent() {
  if (!fs.existsSync(SITE_RELEASE)) {
    throw new Error(`找不到站点配置：${SITE_RELEASE}`)
  }
  return fs.readFileSync(SITE_RELEASE, 'utf8')
}

function parseCurrentUrls(content) {
  const urls = {}
  KEYS.forEach((k) => { urls[k] = '' })
  const m = content.match(BLOCK_RE)
  if (!m) return urls
  const block = m[0]
  // 同时匹配 windows: "..." 和 "linux-deb-x86_64": "..." 两种写法
  KEYS.forEach((k) => {
    const re = new RegExp(`(?:"${k}"|${k.replace(/[-]/g, '[-]')})\\s*:\\s*(['"])([\\s\\S]*?)\\1`)
    const hit = block.match(re)
    if (hit) urls[k] = hit[2]
  })
  return urls
}

function urlsEqual(a, b) {
  return KEYS.every((k) => (a[k] || '') === (b[k] || ''))
}

function updateSite(newUrls, { dryRun = false } = {}) {
  const content = readCurrent()
  if (!BLOCK_RE.test(content)) {
    throw new Error('release.ts 中找不到 OSS_URLS_BEGIN/END 标记，无法自动更新。')
  }
  const current = parseCurrentUrls(content)
  const merged = {}
  KEYS.forEach((k) => { merged[k] = newUrls[k] || current[k] || '' })
  if (urlsEqual(merged, current)) {
    console.log('  站点 OSS_URLS 与本次结果一致，无需改写。')
    return { changed: false, urls: merged }
  }

  const next = content.replace(BLOCK_RE, buildBlock(merged))

  if (dryRun) {
    console.log('  [dry-run] 将改写 site/utils/release.ts 中的 OSS_URLS：')
    KEYS.forEach((k) => {
      if ((current[k] || '') !== (merged[k] || '')) {
        console.log(`    ${k}: ${current[k] || '(空)'} → ${merged[k] || '(空)'}`)
      }
    })
    return { changed: true, urls: merged, dryRun: true }
  }

  fs.writeFileSync(SITE_RELEASE, next, 'utf8')
  console.log(`  ✓ 已写入 ${path.relative(process.cwd(), SITE_RELEASE)}`)
  KEYS.forEach((k) => {
    if ((current[k] || '') !== (merged[k] || '')) {
      console.log(`    ${k} → ${merged[k] || '(空)'}`)
    }
  })
  return { changed: true, urls: merged }
}

module.exports = { updateSite, parseCurrentUrls, KEYS, SITE_RELEASE }
