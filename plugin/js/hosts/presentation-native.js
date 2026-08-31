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

  function requireCapability(key) {
    return global.WpsAiWppCapabilities?.requireSupported?.(platform(), key, "wps_jsapi");
  }

  function detectAdded(collection, beforeCount, returned) {
    const handles = nativeHandles();
    if (returned && typeof returned === "object") return returned;
    const afterCount = handles.countOf(collection);
    if (afterCount <= beforeCount) throw new Error("native_write_not_observed");
    return handles.itemAt(collection, afterCount);
  }

  const PLACEHOLDER_TYPES = Object.freeze({
    title: 1, body: 2, center_title: 3, subtitle: 4, vertical_title: 5,
    vertical_body: 6, object: 7, chart: 8, table: 12, picture: 18
  });

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

  async function probe({ mode = "read", sandboxConfirmed = false, expectedDocumentId = "" } = {}) {
    if (mode === "write" && sandboxConfirmed !== true) {
      throw new Error("写探针要求 sandboxConfirmed=true，并且只能在专用测试演示文稿中运行。");
    }
    const presentation = await getPresentation();
    const handles = nativeHandles();
    const documentId = handles.documentIdentity(presentation);
    if (mode === "write") {
      if (!expectedDocumentId || expectedDocumentId !== documentId) throw new Error("document_mismatch: 写探针的 expectedDocumentId 与当前演示不一致");
      const name = String(handles.safeGet(presentation, "Name", ""));
      if (!/probe|test|测试|sandbox/i.test(name)) throw new Error("write_probe_requires_dedicated_test_presentation");
    }
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
      "wpp.slide.add_from_layout": Boolean(slides && typeof slides.AddSlide === "function"),
      "wpp.theme.manage": typeof presentation.ApplyTemplate === "function" || typeof presentation.ApplyTemplate2 === "function",
      "wpp.template.export": typeof presentation.SaveCopyAs === "function",
      "wpp.chart.native.create": Boolean(firstShapes && (typeof firstShapes.AddChart2 === "function" || typeof firstShapes.AddChart === "function"))
    };
    Object.entries(declarations).forEach(([key, declared]) => {
      capabilities[key] = capability(declared ? "unverified" : "unsupported", adapter,
        declared ? "接口已声明；尚未执行受控写探针" : "当前对象链未暴露对应方法");
    });

    let cleanupVerified = true;
    let mutated = false;
    if (mode === "write") {
      const setProbeResult = (key, ok, reason, extra = {}) => {
        capabilities[key] = capability(ok ? "supported" : "degraded", adapter, reason, extra);
      };
      const verifyRestored = (collection, beforeCount) => {
        const restored = handles.countOf(collection) === beforeCount;
        cleanupVerified = cleanupVerified && restored;
        return restored;
      };

      let probeLayout = null;
      const layoutBefore = handles.countOf(layouts);
      try {
        if (!layouts || typeof layouts.Add !== "function") throw new Error("CustomLayouts.Add unavailable");
        mutated = true;
        probeLayout = detectAdded(layouts, layoutBefore, layouts.Add(layoutBefore + 1));
        setProbeResult("wpp.layout.manage", true, "CustomLayouts.Add/Delete 已验证");
      } catch (error) {
        setProbeResult("wpp.layout.manage", false, error?.message || String(error));
      }

      const layoutForChildren = probeLayout || firstLayout;
      const probeShapes = handles.safeGet(layoutForChildren, "Shapes", null);
      const placeholderBefore = handles.countOf(probeShapes);
      let probePlaceholder = null;
      try {
        if (!probeShapes || typeof probeShapes.AddPlaceholder !== "function") throw new Error("Shapes.AddPlaceholder unavailable");
        mutated = true;
        probePlaceholder = detectAdded(probeShapes, placeholderBefore, probeShapes.AddPlaceholder(1, 10, 10, 120, 40));
        probePlaceholder.Delete?.();
        if (!verifyRestored(probeShapes, placeholderBefore)) throw new Error("placeholder cleanup failed");
        setProbeResult("wpp.placeholder.manage", true, "AddPlaceholder/Delete 已验证");
      } catch (error) {
        try { probePlaceholder?.Delete?.(); } catch (cleanupError) {}
        verifyRestored(probeShapes, placeholderBefore);
        setProbeResult("wpp.placeholder.manage", false, error?.message || String(error));
      }

      const slideBefore = handles.countOf(slides);
      let probeSlide = null;
      try {
        if (!layoutForChildren || !slides || typeof slides.AddSlide !== "function") throw new Error("Slides.AddSlide unavailable");
        mutated = true;
        probeSlide = detectAdded(slides, slideBefore, slides.AddSlide(slideBefore + 1, layoutForChildren));
        probeSlide.Delete?.();
        if (!verifyRestored(slides, slideBefore)) throw new Error("slide cleanup failed");
        setProbeResult("wpp.slide.add_from_layout", true, "Slides.AddSlide/Delete 已验证");
      } catch (error) {
        try { probeSlide?.Delete?.(); } catch (cleanupError) {}
        verifyRestored(slides, slideBefore);
        setProbeResult("wpp.slide.add_from_layout", false, error?.message || String(error));
      }

      const masterShapes = handles.safeGet(master, "Shapes", null);
      const masterShapeBefore = handles.countOf(masterShapes);
      let probeMasterShape = null;
      try {
        if (!masterShapes || typeof masterShapes.AddShape !== "function") throw new Error("SlideMaster.Shapes.AddShape unavailable");
        mutated = true;
        probeMasterShape = detectAdded(masterShapes, masterShapeBefore, masterShapes.AddShape(1, 0, 0, 1, 1));
        probeMasterShape.Delete?.();
        if (!verifyRestored(masterShapes, masterShapeBefore)) throw new Error("master shape cleanup failed");
        setProbeResult("wpp.master.update", true, "SlideMaster.Shapes.AddShape/Delete 已验证");
      } catch (error) {
        try { probeMasterShape?.Delete?.(); } catch (cleanupError) {}
        verifyRestored(masterShapes, masterShapeBefore);
        setProbeResult("wpp.master.update", false, error?.message || String(error));
      }

      try { probeLayout?.Delete?.(); } catch (cleanupError) { cleanupVerified = false; }
      verifyRestored(layouts, layoutBefore);
      if (!cleanupVerified) {
        Object.keys(capabilities).forEach((key) => {
          if (capabilities[key].state === "supported" && key !== "wpp.master.inspect") {
            capabilities[key] = capability("degraded", adapter, "写探针操作成功，但清理验证失败");
          }
        });
      }
    }

    const report = {
      schema: "anthony.wpp.capability-report.v1",
      platform: platform(),
      mode,
      capabilities,
      evidence: {
        adapter,
        mutated,
        cleanupVerified,
        documentId,
        observedAt: new Date().toISOString()
      }
    };
    global.WpsAiWppCapabilities?.recordEvidence?.(report);
    return report;
  }

  async function addSlideFromLayout({ layoutHandle, index } = {}) {
    requireCapability("wpp.slide.add_from_layout");
    const presentation = await getPresentation();
    const handles = nativeHandles();
    const { layout } = handles.resolveLayoutHandle(presentation, layoutHandle);
    const slides = handles.safeGet(presentation, "Slides", null);
    const beforeCount = handles.countOf(slides);
    const targetIndex = Math.max(1, Math.min(Number(index) || beforeCount + 1, beforeCount + 1));
    const returned = slides?.AddSlide?.(targetIndex, layout);
    const slide = detectAdded(slides, beforeCount, returned);
    return {
      slideId: Number(handles.safeGet(slide, "SlideID", 0)) || null,
      slideIndex: Number(handles.safeGet(slide, "SlideIndex", targetIndex)) || targetIndex,
      applied: true
    };
  }

  async function managePlaceholder(options = {}) {
    requireCapability("wpp.placeholder.manage");
    const presentation = await getPresentation();
    const handles = nativeHandles();
    if (options.action === "create") {
      const { design, layout } = handles.resolveLayoutHandle(presentation, options.layoutHandle);
      const shapes = handles.safeGet(layout, "Shapes", null);
      const type = PLACEHOLDER_TYPES[options.type];
      if (!type) throw new Error(`unsupported_placeholder_type:${options.type || ""}`);
      const beforeCount = handles.countOf(shapes);
      const returned = shapes?.AddPlaceholder?.(
        type,
        Number(options.left) || 0,
        Number(options.top) || 0,
        Number(options.width) || 300,
        Number(options.height) || 60
      );
      const shape = detectAdded(shapes, beforeCount, returned);
      if (options.name) { try { shape.Name = String(options.name); } catch (error) {} }
      return { shapeHandle: handles.createLayoutShapeHandle(presentation, design, layout, shape), type: options.type, applied: true };
    }
    const resolved = handles.resolveLayoutShapeHandle(presentation, options.shapeHandle);
    if (options.action === "delete") {
      resolved.shape?.Delete?.();
      return { deleted: true };
    }
    if (options.action === "update") {
      for (const [field, property] of [["left", "Left"], ["top", "Top"], ["width", "Width"], ["height", "Height"]]) {
        if (Number.isFinite(options[field])) resolved.shape[property] = Number(options[field]);
      }
      if (typeof options.name === "string") resolved.shape.Name = options.name;
      return { shapeHandle: options.shapeHandle, applied: true };
    }
    throw new Error(`unsupported_placeholder_action:${options.action || ""}`);
  }

  async function manageLayout(options = {}) {
    const presentation = await getPresentation();
    const handles = nativeHandles();
    if (options.action === "list") return inspect({ includeShapes: true });
    requireCapability("wpp.layout.manage");
    if (["update", "move", "delete"].includes(options.action)) {
      const { design, layout } = handles.resolveLayoutHandle(presentation, options.layoutHandle);
      if (options.action === "delete") { layout.Delete?.(); return { deleted: true }; }
      if (typeof options.name === "string") layout.Name = options.name;
      if (typeof options.matchingName === "string") layout.MatchingName = options.matchingName;
      if (options.action === "move") layout.MoveTo?.(Math.max(1, Number(options.index) || 1));
      return { layoutHandle: handles.createLayoutHandle(presentation, design, layout), applied: true };
    }
    const designs = handles.designsOf(presentation);
    const design = handles.itemAt(designs, Math.max(1, Number(options.designIndex) || 1));
    const layouts = handles.safeGet(handles.safeGet(design, "SlideMaster", null), "CustomLayouts", null);
    const beforeCount = handles.countOf(layouts);
    let returned;
    if (options.action === "create") {
      returned = layouts?.Add?.(Math.max(1, Math.min(Number(options.index) || beforeCount + 1, beforeCount + 1)));
    } else if (options.action === "clone") {
      const source = handles.resolveLayoutHandle(presentation, options.layoutHandle).layout;
      source.Copy?.();
      returned = layouts?.Paste?.(Math.max(1, Math.min(Number(options.index) || beforeCount + 1, beforeCount + 1)));
    } else {
      throw new Error(`unsupported_layout_action:${options.action || ""}`);
    }
    const layout = detectAdded(layouts, beforeCount, returned);
    if (options.name) layout.Name = String(options.name);
    if (options.matchingName) layout.MatchingName = String(options.matchingName);
    return { layoutHandle: handles.createLayoutHandle(presentation, design, layout), applied: true };
  }

  async function manageTheme(options = {}) {
    requireCapability("wpp.theme.manage");
    if (!options.path) throw new Error("theme path 不能为空");
    const presentation = await getPresentation();
    if (typeof presentation.ApplyTemplate2 === "function") presentation.ApplyTemplate2(String(options.path), options.variantGuid || "");
    else if (typeof presentation.ApplyTemplate === "function") presentation.ApplyTemplate(String(options.path));
    else throw new Error("native_theme_api_unavailable");
    return { applied: true, path: String(options.path) };
  }

  async function updateMaster(options = {}) {
    requireCapability("wpp.master.update");
    const presentation = await getPresentation();
    const handles = nativeHandles();
    if (["update_shape", "delete_shape"].includes(options.action)) {
      const resolved = handles.resolveMasterShapeHandle(presentation, options.shapeHandle);
      if (options.action === "delete_shape") { resolved.shape.Delete?.(); return { deleted: true }; }
      for (const [field, property] of [["left", "Left"], ["top", "Top"], ["width", "Width"], ["height", "Height"]]) {
        if (Number.isFinite(options[field])) resolved.shape[property] = Number(options[field]);
      }
      if (typeof options.name === "string") resolved.shape.Name = options.name;
      if (typeof options.text === "string") {
        const textRange = handles.safeGet(handles.safeGet(resolved.shape, "TextFrame", null), "TextRange", null);
        if (textRange) textRange.Text = options.text;
      }
      return { shapeHandle: options.shapeHandle, applied: true };
    }
    const designs = handles.designsOf(presentation);
    const design = handles.itemAt(designs, Math.max(1, Number(options.designIndex) || 1));
    const master = handles.safeGet(design, "SlideMaster", null);
    if (options.action !== "add_shape") throw new Error(`unsupported_master_action:${options.action || ""}`);
    const shapes = handles.safeGet(master, "Shapes", null);
    const beforeCount = handles.countOf(shapes);
    const type = options.shapeType === "ellipse" ? 9 : 1;
    const returned = shapes?.AddShape?.(type, Number(options.left) || 0, Number(options.top) || 0, Number(options.width) || 100, Number(options.height) || 40);
    const shape = detectAdded(shapes, beforeCount, returned);
    if (options.name) shape.Name = String(options.name);
    if (typeof options.text === "string") {
      const textRange = handles.safeGet(handles.safeGet(shape, "TextFrame", null), "TextRange", null);
      if (textRange) textRange.Text = options.text;
    }
    return { shapeHandle: handles.createMasterShapeHandle(presentation, design, shape), applied: true };
  }

  async function proxyJson(route, body) {
    const base = global.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890";
    const response = await global.fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `template export proxy failed: ${response.status}`);
    return payload;
  }

  async function exportTemplate(options = {}) {
    const finalPath = String(options.path || "");
    if (!/\.potx$/i.test(finalPath)) throw new Error("模板输出路径必须以 .potx 结尾");
    const presentation = await getPresentation();
    if (typeof presentation.SaveCopyAs !== "function") throw new Error("capability_unsupported:wpp.template.export:SaveCopyAs unavailable");
    const prepared = await proxyJson("/template-export/prepare", { finalPath, overwrite: options.overwrite === true });
    try {
      await Promise.resolve(presentation.SaveCopyAs(prepared.tempPath, 26, -1));
      const finalized = await proxyJson("/template-export/finalize", { token: prepared.token });
      const observedAt = new Date().toISOString();
      global.WpsAiWppCapabilities?.recordEvidence?.({
        platform: platform(),
        capabilities: { "wpp.template.export": { state: "supported", adapter: "wps_jsapi", reason: "SaveCopyAs(format=26) + OOXML validation passed" } },
        evidence: { observedAt, mutated: false, outputPath: finalized.path }
      });
      return { path: finalized.path, backupPath: finalized.backupPath || null, size: finalized.size || null, applied: true };
    } catch (error) {
      try { await proxyJson("/template-export/cleanup", { token: prepared.token }); } catch (cleanupError) {}
      throw error;
    }
  }

  global.WpsAiPresentationNative = {
    getPresentation, inspect, probe, addSlideFromLayout, managePlaceholder, manageLayout, manageTheme, updateMaster, exportTemplate
  };
})(window);
