// 把 site/utils/release.ts 的 VERSION 同步到所有版本号载体文件。
// release.ts 是单一真相源 —— 升级一行就够，其它跟着走。
//
// 同步目标：
//   plugin/package.json         "version": "X.Y.Z"   ← loadVersionInfo 读这个显示在 UI
//   plugin/manifest.json        "version": "X.Y.Z"
//   installer/anthony-ai.iss     #define MyAppVersion "X.Y.Z"  + 注释里的 setup 文件名

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

// 单文件单字段更新策略 —— 各自正则替换
const TARGETS = [
  {
    label: 'plugin/package.json',
    file: path.join(ROOT, 'plugin', 'package.json'),
    read: (raw) => {
      const m = raw.match(/"version"\s*:\s*"([^"]+)"/)
      return m ? m[1] : null
    },
    write: (raw, version) => raw.replace(/"version"\s*:\s*"([^"]+)"/, `"version": "${version}"`)
  },
  {
    label: 'plugin/manifest.json',
    file: path.join(ROOT, 'plugin', 'manifest.json'),
    read: (raw) => {
      const m = raw.match(/"version"\s*:\s*"([^"]+)"/)
      return m ? m[1] : null
    },
    write: (raw, version) => raw.replace(/"version"\s*:\s*"([^"]+)"/, `"version": "${version}"`)
  },
  {
    label: 'installer/anthony-ai.iss',
    file: path.join(ROOT, 'installer', 'anthony-ai.iss'),
    read: (raw) => {
      const m = raw.match(/#define\s+MyAppVersion\s+"([^"]+)"/)
      return m ? m[1] : null
    },
    write: (raw, version) => raw
      // #define MyAppVersion "X.Y.Z"
      .replace(/(#define\s+MyAppVersion\s+")([^"]+)(")/, `$1${version}$3`)
      // 注释里 ; 产物：dist\lingxi-ai-X.Y.Z-setup.exe
      .replace(/(dist[\\/]lingxi-ai-)([0-9][^\s-]*)(-setup\.exe)/g, `$1${version}$3`)
  }
]

// check=true 只查不写，返回 mismatches 列表；check=false 实际写盘
function syncVersions(targetVersion, { check = false } = {}) {
  const result = { synced: [], unchanged: [], missing: [], mismatches: [] }
  for (const t of TARGETS) {
    if (!fs.existsSync(t.file)) {
      result.missing.push(t.label)
      continue
    }
    const raw = fs.readFileSync(t.file, 'utf8')
    const cur = t.read(raw)
    if (cur == null) {
      result.missing.push(`${t.label} (匹配不到 version 字段)`)
      continue
    }
    if (cur === targetVersion) {
      result.unchanged.push(t.label)
      continue
    }
    // 不一致
    result.mismatches.push({ label: t.label, current: cur, target: targetVersion })
    if (!check) {
      const next = t.write(raw, targetVersion)
      if (next === raw) {
        // 写函数没找到目标 → 算 missing 兜底
        result.missing.push(`${t.label} (write 没匹配到任何位置)`)
        continue
      }
      fs.writeFileSync(t.file, next, 'utf8')
      result.synced.push({ label: t.label, from: cur, to: targetVersion })
    }
  }
  return result
}

module.exports = { syncVersions, TARGETS }
