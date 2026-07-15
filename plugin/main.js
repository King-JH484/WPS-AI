// 参考 wpsjs_demo：index.html 作为 WPS 加载项入口，仅加载 main.js；业务脚本由 main.js 统一装载。
(function loadWpsAiScripts() {
  "use strict";

  (function installWpsNamespaceFallback(global) {
    function patchWpsApi(api) {
      if (!api || (typeof api !== "object" && typeof api !== "function")) return api;
      ["WrapCallbackArg", "JS2Variant", "Variant2JS"].forEach((name) => {
        if (typeof api[name] === "function") return;
        try {
          Object.defineProperty(api, name, {
            configurable: true,
            enumerable: false,
            writable: true,
            value(value) {
              return value;
            }
          });
        } catch (error) {
          try {
            api[name] = function identityVariantBridge(value) {
              return value;
            };
          } catch (e) {}
        }
      });
      return api;
    }

    const fallback = patchWpsApi({});
    if ("wps" in global) {
      try {
        if (global.wps == null) {
          global.wps = fallback;
        } else {
          patchWpsApi(global.wps);
        }
      } catch (error) {}
      return;
    }
    try {
      Object.defineProperty(global, "wps", {
        configurable: true,
        enumerable: true,
        get() {
          return fallback;
        },
        set(value) {
          Object.defineProperty(global, "wps", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patchWpsApi(value)
          });
        }
      });
    } catch (error) {
      global.wps = fallback;
    }
  })(window);

  const isTaskpanePage = /(?:^|\/)taskpane\.html(?:[?#].*)?$/i.test(window.location.pathname);

  // 加载顺序很重要：
  // 0. runtime.js: 端口探测 + WpsAiRuntime.proxyBase()（其他模块/provider 顶层会立刻读它）
  // 0.5. store.js: sqlite/localStorage 兼容存取层，依赖 runtime.proxyBase()；
  //      必须排在 runtime 之后、auth 等一切读缓存的受管模块之前 —— boot 时
  //      app.js 会先 await WpsAiStore.init() 再放行后续读取。
  // 1. auth.js: OAuth/Token
  // 2. providers/registry.js: 必须在各 provider 注册之前
  // 3. providers/sse.js: SSE 工具
  // 4. providers/*: 各 provider 实现，调用 registry.register
  // 5. openai.js: 上层 facade，依赖 registry
  // 6. wps-addon-adapter.js + wps.js: WPS 文档桥接
  // 7. app.js: 业务 UI（仅 taskpane 页面）
  const scripts = [
    "js/vendor/vue/vue.global.prod.js",
    "js/vendor/dayjs/dayjs.min.js",
    "js/vendor/dayjs/advancedFormat.js",
    "js/vendor/dayjs/customParseFormat.js",
    "js/vendor/dayjs/localeData.js",
    "js/vendor/dayjs/quarterOfYear.js",
    "js/vendor/dayjs/weekOfYear.js",
    "js/vendor/dayjs/weekYear.js",
    "js/vendor/dayjs/weekday.js",
    "js/vendor/ant-design-vue/antd.min.js",
    "js/antd-modals.js",
    "js/runtime.js",
    "js/store.js",
    "js/auth.js",
    "js/providers/registry.js",
    "js/providers/capabilities.js",
    "js/providers/sse.js",
    "js/providers/codex.js",
    "js/providers/openai.js",
    "js/providers/anthropic.js",
    "js/providers/image.js",
    "js/openai.js",
    "js/quick-actions.js",
    "js/wps-addon-adapter.js",
    "js/markdown-to-word.js",
    "js/markdown-render.js",
    "js/mindmap.js", // 文档脑图：markdown 大纲 → echarts tree 数据
    "js/hosts/writer.js",
    "js/hosts/spreadsheet.js",
    "js/hosts/presentation.js",
    "js/hosts/pdf.js",
    "js/wps.js",
    // 方案 B：frontend-slides 风格 HTML 模板 → 图片插入 PPT
    // vendor（html2canvas / echarts）改为懒加载：真正需要 HTML 模板渲染时
    // renderer.js 会 await WpsAiLazyVendor.ensure() 动态注入，冷启动 -500KB
    "js/lazy-vendor.js",
    "js/html-templates/cache.js",
    "js/html-templates/components.js",
    "js/html-templates/renderer.js",
    "js/html-templates/templates/studio.js",
    // 改动记录：依赖 wps.js / hosts/*，要在 tools/registry.js 之前加载，
    // 这样 registry.execute() hook 进去时 WpsAiHistory / WpsAiSnapshot 已可用
    "js/doc-lock.js",   // AI 工作期间锁住文档不让用户编辑
    "js/backup.js",     // 文档级备份（per-turn 快照恢复），被 history.js 使用
    "js/history.js",
    "js/material-library.js", // 生图素材库：记录 generate_image 历史，供 ribbon「素材库」打开
    "js/material-tagger.js", // 素材内容打标（LLM，文本/视觉），依赖 material-library + providers
    "js/local-matting.js", // 本地离线抠图（onnxruntime-web + isnet 模型），发丝级软 alpha，无需联网/供应商
    "js/snapshot.js",
    "js/conversations.js",  // 多对话管理（新建 / 切换 / 历史）
    "js/token-usage.js",
    "js/skills.js",         // 技能（内置 + 用户导入，按需拼到 system prompt）
    "js/updater.js",        // 热更新（拉 manifest / 下载 zip / 解压覆盖）
    "js/cache.js",          // 缓存管理：扫 localStorage + proxy 侧目录大小，可选择性清
    "js/image-error-classifier.js", // 生图错误归因分类器（纯逻辑，无 DOM 依赖）
    "js/edit-shortcuts.js", // WPS 宿主快捷键兜底：粘贴等编辑键优先进入 WebView 输入框
    "js/mcp-bridge.js",     // MCP 服务桥：把 WPS 工具暴露给外部 agent (Claude Code CLI 等)
    // 工具注册表 + 各宿主工具实现（依赖 wps.js 的 WpsAiDocument 与 hosts/*）
    "js/tools/registry.js",
    "js/tools/common.js",
    "js/tools/spreadsheet.js",
    "js/tools/writer.js",
    "js/tools/deck-staging.js",
    "js/tools/materials.js",
    "js/tools/web.js",
    "js/tools/presentation.js",
    "js/tools/pdf.js",
    "js/tools/image.js"
  ];

  if (isTaskpanePage) {
    scripts.push("js/app.js");
  }

  const cacheBust = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname)
    ? `?v=${Date.now()}`
    : "";

  scripts.forEach((src) => {
    document.write(`<script type="text/javascript" src="${src}${cacheBust}"><\/script>`);
  });
})();
