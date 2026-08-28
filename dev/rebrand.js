#!/usr/bin/env node
/**
 * 品牌改名工具（全仓库、大小写保形、编码保形）
 *
 * 用法：
 *   node dev/rebrand.js "新品牌"           # 预演，只打印会改什么，不落盘
 *   node dev/rebrand.js "新品牌" --apply   # 真改
 *
 * 设计要点（改这个脚本前先读 docs/REBRAND.md）：
 *
 * 1. 当前品牌不写死。从 plugin/js/updater.js 第一行的
 *      // <品牌> AI 插件热更新
 *    里读出来。这样连续改两次名也不用改脚本。
 *
 * 2. 三种形态各自替换，大小写保形：
 *      UPPER  环境变量 / 常量        <LOWER>.toUpperCase() 且 - 换成 _
 *      Pascal 显示名 / C# 类名 / 目录  去掉空格
 *      lower  路径 / 服务名 / DOM id   小写且空格换成 -
 *    替换顺序固定 UPPER -> Pascal -> lower，全部大小写敏感，互不吃字符。
 *
 * 3. 旧品牌 lingxi / Lingxi / LINGXI / LingxiAI 是历史事实，
 *    散落在卸载脚本和进程匹配列表里，用来兼容从旧版升级上来的机器。
 *    它们**绝不能**被这个脚本扫掉。脚本收尾会核对旧品牌出现次数前后一致，
 *    对不上就整体回滚（--apply 下 git checkout）并报错。
 *
 * 4. 文件范围只取 git ls-files，所以 node_modules / dist / 未跟踪文件天然不会被碰。
 *    再排除 img/（图片）和 plugin/runtime/（厂商自带的 Node 发行版）。
 *    含 NUL 字节的文件按二进制跳过内容，只改文件名。
 *
 * 5. 编码保形。Windows 的 6 个 .bat 是 GBK，其余全是 UTF-8，
 *    改完必须按原编码写回去，否则 cmd 里中文全是乱码。GBK 编码依赖系统 iconv。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");

// ---- GBK 编码的 Windows 批处理。清单写死，因为它是事实而不是规则： ----
// plugin/tools/post-install-windows.bat 和 plugin/install-permanent-windows.bat
// 是 UTF-8，混进来会把中文写坏。改动清单前先跑 dev/rebrand.js --list-encodings。
const GBK_FILES = new Set([
  "plugin/install-windows.bat",
  "plugin/start-et.bat",
  "plugin/start-wpp.bat",
  "plugin/start-wps.bat",
  "plugin/uninstall-permanent-windows.bat",
  "plugin/tools/pre-uninstall-windows.bat",
]);

// 整目录排除：图片是二进制，runtime 是原样打包的 Node 发行版（里面的 nodevars.bat
// 之类跟我们的品牌无关，动了反而破坏 Node）。
const SKIP_DIRS = ["img/", "plugin/runtime/"];

// 旧品牌字面量。改名脚本必须对它们零影响，收尾用它做一致性断言。
const LEGACY_RE = /lingxi/gi;

function die(msg) {
  console.error("[X] " + msg);
  process.exit(1);
}

/** 从品牌显示名派生三种形态 */
function forms(display) {
  const lower = display.toLowerCase().replace(/\s+/g, "-");
  return {
    display,
    lower,
    pascal: display.replace(/\s+/g, ""),
    upper: lower.toUpperCase().replace(/-/g, "_"),
  };
}

/** 读当前品牌 */
function currentBrand() {
  const f = path.join(REPO, "plugin/js/updater.js");
  const first = fs.readFileSync(f, "utf8").split("\n")[0];
  const m = first.match(/^\/\/ (.+?) AI 插件热更新/);
  if (!m) {
    die(
      "读不出当前品牌：plugin/js/updater.js 第一行不是 `// <品牌> AI 插件热更新`。\n" +
        "    实际内容: " + JSON.stringify(first)
    );
  }
  return forms(m[1]);
}

function gitFiles() {
  return execFileSync("git", ["ls-files"], { cwd: REPO })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => !SKIP_DIRS.some((d) => f.startsWith(d)));
}

function decode(buf, rel) {
  if (GBK_FILES.has(rel)) return { text: new TextDecoder("gbk").decode(buf), gbk: true };
  return { text: new TextDecoder("utf-8").decode(buf), gbk: false };
}

