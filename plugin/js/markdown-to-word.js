(function attachMarkdownToWord(global) {
  "use strict";

  // wdBuiltinStyle 枚举（Word/WPS 通用，传整数比 locale-dependent 名称稳）
  const STYLE = {
    Normal: -1,
    Heading1: -2,
    Heading2: -3,
    Heading3: -4,
    ListBullet: -19,
    ListNumber: -29,
    Code: -1, // 代码块仍用 Normal，但切等宽字体
    Quote: -1
  };

  /**
   * 把整段 markdown 切成块（heading / paragraph / list-item / hr / code-fence）。
   * 仅处理常用子集，链接/表格/图片不展开（链接保留 URL，表格/图片按段落原样写入）。
   */
  // 计算列表行的缩进层级（0=顶层，每 2 空格或 1 tab 升一层）
  function listLevel(leadingWs) {
    let level = 0;
    for (let i = 0; i < leadingWs.length; i += 1) {
      if (leadingWs[i] === "\t") level += 1;
      else if (leadingWs[i] === " ") {
        // 累计两个空格升一层
        let j = i;
        while (j < leadingWs.length && leadingWs[j] === " " && j - i < 2) j += 1;
        if (j - i === 2) { level += 1; i = j - 1; }
      }
    }
    return Math.min(level, 5);
  }

  // 把一行 | a | b | c | 切成 ["a", "b", "c"]，trim 每个 cell
  function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function tokenizeBlocks(md) {
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let inFence = false;
    let fenceBuf = [];
    let fenceLang = "";

    const flushParagraph = (buf) => {
      if (buf.length === 0) return;
      blocks.push({ type: "paragraph", text: buf.join(" ").trim() });
    };

    let paraBuf = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // fenced code block
      if (/^\s*```/.test(line)) {
        if (!inFence) {
          flushParagraph(paraBuf); paraBuf = [];
          inFence = true;
          fenceLang = line.replace(/^\s*```/, "").trim();
          fenceBuf = [];
        } else {
          inFence = false;
          blocks.push({ type: "code", text: fenceBuf.join("\n"), lang: fenceLang });
          fenceBuf = [];
          fenceLang = "";
        }
        continue;
      }
      if (inFence) {
        fenceBuf.push(line);
        continue;
      }

      // empty line ends paragraph
      if (/^\s*$/.test(line)) {
        flushParagraph(paraBuf); paraBuf = [];
        continue;
      }

      // ATX heading
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        flushParagraph(paraBuf); paraBuf = [];
        const level = Math.min(heading[1].length, 3);
        blocks.push({ type: "heading", level, text: heading[2] });
        continue;
      }

      // horizontal rule
      if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && /^[\s\-*_]+$/.test(line)) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "hr" });
        continue;
      }

      // markdown table:
      //   | h1 | h2 |
      //   | --- | --- |
      //   | a  | b  |
      // 必须头部行 + 分隔行 + 至少一条数据行
      if (/^\s*\|.+\|\s*$/.test(line)) {
        const sepLine = lines[i + 1];
        if (sepLine && /^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|\s*$/.test(sepLine)) {
          flushParagraph(paraBuf); paraBuf = [];
          const headers = splitTableRow(line);
          const rows = [];
          let j = i + 2;
          while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) {
            rows.push(splitTableRow(lines[j]));
            j += 1;
          }
          blocks.push({ type: "table", headers, rows });
          i = j - 1;
          continue;
        }
      }

      // unordered list item (带 level)
      const ul = /^(\s*)[-*+]\s+(.+)$/.exec(line);
      if (ul) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "ul", text: ul[2], level: listLevel(ul[1]) });
        continue;
      }

      // ordered list item (带 level)
      const ol = /^(\s*)\d+\.\s+(.+)$/.exec(line);
      if (ol) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "ol", text: ol[2], level: listLevel(ol[1]) });
        continue;
      }

      // blockquote
      const bq = /^\s*>\s?(.*)$/.exec(line);
      if (bq) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "quote", text: bq[1] });
        continue;
      }

      // paragraph line — accumulate until blank
      paraBuf.push(line);
    }

    if (inFence) {
      blocks.push({ type: "code", text: fenceBuf.join("\n"), lang: fenceLang });
    }
    flushParagraph(paraBuf);

    return blocks;
  }

  /**
   * 把一段 markdown 内联文本切成 run 数组：[{ text, bold, italic, code }]
   * 处理：**粗体** *斜体* `代码` ***粗斜*** [文字](url)
   */
  function tokenizeInline(text) {
    const runs = [];
    let i = 0;
    let buf = "";
    let bold = false;
    let italic = false;
    const flush = () => {
      if (buf) {
        runs.push({ text: buf, bold, italic, code: false });
        buf = "";
      }
    };

    while (i < text.length) {
      const ch = text[i];
      const next2 = text.slice(i, i + 2);
      const next3 = text.slice(i, i + 3);

      // 反斜杠转义
      if (ch === "\\" && i + 1 < text.length) {
        buf += text[i + 1];
        i += 2;
        continue;
      }

      // ***bold italic***
      if (next3 === "***") {
        flush();
        const close = text.indexOf("***", i + 3);
        if (close === -1) { buf += "***"; i += 3; continue; }
        runs.push({ text: text.slice(i + 3, close), bold: true, italic: true, code: false });
        i = close + 3;
        continue;
      }

      // **bold**
      if (next2 === "**") {
        flush();
        const close = text.indexOf("**", i + 2);
        if (close === -1) { buf += "**"; i += 2; continue; }
        runs.push({ text: text.slice(i + 2, close), bold: true, italic, code: false });
        i = close + 2;
        continue;
      }

      // __bold__
      if (next2 === "__") {
        flush();
        const close = text.indexOf("__", i + 2);
        if (close === -1) { buf += "__"; i += 2; continue; }
        runs.push({ text: text.slice(i + 2, close), bold: true, italic, code: false });
        i = close + 2;
        continue;
      }

      // *italic*
      if (ch === "*") {
        flush();
        const close = text.indexOf("*", i + 1);
        if (close === -1) { buf += "*"; i += 1; continue; }
        runs.push({ text: text.slice(i + 1, close), bold, italic: true, code: false });
        i = close + 1;
        continue;
      }

      // _italic_  （仅在词边界，避免误吞 file_name）
      if (ch === "_" && (i === 0 || /\s/.test(text[i - 1]))) {
        const close = text.indexOf("_", i + 1);
        if (close > i + 1 && (close + 1 === text.length || /\s|[.,，。！？!?;:、)]/.test(text[close + 1]))) {
          flush();
          runs.push({ text: text.slice(i + 1, close), bold, italic: true, code: false });
          i = close + 1;
          continue;
        }
      }

      // `inline code`
      if (ch === "`") {
        flush();
        const close = text.indexOf("`", i + 1);
        if (close === -1) { buf += "`"; i += 1; continue; }
        runs.push({ text: text.slice(i + 1, close), bold: false, italic: false, code: true });
        i = close + 1;
        continue;
      }

      // [text](url) → 仅写文字 + 后接 (url)（保持简单，不创建超链接对象）
      if (ch === "[") {
        const closeBracket = text.indexOf("]", i + 1);
        if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
          const closeParen = text.indexOf(")", closeBracket + 2);
          if (closeParen !== -1) {
            const linkText = text.slice(i + 1, closeBracket);
            const url = text.slice(closeBracket + 2, closeParen);
            flush();
            runs.push({ text: linkText, bold, italic, code: false });
            runs.push({ text: ` (${url})`, bold, italic, code: false });
            i = closeParen + 1;
            continue;
          }
        }
      }

      buf += ch;
      i += 1;
    }

    flush();
    return runs;
  }

  // 安全设置某属性，COM 对象偶发 readonly / 不支持时不报错
  function safeSet(obj, prop, value) {
    try { obj[prop] = value; } catch (error) { /* ignore */ }
  }

  function applyStyle(selection, styleId) {
    safeSet(selection, "Style", styleId);
  }

  function resetParagraph(selection) {
    applyStyle(selection, STYLE.Normal);
    try { selection.Range.ListFormat?.RemoveNumbers?.(); } catch (e) {}
    // 把段落左缩进 / 首行缩进归零，避免继承前一段（特别是从列表后切回正文）的缩进
    try {
      const pf = selection.ParagraphFormat;
      if (pf) {
        safeSet(pf, "LeftIndent", 0);
        safeSet(pf, "FirstLineIndent", 0);
        safeSet(pf, "RightIndent", 0);
      }
    } catch (e) {}
  }

  // 给当前列表段落施加嵌套缩进：每多一层 ~14pt 左缩进（约半个汉字宽）
  function applyListLevel(selection, level) {
    if (!level || level < 1) return;
    try {
      const pf = selection.ParagraphFormat;
      if (pf) safeSet(pf, "LeftIndent", 14 * level);
    } catch (e) {}
  }

  // 写一个 Word 原生表格：当前光标位置插入；表头加粗 + 浅灰底；自动适应内容
  function writeTable(selection, block) {
    const headers = block.headers || [];
    const rows = block.rows || [];
    const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
    const rowCount = 1 + rows.length;
    if (rowCount === 0 || colCount === 0) return;

    let table;
    try {
      const range = selection.Range;
      table = range.Tables.Add(range, rowCount, colCount);
    } catch (e) {
      // 兜底：把表格按制表符分隔的纯文本写入
      writeRuns(selection, [{ text: headers.join("\t"), bold: true }]);
      newParagraph(selection);
      rows.forEach((r) => {
        writeRuns(selection, [{ text: r.join("\t") }]);
        newParagraph(selection);
      });
      return;
    }

    // 基础网格样式 wdStyleTableGrid = -111
    try { table.Style = -111; } catch (e) {}
    // 列宽自适应内容 wdAutoFitContent = 1
    try { table.AutoFitBehavior(1); } catch (e) {}

    // 填表头
    for (let c = 0; c < colCount; c += 1) {
      try {
        const cell = table.Cell(1, c + 1);
        cell.Range.Text = headers[c] || "";
      } catch (e) {}
    }
    // 填数据行
    rows.forEach((row, ri) => {
      for (let c = 0; c < colCount; c += 1) {
        try {
          const cell = table.Cell(ri + 2, c + 1);
          cell.Range.Text = row[c] || "";
        } catch (e) {}
      }
    });

    // 表头加粗 + 浅色底
    try {
      const headerRow = table.Rows.Item(1);
      headerRow.Range.Font.Bold = true;
      try { headerRow.Shading.BackgroundPatternColor = 15921906; } catch (e) {} // #F2F2F2
    } catch (e) {}
    // 表格整体字号略小，更紧凑
    try { table.Range.Font.Size = 10.5; } catch (e) {}

    // 把光标移到表格后面，继续写后续块
    try {
      selection.SetRange(table.Range.End, table.Range.End);
      selection.MoveDown?.();
    } catch (e) {}
    // 在表格后插一个空段落，避免下一段被吸进表格
    try { selection.TypeParagraph(); } catch (e) {}
  }

  function writeRuns(selection, runs) {
    for (const run of runs) {
      if (!run.text) continue;
      const prevBold = selection.Font.Bold;
      const prevItalic = selection.Font.Italic;
      const prevName = selection.Font.Name;

      safeSet(selection.Font, "Bold", !!run.bold);
      safeSet(selection.Font, "Italic", !!run.italic);
      if (run.code) {
        safeSet(selection.Font, "Name", "Consolas");
      }

      try { selection.TypeText(run.text); } catch (error) {
        if (typeof selection.InsertAfter === "function") selection.InsertAfter(run.text);
      }

      // 还原内联格式
      if (run.code) safeSet(selection.Font, "Name", prevName);
      safeSet(selection.Font, "Italic", prevItalic);
      safeSet(selection.Font, "Bold", prevBold);
    }
  }

  function newParagraph(selection) {
    if (typeof selection.TypeParagraph === "function") {
      selection.TypeParagraph();
    } else {
      selection.TypeText("\n");
    }
  }

  /**
   * 把 markdown 文本写入到给定 Selection 当前位置。会在写入前清空选区文本。
   * @param {object} selection - WPS Word Application.Selection 对象
   * @param {string} markdown - 待写入的 markdown 文本
   * @param {object} options
   * @param {boolean} options.replace - 写入前先把选区当前内容删除（用于 replace 场景）
   */
  function writeMarkdown(selection, markdown, options = {}) {
    if (!selection) throw new Error("缺少 Selection 对象");
    if (!markdown) return { blocks: 0 };

    if (options.replace) {
      // 清空当前选区，光标停在原选区起点
      try { selection.Delete(); } catch (e) {
        try { selection.Text = ""; } catch (e2) {}
      }
    }

    const blocks = tokenizeBlocks(markdown);

    blocks.forEach((block, idx) => {
      switch (block.type) {
        case "heading":
          applyStyle(selection, [STYLE.Heading1, STYLE.Heading2, STYLE.Heading3][block.level - 1] || STYLE.Heading1);
          writeRuns(selection, tokenizeInline(block.text));
          newParagraph(selection);
          resetParagraph(selection);
          break;

        case "ul":
          applyStyle(selection, STYLE.ListBullet);
          try { selection.Range.ListFormat?.ApplyBulletDefault?.(); } catch (e) {
            // 退化：手动加项目符号
            writeRuns(selection, [{ text: "• ", bold: false, italic: false, code: false }]);
          }
          applyListLevel(selection, block.level || 0);
          writeRuns(selection, tokenizeInline(block.text));
          newParagraph(selection);
          break;

        case "ol":
          applyStyle(selection, STYLE.ListNumber);
          try { selection.Range.ListFormat?.ApplyNumberDefault?.(); } catch (e) {
            writeRuns(selection, [{ text: "1. ", bold: false, italic: false, code: false }]);
          }
          applyListLevel(selection, block.level || 0);
          writeRuns(selection, tokenizeInline(block.text));
          newParagraph(selection);
          break;

        case "table":
          resetParagraph(selection);
          writeTable(selection, block);
          break;

        case "code":
          // 代码块：等宽字体 + 整段直出（不解析内联）
          {
            const prevName = selection.Font.Name;
            safeSet(selection.Font, "Name", "Consolas");
            try { selection.TypeText(block.text); } catch (e) {
              if (typeof selection.InsertAfter === "function") selection.InsertAfter(block.text);
            }
            safeSet(selection.Font, "Name", prevName);
            newParagraph(selection);
            resetParagraph(selection);
          }
          break;

        case "quote":
          // 简单实现：在前面加 "│ "，保留段落格式
          writeRuns(selection, [{ text: "│ ", bold: false, italic: true, code: false }]);
          writeRuns(selection, tokenizeInline(block.text));
          newParagraph(selection);
          break;

        case "hr":
          // 用一行分隔线代替
          writeRuns(selection, [{ text: "────────────────", bold: false, italic: false, code: false }]);
          newParagraph(selection);
          break;

        case "paragraph":
        default:
          resetParagraph(selection);
          writeRuns(selection, tokenizeInline(block.text));
          // 段间留一个换行（最后一段不加，避免文末空行）
          if (idx !== blocks.length - 1) newParagraph(selection);
      }
    });

    return { blocks: blocks.length };
  }

  global.WpsAiMarkdownToWord = {
    writeMarkdown,
    tokenizeBlocks,
    tokenizeInline
  };
})(window);
