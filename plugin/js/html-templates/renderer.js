// HTML 模板渲染器 —— 把 frontend-slides 风格的 HTML 模板渲染成 PNG（dataURL）。
// 流程：取模板 → 调 render(data, palette) 得到完整 HTML → 写入 1920×1080 隐藏 iframe →
//       等字体加载 → 用 html2canvas 截图 → 返回 PNG dataURL。
//
// 调用方（wpp_render_html_template 工具）拿到 dataURL 后走现有 uploadDataUrl → AddPicture 路径
// 插入到 PPT，整页铺为背景图，文字部分可叠加真文本框（可选）。
//
// 依赖：window.html2canvas（vendor/html2canvas.min.js）+ window.WpsAiHtmlTemplates._registry。
(function attachHtmlRenderer(global) {
  "use strict";

  const STAGE_W = 1920;
  const STAGE_H = 1080;

  function listTemplates() {
    const reg = global.WpsAiHtmlTemplates?._registry || {};
    return Object.keys(reg).sort();
  }

  function getTemplate(name) {
    const reg = global.WpsAiHtmlTemplates?._registry || {};
    return reg[name] || null;
  }

  function listLayouts(name) {
    const tpl = getTemplate(name);
    if (!tpl) return [];
    return Object.keys(tpl.layouts || {});
  }

  // 等 iframe 内字体加载完。FontFace API 没就 fallback 到固定延时。
  async function waitForFonts(iframeDoc) {
    try {
      if (iframeDoc.fonts?.ready) {
        await iframeDoc.fonts.ready;
        return;
      }
    } catch (e) { /* fall through */ }
    await new Promise((r) => setTimeout(r, 800));
  }

  // 修复：截图前先把 iframe 里的 ECharts 实际渲染出来。
  // 之前 html2canvas 截图时 [data-echarts-option] 容器还是空 div（父窗口的预览桥接不会跑这个隐藏 iframe），
  // 结果 PPT 插的图里图表区是空白。这里直接在隐藏 iframe 里调用 echarts.init().setOption()，
  // 用 SVG renderer 同步出图，再等一拍让浏览器完成布局/绘制。
  async function bridgeEchartsInDoc(iframeDoc) {
    const ec = window.echarts;
    if (!ec) return; // echarts 未加载就降级为不画图（旧行为）
    const root = iframeDoc.documentElement;
    const cs = iframeDoc.defaultView ? iframeDoc.defaultView.getComputedStyle(root) : null;
    const palette = cs ? [
      (cs.getPropertyValue("--primary") || "#1A6DFF").trim(),
      (cs.getPropertyValue("--accent")  || "#E85D2F").trim(),
      (cs.getPropertyValue("--body-color") || "#475569").trim(),
      (cs.getPropertyValue("--surface") || "#E2E8F0").trim(),
      "#7C5295", "#15803D"
    ] : null;
    const charts = [];
    iframeDoc.querySelectorAll("[data-echarts-option]").forEach((el) => {
      try {
        const opt = JSON.parse(el.getAttribute("data-echarts-option"));
        if (palette && !opt.color) opt.color = palette;
        if (!el.style.width && !el.clientWidth) el.style.width = "100%";
        if (!el.style.height && !el.clientHeight) el.style.height = "100%";
        const chart = ec.init(el, null, { renderer: "svg" });
        chart.setOption(opt);
        charts.push(chart);
      } catch (e) { /* 单格失败不阻塞其他 */ }
    });
    // 处理 canvas 绘制
    iframeDoc.querySelectorAll("canvas[data-canvas-draw]").forEach((c) => {
      try {
        const w = c.clientWidth, h = c.clientHeight;
        if (w && h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d");
        const code = c.getAttribute("data-canvas-draw");
        new Function("ctx", "canvas", "w", "h", code)(ctx, c, c.width, c.height);
      } catch (e) {}
    });
    // SVG renderer 是同步的，但仍等两个 rAF 让浏览器完成布局 + 一次 paint，
    // 否则 html2canvas 偶发截到空 SVG（特别在 WPS WebView 上）
    if (charts.length) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 80));
    }
    return charts;
  }

  // 创建一个 1920×1080 的隐藏 iframe，写入 html，等加载完。
  function mountHiddenIframe(html) {
    const iframe = document.createElement("iframe");
    // 不能用 display:none —— html2canvas 截不到不可见元素。
    // 用 absolute + 巨负偏移 + opacity:0，但保证布局有效。
    iframe.style.cssText = [
      "position: absolute",
      "left: -10000px",
      "top: 0",
      `width: ${STAGE_W}px`,
      `height: ${STAGE_H}px`,
      "border: 0",
      "opacity: 0",
      "pointer-events: none"
    ].join("; ");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("scrolling", "no");
    document.body.appendChild(iframe);
    return new Promise((resolve, reject) => {
      const onLoad = () => {
        iframe.removeEventListener("load", onLoad);
        resolve(iframe);
      };
      iframe.addEventListener("load", onLoad);
      // srcdoc 兼容性广；老版 IE 不支持但 WPS WebView 都是 Chromium
      try {
        iframe.srcdoc = html;
      } catch (e) {
        iframe.removeEventListener("load", onLoad);
        document.body.removeChild(iframe);
        reject(e);
      }
    });
  }

  // 主入口：渲染指定模板 + 布局 → 返回 dataURL。
  // - templateName: "studio" 等 frontend-slides slug
  // - layout: "cover" / "section" / "content" / "stat" 等
  // - data: 字段值对象（具体字段由 template.layouts[layout].fields 定义）
  // - palette: 色板（一般传 wpp_get_style_preset 的返回值或其子集）
  // - opts.scale: 渲染倍数（默认 1，已经是 1920×1080 原始大小；2 = 4K 超清更不易糊）
  async function renderToPng(templateName, layout, data, palette, opts = {}) {
    if (!global.html2canvas) {
      throw new Error("html2canvas 未加载（缺 js/vendor/html2canvas.min.js）");
    }
    const tpl = getTemplate(templateName);
    if (!tpl) throw new Error(`未知 HTML 模板：${templateName}`);
    const layoutDef = tpl.layouts?.[layout];
    if (!layoutDef) throw new Error(`模板 ${templateName} 没有布局 ${layout}`);

    const html = layoutDef.render(data || {}, palette || {});

    const iframe = await mountHiddenIframe(html);
    let charts = null;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error("iframe document 不可访问（跨域？）");
      await waitForFonts(doc);
      // ECharts / canvas 必须在截图前真实绘制出来，否则 PPT 里图表区是空白
      try { charts = await bridgeEchartsInDoc(doc); } catch (e) { /* 画图失败不阻塞截图 */ }

      const canvas = await global.html2canvas(doc.body, {
        width: STAGE_W,
        height: STAGE_H,
        scale: opts.scale || 1,
        useCORS: true,
        backgroundColor: null,
        logging: false,
        windowWidth: STAGE_W,
        windowHeight: STAGE_H
      });
      return canvas.toDataURL("image/png");
    } finally {
      // 截完图把 echarts 实例 dispose 掉再卸 iframe，避免实例残留泄漏（多页 batch 时尤其要注意）
      try { (charts || []).forEach((c) => { try { c.dispose(); } catch (e) {} }); } catch (e) {}
      try { iframe.remove(); } catch (e) {}
    }
  }

  global.WpsAiHtmlTemplates = global.WpsAiHtmlTemplates || { _registry: {} };
  Object.assign(global.WpsAiHtmlTemplates, {
    renderToPng,
    listTemplates,
    listLayouts,
    getTemplate,
    STAGE_W,
    STAGE_H
  });
})(window);
