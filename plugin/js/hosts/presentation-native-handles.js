(function attachWppNativeHandles(global) {
  "use strict";

  function safeGet(object, property, fallback = undefined) {
    try {
      const value = object?.[property];
      return value == null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function countOf(collection) {
    return Math.max(0, Number(safeGet(collection, "Count", 0)) || 0);
  }

  function itemAt(collection, index) {
    try { return collection?.Item?.(index) || null; } catch (error) { return null; }
  }

  function hash(value) {
    const input = String(value || "");
    let result = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      result ^= input.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function documentIdentity(presentation) {
    const fullName = safeGet(presentation, "FullName", "");
    const name = safeGet(presentation, "Name", "untitled");
    return hash(fullName || name);
  }

  function shapeFingerprint(shape) {
    return [safeGet(shape, "Id", ""), safeGet(shape, "Type", ""), safeGet(shape, "Name", "")].join("/");
  }

  function layoutFingerprint(layout) {
    const shapes = safeGet(layout, "Shapes", null);
    const shapeParts = [];
    for (let index = 1; index <= Math.min(countOf(shapes), 24); index += 1) {
      shapeParts.push(shapeFingerprint(itemAt(shapes, index)));
    }
    return hash([
      safeGet(layout, "Name", ""),
      safeGet(layout, "MatchingName", ""),
      countOf(shapes),
      shapeParts.join("|")
    ].join("::"));
  }

  function designsOf(presentation) {
    const designs = safeGet(presentation, "Designs", null);
    if (countOf(designs) > 0) return designs;
    const master = safeGet(presentation, "SlideMaster", null);
    if (!master) return null;
    return { Count: 1, Item: () => ({ Index: 1, Name: "default", SlideMaster: master }) };
  }

  function createLayoutHandle(presentation, design, layout) {
    return [
      "wpp-layout", "v1", documentIdentity(presentation),
      Number(safeGet(design, "Index", 0)) || 1,
      Number(safeGet(layout, "Index", 0)) || 1,
      layoutFingerprint(layout)
    ].join(":");
  }

  function parseHandle(handle, type) {
    const parts = String(handle || "").split(":");
    if (parts[0] !== `wpp-${type}` || parts[1] !== "v1") throw new Error(`invalid_${type}_handle`);
    return parts;
  }

  function resolveLayoutHandle(presentation, handle) {
    const parts = parseHandle(handle, "layout");
    if (parts[2] !== documentIdentity(presentation)) throw new Error("document_mismatch");
    const designHint = Number(parts[3]);
    const layoutHint = Number(parts[4]);
    const fingerprint = parts[5];
    const designs = designsOf(presentation);
    const matches = [];
    for (let di = 1; di <= countOf(designs); di += 1) {
      const design = itemAt(designs, di);
      const layouts = safeGet(safeGet(design, "SlideMaster", null), "CustomLayouts", null);
      const hinted = di === designHint ? itemAt(layouts, layoutHint) : null;
      if (hinted && layoutFingerprint(hinted) === fingerprint) return { design, layout: hinted };
      for (let li = 1; li <= countOf(layouts); li += 1) {
        const layout = itemAt(layouts, li);
        if (layout && layoutFingerprint(layout) === fingerprint) matches.push({ design, layout });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error("ambiguous_handle");
    throw new Error("stale_handle");
  }

  function createShapeHandle(presentation, slide, shape) {
    return ["wpp-shape", "v1", documentIdentity(presentation), safeGet(slide, "SlideID", 0), safeGet(shape, "Id", 0)].join(":");
  }

  function resolveShapeHandle(presentation, handle) {
    const parts = parseHandle(handle, "shape");
    if (parts[2] !== documentIdentity(presentation)) throw new Error("document_mismatch");
    const slideId = Number(parts[3]);
    const shapeId = Number(parts[4]);
    const slides = safeGet(presentation, "Slides", null);
    let slide = null;
    try { slide = slides?.FindBySlideID?.(slideId) || null; } catch (error) {}
    if (!slide) {
      for (let index = 1; index <= countOf(slides); index += 1) {
        const candidate = itemAt(slides, index);
        if (Number(safeGet(candidate, "SlideID", 0)) === slideId) { slide = candidate; break; }
      }
    }
    if (!slide) throw new Error("stale_handle");
    const shapes = safeGet(slide, "Shapes", null);
    for (let index = 1; index <= countOf(shapes); index += 1) {
      const shape = itemAt(shapes, index);
      if (Number(safeGet(shape, "Id", 0)) === shapeId) return { slide, shape };
    }
    throw new Error("stale_handle");
  }

  global.WpsAiWppHandles = {
    safeGet, countOf, itemAt, hash, documentIdentity, layoutFingerprint, designsOf,
    createLayoutHandle, resolveLayoutHandle, createShapeHandle, resolveShapeHandle
  };
})(window);
