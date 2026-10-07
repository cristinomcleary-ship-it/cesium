import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createSafetySpatialStore } from "./safetySpatialStore.ts";
import { spatialFixture } from "../src/safetySpatial.testFixtures.ts";
import type { SpatialMutation } from "../src/safetySpatialTypes.ts";

async function fixture() {
  const testRoot = resolve("tmp/safety-spatial-tests"); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "case-")); const store = createSafetySpatialStore({ dataDir: root });
  const server = createServer((req, res) => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__safety/spatial`;
  const call = async (mutation?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { method: mutation === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Cesium-Library": "1", ...headers },
      body: mutation === undefined ? undefined : typeof mutation === "string" ? mutation : JSON.stringify(mutation) });
    return { status: response.status, body: await response.json() };
  };
  return { root, store, call, close: async () => {
    server.closeAllConnections(); await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
    assert.ok(resolve(root).startsWith(testRoot + sep)); await rm(root, { recursive: true, force: true });
  } };
}
function upsert(id = "area", expectedRevision = 0, mutationId = "first"): SpatialMutation {
  return { operation: "upsert", expectedRevision, mutationId, object: spatialFixture("construction-area", id) };
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
    assert.equal(deleted.status, 200); assert.equal(deleted.body.objects.length, 0); assert.equal(deleted.body.revision, 2);
    assert.equal((await f.call(upsert("area", 1, "stale"))).status, 409);
    const retry = await f.call(upsert()); assert.equal(retry.status, 200); assert.equal(retry.body.objects.length, 0);
    assert.equal((await createSafetySpatialStore({ dataDir: f.root }).load()).objects.length, 0);
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
