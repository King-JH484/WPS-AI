const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const mainJs = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

function runMain(overrides = {}) {
  const writes = [];
  const sandbox = {
    window: null,
    location: { pathname: "/index.html", hostname: "127.0.0.1" },
    document: {
      write(html) { writes.push(html); }
    },
    Date: { now() { return 123; } },
    ...overrides
  };
  sandbox.window = sandbox;
  vm.runInNewContext(mainJs, sandbox);
  return { sandbox, writes };
}

test("main.js installs a safe wps namespace fallback for PDF devtools probes", () => {
  const { sandbox } = runMain();
  assert.doesNotThrow(() => vm.runInNewContext("typeof wps.WpsApplication", sandbox));
  assert.equal(vm.runInNewContext("typeof wps.WpsApplication", sandbox), "undefined");
  assert.equal(vm.runInNewContext("typeof wps.WrapCallbackArg", sandbox), "function");
  assert.equal(vm.runInNewContext("typeof wps.JS2Variant", sandbox), "function");
  assert.equal(vm.runInNewContext("typeof wps.Variant2JS", sandbox), "function");
  assert.equal(vm.runInNewContext("wps.WrapCallbackArg('quick.pdf.summary')", sandbox), "quick.pdf.summary");
  assert.equal(vm.runInNewContext("wps.JS2Variant('quick.pdf.summary')", sandbox), "quick.pdf.summary");
  assert.equal(vm.runInNewContext("wps.Variant2JS('quick.pdf.summary')", sandbox), "quick.pdf.summary");
});

test("main.js does not overwrite a native wps object when the host provides one", () => {
  const nativeWps = { WpsApplication() { return "native"; } };
  const { sandbox } = runMain({ wps: nativeWps });
  assert.equal(sandbox.wps, nativeWps);
  assert.equal(sandbox.wps.WpsApplication(), "native");
});

test("main.js patches native wps object when PDF host misses WrapCallbackArg", () => {
  const nativeWps = { PdfApplication() { return "pdf"; } };
  const { sandbox } = runMain({ wps: nativeWps });
  assert.equal(sandbox.wps, nativeWps);
  assert.equal(typeof sandbox.wps.WrapCallbackArg, "function");
  assert.equal(typeof sandbox.wps.JS2Variant, "function");
  assert.equal(typeof sandbox.wps.Variant2JS, "function");
  assert.deepStrictEqual(sandbox.wps.WrapCallbackArg({ id: "openWpsAiPane" }), { id: "openWpsAiPane" });
  assert.deepStrictEqual(sandbox.wps.JS2Variant({ id: "openWpsAiPane" }), { id: "openWpsAiPane" });
  assert.deepStrictEqual(sandbox.wps.Variant2JS({ id: "openWpsAiPane" }), { id: "openWpsAiPane" });
});

test("main.js keeps native WrapCallbackArg when the host provides one", () => {
  const wrap = (value) => ({ wrapped: value });
  const js2Variant = (value) => ({ variant: value });
  const variant2Js = (value) => ({ js: value });
  const nativeWps = { WrapCallbackArg: wrap, JS2Variant: js2Variant, Variant2JS: variant2Js };
  const { sandbox } = runMain({ wps: nativeWps });
  assert.equal(sandbox.wps.WrapCallbackArg, wrap);
  assert.equal(sandbox.wps.JS2Variant, js2Variant);
  assert.equal(sandbox.wps.Variant2JS, variant2Js);
  assert.deepStrictEqual(sandbox.wps.WrapCallbackArg("x"), { wrapped: "x" });
  assert.deepStrictEqual(sandbox.wps.JS2Variant("x"), { variant: "x" });
  assert.deepStrictEqual(sandbox.wps.Variant2JS("x"), { js: "x" });
});
