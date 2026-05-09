(function attachProviderRegistry(global) {
  "use strict";

  const SETTINGS_KEY = "wps_ai_provider_settings_v1";

  const DEFAULT_SETTINGS = Object.freeze({
    activeProvider: "codex",
    operationMode: "preview",
    // 一次对话允许的工具调用循环上限，超过会强制中止（防失控）。
    // 复杂任务（生成 10 页 PPT 之类）通常需要 30-60 次迭代。
    maxToolIterations: 50,
    providers: Object.freeze({
      codex: Object.freeze({
        type: "codex",
        label: "Codex (ChatGPT OAuth)",
        defaultModel: "gpt-5.1-codex"
      }),
      openai: Object.freeze({
        type: "openai",
        label: "OpenAI 兼容",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        defaultModel: "gpt-4o-mini",
        useProxy: true
      }),
      anthropic: Object.freeze({
        type: "anthropic",
        label: "Anthropic Claude",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "",
        defaultModel: "claude-sonnet-4-6",
        useProxy: true,
        anthropicVersion: "2023-06-01"
      })
    }),
    // 图像生成独立配置。当前对接 toapis.com / GPT-Image-2 异步任务协议：
    //   POST {base}/images/generations  → { id, status }
    //   GET  {base}/images/generations/{id}  → { status, result.data[].url }
    imageProvider: Object.freeze({
      enabled: false,
      baseUrl: "https://toapis.com/v1",
      apiKey: "",
      model: "gpt-image-2",
      defaultSize: "1:1",
      defaultResolution: "1K",
      useProxy: true
    }),
    // PPT 风格预设：用户在 ribbon「PPT 风格」对话框里设置后，AI 生成幻灯片时统一套用
    stylePreset: Object.freeze({
      enabled: false,
      // 字体
      titleFont: "Microsoft YaHei",
      titleSize: 32,
      titleBold: true,
      bodyFont: "Microsoft YaHei",
      bodySize: 18,
      // 色板（核心：让 AI 用这套颜色统一设计幻灯片）
      titleColor: "#1f2329",      // 标题字色
      bodyColor: "#33363c",       // 正文字色
      primaryColor: "#1f3a5f",    // 主色（标题块/装饰条/章节页背景）
      secondaryColor: "#3d5a80",  // 次色（主色暗版/边框）
      accentColor: "#ee6c4d",     // 强调色（点缀/高亮）
      backgroundColor: "#ffffff", // 幻灯片底色
      surfaceColor: "#f5f7fa",    // 卡片/区块底色
      // 主题模板（可选，本地路径）
      themeFile: "",
      // 当前色板方案标识（"custom" 表示用户自定义；其他值见 COLOR_SCHEMES）
      scheme: "custom"
    }),
    // 12 套主题预设——每个都带设计理念。颜色都经过对比度核对，避免炫光/相冲。
    COLOR_SCHEMES: Object.freeze({
      "bold-signal": Object.freeze({
        label: "Bold Signal", description: "自信、高冲击力 · Pitch Deck/主题演讲",
        design: "黑白极简对比 + 一抹深橙作 hero。大量留白，标题占满视线。灵感：Pitch.com YC 模板 / Apple keynote。",
        darkMode: false,
        primaryColor: "#1A1A1A", secondaryColor: "#525252", accentColor: "#FF5722",
        backgroundColor: "#FAFAFA", surfaceColor: "#F4F4F5",
        titleColor: "#1A1A1A", bodyColor: "#404040",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "electric-studio": Object.freeze({
        label: "Electric Studio", description: "干净、专业 · 品牌/代理商演示",
        design: "信任蓝 + 暖橙作对比，cool grey 中性面。灵感：R/GA / Pentagram 工作室作品集。",
        darkMode: false,
        primaryColor: "#2563EB", secondaryColor: "#1E3A8A", accentColor: "#F97316",
        backgroundColor: "#FFFFFF", surfaceColor: "#F1F5F9",
        titleColor: "#0F172A", bodyColor: "#475569",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "creative-voltage": Object.freeze({
        label: "Creative Voltage", description: "复古活力 · 创意提案",
        design: "70s 海报色——砖红 + 深蓝 + 芥末黄，做羊皮纸底。灵感：Eames、Massimo Vignelli。",
        darkMode: false,
        primaryColor: "#C2410C", secondaryColor: "#1E40AF", accentColor: "#EAB308",
        backgroundColor: "#FAF3E7", surfaceColor: "#FCE7C5",
        titleColor: "#1C1917", bodyColor: "#57534E",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "dark-botanical": Object.freeze({
        label: "Dark Botanical", description: "优雅、精致 · 高端品牌",
        design: "森林深绿 + 古铜金 + 暖奶油字。深色克制，金色点缀，奢华低调。灵感：Hermès / RH catalog。",
        darkMode: true,
        primaryColor: "#2D4A38", secondaryColor: "#4A6B53", accentColor: "#B8916D",
        backgroundColor: "#0F1A14", surfaceColor: "#1F2D24",
        titleColor: "#EFE8D7", bodyColor: "#A9B3A4",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "notebook-tabs": Object.freeze({
        label: "Notebook Tabs", description: "编辑感、条理清晰 · 报告/评测",
        design: "米黄笔记纸底 + 蓝/红/赭石三色像分类标签。每章一个色调暗示。灵感：Field Notes / Moleskine。",
        darkMode: false,
        primaryColor: "#1E40AF", secondaryColor: "#B91C1C", accentColor: "#B45309",
        backgroundColor: "#FAFAF2", surfaceColor: "#F5F0DC",
        titleColor: "#1C1917", bodyColor: "#44403C",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "pastel-geometry": Object.freeze({
        label: "Pastel Geometry", description: "友好、亲切 · 产品介绍",
        design: "柔和粉彩三色（薰衣草 + 桃 + 薄荷）配几何感装饰，warm white 底。灵感：Stripe Atlas / Memphis Group。",
        darkMode: false,
        primaryColor: "#8B7CF6", secondaryColor: "#FBA774", accentColor: "#5EEAD4",
        backgroundColor: "#FFFCF7", surfaceColor: "#F3EEFF",
        titleColor: "#312E81", bodyColor: "#4F4870",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "split-pastel": Object.freeze({
        label: "Split Pastel", description: "活泼、现代 · 创意机构",
        design: "粉/青双色等权重分屏，黄色作点缀。Spotify Wrapped 美学。灵感：Wrapped / 现代杂志。",
        darkMode: false,
        primaryColor: "#EC4899", secondaryColor: "#06B6D4", accentColor: "#FACC15",
        backgroundColor: "#FFFFFF", surfaceColor: "#FFE4ED",
        titleColor: "#831843", bodyColor: "#4A2A4A",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "vintage-editorial": Object.freeze({
        label: "Vintage Editorial", description: "个性、有腔调 · 个人品牌",
        design: "杂志色调——牛血红 + 烟草棕 + 旧纸黄，宋体衬线。Wes Anderson 调色 + 老 Vogue。",
        darkMode: false,
        primaryColor: "#5C2A2A", secondaryColor: "#8B6F47", accentColor: "#C8553D",
        backgroundColor: "#F0E8D6", surfaceColor: "#E0D4BC",
        titleColor: "#1C0D02", bodyColor: "#3A2E1F",
        titleFont: "宋体", bodyFont: "宋体"
      }),
      "neon-cyber": Object.freeze({
        label: "Neon Cyber", description: "未来感、科技感 · 科技初创",
        design: "深空蓝底 + 电光紫到青的克制霓虹（不是三种霓虹乱炸）。灵感：Apple Vision Pro launch。",
        darkMode: true,
        primaryColor: "#6366F1", secondaryColor: "#8B5CF6", accentColor: "#22D3EE",
        backgroundColor: "#0A0E1A", surfaceColor: "#131829",
        titleColor: "#F8FAFC", bodyColor: "#94A3B8",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "terminal-green": Object.freeze({
        label: "Terminal Green", description: "开发者极客风 · Dev 工具/API 介绍",
        design: "GitHub Dark + 现代终端绿（不是辣眼的纯绿），等宽 Consolas。Amber 警告 / 红色错误对应代码 IDE 语义。",
        darkMode: true,
        primaryColor: "#4ADE80", secondaryColor: "#FBBF24", accentColor: "#F87171",
        backgroundColor: "#0D1117", surfaceColor: "#161B22",
        titleColor: "#E6EDF3", bodyColor: "#8B949E",
        titleFont: "Consolas", bodyFont: "Consolas"
      }),
      "swiss-modern": Object.freeze({
        label: "Swiss Modern", description: "极简、精准 · 企业数据汇报",
        design: "纯黑白 + 一抹瑞士红，网格留白克制。灵感：Helvetica / Müller-Brockmann / Dieter Rams。",
        darkMode: false,
        primaryColor: "#000000", secondaryColor: "#525252", accentColor: "#DC2626",
        backgroundColor: "#FFFFFF", surfaceColor: "#F4F4F5",
        titleColor: "#000000", bodyColor: "#262626",
        titleFont: "Microsoft YaHei", bodyFont: "Microsoft YaHei"
      }),
      "paper-ink": Object.freeze({
        label: "Paper & Ink", description: "文学感、沉稳 · 深度叙事/研究",
        design: "旧纸黄 + 墨黑 + 朱砂红印章。宋体衬线，文人气。灵感：Penguin Classics 封面。",
        darkMode: false,
        primaryColor: "#1C1917", secondaryColor: "#44403C", accentColor: "#991B1B",
        backgroundColor: "#F5EDD8", surfaceColor: "#E8DCBF",
        titleColor: "#1C1917", bodyColor: "#292524",
        titleFont: "宋体", bodyFont: "宋体"
      })
    })
  });

  const factories = new Map();

  function register(type, factory) {
    factories.set(type, factory);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return clone(DEFAULT_SETTINGS);
      }
      const parsed = JSON.parse(raw);
      const merged = clone(DEFAULT_SETTINGS);
      merged.activeProvider = parsed.activeProvider || merged.activeProvider;
      merged.operationMode = parsed.operationMode || merged.operationMode;
      if (typeof parsed.maxToolIterations === "number" && parsed.maxToolIterations > 0) {
        merged.maxToolIterations = parsed.maxToolIterations;
      }
      Object.keys(merged.providers).forEach((key) => {
        if (parsed.providers && parsed.providers[key]) {
          merged.providers[key] = Object.assign({}, merged.providers[key], parsed.providers[key]);
        }
      });
      if (parsed.imageProvider) {
        merged.imageProvider = Object.assign({}, merged.imageProvider, parsed.imageProvider);
      }
      if (parsed.stylePreset) {
        merged.stylePreset = Object.assign({}, merged.stylePreset, parsed.stylePreset);
      }
      return merged;
    } catch (error) {
      console.warn("[provider] 读取设置失败，使用默认值", error);
      return clone(DEFAULT_SETTINGS);
    }
  }

  function getImageConfig(settings = loadSettings()) {
    return Object.assign({}, settings.imageProvider || {});
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function getActiveConfig(settings = loadSettings()) {
    const cfg = settings.providers[settings.activeProvider];
    if (!cfg) {
      throw new Error(`未知 provider: ${settings.activeProvider}`);
    }
    return Object.assign({ id: settings.activeProvider }, cfg);
  }

  function buildProvider(config = getActiveConfig()) {
    const factory = factories.get(config.type);
    if (!factory) {
      throw new Error(`Provider 类型未注册：${config.type}`);
    }
    return factory(config);
  }

  function listProviderTypes() {
    return Array.from(factories.keys());
  }

  global.WpsAiProviderRegistry = {
    register,
    buildProvider,
    loadSettings,
    saveSettings,
    getActiveConfig,
    getImageConfig,
    listProviderTypes,
    DEFAULT_SETTINGS,
    COLOR_SCHEMES: DEFAULT_SETTINGS.COLOR_SCHEMES
  };
})(window);
