(function attachMaterialLibrary(global) {
  "use strict";

  const KEY = "lingxi_material_library_v1";
  const MAX_ENTRIES = 80;
  const ALL_GROUP_ID = "all";
  const DEFAULT_GROUP_ID = "default";

  function nowId() {
    return "img-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function readStore() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const entries = (Array.isArray(parsed.entries) ? parsed.entries : [])
        .map(normalizeEntry)
        .filter(Boolean);
      const groups = normalizeGroups(parsed.groups);
      return { entries, groups };
    } catch (e) {
      return { entries: [], groups: normalizeGroups([]) };
    }
  }

  function normalizeGroups(groups) {
    const seen = new Set();
    const out = [];
    (Array.isArray(groups) ? groups : []).forEach((group) => {
      const id = String(group?.id || "").trim();
      const name = String(group?.name || "").trim();
      if (!id || id === ALL_GROUP_ID || seen.has(id)) return;
      out.push({ id, name: name || "未命名分组", ts: Number(group.ts) || Date.now() });
      seen.add(id);
    });
    if (!seen.has(DEFAULT_GROUP_ID)) {
      out.unshift({ id: DEFAULT_GROUP_ID, name: "未分组", ts: 0 });
    }
    return out;
  }

  function normalizeGroupId(groupId) {
    const id = String(groupId || "").trim();
    if (!id || id === ALL_GROUP_ID) return DEFAULT_GROUP_ID;
    return id;
  }

  function writeStore(storeOrEntries) {
    const store = Array.isArray(storeOrEntries)
      ? { entries: storeOrEntries, groups: readStore().groups }
      : (storeOrEntries || {});
    const trimmed = (Array.isArray(store.entries) ? store.entries : [])
      .filter((item) => item && (item.url || item.dataUrl))
      .map(normalizeEntry)
      .filter(Boolean)
      .slice(0, MAX_ENTRIES);
    const groups = normalizeGroups(store.groups);
    try {
      localStorage.setItem(KEY, JSON.stringify({ entries: trimmed, groups, savedAt: Date.now() }));
      return true;
    } catch (e) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ entries: trimmed.slice(0, 30), groups, savedAt: Date.now() }));
        return true;
      } catch (e2) {
        console.warn("[material-library] 写入失败:", e2?.message || e2);
        return false;
      }
    }
  }

  function normalizeEntry(input) {
    const item = input || {};
    const url = String(item.url || "").trim();
    const dataUrl = String(item.dataUrl || "").trim();
    if (!url && !dataUrl) return null;
    return {
      id: item.id || nowId(),
      url,
      dataUrl,
      prompt: String(item.prompt || "").trim(),
      revisedPrompt: String(item.revisedPrompt || "").trim(),
      size: String(item.size || "").trim(),
      resolution: String(item.resolution || "").trim(),
      model: String(item.model || "").trim(),
      providerType: String(item.providerType || "").trim(),
      groupId: normalizeGroupId(item.groupId),
      ts: Number(item.ts) || Date.now()
    };
  }

  function add(input) {
    const entry = normalizeEntry(input);
    if (!entry) return null;
    const store = readStore();
    const key = entry.url || entry.dataUrl;
    const next = store.entries.filter((it) => (it.url || it.dataUrl) !== key);
    next.unshift(entry);
    writeStore({ entries: next, groups: store.groups });
    notify();
    return entry;
  }

  function addMany(items, meta = {}) {
    const added = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      const entry = add(Object.assign({}, meta, item));
      if (entry) added.push(entry);
    });
    return added;
  }

  function list(opts = {}) {
    const store = readStore();
    const groupId = opts?.groupId || ALL_GROUP_ID;
    if (!groupId || groupId === ALL_GROUP_ID) return store.entries;
    return store.entries.filter((item) => normalizeGroupId(item.groupId) === groupId);
  }

  function listGroups() {
    const store = readStore();
    const counts = new Map();
    store.entries.forEach((item) => {
      const id = normalizeGroupId(item.groupId);
      counts.set(id, (counts.get(id) || 0) + 1);
    });
    return [
      { id: ALL_GROUP_ID, name: "全部", virtual: true, count: store.entries.length },
      ...store.groups.map((group) => Object.assign({}, group, { count: counts.get(group.id) || 0 }))
    ];
  }

  function find(id) {
    return list().find((item) => item.id === id) || null;
  }

  function remove(id) {
    const store = readStore();
    const next = store.entries.filter((item) => item.id !== id);
    if (next.length === store.entries.length) return false;
    writeStore({ entries: next, groups: store.groups });
    notify();
    return true;
  }

  function clear() {
    const store = readStore();
    writeStore({ entries: [], groups: store.groups });
    notify();
  }

  function createGroup(name) {
    const clean = String(name || "").trim();
    if (!clean) return null;
    const store = readStore();
    const exists = store.groups.find((group) => group.name === clean);
    if (exists) return exists;
    const group = {
      id: "grp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      name: clean,
      ts: Date.now()
    };
    writeStore({ entries: store.entries, groups: store.groups.concat(group) });
    notify();
    return group;
  }

  function renameGroup(id, name) {
    const groupId = String(id || "").trim();
    const clean = String(name || "").trim();
    if (!groupId || groupId === ALL_GROUP_ID || groupId === DEFAULT_GROUP_ID || !clean) return false;
    const store = readStore();
    let changed = false;
    const groups = store.groups.map((group) => {
      if (group.id !== groupId) return group;
      changed = true;
      return Object.assign({}, group, { name: clean });
    });
    if (!changed) return false;
    writeStore({ entries: store.entries, groups });
    notify();
    return true;
  }

  function deleteGroup(id) {
    const groupId = String(id || "").trim();
    if (!groupId || groupId === ALL_GROUP_ID || groupId === DEFAULT_GROUP_ID) return false;
    const store = readStore();
    const groups = store.groups.filter((group) => group.id !== groupId);
    if (groups.length === store.groups.length) return false;
    const entries = store.entries.map((entry) => {
      if (normalizeGroupId(entry.groupId) !== groupId) return entry;
      return Object.assign({}, entry, { groupId: DEFAULT_GROUP_ID });
    });
    writeStore({ entries, groups });
    notify();
    return true;
  }

  function moveEntries(ids, groupId) {
    const idSet = new Set(Array.isArray(ids) ? ids.map(String) : [String(ids || "")]);
    idSet.delete("");
    if (!idSet.size) return 0;
    const targetGroupId = normalizeGroupId(groupId);
    const store = readStore();
    let moved = 0;
    const entries = store.entries.map((entry) => {
      if (!idSet.has(entry.id)) return entry;
      moved += 1;
      return Object.assign({}, entry, { groupId: targetGroupId });
    });
    if (!moved) return 0;
    writeStore({ entries, groups: store.groups });
    notify();
    return moved;
  }

  const listeners = new Set();
  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    listeners.forEach((fn) => {
      try { fn(list()); } catch (e) {}
    });
  }

  global.WpsAiMaterialLibrary = {
    add,
    addMany,
    list,
    listGroups,
    find,
    remove,
    clear,
    createGroup,
    renameGroup,
    deleteGroup,
    moveEntries,
    ALL_GROUP_ID,
    DEFAULT_GROUP_ID,
    subscribe
  };
})(window);
