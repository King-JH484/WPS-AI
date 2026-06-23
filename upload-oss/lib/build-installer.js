#!/usr/bin/env node
// 三端安装包打包入口，npm run build:win / build:mac / build:linux 调它。
//
// 流程：
//   1. 跑 syncVersions —— 把 release.ts 的 VERSION 写到 package.json / manifest.json / iss
//   2. 检查目标平台对应的 portable Node 是否就绪；缺就跑 plugin/tools/bundle-node.js 下载
//   3. 调对应原生构建脚本：
//        win   → ISCC.exe + installer/lingxi-ai.iss            产物 dist/lingxi-ai-<v>-setup.exe
//        mac   → bash installer-mac/build-dmg.sh                产物 dist/lingxi-ai-<v>-mac.dmg
//        linux → bash installer-linux/build.sh [--arch x64]     产物 dist/lingxi-ai-*-{tar.gz,deb,rpm}
//
// 用法：
//   node lib/build-installer.js win
//   node lib/build-installer.js mac
//   node lib/build-installer.js linux               # 默认 x64 全格式
//   node lib/build-installer.js linux --arch arm64

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const { syncVersions } = require('./sync-versions')
const { archiveOldArtifacts } = require('./archive-old-artifacts')

function readReleaseVersion() {
  const fp = path.join(ROOT, 'site', 'utils', 'release.ts')
  const m = fs.readFileSync(fp, 'utf8').match(/VERSION\s*=\s*['"]([^'"]+)['"]/)
  if (!m) throw new Error('site/utils/release.ts 里找不到 VERSION')
  return m[1]
}

// 检查并按需补齐 plugin/runtime/node-<platform>/<binary>
// 缺就跑 plugin/tools/bundle-node.js 下载对应平台的 portable Node
function ensureNodeRuntime(platforms) {
  const map = {
    'win-x64':      { dir: 'node-win-x64',      probe: 'node.exe' },
    'darwin-x64':   { dir: 'node-darwin-x64',   probe: 'bin/node' },
    'darwin-arm64': { dir: 'node-darwin-arm64', probe: 'bin/node' },
    'linux-x64':    { dir: 'node-linux-x64',    probe: 'bin/node' },
    'linux-arm64':  { dir: 'node-linux-arm64',  probe: 'bin/node' }
  }
  const missing = []
  for (const p of platforms) {
    const cfg = map[p]
    if (!cfg) throw new Error(`不支持的平台 key：${p}`)
    const probe = path.join(ROOT, 'plugin', 'runtime', cfg.dir, cfg.probe)
    if (!fs.existsSync(probe)) missing.push(p)
  }
  if (missing.length === 0) return
  console.log(`[build] 缺少内置 Node 运行时：${missing.join(', ')}，调 bundle-node.js 下载...`)
  for (const p of missing) {
    const r = spawnSync(process.execPath, [
      path.join('tools', 'bundle-node.js'),
      '--platform', p
    ], { cwd: path.join(ROOT, 'plugin'), stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`bundle-node.js 下载 ${p} 失败`)
  }
}

function findISCC() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 5', 'ISCC.exe')
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

function buildWin(version) {
  if (process.platform !== 'win32') {
    console.error('[build:win] 必须在 Windows 上跑（依赖 Inno Setup ISCC.exe）')
    process.exit(1)
  }
  const iscc = findISCC()
  if (!iscc) {
    console.error('[build:win] 找不到 ISCC.exe。装 Inno Setup 6: https://jrsoftware.org/isdl.php')
    process.exit(1)
  }
  ensureNodeRuntime(['win-x64'])
  archiveOldArtifacts(version)
  console.log(`[build:win] ISCC: ${iscc}`)
  const issPath = path.join(ROOT, 'installer', 'lingxi-ai.iss')
  const r = spawnSync(iscc, [issPath], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`[build:win] ✓ dist/lingxi-ai-${version}-setup.exe`)
}

function buildMac(version) {
  if (process.platform !== 'darwin') {
    console.error('[build:mac] 必须在 macOS 上跑（依赖 pkgbuild / productbuild / hdiutil）')
    process.exit(1)
  }
  ensureNodeRuntime(['darwin-x64', 'darwin-arm64'])
  archiveOldArtifacts(version)
  const script = path.join(ROOT, 'installer-mac', 'build-dmg.sh')
  const r = spawnSync('bash', [script, '--version', version], {
    stdio: 'inherit',
    cwd: path.dirname(script)
  })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`[build:mac] ✓ dist/lingxi-ai-${version}-mac.dmg / dist/lingxi-ai-${version}.pkg`)
}

