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
  // wpsjs 实际写两个文件：
  //   publish.xml  → wpsjs publish 用，含 enable="enable_dev"
  //   jsplugins.xml → wpsjs debug 用，含 debug="code"  ← 这个才是按钮真正的触发字段
  // 都要 patch。
  const fileNames = ["jsplugins.xml", "publish.xml"];
  const dirs = isWindows
    ? [
        path.join(process.env.APPDATA || "", "kingsoft", "wps", "jsaddons")
      ]
    : [
        path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac/Data/.kingsoft/wps/jsaddons"),
        path.join(os.homedir(), "Library/Containers/com.kingsoft.wpsoffice.mac.global/Data/.kingsoft/wps/jsaddons"),
        path.join(os.homedir(), ".local/share/Kingsoft/wps/jsaddons")
      ];
  const candidates = [];
  dirs.forEach((d) => fileNames.forEach((n) => candidates.push(path.join(d, n))));

  let warnedRestart = false;

  function patch(fp, source) {
    try {
      if (!fs.existsSync(fp)) return false;
      const raw = fs.readFileSync(fp, "utf8");
      // 触发"打开JS调试器"按钮的三种字段：
      //   debug="code" / debug="..."（非空）/ enable="enable_dev"
      // 全部清掉即可（去掉 debug 属性 + 把 enable_dev 改成 enable）
      const needPatch = /debug="[^"]+"/.test(raw) || raw.includes('enable="enable_dev"');
      if (!needPatch) return false;
      let patched = raw
        .replace(/\s+debug="[^"]*"/g, "")          // 去掉整个 debug="..." 属性
        .replace(/enable="enable_dev"/g, 'enable="enable"');
      fs.writeFileSync(fp, patched, "utf8");
      process.stdout.write(`\x1b[33m[dev]\x1b[0m 已隐藏"打开JS调试器"按钮（${source}: ${fp}）\n`);
      if (!warnedRestart) {
        warnedRestart = true;
        process.stdout.write(`\x1b[33m[dev]\x1b[0m 如果 WPS 已经在跑，按钮要等下次启动 WPS 才会消失\n`);
      }
      return true;
    } catch (e) { return false; }
  }

  // 1) 启动时立刻 patch 一遍（应对文件已经存在的情况）
  candidates.forEach((fp) => patch(fp, "startup"));

  // 2) 给每个候选路径的父目录挂 fs.watch；wpsjs 后续写 publish.xml 会立即触发
  const watchers = [];
  candidates.forEach((fp) => {
    const dir = path.dirname(fp);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try {
      const w = fs.watch(dir, (eventType, filename) => {
        if (filename !== "publish.xml") return;
        setTimeout(() => patch(fp, "watch"), 50); // 给 wpsjs 一点时间完成写入
      });
      watchers.push(w);
    } catch (e) { /* 某些路径不存在或无权限 */ }
  });

  // 3) 兜底：再低频轮询 30s，万一 fs.watch 漏触发
  let ticks = 0;
  const fallback = setInterval(() => {
    ticks += 1;
    candidates.forEach((fp) => patch(fp, "poll-" + ticks));
    if (ticks >= 30) {
      clearInterval(fallback);
      watchers.forEach((w) => { try { w.close(); } catch (e) {} });
    }
  }, 1000);
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
