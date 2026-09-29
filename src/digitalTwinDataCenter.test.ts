import assert from "node:assert/strict";
import test from "node:test";

import {
  DigitalTwinDataCenter,
  dataResourceFromImport,
  type DataCenterEvent,
  type StorageLike,
} from "./digitalTwinDataCenter.ts";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const clock = () => new Date("2026-08-21T00:00:00.000Z");

test("manages typed catalogs and filters by type, status, project, tags, and keyword", () => {
  const center = new DigitalTwinDataCenter({ storage: null, clock });
  center.upsertProject({ id: " project-1 ", name: "  北区\n项目  ", type: "building", status: "active", tags: ["重点", "重点"] });
  center.upsertResource({
    id: "cad-1",
    name: "基坑围护.dwg",
    type: "CAD",
    status: "ready",
    projectId: "project-1",
    visible: true,
    tags: ["地下"],
    metadata: { discipline: "结构" },
  });
  center.upsertResource({ id: "gis-1", name: "红线", type: "GIS", status: "hidden", projectId: "project-1", visible: false });
  center.upsertBusinessRecord({
    id: "issue-1",
    name: "围护结构巡检",
    type: "inspection",
    status: "open",
    projectId: "project-1",
    resourceId: "cad-1",
    description: "发现结构变形",
  });

  assert.equal(center.getProject("project-1")?.name, "北区 项目");
  assert.deepEqual(center.getProject("project-1")?.tags, ["重点"]);
  assert.deepEqual(center.queryResources({ type: "CAD", status: "ready", projectId: "project-1", tags: ["地下"] }).map(({ id }) => id), ["cad-1"]);
  assert.deepEqual(center.queryResources({ keyword: "结构" }).map(({ id }) => id), ["cad-1"]);
  assert.deepEqual(center.queryBusinessRecords({ keyword: "变形" }).map(({ id }) => id), ["issue-1"]);

  const snapshot = center.snapshot();
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.resources.total, 2);
  assert.equal(snapshot.resources.byType.CAD, 1);
  assert.equal(snapshot.resources.byStatus.hidden, 1);
});

test("upsert preserves creation time, reconcile removes stale entries, and events can be unsubscribed", () => {
  const center = new DigitalTwinDataCenter({ storage: null, clock });
  const events: DataCenterEvent[] = [];
  const unsubscribe = center.subscribe((event) => events.push(event));

  center.upsertResource({ id: "one", name: "One", type: "Model", createdAt: "2020-01-01", runtimeResource: { live: 1 } });
  center.upsertResource({ id: "one", name: "One updated", type: "Model", createdAt: "2025-01-01", runtimeResource: { live: 2 } });
  center.upsertResource({ id: "old", name: "Old", type: "GIS" });
  const result = center.reconcileResources([
    { id: "one", name: "One final", type: "Model", runtimeResource: { live: 3 } },
    { id: "new", name: "New", type: "CAD" },
  ]);

  assert.deepEqual(result, { inserted: 1, updated: 1, removed: 1, total: 2 });
  assert.equal(center.getResource("old"), undefined);
  assert.equal(center.getResource("one")?.createdAt, "2020-01-01T00:00:00.000Z");
  assert.deepEqual(center.getResource("one")?.runtimeResource, { live: 3 });
  assert.equal(events.at(-1)?.action, "reconcile");
  assert.equal(events.at(-1)?.snapshot.resources.total, 2);

  unsubscribe();
  center.removeResource("new");
  assert.equal(events.length, 4);
});

