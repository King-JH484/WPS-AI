const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appJs = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");

test("showMessage logs non-string payloads before displaying them", () => {
  assert.match(appJs, /function\s+formatMessageText\s*\(/);
  assert.match(appJs, /function\s+describeForLog\s*\(/);
  assert.match(appJs, /showMessage\.nonString/);
  assert.match(appJs, /showMessage\.objectString/);
  assert.match(appJs, /els\.message\.textContent\s*=\s*messageText/);
});

test("PDF path resolution writes diagnostic logs for dev tools", () => {
  assert.match(appJs, /pdfPath\.resolve/);
  assert.match(appJs, /pdfPath\.prepare/);
});
