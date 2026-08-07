const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTimeline(documentStub) {
  const context = { window: {}, console };
  if (documentStub) context.document = documentStub;
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "chat", "timeline.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiChatTimeline;
}

// ---- buildTurnSteps 产出扁平有序步骤（不分组）；有序交织（文本块 / run）交给 buildTurnItems ----

test("buildTurnSteps：tool_call+tool_result 折叠成一个 ok 工具步骤，顺序保留", () => {
  const T = loadTimeline();
  const steps = T.buildTurnSteps([
    { type: "reasoning", text: "先想想" },
    { type: "tool_call", name: "et_read_range", args: { a: 1 } },
    { type: "tool_result", name: "et_read_range", result: { ok: true, value: 42 } },
    { type: "assistant", text: "读到了" }
  ]);
  assert.deepEqual(steps.map((s) => s.kind), ["reasoning", "tool", "text"]);
  assert.equal(steps[1].status, "ok");
  assert.deepEqual(steps[1].result, { ok: true, value: 42 });
  assert.equal(steps[2].text, "读到了");
});

// ---- buildTurnItems：有序交织模型（文本块 / run 摘要 / 错误块） ----

// 把 item 列表归纳成可比较的紧凑序列：text→"text"、run→"run:{工具数}"、error→"error"。
function itemKinds(items) {
  return items.map((it) => {
    if (it.kind === "run") return "run:" + it.items.filter((s) => s.kind === "tool").length;
    return it.kind;
  });
}

test("buildTurnItems：[tool,reasoning,tool] 合成一个 run（count=2，思考折进去，不打断）", () => {
  const T = loadTimeline();
  const items = T.buildTurnItems(T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "reasoning", text: "中间想一下" },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } }
  ]));
  assert.deepEqual(itemKinds(items), ["run:2"]);        // 一个 run，两个工具
  assert.equal(items[0].items.filter((s) => s.kind === "reasoning").length, 1); // 思考折在 run 里
});

test("buildTurnItems：文本打断 run → 两个独立 run（各 1 工具），文本块夹在中间", () => {
  const T = loadTimeline();
  const items = T.buildTurnItems(T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "assistant", text: "中间说一句" },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } }
  ]));
  assert.deepEqual(itemKinds(items), ["run:1", "text", "run:1"]);
});

test("buildTurnItems：纯思考 run（无工具，随后正文）→ run 标「思考过程」+ 文本块", () => {
  const T = loadTimeline();
  const items = T.buildTurnItems(T.buildTurnSteps([
    { type: "reasoning", text: "只想" },
    { type: "assistant", text: "结论" }
  ]));
  assert.deepEqual(itemKinds(items), ["run:0", "text"]);
  assert.equal(items[0].items.filter((s) => s.kind === "reasoning").length, 1);
});

test("buildTurnItems：整轮交织 text1,[tool,reasoning,tool],text2,[tool],text3 → 有序 item 列表", () => {
  const T = loadTimeline();
  const items = T.buildTurnItems(T.buildTurnSteps([
    { type: "assistant", text: "text1" },
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "reasoning", text: "中间推理" },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } },
    { type: "assistant", text: "text2" },
    { type: "tool_call", name: "c", args: {} },
    { type: "tool_result", name: "c", result: { ok: true } },
    { type: "assistant", text: "text3" }
  ]));
  // 顺序是重点：text1 / run(2 工具，含中间推理) / text2 / run(1 工具) / text3
  assert.deepEqual(itemKinds(items), ["text", "run:2", "text", "run:1", "text"]);
});

test("buildTurnItems：EMPTY/空白 assistant 文本夹在两个工具之间 → 合并成一个 run（不打断），非空文本仍会打断", () => {
  const T = loadTimeline();

  const merged = T.buildTurnItems(T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "assistant", text: "" },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } }
  ]));
  assert.deepEqual(itemKinds(merged), ["run:2"]); // 空文本被整步跳过，两个工具合并成一个 run

  const mergedWhitespace = T.buildTurnItems(T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "assistant", text: "   \n  " },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } }
  ]));
  assert.deepEqual(itemKinds(mergedWhitespace), ["run:2"]); // 纯空白同样跳过

  const split = T.buildTurnItems(T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "assistant", text: "真的说了点什么" },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } }
  ]));
  assert.deepEqual(itemKinds(split), ["run:1", "text", "run:1"]); // 非空文本仍然打断，不能被过度跳过
});

