# AI 生成 PPT 链路 — 优化建议清单

> 起草时间：2026-05-27
> 范围：从 AI 工具调用 → 预览 → 编辑 → 插入到 WPS PPT 的全链路业务逻辑

## 链路全景图

```
AI 工具层
├─ wpp_render_html_template (单页)
└─ wpp_render_full_deck (多页 batch)
        ↓
预览层（可选）
├─ WpsAiHtmlPreview.open() → Application.ShowDialog (新窗口)
├─ 主 TaskPane ←→ Dialog 窗口 通过 localStorage IPC
└─ openHtmlPreviewInline() 在 dialog 内渲染
        ↓
渲染管线
├─ studio.js doc() + layoutDef.render() → HTML
├─ iframe document.open/write/close (主路径)
└─ bridgeEchartsToFrame() → echarts 图表 / canvas
        ↓
交互层
├─ 美化当前 chat / 统一修改 chat
├─ 选用组件 / 整页存为组件 / AI 抽取组件
├─ 编辑模式 (单选 + 圈选)
└─ 保存到「我的历史」cache
        ↓
插入层
├─ HtmlTpl.renderToPng() (html2canvas)
├─ uploadDataUrl() → proxy/upload-image
└─ pres.Slides.Add() + AddPicture()
```

---

## 🔴 高风险（数据 / 一致性）

### #1 `wpp_render_full_deck` 没有 preview 路径 + 没有 batch 撤销

**问题**：`presentation.js` L1826-L1865 直接逐页插入到末尾，每页 `cache.save`。
- AI 生成 8 页烂内容 → 全部插入 PPT + "我的历史" 一下子多 8 条
- 用户只能事后手动删 8 张 slide + 8 条历史

**修复方案**：
- 给 batch 加一个 `batchTag` 字段（uuid），写入每条 cache 和每张 slide 的 Tags
- UI 提供「撤销本次批量插入」按钮，一键删 N 张 slide + 清 batchTag 的 cache 条目
- 工具返回值带上 `batchTag`，AI 后续可引用

**状态**：✅ **已修** — cache.js 加 `batchTag` 字段 + `listByBatch/listBatches/removeBatch` API；presentation.js 的 `wpp_render_full_deck` 生成 uuid 并写入每条 cache + 每张 slide 的 Tags；新增 `wpp_undo_full_deck_batch` 工具让 AI 可一键撤销；`WpsAiHtmlPreview.undoBatch(tag)` 提供 JS API。palette 优先级也修正成「单页 > deckPalette > 全局」。

---

### #2 `wpp_render_full_deck` palette 优先级反人类

**问题**：当前实现 `Object.assign({}, globalPalette, spec.palette, deckPalette)` —— deckPalette 永远覆盖单页 palette。
- 用户想让封面用强对比 palette，其他用统一 palette → 无法做到

**修复方案**：
- 改成 `Object.assign({}, globalPalette, deckPalette, spec.palette)`
- 单页 palette 优先于 deckPalette
- 注释 + 工具描述同步修正

**状态**：✅ **已修** — 代码层在 #1 时已修正（assign 顺序：globalPalette → deckPalette → spec.palette）；本次同步修正了 `wpp_render_full_deck` 的工具描述（"色板锁定"→"色板优先级"）和 `deckPalette` 字段的 schema description，告诉 AI 单页 palette 优先级更高，可单独覆盖封面/章节页。

---

### #3 `preview=true` 路径不立即写缓存 → "我的历史" 延迟

**问题**：`wpp_render_html_template` preview=true 时 cache 只在 onConfirm 后才写。
- AI 调工具 → 弹预览 → 用户改了一下没确认就关掉 → 这页 0 痕迹
- 用户以为 AI 没工作过

**修复方案**：
- preview=true 时也立即 `cache.save({...payload, draft: true})`，标记 draft 状态
- 用户确认插入时 `cache.update(id, {draft: false})`
- 用户取消时 cache 项保留（带 draft 标记）供后续召回
- 画廊渲染 draft 项时加视觉标识（虚线边 / "草稿" 角标）

