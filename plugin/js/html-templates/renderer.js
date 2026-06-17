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
    if (!ec) return []; // echarts 未加载就降级为不画图（旧行为）
    const root = iframeDoc.documentElement;
    const cs = iframeDoc.defaultView ? iframeDoc.defaultView.getComputedStyle(root) : null;
    const palette = cs ? [
      (cs.getPropertyValue("--primary") || "#1A6DFF").trim(),
      (cs.getPropertyValue("--accent")  || "#E85D2F").trim(),
      (cs.getPropertyValue("--body-color") || "#475569").trim(),
      (cs.getPropertyValue("--surface") || "#E2E8F0").trim(),
      "#7C5295", "#15803D"
    ] : null;
    const pending = []; // [{chart, container, opt}] 等 finished 后转 inline-SVG
    iframeDoc.querySelectorAll("[data-echarts-option]").forEach((el) => {
      try {
        const opt = JSON.parse(el.getAttribute("data-echarts-option"));
        if (palette && !opt.color) opt.color = palette;
        // 截图场景不要动画 —— 默认 1000ms 动画 → setOption 后立即 setTimeout 截图会截到 0 帧
        opt.animation = false;
        opt.progressive = 0;
        if (!el.style.width && !el.clientWidth) el.style.width = "100%";
        if (!el.style.height && !el.clientHeight) el.style.height = "100%";
        const chart = ec.init(el, null, { renderer: "svg" });
        chart.setOption(opt, { lazyUpdate: false });
        pending.push({ chart, container: el, opt });
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
    if (!pending.length) return [];

    // 1) 等每张图 finished 事件（带 1s timeout 兜底）
    await Promise.all(pending.map(({ chart }) => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      try {
        chart.on("finished", finish);
        // 同步路径下 finished 可能已经触发；listener attach 太晚 → 用 rendered 事件兜底
        chart.on("rendered", finish);
      } catch (e) { finish(); return; }
      setTimeout(finish, 1000);
    })));

    // 2) 关键修复：用 chart.renderToSVGString() 拿到稳定的 SVG 字符串，
    //    替换容器内容为 inline <svg>。html2canvas 截动态生成的 echarts SVG 在 WebView
    //    上偶发空白（推测跟 SVG namespace / use href 解析时机有关）；
    //    把它"烘焙"成静态 SVG 后截图就稳了。
    pending.forEach(({ chart, container }) => {
      try {
        if (typeof chart.renderToSVGString === "function") {
          const svgStr = chart.renderToSVGString();
          if (svgStr) {
            // 保证容器仍占 100% 大小
            container.innerHTML = svgStr;
            const svgEl = container.querySelector("svg");
            if (svgEl) {
              svgEl.setAttribute("width", "100%");
              svgEl.setAttribute("height", "100%");
              svgEl.style.width = "100%";
              svgEl.style.height = "100%";
            }
          }
        }
      } catch (e) { /* 单格失败留 init 出来的 SVG 兜底 */ }
    });

    // 3) 再等两个 rAF 让浏览器完成 reflow + 一次 paint
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 50));

    return pending.map((p) => p.chart);
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

  // 分图层渲染：把 .stage 拆成 N 张 PNG（背景 + 每个直接子元素一张），
  // 调用方按 layer.x/y/w/h 分别 AddPicture 到 PPT，**每个图层都是独立 shape**，
  // 用户在 PPT 里能选中/移动/缩放各个图层，不再是一张铁板一块的大图。
  //
  // 拆分规则（简单高效，对 freeform / fixed layout 都 OK）:
  //   1. 直接子元素 `.stage > *` 即为图层（DOM 顺序 = z 层底→顶）
  //   2. 背景层 = 把所有直接子元素临时 visibility:hidden 后整张截图，捕获 stage 的 bg/::before/::after
  //   3. 每个直接子元素 = 单独 html2canvas 截图，自带 element 的实际宽高
  //   4. 不递归再拆 grandchild，否则 cover-inner 内的 title+subtitle 会被拆烂，组织复杂还互相覆盖
  //
  // 返回 { width, height, layers: [{x, y, w, h, dataUrl, kind: "background"|"layer"}] }
  // 坐标系：x/y/w/h 单位是 stage 内部 px (1920×1080 基准)。调用方按 PPT slide 实际尺寸缩放。
  async function renderToLayers(templateName, layout, data, palette, opts = {}) {
    if (!global.html2canvas) {
      throw new Error("html2canvas 未加载（缺 js/vendor/html2canvas.min.js）");
    }
    const tpl = getTemplate(templateName);
    if (!tpl) throw new Error(`未知 HTML 模板：${templateName}`);
    const layoutDef = tpl.layouts?.[layout];
    if (!layoutDef) throw new Error(`模板 ${templateName} 没有布局 ${layout}`);

    const html = layoutDef.render(data || {}, palette || {});
    const scale = opts.scale || 1;

    const iframe = await mountHiddenIframe(html);
    let charts = null;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error("iframe document 不可访问（跨域？）");
      await waitForFonts(doc);
      try { charts = await bridgeEchartsInDoc(doc); } catch (e) {}

      const stage = doc.querySelector(".stage") || doc.body;
      const stageRect = stage.getBoundingClientRect();
      const sLeft = stageRect.left;
      const sTop = stageRect.top;
      const children = Array.from(stage.children);
      const layers = [];

      const baseOpts = {
        scale,
        useCORS: true,
        backgroundColor: null,
        logging: false,
        windowWidth: STAGE_W,
        windowHeight: STAGE_H
      };

      // 1) 背景层：临时把所有直接子元素 visibility: hidden，截 stage 整张，
      //    捕获 stage 自身 bg + ::before / ::after + 任何在 stage 上的装饰
      const prevVis = children.map((c) => c.style.visibility);
      children.forEach((c) => { c.style.visibility = "hidden"; });
      try {
        const bgCanvas = await global.html2canvas(stage, {
          ...baseOpts,
          width: STAGE_W,
          height: STAGE_H
        });
        layers.push({
          x: 0, y: 0, w: STAGE_W, h: STAGE_H,
          dataUrl: bgCanvas.toDataURL("image/png"),
          kind: "background"
        });
      } finally {
        children.forEach((c, i) => { c.style.visibility = prevVis[i] || ""; });
      }

      // 2) 每个直接子元素 → 单独一层
      for (const child of children) {
        const r = child.getBoundingClientRect();
        const x = Math.max(0, Math.round(r.left - sLeft));
        const y = Math.max(0, Math.round(r.top - sTop));
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        // 0 宽/高的占位元素（display:none / 空 div）跳过
        if (w <= 1 || h <= 1) continue;
        try {
          const childCanvas = await global.html2canvas(child, {
            ...baseOpts,
            width: w,
            height: h
          });
          layers.push({
            x, y, w, h,
            dataUrl: childCanvas.toDataURL("image/png"),
            kind: "layer"
          });
        } catch (e) { /* 单层失败不影响其他层 */ }
      }

      return { width: STAGE_W, height: STAGE_H, layers };
    } finally {
      try { (charts || []).forEach((c) => { try { c.dispose(); } catch (e) {} }); } catch (e) {}
      try { iframe.remove(); } catch (e) {}
    }
  }

  global.WpsAiHtmlTemplates = global.WpsAiHtmlTemplates || { _registry: {} };
  Object.assign(global.WpsAiHtmlTemplates, {
    renderToPng,
    renderToLayers,
    listTemplates,
    listLayouts,
    getTemplate,
    STAGE_W,
    STAGE_H
  });
})(window);
