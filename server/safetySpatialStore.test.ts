import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createSafetySpatialStore, loadProjectModelRegistry } from "./safetySpatialStore.ts";
import { spatialFixture, spatialV3Fixture, spatialSnapshot, modelRegistryFixture } from "../src/safetySpatial.testFixtures.ts";
import type { SpatialMutation } from "../src/safetySpatialTypes.ts";

async function fixture() {
  const testRoot = resolve("tmp/safety-spatial-tests"); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "case-")); const store = createSafetySpatialStore({ dataDir: root, modelRegistry: [modelRegistryFixture()] });
  const server = createServer((req, res) => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__safety/spatial`;
  const call = async (mutation?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { method: mutation === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Cesium-Library": "1", ...headers },
      body: mutation === undefined ? undefined : typeof mutation === "string" ? mutation : JSON.stringify(mutation) });
    return { status: response.status, body: await response.json() };
  };
  return { root, store, call, url, close: async () => {
    server.closeAllConnections(); await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
    assert.ok(resolve(root).startsWith(testRoot + sep)); await rm(root, { recursive: true, force: true });
  } };
}
function upsert(id = "area", expectedRevision = 0, mutationId = "first"): SpatialMutation {
  return { operation: "upsert", expectedRevision, mutationId, object: spatialV3Fixture("construction-area", id) };
}

test("spatial save and fresh-server restore preserve source coordinates without modifying original library files", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "records")); await writeFile(join(f.root, "view.json"), "original camera");
    await writeFile(join(f.root, "records", "source.txt"), "original engineering source");
    assert.deepEqual((await f.call()).body.objects, []);
    const saved = await f.call(upsert()); assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
    assert.deepEqual(saved.body.objects[0].geometry, spatialFixture().geometry);
    const restored = await createSafetySpatialStore({ dataDir: f.root }).load(); assert.equal(restored.objects.length, 1); assert.equal(restored.objects[0].source.vertices[0].sourceHeight, 12);
    assert.equal(await readFile(join(f.root, "view.json"), "utf8"), "original camera");
    assert.equal(await readFile(join(f.root, "records", "source.txt"), "utf8"), "original engineering source");
    assert.ok(!(await readdir(f.root)).some((name) => name.endsWith(".pending")));
  } finally { await f.close(); }
});

test("idempotent mutation receipts survive restart and reject reused IDs with different content", async () => {
  const f = await fixture();
  try {
    const command = upsert(); assert.equal((await f.call(command)).body.revision, 1);
    assert.equal((await f.call(command)).body.revision, 1);
    const restarted = createSafetySpatialStore({ dataDir: f.root }); assert.equal((await restarted.mutate(command)).revision, 1);
    const changed = upsert("different", 0, "first"); const response = await f.call(changed);
    assert.equal(response.status, 409); assert.equal(response.body.code, "MUTATION_ID_REUSED"); assert.equal((await f.store.load()).objects.length, 1);
  } finally { await f.close(); }
});

test("concurrent writes reject stale revisions rather than losing either page's edits", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.call(upsert("one", 0, "one")), f.call(upsert("two", 0, "two"))]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const conflict = results.find((result) => result.status === 409)!; assert.equal(conflict.body.code, "REVISION_CONFLICT");
    assert.equal(conflict.body.snapshot.revision, 1); assert.equal((await f.store.load()).objects.length, 1);
  } finally { await f.close(); }
});

test("delete is durable and stale saves cannot resurrect an object", async () => {
  const f = await fixture();
  try {
    await f.call(upsert()); const deleted = await f.call({ operation: "delete", id: "area", expectedRevision: 1, mutationId: "delete" });
    assert.equal(deleted.status, 200); assert.equal(deleted.body.objects.length, 1); assert.ok(deleted.body.objects[0].deletedAt); assert.equal(deleted.body.revision, 2);
    assert.equal((await f.call(upsert("area", 1, "stale"))).status, 409);
    const retry = await f.call(upsert()); assert.equal(retry.status, 200); assert.equal(retry.body.objects.length, 1); assert.ok(retry.body.objects[0].deletedAt);
    assert.ok((await createSafetySpatialStore({ dataDir: f.root }).load()).objects[0].deletedAt);
  } finally { await f.close(); }
});

test("corrupt persistence is reported and never overwritten by a new save", async () => {
  const f = await fixture();
  try {
    await writeFile(f.store.path, "original corrupt source");
    const read = await f.call(); assert.equal(read.status, 500); assert.equal(read.body.code, "STORAGE_CORRUPT");
    assert.equal((await f.call(upsert())).status, 500); assert.equal(await readFile(f.store.path, "utf8"), "original corrupt source");
  } finally { await f.close(); }
});

test("HTTP mutation rejects cross-origin requests, missing markers, bad JSON and invalid geometry", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(upsert(), { Origin: "https://unrelated.example" })).status, 403);
    assert.equal((await f.call(upsert(), { Origin: "null" })).status, 403);
    assert.equal((await f.call(upsert(), { "X-Cesium-Library": "0" })).status, 403);
    assert.equal((await f.call("{invalid")).status, 400);
    const command = upsert(); if (command.operation !== "upsert" || command.object.geometry.type !== "Polygon") return;
    command.object.geometry.positions.pop(); command.object.geometry.positions.pop();
    assert.equal((await f.call(command)).status, 400); assert.equal((await f.store.load()).revision, 0);
  } finally { await f.close(); }
});


test("HTTP rejects oversized bodies and the serial queue remains usable after a failed mutation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(" ".repeat(1_048_577))).status, 413);
    const missing = await f.call({ operation: "delete", id: "missing", expectedRevision: 0, mutationId: "missing" });
    assert.equal(missing.status, 404);
    const saved = await f.call(upsert()); assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
  } finally { await f.close(); }
});


test("soft delete and restore preserve stable identity, sources and legacy corridor geometry", async () => {
  const f = await fixture();
  try {
    const corridor = spatialFixture("railway", "legacy"), risk = spatialFixture("risk-point", "legacy-risk"); risk.risk!.status = "closed";
    await writeFile(f.store.path, JSON.stringify({ ...spatialSnapshot(corridor, risk), mutations: [] }));
    const read = await f.call(); assert.deepEqual(read.body.objects, [corridor, risk]);
    const renamed = { ...corridor, name: "Edited legacy name" };
    assert.equal((await f.call({ operation: "upsert", object: renamed, expectedRevision: 1, mutationId: "legacy-edit" })).status, 200);
    const changed = structuredClone(renamed); if (changed.geometry.type !== "Corridor") throw new Error("fixture"); changed.geometry.positions[0].height += 1;
    assert.equal((await f.call({ operation: "upsert", object: changed, expectedRevision: 2, mutationId: "legacy-move" })).body.code, "MODEL_SURFACE_REQUIRED");
    const deleted = await f.call({ operation: "delete", id: "legacy", expectedRevision: 2, mutationId: "soft-delete" }); assert.ok(deleted.body.objects[0].deletedAt);
    assert.equal((await f.call({ operation: "upsert", object: renamed, expectedRevision: 3, mutationId: "revive-without-restore" })).body.code, "OBJECT_DELETED");
    const restored = await f.call({ operation: "restore", id: "legacy", expectedRevision: 3, mutationId: "restore" });
    assert.equal(restored.status, 200); assert.equal(restored.body.objects[0].id, "legacy"); assert.equal(restored.body.objects[0].deletedAt, undefined);
    assert.deepEqual(restored.body.objects[0].geometry, corridor.geometry); assert.deepEqual(restored.body.objects[0].source, corridor.source);
    assert.equal(restored.body.objects[1].risk.status, "closed"); assert.equal(restored.body.objects[0].creationSource, undefined);
    assert.equal((await f.call({ operation: "restore", id: "legacy", expectedRevision: 3, mutationId: "restore" })).body.revision, 4);
  } finally { await f.close(); }
});

test("new definitions reject unregistered or changed models and cannot downgrade existing provenance", async () => {
  const f = await fixture();
  try {
    const command = upsert(); if (command.operation !== "upsert") throw new Error("fixture");
    command.object.source.vertices[0].anchor!.model.assetVersion = "old-version";
    const changed = await f.call(command); assert.equal(changed.status, 409); assert.equal(changed.body.code, "MODEL_VERSION_CHANGED"); assert.equal((await f.store.load()).revision, 0);
    command.object = spatialV3Fixture(); command.object.projectId = "other-project";
    assert.equal((await f.call(command)).body.code, "MODEL_UNAVAILABLE");
    command.object = spatialFixture(); assert.equal((await f.call(command)).body.code, "MODEL_SURFACE_REQUIRED");
    const saved = await f.call(upsert()); assert.equal(saved.status, 200);
    const downgrade = { ...saved.body.objects[0] }; delete downgrade.creationSource;
    assert.equal((await f.call({ operation: "upsert", object: downgrade, expectedRevision: 1, mutationId: "downgrade" })).body.code, "MODEL_SURFACE_REQUIRED");
    const models = await fetch(f.url.replace("/spatial", "/models")); assert.equal(models.status, 200); assert.deepEqual(await models.json(), [modelRegistryFixture()]);
  } finally { await f.close(); }
});

test("model registry versions actual tiles and transforms while ignoring visibility and record updatedAt", async () => {
  const f = await fixture();
  try {
    const id = "8bc58629-cf26-45de-986e-086479db11a0", dir = join(f.root, "records", id), tiles = join(dir, "tiles");
    await mkdir(tiles, { recursive: true }); await writeFile(join(tiles, "root.json"), JSON.stringify({ asset: { version: "1.0" }, root: { geometricError: 0 } }));
    await writeFile(join(tiles, "tile.b3dm"), "fixture tile bytes");
    const record = { id, name: "Verified model", kind: "3D Tiles", visible: true, updatedAt: "original", files: { tiles: { url: `/__library/files/${id}/tiles/root.json` } }, settings: { matrix: modelRegistryFixture().matrix, tiles: { heightOffset: 0 } } };
    await writeFile(join(dir, "record.json"), JSON.stringify(record));
    const options = { libraryDataDir: f.root }, first = (await loadProjectModelRegistry(options))[0]; assert.ok(first.assetVersion);
    record.visible = false; record.updatedAt = "new UI time"; await writeFile(join(dir, "record.json"), JSON.stringify(record));
    const uiChanged = (await loadProjectModelRegistry(options))[0]; assert.equal(uiChanged.assetVersion, first.assetVersion); assert.equal(uiChanged.coordinateTransformVersion, first.coordinateTransformVersion);
    record.settings.matrix[12] = 10; await writeFile(join(dir, "record.json"), JSON.stringify(record));
    const moved = (await loadProjectModelRegistry(options))[0]; assert.equal(moved.assetVersion, first.assetVersion); assert.notEqual(moved.coordinateTransformVersion, first.coordinateTransformVersion);
    await writeFile(join(tiles, "tile.b3dm"), "different fixture bytes and geometry size");
    assert.notEqual((await loadProjectModelRegistry(options))[0].assetVersion, first.assetVersion);
    await mkdir(join(f.root, "deleted")); await writeFile(join(f.root, "deleted", id + ".json"), "{}"); assert.deepEqual(await loadProjectModelRegistry(options), []);
  } finally { await f.close(); }
});


test("changed model transform blocks saved-definition edits without moving geometry and still allows explicit restore", async () => {
  const f = await fixture();
  try {
    const registered = modelRegistryFixture();
    const store = createSafetySpatialStore({ dataDir: f.root, modelRegistry: async () => [registered] });
    const object = spatialV3Fixture("risk-point", "old-anchor");
    await store.mutate({ operation: "upsert", object, expectedRevision: 0, mutationId: "initial" });
    const before = await readFile(store.path, "utf8"); registered.coordinateTransformVersion = "changed-transform";
    await assert.rejects(store.mutate({ operation: "upsert", object: { ...object, name: "Attempted rename" }, expectedRevision: 1, mutationId: "changed" }), /模型版本或位置已变更/);
    assert.equal(await readFile(store.path, "utf8"), before);
    await store.mutate({ operation: "delete", id: object.id, expectedRevision: 1, mutationId: "delete-old" });
    const restored = await store.mutate({ operation: "restore", id: object.id, expectedRevision: 2, mutationId: "restore-old" });
    assert.deepEqual(restored.objects[0].geometry, object.geometry); assert.deepEqual(restored.objects[0].source, object.source);
    assert.equal(restored.objects[0].source.vertices[0].anchor!.model.coordinateTransformVersion, "test-transform-v1");
  } finally { await f.close(); }
});


test("HTTP object revisions are server-owned, mutation retries stable and historical objects remain unnumbered until edited", async () => {
  const f = await fixture();
  try {
    const untouched = spatialV3Fixture("railway", "untouched"), legacy = spatialFixture("railway", "historical");
    const original = JSON.stringify({ ...spatialSnapshot(untouched, legacy), revision: 10, mutations: [] });
    await writeFile(f.store.path, original);
    const initial = await f.call(); assert.equal(initial.status, 200);
    assert.equal(Object.hasOwn(initial.body.objects[0], "revision"), false);
    assert.equal(await readFile(f.store.path, "utf8"), original, "reading does not migrate original JSON");
    const first = { operation: "upsert", object: { ...spatialV3Fixture("risk-point", "new"), revision: "forged" }, expectedRevision: 10, mutationId: "new-revision" };
    const created = await f.call(first); assert.equal(created.status, 200); assert.equal(created.body.objects[2].revision, 1);
    const retried = await f.call({ ...first, object: { ...first.object, revision: -900 } });
    assert.equal(retried.status, 200); assert.equal(retried.body.revision, 11); assert.equal(retried.body.objects[2].revision, 1);
    const edit = await f.call({ operation: "upsert", object: { ...created.body.objects[2], revision: Number.MAX_SAFE_INTEGER, name: "revised" }, expectedRevision: 11, mutationId: "edit-revision" });
    assert.equal(edit.body.objects[2].revision, 2);
    const beforeConflict = await readFile(f.store.path, "utf8");
    assert.equal((await f.call({ operation: "delete", id: "new", expectedRevision: 11, mutationId: "stale-delete" })).status, 409);
    assert.equal(await readFile(f.store.path, "utf8"), beforeConflict);
    const deleted = await f.call({ operation: "delete", id: "new", expectedRevision: 12, mutationId: "delete-revision" });
    assert.equal(deleted.body.objects[2].revision, 3);
    const restored = await f.call({ operation: "restore", id: "new", expectedRevision: 13, mutationId: "restore-revision" });
    assert.equal(restored.body.objects[2].revision, 4); assert.deepEqual(restored.body.objects[2].geometry, created.body.objects[2].geometry);
    const editedLegacy = await f.call({ operation: "upsert", object: { ...legacy, name: "renamed historical" }, expectedRevision: 14, mutationId: "historical-edit" });
    assert.equal(editedLegacy.body.objects[1].revision, 1); assert.deepEqual(editedLegacy.body.objects[1].source, legacy.source);
    assert.deepEqual(editedLegacy.body.objects[0], untouched, "unrelated historical object is not assigned a revision");
    const reopened = await createSafetySpatialStore({ dataDir: f.root }).load();
    assert.equal(reopened.objects[2].revision, 4); assert.equal(reopened.objects[0].revision, undefined);
  } finally { await f.close(); }
});
