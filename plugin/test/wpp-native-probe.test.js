const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function mutableCollection(items) {
  return { get Count() { return items.length; }, Item: (index) => items[index - 1] || null, _items: items };
}

function makeDeletable(items, object) {
  object.Delete = () => { const index = items.indexOf(object); if (index >= 0) items.splice(index, 1); };
  return object;
}

function loadProbe() {
  const layoutItems = [];
  const layouts = mutableCollection(layoutItems);
  layouts.Add = function Add(index) {
    const shapeItems = [];
    const shapes = mutableCollection(shapeItems);
    shapes.AddPlaceholder = function AddPlaceholder(type) {
      const shape = makeDeletable(shapeItems, { Id: 90 + shapeItems.length, PlaceholderFormat: { Type: type } });
      shapeItems.push(shape);
      return shape;
    };
    const layout = makeDeletable(layoutItems, { Name: "Probe Layout", MatchingName: "probe", Index: index, Shapes: shapes });
    layoutItems.push(layout);
    return layout;
  };
  const masterShapeItems = [];
  const masterShapes = mutableCollection(masterShapeItems);
  masterShapes.AddShape = function AddShape() {
    const shape = makeDeletable(masterShapeItems, { Id: 44 });
    masterShapeItems.push(shape);
    return shape;
  };
  const master = { Shapes: masterShapes, CustomLayouts: layouts };
  const designs = mutableCollection([{ Name: "D", Index: 1, SlideMaster: master }]);
  const slideItems = [];
  const slides = mutableCollection(slideItems);
  slides.AddSlide = function AddSlide(index, layout) {
    const slide = makeDeletable(slideItems, { SlideID: 12, SlideIndex: index, CustomLayout: layout, Shapes: mutableCollection([]) });
    slideItems.push(slide);
    return slide;
  };
  const presentation = { Name: "native-probe-test.pptx", FullName: "/tmp/native-probe-test.pptx", Designs: designs, Slides: slides };
  const window = { navigator: { platform: "MacIntel" }, WpsAiHostPresentation: { _internal: { getActivePresentation: async () => presentation } } };
  window.window = window;
  const context = vm.createContext({ window, console, navigator: window.navigator, Date });
  for (const [folder, file] of [["tools", "wpp-capabilities.js"], ["hosts", "presentation-native-handles.js"], ["hosts", "presentation-native.js"]]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", folder, file), "utf8"), context, { filename: file });
  }
  return { window, presentation, layouts, masterShapes, slides };
}

test("受控写探针要求当前文档 identity 精确匹配", async () => {
  const { window } = loadProbe();
  await assert.rejects(
    () => window.WpsAiPresentationNative.probe({ mode: "write", sandboxConfirmed: true, expectedDocumentId: "wrong" }),
    /document_mismatch/
  );
});

test("受控写探针验证并清理版式、占位符、母版形状和按版式加页", async () => {
  const { window, presentation, layouts, masterShapes, slides } = loadProbe();
  const documentId = window.WpsAiWppHandles.documentIdentity(presentation);
  const report = await window.WpsAiPresentationNative.probe({ mode: "write", sandboxConfirmed: true, expectedDocumentId: documentId });
  for (const key of ["wpp.layout.manage", "wpp.placeholder.manage", "wpp.master.update", "wpp.slide.add_from_layout"]) {
    assert.equal(report.capabilities[key].state, "supported", key);
  }
  assert.equal(layouts.Count, 0);
  assert.equal(masterShapes.Count, 0);
  assert.equal(slides.Count, 0);
  assert.equal(report.evidence.mutated, true);
  assert.equal(report.evidence.cleanupVerified, true);
});