let iconvChecked = false;
function encode(text, gbk) {
  if (!gbk) return Buffer.from(text, "utf8");
  if (!iconvChecked) {
    try {
      execFileSync("iconv", ["-l"], { stdio: "ignore" });
    } catch (e) {
      die(
        "系统没有 iconv，无法把 GBK 批处理写回去。\n" +
          "    Windows 上请在 WSL / Git Bash 里跑本脚本，或手工处理这 6 个文件：\n" +
          "    " + [...GBK_FILES].join("\n    ")
      );
    }
    iconvChecked = true;
  }
  const tmp = path.join(REPO, ".rebrand-gbk.tmp");
  fs.writeFileSync(tmp, text, "utf8");
  try {
    return execFileSync("iconv", ["-f", "UTF-8", "-t", "GBK", tmp]);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** 三形态替换。顺序固定，全部大小写敏感。 */
function rename(text, from, to) {
  return text
    .split(from.upper).join(to.upper)
    .split(from.pascal).join(to.pascal)
    .split(from.lower).join(to.lower);
}

function countLegacy(text) {
  return (text.match(LEGACY_RE) || []).length;
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const target = argv.filter((a) => !a.startsWith("--"))[0];

if (argv.includes("--list-encodings")) {
  for (const rel of gitFiles()) {
    if (!rel.endsWith(".bat")) continue;
    const buf = fs.readFileSync(path.join(REPO, rel));
    let enc = "GBK";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf);
      enc = "UTF-8";
    } catch (e) {
      /* 不是合法 UTF-8，按 GBK 记 */
    }
    console.log(enc.padEnd(6) + (GBK_FILES.has(rel) ? "清单内 " : "清单外 ") + rel);
  }
  process.exit(0);
}

if (!target) {
  die('用法: node dev/rebrand.js "新品牌" [--apply]');
}
if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(target)) {
  die(
    "新品牌只允许 ASCII 字母数字和空格，且以字母开头。\n" +
      "    它要落进环境变量名、LaunchAgent Label、注册表键名和 C# 标识符，中文和符号都过不去。"
  );
}
if (/lingxi/i.test(target)) {
  die("新品牌不能包含 lingxi —— 那是旧品牌，会和历史兼容逻辑撞车。");
}

const from = currentBrand();
const to = forms(target);

if (from.lower === to.lower) {
  die("新旧品牌相同（" + from.lower + "），无需改名。");
}

console.log("当前品牌: " + from.upper + " / " + from.pascal + " / " + from.lower);
console.log("目标品牌: " + to.upper + " / " + to.pascal + " / " + to.lower);
console.log(apply ? "模式: 落盘改名\n" : "模式: 预演（加 --apply 才真改）\n");

let legacyBefore = 0;
let legacyAfter = 0;
let changedFiles = 0;
let changedHits = 0;
const renames = [];

for (const rel of gitFiles()) {
  const abs = path.join(REPO, rel);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    continue; // 符号链接指向仓库外之类
  }

  // 文件名带品牌的，内容改不改都要 git mv
  const newRel = rename(rel, from, to);
  if (newRel !== rel) renames.push([rel, newRel]);

  if (buf.includes(0)) continue; // 二进制：只改名，不动内容

  const { text, gbk } = decode(buf, rel);
  legacyBefore += countLegacy(text);

  const out = rename(text, from, to);
  if (out === text) {
    legacyAfter += countLegacy(text);
    continue;
  }

  legacyAfter += countLegacy(out);
  const hits =
    (text.split(from.upper).length - 1) +
    (text.split(from.pascal).length - 1) +
    (text.split(from.lower).length - 1);
  changedFiles++;
  changedHits += hits;
  console.log("  " + String(hits).padStart(4) + " 处  " + rel + (gbk ? "  [GBK]" : ""));

  if (apply) fs.writeFileSync(abs, encode(out, gbk));
}

// ---- 旧品牌一致性断言 ----
// 改名不应该动到任何 lingxi 字面量。数量对不上说明替换规则吃到了历史兼容逻辑。
if (legacyBefore !== legacyAfter) {
  console.error(
    "\n[X] 旧品牌字面量被改动了：改名前 " + legacyBefore + " 处，改名后 " + legacyAfter + " 处。"
  );
  if (apply) {
    console.error("    正在回滚……");
    execFileSync("git", ["checkout", "--", "."], { cwd: REPO, stdio: "inherit" });
    console.error("    已回滚。");
  }
  die("请检查 docs/REBRAND.md 的「受保护字面量」一节。");
}

if (apply) {
  for (const [oldRel, newRel] of renames) {
    fs.mkdirSync(path.dirname(path.join(REPO, newRel)), { recursive: true });
    execFileSync("git", ["mv", oldRel, newRel], { cwd: REPO });
  }
}
for (const [oldRel, newRel] of renames) {
  console.log("  改名  " + oldRel + "  ->  " + newRel);
}

console.log(
  "\n合计: " + changedHits + " 处替换，" + changedFiles + " 个文件，" +
    renames.length + " 个文件重命名。旧品牌字面量 " + legacyBefore + " 处，未受影响。"
);

if (!apply) {
  console.log('\n确认无误后加 --apply 重跑：node dev/rebrand.js "' + target + '" --apply');
} else {
  console.log("\n下一步（docs/REBRAND.md「改完之后」一节）：");
  console.log("  1. cd plugin && node --test $(ls test/*.test.js | tr '\\n' ' ')");
  console.log("  2. 重新生成宿主变体并重装服务");
  console.log("  3. git diff --stat 复核，确认没有 plugin/runtime/ 和 img/ 下的改动");
}
