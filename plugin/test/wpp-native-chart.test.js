const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function collection(items) {
  return { get Count() { return items.length; }, Item: (index) => items[index - 1] || null, _items: items };
}

function loadRuntime() {
  const writes = [];
  const calls = { addChart: 0, chartDataGet: 0, chartDataActivate: 0 };
  const sheet = {
    Name: "Sheet1",
    Range(address) { return { set Value(value) { writes.push({ address, value }); }, get Value() { return null; } }; }
  };
  const workbook = { Worksheets: collection([sheet]), Close() {} };
  const shapeItems = [];
  const shapes = collection(shapeItems);
  shapes.AddChart2 = function AddChart2(_style, type, left, top, width, height) {
    calls.addChart += 1;
    const chartData = { Activate() { calls.chartDataActivate += 1; }, Workbook: workbook };
    const chart = { ChartType: type, SetSourceData(source) { this.source = source; } };
    Object.defineProperty(chart, "ChartData", { get() { calls.chartDataGet += 1; return chartData; } });
    const shape = { Id: 501, HasChart: -1, Chart: chart, Left: left, Top: top, Width: width, Height: height, Delete: () => shapeItems.splice(shapeItems.indexOf(shape), 1) };
    shapeItems.push(shape);
    return shape;
  };
  const slide = { SlideID: 77, SlideIndex: 1, Shapes: shapes };
  const presentation = { Name: "chart-test.pptx", FullName: "/tmp/chart-test.pptx", Slides: collection([slide]) };
  const window = { navigator: { platform: "MacIntel" }, WpsAiHostPresentation: { _internal: { getActivePresentation: async () => presentation } } };
  window.window = window;
  const context = vm.createContext({ window, console, navigator: window.navigator, Date, Promise });
  for (const [folder, file] of [["tools", "wpp-capabilities.js"], ["hosts", "presentation-native-handles.js"], ["hosts", "presentation-native.js"]]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", folder, file), "utf8"), context, { filename: file });
  }
  return { window, presentation, writes, shapeItems, calls };
}

function support(runtime, keys) {
  const capabilities = {};
  keys.forEach((key) => { capabilities[key] = { state: "supported", adapter: "wps_jsapi", reason: "test" }; });
  runtime.WpsAiWppCapabilities.recordEvidence({ platform: "darwin", capabilities, evidence: { observedAt: new Date().toISOString() } });
}

test("原生图表写能力未验证时 fail closed", async () => {
  const { window, calls } = loadRuntime();
  support(window, ["wpp.chart.native.create"]);
  await assert.rejects(() => window.WpsAiPresentationNative.createNativeChart({ slide: 1, chartType: "column", categories: ["A"], series: [{ name: "S", values: [1] }] }), /capability_unverified/);
  assert.deepEqual(calls, { addChart: 0, chartDataGet: 0, chartDataActivate: 0 });
});

test("创建柱状图调用 AddChart2，并将类别/系列写入 ChartData.Workbook", async () => {
  const { window, writes, shapeItems } = loadRuntime();
  support(window, ["wpp.chart.native.create", "wpp.chart.native.data"]);
  const result = await window.WpsAiPresentationNative.createNativeChart({
    slide: 1, chartType: "column", title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "2026", values: [10, 20] }]
  });
  assert.equal(shapeItems[0].Chart.ChartType, 51);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, "A1:B3");
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].value)), [["", "2026"], ["Q1", 10], ["Q2", 20]]);
  assert.match(result.chartHandle, /^wpp-shape:v1:/);
  assert.equal(result.native, true);
});

test("更新和读取均按 chart handle 定位，不依赖页序", async () => {
  const { window, presentation } = loadRuntime();
  support(window, ["wpp.chart.native.create", "wpp.chart.native.data", "wpp.chart.native.read", "wpp.chart.native.update"]);
  const created = await window.WpsAiPresentationNative.createNativeChart({ slide: 1, chartType: "line", categories: ["A"], series: [{ name: "S", values: [1] }] });
  const updated = await window.WpsAiPresentationNative.updateNativeChart({ chartHandle: created.chartHandle, chartType: "pie", categories: ["A"], series: [{ name: "S", values: [2] }] });
  assert.equal(updated.applied, true);
  const info = await window.WpsAiPresentationNative.readNativeChart({ chartHandle: created.chartHandle });
  assert.equal(info.chartTypeCode, 5);
  assert.equal(presentation.Slides.Item(1).Shapes.Item(1).Chart.ChartType, 5);
});

test("仅更新图表类型或标题不需要 ChartData 能力，也不读取 Workbook", async () => {
  const { window, calls } = loadRuntime();
  support(window, ["wpp.chart.native.create", "wpp.chart.native.data", "wpp.chart.native.update"]);
  const created = await window.WpsAiPresentationNative.createNativeChart({ slide: 1, chartType: "line", categories: ["A"], series: [{ name: "S", values: [1] }] });
  calls.addChart = 0;
  calls.chartDataGet = 0;
  calls.chartDataActivate = 0;
  await window.WpsAiPresentationNative.updateNativeChart({ chartHandle: created.chartHandle, chartType: "pie", title: "Only metadata" });
  assert.deepEqual(calls, { addChart: 0, chartDataGet: 0, chartDataActivate: 0 });
});

test("数据校验失败时清理刚创建的原生图表，不留下半成品", async () => {
  const { window, shapeItems } = loadRuntime();
  support(window, ["wpp.chart.native.create", "wpp.chart.native.data"]);
  await assert.rejects(() => window.WpsAiPresentationNative.createNativeChart({
    slide: 1, chartType: "pie", categories: ["A"], series: [{ name: "S1", values: [1] }, { name: "S2", values: [2] }]
  }), /只支持一个系列/);
  assert.equal(shapeItems.length, 0);
});

test("原生图表工具与图片图表名称明确分离", () => {
  const names = [];
  const window = { WpsAiToolRegistry: { registerTool: (definition) => names.push(definition.name) } };
  window.window = window;
  const context = vm.createContext({ window, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "tools", "wpp-native-tools.js"), "utf8"), context);
  for (const name of ["wpp_native_chart_create", "wpp_native_chart_read", "wpp_native_chart_update", "wpp_native_chart_delete"]) {
    assert.ok(names.includes(name), `${name} 未注册`);
  }
  assert.ok(!names.includes("wpp_render_chart"));
});
