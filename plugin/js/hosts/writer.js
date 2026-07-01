(function attachWriterHost(global) {
  "use strict";

  async function getApp() {
    return global.WpsAiAddon?.getApplication ? await global.WpsAiAddon.getApplication() : global.Application;
  }

  async function getActiveDocument() {
    const app = await getApp();
    return app?.ActiveDocument || null;
  }

  async function ensureDocument() {
    const doc = await getActiveDocument();
    if (!doc) {
      throw new Error("未检测到打开的 WPS 文字文档。");
    }
    return doc;
  }

  async function getSelection() {
    const app = await getApp();
    const doc = await getActiveDocument();
    return app?.Selection || doc?.Application?.Selection || null;
  }

  async function readSelectionText() {
    const sel = await getSelection();
    const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
    const text = sel?.Text || range?.Text || "";
    return String(text).trim();
  }

  // 探测 range 首段的列表格式：无序 / 有序 / 无，以及 level。
  //
  // 判据优先级（前面命中就返回，后面的只作兜底）：
  //   1. ListFormat.ListString —— 段落实际显示的项目符号 / 编号字符。
  //      "•/○/■/▪/◦/·/-/*" 是 bullet；"1./a)/I./①" 是 numbered。最准。
  //   2. ListFormat.ListType —— Word 常量枚举
  //        0 = wdListNoNumbering
  //        1 = wdListListNumOnly
  //        2 = wdListSimpleNumbering
  //        3 = wdListBullet
  //        4 = wdListMixedNumbering
  //        5 = wdListOutlineNumbering
  //        6 = wdListPictureBullet
  //      3 / 6 → bullet；其它非 0 → numbered。之前只认 3，用户用图片项目符号被误判 numbered。
  //   3. 段落 Style 名字（"项目符号 / List Bullet / 无序列表 / 编号列表 / List Number …"）—— 用户
  //      用 Style 应用 list 而不是走 ListFormat 时兜底。
  function detectListFormat(range) {
    if (!range) return null;
    let lf = null;
    try { lf = range.ListFormat; } catch (e) {}
    let listLevel = 1;
    try { if (lf) listLevel = Number(lf.ListLevelNumber) || 1; } catch (e) {}
    const clampLevel = () => Math.max(1, Math.min(9, listLevel));

    // 收集诊断信息 —— 用户报告 ListType=5/2 但视觉是 bullet，得看清楚 WPS 到底返回啥
    let listString = "";
    let listStringCodes = "";
    let listType = 0;
    let listValue = null;
    let styleName = "";
    try { if (lf) listString = String(lf.ListString || ""); } catch (e) {}
    try {
      // 把每个字符的码点也带出来，看是不是奇怪的 PUA 或 unicode 变体
      listStringCodes = Array.from(listString).slice(0, 4).map((c) => c.charCodeAt(0).toString(16)).join(",");
    } catch (e) {}
    try { if (lf) listType = Number(lf.ListType) || 0; } catch (e) {}
    try { if (lf) { const v = lf.ListValue; if (v != null) listValue = Number(v); } } catch (e) {}
    try {
      const p = range.Paragraphs?.Item?.(1);
      const style = p?.Style;
      styleName = String(style?.NameLocal || style?.Name || style || "");
    } catch (e) {}
    const diag = { listString, listStringCodes, listType, listValue, styleName, listLevel };

    // 1) ListString 字符判断（最准 —— 人眼看到什么就是什么）
    const trimmed = listString.trim();
    if (trimmed) {
      // bullet 字符集：常见 unicode + WPS 里的 F0B7（Wingdings 的 · 私用区映射）
      if (/^[•○◦▪■▫◾◽·‧⁃∙▶►◆◇★☆✓✔◉◎●\-*+·]|^|^|^|^/.test(trimmed)) {
        return { kind: "bullet", level: clampLevel(), _via: "listString-bullet", _diag: diag };
      }
      // numbered：数字 / 字母 / 罗马 / ①② / 中文数字
      if (/^\d|^[a-zA-Z][\.\)]|^[IVXLCM]+[\.\)]|^[Ⅰ-ⅿ]|^[①-⒛]|^[０-９]|^[一二三四五六七八九十]/.test(trimmed)) {
        return { kind: "numbered", level: clampLevel(), _via: "listString-numbered", _diag: diag };
      }
      // ListString 有内容但都不匹配：既然肉眼视觉不像数字，默认按 bullet 处理（比误判成 ol 好）
      return { kind: "bullet", level: clampLevel(), _via: "listString-fallback-bullet", _diag: diag };
    }

    // 2) ListString 空：靠 ListValue 决胜
    //   ListValue 是本项的编号数字（1, 2, 3…），bullet 项没编号会返回 0 / null / 抛错。
    //   凡是能拿到 > 0 的 ListValue 才判 numbered，否则一律 bullet（比"任何 ListType>0 都算 numbered"稳）
    if (listValue != null && listValue > 0) {
      return { kind: "numbered", level: clampLevel(), _via: "listValue", _diag: diag };
    }
    if (listType === 3 || listType === 6) {
      return { kind: "bullet", level: clampLevel(), _via: "listType-bullet", _diag: diag };
    }
    if (listType > 0 && listValue === 0) {
      // 有 list 属性 + 编号值 = 0 → 大概率是 bullet（Outline 模板下的项目符号）
      return { kind: "bullet", level: clampLevel(), _via: "listValue-zero-bullet", _diag: diag };
    }

    // 3) Style 名字兜底
    if (styleName) {
      if (/项目符号|无序列表|list.*bullet|bullet/i.test(styleName)) {
        return { kind: "bullet", level: clampLevel(), _via: "style-bullet", _diag: diag };
      }
      if (/编号列表|有序列表|list.*number|numbered/i.test(styleName)) {
        return { kind: "numbered", level: clampLevel(), _via: "style-numbered", _diag: diag };
      }
    }

    // 4) 什么都没匹配上但 ListType > 0：只有到这一步才 fallback numbered
    if (listType > 0) {
      return { kind: "numbered", level: clampLevel(), _via: "listType-last-resort", _diag: diag };
    }

    return null;
  }

  async function readSelectionSnapshot() {
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const range = typeof sel?.Range === "function" ? await sel.Range() : sel?.Range;
    const text = sel?.Text || range?.Text || "";
    const listFormat = detectListFormat(range);
    // 打日志：帮排查"选中 bullet 却识别成 numbered"这类情况
    // 只输出前几个字段避免爆日志；_via / _sample 会告诉我们是哪层判据命中的
    try {
      global.WpsAiLog?.log?.("fmt:snapshot-listFormat", {
        listFormat,
        textLen: String(text || "").length,
        textPreview: String(text || "").slice(0, 30)
      });
    } catch (e) {}
    return {
      text: String(text || "").trim(),
      range: {
        start: Number(range?.Start),
        end: Number(range?.End)
      },
      listFormat
    };
  }

  function HTML_FILE_URL() { return (window.WpsAiRuntime?.proxyBase?.() || "http://127.0.0.1:3890") + "/html-file"; }

  async function readDocumentText() {
    const doc = await ensureDocument();
    const range = typeof doc.Range === "function" ? await doc.Range() : null;
    const text = doc.Content?.Text || range?.Text || "";
    return String(text).trim();
  }

  // 结构化读文档：按顶层段落遍历，每段记 [rangeStart, rangeEnd] + kind。
  // 表格 / 内嵌图 / 目录等特殊段落标 kind=table/image/other，AI 只处理 kind=paragraph 的。
  // 排版应用时表格 / 图片 Range 完全跳过，保住原样。
  //
  // 检测"是否在表格里"：主路径 Range.Information(12)（wdWithInTable）。
  // 兜底：先把文档里所有 doc.Tables[i].Range 的 [start, end] 收集起来，段落 range
  // 落在任何一个表格 range 内也算 table —— 之前 Information(12) 在某些段落抛异常时
  // 会把表格里的段落漏判成正文，AI 拿去当成段落重排，预览出现"乱码"（其实是拆开
  // 的表格单元格文本）。
  // 调试日志：直接走 window.WpsAiLog.log（等同于 plog），自动落进 lingxi 日志查看器 +
  // console。之前用 console.log + /debug-log 用户看不到（日志查看器只捕获 plog 格式）。
  // 每次预览都会打 4 条摘要，够看清楚"6 层判断到底哪一层跑通了"。
  function fmtLog(tag, data) {
    try {
      const logger = global.WpsAiLog?.log;
      if (logger) { logger("fmt:" + tag, data); return; }
      // 老逻辑兜底
      console.log("[format-preview]", tag, data);
    } catch (e) {}
  }

  async function readDocumentStructure() {
    const doc = await ensureDocument();
    const paragraphs = doc.Content?.Paragraphs;
    if (!paragraphs) {
      fmtLog("no-paragraphs", { hasContent: !!doc.Content });
      return { segments: [], editable: [], tables: [] };
    }

    // 一次性走 doc.Tables 收 3 件事：
    //   - tableRanges: 每张表的 Range [start, end]
    //   - cellRanges:  每个单元格的 Range [start, end]  （老 .wps 格式 Table.Range 会漏字符，cell 级更稳）
    //   - tableParaStarts: 反向枚举 —— 直接用 table.Range.Paragraphs 拿到"这张表里的所有段落"的 Range.Start
    //     Set。主循环用 Set.has(p.Range.Start) 判断，绕过所有段级 API（Information / Range.Tables /
    //     Range.Cells）在某些格式下不给正确答案的情况。只要 doc.Tables 能枚举 + 拿到 paragraph.Range.Start
    //     就 100% 准确 —— 这是老 .wps 文件表格漏检的关键补丁。
    const tableRanges = [];
    const cellRanges = [];
    const tableParaStarts = new Set();
    // 收集期错误也记一下，方便看是哪个 API 挂了
    const collectErrors = [];
    try {
      const tables = doc.Tables;
      const tCount = Number(tables?.Count) || 0;
      fmtLog("tables-count", { count: tCount, hasTablesObj: !!tables });
      for (let t = 1; t <= tCount; t += 1) {
        try {
          const table = tables.Item(t);
          const tr = table?.Range;
          let trStart = -1, trEnd = -1;
          if (tr) {
            trStart = Number(tr.Start) || 0;
            trEnd = Number(tr.End) || 0;
            tableRanges.push({ start: trStart, end: trEnd });
          }
          // 反向枚举：表里的所有段落 Range.Start 直接进 Set
          let tpAdded = 0;
          try {
            const tParas = tr?.Paragraphs;
            const tpCount = Number(tParas?.Count) || 0;
            for (let pi = 1; pi <= tpCount; pi += 1) {
              try {
                const tp = tParas.Item(pi);
                const s = Number(tp?.Range?.Start);
                if (Number.isFinite(s)) { tableParaStarts.add(s); tpAdded += 1; }
              } catch (e) {}
            }
            fmtLog("table-paragraphs", { tableIdx: t, count: tpCount, added: tpAdded, tableRange: [trStart, trEnd] });
          } catch (e) { collectErrors.push({ where: `t${t}.Range.Paragraphs`, error: e?.message || String(e) }); }
          // 单元格级 range 兜底
          let cellAdded = 0;
          try {
            const rows = table.Rows;
            const rCount = Number(rows?.Count) || 0;
            for (let ri = 1; ri <= rCount; ri += 1) {
              try {
                const row = rows.Item(ri);
                const cells = row.Cells;
                const cCount = Number(cells?.Count) || 0;
                for (let ci = 1; ci <= cCount; ci += 1) {
                  try {
                    const cell = cells.Item(ci);
                    const cr = cell?.Range;
                    if (cr) { cellRanges.push({ start: Number(cr.Start) || 0, end: Number(cr.End) || 0 }); cellAdded += 1; }
                  } catch (e) {}
                }
              } catch (e) {}
            }
            fmtLog("table-cells", { tableIdx: t, rows: rCount, cellsCollected: cellAdded });
          } catch (e) { collectErrors.push({ where: `t${t}.Rows`, error: e?.message || String(e) }); }
        } catch (e) { collectErrors.push({ where: `tables.Item(${t})`, error: e?.message || String(e) }); }
      }
    } catch (e) { collectErrors.push({ where: "doc.Tables", error: e?.message || String(e) }); }
    fmtLog("collect-summary", {
      tableRanges: tableRanges.length,
      cellRanges: cellRanges.length,
      tableParaStarts: tableParaStarts.size,
      errors: collectErrors
    });
    const isInsideAnyTable = (s, e) => {
      if (tableRanges.some((tr) => s >= tr.start && e <= tr.end)) return true;
      // 单元格边界更细，段落大概率整段落在某个 cell 里；也允许 s 只落在 cell 内（尾字符差 1）
      return cellRanges.some((cr) => s >= cr.start && s < cr.end);
    };

    const count = Number(paragraphs.Count) || 0;
    fmtLog("main-loop-start", { paragraphCount: count });
    const segments = [];
    // 逐层命中统计 + 前 N 条明细
    const layerHitCount = { paraStarts: 0, information: 0, rangeTables: 0, rangeCells: 0, ranges: 0, bel: 0, none: 0 };
    const detailed = [];
    const DETAIL_MAX = 30; // 只留前 30 条明细
    for (let i = 1; i <= count; i += 1) {
      let p, r;
      try { p = paragraphs.Item(i); } catch (e) { continue; }
      try { r = p.Range; } catch (e) { continue; }
      if (!r) continue;
      let start = 0, end = 0;
      try { start = Number(r.Start) || 0; } catch (e) {}
      try { end = Number(r.End) || 0; } catch (e) {}
      // 6 层判断，从最可靠到最兜底
      let inTable = false;
      let hitLayer = null;
      // 1. 反向枚举
      if (tableParaStarts.has(start)) { inTable = true; hitLayer = "paraStarts"; }
      // 2. Information(12)
      let infoVal = null;
      if (!inTable) {
        try { infoVal = r.Information(12); inTable = !!infoVal; if (inTable) hitLayer = "information"; } catch (e) {}
      }
      // 3. Range.Tables.Count
      let rangeTablesCount = null;
      if (!inTable) {
        try { rangeTablesCount = Number(r.Tables?.Count) || 0; if (rangeTablesCount > 0) { inTable = true; hitLayer = "rangeTables"; } } catch (e) {}
      }
      // 4. Range.Cells.Count
      let rangeCellsCount = null;
      if (!inTable) {
        try { rangeCellsCount = Number(r.Cells?.Count) || 0; if (rangeCellsCount > 0) { inTable = true; hitLayer = "rangeCells"; } } catch (e) {}
      }
      // 5. tableRanges + cellRanges 区间
      if (!inTable && isInsideAnyTable(start, end)) { inTable = true; hitLayer = "ranges"; }
      let hasImage = false;
      try { hasImage = (Number(r.InlineShapes?.Count) || 0) > 0; } catch (e) {}
      let text = "";
      try { text = String(r.Text || ""); } catch (e) {}
      text = text.replace(/[\r\n\v]+$/g, "");
      // 6. BEL
      if (!inTable && /\x07/.test(text)) { inTable = true; hitLayer = "bel"; }
      if (hitLayer) layerHitCount[hitLayer] += 1; else layerHitCount.none += 1;
      let kind = "paragraph";
      if (inTable) kind = "table";
      else if (hasImage) kind = "image";
      else if (text.trim() === "") kind = "empty";
      // 前 DETAIL_MAX 条 + 所有命中 table 的都记明细，方便排查
      if (detailed.length < DETAIL_MAX || inTable) {
        detailed.push({
          idx: i - 1, start, end, kind, hitLayer,
          infoVal, rangeTablesCount, rangeCellsCount,
          textPreview: text.slice(0, 40)
        });
      }
      segments.push({ idx: i - 1, kind, text, start, end });
    }
    fmtLog("main-loop-done", { layerHits: layerHitCount, detailedSample: detailed.slice(0, 40) });
    // AI 只处理 editable = kind === "paragraph"（空段落也跳过，避免污染 AI 输出）
    const editable = segments
      .filter((s) => s.kind === "paragraph")
      .map((s, editIdx) => ({ editIdx, refIdx: s.idx, text: s.text }));

    // 表格清单：把每张表的 cells 二维数组也读出来，供预览面板渲染成 <table>
    // 让用户看到跟真实文档一致的排版。之前只跳过表格 range，预览面板里表格就"消失"了。
    // 每张表按 tableRange 与哪些 segments 重叠来关联；预览合并时用 startsAt 找回原顺序。
    const tables = [];
    try {
      const wpsTables = doc.Tables;
      const tCount2 = Number(wpsTables?.Count) || 0;
      for (let ti = 1; ti <= tCount2; ti += 1) {
        try {
          const t = wpsTables.Item(ti);
          const trStart = Number(t.Range?.Start) || 0;
          const trEnd = Number(t.Range?.End) || 0;
          const rowCount = Math.min(Number(t.Rows?.Count) || 0, 100);  // 太大就截，防爆 DOM
          const colCount = Math.min(Number(t.Columns?.Count) || 0, 20);
          const cells = [];
          for (let r = 1; r <= rowCount; r += 1) {
            const row = [];
            for (let c = 1; c <= colCount; c += 1) {
              let cellText = "";
              try { cellText = String(t.Cell(r, c)?.Range?.Text || "").replace(/[\r\n\v\x07]+$/g, ""); } catch (e) {}
              row.push(cellText);
            }
            cells.push(row);
          }
          tables.push({ tableIndex: ti, start: trStart, end: trEnd, rows: rowCount, cols: colCount, cells });
        } catch (e) {}
      }
    } catch (e) {}
    fmtLog("final", {
      segmentsByKind: segments.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
      editableCount: editable.length,
      tablesCount: tables.length
    });
    return { segments, editable, tables };
  }

  const STYLE_IDS = {
    normal: -1,
    title: -63,
    subtitle: -75,
    heading1: -2,
    heading2: -3,
    heading3: -4,
    heading4: -5,
    bullet: -19,
    numbered: -29,
    quote: -85
  };

  function safeSet(obj, prop, value) {
    try { obj[prop] = value; } catch (e) {}
  }

  function clearParagraphFormat(sel) {
    try { sel?.Range?.ListFormat?.RemoveNumbers?.(); } catch (e) {}
    try {
      const pf = sel?.ParagraphFormat;
      if (!pf) return;
      safeSet(pf, "LeftIndent", 0);
      safeSet(pf, "FirstLineIndent", 0);
      safeSet(pf, "RightIndent", 0);
      safeSet(pf, "CharacterUnitLeftIndent", 0);
      safeSet(pf, "CharacterUnitFirstLineIndent", 0);
      safeSet(pf, "CharacterUnitRightIndent", 0);
      safeSet(pf, "SpaceBefore", 0);
      safeSet(pf, "SpaceAfter", 6);
      safeSet(pf, "LineSpacingRule", 0);
    } catch (e) {}
  }

  function applyBlockStyle(sel, type, level) {
    const t = String(type || "paragraph").toLowerCase();
    clearParagraphFormat(sel);
    let style = STYLE_IDS.normal;
    if (t === "title") style = STYLE_IDS.title;
    else if (t === "subtitle") style = STYLE_IDS.subtitle;
    else if (t === "heading") {
      const n = Math.max(1, Math.min(4, Number(level || 1)));
      style = STYLE_IDS[`heading${n}`] || STYLE_IDS.heading1;
    } else if (t === "quote") {
      style = STYLE_IDS.quote;
    } else if (t === "bullet") {
      style = STYLE_IDS.bullet;
    } else if (t === "numbered") {
      style = STYLE_IDS.numbered;
    }
    safeSet(sel, "Style", style);
    try {
      const font = sel.Font;
      if (font) {
        if (t === "title") {
          safeSet(font, "Bold", true);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 18);
        } else if (t === "subtitle") {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 12);
        } else if (t === "heading") {
          safeSet(font, "Bold", true);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", Number(level || 1) <= 1 ? 16 : (Number(level || 1) === 2 ? 14 : 12));
        } else if (t === "quote") {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", true);
          safeSet(font, "Size", 10.5);
        } else {
          safeSet(font, "Bold", false);
          safeSet(font, "Italic", false);
          safeSet(font, "Size", 10.5);
        }
      }
    } catch (e) {}
    if (t === "bullet") {
      try { sel.Range.ListFormat?.ApplyBulletDefault?.(); } catch (e) {}
    } else if (t === "numbered") {
      try { sel.Range.ListFormat?.ApplyNumberDefault?.(); } catch (e) {}
    }
    if ((t === "bullet" || t === "numbered") && Number(level) > 1) {
      try {
        const pf = sel.ParagraphFormat;
        if (pf) safeSet(pf, "LeftIndent", 14 * Math.min(Number(level) - 1, 5));
      } catch (e) {}
    }
  }

  function writePlainParagraph(sel, text) {
    const value = String(text || "").replace(/\s+$/g, "");
    if (value) {
      if (typeof sel.TypeText === "function") sel.TypeText(value);
      else if (typeof sel.InsertAfter === "function") sel.InsertAfter(value);
      else throw new Error("当前 Selection 对象不支持写入文本。");
    }
    if (typeof sel.TypeParagraph === "function") sel.TypeParagraph();
    else if (typeof sel.TypeText === "function") sel.TypeText("\n");
  }

  async function replaceDocumentBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("没有可替换的排版内容。");
    }
    await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    if (typeof sel.WholeStory !== "function") throw new Error("当前 Selection 不支持全文选择。");
    sel.WholeStory();
    try { sel.Delete(); } catch (e) {
      try { sel.Text = ""; } catch (e2) {}
    }
    for (const block of blocks) {
      const type = String(block?.type || "paragraph").toLowerCase();
      if (type === "spacer") {
        if (typeof sel.TypeParagraph === "function") sel.TypeParagraph();
        continue;
      }
      applyBlockStyle(sel, type, block?.level);
      const text = block?.text != null ? block.text : "";
      writePlainParagraph(sel, text);
      clearParagraphFormat(sel);
    }
    return { replaced: blocks.length };
  }

  // 分段范围替换：只动 kind=paragraph 的段落，表格 / 图片 / 特殊段落一律跳过。
  //   - segments: readDocumentStructure() 返回的段落清单
  //   - blocks:   AI 返回的排版 block，sourceIndex 指向 editable 数组的索引
  // 从后往前替换，前面段落的 [start,end] 不受后面替换的长度变化影响。
  //
  // 关键坑：paragraph.Range 通常包含段落末尾的 ¶（\r）。直接 sel.Delete() 会把段落合并
  // 掉，跟前后段落连成一坨。所以先把 sel.End 收缩到 ¶ 之前，只删正文；再 TypeText 新
  // 内容，¶ 保留 —— 前后段落隔断完整。
  async function replaceParagraphsInPlace(segments, blocks) {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("段落清单为空。");
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("没有可替换的排版内容。");
    const doc = await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    if (typeof sel.SetRange !== "function") throw new Error("当前 Selection 不支持 SetRange。");

    // 建立 editable 索引 → block 的映射（AI sourceIndex 引用的是 editable 数组）
    const blockByEditIdx = new Map();
    blocks.forEach((b, i) => {
      const src = Number.isInteger(b?.sourceIndex) ? b.sourceIndex : i;
      if (!blockByEditIdx.has(src)) blockByEditIdx.set(src, b);
    });

    // 走一遍 segments，给 kind=paragraph 的分配 editIdx
    let editIdx = 0;
    const plan = [];
    for (const seg of segments) {
      if (seg.kind === "paragraph") {
        const block = blockByEditIdx.get(editIdx);
        plan.push({ seg, block });
        editIdx += 1;
      }
      // 表格 / 图片 / 空段 / other 一律 skip（不加入 plan → 不会被 touch）
    }

    // 关键改造：不再用 sel.Delete + TypeText。改用 doc.Range(start, end-1).Text = newText。
    //   - Range.Text setter 是 Word/WPS 官方"替换 range 内容"的写法，preserves paragraph
    //     structure（不影响 ¶）
    //   - 之前 sel.SetRange + sel.End -= 1 + Delete + TypeText 的组合，用户反馈"替换后
    //     只剩前 16 个字符"——推测 sel.End -= 1 在某些 WPS 版本上把 End 拉到 Start 之前
    //     或 selection 内部状态错乱，导致 TypeText 只写了一部分就退出
    //   - 用 Range 完全绕过 Selection，稳定得多。段落 style 用 paragraph.Style 直接设
    //
    // 反向替换 —— 后面变了不影响前面的 Range
    fmtLog("replace-plan", {
      totalPlan: plan.length,
      hasBlock: plan.filter((p) => p.block).length,
      totalSegments: segments.length,
      firstFewPlan: plan.slice(0, 5).map((p) => ({
        segStart: p.seg.start,
        segEnd: p.seg.end,
        segTextLen: p.seg.text?.length || 0,
        blockType: p.block?.type,
        blockLevel: p.block?.level,
        blockTextLen: p.block?.text?.length || 0,
        blockTextPreview: (p.block?.text || "").slice(0, 40)
      }))
    });
    let replaced = 0, skipped = 0;
    for (let i = plan.length - 1; i >= 0; i -= 1) {
      const { seg, block } = plan[i];
      if (!block) { skipped += 1; continue; }
      const type = String(block.type || "paragraph").toLowerCase();
      if (type === "spacer") { skipped += 1; continue; } // spacer 在原地保留即可

      try {
        const rawText = String(block.text || "").replace(/\s+$/g, "");
        // 换行归一化 —— Word/WPS 里 \r 才是段落标记。之前把 \n 转成 \r 会造成一段
        // 拆成多段，反过来影响后续 segment 的 Range 位置。这里改成把所有换行都变成空格，
        // 因为一个段落里理论上不应该有换行（AI 出的 block.text 一段一条）
        const cleanText = rawText.replace(/[\r\n\v]+/g, " ").trim();
        // 用 Range 替换文本 —— 范围收缩到 ¶ 之前（seg.end - 1）
        const targetEnd = Math.max(seg.start, seg.end - 1);
        const range = typeof doc.Range === "function" ? doc.Range(seg.start, targetEnd) : null;
        if (!range) throw new Error("doc.Range 不可用");
        // 关键：Range.Text 是 setter，写入后 range 会自动扩展到新内容末尾
        range.Text = cleanText;
        // 段落级样式：拿到这段所属的 paragraph 对象直接设 style
        try {
          const para = range.Paragraphs?.Item?.(1) || null;
          if (para) {
            let style = STYLE_IDS.normal;
            if (type === "title") style = STYLE_IDS.title;
            else if (type === "subtitle") style = STYLE_IDS.subtitle;
            else if (type === "heading") {
              const n = Math.max(1, Math.min(4, Number(block.level || 1)));
              style = STYLE_IDS[`heading${n}`] || STYLE_IDS.heading1;
            } else if (type === "quote") style = STYLE_IDS.quote;
            else if (type === "bullet") style = STYLE_IDS.bullet;
            else if (type === "numbered") style = STYLE_IDS.numbered;
            safeSet(para, "Style", style);
            // 字体
            try {
              const font = para.Range?.Font;
              if (font) {
                if (type === "title") { safeSet(font, "Bold", true); safeSet(font, "Size", 18); }
                else if (type === "subtitle") { safeSet(font, "Bold", false); safeSet(font, "Size", 12); }
                else if (type === "heading") {
                  const n = Math.max(1, Math.min(4, Number(block.level || 1)));
                  safeSet(font, "Bold", true);
                  safeSet(font, "Size", n <= 1 ? 16 : (n === 2 ? 14 : 12));
                } else if (type === "quote") { safeSet(font, "Bold", false); safeSet(font, "Italic", true); safeSet(font, "Size", 10.5); }
                else { safeSet(font, "Bold", false); safeSet(font, "Italic", false); safeSet(font, "Size", 10.5); }
              }
            } catch (fontErr) {}
            // 列表
            if (type === "bullet") {
              try { para.Range?.ListFormat?.ApplyBulletDefault?.(); } catch (e) {}
            } else if (type === "numbered") {
              try { para.Range?.ListFormat?.ApplyNumberDefault?.(); } catch (e) {}
            } else {
              // 非列表段落，如果之前是列表的要把 list 撸掉。但只针对当前段，不影响别的
              try { para.Range?.ListFormat?.RemoveNumbers?.(); } catch (e) {}
            }
            if ((type === "bullet" || type === "numbered") && Number(block.level) > 1) {
              try {
                const pf = para.Format || para.ParagraphFormat;
                if (pf) safeSet(pf, "LeftIndent", 14 * Math.min(Number(block.level) - 1, 5));
              } catch (e) {}
            }
          }
        } catch (styleErr) {
          fmtLog("replace-style-err", { idx: seg.idx, error: styleErr?.message || String(styleErr) });
        }
        replaced += 1;
        if (i >= plan.length - 3 || i < 3) {
          // 前 3 段 + 后 3 段留个明细，方便对着看
          fmtLog("replace-step", { i, idx: seg.idx, type, textLen: cleanText.length, textPreview: cleanText.slice(0, 40), segStart: seg.start, segEnd: seg.end });
        }
      } catch (e) {
        fmtLog("replace-step-err", { i, idx: seg.idx, error: e?.message || String(e) });
        skipped += 1;
      }
    }
    fmtLog("replace-done", { replaced, skipped, preserved: segments.length - plan.length });
    return { replaced, skipped, preserved: segments.length - plan.length };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function blocksToHtml(blocks) {
    const parts = [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8">',
      "<style>",
      "@page{margin:72pt 72pt 72pt 72pt;}",
      "body{font-family:SimSun,'Songti SC',serif;font-size:10.5pt;color:#111;}",
      "p.MsoNormal{margin:0 0 6pt 0;text-indent:21pt;mso-char-indent-count:2.0;line-height:175%;mso-line-height-rule:exactly;}",
      "p.LingxiSubtitle{margin:0 0 12pt 0;text-align:center;text-indent:0;font-size:12pt;color:#4b5563;line-height:150%;}",
      "p.LingxiQuote{margin:8pt 0 8pt 0;padding-left:12pt;border-left:3pt solid #1a6dff;color:#374151;font-style:italic;text-indent:0;line-height:165%;}",
      "h1{margin:0 0 16pt 0;text-align:center;font-size:18pt;font-weight:bold;line-height:135%;}",
      "h2{margin:14pt 0 6pt 0;font-size:16pt;font-weight:bold;line-height:145%;}",
      "h3{margin:14pt 0 6pt 0;font-size:14pt;font-weight:bold;line-height:145%;}",
      "h4{margin:14pt 0 6pt 0;font-size:12pt;font-weight:bold;line-height:145%;}",
      "ul,ol{margin:6pt 0 8pt 24pt;padding-left:18pt;line-height:165%;}",
      "li{margin:0 0 3pt 0;}",
      "</style>",
      "</head>",
      "<body>"
    ];
    let listTag = "";
    const closeList = () => {
      if (listTag) {
        parts.push(`</${listTag}>`);
        listTag = "";
      }
    };
    const listStyle = 'margin:6pt 0 8pt 24pt;padding-left:18pt;line-height:1.65;';
    blocks.forEach((block) => {
      const type = String(block?.type || "paragraph").toLowerCase();
      const text = escapeHtml(block?.text || "");
      if (type === "spacer") {
        closeList();
        parts.push('<p class="MsoNormal" style="text-indent:0;mso-char-indent-count:0;">&nbsp;</p>');
        return;
      }
      if (type === "bullet" || type === "numbered") {
        const tag = type === "numbered" ? "ol" : "ul";
        if (listTag !== tag) {
          closeList();
          parts.push(`<${tag} style="${listStyle}">`);
          listTag = tag;
        }
        parts.push(`<li style="margin:0 0 3pt 0;">${text}</li>`);
        return;
      }
      closeList();
      if (type === "title") {
        parts.push(`<h1 style="margin:0 0 16pt 0;text-align:center;font-size:18pt;font-weight:bold;line-height:1.35;">${text}</h1>`);
      } else if (type === "subtitle") {
        parts.push(`<p class="LingxiSubtitle" style="margin:0 0 12pt 0;text-align:center;font-size:12pt;color:#4b5563;text-indent:0;mso-char-indent-count:0;line-height:150%;">${text}</p>`);
      } else if (type === "heading") {
        const level = Math.max(1, Math.min(4, Number(block?.level || 2)));
        const size = level <= 1 ? 16 : (level === 2 ? 14 : 12);
        parts.push(`<h${Math.min(level + 1, 4)} style="margin:14pt 0 6pt 0;font-size:${size}pt;font-weight:bold;line-height:1.45;">${text}</h${Math.min(level + 1, 4)}>`);
      } else if (type === "quote") {
        parts.push(`<p class="LingxiQuote" style="margin:8pt 0 8pt 0;padding-left:12pt;border-left:3pt solid #1a6dff;color:#374151;font-style:italic;text-indent:0;mso-char-indent-count:0;line-height:165%;">${text}</p>`);
      } else {
        parts.push(`<p class="MsoNormal" style="margin:0 0 6pt 0;text-indent:21pt;mso-char-indent-count:2.0;line-height:175%;mso-line-height-rule:exactly;">${text}</p>`);
      }
    });
    closeList();
    parts.push("</body>", "</html>");
    return parts.join("");
  }

  async function replaceDocumentBlocksHtml(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("没有可替换的排版内容。");
    }
    await ensureDocument();
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");
    const html = blocksToHtml(blocks);
    const resp = await fetch(HTML_FILE_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html })
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.htmlPath) {
      throw new Error(payload.error || `html-file ${resp.status}`);
    }
    if (typeof sel.WholeStory !== "function") throw new Error("当前 Selection 不支持全文选择。");
    sel.WholeStory();
    try { sel.Delete(); } catch (e) {
      try { sel.Text = ""; } catch (e2) {}
    }
    const range = typeof sel.Range === "function" ? await sel.Range() : sel.Range;
    if (!range?.InsertFile) throw new Error("Range.InsertFile 不可用");
    range.InsertFile(payload.htmlPath);
    return { replaced: blocks.length, htmlPath: payload.htmlPath };
  }

  function looksLikeMarkdown(text) {
    if (typeof text !== "string") return false;
    return /(^|\n)\s*(#{1,6} |[-*+] |\d+\. |> |```)/.test(text)
      || /\*\*[^\n*]+\*\*/.test(text)
      || /(^|[^*])\*[^\n*]+\*([^*]|$)/.test(text)
      || /`[^`\n]+`/.test(text);
  }

  async function insertText(text, options = {}) {
    if (!text) throw new Error("没有可插入的文本。");
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前光标位置。");

    const format = options.format || (looksLikeMarkdown(text) ? "markdown" : "plain");
    if (format === "markdown" && global.WpsAiMarkdownToWord) {
      global.WpsAiMarkdownToWord.writeMarkdown(sel, text, { replace: false });
      return;
    }
    // 同 replaceSelectionText：plain 路径 \n 必须转成 \r 才会变成 Word 段落标记
    const textForWord = normalizeNewlinesForWord(text);
    if (typeof sel.TypeText === "function") return sel.TypeText(textForWord);
    if (typeof sel.InsertAfter === "function") return sel.InsertAfter(textForWord);
    throw new Error("当前 Selection 对象不支持插入文本。");
  }

  // WPS/Word 的 Range.Text / Selection.Text 把段落标记编码成 \r (CR, char 13)，**不是** \n。
  // 直接赋值 "line1\nline2" 会被当成一行带个 line-feed 占位符，看起来就是"换行消失"。
  // 这里把 AI 输出里的 \r\n / \n 全部规一成 \r，让每个换行实实在在变成一个段落标记。
  // 同时把 \v (vertical tab, char 11) 保留——VBA 里这是 Shift+Enter 的"软回车"，AI 一般不会输出但保留以防。
  function normalizeNewlinesForWord(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\r")
      .replace(/\n/g, "\r")
      .replace(/\u2028/g, "\r")
      .replace(/\u2029/g, "\r");
  }

  // ---- 字符/段落格式 capture & restore ----
  // wdUndefined = 9999999：Word/WPS 在范围内格式不一致时（例如选区内一部分粗体一部分不粗）
  // 返回的"未定义"哨兵值。捕获时把它当成 null，恢复时也跳过——避免把"混合"误写成"统一"。
  const WD_UNDEFINED = 9999999;

  // 一次性可读字段；漏读 / 异常都按 null 处理
  const FONT_KEYS = [
    "Name", "NameFarEast", "NameAscii", "NameOther",
    "Size",
    "Bold", "Italic",
    "Underline", "UnderlineColor",
    "Color", "ColorIndex",
    "StrikeThrough", "DoubleStrikeThrough",
    "Subscript", "Superscript",
    "SmallCaps", "AllCaps", "Hidden",
    "Spacing", "Scaling", "Position", "Kerning"
  ];
  const PARA_KEYS = [
    "Alignment",
    "LineSpacing", "LineSpacingRule",
    "SpaceBefore", "SpaceAfter",
    "FirstLineIndent", "LeftIndent", "RightIndent",
    "CharacterUnitLeftIndent", "CharacterUnitFirstLineIndent", "CharacterUnitRightIndent",
    "KeepWithNext", "KeepTogether"
  ];

  function safeReadProp(obj, key) {
    try {
      const v = obj?.[key];
      if (typeof v === "function") return null;
      return v == null ? null : v;
    } catch (e) {
      return null;
    }
  }
  function safeWriteProp(obj, key, value) {
    if (value == null) return;
    if (value === WD_UNDEFINED) return; // 跳过混合态
    try { obj[key] = value; } catch (e) {}
  }
  function captureFontSnap(range) {
    const f = range?.Font;
    if (!f) return null;
    const snap = {};
    FONT_KEYS.forEach((k) => { snap[k] = safeReadProp(f, k); });
    return snap;
  }
  function captureParaSnap(range) {
    const p = range?.ParagraphFormat;
    if (!p) return null;
    const snap = {};
    PARA_KEYS.forEach((k) => { snap[k] = safeReadProp(p, k); });
    return snap;
  }
  function applyFontSnap(range, snap) {
    if (!snap) return;
    const f = range?.Font;
    if (!f) return;
    FONT_KEYS.forEach((k) => safeWriteProp(f, k, snap[k]));
  }
  function applyParaSnap(range, snap) {
    if (!snap) return;
    const p = range?.ParagraphFormat;
    if (!p) return;
    PARA_KEYS.forEach((k) => safeWriteProp(p, k, snap[k]));
  }
  function captureStyle(range) {
    try { return range?.Style; } catch (e) { return null; }
  }
  function applyStyle(range, style) {
    if (style == null) return;
    try { range.Style = style; } catch (e) {}
  }

  // 把"plain 文本带换行"写入到 Selection 的核心逻辑：
  // 1. 先 Delete 把选中内容清掉，光标自动 collapse 到原起点
  // 2. 按 \n/\r/\r\n/U+2028/U+2029 切段，每段之间用 sel.TypeParagraph() 创建真段落（最可靠）
  // 3. 段内用 sel.TypeText() 写文本——TypeText 在光标处写入，自然继承原位置的字体格式
  // 这条路径避开了 "Range.Text = '...\r...' 在某些 WPS 版本下不会被识别成段落标记" 的坑。
  // 选区/Range 末端如果包含段落标记（用户三击选中整段、或 readSelectionSnapshot 抓到的范围
  // 越到了下一段开头），sel.Delete() 会把当前段和下一段合并 —— 合并后**新段的段落标记**沿用
  // 下一段（很常见是大标题段）的，于是光标 collapse 进去后所在段的字体/段落上下文也变成了大
  // 标题的，TypeText 写新内容就跟着用大标题的字号了。
  // 解法：删除前把选区/Range 收一格，让段落标记留在原段，Delete 只清正文文字，不破坏段落结构。
  function trimTrailingParagraphMark(sel) {
    try {
      const text = String(sel?.Text || "");
      if (!text) return;
      const last = text.charCodeAt(text.length - 1);
      // wdCR=13 / wdLF=10 / U+2029（很少见，paragraph separator）
      if (last !== 13 && last !== 10 && last !== 0x2029) return;
      // 优先用 MoveEnd（语义最贴）；不支持就直接动 End 属性
      if (typeof sel.MoveEnd === "function") {
        try { sel.MoveEnd(1, -1); return; } catch (e) {} // wdCharacter = 1
      }
      try { sel.End = sel.End - 1; } catch (e) {}
    } catch (e) {}
  }

  function trimTrailingParagraphMarkOnRange(range) {
    try {
      const text = String(range?.Text || "");
      if (!text) return;
      const last = text.charCodeAt(text.length - 1);
      if (last !== 13 && last !== 10 && last !== 0x2029) return;
      try { range.End = range.End - 1; } catch (e) {}
    } catch (e) {}
  }

  function insertParagraphBreak(sel) {
    try {
      if (typeof sel.TypeParagraph === "function") { sel.TypeParagraph(); return true; }
    } catch (e) {}
    try {
      const r = sel.Range;
      if (r && typeof r.InsertParagraphAfter === "function") {
        try { r.Collapse?.(0); } catch (e) {}
        r.InsertParagraphAfter();
        try { r.Collapse?.(0); } catch (e) {}
        try { r.Select?.(); } catch (e) {}
        return true;
      }
    } catch (e) {}
    try {
      if (typeof sel.TypeText === "function") { sel.TypeText("\r"); return true; }
    } catch (e) {}
    return false;
  }

  function typeWithExplicitParagraphs(sel, text) {
    // \u4e3b\u7b56\u7565\uff1a\u628a\u6240\u6709\u6362\u884c\u89c4\u4e00\u6210 \r\uff08CR\uff09\uff0c\u5355\u6b21 sel.TypeText() \u5199\u5165\u3002
    // Word/WPS \u7684 Selection.TypeText() \u628a \r \u5f53\u4f5c vbCr\uff0c\u76f4\u63a5\u751f\u6210\u6bb5\u843d\u6807\u8bb0\u2014\u2014\u8fd9\u662f VBA \u91cc\u901a\u7528\u505a\u6cd5\uff0c
    // \u6bd4"\u6309\u884c\u5faa\u73af + TypeParagraph"\u5728 WPS \u5404\u7248\u672c\u4e0b\u90fd\u66f4\u7a33\u3002
    const normalized = normalizeNewlinesForWord(text);
    if (!normalized) return;
    try {
      if (typeof sel.TypeText === "function") { sel.TypeText(normalized); return; }
    } catch (e) {}
    // Fallback\uff1aTypeText \u4e0d\u53ef\u7528\uff0c\u6309\u884c\u5faa\u73af + \u4e09\u5c42\u6362\u884c\u515c\u5e95\uff08TypeParagraph / InsertParagraphAfter / TypeText("\r")\uff09
    const lines = String(text || "").split(/\r\n|\r|\n|\u2028|\u2029/);
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) insertParagraphBreak(sel);
      const line = lines[i];
      if (!line) continue;
      try { sel.InsertAfter?.(line); } catch (e) {}
    }
  }

  // 替换后把原选区的 list 格式重 apply 到所有新段落上（不然 range.Text = "多段\r"
  // 只保留首段的 list，后续段落全变成普通段）。
  function reapplyListFormatToNewParagraphs(doc, start, textLen, listFormat) {
    if (!listFormat || !listFormat.kind || textLen <= 0) return;
    try {
      const newRange = doc.Range(start, start + textLen);
      const paras = newRange.Paragraphs;
      const cnt = Number(paras?.Count) || 0;
      for (let i = 1; i <= cnt; i += 1) {
        try {
          const p = paras.Item(i);
          const lf = p?.Range?.ListFormat;
          if (!lf) continue;
          if (listFormat.kind === "bullet") {
            if (typeof lf.ApplyBulletDefault === "function") lf.ApplyBulletDefault();
          } else if (listFormat.kind === "numbered") {
            if (typeof lf.ApplyNumberDefault === "function") lf.ApplyNumberDefault();
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  async function replaceSelectionText(text, options = {}) {
    if (!text) throw new Error("没有可替换的文本。");
    const sel = await getSelection();
    if (!sel) throw new Error("未获取到当前选区。");

    const format = options.format || (looksLikeMarkdown(text) ? "markdown" : "plain");
    if (format === "markdown" && global.WpsAiMarkdownToWord) {
      global.WpsAiMarkdownToWord.writeMarkdown(sel, text, { replace: true });
      return;
    }

    // 主路径：doc.Range(start, end).Text = normalized。跟 replaceParagraphsInPlace 同一套
    // Range-based 原子替换，绕开 Selection 状态在部分 WPS 版本上不稳的坑（现象：sel.End -= 1
    // + Delete + TypeText 组合会导致文本只写入前 N 个字符）。
    // 段落尾部 ¶ 用 sel.Text 尾字符判断后从 range end 减 1 剔掉，避免和下一段合并。
    try {
      const doc = await ensureDocument();
      let start = 0, end = 0;
      try { start = Number(sel.Start) || 0; } catch (e) {}
      try { end = Number(sel.End) || 0; } catch (e) {}
      if (end > start) {
        try {
          const selText = String(sel.Text || "");
          if (selText) {
            const last = selText.charCodeAt(selText.length - 1);
            if (last === 13 || last === 10 || last === 0x2029) end = Math.max(start, end - 1);
          }
        } catch (e) {}
        if (typeof doc.Range === "function") {
          const range = doc.Range(start, end);
          if (range) {
            // 关键：**在写入前**探测原 list 格式（sel 或 caller 传的都可能有）；写完后重 apply
            // 到所有新段落上。不然 range.Text = "多段\r" 后续段全是普通段没 bullet。
            const listFormat = options.listFormat || detectListFormat(range);
            const normalized = normalizeNewlinesForWord(text);
            range.Text = normalized;
            reapplyListFormatToNewParagraphs(doc, start, normalized.length, listFormat);
            return;
          }
        }
      }
    } catch (e) {
      // Range 路径失败 → 兜底走老 Selection 路径
    }

    // 兜底：老 Selection 路径（trimTrailingParagraphMark + Delete + typeWithExplicitParagraphs）
    trimTrailingParagraphMark(sel);
    try { sel.Delete?.(); } catch (e) {
      try { if ("Text" in sel) sel.Text = ""; } catch (e2) {}
    }
    typeWithExplicitParagraphs(sel, text);
  }

  async function replaceRangeText(rangeInfo, text, options = {}) {
    if (!text) throw new Error("没有可替换的文本。");
    const doc = await ensureDocument();
    const start = Number(rangeInfo?.start);
    const end = Number(rangeInfo?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return replaceSelectionText(text, options);
    }
    let range = null;
    try {
      if (typeof doc.Range === "function") range = doc.Range(start, end);
    } catch (e) {}
    if (!range) return replaceSelectionText(text, options);
    const format = options.format || (looksLikeMarkdown(text) ? "markdown" : "plain");

    // 主路径：直接 Range.Text = normalized。跟 replaceParagraphsInPlace / replaceSelectionText
    // 走同一套 Range-based 原子替换。段落尾部 ¶ 从 range 尾字符判断后裁掉。
    if (format !== "markdown" || !global.WpsAiMarkdownToWord) {
      try {
        // 写入前抓 list 格式，写完后重 apply（同 replaceSelectionText 逻辑）
        const listFormat = options.listFormat || detectListFormat(range);
        trimTrailingParagraphMarkOnRange(range);
        const rangeStart = Number(range.Start) || 0;
        if ("Text" in range) {
          const normalized = normalizeNewlinesForWord(text);
          range.Text = normalized;
          reapplyListFormatToNewParagraphs(doc, rangeStart, normalized.length, listFormat);
          return;
        }
      } catch (e) {
        // Range 路径失败 → 兜底走 Selection
      }
    }

    // Markdown 路径 / Range.Text 兜底：走 Selection
    try { range.Select?.(); } catch (e) {}
    const sel = await getSelection();
    if (format === "markdown" && global.WpsAiMarkdownToWord && sel) {
      global.WpsAiMarkdownToWord.writeMarkdown(sel, text, { replace: true });
      return;
    }
    if (sel) {
      trimTrailingParagraphMark(sel);
      try { sel.Delete?.(); } catch (e) {
        try { if ("Text" in sel) sel.Text = ""; } catch (e2) {}
      }
      typeWithExplicitParagraphs(sel, text);
    } else {
      throw new Error("当前 Range 对象不支持替换文本。");
    }
  }

  async function readByScope(scope) {
    if (scope === "selection") return readSelectionText();
    return readDocumentText();
  }

  function getScopeOptions() {
    return [
      { value: "selection", label: "当前选区" },
      { value: "document", label: "全文" }
    ];
  }

  global.WpsAiHostWriter = {
    host: "wps",
    label: "WPS 文字",
    readSelectionText,
    readSelectionSnapshot,
    readDocumentText,
    readDocumentStructure,       // 表格 / 图片保留用：结构化读取，AI 只处理 paragraph
    readByScope,
    insertText,
    replaceSelectionText,
    replaceRangeText,
    replaceDocumentBlocks,
    replaceDocumentBlocksHtml,
    replaceParagraphsInPlace,    // 表格 / 图片保留用：分段范围替换，跳过非段落
    getScopeOptions,
    looksLikeMarkdown
  };
})(window);
