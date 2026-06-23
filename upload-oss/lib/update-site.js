const path = require('path')
const fs = require('fs')

const SITE_RELEASE = path.resolve(__dirname, '..', '..', 'site', 'utils', 'release.ts')

const BLOCK_RE = /\/\/ region OSS_URLS_BEGIN[\s\S]*?\/\/ endregion OSS_URLS_END/

function buildBlock(urls) {
  const fmt = (k) => `  ${k}: ${JSON.stringify(urls[k] || '')}`
  return `// region OSS_URLS_BEGIN
// 该区块由 upload-oss 工具自动维护，请勿手动编辑。
export const OSS_URLS: Record<'windows' | 'mac', string> = {
${fmt('windows')},
${fmt('mac')}
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
  const m = content.match(BLOCK_RE)
  const urls = { windows: '', mac: '' }
  if (!m) return urls
  const block = m[0]
  const winM = block.match(/windows\s*:\s*(['"])(.*?)\1/)
  const macM = block.match(/mac\s*:\s*(['"])(.*?)\1/)
  if (winM) urls.windows = winM[2]
  if (macM) urls.mac = macM[2]
  return urls
}

function updateSite(newUrls, { dryRun = false } = {}) {
  const content = readCurrent()
  if (!BLOCK_RE.test(content)) {
    throw new Error('release.ts 中找不到 OSS_URLS_BEGIN/END 标记，无法自动更新。')
  }
  const current = parseCurrentUrls(content)
  const merged = {
    windows: newUrls.windows || current.windows,
    mac: newUrls.mac || current.mac
  }
  if (merged.windows === current.windows && merged.mac === current.mac) {
    console.log('  站点 OSS_URLS 与本次结果一致，无需改写。')
    return { changed: false, urls: merged }
  }

  const next = content.replace(BLOCK_RE, buildBlock(merged))

  if (dryRun) {
    console.log('  [dry-run] 将改写 site/utils/release.ts 中的 OSS_URLS：')
    console.log(`    windows: ${current.windows || '(空)'} → ${merged.windows || '(空)'}`)
    console.log(`    mac:     ${current.mac || '(空)'} → ${merged.mac || '(空)'}`)
    return { changed: true, urls: merged, dryRun: true }
  }

  fs.writeFileSync(SITE_RELEASE, next, 'utf8')
  console.log(`  ✓ 已写入 ${path.relative(process.cwd(), SITE_RELEASE)}`)
  console.log(`    windows → ${merged.windows}`)
  console.log(`    mac     → ${merged.mac}`)
  return { changed: true, urls: merged }
}

module.exports = { updateSite, parseCurrentUrls, SITE_RELEASE }