function buildLinux(version, extraArgs) {
  if (process.platform === 'win32') {
    console.error('[build:linux] Windows 上跑不了（依赖 dpkg-deb / rpmbuild）。请在 Linux 或 WSL 里跑。')
    process.exit(1)
  }
  // arch 默认 x64，可通过 --arch 覆盖
  const arch = (() => {
    const i = extraArgs.indexOf('--arch')
    return i >= 0 && extraArgs[i + 1] ? extraArgs[i + 1] : 'x64'
  })()
  const platKey = arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  ensureNodeRuntime([platKey])
  archiveOldArtifacts(version)

  // Pre-flight：检查打包工具。注意 Mac 上 brew rpm 跨平台 build 不通（rpmrc 默认
  // 只识 Darwin 架构），所以 Mac 上 .rpm 必须走 fpm。Linux 上优先 rpmbuild + dpkg-deb。
  const has = (cmd) => spawnSync('command', ['-v', cmd], { shell: true }).status === 0
  const hasDpkg = has('dpkg-deb')
  const hasRpmbuild = has('rpmbuild')
  const hasFpm  = has('fpm')
  const canDeb = hasDpkg
  // Mac 上只信 fpm 打 rpm；Linux 上 rpmbuild / fpm 任一即可
  const canRpm = process.platform === 'darwin' ? hasFpm : (hasRpmbuild || hasFpm)

  if (!canDeb || !canRpm) {
    console.log('')
    console.log('⚠️  [build:linux] 缺工具，对应格式会被跳过：')
    if (!canDeb) console.log('     - .deb 需要 dpkg-deb')
    if (!canRpm) console.log(`     - .rpm 需要 ${process.platform === 'darwin' ? 'fpm (Mac 上 brew rpm 跨平台 build 走不通)' : 'rpmbuild 或 fpm'}`)
    console.log('')
    if (process.platform === 'darwin') {
      console.log('   Mac 装齐（需要 Homebrew）：')
      if (!canDeb) console.log('     brew install dpkg')
      if (!canRpm) console.log('     brew install fpm')
    } else {
      console.log('   Linux 装齐：')
      if (!canDeb) console.log('     sudo apt install dpkg-dev   # Debian/Ubuntu')
      if (!canRpm) console.log('     sudo dnf install rpm-build  # Fedora/openEuler/Anolis  或  sudo apt install rpm  # Debian/Ubuntu  或  sudo gem install fpm')
    }
    console.log('   装完重跑 npm run build:linux 即可。')
    console.log('   坚持跑下去会只产 tar.gz（依然可分发，国产发行版能用）。')
    console.log('')
  }

  const script = path.join(ROOT, 'installer-linux', 'build.sh')
  const r = spawnSync('bash', [script, '--version', version, ...extraArgs], {
    stdio: 'inherit',
    cwd: path.dirname(script)
  })
  if (r.status !== 0) process.exit(r.status || 1)
  console.log(`[build:linux] ✓ dist/lingxi-ai-${version}-linux-${arch} (.tar.gz${hasDpkg ? ' / .deb' : ''}${hasRpm ? ' / .rpm' : ''})`)
}

function main() {
  const argv = process.argv.slice(2)
  const target = argv[0]
  const rest = argv.slice(1)
  if (!['win', 'mac', 'linux'].includes(target)) {
    console.error('用法：node lib/build-installer.js <win|mac|linux> [extra args]')
    process.exit(1)
  }

  // 同步版本号（release.ts → package.json / manifest.json / iss）
  const version = readReleaseVersion()
  console.log(`\n=== build:${target} v${version} ===\n`)
  const r = syncVersions(version, { check: false })
  if (r.synced.length > 0) {
    console.log('版本号同步：')
    r.synced.forEach((s) => console.log(`  ✓ ${s.label}  ${s.from} → ${s.to}`))
    console.log('')
  }
  if (r.missing.length > 0) {
    console.warn(`⚠️ 未匹配 version 字段：${r.missing.join(', ')}`)
  }

  if (target === 'win')   buildWin(version)
  if (target === 'mac')   buildMac(version)
  if (target === 'linux') buildLinux(version, rest)
}

main()