test("live==replay：EMPTY assistant 文本夹在两个工具之间 → 两路都合并成一个 run；非空文本两路都仍产生两个 run + 可见文本块", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);

  const emptySeq = [
    { t: "tool", name: "a", result: { ok: true } },
    { t: "text", text: "" },
    { t: "tool", name: "b", result: { ok: true } }
  ];
  const liveEmpty = T.beginAssistantTurn({ meta: {} });
  driveLive(liveEmpty, emptySeq);
  const replayEmpty = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(emptySeq)) });

  assert.deepEqual(railItems(liveEmpty.node), railItems(replayEmpty));
  assert.deepEqual(railKinds(liveEmpty.node), ["run:2"]);  // 一个 run，两个工具合并，无空文本块
  assert.deepEqual(railKinds(replayEmpty), ["run:2"]);

  const textSeq = [
    { t: "tool", name: "a", result: { ok: true } },
    { t: "text", text: "中间真说了话" },
    { t: "tool", name: "b", result: { ok: true } }
  ];
  const liveText = T.beginAssistantTurn({ meta: {} });
  driveLive(liveText, textSeq);
  const replayText = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(textSeq)) });

  assert.deepEqual(railItems(liveText.node), railItems(replayText));
  assert.deepEqual(railKinds(liveText.node), ["run:1", "text", "run:1"]); // 非空文本仍然打断成两个 run
  assert.equal(railItems(liveText.node)[1].text, "中间真说了话");
});

test("stepStatusFromResult", () => {
  const T = loadTimeline();
  assert.equal(T.stepStatusFromResult({ ok: true }), "ok");
  assert.equal(T.stepStatusFromResult({ ok: false }), "error");
  assert.equal(T.stepStatusFromResult(null), "ok");
});

// 最小 document stub：记录 createElement/className/children，够验证结构，不渲染。
function makeDocStub() {
  function el(tag) {
    return {
      tagName: tag, className: "", dataset: {}, children: [], textContent: "", _attrs: {},
      _html: "", set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      replaceChild(nw, old) { const i = this.children.indexOf(old); if (i >= 0) this.children[i] = nw; else this.children.push(nw); return old; },
      insertBefore(nw, ref) { const i = this.children.indexOf(ref); if (i >= 0) this.children.splice(i, 0, nw); else this.children.push(nw); return nw; },
      setAttribute(k, v) { this._attrs[k] = v; if (k.indexOf("data-") === 0) this.dataset[k.replace(/^data-/, "")] = v; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
      removeAttribute(k) { delete this._attrs[k]; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { // 只支持按 class 递归查
        const cls = sel.replace(".", ""); const out = [];
        (function walk(n) { for (const c of n.children) { if ((c.className || "").split(" ").includes(cls)) out.push(c); walk(c); } })(this);
        return out;
      },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
    };
  }
  return { createElement: (t) => el(t) };
}

function hasClass(node, cls) { return (node.className || "").split(" ").includes(cls); }

// 取 AI 轮节点里 .tl-rail 的直接子节点，按顺序归纳成 item 描述——顺序现在就是全部意义所在。
// text→{kind,text}；run→{kind,label,tools,status}；error→{kind,text}。
function railItems(node) {
  const rail = node.querySelectorAll(".tl-rail")[0];
  return rail.children.map((c) => {
    if (hasClass(c, "tl-step-process")) {
      return {
        kind: "run",
        label: c.querySelectorAll(".tl-step-name")[0].textContent,
        tools: c.querySelectorAll(".tl-tool-row").length,
        reasonings: c.querySelectorAll(".tl-proc-reasoning").length,
        status: c.querySelectorAll(".tl-step-status")[0].className
      };
    }
    if (hasClass(c, "tl-error")) return { kind: "error", text: c.textContent };
    return { kind: "text", text: c.textContent };
  });
}

// 只留 kind + run 工具数的紧凑指纹（顺序敏感）。
function railKinds(node) {
  return railItems(node).map((it) => (it.kind === "run" ? "run:" + it.tools : it.kind));
}

test("renderAssistantTurn：思考+工具+末尾正文 → run（1 工具，思考折进去）+ 文本块，顺序正确", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const steps = T.buildTurnSteps([
    { type: "reasoning", text: "想" },
    { type: "tool_call", name: "et_read_range", args: {} },
    { type: "tool_result", name: "et_read_range", result: { ok: true } },
    { type: "assistant", text: "答案" }
  ]);
  const node = T.renderAssistantTurn({ steps, meta: { model: "gpt-x", elapsedMs: 1200 } });
  const items = railItems(node);
  assert.deepEqual(railKinds(node), ["run:1", "text"]);
  assert.equal(items[0].reasonings, 1);          // 思考折进 run 详情
  assert.match(items[0].label, /1/);             // 「调用了 1 个工具」
  assert.equal(items[1].text, "答案");
});

test("renderAssistantTurn：文本把整轮工具切成多个 run（非一条顶部摘要），顺序保留", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const steps = T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "assistant", text: "中间说一句" },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: true } },
    { type: "tool_call", name: "c", args: {} },
    { type: "tool_result", name: "c", result: { ok: true } },
    { type: "assistant", text: "结论" }
  ]);
  const node = T.renderAssistantTurn({ steps });
  // 旧模型会 hoist 成一条顶部摘要 + 答案；新模型按顺序交织：run(1) / text / run(2) / text
  assert.deepEqual(railKinds(node), ["run:1", "text", "run:2", "text"]);
  const items = railItems(node);
  assert.equal(items[1].text, "中间说一句");
  assert.equal(items[3].text, "结论");
});

