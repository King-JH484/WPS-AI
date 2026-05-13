(function attachWriterTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const doc = () => global.WpsAiDocument;
  const writer = () => global.WpsAiHostWriter;

  registry.registerTool({
    name: "wps_read_selection",
    hosts: ["wps"],
    description: "读取 WPS 文字 当前选区文本。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const text = await writer().readSelectionText();
      return { text };
    }
  });

  registry.registerTool({
    name: "wps_read_document",
    hosts: ["wps"],
    description: "读取 WPS 文字 当前整篇文档的纯文本。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const text = await writer().readDocumentText();
      return { text, length: text.length };
    }
  });

  registry.registerTool({
    name: "wps_insert_text",
    hosts: ["wps"],
    description: "在当前光标位置插入文本（不替换选中内容）。默认按 markdown 渲染：# 转标题样式、**粗体** 转 Bold、- 转项目符号；想保持原样请显式传 format=\"plain\"。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "要插入的内容，支持 markdown" },
        format: { type: "string", enum: ["markdown", "plain"], description: "渲染方式，默认按内容自动判断（含 markdown 语法时按 markdown 渲染）" }
      }
    },
    handler: async ({ text, format } = {}) => {
      await writer().insertText(text, { format });
      return { inserted: text.length, format: format || "auto" };
    }
  });

  registry.registerTool({
    name: "wps_replace_selection",
    hosts: ["wps"],
    description: "用指定文本替换当前选区。默认按 markdown 渲染（# 转标题、**xx** 转 Bold、- 转项目符号等）；要写纯文本请传 format=\"plain\"。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "替换内容，支持 markdown" },
        format: { type: "string", enum: ["markdown", "plain"], description: "渲染方式，默认自动判断" }
      }
    },
    handler: async ({ text, format } = {}) => {
      await writer().replaceSelectionText(text, { format });
      return { replaced: text.length, format: format || "auto" };
    }
  });

  registry.registerTool({
    name: "wps_find_replace",
    hosts: ["wps"],
    description: "在当前 WPS 文字 文档全局执行查找/替换。",
    parameters: {
      type: "object",
      required: ["find", "replace"],
      properties: {
        find: { type: "string", description: "要查找的文本" },
        replace: { type: "string", description: "替换为" },
        matchCase: { type: "boolean", default: false }
      }
    },
    handler: async ({ find, replace, matchCase = false } = {}) => {
      const app = await doc().getApplication();
      const document = app?.ActiveDocument;
      if (!document) throw new Error("未检测到活动文档。");
      const range = document.Content;
      const finder = range.Find;
      finder.Text = find;
      finder.Replacement.Text = replace;
      finder.MatchCase = matchCase;
      // wdReplaceAll = 2
      const ok = finder.Execute(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);
      return { matched: !!ok };
    }
  });

  // ---- 内部工具 ----

  async function getActiveDocument() {
    const app = await doc().getApplication();
    const d = app?.ActiveDocument;
    if (!d) throw new Error("未检测到活动文档。");
    return d;
  }

  async function getApp() {
    const app = await doc().getApplication();
    if (!app) throw new Error("未检测到 WPS 文字 应用对象。");
    return app;
  }

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    // Word Color 也是 BGR 整数（0xBBGGRR）
    return (b << 16) | (g << 8) | r;
  }

  // wd 内置样式 ID（WdBuiltinStyle 枚举）
  const STYLE_IDS = {
    "Normal": -1, "正文": -1,
    "Heading 1": -2, "标题 1": -2, "标题1": -2,
    "Heading 2": -3, "标题 2": -3, "标题2": -3,
    "Heading 3": -4, "标题 3": -4, "标题3": -4,
    "Heading 4": -5, "Heading 5": -6, "Heading 6": -7,
    "Title": -63, "标题": -63,
    "Subtitle": -75, "副标题": -75,
    "Quote": -85, "引用": -85,
    "List Bullet": -19, "项目符号": -19,
    "List Number": -29, "编号列表": -29
  };

  // ---- 文档统计 / 大纲 / 选择 ----

  registry.registerTool({
    name: "wps_get_doc_stats",
    hosts: ["wps"],
    description: "获取当前文档统计信息：总字符数、汉字数、段落数、页数。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const stats = {};
      // WdStatistic 枚举：1=Words, 2=Lines, 3=Pages, 4=Paragraphs, 5=Characters, 6=CharactersWithSpaces
      const safe = (n) => {
        try { return document.ComputeStatistics(n); } catch (e) { return null; }
      };
      stats.words = safe(1);
      stats.lines = safe(2);
      stats.pages = safe(3);
      stats.paragraphs = safe(4);
      stats.characters = safe(5);
      stats.charactersWithSpaces = safe(6);
      try { stats.name = document.Name; } catch (e) { stats.name = null; }
      try { stats.saved = !!document.Saved; } catch (e) {}
      return stats;
    }
  });

  registry.registerTool({
    name: "wps_get_outline",
    hosts: ["wps"],
    description: "提取文档大纲（所有标题样式段落的层级和文本）。返回数组，每项含 level（1-9）、text、index。",
    parameters: {
      type: "object",
      properties: {
        maxLevel: { type: "integer", minimum: 1, maximum: 9, default: 3, description: "提取到第几级标题为止，默认 3" }
      }
    },
    handler: async ({ maxLevel = 3 } = {}) => {
      const document = await getActiveDocument();
      const paragraphs = document.Paragraphs;
      const count = paragraphs?.Count || 0;
      const out = [];
      for (let i = 1; i <= count; i += 1) {
        const p = paragraphs.Item(i);
        let styleName = "";
        try {
          const style = p.Style;
          styleName = typeof style === "string" ? style : (style?.NameLocal || style?.Name || "");
        } catch (e) { styleName = ""; }
        const m = /^(?:Heading|标题)\s*(\d)/i.exec(styleName);
        if (m) {
          const level = parseInt(m[1], 10);
          if (level <= maxLevel) {
            let text = "";
            try { text = String(p.Range.Text || "").replace(/[\r\n]+$/g, ""); } catch (e) {}
            out.push({ level, text, index: i });
          }
        }
      }
      return { count: out.length, headings: out };
    }
  });

  registry.registerTool({
    name: "wps_select_all",
    hosts: ["wps"],
    description: "选中整篇文档（等同 Ctrl+A）。后续 wps_replace_selection 可以替换全文。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      return { ok: true };
    }
  });

  registry.registerTool({
    name: "wps_replace_document",
    hosts: ["wps"],
    description: "替换整个文档内容（先全选再替换）。默认按 markdown 渲染。慎用：此操作覆盖现有所有文字。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "新内容，支持 markdown" },
        format: { type: "string", enum: ["markdown", "plain"] }
      }
    },
    handler: async ({ text, format } = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      sel.WholeStory();
      await writer().replaceSelectionText(text, { format });
      return { replaced: text.length, format: format || "auto" };
    }
  });

  registry.registerTool({
    name: "wps_select_paragraph",
    hosts: ["wps"],
    description: "把选区移到指定序号的段落上（用于 wps_get_outline 返回的 index 跳转）。",
    parameters: {
      type: "object",
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1, description: "段落序号（从 1 开始）" }
      }
    },
    handler: async ({ index } = {}) => {
      const document = await getActiveDocument();
      const p = document.Paragraphs.Item(index);
      if (!p) throw new Error(`段落 ${index} 不存在`);
      p.Range.Select();
      return { selected: index };
    }
  });

  // ---- 段落样式 / 字符格式 ----

  registry.registerTool({
    name: "wps_apply_paragraph_style",
    hosts: ["wps"],
    description: "为当前选区应用段落样式。常用：Heading 1 / Heading 2 / Heading 3 / Normal / Title / Quote / List Bullet / List Number。",
    parameters: {
      type: "object",
      required: ["style"],
      properties: {
        style: { type: "string", description: "样式名（中英文都支持）" }
      }
    },
    handler: async ({ style } = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const styleId = STYLE_IDS[style];
      try {
        if (styleId != null) {
          sel.Style = styleId;
        } else {
          sel.Style = style;
        }
      } catch (e) {
        throw new Error(`应用样式失败：${e.message || e}`);
      }
      return { style };
    }
  });

  registry.registerTool({
    name: "wps_format_selection",
    hosts: ["wps"],
    description: "对当前选区应用字符格式（粗/斜/下划线/字体/字号/颜色）。所有参数可选，只设置传入的项。",
    parameters: {
      type: "object",
      properties: {
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        underline: { type: "boolean", description: "true=单下划线" },
        fontName: { type: "string", description: "字体名，如 \"宋体\"、\"Microsoft YaHei\"" },
        fontSize: { type: "number", description: "字号（磅）" },
        color: { type: "string", description: "字体颜色 #RRGGBB" },
        highlight: { type: "string", description: "荧光笔色 #RRGGBB（部分 WPS 版本支持）" }
      }
    },
    handler: async (opts = {}) => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const font = sel.Font;
      if (!font) throw new Error("未获取到 Font 对象。");
      const applied = {};
      if (typeof opts.bold === "boolean") { font.Bold = opts.bold ? 1 : 0; applied.bold = opts.bold; }
      if (typeof opts.italic === "boolean") { font.Italic = opts.italic ? 1 : 0; applied.italic = opts.italic; }
      if (typeof opts.underline === "boolean") {
        // wdUnderlineNone=0, wdUnderlineSingle=1
        font.Underline = opts.underline ? 1 : 0;
        applied.underline = opts.underline;
      }
      if (opts.fontName) { font.Name = opts.fontName; applied.fontName = opts.fontName; }
      if (typeof opts.fontSize === "number") { font.Size = opts.fontSize; applied.fontSize = opts.fontSize; }
      if (opts.color) { font.Color = parseColor(opts.color); applied.color = opts.color; }
      if (opts.highlight) {
        try { sel.Range.HighlightColorIndex = parseColor(opts.highlight); applied.highlight = opts.highlight; }
        catch (e) { /* 部分版本不支持 */ }
      }
      return { applied };
    }
  });

  // ---- 插入元素 ----

  registry.registerTool({
    name: "wps_insert_page_break",
    hosts: ["wps"],
    description: "在当前光标位置插入分页符。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      // wdPageBreak = 7
      sel.InsertBreak(7);
      return { ok: true };
    }
  });

  registry.registerTool({
    name: "wps_insert_table",
    hosts: ["wps"],
    description: "在当前光标位置插入表格。可选 data 是二维数组用于初始填充。",
    parameters: {
      type: "object",
      required: ["rows", "cols"],
      properties: {
        rows: { type: "integer", minimum: 1 },
        cols: { type: "integer", minimum: 1 },
        data: {
          type: "array",
          description: "二维数组，外层为行内层为列；单元格按 String() 写入。可省略。",
          items: { type: "array", items: { type: "string" } }
        }
      }
    },
    handler: async ({ rows, cols, data } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const table = document.Tables.Add(sel.Range, rows, cols);
      if (Array.isArray(data)) {
        for (let r = 0; r < Math.min(rows, data.length); r += 1) {
          const row = data[r];
          if (!Array.isArray(row)) continue;
          for (let c = 0; c < Math.min(cols, row.length); c += 1) {
            try {
              const cell = table.Cell(r + 1, c + 1);
              cell.Range.Text = String(row[c] ?? "");
            } catch (e) { /* skip */ }
          }
        }
      }
      return { rows, cols, filled: !!data };
    }
  });

  registry.registerTool({
    name: "wps_insert_hyperlink",
    hosts: ["wps"],
    description: "在当前光标位置插入超链接。textToDisplay 留空时显示 URL 本身。",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        textToDisplay: { type: "string" },
        screenTip: { type: "string", description: "鼠标悬停提示" }
      }
    },
    handler: async ({ url, textToDisplay, screenTip } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Hyperlinks.Add(sel.Range, url, undefined, screenTip, textToDisplay || url);
      return { url, textToDisplay: textToDisplay || url };
    }
  });

  registry.registerTool({
    name: "wps_insert_image",
    hosts: ["wps"],
    description: "在当前光标位置插入图片。fileName 可以是 HTTP URL（WPS 内部下载）或本地路径。常配合 generate_image 使用：先生成拿到 URL，再用此工具插入。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        width: { type: "number", description: "宽度（磅，1磅=1/72英寸）；省略使用原图" },
        height: { type: "number", description: "高度（磅）；省略使用原图" }
      }
    },
    handler: async ({ fileName, width, height } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      const shape = document.InlineShapes.AddPicture(fileName, false, true, sel.Range);
      if (typeof width === "number") {
        try { shape.Width = width; } catch (e) {}
      }
      if (typeof height === "number") {
        try { shape.Height = height; } catch (e) {}
      }
      return { inserted: true, fileName };
    }
  });

  registry.registerTool({
    name: "wps_insert_toc",
    hosts: ["wps"],
    description: "在当前光标位置插入目录（基于文档中的标题样式）。",
    parameters: {
      type: "object",
      properties: {
        upperHeadingLevel: { type: "integer", default: 1 },
        lowerHeadingLevel: { type: "integer", default: 3 },
        useHyperlinks: { type: "boolean", default: true }
      }
    },
    handler: async ({ upperHeadingLevel = 1, lowerHeadingLevel = 3, useHyperlinks = true } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      // TablesOfContents.Add(Range, UseHeadingStyles, UpperHeadingLevel, LowerHeadingLevel,
      //   UseFields, TableID, RightAlignPageNumbers, IncludePageNumbers, AddedStyles, UseHyperlinks)
      document.TablesOfContents.Add(
        sel.Range, true, upperHeadingLevel, lowerHeadingLevel,
        false, undefined, true, true, undefined, useHyperlinks
      );
      return { upperHeadingLevel, lowerHeadingLevel };
    }
  });

  registry.registerTool({
    name: "wps_save",
    hosts: ["wps"],
    description: "保存当前文档（使用现有路径）。新文档需先在 WPS 里另存为再调用此工具。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      try {
        document.Save();
        return { saved: true, name: document.Name };
      } catch (e) {
        throw new Error(`保存失败（可能是新文档没有路径）：${e.message || e}`);
      }
    }
  });

  // ---- 批注 / 书签 ----

  registry.registerTool({
    name: "wps_add_comment",
    hosts: ["wps"],
    description: "对当前选区添加批注。",
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "批注内容" }
      }
    },
    handler: async ({ text } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Comments.Add(sel.Range, text);
      return { added: true };
    }
  });

  registry.registerTool({
    name: "wps_list_bookmarks",
    hosts: ["wps"],
    description: "列出文档中的所有书签。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const document = await getActiveDocument();
      const bms = document.Bookmarks;
      const count = bms?.Count || 0;
      const names = [];
      for (let i = 1; i <= count; i += 1) {
        try { names.push(bms.Item(i).Name); } catch (e) {}
      }
      return { count, bookmarks: names };
    }
  });

  registry.registerTool({
    name: "wps_add_bookmark",
    hosts: ["wps"],
    description: "在当前选区或光标位置添加命名书签。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "书签名（不能含空格和特殊字符）" }
      }
    },
    handler: async ({ name } = {}) => {
      const document = await getActiveDocument();
      const app = await getApp();
      const sel = app.Selection;
      if (!sel) throw new Error("未获取到 Selection。");
      document.Bookmarks.Add(name, sel.Range);
      return { added: name };
    }
  });

  registry.registerTool({
    name: "wps_goto_bookmark",
    hosts: ["wps"],
    description: "跳转到指定书签的位置。",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" }
      }
    },
    handler: async ({ name } = {}) => {
      const document = await getActiveDocument();
      const bm = document.Bookmarks.Item(name);
      if (!bm) throw new Error(`书签不存在：${name}`);
      bm.Select();
      return { gone: name };
    }
  });
})(window);
