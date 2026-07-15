const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadInternals() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "tools", "presentation.js"), "utf8");
  // presentation.js 顶部若 registry 缺失会 return，导致不挂 internals。给足最小桩：
  const window = {
    WpsAiToolRegistry: { registerTool() {}, toOpenAIToolSpec() {}, execute() {}, serializeResult() {} },
    WpsAiHostPresentation: { _internal: {} },
    WpsAiImageAssets: {},
    WpsAiProviderRegistry: { DESIGN_GUIDELINES: [], COLOR_SCHEMES: {}, loadSettings: () => ({}) },
    WpsAiHtmlTemplates: {},
    WpsAiHtmlCache: {},
    WpsAiHtmlPreview: {},
    WpsAiDeckStaging: {}
  };
  const sandbox = { window, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return window.WpsAiRenderDeckInternals;
}

// mock 一张 slide：Tags.Item(name) 从 map 取；SlideIndex 固定
function mkSlide(index, tags) {
  return {
    SlideIndex: index,
    Tags: { Item: (name) => (tags && tags[name]) || "" }
  };
}
function mkPres(slides) {
  return { Slides: { Count: slides.length, Item: (i) => slides[i - 1] } };
}

test("findSlideIndexBySeqTag: 命中唯一 seq tag 返回其 SlideIndex", () => {
  const internals = loadInternals();
  const pres = mkPres([
    mkSlide(1, { LingxiBatchSeq: "deck-x:1" }),
    mkSlide(2, { LingxiBatchSeq: "deck-x:2" }),
    mkSlide(3, { LingxiBatchSeq: "other:1" })
  ]);
  assert.strictEqual(internals.findSlideIndexBySeqTag(pres, "deck-x", 2), 2);
});

test("findSlideIndexBySeqTag: 用户在前面插了一页后仍按 tag 命中真实位置", () => {
  const internals = loadInternals();
  const pres = mkPres([
    mkSlide(1, {}),                                   // 用户新插入的页
    mkSlide(2, { LingxiBatchSeq: "deck-x:1" }),
    mkSlide(3, { LingxiBatchSeq: "deck-x:2" })
  ]);
  assert.strictEqual(internals.findSlideIndexBySeqTag(pres, "deck-x", 1), 2);
});

test("findSlideIndexBySeqTag: 找不到返回 null", () => {
  const internals = loadInternals();
  const pres = mkPres([mkSlide(1, { LingxiBatchSeq: "deck-x:1" })]);
  assert.strictEqual(internals.findSlideIndexBySeqTag(pres, "deck-x", 9), null);
});
