const path = require('path')
const fs = require('fs')

function requireOSS() {
  try {
    return require('ali-oss')
  } catch (e) {
    console.error('[upload-oss] 缺少依赖 ali-oss。请先在 upload-oss/ 目录下执行：')
    console.error('  npm install')
    process.exit(1)
  }
}

function loadConfig(configPath) {
  const resolved = path.resolve(configPath)
  if (!fs.existsSync(resolved)) {
    console.error(`[upload-oss] 找不到配置文件：${resolved}`)
    console.error('  请复制 oss.config.example.js → oss.config.js 后填入真实凭据。')
    process.exit(1)
  }
  const cfg = require(resolved)
  const required = ['region', 'accessKeyId', 'accessKeySecret', 'bucket']
  for (const k of required) {
    if (!cfg[k] || String(cfg[k]).startsWith('YOUR_')) {
      console.error(`[upload-oss] 配置 ${k} 缺失或仍为占位符。请编辑 ${path.basename(configPath)}。`)
      process.exit(1)
    }
  }
  cfg.pathPrefix = (cfg.pathPrefix || 'releases').replace(/^\/+|\/+$/g, '')
  cfg.cdnBaseUrl = (cfg.cdnBaseUrl || '').replace(/\/+$/, '')
  cfg.multipart = { partSize: 1024 * 1024, parallel: 4, ...(cfg.multipart || {}) }
  cfg.headers = cfg.headers || {}
  return cfg
}

function createClient(cfg) {
  const OSS = requireOSS()
  const opts = {
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    bucket: cfg.bucket,
    secure: true
  }
  if (cfg.endpoint) opts.endpoint = cfg.endpoint
  return new OSS(opts)
}

function buildKey(cfg, version, filename) {
  return [cfg.pathPrefix, version, filename].filter(Boolean).join('/')
}

// 把 pathPrefix 拆出"父目录"，用来推 plugin.zip / manifest.json 的 key。
// 例：pathPrefix="wps-ai/releases" → parent="wps-ai"; pathPrefix="releases" → parent=""
function parentPrefix(cfg) {
  const parts = String(cfg.pathPrefix || '').split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

// 热更新用的 plugin.zip key：<parent>/plugin/<version>/plugin.zip
// （可被 cfg.pluginPathPrefix 完全覆盖，例：'wps-ai/plugin'）
function buildPluginZipKey(cfg, version) {
  const prefix = cfg.pluginPathPrefix
    ? String(cfg.pluginPathPrefix).replace(/^\/+|\/+$/g, '')
    : [parentPrefix(cfg), 'plugin'].filter(Boolean).join('/')
  return [prefix, version, 'plugin.zip'].filter(Boolean).join('/')
}

// 检查更新清单 key：<parent>/manifest.json
// （可被 cfg.manifestKey 完全覆盖，例：'wps-ai/manifest.json'）
function buildManifestKey(cfg) {
  if (cfg.manifestKey) return String(cfg.manifestKey).replace(/^\/+/, '')
  const parent = parentPrefix(cfg)
  return parent ? `${parent}/manifest.json` : 'manifest.json'
}

function buildPublicUrl(cfg, key) {
  if (cfg.cdnBaseUrl) return `${cfg.cdnBaseUrl}/${key}`
  return `https://${cfg.bucket}.${cfg.region}.aliyuncs.com/${key}`
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function uploadFile(client, cfg, filePath, key, { dryRun = false } = {}) {
  const stat = fs.statSync(filePath)
  const sizeStr = humanSize(stat.size)
  const publicUrl = buildPublicUrl(cfg, key)

  if (dryRun) {
    console.log(`  [dry-run] ${path.basename(filePath)} (${sizeStr}) → oss://${cfg.bucket}/${key}`)
    return { key, url: publicUrl, size: stat.size, dryRun: true }
  }

  console.log(`  上传 ${path.basename(filePath)} (${sizeStr}) → ${key}`)

  let lastPct = -1
  // 关键：bucket ACL=private 时必须给对象单独打 public-read，否则下载链接会 403。
  // 用户在 cfg.objectAcl='private' 时跳过（保留私桶语义）。
  const acl = cfg.objectAcl == null ? 'public-read' : String(cfg.objectAcl)
  const headers = { ...(cfg.headers || {}) }
  if (acl && acl !== 'inherit') headers['x-oss-object-acl'] = acl
  const result = await client.multipartUpload(key, filePath, {
    partSize: cfg.multipart.partSize,
    parallel: cfg.multipart.parallel,
    headers,
    progress: (p) => {
      const pct = Math.floor(p * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        process.stdout.write(`    进度 ${pct}%\r`)
        lastPct = pct
      }
    }
  })
  process.stdout.write('                    \r')
  console.log(`  ✓ 完成 → ${publicUrl}`)

  return { key, url: publicUrl, size: stat.size, etag: result.etag }
}

// manifest.json 这种小文件 + 文本不需要走 multipart；普通 put + 不带 attachment 头
async function uploadManifest(client, cfg, filePath, key, { dryRun = false } = {}) {
  const stat = fs.statSync(filePath)
  const publicUrl = buildPublicUrl(cfg, key)
  if (dryRun) {
    console.log(`  [dry-run] ${path.basename(filePath)} (${humanSize(stat.size)}) → oss://${cfg.bucket}/${key}`)
    return { key, url: publicUrl, size: stat.size, dryRun: true }
  }
  console.log(`  上传 ${path.basename(filePath)} (${humanSize(stat.size)}) → ${key}`)
  // manifest 要让浏览器直读（不要 attachment）；缓存时间短一点便于热修
  const acl = cfg.objectAcl == null ? 'public-read' : String(cfg.objectAcl)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300'
  }
  if (acl && acl !== 'inherit') headers['x-oss-object-acl'] = acl
  const result = await client.put(key, filePath, { headers })
  console.log(`  ✓ 完成 → ${publicUrl}`)
  return { key, url: publicUrl, size: stat.size, etag: result.etag || result.res?.headers?.etag }
}

module.exports = {
  loadConfig,
  createClient,
  buildKey,
  buildPluginZipKey,
  buildManifestKey,
  parentPrefix,
  buildPublicUrl,
  uploadFile,
  uploadManifest,
  humanSize
}