test("renderAssistantTurn：纯文本轮 → 只有文本块，无 run", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const node = T.renderAssistantTurn({ steps: T.buildTurnSteps([{ type: "assistant", text: "只有答案" }]) });
  assert.deepEqual(railKinds(node), ["text"]);
  assert.equal(railItems(node)[0].text, "只有答案");
});

test("renderAssistantTurn：以工具收尾（无末尾正文）→ 末尾是 run，无尾随文本块", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const node = T.renderAssistantTurn({ steps: T.buildTurnSteps([
    { type: "assistant", text: "我来查一下" },
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } }
  ]) });
  assert.deepEqual(railKinds(node), ["text", "run:1"]); // 叙述文本块可见，后接 run
  assert.equal(railItems(node)[0].text, "我来查一下");
});

test("renderAssistantTurn：纯思考 run（无工具）→ 标「思考过程」", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const node = T.renderAssistantTurn({ steps: T.buildTurnSteps([{ type: "reasoning", text: "只想没说" }]) });
  const items = railItems(node);
  assert.deepEqual(railKinds(node), ["run:0"]);
  assert.equal(items[0].label, "思考过程");
  assert.equal(items[0].reasonings, 1);
});

test("状态聚合：run 内任一工具 error → status=error；有 running → running", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const errNode = T.renderAssistantTurn({ steps: T.buildTurnSteps([
    { type: "tool_call", name: "a", args: {} },
    { type: "tool_result", name: "a", result: { ok: true } },
    { type: "tool_call", name: "b", args: {} },
    { type: "tool_result", name: "b", result: { ok: false, error: "boom" } }
  ]) });
  assert.match(railItems(errNode)[0].status, /tl-step-status-error/);

  const runNode = T.renderAssistantTurn({ steps: T.buildTurnSteps([{ type: "tool_call", name: "x", args: {} }]) });
  assert.match(railItems(runNode)[0].status, /tl-step-status-running/);
});

// ---- live==replay：同一事件序列，实时增量与批量回放产出结构一致的 DOM ----

// 按 app.js handleStreamEvent 的调用模式驱动 live 句柄。
function driveLive(turn, seq) {
  for (const ev of seq) {
    if (ev.t === "reasoning") {
      turn.updateReasoning(ev.text);   // reasoning_chunk
      turn.endReasoning();             // reasoning_end
    } else if (ev.t === "text") {
      turn.endReasoning();             // assistant_chunk 里出正文即收尾思考
      turn.setText(ev.text);           // assistant_chunk
      turn.finalizeText(ev.text);      // assistant_text_end
    } else if (ev.t === "tool") {
      turn.endReasoning();             // tool_call
      turn.sealText();                 // 封口当前文本块（留其可见）
      const ref = turn.addToolStep(ev.name, ev.args || {});
      turn.finishToolStep(ref, ev.result); // tool_result
    }
  }
  turn.endReasoning();                 // done（新模型 done 不再 sealText）
}

// 同一序列 → 回放用的 turnEvents。
function toTurnEvents(seq) {
  const out = [];
  for (const ev of seq) {
    if (ev.t === "reasoning") out.push({ type: "reasoning", text: ev.text });
    else if (ev.t === "text") out.push({ type: "assistant", text: ev.text });
    else if (ev.t === "tool") {
      out.push({ type: "tool_call", name: ev.name, args: ev.args || {} });
      out.push({ type: "tool_result", name: ev.name, result: ev.result });
    }
  }
  return out;
}

