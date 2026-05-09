// 参考 wpsjs_demo：index.html 作为 WPS 加载项入口，仅加载 main.js；业务脚本由 main.js 统一装载。
(function loadWpsAiScripts() {
  "use strict";

  const isTaskpanePage = /(?:^|\/)taskpane\.html(?:[?#].*)?$/i.test(window.location.pathname);

  // 加载顺序很重要：
  // 1. auth.js: OAuth/Token
  // 2. providers/registry.js: 必须在各 provider 注册之前
  // 3. providers/sse.js: SSE 工具
  // 4. providers/*: 各 provider 实现，调用 registry.register
  // 5. openai.js: 上层 facade，依赖 registry
  // 6. wps-addon-adapter.js + wps.js: WPS 文档桥接
  // 7. app.js: 业务 UI（仅 taskpane 页面）
  const scripts = [
    "js/auth.js",
    "js/providers/registry.js",
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
    "js/hosts/writer.js",
    "js/hosts/spreadsheet.js",
    "js/hosts/presentation.js",
    "js/wps.js",
    // 工具注册表 + 各宿主工具实现（依赖 wps.js 的 WpsAiDocument 与 hosts/*）
    "js/tools/registry.js",
    "js/tools/common.js",
    "js/tools/spreadsheet.js",
    "js/tools/writer.js",
    "js/tools/presentation.js",
    "js/tools/image.js"
  ];

  if (isTaskpanePage) {
    scripts.push("js/app.js");
  }

  scripts.forEach((src) => {
    document.write(`<script type="text/javascript" src="${src}"><\/script>`);
  });
})();
