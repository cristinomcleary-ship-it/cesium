import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createSafetyEventStore } from "./safetyEventStore.ts";
import { createSafetySpatialStore } from "./safetySpatialStore.ts";
import { SafetyEventError, SafetyEventRepository } from "../src/safetyEventRepository.ts";
import { EMPTY_EVENT_SNAPSHOT, type SafetyEventRecord } from "../src/safetyEventTypes.ts";
import { modelRegistryFixture, spatialV3Fixture } from "../src/safetySpatial.testFixtures.ts";

function event(id = "manual-event"): SafetyEventRecord {
  return { id, projectId: "safety:project", title: "Explicit manual observation", severity: "medium", status: "pending", occurredAt: 1791360000000,
    spatialObjectId: "risk-definition", mediaIds: [], source: { kind: "manual-record" }, createdAt: "2026-10-07T08:00:00Z", updatedAt: "2026-10-07T08:00:00Z" };
}
async function fixture() {
  const testRoot = resolve("tmp/safety-event-tests"); await mkdir(testRoot, { recursive: true }); const root = await mkdtemp(join(testRoot, "case-"));
  const store = createSafetyEventStore({ dataDir: root });
  const server = createServer((req, res) => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__safety/events`;
  const call = async (body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "X-Cesium-Library": "1", "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { root, store, call, close: async () => { server.closeAllConnections(); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    assert.ok(resolve(root).startsWith(testRoot + sep)); await rm(root, { recursive: true, force: true }); } };
}
test("new event collection is empty and risk definition create/delete/restore never creates or deletes events", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.call()).body, EMPTY_EVENT_SNAPSHOT);
    const definitions = createSafetySpatialStore({ dataDir: f.root, modelRegistry: [modelRegistryFixture()] });
    const point = spatialV3Fixture("risk-point", "risk-definition");
    await definitions.mutate({ operation: "upsert", object: point, expectedRevision: 0, mutationId: "define" });
    assert.equal((await f.store.load()).events.length, 0);
    const created = await f.call({ operation: "create", event: event(), expectedRevision: 0, mutationId: "event-create" }); assert.equal(created.status, 200);
    const definitionBytes = await readFile(definitions.path, "utf8");
    const completed = await f.call({ operation: "complete", id: "manual-event", result: { description: "Explicit handling result" }, expectedRevision: 1, mutationId: "handle" });
    assert.equal(completed.body.events[0].status, "completed"); assert.equal(completed.body.events[0].position, undefined);
    assert.equal(await readFile(definitions.path, "utf8"), definitionBytes);
    const eventBytes = await readFile(f.store.path, "utf8");
    await definitions.mutate({ operation: "delete", id: point.id, expectedRevision: 1, mutationId: "delete-definition" });
    await definitions.mutate({ operation: "restore", id: point.id, expectedRevision: 2, mutationId: "restore-definition" });
    assert.equal(await readFile(f.store.path, "utf8"), eventBytes); assert.equal((await createSafetyEventStore({ dataDir: f.root }).load()).events[0].handling?.description, "Explicit handling result");
  } finally { await f.close(); }
});
test("failed results and stale revisions retain the confirmed event state and user input is not persisted prematurely", async () => {
  const f = await fixture();
  try {
    await f.call({ operation: "create", event: event(), expectedRevision: 0, mutationId: "create" });
    const before = await readFile(f.store.path, "utf8");
    assert.equal((await f.call({ operation: "complete", id: "manual-event", result: { description: "  " }, expectedRevision: 1, mutationId: "blank" })).status, 400);
    assert.equal((await f.call({ operation: "complete", id: "manual-event", result: { description: "valid" }, expectedRevision: 0, mutationId: "stale" })).status, 409);
    assert.equal(await readFile(f.store.path, "utf8"), before); assert.equal((await f.store.load()).events[0].status, "pending");
    const results = await Promise.all(["one", "two"].map(id => f.call({ operation: "complete", id: "manual-event", result: { description: id }, expectedRevision: 1, mutationId: id })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const current = await f.store.load(); assert.equal(current.revision, 2); assert.equal(current.events[0].status, "completed");
    assert.equal((await f.call({ operation: "complete", id: "manual-event", result: { description: "overwrite" }, expectedRevision: 2, mutationId: "overwrite" })).body.code, "EVENT_COMPLETED");
  } finally { await f.close(); }
});
test("event lost acknowledgement retries are idempotent after restart and unverified imports are rejected", async () => {
  const f = await fixture();
  try {
    const command = { operation: "create", event: event(), expectedRevision: 0, mutationId: "stable" };
    await f.call(command); assert.equal((await createSafetyEventStore({ dataDir: f.root }).mutate(command)).revision, 1);
    assert.equal((await f.call({ ...command, event: event("different") })).body.code, "MUTATION_ID_REUSED");
    const imported = { ...event("imported"), source: { kind: "imported-event", sourceRecordId: "external-real-record" } };
    assert.equal((await f.call({ operation: "create", event: imported, expectedRevision: 1, mutationId: "imported" })).body.code, "IMPORT_SOURCE_UNVERIFIED");
    const adapterStore = createSafetyEventStore({ dataDir: f.root, validateImportedEvent: async item => item.source.sourceRecordId === "external-real-record" });
    assert.equal((await adapterStore.mutate({ operation: "create", event: imported, expectedRevision: 1, mutationId: "verified-import" })).events.length, 2);
  } finally { await f.close(); }
});
test("event endpoint rejects cross-origin writes and corrupt storage remains intact", async () => {
  const f = await fixture();
  try {
    const command = { operation: "create", event: event(), expectedRevision: 0, mutationId: "create" };
    assert.equal((await f.call(command, { Origin: "https://unrelated.example" })).status, 403);
    assert.equal((await f.call(command, { "X-Cesium-Library": "0" })).status, 403);
    await writeFile(f.store.path, "broken event data"); assert.equal((await f.call()).body.code, "STORAGE_CORRUPT");
    assert.equal((await f.call(command)).status, 500); assert.equal(await readFile(f.store.path, "utf8"), "broken event data");
  } finally { await f.close(); }
});
test("event repository binds native fetch, preserves request ID on retry and returns typed conflicts", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function (this: unknown) { assert.equal(this, globalThis); return new Response(JSON.stringify(EMPTY_EVENT_SNAPSHOT)); };
  try { assert.equal((await new SafetyEventRepository().load()).events.length, 0); } finally { globalThis.fetch = original; }
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => { bodies.push(String(init?.body)); if (bodies.length === 1) throw new TypeError("ack lost"); return new Response(JSON.stringify({ ...EMPTY_EVENT_SNAPSHOT, revision: 1, events: [event()] })); };
  await new SafetyEventRepository(fetcher).create(event(), 0); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  const conflict: typeof fetch = async () => new Response(JSON.stringify({ code: "REVISION_CONFLICT", error: "changed", snapshot: EMPTY_EVENT_SNAPSHOT }), { status: 409 });
  await assert.rejects(new SafetyEventRepository(conflict).complete("manual-event", { description: "result" }, 0), error => error instanceof SafetyEventError && error.snapshot?.revision === 0);
});