test("live==replay：中间思考不打断 run —— text1,tool,reasoning,tool,text2,reasoning,tool,text3", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const seq = [
    { t: "text", text: "text1" },
    { t: "tool", name: "a", result: { ok: true } },
    { t: "reasoning", text: "中间推理" },
    { t: "tool", name: "b", result: { ok: true } },
    { t: "text", text: "text2" },
    { t: "reasoning", text: "又想一下" },
    { t: "tool", name: "c", result: { ok: true } },
    { t: "text", text: "text3" }
  ];

  const live = T.beginAssistantTurn({ meta: { model: "m" } });
  driveLive(live, seq);
  const replay = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(seq)) });

  // 有序交织逐项一致（顺序敏感的深比较）
  assert.deepEqual(railItems(live.node), railItems(replay));
  // 且确实收敛到期望的形状：text1 / run(2 工具，含中间推理) / text2 / run(1 工具，含 leading 推理) / text3
  assert.deepEqual(railKinds(live.node), ["text", "run:2", "text", "run:1", "text"]);
  const items = railItems(live.node);
  assert.equal(items[0].text, "text1");
  assert.equal(items[1].reasonings, 1);   // 中间推理折进第一个 run
  assert.equal(items[2].text, "text2");
  assert.equal(items[3].reasonings, 1);   // leading 推理折进第二个 run
  assert.equal(items[4].text, "text3");
});

test("live==replay：混合序列 text1,tool,text2,reasoning,tool,tool,text3 结构一致", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const seq = [
    { t: "text", text: "我先读表格" },
    { t: "tool", name: "a", result: { ok: true } },
    { t: "text", text: "再想想怎么写" },
    { t: "reasoning", text: "推理一下" },
    { t: "tool", name: "b", result: { ok: true } },
    { t: "tool", name: "c", result: { ok: true } },
    { t: "text", text: "最终答案" }
  ];

  const live = T.beginAssistantTurn({ meta: { model: "m" } });
  driveLive(live, seq);
  const replay = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(seq)) });

  assert.deepEqual(railItems(live.node), railItems(replay));
  assert.deepEqual(railKinds(live.node), ["text", "run:1", "text", "run:2", "text"]);
  const items = railItems(live.node);
  assert.equal(items[3].reasonings, 1);   // 推理折进第二个 run（2 工具）
  assert.match(items[3].label, /2/);
  assert.equal(items[4].text, "最终答案");
});

test("live==replay：纯文本轮不产生 run", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const seq = [{ t: "text", text: "就一句话" }];

  const live = T.beginAssistantTurn({ meta: {} });
  driveLive(live, seq);
  const replay = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(seq)) });

  assert.deepEqual(railItems(live.node), railItems(replay));
  assert.deepEqual(railKinds(live.node), ["text"]);
  assert.equal(railItems(live.node)[0].text, "就一句话");
});

test("live==replay：以工具收尾（无末尾正文）两路一致，末尾是 run，叙述文本块仍可见", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const seq = [
    { t: "text", text: "我来查一下" },
    { t: "tool", name: "a", result: { ok: true } }
  ];

  const live = T.beginAssistantTurn({ meta: {} });
  driveLive(live, seq);
  const replay = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(seq)) });

  assert.deepEqual(railItems(live.node), railItems(replay));
  assert.deepEqual(railKinds(live.node), ["text", "run:1"]); // 文本块不再被降级/隐藏
  assert.equal(railItems(live.node)[0].text, "我来查一下");
});

test("live==replay：showToolCallLogs → run 详情默认展开（expandTools 两路同分支）", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const seq = [{ t: "tool", name: "a", result: { ok: true } }, { t: "text", text: "好了" }];

  const live = T.beginAssistantTurn({ meta: {} });
  // 模拟 handleStreamEvent 里 showToolCallLogs 开启时 tool_call/tool_result 后调 expandToolStep
  live.endReasoning();
  const ref = live.addToolStep("a", {});
  live.expandToolStep(ref);
  live.finishToolStep(ref, { ok: true });
  live.expandToolStep(ref);
  live.setText("好了"); live.finalizeText("好了");
  live.endReasoning();

  const replay = T.renderAssistantTurn({ steps: T.buildTurnSteps(toTurnEvents(seq)), expandTools: true });

  const liveDetail = live.node.querySelectorAll(".tl-step-detail")[0];
  const replayDetail = replay.querySelectorAll(".tl-step-detail")[0];
  assert.equal(liveDetail.hasAttribute("hidden"), false);
  assert.equal(replayDetail.hasAttribute("hidden"), false);
});

test("renderUserMessage：quickAction 渲成可展开盒子（带 data-quickaction）", () => {
  const doc = makeDocStub();
  const T = loadTimeline(doc);
  const node = T.renderUserMessage({ text: "全文润色", quickAction: { label: "润色", prompt: "把全文润色得更专业" } });
  assert.equal(node.dataset.quickaction, "1");
});
