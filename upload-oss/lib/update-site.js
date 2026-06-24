const path = require('path')
const fs = require('fs')

const SITE_RELEASE = path.resolve(__dirname, '..', '..', 'site', 'utils', 'release.ts')

const BLOCK_RE = /\/\/ region OSS_URLS_BEGIN[\s\S]*?\/\/ endregion OSS_URLS_END/

// 自动同步的全部 OSS_URLS / OSS_SIZES key —— 新增平台/架构时往这里加。
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

function buildBlock(urls, sizes) {
  const urlEntries = KEYS.map((k) => `  ${formatKey(k)}: ${JSON.stringify(urls[k] || '')}`).join(',\n')
  const sizeEntries = KEYS.map((k) => `  ${formatKey(k)}: ${Number(sizes[k]) || 0}`).join(',\n')
  return `// region OSS_URLS_BEGIN
// 该区块由 upload-oss 工具自动维护，请勿手动编辑。
export const OSS_URLS: Record<${typeUnion()}, string> = {
${urlEntries}
}
// OSS_SIZES 是上传到 OSS 时实际文件字节数（0 = 未发布）。
// 前端用 humanSize() 格式化显示，避免硬编码 "~30 MB" 跟实际产物对不上。
export const OSS_SIZES: Record<${typeUnion()}, number> = {
${sizeEntries}
}
// endregion OSS_URLS_END`
}

function readCurrent() {
  if (!fs.existsSync(SITE_RELEASE)) {
    throw new Error(`找不到站点配置：${SITE_RELEASE}`)
  }
  return fs.readFileSync(SITE_RELEASE, 'utf8')
}

function parseCurrentBlock(content) {
  const urls = {}
  const sizes = {}
  KEYS.forEach((k) => { urls[k] = ''; sizes[k] = 0 })
  const m = content.match(BLOCK_RE)
  if (!m) return { urls, sizes }
  const block = m[0]
  // 分别在 OSS_URLS 段和 OSS_SIZES 段里找。两个段都遵循 `key: value` 字面量格式。
  // 切两半：URLS_BLOCK = 'OSS_URLS' 到 'OSS_SIZES' 之间；SIZES_BLOCK = 'OSS_SIZES' 之后。
  const urlsBlock = (block.split(/export const OSS_SIZES/)[0]) || block
  const sizesBlock = (block.split(/export const OSS_SIZES/)[1]) || ''
  KEYS.forEach((k) => {
    const reUrl = new RegExp(`(?:"${k}"|${k.replace(/[-]/g, '[-]')})\\s*:\\s*(['"])([\\s\\S]*?)\\1`)
    const reSize = new RegExp(`(?:"${k}"|${k.replace(/[-]/g, '[-]')})\\s*:\\s*(\\d+)`)
    const hitU = urlsBlock.match(reUrl)
    if (hitU) urls[k] = hitU[2]
    const hitS = sizesBlock.match(reSize)
    if (hitS) sizes[k] = Number(hitS[1]) || 0
  })
  return { urls, sizes }
}

// 兼容老调用：单参时返回 urls
function parseCurrentUrls(content) { return parseCurrentBlock(content).urls }

function isEqual(a, b) {
  return KEYS.every((k) => (a[k] || '') === (b[k] || ''))
}
function isEqualSizes(a, b) {
  return KEYS.every((k) => (Number(a[k]) || 0) === (Number(b[k]) || 0))
}

function updateSite(newUrls, newSizes = {}, { dryRun = false } = {}) {
  // 兼容老签名：updateSite(newUrls, { dryRun })
  if (newSizes && typeof newSizes === 'object' && 'dryRun' in newSizes && !Object.keys(newSizes).some((k) => KEYS.includes(k))) {
    dryRun = newSizes.dryRun
    newSizes = {}
  }
  const content = readCurrent()
  if (!BLOCK_RE.test(content)) {
    throw new Error('release.ts 中找不到 OSS_URLS_BEGIN/END 标记，无法自动更新。')
  }
  const { urls: curUrls, sizes: curSizes } = parseCurrentBlock(content)
  const mergedUrls = {}
  const mergedSizes = {}
  KEYS.forEach((k) => {
    mergedUrls[k] = newUrls[k] || curUrls[k] || ''
    // size 用 newSizes 优先，没有就保留旧值；如果 url 被更新但 size 没传，旧 size 也合理保留
    mergedSizes[k] = Number(newSizes[k]) || Number(curSizes[k]) || 0
  })
  if (isEqual(mergedUrls, curUrls) && isEqualSizes(mergedSizes, curSizes)) {
    console.log('  站点 OSS_URLS / OSS_SIZES 与本次结果一致，无需改写。')
    return { changed: false, urls: mergedUrls, sizes: mergedSizes }
  }

  const next = content.replace(BLOCK_RE, buildBlock(mergedUrls, mergedSizes))

  if (dryRun) {
    console.log('  [dry-run] 将改写 site/utils/release.ts 中的 OSS_URLS / OSS_SIZES：')
    KEYS.forEach((k) => {
      if ((curUrls[k] || '') !== (mergedUrls[k] || '')) {
        console.log(`    url   ${k}: ${curUrls[k] || '(空)'} → ${mergedUrls[k] || '(空)'}`)
      }
      if ((Number(curSizes[k]) || 0) !== (Number(mergedSizes[k]) || 0)) {
        console.log(`    size  ${k}: ${curSizes[k] || 0} → ${mergedSizes[k] || 0} bytes`)
      }
    })
    return { changed: true, urls: mergedUrls, sizes: mergedSizes, dryRun: true }
  }

  fs.writeFileSync(SITE_RELEASE, next, 'utf8')
  console.log(`  ✓ 已写入 ${path.relative(process.cwd(), SITE_RELEASE)}`)
  KEYS.forEach((k) => {
    if ((curUrls[k] || '') !== (mergedUrls[k] || '') || (Number(curSizes[k]) || 0) !== (Number(mergedSizes[k]) || 0)) {
      console.log(`    ${k} → url=${mergedUrls[k] || '(空)'}  size=${mergedSizes[k] || 0}`)
    }
  })
  return { changed: true, urls: mergedUrls, sizes: mergedSizes }
}

module.exports = { updateSite, parseCurrentUrls, parseCurrentBlock, KEYS, SITE_RELEASE }
