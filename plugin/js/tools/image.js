(function attachImageTools(global) {
  "use strict";

  const registry = global.WpsAiToolRegistry;
  if (!registry) return;

  registry.registerTool({
    name: "generate_image",
    hosts: ["*"],
    description: "调用 toapis.com / GPT-Image-2 异步生成图片，内部会轮询任务直到完成。返回图片 URL。需要先在「设置 → 图像生成」中启用并配置 baseUrl/apiKey/model。生成后通常配合 wps_insert_image 把图片插入到 Word 文档。",
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "图像描述，越具体效果越好（≤4000 字符）" },
        size: {
          type: "string",
          description: "宽高比例（不是像素）。1K 仅支持 1:1/3:2/2:3；2K 增加 4:3/3:4/16:9/9:16/2:1/1:2 等；4K 仅支持 16:9/9:16/2:1/1:2/21:9/9:21。省略走默认。",
          enum: ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"]
        },
        resolution: {
          type: "string",
          description: "分辨率档位：1K 最便宜最快，4K 最贵最慢。省略走默认。",
          enum: ["1K", "2K", "4K"]
        },
        n: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "生成几张" },
        model: { type: "string", description: "覆盖默认模型（如不传使用设置中的默认 gpt-image-2）" }
      }
    },
    handler: async ({ prompt, size, resolution, n, model } = {}) => {
      const results = await global.WpsAiImage.generateImage({
        prompt, size, resolution, n: n || 1, model
      });
      return {
        count: results.length,
        images: results.map((r) => ({ url: r.url, revisedPrompt: r.revisedPrompt }))
      };
    }
  });
})(window);
