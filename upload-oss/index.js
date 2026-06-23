#!/usr/bin/env node
const path = require('path')
const fs = require('fs')

const {
  loadConfig, createClient, buildKey, buildPluginZipKey, buildManifestKey,
  uploadFile, uploadManifest, humanSize
} = require('./lib/client')
const { discoverArtifacts, resolveExplicitFiles } = require('./lib/discover')
const { updateSite } = require('./lib/update-site')
const { buildPluginZip } = require('./lib/build-plugin-zip')
const { buildManifest } = require('./lib/build-manifest')
const { syncVersions } = require('./lib/sync-versions')

function parseArgs(argv) {
  const opts = {
    configPath: path.resolve(__dirname, 'oss.config.js'),
    version: null,
    files: [],
    dryRun: false,
    updateSite: true,
    skipUpdate: false,        // 跳过 plugin.zip + manifest.json
    onlyUpdate: false,        // 只跑 plugin.zip + manifest.json，不传安装包
    syncVersion: true,        // 跑前把 release.ts 的 VERSION 同步到 package.json / manifest.json / iss
    checkVersionOnly: false   // 只校验版本一致性，不真改文件（CI 用）
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-site-update') opts.updateSite = false
    else if (a === '--no-update-bundle') opts.skipUpdate = true
    else if (a === '--only-update-bundle') opts.onlyUpdate = true
    else if (a === '--no-sync-version') opts.syncVersion = false
    else if (a === '--check-version') { opts.checkVersionOnly = true; opts.syncVersion = false }
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
  --dry-run              只打印不真正上传 / 不改 site / 不生成 plugin.zip
  --no-site-update       上传完成但不改写 site/utils/release.ts
  --no-update-bundle     跳过 plugin.zip + manifest.json（只传安装包）
  --only-update-bundle   只跑 plugin.zip + manifest.json（不传任何安装包）
  --no-sync-version      跳过把 release.ts 的 VERSION 同步到 package.json / iss / manifest
  --check-version        只校验所有版本号是否跟 release.ts 一致，不动文件（CI 用）
  -h, --help             显示帮助

产物：
  - 安装包      → <pathPrefix>/<version>/lingxi-ai-*.exe / .pkg / .dmg
  - plugin.zip → <pluginPathPrefix>/<version>/plugin.zip   （应用内热更新用）
  - manifest   → <manifestKey>（默认 <parent>/manifest.json，应用启动检查更新拉这个）
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

  // ---- 0. 版本号同步：release.ts → package.json / manifest.json / iss ----
  if (opts.checkVersionOnly) {
    const r = syncVersions(version, { check: true })
    console.log('版本一致性检查（不修改文件）：')
    r.unchanged.forEach((l) => console.log(`  ✓ ${l}  = ${version}`))
    r.mismatches.forEach((m) => console.log(`  ✗ ${m.label}  ${m.current} ≠ ${version}`))
    r.missing.forEach((l) => console.log(`  ? ${l}  缺失`))
    process.exit(r.mismatches.length > 0 || r.missing.length > 0 ? 1 : 0)
  }
  if (opts.syncVersion) {
    const r = syncVersions(version, { check: opts.dryRun })
    if (r.synced.length > 0) {
      console.log(`版本号已${opts.dryRun ? '[dry-run] 将' : ''}同步到 release.ts 的 v${version}：`)
      r.synced.forEach((s) => console.log(`  ✓ ${s.label}  ${s.from} → ${s.to}`))
    } else if (r.mismatches.length > 0 && opts.dryRun) {
      console.log(`[dry-run] 版本号待同步：`)
      r.mismatches.forEach((m) => console.log(`  ✗ ${m.label}  ${m.current} → ${version}`))
    }
    if (r.missing.length > 0) {
      console.warn(`⚠️ 以下文件未匹配到 version 字段，跳过：${r.missing.join(', ')}`)
    }
    console.log('')
  }

  const cfg = loadConfig(opts.configPath)
  console.log(`桶：${cfg.bucket} (${cfg.region})`)
  console.log(`路径前缀：${cfg.pathPrefix}/${version}/`)
  console.log(`下载域名：${cfg.cdnBaseUrl || `https://${cfg.bucket}.${cfg.region}.aliyuncs.com`}\n`)

  // ---- 1. 安装包：发现 / 上传 ----
  const artifacts = opts.onlyUpdate
    ? []
    : (opts.files.length > 0 ? resolveExplicitFiles(opts.files) : discoverArtifacts())

  if (!opts.onlyUpdate && artifacts.length === 0) {
    console.error('没有发现可上传的安装包。')
    console.error('  - 默认从 dist/ (Windows .exe) 与 installer-mac/dist/ (.pkg/.dmg) 扫描。')
    console.error('  - 也可以直接：node index.js <path-to-installer> ...')
    console.error('  - 只想发热更新包（plugin.zip + manifest）用：--only-update-bundle')
    process.exit(1)
  }

  if (artifacts.length > 0) {
    console.log('待上传安装包：')
    for (const a of artifacts) {
      const tag = a.isPrimary ? '主下载' : '附加'
      console.log(`  [${a.platform}] ${a.filename}  (${tag})`)
    }
    console.log('')
  }

  const client = opts.dryRun ? null : createClient(cfg)
  // 注意：linux 平台只是塞着，update-site.js 暂只把 windows/mac 同步回 release.ts；
  // Linux 的 OSS_URLS 由 linuxUrl 帮助函数管，要做联动得另外扩 update-site.js
  const primaryUrls = { windows: '', mac: '', linux: '' }
  const allUploaded = []

  for (const a of artifacts) {
    const key = buildKey(cfg, version, a.filename)
    let result
    if (opts.dryRun) {
      result = await uploadFile(null, cfg, a.filePath, key, { dryRun: true })
    } else {
      result = await uploadFile(client, cfg, a.filePath, key)
    }
    allUploaded.push({ ...a, ...result })
    if (a.isPrimary) primaryUrls[a.platform] = result.url
  }

  if (allUploaded.length > 0) {
    console.log('\n=== 安装包上传结果 ===')
    for (const u of allUploaded) {
      console.log(`  [${u.platform}] ${u.filename}`)
      console.log(`    ${u.url}`)
    }
  }

  // ---- 2. plugin.zip + manifest.json （应用内自动更新）----
  let pluginUploadUrl = ''
  let pluginUploadSize = 0
  let manifestUploadUrl = ''
  if (!opts.skipUpdate) {
    console.log('\n=== 热更新包 (plugin.zip + manifest.json) ===')
    const projectRoot = path.resolve(__dirname, '..')
    const pluginRoot = path.join(projectRoot, 'plugin')
    const outDir = path.join(projectRoot, 'dist')


    const pluginZipKey = buildPluginZipKey(cfg, version)
    const manifestKey = buildManifestKey(cfg)
    const pluginZipPublicUrl = cfg.cdnBaseUrl
      ? `${cfg.cdnBaseUrl}/${pluginZipKey}`
      : `https://${cfg.bucket}.${cfg.region}.aliyuncs.com/${pluginZipKey}`

    if (opts.dryRun) {
      console.log(`  [dry-run] 跳过实际打 plugin.zip，模拟产物`)
      pluginUploadUrl = pluginZipPublicUrl
      pluginUploadSize = 0
    } else {
      console.log(`  打包 ${pluginRoot} → plugin-${version}.zip（排除 node_modules / runtime / .git / 等）...`)
      const zipInfo = buildPluginZip({ pluginRoot, version, outDir })
      console.log(`  ✓ 完成 ${path.relative(projectRoot, zipInfo.zipPath)} (${humanSize(zipInfo.size)})`)
      const r = await uploadFile(client, cfg, zipInfo.zipPath, pluginZipKey)
      pluginUploadUrl = r.url
      pluginUploadSize = r.size
    }

    // 生成 manifest（pluginUrl 指向刚上传的 plugin.zip）
    if (opts.dryRun) {
      console.log(`  [dry-run] manifest.json → oss://${cfg.bucket}/${manifestKey}`)
      console.log(`            version=${version}  pluginUrl=${pluginZipPublicUrl}`)
      manifestUploadUrl = cfg.cdnBaseUrl
        ? `${cfg.cdnBaseUrl}/${manifestKey}`
        : `https://${cfg.bucket}.${cfg.region}.aliyuncs.com/${manifestKey}`
    } else {
      const projectRoot2 = path.resolve(__dirname, '..')
      const outDir2 = path.join(projectRoot2, 'dist')
      const { manifestPath, manifest } = buildManifest({
        version,
        pluginUrl: pluginUploadUrl,
        pluginSize: pluginUploadSize,
        outDir: outDir2
      })
      console.log(`  ✓ 生成 ${path.relative(projectRoot2, manifestPath)}（changelog ${manifest.changelog.length} 字符）`)
      const r = await uploadManifest(client, cfg, manifestPath, manifestKey)
      manifestUploadUrl = r.url
    }
  } else {
    console.log('\n（已跳过 plugin.zip + manifest.json：--no-update-bundle）')
  }

  // ---- 3. 同步下载站 ----
  if (opts.updateSite && artifacts.length > 0) {
    console.log('\n=== 同步下载站 ===')
    updateSite(primaryUrls, { dryRun: opts.dryRun })
  } else if (!opts.updateSite) {
    console.log('\n（已跳过站点更新：--no-site-update）')
  }

  // ---- 4. 总结 ----
  if (manifestUploadUrl) {
    console.log('\n=== 应用内自动更新指向 ===')
    console.log(`  manifest:   ${manifestUploadUrl}`)
    console.log(`  plugin.zip: ${pluginUploadUrl}`)
    console.log('  确认 plugin/js/updater.js 里 DEFAULT_MANIFEST_URL 跟上面 manifest 一致。')
  }

  console.log('\n完成。')
}

main().catch((err) => {
  console.error('\n[upload-oss] 失败：', err.message || err)
  if (err.stack && process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
