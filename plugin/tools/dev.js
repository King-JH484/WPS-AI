#!/usr/bin/env node
/**
 * 跨平台并发启动 CORS 代理 + wpsjs debug。
 *
 * 替代旧的 bash-only 脚本：
 *   "node tools/proxy-server.js & wpsjs debug; kill %1 2>/dev/null"
 *
 * 在 Windows cmd 上 `&` 是顺序执行而非并发，会导致 wpsjs debug 永远不启动。
 * 这个脚本统一用 child_process.spawn 并发跑两个进程，Ctrl-C 时一起结束。
 */

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const isWindows = os.platform() === "win32";

/**
 * wpsjs debug 会自动往 WPS 加载项配置里写 enable="enable_dev"，
 * WPS 见状会塞个"打开JS调试器"按钮。开发期不需要它（我们用浏览器
 * 自带的 DevTools 调）。这个函数轮询找到 wpsjs 写的 publish.xml，
 * 把 enable_dev 静默换成 enable 把按钮藏掉。
 */
function suppressDevDebugButton() {
  const candidates = isWindows
    ? [
        path.join(process.env.APPDATA || "", "kingsoft", "wps", "jsaddons", "publish.xml")
      ]
    : [
        path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons/publish.xml"),
        path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons/publish.xml"),
        path.join(os.homedir(), ".local/share/Kingsoft/wps/jsaddons/publish.xml")
      ];

  let attempts = 0;
  const maxAttempts = 30; // 最多探测 ~15 秒
  const timer = setInterval(() => {
    attempts += 1;
    let anyTouched = false;
    for (const fp of candidates) {
      try {
        if (!fs.existsSync(fp)) continue;
        const raw = fs.readFileSync(fp, "utf8");
        if (!raw.includes('enable="enable_dev"')) continue;
        const patched = raw.replace(/enable="enable_dev"/g, 'enable="enable"');
        fs.writeFileSync(fp, patched, "utf8");
        process.stdout.write(`\x1b[33m[dev]\x1b[0m 已隐藏"打开JS调试器"按钮（改写 ${fp}）\n`);
        anyTouched = true;
      } catch (e) { /* ignore */ }
    }
    if (anyTouched || attempts >= maxAttempts) clearInterval(timer);
  }, 500);
}

function spawnLabeled(label, color, command, args, cwd) {
  // Windows 上 .cmd / .bat 必须 shell:true 才能解析
  const child = spawn(command, args, {
    cwd,
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const wire = (stream, target) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        target.write(prefix + line + "\n");
      }
    });
    stream.on("end", () => {
      if (buf) target.write(prefix + buf + "\n");
    });
  };

  wire(child.stdout, process.stdout);
  wire(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    process.stdout.write(prefix + `进程退出 code=${code} signal=${signal}\n`);
  });

  return child;
}

const cwd = process.cwd();

const proxy = spawnLabeled(
  "proxy",
  "36", // 青色
  process.execPath,
  [path.resolve(cwd, "tools/proxy-server.js")],
  cwd
);

const wpsjs = spawnLabeled(
  "wpsjs",
  "32", // 绿色
  isWindows ? "wpsjs.cmd" : "wpsjs",
  ["debug"],
  cwd
);

// wpsjs debug 会在某个时刻写 publish.xml，我们等它落盘后把 enable_dev 替换掉
suppressDevDebugButton();

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n[dev] 关闭中（${reason}）...\n`);
  for (const child of [proxy, wpsjs]) {
    if (child && !child.killed) {
      try {
        if (isWindows) {
          // Windows 下 child_process kill 经常无法终止 shell 子进程，强制 taskkill
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
        } else {
          child.kill("SIGTERM");
        }
      } catch (error) { /* ignore */ }
    }
  }
  setTimeout(() => process.exit(0), 800);
}

process.on("SIGINT", () => shutdown("Ctrl-C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 任意子进程崩溃时一起退出，避免端口悬挂
proxy.on("exit", (code) => { if (!shuttingDown && code !== 0) shutdown(`proxy 退出 code=${code}`); });
wpsjs.on("exit", (code) => { if (!shuttingDown && code !== 0) shutdown(`wpsjs 退出 code=${code}`); });
