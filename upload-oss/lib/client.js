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
  const result = await client.multipartUpload(key, filePath, {
    partSize: cfg.multipart.partSize,
    parallel: cfg.multipart.parallel,
    headers: cfg.headers,
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

module.exports = {
  loadConfig,
  createClient,
  buildKey,
  buildPublicUrl,
  uploadFile,
  humanSize
}
