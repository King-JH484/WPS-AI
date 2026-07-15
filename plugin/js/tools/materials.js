(function attachMaterialsTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  // 纯过滤：project/kind 精确、tags 任一命中、query 子串命中 prompt/标签/标题/正文/项目。
  function filterMaterials(list, opts) {
    const o = opts || {};
    const q = String(o.query || "").trim().toLowerCase();
    const project = String(o.project || "").trim();
    const kind = String(o.kind || "").trim();
    const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [];
    return (Array.isArray(list) ? list : []).filter((it) => {
      if (project && String(it.project || "") !== project) return false;
      if (kind && String(it.kind || "image") !== kind) return false;
      if (tags.length) {
        const itags = (it.tags || []).map((t) => String(t).toLowerCase());
        if (!tags.some((t) => itags.includes(t))) return false;
      }
      if (q) {
        const hay = [it.prompt, it.revisedPrompt, it.title, it.text, (it.tags || []).join(" "), it.project]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  registry.registerTool({
    name: "query_materials",
    hosts: ["*"],
    description: [
      "检索素材库里已有的素材（图片/网页），按内容标签、项目、关键词、类型过滤。",
      "**做文档/PPT 需要配图或引用资料时，先调本工具**看有没有可复用素材，命中合适的就直接用它的 url（传给 wps_insert_image / wpp_add_picture，或写进 freeform HTML 的 src），避免重复生成。",
      "返回精简条目：{ id, url, kind, prompt, title, tags, project, source }。url 为空表示是本地导入的图（仅本地数据，无网络地址），此类请让用户从素材库手动插入。"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，匹配提示词/标签/标题/正文/项目" },
        tags: { type: "array", items: { type: "string" }, description: "内容标签，任一命中即可" },
        project: { type: "string", description: "项目名（精确匹配）" },
        kind: { type: "string", enum: ["image", "web"], description: "素材类型" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "最多返回条数，默认 20" }
      }
    },
    handler: async ({ query, tags, project, kind, limit } = {}) => {
      const lib = global.WpsAiMaterialLibrary;
      if (!lib) return { count: 0, materials: [] };
      const filtered = filterMaterials(lib.list(), { query, tags, project, kind }).slice(0, limit || 20);
      return {
        count: filtered.length,
        materials: filtered.map((e) => ({
          id: e.id,
          url: e.url || "", // 只回 http 地址；dataUrl（本地导入）不回，避免 base64 撑爆上下文
          kind: e.kind || "image",
          prompt: e.prompt || "",
          title: e.title || "",
          tags: e.tags || [],
          project: e.project || "",
          source: e.source || ""
        }))
      };
    }
  });

  // 供单测
  global.WpsAiMaterialsToolInternals = { filterMaterials };
})(window);
