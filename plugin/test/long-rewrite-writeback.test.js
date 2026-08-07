const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// NOTE: loaded via vm.runInThisContext (same V8 realm as this test file), not vm.createContext.
// vm.createContext spins up a separate realm with its own Object/Array prototypes; Node's
// assert.deepStrictEqual also checks prototype identity, so structurally-identical plain objects
// created in a different realm still fail deepStrictEqual even against a correct implementation.
// Staying in the same realm keeps the assertions below meaningful. Mirrors
// writer-host.coerce.test.js's loader.
function loadHost() {
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "hosts", "writer.js"), "utf8");
  global.window = {};
  vm.runInThisContext(code, { filename: "writer.js" });
  return global.window.WpsAiHostWriter;
}

// Stub doc: records every Range(start, end) call and the text assigned to it, and hands back
// a minimal Paragraphs stub so the styling loop in replaceSectionsInPlace doesn't throw.
function makeStubDoc(calls) {
  return {
    Range(start, end) {
      const entry = { start, end, text: null };
      calls.push(entry);
      return {
        set Text(v) {
          entry.text = v;
        },
        get Text() {
          return entry.text;
        },
        Paragraphs: {
          Count: 3,
          Item: () => ({ set Style(v) {} })
        }
      };
    }
  };
}

test("replaceSectionsInPlace: writes bottom-up ranges in given order with correct bounds", async () => {
  const host = loadHost();
  const calls = [];
  const doc = makeStubDoc(calls);

  const ordered = [
    { ok: true, charStart: 100, charEnd: 130, blocks: [{ type: "paragraph", text: "第三节改写后" }] },
    { ok: true, charStart: 30, charEnd: 80, blocks: [{ type: "heading", level: 1, text: "第二节标题" }, { type: "paragraph", text: "第二节正文" }] },
    { ok: true, charStart: 0, charEnd: 20, blocks: [{ type: "paragraph", text: "第一节正文" }] }
  ];

  const result = await host.replaceSectionsInPlace(ordered, { doc });

  assert.deepStrictEqual(result, { replaced: 3, failed: 0 });

  assert.equal(calls.length, 3);
  // Ranges must be issued in the given (descending charStart) order.
  assert.deepStrictEqual(calls.map((c) => c.start), [100, 30, 0]);
  // Each call's range is [charStart, charEnd-1].
  assert.deepStrictEqual(calls.map((c) => c.end), [129, 79, 19]);

  assert.equal(calls[0].text, "第三节改写后");
  assert.equal(calls[1].text, "第二节标题\r第二节正文");
  assert.equal(calls[2].text, "第一节正文");
});

test("replaceSectionsInPlace: empty-text blocks are filtered without desyncing styling, and all-empty results fail without writing", async () => {
  const host = loadHost();
  const calls = [];
  const doc = makeStubDoc(calls);

  const ordered = [
    // A spacer block with empty text sits between two real blocks; the styled paragraph loop
    // must line up with the FILTERED text, not the original blocks array (Finding 2).
    {
      ok: true, charStart: 100, charEnd: 140,
      blocks: [
        { type: "heading", level: 2, text: "标题" },
        { type: "paragraph", text: "   " }, // cleans to empty -> filtered out
        { type: "paragraph", text: "正文内容" }
      ]
    },
    // All blocks clean to empty text -> must not write and must count as failed (Finding 3).
    { ok: true, charStart: 30, charEnd: 60, blocks: [{ type: "paragraph", text: "\r\n" }, { type: "paragraph", text: "" }] },
    { ok: true, charStart: 0, charEnd: 20, blocks: [{ type: "paragraph", text: "第一节" }] }
  ];

  const result = await host.replaceSectionsInPlace(ordered, { doc });

  assert.deepStrictEqual(result, { replaced: 2, failed: 1 });

  // Only 2 Range() calls: the all-empty section (charStart 30) must be skipped entirely.
  assert.equal(calls.length, 2);
  assert.deepStrictEqual(calls.map((c) => c.start), [100, 0]);
  assert.deepStrictEqual(calls.map((c) => c.end), [139, 19]);

  // Filtered text joins only the non-empty blocks.
  assert.equal(calls[0].text, "标题\r正文内容");
  assert.equal(calls[1].text, "第一节");
});
