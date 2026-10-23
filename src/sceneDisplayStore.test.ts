import test from "node:test";
import assert from "node:assert/strict";
import { SceneDisplayStore } from "./sceneDisplayStore.ts";

const keyFor = (projectId: string, actorId?: string) => `scene-display:v1:${JSON.stringify([projectId, actorId ?? null])}`;
const items = [
  { id: "machinery:crane", visible: true },
  { id: "personnel:guard", visible: true },
  { id: "import:survey", visible: false },
];

function memoryStorage(initial: [string, string][] = []) {
  const entries = new Map(initial);
  const writes: { key: string; value: string }[] = [];
  return {
    entries,
    writes,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push({ key, value });
      entries.set(key, value);
    },
  };
}

test("display defaults follow the current business catalog until the user supplies an override", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  assert.equal(store.setContext("project", "actor"), true);
  store.setItems(items);
  assert.equal(store.isVisible("machinery:crane"), true);
  assert.equal(store.isVisible("import:survey"), false);
  assert.equal(store.labelsVisible, true);
  assert.equal(store.view, "categories");
  assert.equal(store.isCategoryCollapsed("machinery"), false);
  assert.deepEqual(Object.keys(store.getOverrides()), []);
  assert.equal(storage.writes.length, 0, "loading a catalog does not save business defaults as preferences");

  store.setVisibility(["machinery:crane"], false);
  store.setItems(items.map((item) => ({ ...item, visible: true })));
  assert.equal(store.isVisible("machinery:crane"), false, "an explicit display preference survives a business refresh");
  assert.equal(store.isVisible("import:survey"), true, "an unmodified object follows its new business default");
  assert.equal(storage.writes.length, 1);
  assert.equal(items[0].visible, true, "display changes never mutate caller-owned business objects");
  assert.equal(items[2].visible, false);
});

test("project and account scopes restore all preferences without delimiter collisions", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  store.setContext("project:a", "actor");
  store.setItems(items);
  store.setVisibility(["machinery:crane"], false);
  store.setLabelsVisible(false);
  store.setView("groups");
  store.setCategoryCollapsed("machinery", true);
  const group = store.createGroup("夜间防护", ["machinery:crane", "personnel:guard"]);
  const writesBeforeReload = storage.writes.length;
  assert.equal(store.setContext("project:a", "actor"), false);
  assert.equal(storage.writes.length, writesBeforeReload);

  for (const [projectId, actorId] of [["project", "a:actor"], ["project:a", "other"], ["project:a", undefined]] as const) {
    assert.equal(store.setContext(projectId, actorId), true);
    store.setItems(items);
    assert.equal(store.isVisible("machinery:crane"), true);
    assert.equal(store.labelsVisible, true);
    assert.equal(store.view, "categories");
    assert.equal(store.isCategoryCollapsed("machinery"), false);
    assert.deepEqual(store.getGroups(), []);
  }

  const restored = new SceneDisplayStore(storage);
  restored.setContext("project:a", "actor");
  restored.setItems(items);
  assert.equal(restored.isVisible("machinery:crane"), false);
  assert.equal(restored.labelsVisible, false);
  assert.equal(restored.view, "groups");
  assert.equal(restored.isCategoryCollapsed("machinery"), true);
  assert.deepEqual(restored.getGroups(), [group]);
  assert.equal(storage.writes.length, writesBeforeReload, "reading and switching scopes are read-only");
  assert.equal(storage.entries.has(keyFor("project:a", "actor")), true);
});

test("a multi-object visibility change persists once and restores the entire batch", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  store.setContext("project", "actor");
  store.setItems(items);
  store.setVisibility(items.map((item) => item.id), false);
  assert.equal(storage.writes.length, 1);
  for (const item of items) assert.equal(store.isVisible(item.id), false);
  const persisted = JSON.parse(storage.writes[0].value);
  assert.equal(persisted.version, 1);
  for (const item of items) assert.equal(persisted.overrides[item.id], false);

  const restored = new SceneDisplayStore(storage);
  restored.setContext("project", "actor");
  restored.setItems(items);
  for (const item of items) assert.equal(restored.isVisible(item.id), false);
});

test("overlapping groups derive their tri-state from member visibility and deleting a group preserves it", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  store.setContext("project", "actor");
  store.setItems(items);
  const first = store.createGroup("作业现场", ["machinery:crane", "personnel:guard"]);
  const second = store.createGroup("人员与资料", ["personnel:guard", "import:survey"]);
  assert.equal(store.groupState(first.id), "all");
  assert.equal(store.groupState(second.id), "some");
  const before = storage.writes.length;
  store.setGroupVisibility(first.id, false);
  assert.equal(storage.writes.length, before + 1, "one group click produces one atomic preference write");
  assert.equal(store.groupState(first.id), "none");
  assert.equal(store.groupState(second.id), "none");
  store.setGroupVisibility(second.id, true);
  assert.equal(store.groupState(second.id), "all");
  assert.equal(store.groupState(first.id), "some", "a second group has no independent hidden gate");

  const visibilityBeforeDeletion = items.map((item) => store.isVisible(item.id));
  store.removeGroup(second.id);
  assert.deepEqual(items.map((item) => store.isVisible(item.id)), visibilityBeforeDeletion);
  assert.equal(store.getGroups().some((group) => group.id === second.id), false);
  assert.equal(store.groupState(first.id), "some");
});

