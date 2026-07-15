#!/usr/bin/env node
// 灰度推送：
//   1. 把 plugin/ 打成 plugin.zip
//   2. 上传到 <pluginPathPrefix>/<canaryVersion>/plugin.zip
//   3. 拉当前线上 manifest.json，merge 一个 canary 块进去（不覆盖 stable 字段）
//      canary.version / canary.pluginUrl / canary.pluginSize / canary.snWhitelist
//   4. 回写 manifest.json
//
// 用法：
//   node lib/publish-canary.js <version> --sn <SN> [--sn <SN2> ...] [--changelog "..."] [--dry-run]
//
// 例：
//   node lib/publish-canary.js 1.4.1 --sn 57F9747D-4127-5987-AA57-1580B6D12C1 \
//        --changelog "feat: 全文润色 + 翻译选中预览弹窗 等"

const path = require('path')
const fs = require('fs')

const {
  loadConfig, createClient, buildKey, buildPluginZipKey, buildManifestKey,
  buildPublicUrl, uploadFile, humanSize
} = require('./client')
const { buildPluginZip } = require('./build-plugin-zip')

const ROOT = path.resolve(__dirname, '..', '..')

function parseArgs(argv) {
  const args = { snWhitelist: [], rolloutPercent: null, changelog: null, dryRun: false, version: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--sn') args.snWhitelist.push(argv[++i])
    else if (a === '--rollout-percent') args.rolloutPercent = Number(argv[++i])
    else if (a === '--changelog') args.changelog = String(argv[++i])
    else if (a === '--config') args.configPath = argv[++i]
    else if (!a.startsWith('--')) args.version = a
  }
  if (!args.version) {
    console.error('用法：node lib/publish-canary.js <version> --sn <SN> [--sn ...] [--changelog "..."] [--dry-run]')
    process.exit(1)
  }
  return args
}

async function fetchExistingManifest(client, manifestKey) {
  try {
    const r = await client.get(manifestKey)
    const text = Buffer.isBuffer(r?.content) ? r.content.toString('utf8') : String(r?.content || '')
    return JSON.parse(text)
  } catch (err) {
    const code = err?.code || err?.name || ''
    if (['NoSuchKey', 'NoSuchObject', 'NoSuchBucketError'].includes(code)) return null
    throw err
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = args.configPath || path.resolve(__dirname, '..', 'oss.config.js')
  const cfg = loadConfig(configPath)
  const client = createClient(cfg)

  console.log(`[canary] 版本：${args.version}`)
  console.log(`[canary] 白名单 SN：${args.snWhitelist.length ? args.snWhitelist.join(', ') : '(空)'}`)
  if (args.rolloutPercent != null) console.log(`[canary] rolloutPercent：${args.rolloutPercent}`)

  // === 1. build plugin.zip ===
  const distDir = path.join(ROOT, 'dist')
  console.log(`[canary] 打包 plugin.zip 到 ${distDir}`)
  const built = buildPluginZip({
    pluginRoot: path.join(ROOT, 'plugin'),
    version: args.version,
    outDir: distDir
  })
  const size = built.size
  console.log(`[canary] plugin.zip → ${built.zipPath} (${humanSize(size)})`)

  // === 2. upload plugin.zip to canary path ===
  const pluginKey = buildPluginZipKey(cfg, args.version)
  const pluginUrl = buildPublicUrl(cfg, pluginKey)
  console.log(`[canary] 上传 → oss://${cfg.bucket}/${pluginKey}`)
  console.log(`[canary] 公网 URL：${pluginUrl}`)
  if (args.dryRun) {
    console.log('[canary] --dry-run：跳过实际上传')
  } else {
    await uploadFile(client, cfg, built.zipPath, pluginKey, {})
  }

  // === 3. fetch + patch manifest ===
  const manifestKey = buildManifestKey(cfg)
  console.log(`[canary] 读取线上 manifest：oss://${cfg.bucket}/${manifestKey}`)
  const existing = await fetchExistingManifest(client, manifestKey)
  if (!existing) {
    console.error(`[canary] 线上没有 manifest.json，无法只补 canary（需要先有 stable manifest）`)
    process.exit(1)
  }
  console.log(`[canary] 当前 stable 版本：${existing.version}（不动）`)

  const canary = Object.assign({}, existing.canary || {}, {
    version: args.version,
    pluginUrl,
    pluginSize: size,
    snWhitelist: args.snWhitelist.length ? args.snWhitelist : (existing.canary?.snWhitelist || [])
  })
  if (args.changelog != null) canary.changelog = args.changelog
  else if (existing.canary?.changelog) canary.changelog = existing.canary.changelog
  if (args.rolloutPercent != null) canary.rolloutPercent = args.rolloutPercent
  else if (existing.canary?.rolloutPercent != null) canary.rolloutPercent = existing.canary.rolloutPercent

  const patched = Object.assign({}, existing, { canary, buildTime: Date.now() })
  const patchedText = JSON.stringify(patched, null, 2)

  console.log('[canary] 更新后的 manifest.canary 块：')
  console.log(JSON.stringify(canary, null, 2).split('\n').map((l) => '  ' + l).join('\n'))

  if (args.dryRun) {
    console.log('[canary] --dry-run：跳过 manifest 回写')
    return
  }

  // 上传 manifest。关键：私桶 ACL，必须显式给 manifest 对象打 public-read，否则 updater 拉不到（403）。
  await client.put(manifestKey, Buffer.from(patchedText, 'utf8'), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'x-oss-object-acl': 'public-read'
    }
  })
  console.log(`[canary] manifest.json 已更新：${buildPublicUrl(cfg, manifestKey)}`)
  console.log('[canary] 完成。白名单 SN 用户下次轮询（30min cooldown 内可强制刷新）将看到 canary。')
}

main().catch((e) => {
  console.error('[canary] 失败：', e?.message || e)
  process.exit(1)
})