**状态**：✅ **已修** — `wpp_render_html_template` 的 preview=true 路径现在立即写 draft cache，工具返回值带 `draftCacheId`，AI 后续可引用；用户点保存时 `saveHtmlPreviewToCache` 自动设 `draft: false`；画廊草稿卡有虚线橙边 + "草稿" 左上角徽章（CSS `.is-draft`）。

---

### #4 fallback 插入路径跟原路径生成结果可能不一致

**问题**：用户点完 Insert 一次后 `state.onConfirm = null`，第二次点 Insert 走 `fallbackInsertFromState`，用 `tool.handler({...preview: false})` 重跑工具。
- 两条路径的 palette 解析顺序、slide hint 处理不同
- 二次插入和首次插入视觉可能不一样

**修复方案**：
- 把 `doRenderAndInsert` 抽到 module level / 暴露给 `WpsAiHtmlPreview`
- fallback 直接调它，不要重新走工具调用入口
- 删除 `fallbackInsertFromState` 内部的 `tool.handler` 调用

**状态**：✅ **已修** — presentation.js 提取 `renderAndInsertSlide(params)` 到模块级，挂在 `global.WpsAiRenderAndInsertSlide`；wpp_render_html_template 内部的 `doRenderAndInsert` 转调它；app.js 的 `fallbackInsertFromState` 直接调 `WpsAiRenderAndInsertSlide` 不再走 tool.handler。主路径和 fallback 完全同一条管线。

---

### #5 编辑模式 layout 切换时丢编辑改动

**问题**：用户在 freeform 下编辑了元素 → 没保存 → chat 让 AI 切到 stat layout → AI patch `layout: stat` → DOM 替换 → 改动消失，无警告。

**修复方案**：
- chat 准备应用 layout 切换前，检查 `_editorEnabled && st.layout === "freeform"` 且 DOM 跟 state.data.html 有差异
- 弹原生 `confirm()` 提示 "未保存的编辑会丢失，确认切换？"
- 用户取消 → 跳过 patch 的 layout 字段，其他改动照样应用

**状态**：✅ **已修** — submitHtmlPreviewChat 在切 layout 前检查 `_editorEnabled` + 当前 freeform + iframe `.stage.innerHTML` 跟 `state.data.html` 不一致 → 弹 confirm；用户取消 → 跳过 layout 切换，data/palette 改动照样应用；建议用户先点保存。

---

### #12 dialog X 关闭不一定触发 `onConfirm(null)`

**问题**：用户点 dialog 标题栏 × 时，`dialogOnConfirm` 不会被调，主窗口的 `_pendingHtmlPreviewOnConfirm` 永远 null 不掉。
- 下次开预览时回调状态污染
- 小内存泄漏

**修复方案**：
- 主窗口在 `app.ShowDialog` 返回后无条件调用一次 `cb?.(null)` 兜底
- dialog 内 `window.beforeunload` 事件也写一次 cancelled 到 localStorage

**状态**：✅ **已修** — dialog 内 beforeunload 监听器：如果 `_resultWritten` 还是 false（用户没点任何按钮，是 X 关闭的）→ 写 `{cancelled: true, viaWindowClose: true}` 到 localStorage RESULT key；主窗口侧的兜底逻辑早就有（result null 也调 cb(null)），现在两层都到位。

---

## 🟠 中风险（用户体验 / 性能）

### #6 30 页 batch 渲染无进度反馈

**问题**：`wpp_render_full_deck` 串行调 `renderToPng` + `uploadDataUrl`，30 页约 1-2 分钟，用户期间看不到进度。

**修复方案**：
- 通过 `Application.PluginStorage` 实时写 `lingxi_batch_progress = {current: 12, total: 30}`
- TaskPane 启动一个轮询读取，显示进度条 toast
- 完成后清除 key

