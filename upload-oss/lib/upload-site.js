#!/usr/bin/env node
// 把 site/.output/public/（nuxt generate 产物）上传到 OSS 静态站点桶。
//
// 用法：
//   node lib/upload-site.js                    # 上传到 oss.config.js .site 配的桶
//   node lib/upload-site.js --build            # 先在 site/ 跑 npm run build 再传
//   node lib/upload-site.js --clean            # 上传前先删桶内所有对象（彻底替换；危险）
//   node lib/upload-site.js --dry-run          # 只列出会做什么，不动 OSS
//
// 缓存策略：
//   _nuxt/* / 带 hash 的资源 → max-age=31536000 immutable（长缓存）
//   *.html                    → max-age=300 must-revalidate（短缓存，发布即生效）
//   其它（favicon / 图片等）  → max-age=86400（中缓存）
// 所有对象 ACL 设 public-read。

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const CONFIG_PATH = path.resolve(__dirname, '..', 'oss.config.js')

function requireOSS() {
  try { return require('ali-oss') }
  catch (e) {
    console.error('[upload-site] 缺 ali-oss，在 upload-oss/ 跑 npm install 先')
    process.exit(1)
  }
}

function parseArgs(argv) {
  const opts = { build: false, clean: false, dryRun: false }
  for (const a of argv) {
    if (a === '--build') opts.build = true
    else if (a === '--clean') opts.clean = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '-h' || a === '--help') {
      console.log(`用法：node lib/upload-site.js [--build] [--clean] [--dry-run]
  --build     先在 site/ 跑 npm run build（nuxt generate）再传
  --clean     传之前清空桶（彻底替换；不传 = 增量覆盖，老文件残留）
  --dry-run   只打印不动 OSS`)
      process.exit(0)
    } else {
      console.error(`未知参数：${a}`)
      process.exit(1)
    }
  }
  return opts
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[upload-site] 找不到 ${CONFIG_PATH}`)
    console.error('  复制 oss.config.example.js → oss.config.js 后填真实凭据')
    process.exit(1)
  }
  const cfg = require(CONFIG_PATH)
  if (!cfg.site || !cfg.site.bucket) {
    console.error('[upload-site] oss.config.js 里缺 site.bucket 配置')
    console.error('  参照 oss.config.example.js 的 site 块加上')
    process.exit(1)
  }
  // site 块缺 AK/SK 时复用顶层
  const siteCfg = {
    region: cfg.site.region || cfg.region,
    bucket: cfg.site.bucket,
    accessKeyId: cfg.site.accessKeyId || cfg.accessKeyId,
    accessKeySecret: cfg.site.accessKeySecret || cfg.accessKeySecret,
    distDir: cfg.site.distDir
      ? path.resolve(__dirname, '..', cfg.site.distDir)
      : path.join(ROOT, 'site', '.output', 'public'),
    pathPrefix: (cfg.site.pathPrefix || '').replace(/^\/+|\/+$/g, '')
  }
  if (!siteCfg.accessKeyId || !siteCfg.accessKeySecret) {
    console.error('[upload-site] 缺 AccessKey（site 块或顶层都没填）')
    process.exit(1)
  }
  return siteCfg
}

// 后缀 → Content-Type。ali-oss 自带 mime.js 已经覆盖大多数，这里只声明前端常见的 + 中文友好
const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}

function pickCacheControl(relPath) {
  // _nuxt/* 是 Nuxt 带 content hash 的 chunk，可以永久缓存
  if (relPath.startsWith('_nuxt/') || /\.[0-9a-f]{8,}\./i.test(path.basename(relPath))) {
    return 'public, max-age=31536000, immutable'
  }
  // HTML 短缓存，发版立即生效
  if (/\.html?$/i.test(relPath)) {
    return 'public, max-age=300, must-revalidate'
  }
  // 其它（favicon / images / 字体等）中等缓存
  return 'public, max-age=86400'
}

function pickContentType(filename) {
  const ext = path.extname(filename).toLowerCase()
  return EXT_MIME[ext] || 'application/octet-stream'
}

function walkFiles(rootDir) {
  const out = []
  function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = fs.statSync(fp)
      if (st.isDirectory()) walk(fp, relPath)
      else if (st.isFile()) out.push({ filePath: fp, relPath, size: st.size })
    }
  }
  walk(rootDir, '')
  return out
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function runBuild() {
  const siteDir = path.join(ROOT, 'site')
  console.log(`[upload-site] cd ${siteDir} && npm run build (= nuxt generate)`)
  const r = spawnSync('npm', ['run', 'build'], { cwd: siteDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error('[upload-site] site build 失败')
    process.exit(r.status || 1)
  }
}

async function cleanBucket(client, prefix) {
  console.log(`[upload-site] 清空桶 (prefix=${prefix || '(根)'})...`)
  let total = 0
  let token = undefined
  while (true) {
    const list = await client.listV2({ prefix, 'max-keys': 1000, 'continuation-token': token }, {})
    const keys = (list.objects || []).map((o) => o.name)
    if (keys.length === 0) break
    // 分批 deleteMulti 每批最多 1000
    const r = await client.deleteMulti(keys, { quiet: true })
    total += keys.length
    console.log(`  删 ${keys.length}（累计 ${total}）`)
    if (!list.isTruncated) break
    token = list.nextContinuationToken
  }
  console.log(`[upload-site] 清空完成，共 ${total} 对象`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()

  if (opts.build) {
    await runBuild()
  }

  if (!fs.existsSync(cfg.distDir)) {
    console.error(`[upload-site] 静态产物目录不存在：${cfg.distDir}`)
    console.error('  先在 site/ 跑 npm run build，或加 --build 让本脚本帮你跑')
    process.exit(1)
  }

  const files = walkFiles(cfg.distDir)
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  console.log(`\n=== upload-site${opts.dryRun ? ' [dry-run]' : ''} ===`)
  console.log(`桶:      ${cfg.bucket} (${cfg.region})`)
  console.log(`本地源:  ${cfg.distDir}`)
  console.log(`前缀:    ${cfg.pathPrefix || '(根)'}`)
  console.log(`文件数:  ${files.length}`)
  console.log(`总大小:  ${humanSize(totalBytes)}\n`)

  const OSS = requireOSS()
  const client = opts.dryRun ? null : new OSS({
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    bucket: cfg.bucket,
    secure: true
  })

  if (opts.clean) {
    if (opts.dryRun) {
      console.log(`[dry-run] 会清空桶 (prefix=${cfg.pathPrefix || '(根)'})`)
    } else {
      await cleanBucket(client, cfg.pathPrefix)
    }
  }

  let i = 0
  let okCount = 0
  let failCount = 0
  for (const f of files) {
    i += 1
    const key = cfg.pathPrefix ? `${cfg.pathPrefix}/${f.relPath}` : f.relPath
    const headers = {
      'Content-Type': pickContentType(f.relPath),
      'Cache-Control': pickCacheControl(f.relPath),
      'x-oss-object-acl': 'public-read'
    }
    if (opts.dryRun) {
      console.log(`  [dry-run] ${key}  (${humanSize(f.size)})  cache: ${headers['Cache-Control']}`)
      continue
    }
    try {
      await client.put(key, f.filePath, { headers })
      okCount += 1
      // 进度：每 5 个或最后一个打一次
      if (i % 5 === 0 || i === files.length) {
        process.stdout.write(`  [${i}/${files.length}] ${key}\n`)
      }
    } catch (e) {
      failCount += 1
      console.error(`  [X] ${key}: ${e?.message || e}`)
    }
  }

  console.log(`\n${opts.dryRun ? '[dry-run] ' : ''}完成。${opts.dryRun ? '' : `成功 ${okCount}，失败 ${failCount}`}`)
  if (!opts.dryRun) {
    const base = `https://${cfg.bucket}.${cfg.region}.aliyuncs.com`
    const home = cfg.pathPrefix ? `${base}/${cfg.pathPrefix}/index.html` : `${base}/index.html`
    console.log(`访问: ${home}`)
    console.log(`（如果是首次部署，记得在 OSS 控制台开"静态网站托管"，默认主页 index.html / 错误页 404.html）`)
  }
}

main().catch((err) => {
  console.error('[upload-site] 失败:', err.message || err)
  if (process.env.DEBUG && err.stack) console.error(err.stack)
  process.exit(1)
})
