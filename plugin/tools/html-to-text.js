"use strict";

// 把 HTML 抽成纯文本 + 标题，供 /fetch-web 抓网页素材用。纯函数，可 require 单测。

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return " "; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return " "; } })
    .replace(/&amp;/g, "&"); // 最后解 &，避免二次解码
}

// 线性剥离 script/style/noscript/template/svg 块（含内容）。
// 用 regex.lastIndex 单遍前进，避免懒惰正则 /<tag>[\s\S]*?<\/tag>/ 在大量未闭合标签下的 O(n²) 回溯（DoS）。
// 未闭合处理：
//   - 自闭合 <svg .../> → 只去开标签；
//   - svg/template 未闭合 → 只去开标签、保留后文（这些是视觉/惰性元素，误吞后文会丢正文，见 bug M2）；
//   - script/style/noscript 未闭合 → 去到结尾（避免脚本/样式正文当可见文本泄漏）。
const KEEP_TAIL_ON_UNCLOSED = new Set(["svg", "template"]);
function stripTagBlocks(html) {
  const open = /<(script|style|noscript|template|svg)\b[^>]*>/gi;
  let out = "";
  let last = 0;
  let m;
  while ((m = open.exec(html))) {
    out += html.slice(last, m.index) + " ";
    const tagName = m[1].toLowerCase();
    const openEnd = m.index + m[0].length;
    if (/\/>\s*$/.test(m[0])) { last = openEnd; open.lastIndex = openEnd; continue; } // 自闭合
    const closeRe = new RegExp("</" + tagName + "\\s*>", "gi");
    closeRe.lastIndex = openEnd;
    const cm = closeRe.exec(html);
    if (!cm) {
      if (KEEP_TAIL_ON_UNCLOSED.has(tagName)) { last = openEnd; open.lastIndex = openEnd; continue; }
      last = html.length; break; // script/style/noscript 未闭合 → 丢到结尾
    }
    last = cm.index + cm[0].length;
    open.lastIndex = last;
  }
  out += html.slice(last);
  return out;
}

function htmlToText(html, maxLen) {
  const max = Number(maxLen) > 0 ? Number(maxLen) : 8000;
  let s = String(html || "");
  // 输入上限：正文最终只截到 max 字符，256KB HTML 足够；同时封住注释/标签正则的 O(n²) 最坏情况。
  if (s.length > 262144) s = s.slice(0, 262144);
  // 先去注释 + 脚本/样式/内联资源块（含内容），再取 title，避免注释/脚本里的 <title> 被误取
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = stripTagBlocks(s);
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, " ").trim() : "";
  // 块级结束标签 / 换行标签 → 换行
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|ul|ol|table)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // 去掉剩余所有标签
  s = s.replace(/<[^>]+>/g, " ");
  // 解实体（在去标签之后，避免文本里的 &lt; 被当标签）
  s = decodeEntities(s);
  // 压空白
  s = s.replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let truncated = false;
  if (s.length > max) { s = s.slice(0, max).trim(); truncated = true; }
  return { title, text: s, truncated };
}

module.exports = { htmlToText, decodeEntities };
