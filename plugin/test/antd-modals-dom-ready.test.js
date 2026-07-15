const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const antdModalsJs = fs.readFileSync(path.join(__dirname, "../js/antd-modals.js"), "utf8");

function makeElement(tagName) {
  return {
    tagName: String(tagName || "div").toUpperCase(),
    id: "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute(name, value) { this[name] = String(value); },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; }
  };
}

test("Antd modal islands wait until document.body exists before mounting", () => {
  const listeners = new Map();
  const calls = { mountCount: 0, mountRoot: null };
  const documentElement = makeElement("html");
  const document = {
    body: null,
    documentElement,
    readyState: "loading",
    getElementById() { return null; },
    createElement: makeElement,
    addEventListener(type, callback) {
      const items = listeners.get(type) || [];
      items.push(callback);
      listeners.set(type, items);
    },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const sandbox = {
    window: null,
    document,
    navigator: {},
    MutationObserver: class MutationObserver { observe() {} },
    console: { log() {}, warn() {}, error() {} },
    Vue: {
      h() {},
      nextTick(callback) { if (typeof callback === "function") callback(); },
      createApp() {
        return {
          use() { return this; },
          mount(root) {
            calls.mountCount += 1;
            calls.mountRoot = root;
          }
        };
      }
    },
    antd: { message: {} }
  };
  sandbox.window = sandbox;

  assert.doesNotThrow(() => vm.runInNewContext(antdModalsJs, sandbox));
  assert.equal(calls.mountCount, 0, "body 不存在时不应立即 mount");

  const body = makeElement("body");
  document.body = body;
  document.readyState = "interactive";
  for (const callback of listeners.get("DOMContentLoaded") || []) {
    callback();
  }

  assert.equal(calls.mountCount, 1);
  assert.equal(calls.mountRoot.id, "antdModalRoot");
  assert.equal(calls.mountRoot.parentNode, body);
});
