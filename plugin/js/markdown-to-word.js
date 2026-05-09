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

      // unordered list item
      const ul = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (ul) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "ul", text: ul[1] });
        continue;
      }

      // ordered list item
      const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (ol) {
        flushParagraph(paraBuf); paraBuf = [];
        blocks.push({ type: "ol", text: ol[1] });
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
          writeRuns(selection, tokenizeInline(block.text));
          newParagraph(selection);
          break;

        case "ol":
          applyStyle(selection, STYLE.ListNumber);
          try { selection.Range.ListFormat?.ApplyNumberDefault?.(); } catch (e) {
            writeRuns(selection, [{ text: "1. ", bold: false, italic: false, code: false }]);
          }
          writeRuns(selection, tokenizeInline(block.text));
          newParagraph(selection);
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
