const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function collection(items) {
  return { get Count() { return items.length; }, Item: (index) => items[index - 1] };
}

function loadHandles() {
  const window = {};
  window.window = window;
  const context = vm.createContext({ window, console });
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", "presentation-native-handles.js"), "utf8");
  vm.runInContext(source, context, { filename: "presentation-native-handles.js" });
  return window.WpsAiWppHandles;
}

test("layout handle 在版式重排后按指纹重新解析", () => {
  const handles = loadHandles();
  const first = { Name: "Title", MatchingName: "title", Index: 1, Shapes: collection([{ Id: 11, Type: 14 }]) };
  const second = { Name: "Content", MatchingName: "content", Index: 2, Shapes: collection([{ Id: 22, Type: 14 }]) };
  const items = [first, second];
  const design = { Name: "D", Index: 1, SlideMaster: { CustomLayouts: collection(items) } };
  const presentation = { Name: "deck.pptx", FullName: "/tmp/deck.pptx", Designs: collection([design]) };
  const handle = handles.createLayoutHandle(presentation, design, second);
  items.splice(0, 2, second, first);
  const resolved = handles.resolveLayoutHandle(presentation, handle);
  assert.equal(resolved.layout, second);
});

test("handle 不能跨文档复用，目标消失时返回 stale", () => {
  const handles = loadHandles();
  const layout = { Name: "Title", MatchingName: "title", Index: 1, Shapes: collection([]) };
  const design = { Name: "D", Index: 1, SlideMaster: { CustomLayouts: collection([layout]) } };
  const source = { Name: "a.pptx", FullName: "/tmp/a.pptx", Designs: collection([design]) };
  const other = { Name: "b.pptx", FullName: "/tmp/b.pptx", Designs: collection([design]) };
  const handle = handles.createLayoutHandle(source, design, layout);
  assert.throws(() => handles.resolveLayoutHandle(other, handle), /document_mismatch/);
  design.SlideMaster.CustomLayouts = collection([]);
  assert.throws(() => handles.resolveLayoutHandle(source, handle), /stale_handle/);
});

test("shape handle 使用 SlideID + Shape.Id，不依赖页序和形状序", () => {
  const handles = loadHandles();
  const shape = { Id: 901, Name: "Chart 1" };
  const slide = { SlideID: 77, SlideIndex: 3, Shapes: collection([shape]) };
  const presentation = { Name: "deck.pptx", FullName: "/tmp/deck.pptx", Slides: collection([slide]) };
  const handle = handles.createShapeHandle(presentation, slide, shape);
  assert.equal(handles.resolveShapeHandle(presentation, handle).shape, shape);
});
