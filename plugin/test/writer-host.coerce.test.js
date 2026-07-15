const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// NOTE: loaded via vm.runInThisContext (same V8 realm as this test file), not vm.createContext.
// vm.createContext spins up a separate realm with its own Object/Array prototypes; Node's
// assert.deepStrictEqual also checks prototype identity, so structurally-identical plain objects
// created in a different realm still fail deepStrictEqual even against a correct implementation.
// Staying in the same realm keeps the assertions below meaningful.
function loadHost() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", "writer.js"), "utf8");
  global.window = {};
  vm.runInThisContext(code, { filename: "writer.js" });
  return global.window.WpsAiHostWriter;
}

test("coerceBlocks passes arrays through", () => {
  const host = loadHost();
  const blocks = [{ type: "heading", level: 1, text: "T" }];
  assert.strictEqual(host._internal.coerceBlocks(blocks), blocks);
});

test("coerceBlocks wraps a plain string as one paragraph", () => {
  const host = loadHost();
  assert.deepStrictEqual(host._internal.coerceBlocks("hi"), [{ type: "paragraph", text: "hi" }]);
});

test("coerceBlocks empty input -> empty array", () => {
  const host = loadHost();
  assert.deepStrictEqual(host._internal.coerceBlocks(""), []);
  assert.deepStrictEqual(host._internal.coerceBlocks(null), []);
});
