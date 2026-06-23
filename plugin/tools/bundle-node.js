#!/usr/bin/env node
/**
 * 下载 portable Node.js 二进制到 plugin/runtime/<platform>/
 * 给 GUI 安装器（Inno Setup）打包 / 用户机器没装 Node 也能跑。
 *
 * 用法：
 *   node tools/bundle-node.js           # 默认下当前平台 (NODE_PLATFORM=auto)
 *   node tools/bundle-node.js --all     # win-x64 + darwin-x64 + darwin-arm64 三平台全下
 *   node tools/bundle-node.js --version v22.11.0
 *
 * 输出目录：
 *   plugin/runtime/node-win-x64/node.exe
 *   plugin/runtime/node-darwin-x64/bin/node
 *   plugin/runtime/node-darwin-arm64/bin/node
 *   plugin/runtime/node-linux-x64/bin/node
 *   plugin/runtime/node-linux-arm64/bin/node
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

const DEFAULT_VERSION = "v22.11.0";   // LTS 时刻；可用 --version 覆盖
const MIRROR = "https://nodejs.org/dist";
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = path.join(ROOT, "runtime");

function parseArgs() {
  const args = process.argv.slice(2);
  let version = DEFAULT_VERSION;
  let all = false;
  const platforms = []; // 指定一个或多个 --platform 后该数组非空，覆盖默认行为
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--all") all = true;
    else if (args[i] === "--version" && args[i + 1]) { version = args[i + 1]; i += 1; }
    else if (args[i] === "--platform" && args[i + 1]) { platforms.push(args[i + 1]); i += 1; }
  }
  return { version, all, platforms };
}

// 平台 → { fileSuffix, archiveExt, outDir }
const PLATFORM_MAP = {
  "win-x64":      { archive: "win-x64.zip",         outDir: "node-win-x64" },
  "darwin-x64":   { archive: "darwin-x64.tar.gz",   outDir: "node-darwin-x64" },
  "darwin-arm64": { archive: "darwin-arm64.tar.gz", outDir: "node-darwin-arm64" },
  "linux-x64":    { archive: "linux-x64.tar.xz",    outDir: "node-linux-x64" },
  "linux-arm64":  { archive: "linux-arm64.tar.xz",  outDir: "node-linux-arm64" }
};

function detectPlatform() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return "win-x64";
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "linux")  return a === "arm64" ? "linux-arm64"  : "linux-x64";
  throw new Error(`不支持的平台 ${p}/${a}，请用 --all 或显式指定`);
}

function download(url, destFile) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destFile);
    let receivedBytes = 0;
    let totalBytes = 0;
    let lastReported = 0;
    const handle = (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(destFile);
        return download(res.headers.location, destFile).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destFile);
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      res.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (totalBytes && receivedBytes - lastReported > totalBytes / 20) {
          lastReported = receivedBytes;
          const pct = Math.round((receivedBytes / totalBytes) * 100);
          process.stdout.write(`\r  下载中... ${pct}% (${(receivedBytes/1024/1024).toFixed(1)}MB / ${(totalBytes/1024/1024).toFixed(1)}MB)`);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        process.stdout.write("\r  下载完成: " + (receivedBytes/1024/1024).toFixed(1) + " MB                          \n");
        file.close(() => resolve());
      });
    };
    https.get(url, handle).on("error", (err) => {
      file.close(); try { fs.unlinkSync(destFile); } catch (_) {}
      reject(err);
    });
  });
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

// 用系统 tar 解 .tar.gz / .tar.xz（Win10+ / Mac / Linux 都自带 tar; xz 在 Linux/Mac 普遍内置,Win10+ 也支持）
function extractTar(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // tar 会按文件名自动检测压缩格式(--auto-compress),所以不用区分 -z/-J
  execFileSync("tar", ["-xf", archive, "-C", outDir, "--strip-components=1"], { stdio: "inherit" });
}

// 解 zip：用 PowerShell Expand-Archive（Win）或 unzip（Mac/Linux 退路）
function extractZip(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // 解到临时目录再把内层（node-vXX-win-x64/）的内容移到 outDir
  const tmp = path.join(os.tmpdir(), "lingxi-node-extract-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`], { stdio: "inherit" });
    } else {
      execFileSync("unzip", ["-q", archive, "-d", tmp], { stdio: "inherit" });
    }
    // 找到那个唯一的子目录 node-vXX-win-x64
    const subs = fs.readdirSync(tmp).filter((n) => fs.statSync(path.join(tmp, n)).isDirectory());
    if (subs.length === 0) throw new Error("zip 解压结果异常，没有子目录");
    const inner = path.join(tmp, subs[0]);
    // 把内层目录"提升"到 outDir。跨盘符不能 rename,用复制
    for (const name of fs.readdirSync(inner)) {
      const src = path.join(inner, name);
      const dst = path.join(outDir, name);
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        if (e.code === "EXDEV") {
          // 跨设备：递归 cpSync（Node >= 16.7）
          fs.cpSync(src, dst, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
        } else { throw e; }
      }
    }
  } finally {
    rmrf(tmp);
  }
}

async function bundleOne(platform, version) {
  const spec = PLATFORM_MAP[platform];
  if (!spec) throw new Error("未知平台: " + platform);

  const filename = `node-${version}-${spec.archive}`;
  const url = `${MIRROR}/${version}/${filename}`;
  const outDir = path.join(RUNTIME_ROOT, spec.outDir);
  const cacheArchive = path.join(os.tmpdir(), filename);

  console.log(`\n[bundle-node] 平台: ${platform}, 版本: ${version}`);
  console.log(`              输出: ${outDir}`);

  // 如果 outDir 已经有 node 二进制，跳过
  const nodeBinPath = platform.startsWith("win-")
    ? path.join(outDir, "node.exe")
    : path.join(outDir, "bin", "node");
  if (fs.existsSync(nodeBinPath)) {
    console.log(`  已存在,跳过: ${nodeBinPath}`);
    return;
  }

  // 下载
  if (!fs.existsSync(cacheArchive)) {
    console.log(`  下载: ${url}`);
    await download(url, cacheArchive);
  } else {
    console.log(`  用缓存: ${cacheArchive}`);
  }

  // 清旧 outDir 然后解压
  rmrf(outDir);
  if (spec.archive.endsWith(".zip")) extractZip(cacheArchive, outDir);
  else extractTar(cacheArchive, outDir);

  if (!fs.existsSync(nodeBinPath)) {
    throw new Error("解压完没找到 node 二进制: " + nodeBinPath);
  }
  const size = fs.statSync(nodeBinPath).size;
  console.log(`  完成: ${nodeBinPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  const { version, all, platforms } = parseArgs();
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  let targets;
  if (platforms.length > 0) {
    const unknown = platforms.filter((p) => !PLATFORM_MAP[p]);
    if (unknown.length > 0) {
      console.error(`[bundle-node] 不支持的平台 key：${unknown.join(', ')}`);
      console.error(`  可选：${Object.keys(PLATFORM_MAP).join(' / ')}`);
      process.exit(1);
    }
    targets = platforms;
  } else {
    targets = all ? Object.keys(PLATFORM_MAP) : [detectPlatform()];
  }
  for (const p of targets) {
    try {
      await bundleOne(p, version);
    } catch (e) {
      console.error(`[bundle-node] 平台 ${p} 失败: ${e.message}`);
    }
  }
  console.log("\n[bundle-node] 全部处理完毕");
}

main().catch((e) => { console.error(e); process.exit(1); });
