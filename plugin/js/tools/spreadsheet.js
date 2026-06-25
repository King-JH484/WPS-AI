(function attachSpreadsheetTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  const MSO = { TRUE: -1, FALSE: 0 };
  const imageAssets = () => global.WpsAiImageAssets;

  function getHost() {
    return global.WpsAiHostSpreadsheet?._internal;
  }

  async function getSheetByName(name) {
    const internal = getHost();
    const wb = await internal.getActiveWorkbook();
    if (!wb) throw new Error("未检测到活动工作簿。");
    if (!name) {
      return wb.ActiveSheet || wb.Sheets?.Item?.(1);
    }
    try {
      return wb.Sheets.Item(name);
    } catch (error) {
      throw new Error(`未找到工作表：${name}`);
    }
  }

  function rangeOf(sheet, address) {
    if (!address) throw new Error("缺少 range 地址（如 A1:B5）");
    return sheet.Range(address);
  }

  function read2D(range) {
    let raw;
    try { raw = range.Value2; } catch (e) { raw = null; }
    if (raw == null) {
      try { raw = range.Value; } catch (e) { raw = null; }
    }
    if (raw == null) {
      const text = String(range.Text || "");
      return [[text]];
    }
    if (!Array.isArray(raw)) {
      return [[raw]];
    }
    if (Array.isArray(raw[0])) return raw;
    return [raw];
  }

  function setCell(cell, value) {
    if (typeof value === "string" && value.startsWith("=")) {
      cell.Formula = value;
      return;
    }
    cell.Value2 = value;
  }

  registry.registerTool({
    name: "et_list_sheets",
    hosts: ["et"],
    description: "列出当前 WPS 表格 工作簿的所有工作表名称。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      const count = wb.Sheets?.Count || 0;
      const names = [];
      for (let i = 1; i <= count; i += 1) {
        names.push(wb.Sheets.Item(i).Name);
      }
      const active = wb.ActiveSheet?.Name || null;
      return { sheets: names, active };
    }
  });

  registry.registerTool({
    name: "et_get_sheet_info",
    hosts: ["et"],
    description: "获取指定工作表的基本信息（已使用区域、维度、当前选区地址）。",
    parameters: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" }
      }
    },
    handler: async ({ sheet } = {}) => {
      const internal = getHost();
      const target = await getSheetByName(sheet);
      const used = target.UsedRange;
      const info = {
        name: target.Name,
        usedRange: used?.Address || null,
        rowCount: used?.Rows?.Count || 0,
        columnCount: used?.Columns?.Count || 0
      };
      try {
        const sel = (await internal.getApp()).Selection;
        info.selection = sel?.Address || null;
      } catch (e) { info.selection = null; }
      return info;
    }
  });

  registry.registerTool({
    name: "et_read_range",
    hosts: ["et"],
    description: "读取指定区域的二维数据。返回 2D 数组（行 x 列）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        range: { type: "string", description: "区域地址，如 A1:C10 或 A1（单元格）" }
      }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      return { sheet: target.Name, range: r.Address, values: read2D(r) };
    }
  });

  registry.registerTool({
    name: "et_write_range",
    hosts: ["et"],
    description: "向指定区域写入二维数据（行 x 列）。values 长度必须与 range 形状一致。字符串以 '=' 开头会作为公式写入。",
    parameters: {
      type: "object",
      required: ["range", "values"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        range: { type: "string", description: "目标区域起点或完整地址，如 A1 或 A1:C3" },
        values: {
          type: "array",
          description: "二维数据，外层为行，内层为列",
          items: { type: "array", items: {} }
        }
      }
    },
    handler: async ({ sheet, range, values } = {}) => {
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("values 必须是非空二维数组");
      }
      const target = await getSheetByName(sheet);
      const startCell = target.Range(range).Cells.Item(1, 1);
      const startRow = startCell.Row;
      const startCol = startCell.Column;
      let rows = values.length;
      let cols = 0;
      for (const row of values) {
        if (!Array.isArray(row)) throw new Error("values 内层必须是数组");
        if (row.length > cols) cols = row.length;
      }
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const cell = target.Cells.Item(startRow + r, startCol + c);
          setCell(cell, values[r][c] ?? "");
        }
      }
      const endCell = target.Cells.Item(startRow + rows - 1, startCol + cols - 1);
      return {
        sheet: target.Name,
        writtenRange: `${startCell.Address}:${endCell.Address}`,
        rows,
        cols
      };
    }
  });

  registry.registerTool({
    name: "et_set_formula",
    hosts: ["et"],
    description: "对单元格或区域批量设置公式。公式不需要前导 '='。如果只填一个公式，会应用到整个 range。",
    parameters: {
      type: "object",
      required: ["range", "formula"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        range: { type: "string", description: "目标区域，如 D2:D10" },
        formula: { type: "string", description: "公式内容，如 SUM(A2:C2)，可以带或不带前导 =" }
      }
    },
    handler: async ({ sheet, range, formula } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      const f = formula.startsWith("=") ? formula : `=${formula}`;
      r.Formula = f;
      return { sheet: target.Name, range: r.Address, formula: f };
    }
  });

  registry.registerTool({
    name: "et_add_sheet",
    hosts: ["et"],
    description: "在当前工作簿末尾新增一个工作表。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "新工作表名称，留空使用 WPS 默认命名" }
      }
    },
    handler: async ({ name } = {}) => {
      const internal = getHost();
      const wb = await internal.getActiveWorkbook();
      if (!wb) throw new Error("未检测到活动工作簿。");
      const lastIndex = wb.Sheets.Count;
      const last = wb.Sheets.Item(lastIndex);
      const sheet = wb.Sheets.Add(null, last);
      if (name) {
        try { sheet.Name = name; } catch (error) {
          throw new Error(`重命名失败：${error.message || error}`);
        }
      }
      return { name: sheet.Name, index: sheet.Index };
    }
  });

  registry.registerTool({
    name: "et_format_range",
    hosts: ["et"],
    description: "对区域设置基本格式（粗体/斜体/前景色/背景色/水平对齐）。颜色用 0xRRGGBB 或 #RRGGBB。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "目标区域" },
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        color: { type: "string", description: "字体颜色 #RRGGBB" },
        bgColor: { type: "string", description: "填充色 #RRGGBB" },
        align: { type: "string", enum: ["left", "center", "right"] }
      }
    },
    handler: async ({ sheet, range, bold, italic, color, bgColor, align } = {}) => {
      const target = await getSheetByName(sheet);
      const r = target.Range(range);
      if (typeof bold === "boolean") r.Font.Bold = bold;
      if (typeof italic === "boolean") r.Font.Italic = italic;
      if (color) r.Font.Color = parseColor(color);
      if (bgColor) r.Interior.Color = parseColor(bgColor);
      if (align) {
        // xlHAlignLeft=-4131, xlHAlignCenter=-4108, xlHAlignRight=-4152
        r.HorizontalAlignment = { left: -4131, center: -4108, right: -4152 }[align];
      }
      return { sheet: target.Name, range: r.Address };
    }
  });

  function parseColor(input) {
    let s = String(input).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
    if (s.length !== 6) throw new Error(`颜色格式错误：${input}`);
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    // WPS Color 是 BGR 整数（0xBBGGRR）
    return (b << 16) | (g << 8) | r;
  }

  // ---- 枚举常量（来自 et-jsapi-declare） ----

  const BORDER_INDEX = {
    edgeTop: 8, edgeBottom: 9, edgeLeft: 7, edgeRight: 10,
    insideHorizontal: 12, insideVertical: 11,
    diagonalDown: 5, diagonalUp: 6
  };

  const LINE_STYLE = {
    solid: 1,        // xlContinuous
    dashed: -4115,   // xlDash
    dotted: -4118,   // xlDot
    double: -4119,   // xlDouble
    dashDot: 4,      // xlDashDot
    dashDotDot: 5,   // xlDashDotDot
    none: -4142      // xlLineStyleNone
  };

  const BORDER_WEIGHT = {
    hairline: 1,
    thin: 2,
    medium: -4138,
    thick: 4
  };

  const HALIGN = { left: -4131, center: -4108, right: -4152, fill: 5, justify: -4130, distributed: -4117, general: 1 };
  const VALIGN = { top: -4160, center: -4108, bottom: -4107, justify: -4130, distributed: -4117 };

  const SORT_ORDER = { asc: 1, desc: 2 };
  const YES_NO = { yes: 1, no: 2, guess: 0 };

  const SHIFT_DIR = { down: -4121, right: -4161, left: -4159, up: -4162 };

  const AUTOFILL = {
    default: 0, copy: 1, fillSeries: 2, fillFormats: 3, fillValues: 4,
    fillDays: 5, fillWeekdays: 6, fillMonths: 7, fillYears: 8, linearTrend: 9, growthTrend: 10
  };

  // ---- Borders ----

  registry.registerTool({
    name: "et_set_borders",
    hosts: ["et"],
    description: "为指定区域设置边框。position 控制画哪些边：all（全部）/outline（外框）/inside（内框）/top/bottom/left/right/horizontal/vertical。",
    parameters: {
      type: "object",
      required: ["range", "position"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "区域地址，如 A1:C10" },
        position: {
          type: "string",
          enum: ["all", "outline", "inside", "top", "bottom", "left", "right", "horizontal", "vertical"],
          description: "边框位置"
        },
        style: { type: "string", enum: ["solid", "dashed", "dotted", "double", "dashDot", "dashDotDot", "none"], description: "线型，默认 solid" },
        weight: { type: "string", enum: ["hairline", "thin", "medium", "thick"], description: "线粗，默认 thin" },
        color: { type: "string", description: "线条颜色 #RRGGBB，默认黑色" }
      }
    },
    handler: async ({ sheet, range, position, style = "solid", weight = "thin", color } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      const styleVal = LINE_STYLE[style];
      const weightVal = BORDER_WEIGHT[weight];
      const colorVal = color ? parseColor(color) : 0; // 0 = 黑

      const apply = (idx) => {
        const b = r.Borders.Item(idx);
        if (styleVal != null) b.LineStyle = styleVal;
        if (weightVal != null) b.Weight = weightVal;
        b.Color = colorVal;
      };

      const positions = (() => {
        switch (position) {
          case "all": return [BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight, BORDER_INDEX.insideHorizontal, BORDER_INDEX.insideVertical];
          case "outline": return [BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight];
          case "inside": return [BORDER_INDEX.insideHorizontal, BORDER_INDEX.insideVertical];
          case "horizontal": return [BORDER_INDEX.insideHorizontal, BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom];
          case "vertical": return [BORDER_INDEX.insideVertical, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight];
          case "top": return [BORDER_INDEX.edgeTop];
          case "bottom": return [BORDER_INDEX.edgeBottom];
          case "left": return [BORDER_INDEX.edgeLeft];
          case "right": return [BORDER_INDEX.edgeRight];
          default: throw new Error(`未知 position：${position}`);
        }
      })();

      positions.forEach(apply);
      return { sheet: target.Name, range: r.Address, position, style, weight };
    }
  });

  registry.registerTool({
    name: "et_clear_borders",
    hosts: ["et"],
    description: "清除指定区域的所有边框。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      [
        BORDER_INDEX.edgeTop, BORDER_INDEX.edgeBottom, BORDER_INDEX.edgeLeft, BORDER_INDEX.edgeRight,
        BORDER_INDEX.insideHorizontal, BORDER_INDEX.insideVertical,
        BORDER_INDEX.diagonalDown, BORDER_INDEX.diagonalUp
      ].forEach((idx) => {
        r.Borders.Item(idx).LineStyle = LINE_STYLE.none;
      });
      return { sheet: target.Name, range: r.Address };
    }
  });

  // ---- Merge / Unmerge ----

  registry.registerTool({
    name: "et_merge_cells",
    hosts: ["et"],
    description: "合并单元格。across=true 表示按行合并（每一行作为一个合并单元）；默认 across=false 整块合并。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        across: { type: "boolean", default: false }
      }
    },
    handler: async ({ sheet, range, across = false } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.Merge(!!across);
      return { sheet: target.Name, range: r.Address, across };
    }
  });

  registry.registerTool({
    name: "et_unmerge_cells",
    hosts: ["et"],
    description: "取消合并指定区域内的所有合并单元格。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.UnMerge();
      return { sheet: target.Name, range: r.Address };
    }
  });

  // ---- Sort ----

  registry.registerTool({
    name: "et_sort_range",
    hosts: ["et"],
    description: "对区域排序。keyColumn 指定排序依据的列字母（如 \"A\"）或区域内的列序号（1=第一列）。",
    parameters: {
      type: "object",
      required: ["range", "keyColumn"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "要排序的区域，如 A1:C100" },
        keyColumn: { type: "string", description: "排序依据列：列字母(A-Z) 或区域内列序号" },
        order: { type: "string", enum: ["asc", "desc"], default: "asc" },
        hasHeader: { type: "boolean", description: "是否包含表头（首行不参与排序）", default: true }
      }
    },
    handler: async ({ sheet, range, keyColumn, order = "asc", hasHeader = true } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      // 解析 keyColumn 为绝对列字母
      let keyAddr;
      if (/^[A-Za-z]+$/.test(String(keyColumn))) {
        keyAddr = `${target.Name}!${String(keyColumn).toUpperCase()}1`;
      } else {
        const idx = parseInt(keyColumn, 10);
        if (!idx || idx < 1) throw new Error(`无效的 keyColumn：${keyColumn}`);
        const startCell = r.Cells.Item(1, 1);
        const colCell = target.Cells.Item(startCell.Row, startCell.Column + idx - 1);
        keyAddr = `${target.Name}!${colCell.Address}`;
      }
      const keyRange = target.Application.Range(keyAddr);
      r.Sort(
        keyRange,
        SORT_ORDER[order] || SORT_ORDER.asc,
        undefined, undefined, undefined, undefined, undefined,
        hasHeader ? YES_NO.yes : YES_NO.no
      );
      return { sheet: target.Name, range: r.Address, keyColumn, order, hasHeader };
    }
  });

  // ---- AutoFilter ----

  registry.registerTool({
    name: "et_set_autofilter",
    hosts: ["et"],
    description: "对区域开启或关闭自动筛选。enabled=false 时关闭当前工作表筛选。",
    parameters: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "要应用筛选的区域。enabled=true 时必填" },
        enabled: { type: "boolean", default: true }
      }
    },
    handler: async ({ sheet, range, enabled = true } = {}) => {
      const target = await getSheetByName(sheet);
      if (!enabled) {
        try { target.AutoFilterMode = false; } catch (e) { /* ignore */ }
        return { sheet: target.Name, enabled: false };
      }
      if (!range) throw new Error("启用 AutoFilter 需要提供 range");
      const r = rangeOf(target, range);
      r.AutoFilter();
      return { sheet: target.Name, range: r.Address, enabled: true };
    }
  });

  // ---- Sizing ----

  function parseColumnsToken(token) {
    // "A" / "A:C" / "1" / "1:3" → 返回起止列索引（1-based）
    const t = String(token).trim();
    if (/^\d+(:\d+)?$/.test(t)) {
      const [a, b] = t.split(":").map((n) => parseInt(n, 10));
      return [a, b || a];
    }
    const m = /^([A-Za-z]+)(?::([A-Za-z]+))?$/.exec(t);
    if (!m) throw new Error(`无效的 columns：${t}`);
    const colStrToNum = (s) => s.toUpperCase().split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
    return [colStrToNum(m[1]), m[2] ? colStrToNum(m[2]) : colStrToNum(m[1])];
  }

  function parseRowsToken(token) {
    const t = String(token).trim();
    if (/^\d+(:\d+)?$/.test(t)) {
      const [a, b] = t.split(":").map((n) => parseInt(n, 10));
      return [a, b || a];
    }
    throw new Error(`无效的 rows：${t}`);
  }

  function colNumToLetters(n) {
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // WPS 的 JS 桥不允许 sheet.Columns(N) 这种 COM 默认方法语法。
  // Columns/Rows 是 Range 属性，要用 .Item(N) 或地址法 Range("A:A")/Range("3:3") 取列/行。
  function columnAt(sheet, idx) {
    try {
      if (sheet.Columns?.Item) return sheet.Columns.Item(idx);
    } catch (e) { /* fallthrough */ }
    const letters = colNumToLetters(idx);
    return sheet.Range(`${letters}:${letters}`);
  }

  function rowAt(sheet, idx) {
    try {
      if (sheet.Rows?.Item) return sheet.Rows.Item(idx);
    } catch (e) { /* fallthrough */ }
    return sheet.Range(`${idx}:${idx}`);
  }

  registry.registerTool({
    name: "et_set_column_width",
    hosts: ["et"],
    description: "设置列宽。columns 支持 \"A\"、\"A:C\"、\"1\"、\"1:3\"。width 单位是 WPS 默认字符宽度。",
    parameters: {
      type: "object",
      required: ["columns", "width"],
      properties: {
        sheet: { type: "string" },
        columns: { type: "string", description: "列范围，例 A 或 A:C 或 1:3" },
        width: { type: "number", description: "列宽（字符数）" }
      }
    },
    handler: async ({ sheet, columns, width } = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseColumnsToken(columns);
      for (let c = start; c <= end; c += 1) {
        columnAt(target, c).ColumnWidth = width;
      }
      return { sheet: target.Name, columns, width };
    }
  });

  registry.registerTool({
    name: "et_set_row_height",
    hosts: ["et"],
    description: "设置行高。rows 支持 \"1\"、\"1:5\"。height 单位是磅（point）。",
    parameters: {
      type: "object",
      required: ["rows", "height"],
      properties: {
        sheet: { type: "string" },
        rows: { type: "string", description: "行范围，例 1 或 1:5" },
        height: { type: "number", description: "行高（磅）" }
      }
    },
    handler: async ({ sheet, rows, height } = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseRowsToken(rows);
      for (let r = start; r <= end; r += 1) {
        rowAt(target, r).RowHeight = height;
      }
      return { sheet: target.Name, rows, height };
    }
  });

  registry.registerTool({
    name: "et_autofit",
    hosts: ["et"],
    description: "自动调整区域的行高和/或列宽到内容大小。dimension：rows / columns / both。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        dimension: { type: "string", enum: ["rows", "columns", "both"], default: "both" }
      }
    },
    handler: async ({ sheet, range, dimension = "both" } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      if (dimension === "rows" || dimension === "both") r.EntireRow.AutoFit();
      if (dimension === "columns" || dimension === "both") r.EntireColumn.AutoFit();
      return { sheet: target.Name, range: r.Address, dimension };
    }
  });

  // ---- Insert / Delete rows / columns ----

  registry.registerTool({
    name: "et_insert_rows",
    hosts: ["et"],
    description: "在指定行号之前插入若干行。",
    parameters: {
      type: "object",
      required: ["atRow"],
      properties: {
        sheet: { type: "string" },
        atRow: { type: "integer", minimum: 1, description: "插入位置（在该行之前插入）" },
        count: { type: "integer", minimum: 1, default: 1 }
      }
    },
    handler: async ({ sheet, atRow, count = 1 } = {}) => {
      const target = await getSheetByName(sheet);
      for (let i = 0; i < count; i += 1) {
        rowAt(target, atRow).Insert(SHIFT_DIR.down);
      }
      return { sheet: target.Name, atRow, count };
    }
  });

  registry.registerTool({
    name: "et_insert_columns",
    hosts: ["et"],
    description: "在指定列之前插入若干列。",
    parameters: {
      type: "object",
      required: ["atColumn"],
      properties: {
        sheet: { type: "string" },
        atColumn: { type: "string", description: "插入位置：列字母（如 B）或列号（2）" },
        count: { type: "integer", minimum: 1, default: 1 }
      }
    },
    handler: async ({ sheet, atColumn, count = 1 } = {}) => {
      const target = await getSheetByName(sheet);
      const [colIdx] = parseColumnsToken(atColumn);
      for (let i = 0; i < count; i += 1) {
        columnAt(target, colIdx).Insert(SHIFT_DIR.right);
      }
      return { sheet: target.Name, atColumn, count };
    }
  });

  registry.registerTool({
    name: "et_insert_image",
    hosts: ["et"],
    description: "在当前 WPS 表格工作表插入图片。fileName 可以是 HTTP URL、dataUrl 或本地路径；HTTP/dataUrl 会先落成本地文件再插入，默认放到当前选区左上角。",
    parameters: {
      type: "object",
      required: ["fileName"],
      properties: {
        sheet: { type: "string", description: "工作表名称，留空表示当前活动工作表" },
        cell: { type: "string", description: "目标单元格地址，如 B2；留空表示当前选区" },
        fileName: { type: "string", description: "图片 URL 或本地路径" },
        left: { type: "number", description: "左侧位置（磅），传入后优先于 cell/选区" },
        top: { type: "number", description: "顶部位置（磅），传入后优先于 cell/选区" },
        width: { type: "number", default: 240, description: "宽度（磅）" },
        height: { type: "number", description: "高度（磅），省略使用原图比例或 WPS 默认值" }
      }
    },
    handler: async ({ sheet, cell, fileName, left, top, width = 240, height } = {}) => {
      if (!fileName) throw new Error("缺少图片路径 fileName。");
      const localFileName = await imageAssets()?.ensureLocalImagePath?.(fileName) || fileName;
      const internal = getHost();
      const app = await internal.getApp();
      const target = await getSheetByName(sheet);
      try { target.Activate(); } catch (e) {}

      let anchor = null;
      if (cell) {
        anchor = rangeOf(target, cell);
      } else {
        try { anchor = app.Selection; } catch (e) {}
        if (!anchor || typeof anchor.Left !== "number" || typeof anchor.Top !== "number") {
          try { anchor = target.Range("A1"); } catch (e) {}
        }
      }

      const x = typeof left === "number" ? left : (Number(anchor?.Left) || 0);
      const y = typeof top === "number" ? top : (Number(anchor?.Top) || 0);
      const w = typeof width === "number" ? width : undefined;
      const h = typeof height === "number" ? height : undefined;
      let shape = null;
      if (target.Shapes?.AddPicture) {
        shape = target.Shapes.AddPicture(localFileName, MSO.FALSE, MSO.TRUE, x, y, w, h);
      } else if (target.Pictures?.Insert) {
        shape = target.Pictures.Insert(localFileName);
        try { shape.Left = x; } catch (e) {}
        try { shape.Top = y; } catch (e) {}
        if (typeof w === "number") { try { shape.Width = w; } catch (e) {} }
        if (typeof h === "number") { try { shape.Height = h; } catch (e) {} }
      } else {
        throw new Error("当前 WPS 表格对象不支持插入图片。");
      }
      return {
        sheet: target.Name,
        cell: cell || anchor?.Address || null,
        fileName: localFileName,
        sourceFileName: fileName,
        shapeIndex: target.Shapes?.Count || null,
        left: x,
        top: y,
        width: w || null,
        height: h || null
      };
    }
  });

  registry.registerTool({
    name: "et_delete_rows",
    hosts: ["et"],
    description: "删除指定行。rows 支持 \"3\" 或 \"3:5\"。",
    parameters: {
      type: "object",
      required: ["rows"],
      properties: {
        sheet: { type: "string" },
        rows: { type: "string", description: "行范围，例 3 或 3:5" }
      }
    },
    handler: async ({ sheet, rows } = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseRowsToken(rows);
      // 从后往前删，避免索引漂移
      for (let r = end; r >= start; r -= 1) {
        rowAt(target, r).Delete();
      }
      return { sheet: target.Name, rows, deleted: end - start + 1 };
    }
  });

  registry.registerTool({
    name: "et_delete_columns",
    hosts: ["et"],
    description: "删除指定列。columns 支持 \"B\"、\"B:D\"、\"2\"、\"2:4\"。",
    parameters: {
      type: "object",
      required: ["columns"],
      properties: {
        sheet: { type: "string" },
        columns: { type: "string" }
      }
    },
    handler: async ({ sheet, columns } = {}) => {
      const target = await getSheetByName(sheet);
      const [start, end] = parseColumnsToken(columns);
      for (let c = end; c >= start; c -= 1) {
        columnAt(target, c).Delete();
      }
      return { sheet: target.Name, columns, deleted: end - start + 1 };
    }
  });

  // ---- Fill / Clear ----

  registry.registerTool({
    name: "et_fill_down",
    hosts: ["et"],
    description: "把首行内容向下填充到整个区域（FillDown）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.FillDown();
      return { sheet: target.Name, range: r.Address };
    }
  });

  registry.registerTool({
    name: "et_fill_right",
    hosts: ["et"],
    description: "把首列内容向右填充到整个区域（FillRight）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.FillRight();
      return { sheet: target.Name, range: r.Address };
    }
  });

  registry.registerTool({
    name: "et_clear",
    hosts: ["et"],
    description: "清除区域内容。mode：contents（仅值/公式）/ formats（仅格式）/ all（全部）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        mode: { type: "string", enum: ["contents", "formats", "all"], default: "contents" }
      }
    },
    handler: async ({ sheet, range, mode = "contents" } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      if (mode === "contents" || mode === "all") r.ClearContents();
      if (mode === "formats" || mode === "all") r.ClearFormats();
      return { sheet: target.Name, range: r.Address, mode };
    }
  });

  // ---- Number format / extended formatting ----

  registry.registerTool({
    name: "et_set_number_format",
    hosts: ["et"],
    description: "设置区域的数字格式。常见 format 字符串：\"0.00\"（两位小数）、\"0.00%\"（百分比）、\"#,##0\"（千分位）、\"yyyy-mm-dd\"（日期）、\"@\"（文本）。",
    parameters: {
      type: "object",
      required: ["range", "format"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        format: { type: "string", description: "Excel 数字格式代码" }
      }
    },
    handler: async ({ sheet, range, format } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      r.NumberFormat = format;
      return { sheet: target.Name, range: r.Address, format };
    }
  });

  registry.registerTool({
    name: "et_set_alignment",
    hosts: ["et"],
    description: "设置区域对齐方式。h（水平）：left/center/right/fill/justify/general；v（垂直）：top/center/bottom/justify。可单独传任一项。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        h: { type: "string", enum: ["left", "center", "right", "fill", "justify", "distributed", "general"] },
        v: { type: "string", enum: ["top", "center", "bottom", "justify", "distributed"] },
        wrap: { type: "boolean", description: "是否自动换行" }
      }
    },
    handler: async ({ sheet, range, h, v, wrap } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, range);
      if (h && HALIGN[h] != null) r.HorizontalAlignment = HALIGN[h];
      if (v && VALIGN[v] != null) r.VerticalAlignment = VALIGN[v];
      if (typeof wrap === "boolean") r.WrapText = wrap;
      return { sheet: target.Name, range: r.Address, h, v, wrap };
    }
  });

  // ---- Find / Replace ----

  registry.registerTool({
    name: "et_find_replace",
    hosts: ["et"],
    description: "在指定区域执行查找替换。range 留空时对整个工作表生效。",
    parameters: {
      type: "object",
      required: ["find", "replace"],
      properties: {
        sheet: { type: "string" },
        range: { type: "string", description: "可选；省略时使用 UsedRange" },
        find: { type: "string" },
        replace: { type: "string" },
        matchCase: { type: "boolean", default: false }
      }
    },
    handler: async ({ sheet, range, find, replace, matchCase = false } = {}) => {
      const target = await getSheetByName(sheet);
      const r = range ? rangeOf(target, range) : target.UsedRange;
      // Replace(What, Replacement, LookAt, SearchOrder, MatchCase)
      const ok = r.Replace(find, replace, undefined, undefined, !!matchCase);
      return { sheet: target.Name, range: r.Address, find, replace, matched: !!ok };
    }
  });

  // ---- Freeze panes ----

  registry.registerTool({
    name: "et_freeze_panes",
    hosts: ["et"],
    description: "冻结窗格。splitRow 表示在第几行下方水平分割（0=不水平分割）；splitColumn 表示在第几列右侧垂直分割（0=不垂直分割）。",
    parameters: {
      type: "object",
      properties: {
        splitRow: { type: "integer", minimum: 0, default: 1, description: "冻结的行数（在第 N 行下方分割）" },
        splitColumn: { type: "integer", minimum: 0, default: 0, description: "冻结的列数（在第 N 列右侧分割）" }
      }
    },
    handler: async ({ splitRow = 1, splitColumn = 0 } = {}) => {
      const internal = getHost();
      const app = await internal.getApp();
      const win = app.ActiveWindow;
      if (!win) throw new Error("未获取到活动窗口。");
      // 先解冻避免叠加
      try { win.FreezePanes = false; } catch (e) {}
      win.SplitRow = splitRow;
      win.SplitColumn = splitColumn;
      win.FreezePanes = true;
      return { splitRow, splitColumn };
    }
  });

  registry.registerTool({
    name: "et_unfreeze_panes",
    hosts: ["et"],
    description: "取消冻结窗格。",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const internal = getHost();
      const app = await internal.getApp();
      const win = app.ActiveWindow;
      if (!win) throw new Error("未获取到活动窗口。");
      win.FreezePanes = false;
      return { ok: true };
    }
  });

  // ---- Hyperlinks ----

  registry.registerTool({
    name: "et_add_hyperlink",
    hosts: ["et"],
    description: "在指定单元格添加超链接。",
    parameters: {
      type: "object",
      required: ["cell", "address"],
      properties: {
        sheet: { type: "string" },
        cell: { type: "string", description: "目标单元格，如 A1" },
        address: { type: "string", description: "URL 或路径" },
        displayText: { type: "string", description: "显示文本，省略时使用 address" },
        screenTip: { type: "string", description: "鼠标悬浮提示" }
      }
    },
    handler: async ({ sheet, cell, address, displayText, screenTip } = {}) => {
      const target = await getSheetByName(sheet);
      const r = rangeOf(target, cell);
      target.Hyperlinks.Add(r, address, undefined, screenTip, displayText || address);
      return { sheet: target.Name, cell: r.Address, address, displayText: displayText || address };
    }
  });

  // ---- Sheet management ----

  registry.registerTool({
    name: "et_rename_sheet",
    hosts: ["et"],
    description: "重命名工作表。",
    parameters: {
      type: "object",
      required: ["newName"],
      properties: {
        sheet: { type: "string", description: "要改名的工作表，省略表示当前活动工作表" },
        newName: { type: "string" }
      }
    },
    handler: async ({ sheet, newName } = {}) => {
      const target = await getSheetByName(sheet);
      const oldName = target.Name;
      target.Name = newName;
      return { oldName, newName: target.Name };
    }
  });

  registry.registerTool({
    name: "et_delete_sheet",
    hosts: ["et"],
    description: "删除指定工作表。慎用。",
    parameters: {
      type: "object",
      required: ["sheet"],
      properties: { sheet: { type: "string" } }
    },
    handler: async ({ sheet } = {}) => {
      const target = await getSheetByName(sheet);
      const name = target.Name;
      const internal = getHost();
      const app = await internal.getApp();
      // 关闭确认弹窗（如果支持）
      try { app.DisplayAlerts = false; } catch (e) {}
      target.Delete();
      try { app.DisplayAlerts = true; } catch (e) {}
      return { deleted: name };
    }
  });

  registry.registerTool({
    name: "et_activate_sheet",
    hosts: ["et"],
    description: "激活（切换到）指定工作表。",
    parameters: {
      type: "object",
      required: ["sheet"],
      properties: { sheet: { type: "string" } }
    },
    handler: async ({ sheet } = {}) => {
      const target = await getSheetByName(sheet);
      target.Activate();
      return { active: target.Name };
    }
  });

  // ---- Selection ----

  registry.registerTool({
    name: "et_select_range",
    hosts: ["et"],
    description: "把选区移动到指定区域（不写入数据，只是选中）。",
    parameters: {
      type: "object",
      required: ["range"],
      properties: { sheet: { type: "string" }, range: { type: "string" } }
    },
    handler: async ({ sheet, range } = {}) => {
      const target = await getSheetByName(sheet);
      try { target.Activate(); } catch (e) {}
      const r = rangeOf(target, range);
      r.Select();
      return { sheet: target.Name, range: r.Address };
    }
  });
})(window);
