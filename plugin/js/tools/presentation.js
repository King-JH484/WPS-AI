(function attachPresentationTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const wpp = () => global.WpsAiHostPresentation;
  const internal = () => wpp()?._internal;

  // PpSlideLayout 枚举（来自 wpp-jsapi-declare），常用版式映射
  const LAYOUTS = {
    title: 1,                // 标题幻灯片
    text: 2,                 // 标题 + 内容
    twoColumn: 3,            // 双栏文本
    titleOnly: 11,           // 仅标题
    blank: 12,               // 空白
    sectionHeader: 33,       // 节标题
    comparison: 34,          // 对比
    contentWithCaption: 35,  // 内容+标题说明
    pictureWithCaption: 36   // 图片+标题说明
  };

  // MsoTriState
  const MSO = { TRUE: -1, FALSE: 0 };

  // 单位换算：1 英寸 = 72 磅；slide 单位是磅（point）
  const POINT_PER_INCH = 72;

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return (b << 16) | (g << 8) | r; // BGR
  }

  function readShapeText(shape) {
    try {
      if (!shape?.HasTextFrame) return "";
      return String(shape.TextFrame?.TextRange?.Text || "");
    } catch (e) { return ""; }
  }

  function listSlideShapes(slide) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    const out = [];
    for (let i = 1; i <= count; i += 1) {
      const shape = shapes.Item(i);
      let text = "";
      try { text = readShapeText(shape); } catch (e) {}
      let isPlaceholder = false;
      const placeholderType = safeGetPlaceholderType(shape);
      if (placeholderType !== undefined) isPlaceholder = true;
      // shape.Type 在 WPS 中：14 = msoPlaceholder
      try { if (!isPlaceholder && shape.Type === 14) isPlaceholder = true; } catch (e) {}
      out.push({
        index: i,
        name: shape.Name || `Shape${i}`,
        text,
        hasText: !!text,
        isPlaceholder,
        placeholderType,
        // 给 AI 看类型语义，方便 debug
        placeholderRole: placeholderType !== undefined
          ? (TITLE_PH_TYPES.has(placeholderType) ? "title"
              : BODY_PH_TYPES.has(placeholderType) ? "body"
              : SKIP_PH_TYPES.has(placeholderType) ? "skip"
              : "other")
          : null
      });
    }
    return out;
  }

  async function getPresentation() {
    const pres = await internal().getActivePresentation();
    if (!pres) throw new Error("未检测到打开的 WPS 演示。");
    return pres;
  }

  function getSlideAt(pres, index) {
    if (!index) {
      // 0 / 未传 → 当前幻灯片
      const win = pres.Application?.ActiveWindow;
      if (win?.View?.Slide) return win.View.Slide;
      return pres.Slides.Item(1);
    }
    const slide = pres.Slides.Item(index);
    if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
    return slide;
  }

  // PpPlaceholderType 实际枚举值（来自 wpp-jsapi-declare）：
  //   -2 Mixed / 1 Title / 2 Body / 3 CenterTitle / 4 Subtitle
  //   5 VerticalTitle / 6 VerticalBody / 7 Object / 8 Chart
  //   9 Bitmap / 10 MediaClip / 11 OrgChart / 12 Table
  //   13 SlideNumber / 14 Header / 15 Footer / 16 Date
  //   17 VerticalObject / 18 Picture
  // 标题类（含副标题——封面副标题视觉上跟主标题一组）：
  const TITLE_PH_TYPES = new Set([1, 3, 4, 5]);
  // 正文类（包含 Object / Chart / OrgChart / Table 这些可能填文字的容器）：
  const BODY_PH_TYPES = new Set([2, 6, 7, 8, 11, 12, 17]);
  // 不要乱改的：页眉/页脚/页码/日期/位图/媒体/纯图片
  const SKIP_PH_TYPES = new Set([9, 10, 13, 14, 15, 16, 18]);

  function safeGetPlaceholderType(shape) {
    try { return shape.PlaceholderFormat?.Type; } catch (e) { return undefined; }
  }

  function findTitleShape(slide) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    // 1) 优先按 PlaceholderType 找
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      const t = safeGetPlaceholderType(sh);
      if (t !== undefined && TITLE_PH_TYPES.has(t)) return sh;
    }
    // 2) 按形状 Name 找（"Title 1" / "标题 1" 之类）
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      try {
        if (sh.HasTextFrame && /title|标题/i.test(sh.Name || "")) return sh;
      } catch (e) {}
    }
    return null;
  }

  function findBodyShape(slide, excludeShape) {
    const shapes = slide.Shapes;
    const count = shapes?.Count || 0;
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      if (sh === excludeShape) continue;
      const t = safeGetPlaceholderType(sh);
      if (t !== undefined && BODY_PH_TYPES.has(t)) return sh;
    }
    // 名称 fallback
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      if (sh === excludeShape) continue;
      try {
        if (sh.HasTextFrame && /(content|body|text|placeholder|内容|正文)/i.test(sh.Name || "")) return sh;
      } catch (e) {}
    }
    // 兜底：第一个有 TextFrame、不是 title、不是页眉/页脚/页码 的形状
    for (let i = 1; i <= count; i += 1) {
      const sh = shapes.Item(i);
      if (sh === excludeShape) continue;
      const t = safeGetPlaceholderType(sh);
      if (t !== undefined && (SKIP_PH_TYPES.has(t) || TITLE_PH_TYPES.has(t))) continue;
      try { if (sh.HasTextFrame) return sh; } catch (e) {}
    }
    return null;
  }

  // ============ 现有工具：保留 + 增强 ============

  registry.registerTool({
    name: "wpp_list_slides",
    hosts: ["wpp"],
    description: "列出当前演示文稿所有幻灯片摘要：序号、形状数、布局编号、标题预览、文字预览。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pres = await getPresentation();
      const count = pres.Slides?.Count || 0;
      const summary = [];
      for (let i = 1; i <= count; i += 1) {
        const slide = pres.Slides.Item(i);
        const title = (() => {
          const t = findTitleShape(slide);
          return t ? readShapeText(t).trim() : "";
        })();
        const text = String(internal().readSlideText(slide) || "").trim();
        let layout = null;
        try { layout = slide.Layout; } catch (e) {}
        summary.push({
          index: i,
          shapeCount: slide.Shapes?.Count || 0,
          layout,
          title,
          textPreview: text.slice(0, 200)
        });
      }
      return { count, slides: summary };
    }
  });

  registry.registerTool({
    name: "wpp_read_slide",
    hosts: ["wpp"],
    description: "读取指定幻灯片所有形状的文本和占位信息。index=0 或省略表示当前幻灯片。",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0, description: "幻灯片序号（从 1 开始；0 或省略=当前页）" }
      }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = getSlideAt(pres, index || 0);
      return {
        index: slide.SlideIndex || index || 0,
        layout: slide.Layout,
        shapes: listSlideShapes(slide)
      };
    }
  });

  registry.registerTool({
    name: "wpp_replace_shape_text",
    hosts: ["wpp"],
    description: "替换指定幻灯片中指定形状的文本。slide=0 表示当前页。",
    parameters: {
      type: "object",
      required: ["shape", "text"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        shape: { type: "integer", description: "形状序号（参考 wpp_read_slide 返回的 index）" },
        text: { type: "string" }
      }
    },
    handler: async ({ slide, shape, text } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj) throw new Error(`形状 ${shape} 不存在`);
      if (!shapeObj.HasTextFrame) throw new Error(`形状 ${shape} 不支持文本`);
      shapeObj.TextFrame.TextRange.Text = text;
      return { slide: slideObj.SlideIndex || slide, shape, length: text.length };
    }
  });

  // ============ 幻灯片增删改 ============

  registry.registerTool({
    name: "wpp_add_slide",
    hosts: ["wpp"],
    description: "在指定位置之后插入新幻灯片。layout 控制版式：title=标题页 / text=标题+内容 / titleOnly=仅标题 / blank=空白 / sectionHeader=节标题 / comparison=对比 / contentWithCaption=内容+说明 / pictureWithCaption=图片+说明。返回新幻灯片序号。",
    parameters: {
      type: "object",
      properties: {
        afterIndex: { type: "integer", minimum: 0, description: "在第几张后插入；省略或 0 = 末尾" },
        layout: {
          type: "string",
          enum: ["title", "text", "twoColumn", "titleOnly", "blank", "sectionHeader", "comparison", "contentWithCaption", "pictureWithCaption"],
          default: "text",
          description: "幻灯片版式"
        },
        title: { type: "string", description: "可选：自动填到标题占位符" },
        body: { type: "string", description: "可选：自动填到内容占位符（多段用 \\n 分隔）" }
      }
    },
    handler: async ({ afterIndex, layout = "text", title, body } = {}) => {
      const pres = await getPresentation();
      const total = pres.Slides.Count;
      const layoutId = LAYOUTS[layout] ?? LAYOUTS.text;
      const insertAt = afterIndex == null || afterIndex === 0
        ? total + 1
        : Math.max(1, Math.min(total + 1, afterIndex + 1));
      const slide = pres.Slides.Add(insertAt, layoutId);

      let titleFilled = false;
      let bodyFilled = false;
      let titleShape = null;

      if (title) {
        titleShape = findTitleShape(slide);
        if (titleShape) {
          try {
            titleShape.TextFrame.TextRange.Text = title;
            titleFilled = true;
          } catch (e) { /* ignore */ }
        }
      }

      if (body) {
        const bodyShape = findBodyShape(slide, titleShape);
        if (bodyShape) {
          try {
            bodyShape.TextFrame.TextRange.Text = body;
            bodyFilled = true;
          } catch (e) { /* ignore */ }
        }
      }

      return {
        index: slide.SlideIndex || insertAt,
        layout,
        titleFilled,
        bodyFilled,
        // 调用方拿 false 时可以用 wpp_add_text_box 自行补一个文本框上去
        warning: (title && !titleFilled) || (body && !bodyFilled)
          ? `部分占位符未找到（titleFilled=${titleFilled}, bodyFilled=${bodyFilled}），请用 wpp_add_text_box 补充`
          : undefined
      };
    }
  });

  registry.registerTool({
    name: "wpp_delete_slide",
    hosts: ["wpp"],
    description: "删除指定序号的幻灯片。慎用。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1 }
      }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      slide.Delete();
      return { deleted: index };
    }
  });

  registry.registerTool({
    name: "wpp_move_slide",
    hosts: ["wpp"],
    description: "把幻灯片移动到指定位置。",
    parameters: {
      type: "object",
      required: ["fromIndex", "toIndex"],
      properties: {
        fromIndex: { type: "integer", minimum: 1 },
        toIndex: { type: "integer", minimum: 1, description: "目标位置（1-based）" }
      }
    },
    handler: async ({ fromIndex, toIndex } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(fromIndex);
      if (!slide) throw new Error(`幻灯片 ${fromIndex} 不存在`);
      slide.MoveTo(toIndex);
      return { from: fromIndex, to: toIndex };
    }
  });

  registry.registerTool({
    name: "wpp_duplicate_slide",
    hosts: ["wpp"],
    description: "复制一张幻灯片（新副本紧跟在原幻灯片之后）。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: { index: { type: "integer", minimum: 1 } }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      const range = slide.Duplicate();
      const newIdx = range?.Item?.(1)?.SlideIndex || index + 1;
      return { source: index, newIndex: newIdx };
    }
  });

  registry.registerTool({
    name: "wpp_set_slide_layout",
    hosts: ["wpp"],
    description: "切换某张幻灯片的版式。",
    parameters: {
      type: "object",
      required: ["index", "layout"],
      properties: {
        index: { type: "integer", minimum: 1 },
        layout: { type: "string", enum: ["title", "text", "twoColumn", "titleOnly", "blank", "sectionHeader", "comparison", "contentWithCaption", "pictureWithCaption"] }
      }
    },
    handler: async ({ index, layout } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      const id = LAYOUTS[layout];
      if (id == null) throw new Error(`未知 layout：${layout}`);
      slide.Layout = id;
      return { index, layout };
    }
  });

  registry.registerTool({
    name: "wpp_select_slide",
    hosts: ["wpp"],
    description: "把视图切换到指定幻灯片。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: { index: { type: "integer", minimum: 1 } }
    },
    handler: async ({ index } = {}) => {
      const pres = await getPresentation();
      const slide = pres.Slides.Item(index);
      if (!slide) throw new Error(`幻灯片 ${index} 不存在`);
      slide.Select();
      return { active: index };
    }
  });

  // ============ 幻灯片内容（标题/正文/演讲者备注） ============

  registry.registerTool({
    name: "wpp_set_title",
    hosts: ["wpp"],
    description: "设置某张幻灯片的标题（自动找标题占位符）。slide=0 表示当前页。",
    parameters: {
      type: "object",
      required: ["title"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        title: { type: "string" }
      }
    },
    handler: async ({ slide, title } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const titleShape = findTitleShape(slideObj);
      if (!titleShape) throw new Error("当前幻灯片没有标题占位符。可改用 wpp_add_text_box 自己加一个标题。");
      titleShape.TextFrame.TextRange.Text = title;
      return { slide: slideObj.SlideIndex || slide, title };
    }
  });

  registry.registerTool({
    name: "wpp_set_notes",
    hosts: ["wpp"],
    description: "设置幻灯片的演讲者备注（在 NotesPage 上写文字）。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        text: { type: "string", description: "备注内容（会替换原有备注）" }
      }
    },
    handler: async ({ slide, text } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const notesPage = slideObj.NotesPage;
      if (!notesPage) throw new Error("当前幻灯片没有备注页。");
      // 备注页第一个有 TextFrame 的形状（不是占位编号那种，常见是第二个形状）
      const shapes = notesPage.Item ? notesPage.Item(1).Shapes : notesPage.Shapes;
      const count = shapes?.Count || 0;
      let target = null;
      for (let i = 1; i <= count; i += 1) {
        const sh = shapes.Item(i);
        try {
          if (sh.HasTextFrame && sh.PlaceholderFormat?.Type === 12) { target = sh; break; } // ppPlaceholderBody
        } catch (e) {}
      }
      if (!target) {
        for (let i = 1; i <= count; i += 1) {
          const sh = shapes.Item(i);
          try { if (sh.HasTextFrame) { target = sh; break; } } catch (e) {}
        }
      }
      if (!target) throw new Error("备注页找不到可写文本的形状。");
      target.TextFrame.TextRange.Text = text;
      return { slide: slideObj.SlideIndex || slide, length: text.length };
    }
  });

  registry.registerTool({
    name: "wpp_get_notes",
    hosts: ["wpp"],
    description: "读取幻灯片的演讲者备注。",
    parameters: {
      type: "object",
      properties: { slide: { type: "integer", minimum: 0 } }
    },
    handler: async ({ slide } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const notesPage = slideObj.NotesPage;
      if (!notesPage) return { text: "" };
      const shapes = notesPage.Item ? notesPage.Item(1).Shapes : notesPage.Shapes;
      const count = shapes?.Count || 0;
      const buf = [];
      for (let i = 1; i <= count; i += 1) {
        const sh = shapes.Item(i);
        try {
          if (sh.HasTextFrame && sh.PlaceholderFormat?.Type === 12) {
            buf.push(String(sh.TextFrame.TextRange.Text || ""));
          }
        } catch (e) {}
      }
      return { slide: slideObj.SlideIndex || slide, text: buf.join("\n").trim() };
    }
  });

  // ============ 形状新增（文本框 / 图片 / 表格） ============

  registry.registerTool({
    name: "wpp_add_text_box",
    hosts: ["wpp"],
    description: "在幻灯片上新增一个文本框。坐标和尺寸单位为磅（72 磅 = 1 英寸；常见幻灯片宽 720 磅 / 高 540 磅）。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        text: { type: "string" },
        left: { type: "number", default: 50 },
        top: { type: "number", default: 50 },
        width: { type: "number", default: 600 },
        height: { type: "number", default: 80 },
        fontSize: { type: "number", description: "字号（磅）" },
        bold: { type: "boolean" },
        color: { type: "string", description: "字体颜色 #RRGGBB" }
      }
    },
    handler: async ({ slide, text, left = 50, top = 50, width = 600, height = 80, fontSize, bold, color } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      // MsoTextOrientation: msoTextOrientationHorizontal = 1
      const shape = slideObj.Shapes.AddTextbox(1, left, top, width, height);
      const tr = shape.TextFrame.TextRange;
      tr.Text = text;
      try {
        if (typeof fontSize === "number") tr.Font.Size = fontSize;
        if (typeof bold === "boolean") tr.Font.Bold = bold ? MSO.TRUE : MSO.FALSE;
        if (color) tr.Font.Color.RGB = parseColor(color);
      } catch (e) {}
      return { slide: slideObj.SlideIndex || slide, shapeIndex: slideObj.Shapes.Count };
    }
  });

  registry.registerTool({
    name: "wpp_add_picture",
    hosts: ["wpp"],
    description: "在幻灯片上插入图片。fileName 可以是 HTTP URL 或本地路径。常配合 generate_image 使用：先生成拿到 URL，再调本工具插入到幻灯片。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前）" },
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        left: { type: "number", default: 100 },
        top: { type: "number", default: 100 },
        width: { type: "number", description: "宽度（磅），省略使用原图" },
        height: { type: "number", description: "高度（磅），省略使用原图" }
      }
    },
    handler: async ({ slide, fileName, left = 100, top = 100, width, height } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      // AddPicture(FileName, LinkToFile, SaveWithDocument, Left, Top, Width?, Height?)
      const shape = slideObj.Shapes.AddPicture(fileName, MSO.FALSE, MSO.TRUE, left, top, width, height);
      return { slide: slideObj.SlideIndex || slide, fileName, shapeIndex: slideObj.Shapes.Count };
    }
  });

  registry.registerTool({
    name: "wpp_add_table",
    hosts: ["wpp"],
    description: "在幻灯片上插入表格（无填充）。后续可以用 wpp_set_table_cell 写入数据。",
    parameters: {
      type: "object",
      required: ["rows", "cols"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        rows: { type: "integer", minimum: 1 },
        cols: { type: "integer", minimum: 1 },
        left: { type: "number", default: 50 },
        top: { type: "number", default: 100 },
        width: { type: "number", default: 600 },
        height: { type: "number", default: 300 },
        data: {
          type: "array",
          description: "可选二维数组，自动填充；外层为行内层为列，单元格按 String() 写入",
          items: { type: "array", items: { type: "string" } }
        }
      }
    },
    handler: async ({ slide, rows, cols, left = 50, top = 100, width = 600, height = 300, data } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shape = slideObj.Shapes.AddTable(rows, cols, left, top, width, height);
      if (Array.isArray(data) && shape.Table) {
        for (let r = 0; r < Math.min(rows, data.length); r += 1) {
          const row = data[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < Math.min(cols, row.length); c += 1) {
            try {
              const cell = shape.Table.Cell(r + 1, c + 1);
              cell.Shape.TextFrame.TextRange.Text = String(row[c] ?? "");
            } catch (e) {}
          }
        }
      }
      return { slide: slideObj.SlideIndex || slide, rows, cols, filled: !!data };
    }
  });

  registry.registerTool({
    name: "wpp_set_table_cell",
    hosts: ["wpp"],
    description: "设置表格指定单元格的文本。",
    parameters: {
      type: "object",
      required: ["shape", "row", "col", "text"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        shape: { type: "integer", description: "表格形状的序号（参考 wpp_read_slide）" },
        row: { type: "integer", minimum: 1 },
        col: { type: "integer", minimum: 1 },
        text: { type: "string" }
      }
    },
    handler: async ({ slide, shape, row, col, text } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj?.Table) throw new Error(`形状 ${shape} 不是表格`);
      const cell = shapeObj.Table.Cell(row, col);
      cell.Shape.TextFrame.TextRange.Text = text;
      return { slide: slideObj.SlideIndex || slide, shape, row, col };
    }
  });

  registry.registerTool({
    name: "wpp_delete_shape",
    hosts: ["wpp"],
    description: "删除幻灯片上的某个形状。",
    parameters: {
      type: "object",
      required: ["shape"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        shape: { type: "integer", description: "形状序号（参考 wpp_read_slide）" }
      }
    },
    handler: async ({ slide, shape } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj) throw new Error(`形状 ${shape} 不存在`);
      shapeObj.Delete();
      return { slide: slideObj.SlideIndex || slide, deleted: shape };
    }
  });

  // ============ 文本格式化 ============

  registry.registerTool({
    name: "wpp_format_shape_text",
    hosts: ["wpp"],
    description: "对某形状的文本设置字体格式（粗/斜/下划线/字号/字体/颜色）。所有格式参数可选。",
    parameters: {
      type: "object",
      required: ["shape"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        shape: { type: "integer" },
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        underline: { type: "boolean" },
        fontName: { type: "string" },
        fontSize: { type: "number" },
        color: { type: "string", description: "字体颜色 #RRGGBB" }
      }
    },
    handler: async ({ slide, shape, bold, italic, underline, fontName, fontSize, color } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeObj = slideObj.Shapes.Item(shape);
      if (!shapeObj?.HasTextFrame) throw new Error(`形状 ${shape} 不支持文本`);
      const font = shapeObj.TextFrame.TextRange.Font;
      const applied = {};
      if (typeof bold === "boolean") { font.Bold = bold ? MSO.TRUE : MSO.FALSE; applied.bold = bold; }
      if (typeof italic === "boolean") { font.Italic = italic ? MSO.TRUE : MSO.FALSE; applied.italic = italic; }
      if (typeof underline === "boolean") { font.Underline = underline ? MSO.TRUE : MSO.FALSE; applied.underline = underline; }
      if (fontName) { font.Name = fontName; applied.fontName = fontName; }
      if (typeof fontSize === "number") { font.Size = fontSize; applied.fontSize = fontSize; }
      if (color) { font.Color.RGB = parseColor(color); applied.color = color; }
      return { slide: slideObj.SlideIndex || slide, shape, applied };
    }
  });

  // ============ Presentation 级别 ============

  registry.registerTool({
    name: "wpp_get_presentation_info",
    hosts: ["wpp"],
    description: "获取演示文稿元信息：文件名、保存状态、幻灯片数、页面尺寸。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pres = await getPresentation();
      const ps = pres.PageSetup;
      return {
        name: pres.Name,
        path: pres.Path || null,
        saved: pres.Saved == null ? null : !!pres.Saved,
        slideCount: pres.Slides?.Count || 0,
        slideWidth: ps?.SlideWidth ?? null,
        slideHeight: ps?.SlideHeight ?? null
      };
    }
  });

  registry.registerTool({
    name: "wpp_apply_theme",
    hosts: ["wpp"],
    description: "对指定幻灯片应用主题文件。themePath 是本地 .pptx/.thmx/.potx 文件路径，应用后会替换该幻灯片的设计模板。",
    parameters: {
      type: "object",
      required: ["themePath"],
      properties: {
        themePath: { type: "string" },
        slide: { type: "integer", minimum: 0, description: "省略=当前页；传 0 同样表示当前页；传 -1 表示对所有页应用" }
      }
    },
    handler: async ({ themePath, slide } = {}) => {
      const pres = await getPresentation();
      if (slide === -1) {
        const count = pres.Slides.Count;
        for (let i = 1; i <= count; i += 1) {
          try { pres.Slides.Item(i).ApplyTemplate(themePath); } catch (e) {}
        }
        return { themePath, applied: "all" };
      }
      const slideObj = getSlideAt(pres, slide || 0);
      slideObj.ApplyTemplate(themePath);
      return { themePath, applied: slideObj.SlideIndex || slide };
    }
  });

  registry.registerTool({
    name: "wpp_save",
    hosts: ["wpp"],
    description: "保存当前演示文稿（使用现有路径）。新文件需要先在 WPS 里另存为再调用此工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const pres = await getPresentation();
      try {
        pres.Save();
        return { saved: true, name: pres.Name };
      } catch (e) {
        throw new Error(`保存失败（可能是新文件没有路径）：${e.message || e}`);
      }
    }
  });

  // ============ 风格预设（与「PPT 风格」对话框联动） ============

  registry.registerTool({
    name: "wpp_get_style_preset",
    hosts: ["wpp"],
    description: [
      "读取用户在「PPT 风格」对话框里设定的统一样式预设和色板。",
      "返回字段：",
      "  - enabled, scheme（色板方案标识）",
      "  - titleFont/titleSize/titleBold/titleColor 标题字体设置",
      "  - bodyFont/bodySize/bodyColor 正文字体设置",
      "  - **色板**：primaryColor（主色，章节页背景/装饰色块）、secondaryColor（次色/边框）、accentColor（强调色，点缀高亮）、backgroundColor（幻灯片底色）、surfaceColor（卡片/内容块底色）",
      "  - themeFile 可选模板路径",
      "  - **主题元信息**：themeLabel（英文名）、themeDescription（用途定位）、themeDesign（设计理念+灵感来源，AI 生成时可参考调性）、darkMode（true=深色底主题，文字反白；用图表配色时也要切换深色板）",
      "做高级版式时建议组合使用：",
      "  - 章节分隔页 → wpp_set_slide_background 用 primaryColor 满屏；标题用白色大字号",
      "  - 内容页 → 背景 backgroundColor；左侧 wpp_add_shape(rectangle, width=8, height=slideHeight, fill=primaryColor) 加装饰条",
      "  - 数据/统计页 → 用 wpp_add_shape(roundedRect, fill=surfaceColor) 做卡片容器；或调 wpp_render_chart 生成图表插图",
      "  - 强调元素 → accentColor",
      "通过这套色板和 themeDesign 描述的调性让所有页风格统一。"
    ].join("\n"),
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = settings.stylePreset || { enabled: false };
      const out = Object.assign({}, sp);
      const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
      const matched = sp.scheme && schemes[sp.scheme];
      if (matched) {
        out.themeLabel = matched.label;
        out.themeDescription = matched.description;
        out.themeDesign = matched.design;
        out.darkMode = !!matched.darkMode;
      } else {
        out.themeLabel = "Custom";
        out.themeDescription = "用户自定义色板";
        out.themeDesign = "用户自调，无固定设计参考";
        // 推断 darkMode：背景色亮度 < 128 视为深色
        const bg = (sp.backgroundColor || "#ffffff").replace("#", "");
        if (bg.length === 6) {
          const r = parseInt(bg.slice(0, 2), 16);
          const g = parseInt(bg.slice(2, 4), 16);
          const b = parseInt(bg.slice(4, 6), 16);
          out.darkMode = (r * 299 + g * 587 + b * 114) / 1000 < 128;
        } else {
          out.darkMode = false;
        }
      }
      return out;
    }
  });

  registry.registerTool({
    name: "wpp_apply_style_preset",
    hosts: ["wpp"],
    description: "把用户保存的风格预设统一应用到指定幻灯片的标题/正文/普通文本框。slide=0 表示当前页；省略 slide 表示对所有幻灯片应用。即使预设 enabled=false 也会按已有字段应用一遍商用统一样式（不会失败）。除占位符外，也会顺手把页面上其它纯文本框统一字体（标题用大字号 / 正文用小字号根据高度判断）。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前页；省略=所有页）" },
        formatTextBoxes: { type: "boolean", default: true, description: "是否同时格式化非占位符的纯文本框" }
      }
    },
    handler: async ({ slide, formatTextBoxes = true } = {}) => {
      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = settings.stylePreset || {};
      const pres = await getPresentation();
      const targets = [];
      if (slide === undefined || slide === null) {
        const count = pres.Slides?.Count || 0;
        for (let i = 1; i <= count; i += 1) targets.push(pres.Slides.Item(i));
      } else {
        targets.push(getSlideAt(pres, slide || 0));
      }

      // 取值：未填的字段用一套商用默认值兜底
      const titleFont = sp.titleFont || "Microsoft YaHei";
      const titleSize = sp.titleSize || 32;
      const titleBold = sp.titleBold !== false;
      const titleColor = parseColor(sp.titleColor || "#1f2329");
      const bodyFont = sp.bodyFont || "Microsoft YaHei";
      const bodySize = sp.bodySize || 18;
      const bodyColor = parseColor(sp.bodyColor || "#33363c");

      // 多路径写字体/颜色/加粗，应对 WPS 不同版本和中英文字体差异
      function forceFont(shape, fontName, fontSize, boldFlag, colorBgr) {
        // 1) 经典路径 TextFrame.TextRange.Font
        try {
          const f = shape.TextFrame.TextRange.Font;
          try { f.Name = fontName; } catch (e) {}
          try { f.Size = fontSize; } catch (e) {}
          if (typeof boldFlag === "boolean") {
            // 不同 WPS 版本接受不同值，全都 try 一遍最安全
            for (const v of [boldFlag ? -1 : 0, boldFlag ? 1 : 0, boldFlag]) {
              try { f.Bold = v; break; } catch (e) {}
            }
          }
          // 强制 RGB 类型再设颜色（避免主题色覆盖）
          try { f.Color.Type = 1; } catch (e) {}
          try { f.Color.RGB = colorBgr; } catch (e) {}
        } catch (e) {}

        // 2) 新路径 TextFrame2 — 中文要用 NameFarEast，西文用 NameAscii
        try {
          const f2 = shape.TextFrame2?.TextRange?.Font;
          if (f2) {
            try { f2.NameFarEast = fontName; } catch (e) {}
            try { f2.NameAscii = fontName; } catch (e) {}
            try { f2.NameOther = fontName; } catch (e) {}
            try { f2.Size = fontSize; } catch (e) {}
            if (typeof boldFlag === "boolean") {
              for (const v of [boldFlag ? -1 : 0, boldFlag ? 1 : 0, boldFlag]) {
                try { f2.Bold = v; break; } catch (e) {}
              }
            }
            try { f2.Fill.ForeColor.RGB = colorBgr; } catch (e) {}
          }
        } catch (e) {}

        // 3) Characters() 路径 — 强制每个字符都套上
        try {
          const tr = shape.TextFrame.TextRange;
          const len = tr.Length || tr.Text?.length || 0;
          if (len > 0) {
            const chars = tr.Characters(1, len);
            try { chars.Font.Name = fontName; } catch (e) {}
            try { chars.Font.Size = fontSize; } catch (e) {}
            if (typeof boldFlag === "boolean") {
              for (const v of [boldFlag ? -1 : 0, boldFlag ? 1 : 0, boldFlag]) {
                try { chars.Font.Bold = v; break; } catch (e) {}
              }
            }
            try { chars.Font.Color.Type = 1; } catch (e) {}
            try { chars.Font.Color.RGB = colorBgr; } catch (e) {}
          }
        } catch (e) {}
      }

      let processed = 0;
      let titleHits = 0, bodyHits = 0, otherHits = 0;

      for (const slideObj of targets) {
        const shapes = slideObj.Shapes;
        const cnt = shapes?.Count || 0;

        for (let i = 1; i <= cnt; i += 1) {
          const sh = shapes.Item(i);
          let hasFrame = false;
          try { hasFrame = !!sh.HasTextFrame; } catch (e) {}
          if (!hasFrame) continue;

          const phType = safeGetPlaceholderType(sh);
          if (phType !== undefined && SKIP_PH_TYPES.has(phType)) continue;

          let role = "other";
          if (phType !== undefined && TITLE_PH_TYPES.has(phType)) role = "title";
          else if (phType !== undefined && BODY_PH_TYPES.has(phType)) role = "body";

          try {
            // 空文本框跳过（避免修改空 shape 反而引入隐藏问题）
            let textVal = "";
            try { textVal = String(sh.TextFrame.TextRange.Text || ""); } catch (e) {}
            if (!textVal.trim()) continue;

            if (role === "title") {
              forceFont(sh, titleFont, titleSize, titleBold, titleColor);
              titleHits += 1;
            } else if (role === "body") {
              forceFont(sh, bodyFont, bodySize, undefined, bodyColor);
              bodyHits += 1;
            } else if (formatTextBoxes) {
              let h = 0;
              try { h = sh.Height; } catch (e) {}
              if (h >= 80) {
                forceFont(sh, titleFont, titleSize, titleBold, titleColor);
              } else {
                forceFont(sh, bodyFont, bodySize, undefined, bodyColor);
              }
              otherHits += 1;
            }
          } catch (e) { /* 单个形状失败不影响其他 */ }
        }
        processed += 1;
      }

      return {
        processed,
        scope: slide === undefined || slide === null ? "all" : (slide || 0),
        applied: { titleHits, bodyHits, otherHits },
        usedDefaults: !sp.enabled,
        preset: { titleFont, titleSize, titleBold, bodyFont, bodySize }
      };
    }
  });

  // ============ 内部 helper：模板用的低层操作 ============

  function setBg(slideObj, color) {
    try {
      try { slideObj.FollowMasterBackground = MSO.FALSE; } catch (e) {}
      const bg = slideObj.Background;
      if (!bg) return;
      const fill = bg.Fill;
      try { fill.Solid(); } catch (e) {}
      try { fill.ForeColor.Type = 1; } catch (e) {}
      try { fill.ForeColor.RGB = parseColor(color); } catch (e) {}
    } catch (e) {}
  }

  function addRect(slide, x, y, w, h, fillColor, opts = {}) {
    const sh = slide.Shapes.AddShape(1 /* rectangle */, x, y, w, h);
    try {
      if (fillColor) {
        sh.Fill.Solid();
        try { sh.Fill.ForeColor.Type = 1; } catch (e) {}
        sh.Fill.ForeColor.RGB = parseColor(fillColor);
      } else {
        sh.Fill.Visible = MSO.FALSE;
      }
    } catch (e) {}
    try {
      if (opts.lineColor) {
        sh.Line.Visible = MSO.TRUE;
        try { sh.Line.ForeColor.Type = 1; } catch (e) {}
        sh.Line.ForeColor.RGB = parseColor(opts.lineColor);
      } else {
        sh.Line.Visible = MSO.FALSE;
      }
    } catch (e) {}
    return sh;
  }

  function addText(slide, x, y, w, h, text, opts = {}) {
    const sh = slide.Shapes.AddTextbox(1 /* horizontal */, x, y, w, h);
    const tr = sh.TextFrame.TextRange;
    try { tr.Text = String(text || ""); } catch (e) {}
    if (opts.fontName) {
      try { tr.Font.Name = opts.fontName; } catch (e) {}
      try {
        const f2 = sh.TextFrame2?.TextRange?.Font;
        if (f2) {
          f2.NameFarEast = opts.fontName;
          f2.NameAscii = opts.fontName;
        }
      } catch (e) {}
    }
    if (opts.fontSize) try { tr.Font.Size = opts.fontSize; } catch (e) {}
    if (typeof opts.bold === "boolean") {
      for (const v of [opts.bold ? -1 : 0, opts.bold ? 1 : 0, opts.bold]) {
        try { tr.Font.Bold = v; break; } catch (e) {}
      }
    }
    if (opts.italic) {
      try { tr.Font.Italic = -1; } catch (e) {}
    }
    if (opts.color) {
      try { tr.Font.Color.Type = 1; } catch (e) {}
      try { tr.Font.Color.RGB = parseColor(opts.color); } catch (e) {}
    }
    if (opts.alignH) {
      // 1=left 2=center 3=right
      const map = { left: 1, center: 2, right: 3 };
      try { tr.ParagraphFormat.Alignment = map[opts.alignH] || 1; } catch (e) {}
    }
    // 关闭文本框边框（textbox 默认无边框，保险起见）
    try { sh.Line.Visible = MSO.FALSE; } catch (e) {}
    return sh;
  }

  // ============ 背景 / 形状（高级版式必备） ============

  registry.registerTool({
    name: "wpp_set_slide_background",
    hosts: ["wpp"],
    description: "设置幻灯片背景纯色填充。slide=0 当前页；省略 slide 表示对所有页应用。配合 wpp_get_style_preset 拿到的 backgroundColor / primaryColor 用，章节分隔页可用 primaryColor 做满屏底色。",
    parameters: {
      type: "object",
      required: ["color"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前页；省略=所有页）" },
        color: { type: "string", description: "颜色 #RRGGBB，例 #1f3a5f" }
      }
    },
    handler: async ({ slide, color } = {}) => {
      const pres = await getPresentation();
      const targets = [];
      if (slide === undefined || slide === null) {
        const count = pres.Slides?.Count || 0;
        for (let i = 1; i <= count; i += 1) targets.push(pres.Slides.Item(i));
      } else {
        targets.push(getSlideAt(pres, slide || 0));
      }
      const bgr = parseColor(color);
      let processed = 0;
      for (const slideObj of targets) {
        try {
          // 让幻灯片不再继承母版背景
          try { slideObj.FollowMasterBackground = MSO.FALSE; } catch (e) {}
          const bg = slideObj.Background;
          if (bg) {
            try {
              const fill = bg.Fill;
              try { fill.Solid(); } catch (e) {}
              try { fill.ForeColor.Type = 1; } catch (e) {}
              try { fill.ForeColor.RGB = bgr; } catch (e) {}
            } catch (e) {}
          }
          processed += 1;
        } catch (e) { /* skip */ }
      }
      return { processed, color, scope: slide === undefined || slide === null ? "all" : (slide || 0) };
    }
  });

  // 常用 MsoAutoShapeType（来自 kso.MsoAutoShapeType）
  const SHAPE_TYPES = {
    rectangle: 1,           // msoShapeRectangle
    roundedRect: 5,         // msoShapeRoundedRectangle
    oval: 9,                // msoShapeOval
    diamond: 4,             // msoShapeDiamond
    triangle: 7,            // msoShapeIsoscelesTriangle
    pentagon: 51,           // msoShapePentagon
    hexagon: 10,            // msoShapeHexagon
    star5: 12,              // msoShape5pointStar
    rightArrow: 33,         // msoShapeRightArrow
    leftArrow: 34,
    upArrow: 35,
    downArrow: 36,
    chevron: 52,            // msoShapeChevron
    parallelogram: 8,       // msoShapeParallelogram
    trapezoid: 6,           // msoShapeTrapezoid
    line: 1,                // 用 rectangle 高度=1 模拟横线
    plus: 11                // msoShapePlus
  };

  registry.registerTool({
    name: "wpp_add_shape",
    hosts: ["wpp"],
    description: "在幻灯片上添加一个形状（矩形/圆角矩形/圆/箭头/星形等）。常用于：左侧装饰色块（rectangle 高度=slideHeight，宽 8）、章节页背景色块、统计页大圆点、流程箭头等。可设填充色、描边色、可选写入文字。坐标单位磅（pt）。",
    parameters: {
      type: "object",
      required: ["shape", "left", "top", "width", "height"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号（0=当前页）" },
        shape: {
          type: "string",
          enum: ["rectangle", "roundedRect", "oval", "diamond", "triangle", "pentagon", "hexagon", "star5", "rightArrow", "leftArrow", "upArrow", "downArrow", "chevron", "parallelogram", "trapezoid", "plus"],
          description: "形状类型"
        },
        left: { type: "number" },
        top: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        fillColor: { type: "string", description: "填充色 #RRGGBB，省略=无填充" },
        lineColor: { type: "string", description: "描边色 #RRGGBB，省略=无描边" },
        text: { type: "string", description: "可选：在形状内写入文字" },
        textColor: { type: "string", description: "文字颜色 #RRGGBB" },
        textSize: { type: "number", description: "文字字号（磅）" },
        textBold: { type: "boolean" }
      }
    },
    handler: async ({ slide, shape, left, top, width, height, fillColor, lineColor, text, textColor, textSize, textBold } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const shapeId = SHAPE_TYPES[shape];
      if (shapeId == null) throw new Error(`未知形状：${shape}`);
      const sh = slideObj.Shapes.AddShape(shapeId, left, top, width, height);

      try {
        if (fillColor) {
          const fill = sh.Fill;
          try { fill.Solid(); } catch (e) {}
          try { fill.ForeColor.Type = 1; } catch (e) {}
          fill.ForeColor.RGB = parseColor(fillColor);
        } else {
          try { sh.Fill.Visible = MSO.FALSE; } catch (e) {}
        }
      } catch (e) {}

      try {
        if (lineColor) {
          try { sh.Line.Visible = MSO.TRUE; } catch (e) {}
          try { sh.Line.ForeColor.Type = 1; } catch (e) {}
          try { sh.Line.ForeColor.RGB = parseColor(lineColor); } catch (e) {}
        } else {
          try { sh.Line.Visible = MSO.FALSE; } catch (e) {}
        }
      } catch (e) {}

      if (text) {
        try {
          const tr = sh.TextFrame.TextRange;
          tr.Text = text;
          if (textSize) tr.Font.Size = textSize;
          if (typeof textBold === "boolean") {
            for (const v of [textBold ? -1 : 0, textBold ? 1 : 0, textBold]) {
              try { tr.Font.Bold = v; break; } catch (e) {}
            }
          }
          if (textColor) {
            try { tr.Font.Color.Type = 1; } catch (e) {}
            try { tr.Font.Color.RGB = parseColor(textColor); } catch (e) {}
          }
        } catch (e) {}
      }

      return {
        slide: slideObj.SlideIndex || slide,
        shapeIndex: slideObj.Shapes.Count,
        shape, left, top, width, height
      };
    }
  });

  // ============ 切换效果（过渡动画） ============

  // PpEntryEffect 子集（来自 wpp-jsapi-declare），挑商用合适的几个
  const ENTRY_EFFECTS = {
    none: 0,           // ppEffectNone
    fade: 1793,        // ppEffectFade（推荐，最稳重）
    dissolve: 1537,    // ppEffectDissolve
    cut: 257,          // ppEffectCut
    coverLeft: 1281,
    coverUp: 1282,
    wipeLeft: 2049,    // ppEffectUncoverLeft（轻微移动）
    wipeUp: 2050
  };
  // PpTransitionSpeed: 1=Slow, 2=Medium, 3=Fast
  const TRANSITION_SPEED = { slow: 1, medium: 2, fast: 3 };

  registry.registerTool({
    name: "wpp_set_slide_transition",
    hosts: ["wpp"],
    description: "为幻灯片设置切换/过渡效果。商用建议 effect=fade（淡入淡出最稳）+ speed=medium。slide=0 当前页；省略 slide = 对所有页面应用。一份 PPT 一般统一所有页过渡效果即可。",
    parameters: {
      type: "object",
      properties: {
        slide: { type: "integer", minimum: 0, description: "幻灯片序号，0=当前页，省略=所有页" },
        effect: {
          type: "string",
          enum: ["none", "fade", "dissolve", "cut", "coverLeft", "coverUp", "wipeLeft", "wipeUp"],
          default: "fade"
        },
        speed: { type: "string", enum: ["slow", "medium", "fast"], default: "medium" }
      }
    },
    handler: async ({ slide, effect = "fade", speed = "medium" } = {}) => {
      const pres = await getPresentation();
      const effectId = ENTRY_EFFECTS[effect];
      const speedId = TRANSITION_SPEED[speed] || 2;
      if (effectId == null) throw new Error(`未知效果：${effect}`);

      const targets = [];
      if (slide === undefined || slide === null) {
        const count = pres.Slides?.Count || 0;
        for (let i = 1; i <= count; i += 1) targets.push(pres.Slides.Item(i));
      } else {
        targets.push(getSlideAt(pres, slide || 0));
      }

      let processed = 0;
      for (const slideObj of targets) {
        try {
          const tr = slideObj.SlideShowTransition;
          if (!tr) continue;
          tr.EntryEffect = effectId;
          try { tr.Speed = speedId; } catch (e) {}
          processed += 1;
        } catch (e) { /* 跳过不支持的 */ }
      }

      return { processed, effect, speed, scope: slide === undefined || slide === null ? "all" : (slide || 0) };
    }
  });

  registry.registerTool({
    name: "wpp_export_slide_as_image",
    hosts: ["wpp"],
    description: "把某张幻灯片导出成图片到本地路径。支持 PNG/JPG（看 fileName 后缀，filterName 用 PNG / JPG）。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        slide: { type: "integer", minimum: 0 },
        fileName: { type: "string", description: "本地保存路径，例 C:/tmp/slide-1.png" },
        filterName: { type: "string", default: "PNG", description: "PNG / JPG / BMP" },
        width: { type: "number", description: "导出像素宽度，省略用原始尺寸" },
        height: { type: "number", description: "导出像素高度，省略用原始尺寸" }
      }
    },
    handler: async ({ slide, fileName, filterName = "PNG", width, height } = {}) => {
      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      slideObj.Export(fileName, filterName, width || 0, height || 0);
      return { slide: slideObj.SlideIndex || slide, fileName, filterName };
    }
  });

  // ============ 视觉模板（方案 B：SVG 渲染为 PNG 作为整页背景） ============

  // 把 SVG 字符串渲染成 PNG dataURL
  // 用 Image + Canvas，纯浏览器能力，不需要外部库
  function svgToPngDataUrl(svgString, widthPx, heightPx) {
    return new Promise((resolve, reject) => {
      const svg64 = btoa(unescape(encodeURIComponent(svgString)));
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = widthPx;
          canvas.height = heightPx;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, widthPx, heightPx);
          ctx.drawImage(img, 0, 0, widthPx, heightPx);
          resolve(canvas.toDataURL("image/png"));
        } catch (e) { reject(e); }
      };
      img.onerror = (e) => reject(new Error("SVG 解析失败"));
      img.src = "data:image/svg+xml;base64," + svg64;
    });
  }

  // 上传 dataUrl 到本地代理，拿回本地文件路径供 AddPicture 使用
  async function uploadDataUrl(dataUrl) {
    let resp;
    try {
      resp = await fetch("http://127.0.0.1:3890/upload-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl })
      });
    } catch (e) {
      throw new Error(`代理服务器连不上（127.0.0.1:3890）：${e.message}。先确认 npm run dev:et 进程在跑。`);
    }
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) {}
      if (resp.status === 404) {
        throw new Error(`/upload-image 返回 404 —— 多半是代理服务器是旧进程（没有这个路由）。请重启 npm run dev:et 让新版生效。响应：${detail}`);
      }
      throw new Error(`上传图片失败 ${resp.status}：${detail}`);
    }
    const json = await resp.json();
    if (!json.path) throw new Error(`代理未返回文件路径，响应：${JSON.stringify(json).slice(0, 200)}`);
    return json.path;
  }

  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  // 视觉模板：纯 SVG，吃 palette + params 渲染。每个返回 { svg, textBoxes }
  // textBoxes 是模板预留的可编辑文本框区域（左/上/宽/高/参数引用），由 tool 在插图后再 wpp_add_text_box 叠加
  const VISUAL_TEMPLATES = {
    // 渐变封面：左上→右下渐变 + 大标题居中（标题作为可编辑文本框单独叠加）
    "v-cover-gradient": ({ palette, params, w, h }) => {
      const grad = `<defs>
        <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.secondary)}"/>
        </linearGradient>
        <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="40" />
        </filter>
      </defs>`;
      const decor = `
        <circle cx="${w * 0.85}" cy="${h * 0.15}" r="${h * 0.35}" fill="${escAttr(palette.accent)}" opacity="0.18" filter="url(#soft)"/>
        <circle cx="${w * 0.15}" cy="${h * 0.9}" r="${h * 0.25}" fill="${escAttr(palette.accent)}" opacity="0.12" filter="url(#soft)"/>
        <rect x="${w * 0.08}" y="${h * 0.65}" width="${w * 0.08}" height="3" fill="${escAttr(palette.accent)}"/>
      `;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="url(#g1)"/>${decor}</svg>`;
      return {
        svg,
        textBoxes: [
          { role: "title", text: params.title || "标题", x: w * 0.08, y: h * 0.4, w: w * 0.7, h: h * 0.18, fontSize: 56, bold: true, color: "#FFFFFF" },
          ...(params.subtitle ? [{ role: "subtitle", text: params.subtitle, x: w * 0.08, y: h * 0.58, w: w * 0.7, h: 40, fontSize: 18, color: "#E2E8F0" }] : [])
        ]
      };
    },

    // 现代分章页：暗色背景 + 巨大透明数字 + 章节标题
    "v-section-modern": ({ palette, params, w, h }) => {
      const bigNum = params.chapter || "01";
      const grad = `<defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.secondary)}"/>
        </linearGradient>
      </defs>`;
      const ghost = `
        <text x="${w * 0.45}" y="${h * 0.95}" font-family="Microsoft YaHei, sans-serif" font-size="${h * 1.1}" font-weight="900" fill="${escAttr(palette.accent)}" opacity="0.16">${escAttr(bigNum)}</text>
      `;
      const accent = `<rect x="${w * 0.08}" y="${h * 0.62}" width="${w * 0.06}" height="4" fill="${escAttr(palette.accent)}"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="url(#sg)"/>${ghost}${accent}</svg>`;
      return {
        svg,
        textBoxes: [
          { role: "chapter", text: `第 ${bigNum} 章`, x: w * 0.08, y: h * 0.36, w: w * 0.6, h: 30, fontSize: 16, color: palette.accent, bold: true },
          { role: "title", text: params.title || "章节标题", x: w * 0.08, y: h * 0.45, w: w * 0.84, h: h * 0.2, fontSize: 64, bold: true, color: "#FFFFFF" }
        ]
      };
    },

    // 大数字数据强调页：白底 + 巨大彩色数字
    "v-stat-bigtype": ({ palette, params, w, h }) => {
      const grad = `<defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.bg)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.surface)}"/>
        </linearGradient>
        <linearGradient id="numgr" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.accent)}"/>
        </linearGradient>
      </defs>`;
      const decor = `
        <rect x="${w * 0.5 - 60}" y="${h * 0.78}" width="120" height="3" fill="${escAttr(palette.accent)}"/>
        <circle cx="${w * 0.95}" cy="${h * 0.05}" r="${h * 0.15}" fill="${escAttr(palette.accent)}" opacity="0.08"/>
      `;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="url(#bg)"/>
        <text x="${w / 2}" y="${h * 0.55}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="${h * 0.5}" font-weight="900" fill="url(#numgr)">${escAttr(params.number || "100%")}</text>
        ${decor}</svg>`;
      return {
        svg,
        // 数字直接画在 SVG 上视觉最佳；标签/描述用真文本框叠加便于编辑
        textBoxes: [
          { role: "label", text: params.label || "指标名称", x: 0, y: h * 0.83, w, h: 30, fontSize: 24, bold: true, color: palette.titleColor, alignH: "center" },
          ...(params.description ? [{ role: "description", text: params.description, x: w * 0.15, y: h * 0.9, w: w * 0.7, h: 30, fontSize: 14, color: palette.bodyColor, alignH: "center" }] : [])
        ]
      };
    },

    // 现代内容页：左侧带渐变装饰条 + 标题 + 正文区域（背景留浅色卡片）
    "v-content-modern": ({ palette, params, w, h }) => {
      const grad = `<defs>
        <linearGradient id="cb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(palette.primary)}"/>
          <stop offset="100%" stop-color="${escAttr(palette.accent)}"/>
        </linearGradient>
      </defs>`;
      const accent = `
        <rect x="0" y="0" width="14" height="${h}" fill="url(#cb)"/>
        <rect x="${w * 0.06}" y="${h * 0.22}" width="60" height="3" fill="${escAttr(palette.accent)}"/>
        <rect x="${w * 0.94}" y="${h * 0.92}" width="${w * 0.04}" height="4" fill="${escAttr(palette.primary)}"/>
      `;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${grad}
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>${accent}</svg>`;
      return {
        svg,
        textBoxes: [
          { role: "title", text: params.title || "标题", x: w * 0.06, y: h * 0.08, w: w * 0.85, h: h * 0.12, fontSize: 32, bold: true, color: palette.titleColor },
          { role: "body", text: params.body || "", x: w * 0.06, y: h * 0.28, w: w * 0.85, h: h * 0.6, fontSize: 18, color: palette.bodyColor }
        ]
      };
    }
  };

  registry.registerTool({
    name: "wpp_apply_visual_template",
    hosts: ["wpp"],
    description: [
      "【方案 B】用渲染好的 SVG 视觉模板生成幻灯片，效果比 wpp_apply_template（纯形状拼）更高级——支持渐变背景、模糊光斑、巨大数字等",
      "现代效果。流程：模板 SVG 渲染为 PNG → 整页铺为背景 → 真文本框叠加在上面（仍可编辑）。",
      "",
      "可选模板：",
      "  - v-cover-gradient：渐变封面，主色到次色对角渐变 + 模糊光斑装饰。params: title, subtitle?",
      "  - v-section-modern：现代章节页，背景渐变 + 巨型透明章节数字水印。params: title, chapter?（数字串如 \"01\"，默认 01）",
      "  - v-stat-bigtype：超大数字页，背景渐变 + 巨型渐变填色数字。params: number（如 \"98%\"）, label, description?",
      "  - v-content-modern：现代内容页，左侧渐变装饰条 + 标题 + 正文。params: title, body",
      "",
      "默认追加新页（slide 省略时）。返回值含 textBoxesAdded（叠加了几个文本框）和 picturePath（背景图本地路径）。",
      "和 wpp_apply_template（方案 A）的区别：",
      "  - 方案 A：纯 PPT 形状拼，文字全可编辑，视觉中等",
      "  - 方案 B：背景是渲染图（不可编辑），文字仍是真文本框（可编辑），视觉更精致",
      "  - **建议**：封面/章节/大数字这种视觉权重高的页用方案 B；普通内容页用方案 A 即可"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["templateName"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "目标页；省略=末尾追加新页" },
        templateName: {
          type: "string",
          enum: ["v-cover-gradient", "v-section-modern", "v-stat-bigtype", "v-content-modern"]
        },
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "string" },
        chapter: { type: "string", description: "章节编号字符串（v-section-modern 用），如 \"01\"" },
        number: { type: "string", description: "大数字（v-stat-bigtype 用），如 \"98%\"" },
        label: { type: "string", description: "数字下方标签（v-stat-bigtype 用）" },
        description: { type: "string" }
      }
    },
    handler: async (params = {}) => {
      const { slide, templateName } = params;
      const tpl = VISUAL_TEMPLATES[templateName];
      if (!tpl) throw new Error(`未知视觉模板：${templateName}`);

      const pres = await getPresentation();
      const ps = pres.PageSetup;
      let w = 720, h = 540;
      try { if (ps?.SlideWidth) w = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) h = ps.SlideHeight; } catch (e) {}

      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = settings.stylePreset || {};
      const palette = {
        bg: sp.backgroundColor || "#FFFFFF",
        primary: sp.primaryColor || "#1F3A5F",
        secondary: sp.secondaryColor || "#3D5A80",
        accent: sp.accentColor || "#EE6C4D",
        surface: sp.surfaceColor || "#F5F7FA",
        titleColor: sp.titleColor || "#1F2329",
        bodyColor: sp.bodyColor || "#33363C",
        titleFont: sp.titleFont || "Microsoft YaHei",
        bodyFont: sp.bodyFont || "Microsoft YaHei"
      };

      // 渲染分辨率比 PPT 坐标高一点保证清晰（2x）
      const { svg, textBoxes } = tpl({ palette, params, w, h });
      const dataUrl = await svgToPngDataUrl(svg, Math.round(w * 2), Math.round(h * 2));
      const localPath = await uploadDataUrl(dataUrl);

      let slideObj;
      if (slide === undefined || slide === null) {
        const idx = (pres.Slides?.Count || 0) + 1;
        slideObj = pres.Slides.Add(idx, 12 /* blank */);
      } else {
        slideObj = getSlideAt(pres, slide || 0);
      }

      // 整页铺为背景图
      const pic = slideObj.Shapes.AddPicture(localPath, MSO.FALSE, MSO.TRUE, 0, 0, w, h);
      try { pic.ZOrder?.(1 /* msoSendToBack */); } catch (e) {}

      // 叠加文本框（保持可编辑）
      let added = 0;
      for (const tb of textBoxes || []) {
        try {
          addText(slideObj, tb.x, tb.y, tb.w, tb.h, tb.text, {
            fontName: palette.titleFont,
            fontSize: tb.fontSize,
            bold: tb.bold,
            color: tb.color,
            alignH: tb.alignH
          });
          added += 1;
        } catch (e) { /* skip */ }
      }

      return {
        slide: slideObj.SlideIndex,
        template: templateName,
        slideWidth: w,
        slideHeight: h,
        picturePath: localPath,
        textBoxesAdded: added
      };
    }
  });

  // ============ 数据可视化图表（SVG → PNG → AddPicture） ============
  // 这些图表渲染为 SVG，再转 PNG 插入幻灯片。坐标按 chartW × chartH（默认 720×420 SVG 内部坐标）。
  // 配色用 stylePreset 色板，darkMode=true 时自动切换深色主题。

  // 把任意数字数组归一到 [0,1]
  function normSeries(values, opts = {}) {
    const arr = values.map((v) => Number.isFinite(+v) ? +v : 0);
    const max = opts.max != null ? opts.max : Math.max(...arr, 0);
    const min = opts.min != null ? opts.min : Math.min(...arr, 0);
    const range = max - min || 1;
    return { arr, min, max, range, norm: arr.map((v) => (v - min) / range) };
  }

  // 围绕色板生成图表的多色 series 颜色（最多 6 色）
  function chartPalette(palette, count) {
    const base = [palette.primary, palette.accent, palette.secondary, "#10B981", "#F59E0B", "#8B5CF6"];
    return base.slice(0, Math.max(1, count));
  }

  // 通用：读取 stylePreset 并组装 palette 对象（含 chart 专用字段）
  function getChartPalette() {
    const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
    const sp = settings.stylePreset || {};
    const schemes = global.WpsAiProviderRegistry?.COLOR_SCHEMES || {};
    const matched = sp.scheme && schemes[sp.scheme];
    const darkMode = matched ? !!matched.darkMode : false;
    return {
      bg: sp.backgroundColor || (darkMode ? "#0D1117" : "#FFFFFF"),
      surface: sp.surfaceColor || (darkMode ? "#161B22" : "#F4F4F5"),
      primary: sp.primaryColor || "#2563EB",
      secondary: sp.secondaryColor || "#1E3A8A",
      accent: sp.accentColor || "#F97316",
      titleColor: sp.titleColor || (darkMode ? "#F5F5F5" : "#0F172A"),
      bodyColor: sp.bodyColor || (darkMode ? "#94A3B8" : "#475569"),
      gridColor: darkMode ? "#2D3748" : "#E2E8F0",
      axisColor: darkMode ? "#64748B" : "#94A3B8",
      darkMode,
      titleFont: sp.titleFont || "Microsoft YaHei",
      bodyFont: sp.bodyFont || "Microsoft YaHei"
    };
  }

  const CHART_RENDERERS = {
    // 柱状图：横向多列；data: { categories: [..], series: [{ name, values: [..] }] }
    bar: ({ palette, data, w, h }) => {
      const cats = data.categories || [];
      const series = data.series || [];
      if (!cats.length || !series.length) throw new Error("bar 图表需要 categories 和 series");
      const flat = series.flatMap((s) => s.values || []);
      const { max } = normSeries(flat, { min: 0 });
      const niceMax = Math.ceil(max * 1.1) || 1;
      const colors = chartPalette(palette, series.length);
      const padL = 60, padR = 30, padT = 20, padB = 70;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      const groupW = plotW / cats.length;
      const barW = (groupW * 0.7) / series.length;

      let bars = "";
      cats.forEach((cat, ci) => {
        const groupX = padL + ci * groupW + groupW * 0.15;
        series.forEach((s, si) => {
          const v = +(s.values?.[ci] ?? 0);
          const bh = (v / niceMax) * plotH;
          const x = groupX + si * barW;
          const y = padT + plotH - bh;
          bars += `<rect x="${x}" y="${y}" width="${barW - 2}" height="${bh}" fill="${escAttr(colors[si])}" rx="3"/>`;
          if (series.length === 1) {
            bars += `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="14" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.titleColor)}" font-weight="600">${escAttr(v)}</text>`;
          }
        });
      });

      // 网格线 (4 段)
      let grid = "";
      for (let i = 0; i <= 4; i += 1) {
        const y = padT + (plotH / 4) * i;
        grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
        const lblV = Math.round((niceMax / 4) * (4 - i));
        grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">${escAttr(lblV)}</text>`;
      }

      // 类目标签
      let catLbls = "";
      cats.forEach((cat, ci) => {
        const cx = padL + ci * groupW + groupW / 2;
        catLbls += `<text x="${cx}" y="${h - padB + 18}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(cat)}</text>`;
      });

      // 图例（多 series 时）
      let legend = "";
      if (series.length > 1) {
        const lgY = h - 18;
        let lx = padL;
        series.forEach((s, si) => {
          legend += `<rect x="${lx}" y="${lgY - 9}" width="12" height="12" fill="${escAttr(colors[si])}" rx="2"/>`;
          legend += `<text x="${lx + 18}" y="${lgY + 1}" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(s.name || `系列${si + 1}`)}</text>`;
          lx += 18 + (String(s.name || "").length * 8 + 30);
        });
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${grid}${bars}${catLbls}${legend}
      </svg>`;
    },

    // 环形图：data: { items: [{ label, value }] }
    donut: ({ palette, data, w, h }) => {
      const items = data.items || [];
      if (!items.length) throw new Error("donut 图表需要 items");
      const total = items.reduce((s, i) => s + (+i.value || 0), 0) || 1;
      const colors = chartPalette(palette, items.length);
      const cx = w * 0.35, cy = h / 2;
      const rOuter = Math.min(w * 0.28, h * 0.4);
      const rInner = rOuter * 0.6;

      let arcs = "";
      let angle = -Math.PI / 2;
      items.forEach((it, i) => {
        const v = +it.value || 0;
        const sweep = (v / total) * Math.PI * 2;
        const a2 = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const x1 = cx + Math.cos(angle) * rOuter, y1 = cy + Math.sin(angle) * rOuter;
        const x2 = cx + Math.cos(a2) * rOuter, y2 = cy + Math.sin(a2) * rOuter;
        const x3 = cx + Math.cos(a2) * rInner, y3 = cy + Math.sin(a2) * rInner;
        const x4 = cx + Math.cos(angle) * rInner, y4 = cy + Math.sin(angle) * rInner;
        arcs += `<path d="M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4} Z" fill="${escAttr(colors[i])}"/>`;
        angle = a2;
      });

      // 中心总数
      const centerLabel = data.centerLabel || `${total}`;
      const centerSub = data.centerSub || "总计";
      const centerTxt = `
        <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="${rInner * 0.55}" font-weight="700" font-family="${escAttr(palette.titleFont)}" fill="${escAttr(palette.titleColor)}">${escAttr(centerLabel)}</text>
        <text x="${cx}" y="${cy + rInner * 0.45}" text-anchor="middle" font-size="14" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(centerSub)}</text>
      `;

      // 右侧图例
      let legend = "";
      const lgX = w * 0.7;
      const lineH = 28;
      const lgStart = (h - items.length * lineH) / 2;
      items.forEach((it, i) => {
        const ly = lgStart + i * lineH;
        const pct = ((+it.value || 0) / total * 100).toFixed(1);
        legend += `<rect x="${lgX}" y="${ly}" width="14" height="14" fill="${escAttr(colors[i])}" rx="2"/>`;
        legend += `<text x="${lgX + 22}" y="${ly + 11}" font-size="13" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(it.label)} <tspan font-weight="700" fill="${escAttr(palette.titleColor)}">${pct}%</tspan></text>`;
      });

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${arcs}${centerTxt}${legend}
      </svg>`;
    },

    // 折线图：data: { categories: [..], series: [{ name, values: [..] }] }
    line: ({ palette, data, w, h }) => {
      const cats = data.categories || [];
      const series = data.series || [];
      if (!cats.length || !series.length) throw new Error("line 图表需要 categories 和 series");
      const flat = series.flatMap((s) => s.values || []);
      const { max, min } = normSeries(flat);
      const niceMin = Math.min(0, Math.floor(min * 1.05));
      const niceMax = Math.ceil(max * 1.1) || 1;
      const range = niceMax - niceMin || 1;
      const colors = chartPalette(palette, series.length);
      const padL = 60, padR = 30, padT = 30, padB = 60;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      const stepX = cats.length > 1 ? plotW / (cats.length - 1) : 0;

      // 网格
      let grid = "";
      for (let i = 0; i <= 4; i += 1) {
        const y = padT + (plotH / 4) * i;
        grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
        const lblV = (niceMax - (range / 4) * i).toFixed(0);
        grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">${escAttr(lblV)}</text>`;
      }

      // 折线 + 节点
      let lines = "";
      series.forEach((s, si) => {
        const pts = (s.values || []).map((v, i) => {
          const x = padL + i * stepX;
          const y = padT + plotH - ((+v - niceMin) / range) * plotH;
          return [x, y];
        });
        const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ");
        lines += `<path d="${d}" fill="none" stroke="${escAttr(colors[si])}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
        pts.forEach((p) => {
          lines += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="${escAttr(palette.bg)}" stroke="${escAttr(colors[si])}" stroke-width="2"/>`;
        });
      });

      // 类目标签
      let catLbls = "";
      cats.forEach((cat, ci) => {
        const cx = padL + ci * stepX;
        catLbls += `<text x="${cx}" y="${h - padB + 20}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(cat)}</text>`;
      });

      // 图例
      let legend = "";
      if (series.length >= 1) {
        let lx = padL;
        const ly = 18;
        series.forEach((s, si) => {
          legend += `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 16}" y2="${ly - 4}" stroke="${escAttr(colors[si])}" stroke-width="3"/>`;
          legend += `<text x="${lx + 22}" y="${ly}" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(s.name || `系列${si + 1}`)}</text>`;
          lx += 22 + (String(s.name || "").length * 8 + 30);
        });
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${grid}${lines}${catLbls}${legend}
      </svg>`;
    },

    // 雷达图：data: { axes: [..], series: [{ name, values: [..] }], max? }
    radar: ({ palette, data, w, h }) => {
      const axes = data.axes || [];
      const series = data.series || [];
      if (axes.length < 3 || !series.length) throw new Error("radar 图表至少需要 3 条 axes 和 series");
      const flat = series.flatMap((s) => s.values || []);
      const max = data.max != null ? +data.max : Math.max(...flat) * 1.05 || 1;
      const cx = w / 2, cy = h / 2;
      const r = Math.min(w, h) * 0.36;
      const colors = chartPalette(palette, series.length);
      const angleAt = (i) => -Math.PI / 2 + (Math.PI * 2 * i) / axes.length;

      // 同心多边形（5 层）+ 轴线
      let bg = "";
      for (let lvl = 1; lvl <= 5; lvl += 1) {
        const lr = (r * lvl) / 5;
        const pts = axes.map((_, i) => {
          const a = angleAt(i);
          return `${cx + Math.cos(a) * lr},${cy + Math.sin(a) * lr}`;
        }).join(" ");
        bg += `<polygon points="${pts}" fill="none" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
      }
      axes.forEach((_, i) => {
        const a = angleAt(i);
        bg += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * r}" y2="${cy + Math.sin(a) * r}" stroke="${escAttr(palette.gridColor)}" stroke-width="1"/>`;
      });

      // 每个 series 一个填色多边形
      let polys = "";
      series.forEach((s, si) => {
        const pts = axes.map((_, i) => {
          const a = angleAt(i);
          const v = Math.max(0, Math.min(max, +(s.values?.[i] || 0)));
          const lr = (v / max) * r;
          return `${cx + Math.cos(a) * lr},${cy + Math.sin(a) * lr}`;
        }).join(" ");
        polys += `<polygon points="${pts}" fill="${escAttr(colors[si])}" fill-opacity="0.25" stroke="${escAttr(colors[si])}" stroke-width="2"/>`;
        // 节点
        axes.forEach((_, i) => {
          const a = angleAt(i);
          const v = Math.max(0, Math.min(max, +(s.values?.[i] || 0)));
          const lr = (v / max) * r;
          polys += `<circle cx="${cx + Math.cos(a) * lr}" cy="${cy + Math.sin(a) * lr}" r="3" fill="${escAttr(colors[si])}"/>`;
        });
      });

      // 轴标签
      let labels = "";
      axes.forEach((ax, i) => {
        const a = angleAt(i);
        const lx = cx + Math.cos(a) * (r + 22);
        const ly = cy + Math.sin(a) * (r + 22);
        const anchor = Math.abs(Math.cos(a)) < 0.3 ? "middle" : (Math.cos(a) > 0 ? "start" : "end");
        labels += `<text x="${lx}" y="${ly + 4}" text-anchor="${anchor}" font-size="13" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.titleColor)}" font-weight="600">${escAttr(ax)}</text>`;
      });

      // 图例
      let legend = "";
      if (series.length > 1) {
        let lx = 20, ly = h - 18;
        series.forEach((s, si) => {
          legend += `<rect x="${lx}" y="${ly - 9}" width="12" height="12" fill="${escAttr(colors[si])}" rx="2"/>`;
          legend += `<text x="${lx + 18}" y="${ly + 1}" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(s.name || `系列${si + 1}`)}</text>`;
          lx += 18 + (String(s.name || "").length * 8 + 30);
        });
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${bg}${polys}${labels}${legend}
      </svg>`;
    },

    // 仪表盘 / 完成率：data: { value, max?, label?, suffix? }
    gauge: ({ palette, data, w, h }) => {
      const max = data.max != null ? +data.max : 100;
      const value = Math.max(0, Math.min(max, +data.value || 0));
      const pct = value / max;
      const cx = w / 2, cy = h * 0.62;
      const r = Math.min(w * 0.36, h * 0.5);
      const startA = Math.PI; // 180°
      const endA = 0;          // 360°
      const valueA = startA + (endA - startA) * pct;

      const arc = (a1, a2, color, width) => {
        const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
        const x2 = cx + Math.cos(a2) * r, y2 = cy + Math.sin(a2) * r;
        const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
        const sweep = a2 > a1 ? 1 : 0;
        return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}" fill="none" stroke="${escAttr(color)}" stroke-width="${width}" stroke-linecap="round"/>`;
      };

      // 背景弧（灰）+ 进度弧（accent）
      const bgArc = arc(startA, endA, palette.gridColor, 22);
      const fgArc = pct > 0.001 ? arc(startA, valueA, palette.accent, 22) : "";

      // 中心数字
      const valTxt = `${value}${data.suffix || ""}`;
      const center = `
        <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="${r * 0.55}" font-weight="800" font-family="${escAttr(palette.titleFont)}" fill="${escAttr(palette.primary)}">${escAttr(valTxt)}</text>
        ${data.label ? `<text x="${cx}" y="${cy + r * 0.5}" text-anchor="middle" font-size="16" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(data.label)}</text>` : ""}
      `;

      // 起止刻度
      const ticks = `
        <text x="${cx - r}" y="${cy + 22}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">0</text>
        <text x="${cx + r}" y="${cy + 22}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.axisColor)}">${escAttr(max)}${escAttr(data.suffix || "")}</text>
      `;

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${bgArc}${fgArc}${center}${ticks}
      </svg>`;
    },

    // 热力图：data: { rows: [..], cols: [..], values: [[v,v,...], ...] (rows * cols), max?, min? }
    heatmap: ({ palette, data, w, h }) => {
      const rows = data.rows || [];
      const cols = data.cols || [];
      const values = data.values || [];
      if (!rows.length || !cols.length || !values.length) throw new Error("heatmap 需要 rows、cols、values");
      const flat = values.flat();
      const max = data.max != null ? +data.max : Math.max(...flat);
      const min = data.min != null ? +data.min : Math.min(...flat);
      const range = max - min || 1;
      const padL = 80, padR = 30, padT = 30, padB = 50;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      const cellW = plotW / cols.length, cellH = plotH / rows.length;

      // 用 primary 透明度叠加表示数值（深色模式同样）
      const baseColor = palette.primary;
      let cells = "";
      rows.forEach((r, ri) => {
        cols.forEach((c, ci) => {
          const v = +(values[ri]?.[ci] ?? 0);
          const t = Math.max(0, Math.min(1, (v - min) / range));
          const opacity = 0.15 + t * 0.85;
          cells += `<rect x="${padL + ci * cellW}" y="${padT + ri * cellH}" width="${cellW - 1}" height="${cellH - 1}" fill="${escAttr(baseColor)}" fill-opacity="${opacity.toFixed(3)}"/>`;
          // 单元格数值
          if (cellW > 36 && cellH > 22) {
            const txtColor = t > 0.5 ? "#FFFFFF" : palette.titleColor;
            cells += `<text x="${padL + ci * cellW + cellW / 2}" y="${padT + ri * cellH + cellH / 2 + 4}" text-anchor="middle" font-size="11" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(txtColor)}">${escAttr(v)}</text>`;
          }
        });
      });

      // 行标签
      let rowLbls = "";
      rows.forEach((r, ri) => {
        const y = padT + ri * cellH + cellH / 2 + 4;
        rowLbls += `<text x="${padL - 8}" y="${y}" text-anchor="end" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(r)}</text>`;
      });
      // 列标签
      let colLbls = "";
      cols.forEach((c, ci) => {
        const x = padL + ci * cellW + cellW / 2;
        colLbls += `<text x="${x}" y="${padT - 8}" text-anchor="middle" font-size="12" font-family="${escAttr(palette.bodyFont)}" fill="${escAttr(palette.bodyColor)}">${escAttr(c)}</text>`;
      });

      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
        <rect width="${w}" height="${h}" fill="${escAttr(palette.bg)}"/>
        ${cells}${rowLbls}${colLbls}
      </svg>`;
    }
  };

  registry.registerTool({
    name: "wpp_render_chart",
    hosts: ["wpp"],
    description: [
      "在幻灯片上插入数据可视化图表（SVG 渲染→PNG→AddPicture）。配色自动跟随当前 stylePreset 色板（含 darkMode）。",
      "适合统一风格时给数据型幻灯片加图表：几组数字对比、占比构成、趋势变化、多维度评分等。",
      "",
      "支持的 chartType：",
      "  - bar：柱状图。data = { categories: [\"Q1\",\"Q2\",..], series: [{ name, values:[..] }] }",
      "  - donut：环形图。data = { items: [{label, value}, ..], centerLabel?, centerSub? }",
      "  - line：折线图。data = { categories: [..], series: [{ name, values:[..] }] }",
      "  - radar：雷达图（多维度评分）。data = { axes: [\"产品\",\"交付\",\"售后\"], series: [{ name, values:[..] }], max? }",
      "  - gauge：仪表盘 / 完成率（半圆进度）。data = { value, max?, label?, suffix? }（如 value=87, max=100, suffix='%'）",
      "  - heatmap：热力图（行×列 矩阵）。data = { rows: [..], cols: [..], values: [[..],..] }",
      "",
      "默认插在幻灯片右侧（slide 必填）。可指定 left/top/width/height（PPT 坐标）；省略则默认宽 = slideW * 0.42、高 = slideH * 0.55、靠右居中。",
      "",
      "**何时使用**：在「统一风格」流程里，当某页 textPreview 含百分比、数字趋势、对比数据、占比构成时——比手工堆文字效果好。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["slide", "chartType", "data"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "目标页（1 起；0=当前页）" },
        chartType: { type: "string", enum: ["bar", "donut", "line", "radar", "gauge", "heatmap"] },
        data: { type: "object", description: "图表数据，结构按 chartType 区分（见 description）" },
        left: { type: "number", description: "左上角 X（PPT 坐标）。省略=自动放右半边" },
        top: { type: "number", description: "左上角 Y。省略=自动垂直居中" },
        width: { type: "number", description: "图表宽度。省略=slideW*0.42" },
        height: { type: "number", description: "图表高度。省略=slideH*0.55" },
        title: { type: "string", description: "可选：图表上方的小标题（独立文本框）" }
      }
    },
    handler: async ({ slide, chartType, data, left, top, width, height, title } = {}) => {
      const renderer = CHART_RENDERERS[chartType];
      if (!renderer) throw new Error(`未知 chartType：${chartType}`);
      if (!data || typeof data !== "object") throw new Error("data 必须是对象");

      const pres = await getPresentation();
      const slideObj = getSlideAt(pres, slide || 0);
      const ps = pres.PageSetup;
      let slideW = 720, slideH = 540;
      try { if (ps?.SlideWidth) slideW = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) slideH = ps.SlideHeight; } catch (e) {}

      const palette = getChartPalette();
      const w = width || Math.round(slideW * 0.42);
      const h = height || Math.round(slideH * 0.55);
      const x = (left != null) ? left : Math.round(slideW - w - slideW * 0.04);
      const y = (top != null) ? top : Math.round((slideH - h) / 2);

      // SVG 内部坐标用 720 × 420 比例换算（保证文字大小一致）；最后按 2x 渲染
      const svgW = 720, svgH = Math.round(720 * (h / w));
      const svg = renderer({ palette, data, w: svgW, h: svgH });
      const dataUrl = await svgToPngDataUrl(svg, svgW * 2, svgH * 2);
      const localPath = await uploadDataUrl(dataUrl);

      // 图表小标题（可选）
      let titleAdded = false;
      if (title) {
        try {
          addText(slideObj, x, Math.max(0, y - 28), w, 24, title, {
            fontName: palette.titleFont, fontSize: 14, bold: true, color: palette.titleColor
          });
          titleAdded = true;
        } catch (e) {}
      }

      const pic = slideObj.Shapes.AddPicture(localPath, MSO.FALSE, MSO.TRUE, x, y, w, h);
      try { pic.Name = `lingxi-chart-${chartType}`; } catch (e) {}

      return {
        slide: slideObj.SlideIndex,
        chartType,
        left: x, top: y, width: w, height: h,
        picturePath: localPath,
        titleAdded,
        darkMode: palette.darkMode
      };
    }
  });

  // ============ 高级版式模板（方案 A） ============
  // 每个模板封装一个高频商用版式，AI 只填参数，避免手工拼坐标

  const TEMPLATES = {
    "cover-split": (slide, w, h, p, params) => {
      // 左半边主色块，右半边白底大标题
      setBg(slide, p.bg);
      addRect(slide, 0, 0, Math.round(w * 0.42), h, p.primary);
      // 装饰：左侧色块上加一条细 accent 横线
      addRect(slide, 30, Math.round(h * 0.45), 60, 4, p.accent);
      // 标题
      addText(slide, Math.round(w * 0.48), Math.round(h * 0.32), Math.round(w * 0.46), Math.round(h * 0.18),
        params.title || "标题", {
          fontName: p.titleFont, fontSize: 44, bold: true, color: p.titleColor
        });
      // 副标题
      if (params.subtitle) {
        addText(slide, Math.round(w * 0.48), Math.round(h * 0.55), Math.round(w * 0.46), 40,
          params.subtitle, {
            fontName: p.bodyFont, fontSize: 18, color: p.bodyColor
          });
      }
    },

    "cover-band": (slide, w, h, p, params) => {
      // 顶部主色横条 + 居中大标题 + 底部 accent 细条
      setBg(slide, p.bg);
      addRect(slide, 0, 0, w, Math.round(h * 0.18), p.primary);
      addRect(slide, 0, Math.round(h * 0.18), w, 4, p.accent);
      // 标题居中
      addText(slide, 60, Math.round(h * 0.42), w - 120, 80,
        params.title || "标题", {
          fontName: p.titleFont, fontSize: 48, bold: true, color: p.titleColor, alignH: "center"
        });
      // 副标题/日期
      if (params.subtitle || params.date) {
        addText(slide, 60, Math.round(h * 0.58), w - 120, 32,
          params.subtitle || params.date, {
            fontName: p.bodyFont, fontSize: 16, color: p.bodyColor, alignH: "center"
          });
      }
      // 底部装饰短线
      addRect(slide, Math.round(w / 2 - 30), Math.round(h * 0.65), 60, 3, p.accent);
    },

    "section-fullbleed": (slide, w, h, p, params) => {
      // 满屏主色，白色大字号章节标题
      setBg(slide, p.primary);
      // 章节编号小字（如"第一章"）
      if (params.chapter) {
        addText(slide, 60, Math.round(h * 0.32), w - 120, 30,
          params.chapter, {
            fontName: p.bodyFont, fontSize: 16, color: "#FFFFFF", alignH: "center"
          });
      }
      // 大标题
      addText(slide, 60, Math.round(h * 0.40), w - 120, 100,
        params.title || "章节标题", {
          fontName: p.titleFont, fontSize: 56, bold: true, color: "#FFFFFF", alignH: "center"
        });
      // 中间 accent 装饰横线
      addRect(slide, Math.round(w / 2 - 40), Math.round(h * 0.60), 80, 4, p.accent);
    },

    "content-sidebar": (slide, w, h, p, params) => {
      // 内容页：左侧 8pt 主色装饰条 + 标题 + 标题下细 accent 横线 + 正文
      setBg(slide, p.bg);
      addRect(slide, 0, 0, 8, h, p.primary);
      // 标题
      addText(slide, 40, 30, w - 80, 50,
        params.title || "标题", {
          fontName: p.titleFont, fontSize: p.titleSize, bold: true, color: p.titleColor
        });
      // 标题下方细装饰线
      addRect(slide, 40, 88, 60, 3, p.accent);
      // 正文（多行用 \n 分隔，由 add textbox 自然换行）
      if (params.body) {
        addText(slide, 40, 110, w - 80, h - 150,
          params.body, {
            fontName: p.bodyFont, fontSize: p.bodySize, color: p.bodyColor
          });
      }
    },

    "stat-hero": (slide, w, h, p, params) => {
      // 大数字 + 标签 + 描述（数据强调页）
      setBg(slide, p.bg);
      // 上方左侧装饰条
      addRect(slide, 60, Math.round(h * 0.20), 4, 60, p.accent);
      // 大数字
      addText(slide, 60, Math.round(h * 0.25), w - 120, Math.round(h * 0.25),
        params.number || "100%", {
          fontName: p.titleFont, fontSize: 96, bold: true, color: p.accent, alignH: "center"
        });
      // 标签
      if (params.label) {
        addText(slide, 60, Math.round(h * 0.55), w - 120, 50,
          params.label, {
            fontName: p.titleFont, fontSize: 28, bold: true, color: p.titleColor, alignH: "center"
          });
      }
      // 描述
      if (params.description || params.body) {
        addText(slide, 80, Math.round(h * 0.68), w - 160, 50,
          params.description || params.body, {
            fontName: p.bodyFont, fontSize: 16, color: p.bodyColor, alignH: "center"
          });
      }
    },

    "quote-block": (slide, w, h, p, params) => {
      // 引言：大引号 + 引文（斜体）+ 署名
      setBg(slide, p.surface);
      // 大引号（用 textbox 写一个 “ 开引号，巨大字号）
      addText(slide, 50, 50, 120, 120, "“", {
        fontName: p.titleFont, fontSize: 140, bold: true, color: p.primary
      });
      // 引文
      addText(slide, 100, Math.round(h * 0.32), w - 200, Math.round(h * 0.40),
        params.quote || params.body || "引言内容", {
          fontName: p.titleFont, fontSize: 28, italic: true, color: p.titleColor
        });
      // 署名
      if (params.author) {
        addText(slide, 100, Math.round(h * 0.78), w - 200, 30,
          "— " + params.author, {
            fontName: p.bodyFont, fontSize: 16, color: p.bodyColor, alignH: "right"
          });
      }
    },

    "two-column": (slide, w, h, p, params) => {
      // 左右双栏对比卡片
      setBg(slide, p.bg);
      // 顶部标题（可选）
      if (params.title) {
        addText(slide, 40, 20, w - 80, 40,
          params.title, {
            fontName: p.titleFont, fontSize: 24, bold: true, color: p.titleColor, alignH: "center"
          });
      }
      const top = params.title ? 80 : 40;
      const cardW = Math.round(w * 0.42);
      const cardH = h - top - 40;
      // 左卡片
      addRect(slide, 40, top, cardW, cardH, p.surface);
      addRect(slide, 40, top, cardW, 4, p.primary); // 上边框装饰
      addText(slide, 60, top + 20, cardW - 40, 36,
        params.leftTitle || "方案 A", {
          fontName: p.titleFont, fontSize: 22, bold: true, color: p.primary
        });
      addText(slide, 60, top + 70, cardW - 40, cardH - 90,
        params.leftBody || "", {
          fontName: p.bodyFont, fontSize: 16, color: p.bodyColor
        });
      // 右卡片
      const rightX = w - 40 - cardW;
      addRect(slide, rightX, top, cardW, cardH, p.surface);
      addRect(slide, rightX, top, cardW, 4, p.accent);
      addText(slide, rightX + 20, top + 20, cardW - 40, 36,
        params.rightTitle || "方案 B", {
          fontName: p.titleFont, fontSize: 22, bold: true, color: p.accent
        });
      addText(slide, rightX + 20, top + 70, cardW - 40, cardH - 90,
        params.rightBody || "", {
          fontName: p.bodyFont, fontSize: 16, color: p.bodyColor
        });
    },

    "closing-thanks": (slide, w, h, p, params) => {
      // 结尾页：满屏主色 + "谢谢观看" + Q&A
      setBg(slide, p.primary);
      addText(slide, 60, Math.round(h * 0.38), w - 120, 100,
        params.title || "谢谢观看", {
          fontName: p.titleFont, fontSize: 64, bold: true, color: "#FFFFFF", alignH: "center"
        });
      // 装饰短线
      addRect(slide, Math.round(w / 2 - 30), Math.round(h * 0.55), 60, 3, p.accent);
      // 副标题
      addText(slide, 60, Math.round(h * 0.60), w - 120, 50,
        params.subtitle || "Q & A", {
          fontName: p.bodyFont, fontSize: 28, color: p.accent, alignH: "center"
        });
    }
  };

  registry.registerTool({
    name: "wpp_apply_template",
    hosts: ["wpp"],
    description: [
      "用预设的高级感版式模板生成或改造一张幻灯片。AI 只填参数，模板内部自动按色板（来自风格预设）摆色块/装饰条/标题/正文，比手工拼形状更整齐统一。",
      "",
      "模板列表（templateName 取值）：",
      "  - cover-split：封面，左半主色块 + 右半大标题。params: title, subtitle?",
      "  - cover-band：封面，顶部主色横条 + 居中大标题 + accent 装饰短线。params: title, subtitle? 或 date?",
      "  - section-fullbleed：章节分隔页，满屏主色 + 白字大标题 + 中间 accent 短线。params: title, chapter?（如「第一章」）",
      "  - content-sidebar：内容页，左侧主色装饰条 + 标题（带 accent 下划线）+ 正文多行。params: title, body（多行用 \\n 分隔）",
      "  - stat-hero：数据强调页，巨大数字 + 标签 + 描述。params: number（如 \"98%\"）, label, description?",
      "  - quote-block：引言页，大引号装饰 + 斜体引文 + 署名。params: quote, author?",
      "  - two-column：对比页，左右双卡片。params: title?, leftTitle, leftBody, rightTitle, rightBody",
      "  - closing-thanks：结尾页，满屏主色 + 「谢谢观看」+ Q&A。params: title?（默认「谢谢观看」）, subtitle?（默认「Q & A」）",
      "",
      "默认行为：省略 slide 时**追加一张新空白幻灯片**再应用模板（推荐用法）。",
      "如果 slide 传了序号，会在该幻灯片上**叠加**模板的形状（不会清掉已有内容）。",
      "执行前会读取 stylePreset 的色板和字体，所以不同色板自动出不同质感。"
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["templateName"],
      properties: {
        slide: { type: "integer", minimum: 0, description: "目标幻灯片序号；省略=追加新幻灯片到末尾" },
        templateName: {
          type: "string",
          enum: ["cover-split", "cover-band", "section-fullbleed", "content-sidebar", "stat-hero", "quote-block", "two-column", "closing-thanks"]
        },
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "string", description: "正文，多行用 \\n 分隔（content-sidebar 等用）" },
        chapter: { type: "string", description: "章节编号文字，如「第一章」（仅 section-fullbleed）" },
        number: { type: "string", description: "大数字（仅 stat-hero），如 \"98%\" 或 \"2,580\"" },
        label: { type: "string", description: "数字下方标签（仅 stat-hero）" },
        description: { type: "string", description: "辅助说明（仅 stat-hero）" },
        quote: { type: "string", description: "引言内容（仅 quote-block）" },
        author: { type: "string", description: "引言作者（仅 quote-block）" },
        leftTitle: { type: "string" },
        leftBody: { type: "string" },
        rightTitle: { type: "string" },
        rightBody: { type: "string" },
        date: { type: "string", description: "日期/作者（仅 cover-band 等）" }
      }
    },
    handler: async (params = {}) => {
      const { slide, templateName } = params;
      if (!templateName) throw new Error("templateName 必填");
      const tpl = TEMPLATES[templateName];
      if (!tpl) throw new Error(`未知模板：${templateName}`);

      const pres = await getPresentation();
      const ps = pres.PageSetup;
      let w = 720, h = 540;
      try { if (ps?.SlideWidth) w = ps.SlideWidth; } catch (e) {}
      try { if (ps?.SlideHeight) h = ps.SlideHeight; } catch (e) {}

      const settings = global.WpsAiProviderRegistry?.loadSettings?.() || {};
      const sp = settings.stylePreset || {};
      const palette = {
        bg: sp.backgroundColor || "#FFFFFF",
        primary: sp.primaryColor || "#1F3A5F",
        secondary: sp.secondaryColor || "#3D5A80",
        accent: sp.accentColor || "#EE6C4D",
        surface: sp.surfaceColor || "#F5F7FA",
        titleColor: sp.titleColor || "#1F2329",
        bodyColor: sp.bodyColor || "#33363C",
        titleFont: sp.titleFont || "Microsoft YaHei",
        bodyFont: sp.bodyFont || "Microsoft YaHei",
        titleSize: sp.titleSize || 32,
        bodySize: sp.bodySize || 18
      };

      let slideObj;
      if (slide === undefined || slide === null) {
        const idx = (pres.Slides?.Count || 0) + 1;
        slideObj = pres.Slides.Add(idx, 12 /* ppLayoutBlank */);
      } else {
        slideObj = getSlideAt(pres, slide || 0);
      }

      tpl(slideObj, w, h, palette, params);

      return {
        slide: slideObj.SlideIndex || (slide || pres.Slides.Count),
        template: templateName,
        slideWidth: w,
        slideHeight: h,
        usedPalette: { primary: palette.primary, accent: palette.accent, bg: palette.bg }
      };
    }
  });
})(window);
