/**
 * 多对话管理：把每次 AI 助手的对话保存成独立 conversation，
 * 可以新建、切换、删除。
 *
 * 数据条目结构：
 *   {
 *     id: 'c-...',
 *     title: '帮我润色这段...',   // 从第一句 user message 自动生成
 *     createdAt: 1683830400000,
 *     updatedAt: 1683830900000,
 *     messages: [
 *       { role: 'user', content: '...' },
 *       { role: 'assistant', content: '...' },
 *       ...
 *     ]
 *   }
 *
 * 持久化：localStorage 'lingxi_conversations_v1'，限 MAX 条 FIFO；
 *         当前激活 id 存 'lingxi_current_conversation_v1'。
 *
 * 注意：messages 只存原始 user/assistant 文本（即 chatHistory 数组本身）。
 * 工具调用 / tool_result / 推理这些过程不进 conversation，因为切换重放
 * 它们没意义（旧调用不会被复执行，且会污染上下文）。
 */
(function attachConversations(global) {
  "use strict";

  const STORAGE_KEY = "lingxi_conversations_v1";
  const CURRENT_KEY = "lingxi_current_conversation_v1";
  const MAX_CONVS = 50;
  const TITLE_MAX_LEN = 40;

  let conversations = loadAll();
  let currentId = loadCurrentId();
  const listeners = new Set();

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); }
    catch (e) {
      // 存满了，砍一半重试一次
      if (e?.name === "QuotaExceededError" && conversations.length > 5) {
        conversations = conversations.slice(-Math.floor(conversations.length / 2));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch (_) {}
      }
    }
  }

  function loadCurrentId() {
    try { return localStorage.getItem(CURRENT_KEY) || null; } catch (e) { return null; }
  }

  function persistCurrentId() {
    try {
      if (currentId) localStorage.setItem(CURRENT_KEY, currentId);
      else localStorage.removeItem(CURRENT_KEY);
    } catch (e) {}
  }

  function notify() {
    listeners.forEach((fn) => { try { fn(); } catch (e) {} });
  }

  function newId() {
    return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function deriveTitle(messages) {
    const firstUser = messages.find((m) => m.role === "user");
    const text = firstUser ? String(firstUser.content || "").trim().replace(/\s+/g, " ") : "";
    if (!text) return "新对话";
    return text.length > TITLE_MAX_LEN ? text.slice(0, TITLE_MAX_LEN) + "…" : text;
  }

  function getCurrent() {
    if (!currentId) return null;
    return conversations.find((c) => c.id === currentId) || null;
  }

  // 返回按 updatedAt 倒序的副本；不暴露内部引用
  function listConversations() {
    return conversations.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // 创建新对话，立刻成为 current。返回新对话对象
  function createNew() {
    const conv = {
      id: newId(),
      title: "新对话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    conversations.push(conv);
    if (conversations.length > MAX_CONVS) {
      conversations = conversations.slice(-MAX_CONVS);
    }
    currentId = conv.id;
    persist();
    persistCurrentId();
    notify();
    return conv;
  }

  function switchTo(id) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return null;
    currentId = id;
    persistCurrentId();
    notify();
    return conv;
  }

  function deleteById(id) {
    conversations = conversations.filter((c) => c.id !== id);
    if (currentId === id) {
      currentId = null;
      persistCurrentId();
    }
    persist();
    notify();
  }

  function rename(id, newTitle) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return false;
    conv.title = String(newTitle || "").trim().slice(0, TITLE_MAX_LEN * 2) || conv.title;
    conv.updatedAt = Date.now();
    persist();
    notify();
    return true;
  }

  // 把 app.js 的 chatHistory 数组同步到当前对话（每轮结束 + 清空时调用）
  // 如果没有 current，自动创建一个
  function syncMessages(messages) {
    let current = getCurrent();
    if (!current) {
      current = createNew();
    }
    current.messages = (messages || []).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }));
    current.updatedAt = Date.now();
    // 标题：只在还是默认"新对话"时根据首句用户消息自动生成
    if (current.title === "新对话" && messages && messages.length > 0) {
      current.title = deriveTitle(messages);
    }
    persist();
    notify();
  }

  // 切到某对话并把 messages 数组返回给调用方（让 app.js 用来重建 chat UI）
  function loadAsActive(id) {
    const conv = switchTo(id);
    if (!conv) return null;
    return conv.messages.slice();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  global.WpsAiConversations = {
    listConversations,
    getCurrent,
    getCurrentId: () => currentId,
    createNew,
    switchTo,
    loadAsActive,
    deleteById,
    rename,
    syncMessages,
    subscribe,
    MAX_CONVS
  };
})(window);
