const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// i18n 覆盖率守卫：新增用户可见中文文案必须同步配英文词条。
// 扫描面：taskpane.html 静态文本/属性 + 全部 UI JS 的 HTML 模板文本节点/属性/
// textContent/placeholder/title 赋值/showMessage/confirm/alert 静态串。
// 刻意不翻的（PPT 主题风格名、双语写死、动态碎片）走 SKIP 规则。

const ROOT = path.join(__dirname, "..");

function loadDict() {
  const win = {};
  new Function("window", fs.readFileSync(path.join(ROOT, "js", "i18n.js"), "utf8"))(win);
  return win.WpsAiI18n._dict;
}

const CODE_NOISE = (s) =>
  /[=;{}\\]/.test(s) ||
  /=>|&&|\|\||Math\.|String\(|parseInt|escapeHtml|\.join|\.map|\$\{/.test(s) ||
  /\+ '|' \+|" \+|\+ "/.test(s) ||
  /^[!(.]/.test(s);

// 刻意保留中文/双语的例外
const SKIP = (s) =>
  /&#10;/.test(s)                                  // markdown 大纲示例 placeholder
  || /^[A-Za-z0-9 &'’.\-]+ · /.test(s)             // PPT 主题风格名（Biennale Yellow · 暖纸明黄）
  || /\/ (Language|Auto)$/.test(s)                 // 语言选择器双语文案
  || /^(0 轮|的|标题示例 Title Sample|正文示例 · Body text 12345。)$/.test(s)
  || /classList|window\.location|try \{|\} catch|\(function|if \(/.test(s); // head 内联脚本

function collectJsFiles() {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (/vendor|node_modules/.test(f)) continue;
        walk(p);
      } else if (f.endsWith(".js")) files.push(p);
    }
  };
  walk(path.join(ROOT, "js"));
  files.push(path.join(ROOT, "main.js"));
  return files;
}

test("taskpane.html 用户可见中文均有英文词条（或在例外清单）", () => {
  const dict = loadDict();
  const html = fs.readFileSync(path.join(ROOT, "taskpane.html"), "utf8");
  const found = new Set();
  for (const m of html.matchAll(/>([^<>]*[一-龥][^<>]*)</g)) found.add(m[1].trim());
  for (const m of html.matchAll(/(?:placeholder|title|aria-label)="([^"]*[一-龥][^"]*)"/g)) found.add(m[1].trim());
  const missing = [...found].filter((s) => s && !(s in dict) && !SKIP(s) && !CODE_NOISE(s));
  assert.deepEqual(missing, [], `taskpane.html 有 ${missing.length} 条中文未配翻译：\n${missing.slice(0, 10).join("\n")}`);
});

test("JS 渲染文案（模板/属性/toast/confirm）均有英文词条", () => {
  const dict = loadDict();
  const found = new Set();
  for (const f of collectJsFiles()) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/>([^<>\n]*[一-龥][^<>\n]*)</g)) { const s = m[1].trim(); if (s && !CODE_NOISE(s)) found.add(s); }
    for (const m of src.matchAll(/(?:placeholder|title|aria-label)="([^"\n]*[一-龥][^"\n]*)"/g)) { const s = m[1].trim(); if (s && !CODE_NOISE(s)) found.add(s); }
    for (const m of src.matchAll(/\.(?:textContent|innerText|placeholder|title)\s*=\s*"([^"\n]*[一-龥][^"\n]*)"/g)) { const s = m[1].trim(); if (s && !CODE_NOISE(s)) found.add(s); }
    for (const m of src.matchAll(/showMessage\(\s*"([^"\n]*[一-龥][^"\n]*)"/g)) { const s = m[1].trim(); if (s && !CODE_NOISE(s)) found.add(s); }
    for (const m of src.matchAll(/(?:confirm|alert)\(\s*"([^"\n]*[一-龥][^"\n]*)"/g)) { const s = m[1].trim(); if (s && !CODE_NOISE(s)) found.add(s); }
  }
  const missing = [...found].filter((s) => !(s in dict) && !SKIP(s));
  assert.deepEqual(missing, [], `JS 文案有 ${missing.length} 条中文未配翻译：\n${missing.slice(0, 10).join("\n")}`);
});
