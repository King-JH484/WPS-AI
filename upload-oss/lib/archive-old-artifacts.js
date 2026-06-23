// 打包/上传前把 dist/ 里属于"非本次版本"的产物搬到 distback/，避免：
//   - upload-oss 扫到旧版本一起传
//   - 切换版本时人为误传
// 不删，只搬；distback/ gitignored，需要时还能找回来。

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const DIST_DIR = path.join(ROOT, 'dist')
const BACKUP_DIR = path.join(ROOT, 'distback')

// 这些前缀的文件视为"版本化产物"。带版本号说明属于某一次发布，
// 不属于当前版本的就归档。其它文件（比如临时下载文件、用户手贴的东西）不动。
const VERSIONED_PREFIXES = [
  /^lingxi-ai[-_]/i,   // 安装包：lingxi-ai-X.Y.Z-... / lingxi-ai_X.Y.Z_...
  /^plugin-/i,         // 热更新包：plugin-X.Y.Z.zip
  /^manifest-/i        // 历史 manifest 快照（如果以后归档过）
]

function isVersionedArtifact(filename) {
  return VERSIONED_PREFIXES.some((re) => re.test(filename))
}

// 文件名里包含 version 字符串就算"属于本版本"。
// version=1.4.4 时 lingxi-ai-1.4.4-setup.exe / plugin-1.4.4.zip 都保留；
// lingxi-ai-1.4.3-setup.exe 移走。
function belongsToVersion(filename, version) {
  return filename.includes(version)
}

function archiveOldArtifacts(version) {
  if (!fs.existsSync(DIST_DIR)) return { moved: [], kept: [] }
  const moved = []
  const kept = []
  const all = fs.readdirSync(DIST_DIR)
  for (const name of all) {
    const src = path.join(DIST_DIR, name)
    // 只搬文件，目录不动
    try {
      const st = fs.statSync(src)
      if (!st.isFile()) continue
    } catch (e) { continue }

    if (!isVersionedArtifact(name)) {
      // 非版本化文件（比如 manifest.json 这种），保留
      kept.push(name)
      continue
    }
    if (belongsToVersion(name, version)) {
      kept.push(name)
      continue
    }
    // 是版本化产物且非本版本 → 移到 distback/
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const dst = path.join(BACKUP_DIR, name)
    // 如果 backup 里已经有同名文件，加时间戳后缀避免覆盖
    let finalDst = dst
    if (fs.existsSync(dst)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      finalDst = dst.replace(/(\.[^.]+(?:\.gz)?)$/, `-${ts}$1`)
    }
    fs.renameSync(src, finalDst)
    moved.push({ name, to: path.relative(ROOT, finalDst) })
  }
  if (moved.length > 0) {
    console.log(`[archive] 把 ${moved.length} 个旧版本产物从 dist/ 移到 distback/：`)
    moved.forEach((m) => console.log(`  ${m.name} → ${m.to}`))
  }
  return { moved, kept }
}

module.exports = { archiveOldArtifacts, DIST_DIR, BACKUP_DIR }
