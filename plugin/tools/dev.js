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
 * 历史上这里会把 jsplugins.xml / publish.xml 里的 debug="code" 和 enable="enable_dev"
 * 静默改掉，目的是藏掉 WPS ribbon 上自动塞进来的「打开JS调试器」按钮。
 *
 * 但这两个属性同时是 WPS DevTools 子系统的总开关 —— 清掉之后 jsapi 的
 * Application.Options.ShowDevTools = true 会变成静默 no-op（设置面板里的
 * 「打开 JS 调试器」按钮也就跟着废了）。
 *
 * 结论：不能两头通吃。优先保留 DevTools 能力，ribbon 上多一个原生按钮可以接受。
 * 这里保留函数桩做兜底（万一历史 patch 已经写花了 xml，恢复一下），但不再
 * 主动清属性。
 */
function suppressDevDebugButton() {
  // no-op：保留 enable_dev / debug 属性，让 WPS DevTools 子系统启用，
  // 设置面板里的「打开 JS 调试器」按钮才能真的弹窗。
  // 原生 ribbon 按钮重复展示但功能正常，dev 环境可接受。
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
