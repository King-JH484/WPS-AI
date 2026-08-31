const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function mutableCollection(items) {
  return {
    get Count() { return items.length; },
    Item(index) { return items[index - 1] || null; },
    _items: items
  };
}

function loadRuntime(presentation) {
  const window = { navigator: { platform: "MacIntel" } };
  window.window = window;
  window.WpsAiHostPresentation = { _internal: { getActivePresentation: async () => presentation } };
  const context = vm.createContext({ window, console, navigator: window.navigator, Date });
  const files = [
    ["tools", "wpp-capabilities.js"],
    ["hosts", "presentation-native-handles.js"],
    ["hosts", "presentation-native.js"]
  ];
  for (const [folder, file] of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", folder, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return window;
}

function fixture() {
  const layoutShapes = mutableCollection([]);
  layoutShapes.AddPlaceholder = function AddPlaceholder(type, left, top, width, height) {
    const shape = { Id: 500 + this._items.length, Name: "Placeholder", Left: left, Top: top, Width: width, Height: height, PlaceholderFormat: { Type: type }, Delete: () => this._items.splice(this._items.indexOf(shape), 1) };
    this._items.push(shape);
    return shape;
  };
  const layout = { Name: "Title", MatchingName: "title", Index: 1, Shapes: layoutShapes };
  const layouts = mutableCollection([layout]);
  const masterShapeItems = [];
  const masterShapes = mutableCollection(masterShapeItems);
  masterShapes.AddShape = function AddShape(_type, left, top, width, height) {
    const shape = { Id: 700 + masterShapeItems.length, Left: left, Top: top, Width: width, Height: height, TextFrame: { TextRange: { Text: "" } }, Delete: () => masterShapeItems.splice(masterShapeItems.indexOf(shape), 1) };
    masterShapeItems.push(shape);
    return shape;
  };
  const master = { Name: "Master", Shapes: masterShapes, CustomLayouts: layouts };
  const design = { Name: "D", Index: 1, SlideMaster: master };
  const slideItems = [];
  const slides = mutableCollection(slideItems);
  slides.AddSlide = function AddSlide(index, customLayout) {
    const slide = { SlideID: 100 + slideItems.length, SlideIndex: index, CustomLayout: customLayout, Shapes: mutableCollection([]), Delete: () => slideItems.splice(slideItems.indexOf(slide), 1) };
    slideItems.splice(index - 1, 0, slide);
    return slide;
  };
  return { presentation: { Name: "template-test.pptx", FullName: "/tmp/template-test.pptx", Designs: mutableCollection([design]), Slides: slides }, design, layout };
}

function markSupported(runtime, keys) {
  const capabilities = {};
  keys.forEach((key) => { capabilities[key] = { state: "supported", adapter: "wps_jsapi", reason: "test" }; });
  runtime.WpsAiWppCapabilities.recordEvidence({ platform: "darwin", capabilities, evidence: { observedAt: new Date().toISOString() } });
}

test("未验证写能力 fail closed，不以视觉近似代替", async () => {
  const { presentation, design, layout } = fixture();
  const runtime = loadRuntime(presentation);
  const handle = runtime.WpsAiWppHandles.createLayoutHandle(presentation, design, layout);
  await assert.rejects(() => runtime.WpsAiPresentationNative.addSlideFromLayout({ layoutHandle: handle }), /capability_unverified/);
});

test("通过探针证据后可按稳定 layout handle 新增原生幻灯片", async () => {
  const { presentation, design, layout } = fixture();
  const runtime = loadRuntime(presentation);
  markSupported(runtime, ["wpp.slide.add_from_layout"]);
  const handle = runtime.WpsAiWppHandles.createLayoutHandle(presentation, design, layout);
  const result = await runtime.WpsAiPresentationNative.addSlideFromLayout({ layoutHandle: handle, index: 1 });
  assert.equal(presentation.Slides.Count, 1);
  assert.equal(presentation.Slides.Item(1).CustomLayout, layout);
  assert.equal(result.slideId, 100);
});

test("占位符创建返回 shape handle，并且类型与几何参数写入原生对象", async () => {
  const { presentation, design, layout } = fixture();
  const runtime = loadRuntime(presentation);
  markSupported(runtime, ["wpp.placeholder.manage"]);
  const layoutHandle = runtime.WpsAiWppHandles.createLayoutHandle(presentation, design, layout);
  const result = await runtime.WpsAiPresentationNative.managePlaceholder({
    action: "create", layoutHandle, type: "title", left: 10, top: 20, width: 300, height: 60
  });
  assert.equal(layout.Shapes.Count, 1);
  assert.equal(layout.Shapes.Item(1).PlaceholderFormat.Type, 1);
  assert.match(result.shapeHandle, /^wpp-layout-shape:v1:/);
});

test("母版固定形状使用 master shape handle 更新，不依赖集合序号", async () => {
  const { presentation } = fixture();
  const runtime = loadRuntime(presentation);
  markSupported(runtime, ["wpp.master.update"]);
  const created = await runtime.WpsAiPresentationNative.updateMaster({
    action: "add_shape", shapeType: "rectangle", left: 1, top: 2, width: 80, height: 20, text: "Brand"
  });
  assert.match(created.shapeHandle, /^wpp-master-shape:v1:/);
  const updated = await runtime.WpsAiPresentationNative.updateMaster({ action: "update_shape", shapeHandle: created.shapeHandle, text: "Anthony AI" });
  assert.equal(updated.applied, true);
  const resolved = runtime.WpsAiWppHandles.resolveMasterShapeHandle(presentation, created.shapeHandle);
  assert.equal(resolved.shape.TextFrame.TextRange.Text, "Anthony AI");
});

test("原生模板工具公开完整领域入口，不暴露 raw_call", () => {
  const names = [];
  const window = { WpsAiToolRegistry: { registerTool: (definition) => names.push(definition.name) } };
  window.window = window;
  const context = vm.createContext({ window, console });
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "wpp-native-tools.js"), "utf8");
  vm.runInContext(source, context);
  for (const name of ["wpp_layout_manage", "wpp_placeholder_manage", "wpp_add_slide_from_layout", "wpp_theme_manage", "wpp_master_update", "wpp_template_export"]) {
    assert.ok(names.includes(name), `${name} 未注册`);
  }
  assert.ok(!names.some((name) => /raw_call/.test(name)));
});
