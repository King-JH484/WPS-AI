(function attachQuickActions(global) {
  "use strict";

  // 三个宿主的快捷指令定义。每条带：
  //   key       — 唯一稳定标识，ribbon 上点击时通过它反查 prompt
  //   label     — 显示文字
  //   category  — 分组标识，用于 ribbon 菜单分组渲染（写作/润色/翻译/...）
  //   prefill   — true 表示需要用户在 [占位] 处补内容，taskpane 收到后会预填输入框，不自动发送
  //   prompt    — 实际指令
  const QUICK_ACTIONS = {
    wps: [
      { key: "helpWrite", label: "帮我写", category: "writing", prefill: true,
        prompt: "请帮我写一段关于 [在这里描述主题，比如：项目复盘的 300 字总结] 的内容。先用 wps_insert_text 插入到当前光标位置（用 markdown 自然成段，会渲染成 Word 原生格式）。" },
      { key: "continue", label: "续写", category: "writing",
        prompt: "请用 wps_read_document 读取整篇文档了解上下文，然后基于结尾内容续写 1-2 段，承接已有语气，用 wps_insert_text 插入到当前光标位置。" },
      { key: "expand", label: "扩写", category: "writing",
        prompt: "请用 wps_read_selection 读当前选区，把它扩写得更详细、更丰满（保持原意），然后用 wps_replace_selection 覆盖原选区。" },
      { key: "shrink", label: "缩写", category: "writing",
        prompt: "请用 wps_read_selection 读当前选区，压缩到原来的一半左右，保留核心信息，然后用 wps_replace_selection 覆盖原选区。" },
      { key: "rewrite", label: "重写", category: "writing",
        prompt: "请用 wps_read_selection 读当前选区，从不同角度/不同句式重写一遍（保持原意），然后用 wps_replace_selection 覆盖原选区。" },

      { key: "polish", label: "快速润色", category: "polish",
        prompt: "请用 wps_read_selection 读当前选区，润色让它更流畅、更专业，然后用 wps_replace_selection 替换原选区。保持原意，不要解释。" },
      { key: "polishFormal", label: "更正式", category: "polish",
        prompt: "请用 wps_read_selection 读当前选区，改写成更正式的书面语风格（去除口语词、调整句式），然后用 wps_replace_selection 替换。" },
      { key: "polishAcademic", label: "更学术", category: "polish",
        prompt: "请用 wps_read_selection 读当前选区，改写成学术论文风格（严谨、客观、用专业术语），然后用 wps_replace_selection 替换。" },
      { key: "polishGov", label: "党政风", category: "polish",
        prompt: "请用 wps_read_selection 读当前选区，改写成党政公文风格（规范用词、政策语言、四字格表达），然后用 wps_replace_selection 替换。" },
      { key: "polishLively", label: "更活泼", category: "polish",
        prompt: "请用 wps_read_selection 读当前选区，改写得更活泼生动（多用比喻、设问、贴近读者），然后用 wps_replace_selection 替换。" },
      { key: "polishCasual", label: "口语化", category: "polish",
        prompt: "请用 wps_read_selection 读当前选区，改写成自然口语化表达（像聊天一样），然后用 wps_replace_selection 替换。" },
      { key: "polishAll", label: "全文润色", category: "polish",
        prompt: "请用 wps_read_document 读整篇文档，整体润色（保持结构和原意），然后用 wps_replace_selection 写回——注意：先提示用户全选文档（Ctrl+A）再确认；如未全选则改为分段告诉我润色后的版本，由我决定是否替换。" },

      { key: "translateZh", label: "翻译为中文", category: "translate",
        prompt: "请用 wps_read_selection 读当前选区，翻译为简体中文（自然书面语），然后用 wps_replace_selection 替换。" },
      { key: "translateEn", label: "翻译为英文", category: "translate",
        prompt: "请用 wps_read_selection 读当前选区，翻译为英文（自然书面语），然后用 wps_replace_selection 替换。" },

      { key: "summary", label: "全文总结", category: "document",
        prompt: "请用 wps_read_document 读整篇文档，给我一份结构化的中文摘要（标题 + 要点列表 + 核心结论）。摘要发到对话里就好，先不要写回文档。" },
      { key: "mindmap", label: "文档脑图", category: "document",
        prompt: "请用 wps_read_document 读整篇文档，提炼成 markdown 大纲形式的脑图（一级标题、二级标题、要点）。先发到对话里给我看，问我要不要替换写回文档。" },
      { key: "format", label: "AI 排版", category: "document",
        prompt: "请用 wps_read_document 读全文，识别哪些段落应该是标题/小标题，按结构整理成 markdown（# 一级、## 二级、列表项等）。先发到对话里给我看排版效果，再问我要不要用 wps_replace_selection 全文替换（提醒我先 Ctrl+A 全选）。" },
      { key: "qa", label: "文档问答", category: "document", prefill: true,
        prompt: "请基于当前文档内容回答这个问题：[在这里写你想问的问题]" },

      { key: "image", label: "AI 生成图片", category: "image", prefill: true,
        prompt: "请生成一张关于 [描述要生成的图片内容，比如：科技感的报告封面，深蓝色背景] 的图片，先调用 generate_image 拿到 URL，再用 wps_insert_image 插入到当前光标位置。" },

      { key: "suggest", label: "智能推荐操作", category: "smart",
        prompt: "请先用 wps_read_document 读一下整篇文档（如果太长就读前 2000 字），分析它的内容类型、风格、语气、潜在问题。基于这些观察调用 suggest_quick_actions 工具给我 5-8 条针对这篇文档具体可执行的操作建议。每条 label 不超过 12 个字，prompt 要明确指定调用什么工具完成什么。完成 suggest_quick_actions 后简单说一句你看到了什么。" }
    ],

    et: [
      { key: "autofit", label: "自动调整行列宽", category: "beautify",
        prompt: "请先用 et_get_sheet_info 取到活动工作表的 UsedRange，然后调用 et_autofit 对该区域执行 dimension=both 的自适应。完成后简短告诉我处理了哪个区域。" },
      { key: "beautify", label: "表格美化样式", category: "beautify",
        prompt: "请对当前活动工作表的 UsedRange 执行表格美化：1) 用 et_autofit 自适应行列宽；2) 用 et_set_borders 给整块区域加 outline 外框（thin），再加 inside 内框（hairline）；3) 用 et_format_range 把第一行设置为加粗、白字、深蓝色背景 #2C5BAA、水平居中、垂直居中；4) 用 et_set_alignment 把数据区设置成水平居中 + 垂直居中 + 自动换行。完成后用一句话总结。" },
      { key: "centerAll", label: "全部居中对齐", category: "beautify",
        prompt: "请用 et_get_sheet_info 取到活动工作表的 UsedRange，然后调用 et_set_alignment 把整个 UsedRange 设为 h=center, v=center, wrap=true。完成后用一句话告诉我。" },

      { key: "deleteBlank", label: "删除空白行", category: "data",
        prompt: "请先用 et_get_sheet_info 找到 UsedRange，再用 et_read_range 读取 UsedRange 的全部数据。识别所有完全为空的行（每个单元格都是空字符串或 null），然后调用 et_delete_rows 按从下往上的顺序删除它们。删除完成后告诉我删了哪些行。" },
      { key: "mergeSame", label: "合并相同相邻单元格", category: "data",
        prompt: "请用 et_get_sheet_info 找到当前选区（如果没有选区就用 UsedRange 的第一列），然后用 et_read_range 读取该列数据。识别相邻、内容相同的单元格段，按段调用 et_merge_cells 合并。完成后告诉我合并了哪些段。" },

      { key: "suggest", label: "智能推荐操作", category: "smart",
        prompt: "请先用 et_get_sheet_info 看一下活动工作表的维度，再用 et_read_range 读取 UsedRange 前 20 行（如果数据少于 20 行就全部）。基于看到的数据特征（列名、值类型、是否有空行、是否有数字等），调用 suggest_quick_actions 工具给我 5-8 条针对这个表的具体可执行操作建议。每条 label 不超过 12 个字，prompt 是一句完整指令，用到的工具名要明确写出来。完成 suggest_quick_actions 后简单说一句你看到了什么。" }
    ],

    wpp: [
      { key: "genPpt", label: "AI 生成 PPT", category: "generate", prefill: true,
        prompt: "请帮我生成一份关于 [描述主题，如：2026 年第一季度复盘报告，10 页，包含封面/摘要/数据/结论] 的 PPT。流程：先用 wpp_get_presentation_info 看现状；如果是空文档/我要求重做，就为每一页调 wpp_add_slide（合理选择 layout=title/text/sectionHeader/comparison），并通过 title 和 body 字段填入内容；末尾用 wpp_set_notes 给每页加演讲者备注。完成后告诉我每页大概内容。" },
      { key: "fromOutline", label: "大纲生成 PPT", category: "generate", modal: "outline",
        prompt: "（大纲生成 PPT 走专门的弹窗输入大纲；如果你看到这个 prompt，说明 modal 没正常打开。）" },
      { key: "cover", label: "AI 生成封面", category: "generate", prefill: true,
        prompt: "请帮我做一张吸引眼球的封面：主标题 [写主标题，比如：项目 Alpha 启动会]，副标题/作者 [写副标题或留空]。先用 wpp_add_slide(afterIndex=0, layout='title') 在最前面插入一页，再调 wpp_set_title 填主标题，必要时 wpp_add_text_box 加副标题/日期。" },
      { key: "genOne", label: "AI 生成单页", category: "generate", prefill: true,
        prompt: "请在当前位置之后插入一张新幻灯片，主题是 [描述这一页的内容，比如：第二季度销售额同比增长 23%，给出关键数据和原因]。流程：wpp_add_slide(layout='text', title=..., body=...)，根据需要再 wpp_add_text_box 补充。" },
      { key: "genMany", label: "AI 生成多页", category: "generate", prefill: true,
        prompt: "请围绕主题 [描述主题] 生成 [3-5] 页幻灯片，结构层次清晰（如：概述 → 数据 → 案例 → 结论）。每一页用 wpp_add_slide(title, body) 插入，最后告诉我各页大致内容。" },
      { key: "image", label: "AI 生成图片", category: "generate", prefill: true,
        prompt: "请生成一张关于 [描述图片，如：未来感的科技城市夜景，蓝紫色调] 的图片，并插入到当前幻灯片：先调 generate_image 拿到 URL，再用 wpp_add_picture(fileName=URL, left=80, top=120, width=560) 放到合适位置。" },

      { key: "helpWrite", label: "帮我写", category: "rewrite", prefill: true,
        prompt: "请围绕 [描述主题] 帮我写一段适合放在 PPT 上的内容。如果要替换某个形状的文字，先 wpp_read_slide 找到目标形状的 index，再 wpp_replace_shape_text 写入；如果是新内容，用 wpp_add_text_box 在当前页加一个文本框。" },
      { key: "helpEdit", label: "帮我改", category: "rewrite",
        prompt: "请用 wpp_read_slide 读当前幻灯片所有形状文本，识别需要改进的地方（措辞、错别字、语气、结构），然后逐个用 wpp_replace_shape_text 改写。改完简短说一下改了什么。" },
      { key: "expand", label: "扩写", category: "rewrite", prefill: true,
        prompt: "请扩写当前幻灯片中第 [形状序号] 个形状的文字（先用 wpp_read_slide 看一下序号），把要点扩写为完整段落，再用 wpp_replace_shape_text 写回。" },
      { key: "shrink", label: "缩写", category: "rewrite", prefill: true,
        prompt: "请缩写当前幻灯片中第 [形状序号] 个形状的文字，压缩到原来一半左右、保留核心要点，用 wpp_replace_shape_text 写回。" },
      { key: "polish", label: "润色", category: "rewrite",
        prompt: "请用 wpp_read_slide 读当前幻灯片所有有文字的形状，逐个润色（保持原意，更通顺、更专业），用 wpp_replace_shape_text 写回。完成后总结一下改动。" },

      { key: "proofread", label: "AI 检查校对", category: "check",
        prompt: "请用 wpp_list_slides 看整份演示文稿，再 wpp_read_slide 逐页读文字，找出错别字、用词不当、语法错误、不一致之处。直接列出问题清单（按页码 + 形状序号 + 建议改法），不要直接改文档；改不改由我来决定。" },
      { key: "speakerNotes", label: "AI 演讲稿", category: "check",
        prompt: "请用 wpp_list_slides 看整份演示文稿，再逐页 wpp_read_slide 看每页内容，为每一页生成 1-3 句口语化的演讲稿，用 wpp_set_notes 写入到该页备注。完成后告诉我已为多少页加了备注。" },

      { key: "suggest", label: "智能推荐操作", category: "smart",
        prompt: "请先用 wpp_get_presentation_info 和 wpp_list_slides 了解当前演示文稿（页数、各页标题/版式/字数），然后调用 suggest_quick_actions 工具给我 5-8 条针对这份 PPT 具体可执行的操作建议（比如：缺封面的话提醒生成封面；某些页文字太多建议拆分；缺备注的话建议生成演讲稿等等）。每条 label ≤12 字，prompt 写明要调用哪些工具。" }
    ]
  };

  // 分组在 ribbon 菜单里展示的中文标题；顺序也决定了菜单内分组的顺序
  const CATEGORY_LABELS = {
    writing: "写作",
    polish: "润色",
    translate: "翻译",
    document: "文档",
    image: "图像",
    generate: "生成",
    rewrite: "改写",
    check: "校对",
    beautify: "美化",
    data: "数据",
    smart: "智能",
    other: "其他"
  };

  // 每个 category 在 ribbon 上使用的图标（黑白线性 SVG）
  const CATEGORY_ICON = {
    writing: "images/icons/writing.svg",
    polish: "images/icons/polish.svg",
    translate: "images/icons/translate.svg",
    document: "images/icons/document.svg",
    image: "images/icons/image.svg",
    generate: "images/icons/slides.svg",
    rewrite: "images/icons/edit.svg",
    check: "images/icons/check.svg",
    beautify: "images/icons/brush.svg",
    data: "images/icons/table.svg",
    smart: "images/icons/wand.svg",
    other: "images/ai.svg"
  };

  const CATEGORY_ORDER_BY_HOST = {
    wps: ["writing", "polish", "translate", "document", "image", "smart"],
    et:  ["beautify", "data", "smart"],
    wpp: ["generate", "rewrite", "check", "smart"]
  };

  function findByKey(host, key) {
    const list = QUICK_ACTIONS[host] || [];
    return list.find((a) => a.key === key) || null;
  }

  /**
   * 把宿主下的所有 chip 按 category 分组返回（保留 prefill 标记，
   * ribbon 点击 prefill 类时 taskpane 会预填输入框而不是自动发送）。
   * 返回：[{ category, label, actions: [{key,label,prefill}] }, ...]
   */
  function getRibbonGroups(host) {
    const list = QUICK_ACTIONS[host] || [];
    const order = CATEGORY_ORDER_BY_HOST[host] || ["other"];
    const buckets = new Map(order.map((cat) => [cat, []]));
    list.forEach((act) => {
      const cat = act.category && buckets.has(act.category) ? act.category : "other";
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(act);
    });
    const groups = [];
    buckets.forEach((actions, cat) => {
      if (!actions || actions.length === 0) return;
      groups.push({
        category: cat,
        label: CATEGORY_LABELS[cat] || cat,
        actions: actions.map((a) => ({ key: a.key, label: a.label, prefill: !!a.prefill }))
      });
    });
    return groups;
  }

  global.WpsAiQuickActions = {
    QUICK_ACTIONS,
    CATEGORY_LABELS,
    CATEGORY_ICON,
    CATEGORY_ORDER_BY_HOST,
    findByKey,
    getRibbonGroups
  };
})(window);