test("imports adapter keeps runtime objects in memory but persists only sanitized safe metadata", () => {
  const storage = new MemoryStorage();
  const center = new DigitalTwinDataCenter({ storage, clock });
  const runtimeResource = { url: "blob:https://example.test/runtime", huge: new Uint8Array(10_000) };
  const input = dataResourceFromImport({
    id: "model-1",
    name: "tower.glb",
    kind: "Model",
    resource: runtimeResource,
    visible: true,
    adjustable: true,
    representation: "primitive",
  }, "project-1");
  input.metadata = {
    representation: "primitive",
    adjustable: true,
    token: "must-not-be-saved",
    preview: "blob:https://example.test/secret",
    nested: { forbidden: true },
    valid: "ok",
  };
  center.upsertResource(input);

  assert.equal(center.getResource("model-1")?.runtimeResource, runtimeResource);
  const persisted = [...storage.values.values()][0];
  assert.ok(persisted);
  assert.ok(!persisted.includes("runtimeResource"));
  assert.ok(!persisted.includes("blob:"));
  assert.ok(!persisted.includes("must-not-be-saved"));
  assert.ok(!persisted.includes("forbidden"));
  assert.ok(persisted.includes('"valid":"ok"'));

  const restored = new DigitalTwinDataCenter({ storage, clock });
  assert.equal(restored.getResource("model-1")?.runtimeResource, undefined);
  assert.equal(restored.getResource("model-1")?.metadata.valid, "ok");
});

test("reconcileImports maps the existing imports array shape and visibility", () => {
  const center = new DigitalTwinDataCenter({ storage: null, clock });
  const result = center.reconcileImports([
    { id: "cad", name: "site.dwg", kind: "CAD", resource: { show: true }, visible: true, representation: "primitive" },
    { id: "video", name: "flight.mp4", kind: "Drone Video", resource: { show: false }, visible: false },
  ], "project-9");

  assert.deepEqual(result, { inserted: 2, updated: 0, removed: 0, total: 2 });
  assert.equal(center.getResource("cad")?.status, "ready");
  assert.equal(center.getResource("video")?.status, "hidden");
  assert.equal(center.getResource("video")?.projectId, "project-9");
});

test("enforces catalog and storage capacity while storage failures never escape", () => {
  const center = new DigitalTwinDataCenter({ storage: null, limits: { maxProjects: 1 }, clock });
  center.upsertProject({ id: "one", name: "One" });
  assert.throws(() => center.upsertProject({ id: "two", name: "Two" }), /capacity \(1\) exceeded/);

  const throwingStorage: StorageLike = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
  };
  assert.doesNotThrow(() => {
    const unavailable = new DigitalTwinDataCenter({ storage: throwingStorage, clock });
    unavailable.upsertProject({ id: "safe", name: "Still works" });
    assert.equal(unavailable.getProject("safe")?.name, "Still works");
    assert.equal(unavailable.getPersistenceStatus().reason, "write-failed");
  });

  const tinyStorage = new MemoryStorage();
  const tiny = new DigitalTwinDataCenter({ storage: tinyStorage, limits: { maxStorageBytes: 50 }, clock });
  tiny.upsertProject({ id: "one", name: "A project larger than fifty bytes" });
  assert.equal(tinyStorage.values.size, 0);
  assert.equal(tiny.getPersistenceStatus().reason, "capacity-exceeded");
});

test("sanitizes bounded inputs and rejects empty identifiers", () => {
  const center = new DigitalTwinDataCenter({
    storage: null,
    clock,
    limits: { maxNameLength: 8, maxTags: 2, maxTagLength: 4, maxMetadataEntries: 2, maxMetadataValueLength: 5 },
  });
  const project = center.upsertProject({
    id: "id\u0000",
    name: "1234567890",
    tags: ["abcdef", "two", "three"],
    metadata: { first: "123456", second: Number.POSITIVE_INFINITY, third: true, constructor: "blocked", fourth: "ignored" },
  });
  assert.equal(project.id, "id");
  assert.equal(project.name, "12345678");
  assert.deepEqual(project.tags, ["abcd", "two"]);
  assert.deepEqual(project.metadata, { first: "12345", third: true });
  assert.throws(() => center.upsertProject({ id: "\u0000", name: "bad" }), /non-empty string/);
});