test("unavailable members do not affect group state or acquire changes while absent", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  store.setContext("project", "actor");
  store.setItems(items);
  const group = store.createGroup("现场", ["machinery:crane", "personnel:guard"]);
  store.setItems([items[0]]);
  assert.equal(store.groupState(group.id), "all");
  store.setGroupVisibility(group.id, false);
  assert.equal(store.groupState(group.id), "none");
  store.setItems([]);
  assert.equal(store.groupState(group.id), "empty");
  store.setItems(items);
  assert.equal(store.isVisible("machinery:crane"), false);
  assert.equal(store.isVisible("personnel:guard"), true, "an unavailable member was excluded from the batch");
});

test("renaming and editing groups preserve stable group identity and persist members", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  store.setContext("project", "actor");
  store.setItems(items);
  const group = store.createGroup("原组", ["machinery:crane"]);
  store.renameGroup(group.id, "防护人员");
  store.setGroupMembers(group.id, ["personnel:guard", "import:survey"]);
  assert.deepEqual(store.getGroups(), [{ id: group.id, name: "防护人员", members: ["personnel:guard", "import:survey"] }]);
  assert.equal(store.groupState(group.id), "some");
  const restored = new SceneDisplayStore(storage);
  restored.setContext("project", "actor");
  restored.setItems(items);
  assert.deepEqual(restored.getGroups(), store.getGroups());
});

test("invalid JSON and malformed top-level values safely fall back to business defaults", () => {
  for (const saved of ["{", "null", "[]", '"legacy"', "false", "12"]) {
    const storage = memoryStorage([[keyFor("project", "actor"), saved]]);
    const store = new SceneDisplayStore(storage);
    assert.doesNotThrow(() => store.setContext("project", "actor"));
    store.setItems(items);
    assert.equal(store.isVisible("machinery:crane"), true);
    assert.equal(store.isVisible("import:survey"), false);
    assert.equal(store.labelsVisible, true);
    assert.equal(store.view, "categories");
    assert.deepEqual(store.getGroups(), []);
    assert.equal(storage.writes.length, 0);
  }
});

test("malformed individual persisted fields do not turn strings, arrays or numbers into display flags", () => {
  const storage = memoryStorage([[keyFor("project", "actor"), JSON.stringify({
    version: 1,
    overrides: { "machinery:crane": false, "personnel:guard": "false", "import:survey": 1 },
    labelsVisible: "false",
    view: "unknown",
    collapsedCategories: [false, 1, null, {}, [], "personnel"],
    groups: [null, false, [], { id: 4, name: "bad", members: [] }, { id: "bad", name: [], members: [] }],
  })]]);
  const store = new SceneDisplayStore(storage);
  store.setContext("project", "actor");
  store.setItems(items);
  assert.equal(store.isVisible("machinery:crane"), false);
  assert.equal(store.isVisible("personnel:guard"), true);
  assert.equal(store.isVisible("import:survey"), false);
  assert.equal(store.labelsVisible, true);
  assert.equal(store.view, "categories");
  assert.equal(store.isCategoryCollapsed("machinery"), false);
  assert.equal(store.isCategoryCollapsed("personnel"), true);
  assert.deepEqual(store.getGroups(), []);
});

test("prototype-like object identifiers remain ordinary persisted display keys", () => {
  const storage = memoryStorage();
  const store = new SceneDisplayStore(storage);
  const specialItems = ["__proto__", "constructor", "toString"].map((id) => ({ id, visible: true }));
  store.setContext("project", "actor");
  store.setItems(specialItems);
  for (const item of specialItems) assert.equal(store.isVisible(item.id), true);
  store.setVisibility(specialItems.map((item) => item.id), false);
  for (const item of specialItems) {
    assert.equal(store.isVisible(item.id), false);
    assert.equal(Object.hasOwn(store.getOverrides(), item.id), true);
  }
  const restored = new SceneDisplayStore(storage);
  restored.setContext("project", "actor");
  restored.setItems(specialItems);
  for (const item of specialItems) assert.equal(restored.isVisible(item.id), false);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "__proto__"), false);
});

test("blocked reads and failed writes keep the in-memory display controls usable and expose the failure", () => {
  const store = new SceneDisplayStore({
    getItem: () => { throw new Error("storage access blocked"); },
    setItem: () => { throw new Error("quota exceeded"); },
  });
  assert.doesNotThrow(() => store.setContext("project", "actor"));
  store.setItems(items);
  assert.equal(store.isVisible("machinery:crane"), true);
  assert.ok(store.persistenceError);
  assert.doesNotThrow(() => store.setVisibility(["machinery:crane", "personnel:guard"], false));
  assert.equal(store.isVisible("machinery:crane"), false);
  assert.equal(store.isVisible("personnel:guard"), false);
  assert.doesNotThrow(() => store.setLabelsVisible(false));
  assert.equal(store.labelsVisible, false);
  let groupId = "";
  assert.doesNotThrow(() => { groupId = store.createGroup("临时分组", ["machinery:crane"]).id; });
  assert.equal(store.groupState(groupId), "none");
  assert.ok(store.persistenceError);
});