**状态**：✅ **已修** — presentation.js 在 `wpp_render_full_deck` 渲染每页前/后写 `localStorage["lingxi_full_deck_progress_v1"]={batchTag,current,total,label,ts}`；app.js 调用前 `startFullDeckProgressWatcher` 启动 250ms 轮询；taskpane.html 顶部出现 `#fullDeckProgress` 进度条（bar + 标题 + N/M 计数 + 当前页名），完成后自动隐藏；CSS 加 `.full-deck-progress*` 系列样式。

---

### #7 统一修改 chat 撞 rate limit / 不可取消

**问题**：[`submitUnifiedModifyChat`](plugin/js/app.js) 对每条 cache entry 单独跑 AI，20 条 = 20 次 API 调用。
- 撞 rate limit 时仅记 errs 不退避重试
- 跑到一半想停下来 → 没按钮
- pending bubble 只更新文本，看不到 "已处理 12/20"

**修复方案**：
- 加进度条 bubble (`<progress max=20 value=12>`)
- 加「停止」按钮，按下后 `_unifiedAborted = true`，循环 break
- 429 / 5xx 错误自动 `setTimeout(retry, 2 ** attempt * 1000)` 指数退避，最多 3 次

**状态**：✅ **已修** — 抽出 `unifiedPatchOneWithRetry`：识别 429/5xx/network 三类错，指数退避 1s/2s/4s 最多 3 次；插入 `.unified-progress` bubble，含「停止」按钮，按下置 `_unifiedAborted = true`，循环开头检查直接 break；进度条 `<progress>` + "已处理 N/M" 标签实时更新。

---

### #8 选用组件注入 prompt 可能爆长度

**问题**：[`submitHtmlPreviewChat componentReuseBlock`](plugin/js/app.js) 把选中组件的完整 html+css 全注入 system prompt。
- 选 5 个组件 ≈ 10-15KB
- 加上其他内容，prompt 轻松 20KB+
- DeepSeek-V2 32K context 会被打爆

**修复方案**：
- 单组件 html+css 超过 3KB 截断尾部，加 `... (truncated, see component-id)` 标记
- 总长度 > 15KB 时提示用户 "选了太多组件，建议精简"
- 改用 outline 模式：只注入 name + description + 关键结构，AI 想要完整就调一个新工具 `get_component_full(id)`

**状态**：✅ **已修** — `submitHtmlPreviewChat` 加 `truncCode(code, max)`：SINGLE_LIMIT=3000 字符截断尾部并附"已截断 X 字符"提示；累计字符 >TOTAL_WARN_LIMIT=15000 时 chat 里 push 一条 `ai-err` 警告 "选中的 N 个组件总长度约 X KB，可能撑爆 prompt 上下文，建议精简"。

---

### #9 画廊缩略图 20 个 iframe 同时重建

**问题**：[`renderHtmlTemplateGallery`](plugin/js/app.js) 任何 cache 变动都 clear + 重建全部 20 张。
- 单次保存 → 20 个 iframe 销毁重建 → 视觉抖动
- 跑 echarts 桥接 ×20、字体加载 ×20

**修复方案**：
- diff 渲染：维护 `_galleryCards: Map<entryId, cardEl>`，按 cache.list() 顺序 reuse 已有 DOM
- 只对 `ts` 变化的 entry 重建 iframe，其他保留
- delete 时只移除对应 DOM

**状态**：✅ **已修** — `renderHtmlTemplateGallery` 改写为 desc 描述 + diff 应用：每个卡 `key=身份` (tab+id) `sig=内容签名` (ts+paletteSig+draft 标志)；维护模块级 `_galleryCardCache: Map<key, {el, sig}>`；sig 不变 → 复用现有 iframe（只切 active/draft class）；sig 变 → rebuild 单卡；旧 key 不在期望集 → 移除该卡。20 张里只有保存/编辑/删除的那条会重建 iframe。

---

### #10 组件库 200 条 FIFO 上限会丢老组件

**问题**：[`components.js`](plugin/js/html-templates/components.js) `MAX_ENTRIES=200`，超出时默默淘汰第一个。

