#!/usr/bin/env node
// 把已经上传到 OSS 的对象批量改成 public-read。
// 历史上 client 没主动设 ACL，bucket 又是 private，导致下载链接全部 403。
// 新版 client 已自动加 x-oss-object-acl=public-read；这个脚本用来一次性
// 修历史遗留的对象。
//
// 用法：
//   node fix-acl.js                  # 修当前版本 + manifest（默认）
//   node fix-acl.js --all-versions 1.4.0 1.4.1 ...
//   node fix-acl.js --prefix wps-ai  # 列出 prefix 下全部对象，逐个改 ACL

const path = require('path')
const fs = require('fs')
const { loadConfig, createClient, buildKey, buildPluginZipKey, buildManifestKey } = require('./lib/client')

function detectVersion() {
  const release = path.resolve(__dirname, '..', 'site', 'utils', 'release.ts')
  if (!fs.existsSync(release)) return null
  const m = fs.readFileSync(release, 'utf8').match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

function parseArgs(argv) {
  const opts = { configPath: path.resolve(__dirname, 'oss.config.js'), versions: [], prefix: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') opts.configPath = path.resolve(argv[++i])
    else if (a === '--prefix') opts.prefix = argv[++i]
    else if (a === '--all-versions') {
      // 后面剩下的位置参数都当版本号
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.versions.push(argv[++i])
    } else if (a.startsWith('--')) {
      console.error('未知参数：' + a); process.exit(1)
    } else {
      opts.versions.push(a)
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cfg = loadConfig(opts.configPath)
  const client = createClient(cfg)

  let keys = []
  if (opts.prefix) {
    // 列出 prefix 下所有对象（最多 1000）
    console.log(`列举 prefix=${opts.prefix} 下的对象...`)
    const list = await client.list({ prefix: opts.prefix, 'max-keys': 1000 })
    keys = (list.objects || []).map((o) => o.name)
    console.log(`  找到 ${keys.length} 个对象`)
  } else {
    const versions = opts.versions.length ? opts.versions : [detectVersion()].filter(Boolean)
    if (versions.length === 0) {
      console.error('找不到版本号。请用 --all-versions 1.4.0 1.4.1 显式指定。')
      process.exit(1)
    }
    // manifest（共用）
    keys.push(buildManifestKey(cfg))
    // 每个版本：安装包 + plugin.zip
    for (const v of versions) {
      // 安装包文件名约定：anthony-ai-<v>-setup.exe / anthony-ai-<v>.pkg / anthony-ai-<v>.dmg
      keys.push(buildKey(cfg, v, `anthony-ai-${v}-setup.exe`))
      keys.push(buildKey(cfg, v, `anthony-ai-${v}.pkg`))
      keys.push(buildKey(cfg, v, `anthony-ai-${v}.dmg`))
      keys.push(buildPluginZipKey(cfg, v))
    }
  }

  console.log(`\n准备把 ${keys.length} 个对象改成 public-read：`)
  let ok = 0, fail = 0, missing = 0
  for (const key of keys) {
    try {
      // 先 head 一下确认对象存在；不存在的跳过
      try {
        await client.head(key)
      } catch (e) {
        if (e.code === 'NoSuchKey' || /404/.test(String(e.message))) {
          console.log(`  - ${key}  (不存在，跳过)`)
          missing += 1
          continue
        }
        throw e
      }
      await client.putACL(key, 'public-read')
      console.log(`  ✓ ${key}`)
      ok += 1
    } catch (e) {
      console.log(`  ✗ ${key}  ${e.message || e}`)
      fail += 1
    }
  }
  console.log(`\n完成：成功 ${ok}，失败 ${fail}，跳过 ${missing}`)
}

main().catch((err) => {
  console.error('[fix-acl] 失败：', err.message || err)
  process.exit(1)
})
