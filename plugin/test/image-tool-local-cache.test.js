const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadImageToolSandbox({ generatedResults, localPath }) {
  const code = fs.readFileSync(path.join(__dirname, "../js/tools/image.js"), "utf8");
  const registered = {};
  const added = [];
  const window = {
    WpsAiToolRegistry: {
      registerTool(tool) {
        registered[tool.name] = tool;
      }
    },
    WpsAiProviderRegistry: {
      loadSettings: () => ({ currentProject: "项目A" }),
      getImageConfig: () => ({
        type: "toapis",
        defaultSize: "1:1",
        defaultResolution: "1K",
        model: "gpt-image-2"
      })
    },
    WpsAiImage: {
      generateImage: async () => generatedResults
    },
    WpsAiImageAssets: {
      ensureLocalImagePath: async (url) => {
        assert.equal(url, "https://files.toapis.com/u/out.png");
        return localPath;
      }
    },
    WpsAiMaterialLibrary: {
      addMany(items, meta) {
        items.forEach((item) => added.push(Object.assign({}, meta, item)));
        return added.map((item, index) => Object.assign({ id: "img-" + index }, item));
      }
    },
    WpsAiMaterialTagger: {
      tagImage: async () => []
    },
    WpsAiImageUI: {
      start() {},
      update() {},
      done() {},
      fail() {}
    }
  };
  const factory = vm.runInThisContext(
    "(function(window, console){ " + code + "\n return { registered: window.WpsAiToolRegistry, window }; })"
  );
  factory(window, console);
  return { tool: registered.generate_image, added };
}

test("generate_image 返回 ToAPI 远程图时先缓存为本地路径并以 sourceUrl 入库", async () => {
  const { tool, added } = loadImageToolSandbox({
    generatedResults: [{ url: "https://files.toapis.com/u/out.png", revisedPrompt: "rp" }],
    localPath: "/tmp/anthony-image.png"
  });

  const result = await tool.handler({ prompt: "蓝色科技封面", n: 1 });

  assert.deepEqual(result.images, [{ url: "/tmp/anthony-image.png", revisedPrompt: "rp" }]);
  assert.equal(added[0].url, "/tmp/anthony-image.png");
  assert.equal(added[0].sourceUrl, "https://files.toapis.com/u/out.png");
});
