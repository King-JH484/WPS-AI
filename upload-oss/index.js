#!/usr/bin/env node
const path = require('path')
const fs = require('fs')

const { loadConfig, createClient, buildKey, uploadFile, humanSize } = require('./lib/client')
const { discoverArtifacts, resolveExplicitFiles } = require('./lib/discover')
const { updateSite } = require('./lib/update-site')

function parseArgs(argv) {
  const opts = {
    configPath: path.resolve(__dirname, 'oss.config.js'),
    version: null,
    files: [],
    dryRun: false,
    updateSite: true
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-site-update') opts.updateSite = false
    else if (a === '--config') opts.configPath = path.resolve(argv[++i])
    else if (a === '--version' || a === '-v') opts.version = argv[++i]
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (a.startsWith('--')) {
      console.error(`未知参数：${a}`)
      printHelp()
      process.exit(1)
    } else {
      opts.files.push(a)
    }
  }
  return opts
}

function printHelp() {
  console.log(`用法：
  node index.js [files...] [options]

参数：
  files...               要上传的安装包路径（可多个）。不传则自动从
                         installer/dist/ 与 installer-mac/dist/ 扫描。

选项：
  --config <path>        指定配置文件，默认 ./oss.config.js
  --version, -v <ver>    覆盖默认版本号（默认从 site/utils/release.ts 读 VERSION）
  --dry-run              只打印不真正上传 / 不改 site
  --no-site-update       上传完成但不改写 site/utils/release.ts
  -h, --help             显示帮助
`)
}

function detectVersion() {
  const release = path.resolve(__dirname, '..', 'site', 'utils', 'release.ts')
  if (!fs.existsSync(release)) return null
  const m = fs.readFileSync(release, 'utf8').match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = opts.version || detectVersion()
  if (!version) {
    console.error('无法确定版本号。请用 --version <ver> 指定，或确保 site/utils/release.ts 存在 VERSION 常量。')
    process.exit(1)
  }

  console.log(`\n=== 灵犀AI 安装包上传 (v${version})${opts.dryRun ? ' [dry-run]' : ''} ===\n`)

  const cfg = loadConfig(opts.configPath)
  console.log(`桶：${cfg.bucket} (${cfg.region})`)
  console.log(`路径前缀：${cfg.pathPrefix}/${version}/`)
  console.log(`下载域名：${cfg.cdnBaseUrl || `https://${cfg.bucket}.${cfg.region}.aliyuncs.com`}\n`)

  const artifacts = opts.files.length > 0 ? resolveExplicitFiles(opts.files) : discoverArtifacts()

  if (artifacts.length === 0) {
    console.error('没有发现可上传的安装包。')
    console.error('  - 默认从 installer/dist/ (Windows .exe) 与 installer-mac/dist/ (.pkg/.dmg) 扫描。')
    console.error('  - 也可以直接：node index.js <path-to-installer> ...')
    process.exit(1)
  }

  console.log('待上传：')
  for (const a of artifacts) {
    const tag = a.isPrimary ? '主下载' : '附加'
    console.log(`  [${a.platform}] ${a.filename}  (${tag})`)
  }
  console.log('')

  const client = opts.dryRun ? null : createClient(cfg)
  const primaryUrls = { windows: '', mac: '' }
  const allUploaded = []

  for (const a of artifacts) {
    const key = buildKey(cfg, version, a.filename)
    let result
    if (opts.dryRun) {
      const { uploadFile: dryUpload } = require('./lib/client')
      result = await dryUpload(null, cfg, a.filePath, key, { dryRun: true })
    } else {
      result = await uploadFile(client, cfg, a.filePath, key)
    }
    allUploaded.push({ ...a, ...result })
    if (a.isPrimary) primaryUrls[a.platform] = result.url
  }

  console.log('\n=== 上传结果 ===')
  for (const u of allUploaded) {
    console.log(`  [${u.platform}] ${u.filename}`)
    console.log(`    ${u.url}`)
  }

  if (opts.updateSite) {
    console.log('\n=== 同步下载站 ===')
    updateSite(primaryUrls, { dryRun: opts.dryRun })
  } else {
    console.log('\n（已跳过站点更新：--no-site-update）')
  }

  console.log('\n完成。')
}

main().catch((err) => {
  console.error('\n[upload-oss] 失败：', err.message || err)
  if (err.stack && process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
