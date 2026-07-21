const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadConversations(initial = []) {
  const db = new Map([
    ["lingxi_conversations_v1", JSON.stringify(initial)],
    ["lingxi_current_conversation_v1", initial[0]?.id || ""]
  ]);
  const context = {
    window: {
      WpsAiChatEvents: {
        sanitizeStandardEvent(ev) {
          return Object.assign({ schema: "lingxi.chat.event.v1" }, ev);
        }
      },
      WpsAiStore: {
        getItem(key) { return db.get(key) || ""; },
        setItem(key, value) { db.set(key, String(value)); },
        removeItem(key) { db.delete(key); },
        mergeList(key, arr) {
          db.set(key, JSON.stringify(arr));
          return arr;
        }
      }
    },
    console
  };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, "..", "js", "conversations.js"), "utf8");
  vm.runInContext(code, context);
  return context.window.WpsAiConversations;
}

test("conversation todos are normalized for old and malformed rows", () => {
  const Conv = loadConversations([{
    id: "c1",
    title: "old",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    events: [],
    todos: [{ id: "a", title: "Do it", status: "bad" }, { title: "" }],
    todoMeta: { enabled: true, source: "test" }
  }]);

  const state = Conv.getConversationTodos("c1");
  assert.equal(state.todos.length, 1);
  assert.equal(state.todos[0].status, "pending");
  assert.equal(state.meta.enabled, true);
});

test("conversation todo replace, patch and clear persist on current conversation", () => {
  const Conv = loadConversations();
  const conv = Conv.createNew({ docKey: "doc" });

  assert.equal(Conv.setConversationTodos(conv.id, [
    { id: "todo-1", title: "Read document" },
    { id: "todo-2", title: "Rewrite summary", status: "pending" }
  ], { source: "long_task" }), true);

  let state = Conv.getConversationTodos(conv.id);
  assert.equal(state.todos.length, 2);
  assert.equal(state.meta.enabled, true);
  assert.equal(state.meta.source, "long_task");

  assert.equal(Conv.patchConversationTodo(conv.id, "todo-2", {
    status: "completed",
    detail: "done"
  }), true);
  state = Conv.getConversationTodos(conv.id);
  assert.equal(state.todos[1].status, "completed");
  assert.equal(state.todos[1].detail, "done");

  assert.equal(Conv.clearConversationTodos(conv.id), true);
  state = Conv.getConversationTodos(conv.id);
  assert.equal(state.todos.length, 0);
  assert.equal(state.meta.enabled, false);
});

test("conversation persists standard chat events v2", () => {
  const Conv = loadConversations();
  const conv = Conv.createNew({ docKey: "doc" });

  Conv.appendTurnEventsV2([
    { type: "message.end", role: "user", text: "hello", ts: 1 },
    { type: "tool.start", tool: { name: "read", args: {} }, ts: 2 }
  ]);

  const loaded = Conv.loadAsActive(conv.id);
  assert.equal(loaded.eventsV2.length, 2);
  assert.equal(loaded.eventsV2[0].schema, "lingxi.chat.event.v1");
  assert.equal(loaded.eventsV2[1].type, "tool.start");
});

test("current conversation doc key can be rebound after document identity upgrade", () => {
  const Conv = loadConversations();
  const conv = Conv.createNew({ docKey: "C:/docs/new.docx" });
  assert.equal(Conv.rebindCurrentDocKey("id:abc-123"), true);
  const current = Conv.getCurrent();
  assert.equal(current.id, conv.id);
  assert.equal(current.docKey, "id:abc-123");
});