**修复方案**：
- 超限时不淘汰，弹错误 "组件库已满 (200/200)，请先删除一些再存"
- 或：只淘汰**未被任何 slide picked** 的组件（picked-by-key 反向查询）
- 加 "锁定" 标记，锁定的组件不会被淘汰

**状态**：⬜ 待修（v2）

---

## 🟡 低风险（边界情况）

### #11 `parsePreviewChatJson` 误吃无关 `{}`

**问题**：AI 返回 "改成 `{看起来像 JSON}`，然后 `{真正的 patch}`" 时，函数取 `s.indexOf("{") ... s.lastIndexOf("}")` 会把中间文字一起 parse → 失败。

**修复方案**：
- 优先匹配 markdown 围栏 ` ```json ... ``` `
- 失败再尝试 RegExp 找最大平衡花括号
- 还失败才 fallback 到首末花括号

**状态**：✅ **已修** — `parsePreviewChatJson` 三级降级：①markdown 围栏内 parse；②扫描配平花括号（正确处理字符串内的 `{` `}` 和转义引号）列出所有顶层对象，挑最长能 parse 的；③老路径 first {/ last } 兜底。

---

### #13 缓存清空时未通知打开的预览

**问题**：清空 cache 时正在打开的预览 dialog 的 `state.id` 仍指向已删除的 cache id。
- 用户点 Save → `cache.update(id)` 返回 null → fallback save 新建
- 但 chat 日志、picked components 还在旧 key 下未迁移

**修复方案**：
- clear 时通过 storage 事件广播 `lingxi_cache_cleared = Date.now()`
- dialog 监听后把 state.id 置 null + 提示 "缓存已被清空，当前为新建模式"

**状态**：⬜ 待修（v2）

---

### #14 编辑器 resize 只能从右下角拖

**问题**：PS / Figma 用户习惯 8 个 handle（4 边 + 4 角）。当前只支持右下角。

**修复方案**：
- 选中态 overlay 加 8 个 handle，每个 `data-resize-dir="n|s|e|w|ne|nw|se|sw"`
- mousedown 时按 dir 计算 delta 应用到对应轴：
  - `s/se/sw`: 改 `height`
  - `n/ne/nw`: 改 `height` 同时 transform translate `+dy`
  - `e/ne/se`: 改 `width`
  - `w/nw/sw`: 改 `width` 同时 transform translate `+dx`

**状态**：⬜ 待修（v2）

---

### #15 多选 group-drag 只平移不改 width/height

**问题**：[`startEditorGroupDrag`](plugin/js/app.js) 用 `transform: translate` —— 实际 DOM 位置没变。切回 fixed layout 重渲会丢失 transform。

**修复方案**：
- 拖动结束时把 transform 解析后写入实际 left/top（如果原元素是 absolute）
- 或：persistEditorChangesToState 序列化时把所有 transform 烘焙成实际坐标

**状态**：⬜ 待修（v2）

---

### #16 AI 不知道何时用 single vs full_deck

**问题**：两个工具描述都说 "用 me"。AI 习惯一页一页规划，可能继续逐个调 `wpp_render_html_template`。

**修复方案**：
- 在系统提示里加 routing 规则：
  > 用户说 "做一份 PPT" / "N 页" (N>=3) / "整套" → 必须用 `wpp_render_full_deck`
  > 用户说 "新增一页" / "改这页" / "再来一张" → 用 `wpp_render_html_template`
- 工具描述里互相引用："看 N 页以上用 wpp_render_full_deck 一次搞定"

**状态**：✅ **已修** — `wpp_render_full_deck` 描述顶部加「何时必须用本工具（vs wpp_render_html_template）」分支表：「整套」「N 页（N≥3）」必须用 deck，「新增一页」「改这页」用单页；`wpp_render_html_template` 顶部加「适用场景」段反向引用，明确「1-2 页用本工具，≥3 页改用 wpp_render_full_deck」。

---

### #17 固定 layout 字号无法 AI 调节

**问题**：[`studio.js`](plugin/js/html-templates/templates/studio.js) cover/content/stat 等 layout 的字号 hardcoded（如 `font-size: 200px`）。
- 字数多了显示溢出
- AI 改 data 字符串没用

