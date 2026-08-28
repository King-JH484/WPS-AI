// 把 plugin/ 目录打包成 plugin.zip（用于 /update/apply 热更新覆盖）
//
// 实现策略：
//   1. 把 plugin/ 下的文件按 EXCLUDES 过滤后复制到 tmp 暂存目录
//   2. 调系统自带 zip / PowerShell Compress-Archive 打成 zip
//   3. 清理 tmp
// 不引外部 zip 依赖，跟 proxy-server.js 的解压侧保持一致（用 native 工具）。

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

// 这些路径在 plugin/ 内部，热更新不应该带，理由：
//   node_modules / runtime → 太大且本地状态；proxy-server.js 解压侧也走 KEEP_LOCAL 跳过
//   .git / .DS_Store / *.log / *.swp / .vscode → 工具/系统垃圾
//   .gen → tools 下生成中间产物，热更新不需要
const EXCLUDE_NAMES = new Set([
  'node_modules', 'runtime', '.git', '.DS_Store', '.vscode', '.idea', '.gen'
])
const EXCLUDE_SUFFIX = ['.log', '.swp', '.tmp']

function shouldSkip(relPath, filename) {
  if (EXCLUDE_NAMES.has(filename)) return true
  if (EXCLUDE_SUFFIX.some((s) => filename.endsWith(s))) return true
  return false
}

function copyTree(src, dst, baseLen) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const name of fs.readdirSync(src)) {
      const childSrc = path.join(src, name)
      const rel = childSrc.slice(baseLen).replace(/^[\\/]/, '')
      if (shouldSkip(rel, name)) continue
      copyTree(childSrc, path.join(dst, name), baseLen)
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dst)
  }
}

function runZip(stageDir, outZip) {
  // 跨平台：windows 用 PowerShell Compress-Archive；mac/linux 用 zip
  if (process.platform === 'win32') {
    // 确保 outZip 不存在（Compress-Archive 不覆盖时会报错）
    try { fs.unlinkSync(outZip) } catch (e) {}
    // Compress-Archive 的 -Path 用 `<stage>\*` 把内容打包到根（不套一层目录）
    const ps = [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${path.join(stageDir, '*').replace(/'/g, "''")}' ` +
      `-DestinationPath '${outZip.replace(/'/g, "''")}' -Force`
    ]
    const r = spawnSync('powershell.exe', ps, { encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`Compress-Archive 失败: ${r.stderr || r.stdout}`)
    }
  } else {
    // -r 递归 -q 安静 -X 不存额外属性。在 stageDir 里跑，让 zip 路径不带 stage 前缀。
    const r = spawnSync('zip', ['-r', '-q', '-X', outZip, '.'], {
      cwd: stageDir,
      encoding: 'utf8'
    })
    if (r.status !== 0) {
      throw new Error(`zip 失败: ${r.stderr || r.stdout}`)
    }
  }
}

function buildPluginZip({ pluginRoot, version, outDir }) {
  if (!fs.existsSync(pluginRoot)) {
    throw new Error(`plugin 根目录不存在：${pluginRoot}`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const outZip = path.resolve(outDir, `plugin-${version}.zip`)

  const stageDir = path.join(os.tmpdir(), `anthony-plugin-zip-${Date.now()}`)
  fs.mkdirSync(stageDir, { recursive: true })

  try {
    copyTree(pluginRoot, stageDir, pluginRoot.length)
    runZip(stageDir, outZip)
    const stat = fs.statSync(outZip)
    return { zipPath: outZip, size: stat.size }
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch (e) {}
  }
}

module.exports = { buildPluginZip }
