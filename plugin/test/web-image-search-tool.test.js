const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadWebToolSandbox(fetchImpl) {
  const code = fs.readFileSync(path.join(__dirname, "../js/tools/web.js"), "utf8");
  const registered = {};
  const added = [];
  const window = {
    fetch: fetchImpl,
    WpsAiRuntime: {
      proxyUrl: (p) => "http://127.0.0.1:3890" + p
    },
    WpsAiToolRegistry: {
      registerTool(tool) {
        registered[tool.name] = tool;
      }
    },
    WpsAiProviderRegistry: {
      loadSettings: () => ({ currentProject: "项目A" })
    },
    WpsAiMaterialLibrary: {
      add(item) {
        added.push(item);
        return Object.assign({ id: "mat-" + added.length }, item);
      }
    }
  };
  window.window = window;
  const factory = vm.runInThisContext(
    "(function(window, console, fetch){ " + code + "\n return window.WpsAiToolRegistry; })"
  );
  factory(window, console, fetchImpl);
  return { tool: registered.web_image_search, added };
}

function jsonResponse(ok, status, payload) {
  return {
    ok,
    status,
    json: async () => payload
  };
}

test("web_image_search：指定 site 时把站点约束传给代理", async () => {
  let requested = "";
  const { tool } = loadWebToolSandbox(async (url) => {
    requested = String(url);
    return jsonResponse(true, 200, { ok: true, results: [] });
  });

  await tool.handler({ query: "logo", site: "tencent.com", count: 3 });

  const u = new URL(requested);
  assert.equal(u.pathname, "/image-search");
  assert.equal(u.searchParams.get("site"), "tencent.com");
});

test("web_image_search：save=true 时只保存可成功抓取的图片", async () => {
  const fetchCalls = [];
  const { tool, added } = loadWebToolSandbox(async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).includes("/image-search")) {
      return jsonResponse(true, 200, {
        ok: true,
        results: [
          { url: "https://bad.example.com/missing.jpg", title: "坏图" },
          { url: "https://static.www.tencent.com/uploads/a.jpg", title: "好图" }
        ]
      });
    }
    const body = JSON.parse(options.body || "{}");
    if (body.url.includes("bad.example.com")) {
      return jsonResponse(false, 502, { ok: false, error: "HTTP 404" });
    }
    return jsonResponse(true, 200, { ok: true, dataUrl: "data:image/jpeg;base64,AAA=" });
  });

  const result = await tool.handler({ query: "tencent.com", save: true, count: 2 });

  assert.equal(result.saved, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(added.map((it) => it.url), ["https://static.www.tencent.com/uploads/a.jpg"]);
  assert.equal(fetchCalls.filter((call) => call.url.includes("/fetch-remote-image")).length, 2);
});
