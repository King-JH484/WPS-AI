const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 加载 tools/*.js（IIFE），用捕获式 registry 收集注册的工具名，验证新增工具都在、且无加载期报错。
function loadToolNames(files) {
  const names = [];
  const ctx = { window: {}, console };
  ctx.window.window = ctx.window;
  ctx.window.WpsAiToolRegistry = { registerTool: (d) => names.push(d.name) };
  ctx.WpsAiToolRegistry = ctx.window.WpsAiToolRegistry;
  vm.createContext(ctx);
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", f), "utf8");
    vm.runInContext(code, ctx);
  }
  return names;
}

test("新增宿主工具全部注册（条件格式/数据验证/图表/批注写入/修订/导出PDF）", () => {
  const names = loadToolNames(["spreadsheet.js", "writer.js", "presentation.js", "wpp-native-tools.js"]);
  const want = [
    // 表格（第一批）
    "et_add_conditional_format", "et_add_data_validation", "et_insert_chart", "et_add_comment", "et_export_pdf",
    // 文字：修订 + 导出
    "wps_read_revisions", "wps_manage_revisions", "wps_export_pdf",
    // 演示：批注写入 + 导出
    "wpp_add_comment", "wpp_export_pdf",
    // 表格（第一二梯队）
    "et_create_table", "et_remove_duplicates", "et_text_to_columns", "et_protect_sheet", "et_define_name",
    "et_doc_properties", "et_save_as", "et_print",
    // 文字（第一二梯队）
    "wps_format_paragraph", "wps_set_header_footer", "wps_page_setup", "wps_insert_footnote", "wps_update_toc_fields",
    "wps_doc_properties", "wps_save_as", "wps_print",
    // 演示（第一二梯队）
    "wpp_add_animation", "wpp_align_shapes", "wpp_doc_properties", "wpp_save_as", "wpp_print",
    // 第三梯队
    "et_group_outline", "et_subtotal", "et_add_sparkline",
    "wps_list_styles", "wps_insert_textbox", "wps_insert_file",
    "wpp_add_section", "wpp_set_action", "wpp_add_media",
    // A 组
    "et_apply_cell_style", "et_advanced_filter", "et_set_view",
    "wps_add_caption", "wps_accept_reject_revision", "wps_add_watermark", "wps_set_view",
    "wpp_add_smartart", "wpp_set_view",
    "wpp_probe_native_capabilities", "wpp_probe_native_write_capabilities", "wpp_probe_native_chart_capabilities", "wpp_master_inspect"
  ];
  const missing = want.filter((n) => !names.includes(n));
  assert.deepEqual(missing, [], `未注册：${missing.join(", ")}`);
});

test("导出 PDF 工具被判为只读（不触发快照/改动记录）", () => {
  const ctx = { window: {}, console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "history.js"), "utf8");
  vm.runInContext(code, ctx);
  const H = ctx.window.WpsAiHistory;
  const readonly = [
    "wps_export_pdf", "et_export_pdf", "wpp_export_pdf",
    "wps_save_as", "et_save_as", "wpp_save_as",
    "wps_print", "et_print", "wpp_print",
    "wps_doc_properties", "et_doc_properties", "wpp_doc_properties",
    "wps_set_view", "et_set_view", "wpp_set_view",
    "wps_read_revisions", "wps_list_styles" // 名字含 _read_/_list_ 自动只读
  ];
  for (const n of readonly) assert.equal(H.isMutatingTool(n), false, `${n} 应为只读`);
  // 反向：真正改文档的应判为修改型
  for (const n of ["et_add_conditional_format", "wps_manage_revisions", "et_create_table", "wps_format_paragraph", "wpp_add_animation", "et_remove_duplicates"]) {
    assert.equal(H.isMutatingTool(n), true, `${n} 应为修改型`);
  }
});