**修复方案**：
- 每个固定 layout 暴露可选 `titleSize` / `bodySize` 字段
- render 函数用 `data.titleSize || 200`
- 工具描述里加这些字段说明
- 兼容：未传时仍用默认值

**状态**：✅ **已修** — studio.js 加 `sanitizeSize(v, fallback, min, max)` 工具（接受 px / pt / 纯数字，越界回 fallback）；cover 暴露 titleSize/subtitleSize；content 暴露 titleSize/bodySize；stat 暴露 numberSize/labelSize/descSize；fields[] 同步更新；工具描述加范围说明（如 cover `titleSize=40-320px`）让 AI 学会自调。

---

## 🟢 设计建议（不是 bug）

### #18 缺少 `wpp_edit_html_slide` 工具

**问题**：AI 改已有页只能：
- 让用户在弹窗手动 chat — AI 工具无法触发
- 重新调 `wpp_render_html_template` 给新 data — 失去原页 id 关联

**修复方案**：新加工具：
```
wpp_edit_html_slide(cacheId, dataPatch?, layoutPatch?, palettePatch?)
```
- 找到对应 cache entry，apply patch
- 重新 render + 找到原 slide → clearShapes + AddPicture
- update cache 时间戳

**状态**：⬜ 待修（v2）

---

### #19 整页存为组件没限制

**问题**：用户写完整页存为组件 → 一个组件包含 N 个元素 + 整页 CSS。后续选用时被注入 → prompt 爆炸（见 #8）。

**修复方案**：
- 整页组件入库时算 `html.length + css.length`
- 超过 5KB 给警告 "整页组件较大 (X KB)，AI 选用时可能影响响应速度"
- 提供 "压缩" 选项：自动跑一次 minify

**状态**：✅ **已修** — `confirmSaveAsComponent` 在 `save()` 前算 totalBytes，> 5KB 时弹原生 confirm：显示 "X KB / 阈值 5KB"，提示"组件被选用时会整段注入 AI 上下文，建议在编辑器里只选关键区块再保存"，给「继续保存 / 取消」两选项。压缩功能留 v3。

---

### #20 单页路径的缓存 vs 状态不一致

**问题**：`doRenderAndInsert` 不写缓存。缓存写在 preview=true 的 onConfirm 内部（app.js）+ preview=false 路径（presentation.js）。
- 跨文件 + 异步 + 多入口 → 缓存写失败的 race 难调试

**修复方案**：
- 把 `cache.save` 统一放到 `doRenderAndInsert` 末尾
- 删除 app.js 里 onConfirm 包装的 cache 调用
- 只有一个地方写缓存，权责清晰

**状态**：⬜ 待修（v2）

---

## 修复优先级

### 应立即修（5 条，影响数据正确性）✅ **全部完成**
- [x] #1 batch 撤销 + draft 标记
- [x] #3 preview=true 立即写缓存 draft
- [x] #4 fallback 路径走 doRenderAndInsert 直接调用
- [x] #5 layout 切换前确认未保存改动
- [x] #12 dialog X 关闭兜底 onConfirm(null)

### 1-2 周内做（4 条，体验显著提升）✅ **全部完成**
- [x] #6 batch 进度反馈
- [x] #7 统一修改可取消 + 进度
- [x] #8 组件注入 prompt 截断
- [x] #9 画廊 diff 渲染

### 有空再做（11 条，nice-to-have）— 已完成 5 / 11
- [x] #2 palette 优先级调整（描述同步修正）
- [ ] #10 组件库满了不淘汰
- [x] #11 JSON 解析更鲁棒
- [ ] #13 缓存清空广播
- [ ] #14 八向 resize
- [ ] #15 group-drag 烘焙到实际坐标
- [x] #16 AI 工具路由规则
- [x] #17 固定 layout 字号可调
- [ ] #18 新加 wpp_edit_html_slide 工具
- [x] #19 整页组件大小警告
- [ ] #20 cache 写入统一到 doRenderAndInsert
