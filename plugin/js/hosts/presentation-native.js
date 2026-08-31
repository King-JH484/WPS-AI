(function attachPresentationNative(global) {
  "use strict";

  function nativeHandles() {
    if (!global.WpsAiWppHandles) throw new Error("WPP native handle runtime 未加载");
    return global.WpsAiWppHandles;
  }

  async function getPresentation() {
    const presentation = await global.WpsAiHostPresentation?._internal?.getActivePresentation?.();
    if (!presentation) throw new Error("未检测到打开的 WPS 演示。");
    return presentation;
  }

  function platform() {
    const value = String(global.navigator?.platform || "");
    if (/Mac/i.test(value)) return "darwin";
    if (/Win/i.test(value)) return "win32";
    return "unknown";
  }

  function capability(state, adapter, reason, evidence = {}) {
    return { state, adapter, reason: reason || "", evidence };
  }

  async function inspect({ includeShapes = false } = {}) {
    const presentation = await getPresentation();
    const handles = nativeHandles();
    const designs = handles.designsOf(presentation);
    if (!designs || handles.countOf(designs) === 0) throw new Error("当前 WPS 未暴露 Designs 或 SlideMaster 对象链。");
    const result = [];
    for (let di = 1; di <= handles.countOf(designs); di += 1) {
      const design = handles.itemAt(designs, di);
      const master = handles.safeGet(design, "SlideMaster", null);
      const layouts = handles.safeGet(master, "CustomLayouts", null);
      const layoutItems = [];
      for (let li = 1; li <= handles.countOf(layouts); li += 1) {
        const layout = handles.itemAt(layouts, li);
        const shapes = handles.safeGet(layout, "Shapes", null);
        const placeholders = [];
        if (includeShapes) {
          for (let si = 1; si <= handles.countOf(shapes); si += 1) {
            const shape = handles.itemAt(shapes, si);
            let placeholderType = null;
            try { placeholderType = shape?.PlaceholderFormat?.Type ?? null; } catch (error) {}
            placeholders.push({ id: handles.safeGet(shape, "Id", null), name: handles.safeGet(shape, "Name", ""), placeholderType });
          }
        }
        layoutItems.push({
          handle: handles.createLayoutHandle(presentation, design, layout),
          index: Number(handles.safeGet(layout, "Index", li)) || li,
          name: String(handles.safeGet(layout, "Name", "")),
          matchingName: String(handles.safeGet(layout, "MatchingName", "")),
          shapeCount: handles.countOf(shapes),
          placeholders
        });
      }
      result.push({
        index: Number(handles.safeGet(design, "Index", di)) || di,
        name: String(handles.safeGet(design, "Name", "")),
        masterShapeCount: handles.countOf(handles.safeGet(master, "Shapes", null)),
        layouts: layoutItems
      });
    }
    return { documentId: handles.documentIdentity(presentation), designs: result };
  }

  async function probe({ mode = "read", sandboxConfirmed = false } = {}) {
    if (mode === "write" && sandboxConfirmed !== true) {
      throw new Error("写探针要求 sandboxConfirmed=true，并且只能在专用测试演示文稿中运行。");
    }
    const presentation = await getPresentation();
    const handles = nativeHandles();
    const adapter = "wps_jsapi";
    const capabilities = {};
    try {
      const report = await inspect({ includeShapes: true });
      capabilities["wpp.master.inspect"] = capability("supported", adapter, "已完成当前文档只读遍历", { designCount: report.designs.length });
    } catch (error) {
      capabilities["wpp.master.inspect"] = capability("unsupported", adapter, error?.message || "Designs/SlideMaster 不可访问");
    }

    const designs = handles.designsOf(presentation);
    const design = handles.itemAt(designs, 1);
    const master = handles.safeGet(design, "SlideMaster", null);
    const layouts = handles.safeGet(master, "CustomLayouts", null);
    const firstLayout = handles.itemAt(layouts, 1);
    const slides = handles.safeGet(presentation, "Slides", null);
    const firstSlide = handles.itemAt(slides, 1);
    const firstShapes = handles.safeGet(firstSlide, "Shapes", null) || handles.safeGet(firstLayout, "Shapes", null);
    const declarations = {
      "wpp.master.update": Boolean(master && handles.safeGet(master, "Shapes", null)),
      "wpp.layout.manage": Boolean(layouts && (typeof layouts.Add === "function" || typeof layouts.Paste === "function")),
      "wpp.placeholder.manage": Boolean(firstShapes && typeof firstShapes.AddPlaceholder === "function"),
      "wpp.theme.manage": typeof presentation.ApplyTemplate === "function" || typeof presentation.ApplyTemplate2 === "function",
      "wpp.template.export": typeof presentation.SaveCopyAs === "function",
      "wpp.chart.native.create": Boolean(firstShapes && (typeof firstShapes.AddChart2 === "function" || typeof firstShapes.AddChart === "function"))
    };
    Object.entries(declarations).forEach(([key, declared]) => {
      capabilities[key] = capability(declared ? "unverified" : "unsupported", adapter,
        declared ? "接口已声明；尚未执行受控写探针" : "当前对象链未暴露对应方法");
    });

    const report = {
      schema: "anthony.wpp.capability-report.v1",
      platform: platform(),
      mode,
      capabilities,
      evidence: {
        adapter,
        mutated: false,
        documentId: handles.documentIdentity(presentation),
        observedAt: new Date().toISOString()
      }
    };
    global.WpsAiWppCapabilities?.recordEvidence?.(report);
    return report;
  }

  global.WpsAiPresentationNative = { getPresentation, inspect, probe };
})(window);
