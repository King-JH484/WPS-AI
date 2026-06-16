// studio 模板：通用骨架 + 多种排版布局，**完全由当前 stylePreset 色板与字体驱动**。
// 选 Bold Signal 就出黑橙、选 Dark Botanical 就出深绿金，不再固定黑底黄字。
//
// 已实装布局（让 AI 能搭一整套 deck 不必 fallback 到直写工具）：
//   - cover：封面（巨型标题 + 副标）
//   - section：章节分隔（巨号 + 章节名）
//   - content：内容页（标题 + 多行要点）
//   - stat：数据强爆（巨型数字 + 标签 + 描述）
//   - feature-grid：2×2 特性矩阵（每格 = 图标 + 标题 + 正文）
//   - quote：金句页（大引号 + 引文 + 署名）
//   - comparison：对比页（左右两栏 + 图标 + 列表）
//   - metric-trio：三联指标（每格 = 图标 + 数字 + 标签）
//
// 字段全部走 escapeHtml；data.body 支持 \n 换行。图标用内置 lucide-style 线性 SVG，
// 名字写在字段里（如 "lightbulb"），未知图标自动 fallback 为 sparkles。
(function attachStudio(global) {
  "use strict";

  const CJK_FALLBACK = "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'WenQuanYi Micro Hei', system-ui, sans-serif";

  function cssFont(name) {
    const n = String(name || "").trim();
    if (!n) return CJK_FALLBACK;
    const quoted = /^[\w-]+$/.test(n) ? n : `'${n.replace(/'/g, "\\'")}'`;
    return `${quoted}, ${CJK_FALLBACK}`;
  }

  function resolvePalette(p) {
    return {
      bg: p?.backgroundColor || "#FFFFFF",
      surface: p?.surfaceColor || "#F4F4F5",
      primary: p?.primaryColor || "#1A1A1A",
      accent: p?.accentColor || "#FF5722",
      titleColor: p?.titleColor || p?.primaryColor || "#1A1A1A",
      bodyColor: p?.bodyColor || "#404040",
      titleFont: cssFont(p?.titleFont),
      bodyFont: cssFont(p?.bodyFont)
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function multilineHtml(s) {
    return escapeHtml(String(s || "")).replace(/\n/g, "<br>");
  }

  // ===== lucide 线性图标库（24×24 viewBox，stroke=currentColor）=====
  // 精选 ~28 个常用 PPT 图标。AI 用名字引用，未知名 fallback 到 sparkles。
  const ICONS = {
    "lightbulb": '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    "sparkles": '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    "zap": '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    "rocket": '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    "target": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    "trending-up": '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    "trending-down": '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    "user": '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    "check": '<polyline points="20 6 9 17 4 12"/>',
    "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    "x": '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    "x-circle": '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    "arrow-right": '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    "arrow-down": '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    "bar-chart": '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    "pie-chart": '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    "activity": '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    "shield": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    "lock": '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    "calendar": '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    "book": '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    "file": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    "star": '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    "heart": '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    "globe": '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    "map-pin": '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    "briefcase": '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    "code": '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    "database": '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
  };

  // 渲染图标：返回 inline SVG 字符串。size 单位 px，color 默认 currentColor。
  function icon(name, size = 48, color = "currentColor") {
    const paths = ICONS[name] || ICONS["sparkles"];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">${paths}</svg>`;
  }

  // 组合 <head> + <body>
  // 把 palette 暴露成 CSS 变量，freeform / 后续自定义 layout 可直接用 var(--primary) 引用。
  function doc(palette, bodyHtml, extraCss = "") {
    return `<!doctype html><html><head><meta charset="utf-8">
<style>
:root {
  --bg: ${palette.bg};
  --surface: ${palette.surface};
  --primary: ${palette.primary};
  --accent: ${palette.accent};
  --title-color: ${palette.titleColor};
  --body-color: ${palette.bodyColor};
  --title-font: ${palette.titleFont};
  --body-font: ${palette.bodyFont};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; }
body {
  background: ${palette.bg};
  color: ${palette.bodyColor};
  font-family: ${palette.bodyFont};
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.stage { width: 1920px; height: 1080px; padding: 80px 140px; position: relative; }
.grid-tag {
  position: absolute; top: 64px; left: 140px;
  font-family: ${palette.titleFont};
  font-size: 22px; font-weight: 700; letter-spacing: 0.32em; text-transform: uppercase;
  color: ${palette.accent};
}
.footer-tag {
  position: absolute; bottom: 56px; left: 140px; right: 140px;
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: ${palette.titleFont};
  font-size: 20px; font-weight: 700; letter-spacing: 0.24em; text-transform: uppercase;
  color: ${palette.bodyColor};
}
.accent-bar { position: absolute; left: 140px; width: 64px; height: 4px; background: ${palette.accent}; }
/* echarts 容器默认样式：AI 写 <div class="chart" data-echarts-option='{...}'></div> 即可被父窗口自动渲染 */
[data-echarts-option] { width: 100%; height: 100%; }
${extraCss}
</style>
</head>
<body><div class="stage">${bodyHtml}</div></body></html>`;
  }

  const TEMPLATE = {
    slug: "studio",
    label: "Studio（通用骨架，按当前色板渲染）",
    icons: Object.keys(ICONS), // 供 AI 看可用图标列表
    layouts: {
      // ============================================================
      // cover: 封面
      // ============================================================
      cover: {
        fields: ["title", "subtitle", "tag"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const subtitle = escapeHtml(data.subtitle || "");
          const tag = escapeHtml(data.tag || "");
          const body = `
            ${tag ? `<div class="grid-tag">${tag}</div>` : ""}
            <div class="cover-inner">
              <div class="accent-bar" style="position:relative;left:0;margin-bottom:32px"></div>
              <div class="cover-title">${title}</div>
              ${subtitle ? `<div class="cover-subtitle">${subtitle}</div>` : ""}
            </div>
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 140px; }
            .cover-title {
              font-family: ${palette.titleFont};
              font-size: 200px; font-weight: 900; line-height: 0.96;
              letter-spacing: -0.03em; color: ${palette.titleColor};
              max-width: 1640px;
            }
            .cover-subtitle {
              margin-top: 36px;
              font-family: ${palette.titleFont};
              font-size: 32px; font-weight: 700; letter-spacing: 0.16em;
              text-transform: uppercase; color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // section: 章节分隔
      // ============================================================
      section: {
        fields: ["number", "title", "footer"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const number = escapeHtml(data.number || "01");
          const title = multilineHtml(data.title || "");
          const footer = escapeHtml(data.footer || "");
          const body = `
            <div class="sec-number">${number}</div>
            <div class="sec-title">${title}</div>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>· · ·</span></div>` : ""}
          `;
          const css = `
            .stage { display: grid; grid-template-rows: auto 1fr auto; row-gap: 40px; padding-top: 200px; padding-bottom: 200px; }
            .sec-number {
              font-family: ${palette.titleFont};
              font-size: 320px; font-weight: 900; line-height: 0.9;
              letter-spacing: -0.04em; color: ${palette.accent};
            }
            .sec-title {
              font-family: ${palette.titleFont};
              font-size: 84px; font-weight: 800; line-height: 1.08;
              letter-spacing: -0.01em; max-width: 1640px;
              color: ${palette.titleColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // content: 标题 + 多行要点
      // ============================================================
      content: {
        fields: ["title", "body", "tag", "footer"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const lines = String(data.body || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
          const tag = escapeHtml(data.tag || "");
          const footer = escapeHtml(data.footer || "");
          const items = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
          const body = `
            ${tag ? `<div class="grid-tag">${tag}</div>` : ""}
            <div class="content-title">${title}</div>
            <ul class="content-body">${items}</ul>
            ${footer ? `<div class="footer-tag"><span>${footer}</span><span>· · ·</span></div>` : ""}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; gap: 48px; padding-top: 160px; padding-bottom: 160px; }
            .content-title {
              font-family: ${palette.titleFont};
              font-size: 80px; font-weight: 800; line-height: 1.04;
              letter-spacing: -0.015em; max-width: 1640px;
              color: ${palette.titleColor};
            }
            .content-body {
              font-family: ${palette.bodyFont};
              font-size: 36px; font-weight: 500; line-height: 1.5;
              list-style: none; padding: 0; margin: 0; max-width: 1640px;
              color: ${palette.bodyColor};
            }
            .content-body li { padding: 8px 0 8px 56px; position: relative; }
            .content-body li::before {
              content: "›"; position: absolute; left: 0; top: 4px;
              font-family: ${palette.titleFont};
              font-size: 44px; font-weight: 900;
              color: ${palette.accent};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // stat: 巨型数字 + 标签 + 描述
      // ============================================================
      stat: {
        fields: ["number", "label", "description"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const number = escapeHtml(data.number || "0");
          const label = escapeHtml(data.label || "");
          const description = multilineHtml(data.description || "");
          const body = `
            <div class="stat-inner">
              <div class="stat-number">${number}</div>
              ${label ? `<div class="stat-label">${label}</div>` : ""}
              ${description ? `<div class="stat-desc">${description}</div>` : ""}
            </div>
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; }
            .stat-inner { display: flex; flex-direction: column; gap: 32px; max-width: 1640px; }
            .stat-number {
              font-family: ${palette.titleFont};
              font-size: 440px; font-weight: 900; line-height: 0.9;
              letter-spacing: -0.06em;
              color: ${palette.accent};
            }
            .stat-label {
              font-family: ${palette.titleFont};
              font-size: 60px; font-weight: 800; letter-spacing: 0.06em;
              text-transform: uppercase;
              color: ${palette.titleColor};
            }
            .stat-desc {
              font-family: ${palette.bodyFont};
              font-size: 30px; font-weight: 500; line-height: 1.45;
              color: ${palette.bodyColor};
              max-width: 1200px;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // feature-grid: 2×2 特性矩阵（每格图标 + 标题 + 正文）
      // items 字段格式：每行一个 cell，"icon|heading|body" 用竖线分隔；最多 4 行
      // 例：
      //   "lightbulb|创意驱动|从用户痛点出发\nzap|快速执行|两周内交付 MVP\nshield|稳定保障|99.9% SLA\nusers|团队协作|跨职能共建"
      // ============================================================
      "feature-grid": {
        fields: ["title", "items"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 4).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return { icon: parts[0] || "sparkles", head: parts[1] || "", body: parts[2] || "" };
          });
          const grid = items.map((it) => `
            <div class="fg-cell">
              <div class="fg-icon">${icon(it.icon, 56, palette.accent)}</div>
              <div class="fg-head">${escapeHtml(it.head)}</div>
              <div class="fg-body">${escapeHtml(it.body)}</div>
            </div>
          `).join("");
          const body = `
            <div class="fg-title">${title}</div>
            <div class="fg-grid">${grid}</div>
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 56px; padding-top: 100px; padding-bottom: 100px; }
            .fg-title {
              font-family: ${palette.titleFont};
              font-size: 64px; font-weight: 800; line-height: 1.05;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .fg-grid {
              flex: 1;
              display: grid;
              grid-template-columns: 1fr 1fr;
              grid-template-rows: 1fr 1fr;
              gap: 40px;
            }
            .fg-cell {
              display: flex; flex-direction: column; gap: 18px;
              padding: 32px 36px;
              background: ${palette.surface};
              border-radius: 12px;
              border-left: 4px solid ${palette.accent};
            }
            .fg-head {
              font-family: ${palette.titleFont};
              font-size: 36px; font-weight: 800; line-height: 1.1;
              color: ${palette.titleColor};
            }
            .fg-body {
              font-family: ${palette.bodyFont};
              font-size: 22px; font-weight: 500; line-height: 1.5;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // quote: 大引号 + 引文 + 署名 + 角色
      // ============================================================
      quote: {
        fields: ["quote", "author", "role"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const quoteText = multilineHtml(data.quote || "");
          const author = escapeHtml(data.author || "");
          const role = escapeHtml(data.role || "");
          const body = `
            <div class="q-mark">&ldquo;</div>
            <div class="q-text">${quoteText}</div>
            ${author ? `<div class="q-author"><div class="q-author-bar"></div><div class="q-author-text"><div class="q-author-name">${author}</div>${role ? `<div class="q-author-role">${role}</div>` : ""}</div></div>` : ""}
          `;
          const css = `
            .stage { display: flex; flex-direction: column; justify-content: center; gap: 24px; padding-left: 180px; padding-right: 180px; }
            .q-mark {
              font-family: ${palette.titleFont};
              font-size: 280px; line-height: 0.6;
              color: ${palette.accent};
            }
            .q-text {
              font-family: ${palette.bodyFont};
              font-size: 56px; font-weight: 500; line-height: 1.3;
              font-style: italic;
              color: ${palette.titleColor};
              max-width: 1500px;
            }
            .q-author {
              display: flex; gap: 24px; align-items: center;
              margin-top: 32px;
            }
            .q-author-bar { width: 56px; height: 4px; background: ${palette.accent}; flex: none; }
            .q-author-name {
              font-family: ${palette.titleFont};
              font-size: 28px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
              color: ${palette.titleColor};
            }
            .q-author-role {
              font-family: ${palette.bodyFont};
              font-size: 22px;
              color: ${palette.bodyColor};
              margin-top: 4px;
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // comparison: 左右双栏对比（每栏图标 + 标签 + 多行）
      // 左侧 muted（淡色背景，常表示"过去/反例"），右侧 accent（突出，常表示"现在/正例"）
      // ============================================================
      comparison: {
        fields: ["title", "leftIcon", "leftLabel", "leftBody", "rightIcon", "rightLabel", "rightBody"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const leftIcon = String(data.leftIcon || "x-circle").trim();
          const leftLabel = escapeHtml(data.leftLabel || "");
          const leftLines = String(data.leftBody || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
          const leftItems = leftLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
          const rightIcon = String(data.rightIcon || "check-circle").trim();
          const rightLabel = escapeHtml(data.rightLabel || "");
          const rightLines = String(data.rightBody || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
          const rightItems = rightLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
          const body = `
            ${title ? `<div class="cmp-title">${title}</div>` : ""}
            <div class="cmp-grid">
              <div class="cmp-cell cmp-left">
                <div class="cmp-icon">${icon(leftIcon, 64, palette.bodyColor)}</div>
                <div class="cmp-label">${leftLabel}</div>
                <ul class="cmp-list">${leftItems}</ul>
              </div>
              <div class="cmp-cell cmp-right">
                <div class="cmp-icon" style="color:${palette.accent}">${icon(rightIcon, 64, palette.accent)}</div>
                <div class="cmp-label">${rightLabel}</div>
                <ul class="cmp-list">${rightItems}</ul>
              </div>
            </div>
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 48px; padding-top: 80px; padding-bottom: 80px; }
            .cmp-title {
              font-family: ${palette.titleFont};
              font-size: 56px; font-weight: 800;
              color: ${palette.titleColor};
              text-align: center;
            }
            .cmp-grid {
              flex: 1;
              display: grid; grid-template-columns: 1fr 1fr;
              gap: 40px;
            }
            .cmp-cell {
              display: flex; flex-direction: column; gap: 20px;
              padding: 40px 44px;
              border-radius: 14px;
            }
            .cmp-left { background: ${palette.surface}; opacity: 0.7; }
            .cmp-right { background: ${palette.surface}; border: 3px solid ${palette.accent}; }
            .cmp-label {
              font-family: ${palette.titleFont};
              font-size: 40px; font-weight: 800; line-height: 1.1;
              color: ${palette.titleColor};
            }
            .cmp-list {
              list-style: none; padding: 0; margin: 0;
              font-family: ${palette.bodyFont};
              font-size: 22px; line-height: 1.55;
              color: ${palette.bodyColor};
            }
            .cmp-list li {
              padding: 6px 0 6px 24px; position: relative;
            }
            .cmp-list li::before {
              content: "·"; position: absolute; left: 4px; top: 4px;
              font-weight: 900; color: ${palette.accent};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // metric-trio: 三联指标（图标 + 大数字 + 标签 + 可选描述）
      // items 格式：每行一个 cell，"icon|number|label|desc" 用竖线分隔；最多 3 行
      // 例：
      //   "trending-up|+247%|增长率|相较上季度\nusers|12.4M|月活|稳定增长\nactivity|99.9%|可用性|过去 30 天"
      // ============================================================
      "metric-trio": {
        fields: ["title", "items"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          const title = multilineHtml(data.title || "");
          const items = String(data.items || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3).map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return {
              icon: parts[0] || "trending-up",
              number: parts[1] || "",
              label: parts[2] || "",
              desc: parts[3] || ""
            };
          });
          const cells = items.map((it) => `
            <div class="mt-cell">
              <div class="mt-icon">${icon(it.icon, 56, palette.accent)}</div>
              <div class="mt-num">${escapeHtml(it.number)}</div>
              <div class="mt-label">${escapeHtml(it.label)}</div>
              ${it.desc ? `<div class="mt-desc">${escapeHtml(it.desc)}</div>` : ""}
            </div>
          `).join("");
          const cols = Math.max(1, items.length || 3);
          const body = `
            ${title ? `<div class="mt-title">${title}</div>` : ""}
            <div class="mt-grid">${cells}</div>
          `;
          const css = `
            .stage { display: flex; flex-direction: column; gap: 64px; padding-top: 100px; padding-bottom: 100px; justify-content: center; }
            .mt-title {
              font-family: ${palette.titleFont};
              font-size: 56px; font-weight: 800;
              color: ${palette.titleColor};
              max-width: 1640px;
            }
            .mt-grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 56px; }
            .mt-cell {
              display: flex; flex-direction: column; gap: 12px;
              padding: 24px 28px;
              border-top: 4px solid ${palette.accent};
            }
            .mt-num {
              font-family: ${palette.titleFont};
              font-size: 180px; font-weight: 900; line-height: 0.9; letter-spacing: -0.04em;
              color: ${palette.titleColor};
            }
            .mt-label {
              font-family: ${palette.titleFont};
              font-size: 32px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
              color: ${palette.titleColor};
            }
            .mt-desc {
              font-family: ${palette.bodyFont};
              font-size: 20px; line-height: 1.4;
              color: ${palette.bodyColor};
            }
          `;
          return doc(palette, body, css);
        }
      },

      // ============================================================
      // freeform: 自由排版 —— AI 直接写完整的 body HTML 和自定义 CSS。
      // 适合"现有 8 个 layout 表达不了的丰富设计"，例如:
      //   - 指标卡网格 (像 iPark 那种 6 卡 metric-grid)
      //   - 完成清单 + 状态徽章 (name / desc / status pill)
      //   - 表格 + 优势卡组合 (左 table + 右多卡)
      //   - Gantt / 里程碑时间轴 / 风险矩阵 / 团队结构图 等
      //
      // 渲染规则：
      //   - data.html: 必填，直接作为 body 内容（**不会**被包进 .stage 容器，AI 自己定布局）
      //   - data.css:  可选，作为额外样式注入（追加在默认样式后）
      //   - 可用 CSS 变量：--bg / --surface / --primary / --accent /
      //     --title-color / --body-color / --title-font / --body-font
      //   - stage 已是 1920×1080，AI 写绝对定位或 flex/grid 均可，记得元素超出 1920×1080 会被裁掉
      //   - 不需要写 <html>/<head>/<body>，只给 body 内容
      // ============================================================
      freeform: {
        fields: ["html", "css"],
        render(data, paletteIn) {
          const palette = resolvePalette(paletteIn);
          // 注意：freeform 的 html 是用户/AI 提供的，**不做 escape**（这就是自由的代价）。
          // 上下游链路里这段 HTML 只被塞进 iframe srcdoc 渲染成截图，不直写到主文档，
          // 没有 XSS / RCE 风险面。
          const customHtml = String(data.html || "");
          const customCss = String(data.css || "");
          // 把 .stage 内边距压成 0，让 freeform 自己掌控整个 1920×1080 画布。
          // 默认字号映射 PPT 标准磅值：1920×1080 = 13.333"，144 DPI → **1pt = 2px**。
          //   PPT 风格         | pt  | px (默认)
          //   ---              | --- | ---
          //   Title (h1)       | 54  | 108
          //   Section (h2)     | 40  | 80
          //   Heading (h3)     | 28  | 56
          //   Subheading (h4)  | 22  | 44
          //   Body (p/li/td)   | 18  | 36
          //   Caption (small)  | 14  | 28
          //   Min readable     | 12  | 24
          // AI 写的 CSS 会覆盖这些保底；这些只是"AI 没显式写 font-size 时也不会出现网页尺寸的小字"。
          const css = `
            .stage { padding: 0; font-size: 36px; line-height: 1.5; }
            .stage h1 { font-size: 108px; line-height: 1.1; font-weight: 800; }
            .stage h2 { font-size: 80px; line-height: 1.15; font-weight: 800; }
            .stage h3 { font-size: 56px; line-height: 1.2; font-weight: 700; }
            .stage h4 { font-size: 44px; line-height: 1.25; font-weight: 700; }
            .stage p,
            .stage li,
            .stage td,
            .stage th { font-size: 36px; line-height: 1.5; }
            .stage small,
            .stage .small,
            .stage figcaption { font-size: 28px; line-height: 1.4; }
            ${customCss}
          `;
          return doc(palette, customHtml, css);
        }
      }
    }
  };

  global.WpsAiHtmlTemplates = global.WpsAiHtmlTemplates || { _registry: {} };
  global.WpsAiHtmlTemplates._registry[TEMPLATE.slug] = TEMPLATE;
})(window);
