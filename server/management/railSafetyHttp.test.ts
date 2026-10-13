import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import type { ManagementCollection, ManagementCommandType, ManagementRecord } from "../../src/managementTypes.ts";
import type { RailSafetyDefinition, RailSafetyPosition } from "../../src/railSafetyTypes.ts";
import { validateRailSafetyDefinition, validateRailSafetyPolygon } from "../../src/railSafetyValidation.ts";
import { canAccessRecord, recordReferences, type RecordSource } from "./authorization.ts";
import type { Actor } from "./domain.ts";

const projectId = "safety:project", password = `RailSafety-${randomUUID()}!`;
const point = (x = 0, y = 0): RailSafetyPosition => ({ longitude: 116.397 + x * 0.00001, latitude: 39.908 + y * 0.00001, height: 47.25 });
const polygon = [point(), point(30), point(30, 30), point(0, 30)];
const limit = (): RailSafetyDefinition => ({ schemaVersion: 1, kind: "limit", polygon: structuredClone(polygon) });
const guard = (): RailSafetyDefinition => ({ schemaVersion: 1, kind: "guard", station: point(-5, 5), polygon: structuredClone(polygon), resourceIds: ["machine"] });
const machine = (): RailSafetyDefinition => ({ schemaVersion: 1, kind: "machine", resourceId: "machine", selectedLimitIds: ["limit"], inspectionStatus: "unknown", support: { length: 8, width: 5, centerX: 0, centerZ: 0 } });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cesium-rail-safety-http-"));
  let store: ReturnType<typeof createManagementStore>, server: Server, base = "", cookie = "", sequence = 0;
  async function start() {
    store = createManagementStore({ dataDir: root, libraryDataDir: root });
    server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); })));
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function stop() { await new Promise<void>(done => server.close(() => done())); store.close(); }
  async function request(path: string, body?: unknown, cookieOverride?: string) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie: cookieOverride ?? cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data, text };
  }
  async function command(type: ManagementCommandType, payload: Record<string, unknown> = {}, id?: string, expectedRevision?: number, options: { projectId?: string; key?: string; cookie?: string } = {}) {
    return request("/__management/commands", { projectId: options.projectId ?? projectId, type, payload, id, expectedRevision, idempotencyKey: options.key ?? `rail-${++sequence}` }, options.cookie);
  }
  async function ok(type: ManagementCommandType, payload: Record<string, unknown> = {}, id?: string, expectedRevision?: number, options: { projectId?: string; key?: string } = {}) {
    const r = await command(type, payload, id, expectedRevision, options); assert.equal(r.status, 200, `${type}: ${r.text}`); return r.data;
  }
  async function record(id: string, kind: ManagementCollection = "railSafety", project = projectId) { return request(`/__management/records/${kind}/${id}?projectId=${encodeURIComponent(project)}`); }
  async function state() { const r = await request(`/__management/state?projectId=${encodeURIComponent(projectId)}`); assert.equal(r.status, 200, r.text); return r.data; }
  async function login(username: string) { const r = await request("/__management/session", { username, password, projectId }); assert.equal(r.status, 200, r.text); return cookie; }
  await start(); await ok("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  return { request, command, ok, record, state, login, async restart() { await stop(); await start(); }, async close() { await stop(); rmSync(root, { recursive: true, force: true }); } };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ok("resource.create", { name: "现场吊机", kind: "equipment", quantity: 1, unit: "台", availability: "disabled" }, "machine");
  await f.ok("railSafety.save", { name: "用户定义铁路限界", definition: limit() }, "limit", 0);
  await f.ok("railSafety.save", { name: "用户定义防护人员", definition: guard() }, "guard", 0);
  await f.ok("railSafety.save", { name: "机械现场管控", definition: machine() }, "machine-config", 0);
}

test("rail safety persists user definitions, revisions and soft deletion through actual SQLite restarts without approving equipment", async () => {
  const f = await fixture(); try {
    await seed(f); const before = await f.state();
    await f.restart(); const after = await f.state(); assert.deepEqual(after.collections.railSafety, before.collections.railSafety);
    assert.equal(after.collections.resources[0].availability, "disabled"); assert.equal(after.collections.resources[0].confirmedAt, undefined);
    const payload = { name: "机械现场管控", definition: { ...machine(), inspectionStatus: "reported" } };
    const changed = await f.ok("railSafety.save", payload, "machine-config", 1, { key: "save-once" });
    assert.equal(changed.collections.railSafety.find((r: any) => r.id === "machine-config").revision, 2);
    const replay = await f.ok("railSafety.save", payload, "machine-config", 1, { key: "save-once" });
    assert.equal(replay.revision, changed.revision); assert.deepEqual(replay.collections, changed.collections); assert.deepEqual(replay.audit, changed.audit); assert.equal((await f.command("railSafety.save", { ...payload, name: "different" }, "machine-config", 1, { key: "save-once" })).data.code, "IDEMPOTENCY_CONFLICT");
    const conflict = await f.command("railSafety.save", payload, "machine-config", 1); assert.equal(conflict.status, 409); assert.equal(conflict.data.current.revision, 2);
    await f.ok("railSafety.remove", { reason: "用户移除" }, "limit", 1);
    await f.restart(); const removed = (await f.record("limit")).data;
    assert.equal(removed.status, "deleted"); assert.ok(removed.deletedAt); assert.ok(removed.deletedBy); assert.deepEqual(removed.definition, limit());
    assert.deepEqual((await f.record("machine-config")).data.definition.selectedLimitIds, ["limit"], "a deleted limit remains an unresolved reference, never silently removed from evaluation inputs");
    assert.equal((await f.command("railSafety.save", payload, "machine-config", 2)).data.code, "RAIL_SAFETY_LIMIT_INVALID");
    assert.equal((await f.command("railSafety.save", { name: "revive", definition: limit() }, "limit", 2)).data.code, "INVALID_STATE");
    const audit = (await f.state()).audit.filter((a: any) => a.command.startsWith("railSafety.")); assert.equal(audit.length, 5);
  } finally { await f.close(); }
});

test("rail safety validates geometry, capacity and all referenced identities atomically", async () => {
  const f = await fixture(); try {
    await seed(f); const before = await f.state();
    const invalid: unknown[] = [
      { ...limit(), schemaVersion: 2 }, { ...limit(), polygon: polygon.slice(0, 2) }, { ...limit(), polygon: [point(), point(1), point(2)] },
      { ...limit(), polygon: [point(), point(30, 30), point(30), point(0, 30)] }, { ...limit(), polygon: [...polygon, polygon[0]] },
      { ...limit(), polygon: [point(), point(30), { ...point(30, 30), height: Infinity }] },
      { ...limit(), polygon: [point(), { ...point(30), latitude: 91 }, point(30, 30)] },
      { ...limit(), polygon: Array.from({ length: 129 }, (_, i) => point(i, i % 2)) },
      { ...limit(), polygon: [point(), { ...point(), longitude: -116 }, point(1, 1)] },
      { ...limit(), approved: true }, { ...guard(), resourceIds: ["machine", "machine"] },
      { ...machine(), support: { length: 0, width: 5, centerX: 0, centerZ: 0 } }, { ...machine(), inspectionStatus: "approved" }, { ...machine(), inspectionStatus: ["unknown"] },
      { ...machine(), selectedLimitIds: ["guard"] }, { ...machine(), selectedLimitIds: ["missing"] },
      { ...guard(), resourceIds: ["missing"] },
    ];
    for (const [index, definition] of invalid.entries()) {
      const r = await f.command("railSafety.save", { name: `invalid-${index}`, definition }, `invalid-${index}`, 0);
      assert.ok(r.status >= 400 && r.status < 500, `${index}: ${r.text}`);
    }
    assert.equal((await f.command("railSafety.save", { name: "state injection", status: "approved", definition: limit() }, "inject", 0)).data.code, "INVALID_RAIL_SAFETY_PAYLOAD");
    assert.equal((await f.command("railSafety.save", { name: "duplicate equipment config", definition: machine() }, "duplicate", 0)).data.code, "RAIL_SAFETY_MACHINE_EXISTS");
    assert.equal((await f.command("resource.update", { name: "改为材料", kind: "material", reason: "错误类别" }, "machine", 1)).data.code, "RAIL_SAFETY_RESOURCE_KIND");
    const after = await f.state(); assert.equal(after.revision, before.revision); assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.audit, before.audit);
    await f.ok("resource.create", { name: "班组", kind: "crew" }, "crew");
    assert.equal((await f.command("railSafety.save", { name: "wrong kind", definition: { ...guard(), resourceIds: ["crew"] } }, "bad-kind", 0)).data.code, "RAIL_SAFETY_RESOURCE_KIND");
  } finally { await f.close(); }
});

test("rail safety reads require models and writes require live models + resource, including receipts, conflicts and report history", async () => {
  const f = await fixture(); try {
    await seed(f);
    await f.ok("report.freeze", { name: "历史场景快照", D: new Date().toISOString().slice(0, 10), F: new Date().toISOString() }, "history");
    const ownerHistory = (await f.record("history", "reports")).data; assert.equal(ownerHistory.sourceRevisions.filter((r: any) => r.kind === "railSafety").length, 3);
    for (const [username, roles, models] of [["no-models", ["resource"], false], ["reader", ["viewer"], true], ["writer", ["resource"], true]] as const) await f.ok("member.save", { username, displayName: username, password, roles, resourceAccess: { models } });
    await f.login("no-models");
    assert.equal((await f.record("limit")).status, 403); const hidden = await f.state(); assert.deepEqual(hidden.collections.railSafety, []);
    const report = (await f.record("history", "reports")).data; assert.equal(report.sourceRevisions.some((r: any) => r.kind === "railSafety"), false); assert.equal(JSON.stringify(report).includes('"definition"'), false);
    for (const type of ["railSafety.save", "railSafety.remove"] as const) { const r = await f.command(type, { name: "forbidden", definition: limit() }, "limit", 999); assert.equal(r.status, 403); assert.equal(r.data.current, undefined); }
    await f.login("reader"); assert.deepEqual((await f.record("limit")).data.definition, limit()); assert.equal((await f.command("railSafety.remove", {}, "limit", 1)).status, 403);
    const writerCookie = await f.login("writer"), payload = { name: "写入成功", definition: guard() };
    await f.ok("railSafety.save", payload, "guard", 1, { key: "writer-key" }); await f.login("owner");
    const member = (await f.state()).members.find((v: any) => v.username === "writer");
    await f.ok("member.save", { username: "writer", displayName: "writer", roles: ["resource"], resourceAccess: { models: false } }, undefined, member.revision);
    const replay = await f.command("railSafety.save", payload, "guard", 1, { key: "writer-key", cookie: writerCookie }); assert.equal(replay.status, 403); assert.equal(replay.data.current, undefined);
    await f.restart(); assert.deepEqual((await f.record("history", "reports")).data, ownerHistory, "redacting public history does not alter the stored frozen snapshot");
  } finally { await f.close(); }
});

test("rail safety project/task scope cannot be bypassed with global objects or cross-task limit references", async () => {
  const f = await fixture(); try {
    await seed(f); await f.ok("task.create", { name: "A任务", areaIds: [] }, "A"); await f.ok("task.create", { name: "B任务", areaIds: [] }, "B");
    await f.ok("railSafety.save", { name: "B限界", taskId: "B", definition: limit() }, "limit-B", 0);
    assert.equal((await f.command("railSafety.save", { name: "跨任务配置", taskId: "A", definition: { ...machine(), selectedLimitIds: ["limit-B"] } }, "machine-config", 1)).data.code, "RAIL_SAFETY_TASK_MISMATCH");
    assert.equal((await f.command("railSafety.save", { name: "改变被引用限界任务", taskId: "B", definition: limit() }, "limit", 1)).data.code, "RAIL_SAFETY_TASK_MISMATCH");
    await f.ok("project.create", { id: "other-project", name: "其他项目" });
    await f.ok("railSafety.save", { name: "其他项目限界", definition: limit() }, "foreign-limit", 0, { projectId: "other-project" });
    assert.equal((await f.command("railSafety.save", { name: "跨项目引用", definition: { ...machine(), selectedLimitIds: ["foreign-limit"] } }, "machine-config", 1)).status, 404);
    await f.ok("member.save", { username: "scoped", displayName: "仅A", password, roles: ["resource"], taskIds: ["A"] }); await f.login("scoped");
    assert.deepEqual((await f.state()).collections.railSafety, []); assert.equal((await f.record("limit")).status, 403); assert.equal((await f.record("limit-B")).status, 403);
    assert.equal((await f.command("railSafety.save", { name: "全局绕过", definition: limit() }, "scope-bypass", 0)).status, 403);
  } finally { await f.close(); }
});

test("definition validation accepts local concave and dateline polygons, and authorization includes nested machine references", () => {
  const concave = [point(), point(30), point(30, 30), point(15, 15), point(0, 30)]; assert.deepEqual(validateRailSafetyPolygon(concave), concave);
  const dateline = [{ longitude: 179.9999, latitude: 0, height: 0 }, { longitude: -179.9999, latitude: 0, height: 0 }, { longitude: -179.9999, latitude: 0.0002, height: 0 }, { longitude: 179.9999, latitude: 0.0002, height: 0 }]; assert.deepEqual(validateRailSafetyPolygon(dateline), dateline);
  assert.throws(() => validateRailSafetyDefinition({ ...limit(), polygon: [point(), point(30), point(15), point(15, 30), point(0, 30)] }), /自交|接触/);
  const base = { id: "control", projectId, revision: 1, name: "control", status: "active", createdAt: "now", updatedAt: "now", createdBy: "owner" };
  const records: Record<string, ManagementRecord> = { A: { ...base, id: "A" }, B: { ...base, id: "B" }, limit: { ...base, id: "limit", taskId: "B", definition: limit() }, machine: { ...base, id: "machine", taskId: "A", kind: "equipment" } };
  const source: RecordSource = { get: (_kind, id) => { if (!records[id]) throw new Error("not found"); return records[id]; }, list: () => [] };
  const actor: Actor = { id: "a", displayName: "a", roles: ["resource"], permissions: ["read", "models", "resource"], authMode: "local-account", taskIds: ["A"] };
  assert.equal(canAccessRecord(actor, "railSafety", { ...base, definition: guard() }, source), false, "an unscoped object cannot become accessible through an allowed resource");
  assert.equal(canAccessRecord(actor, "railSafety", { ...base, taskId: "A", definition: machine() }, source), false, "an A task wrapper cannot hide its B task limit");
  assert.deepEqual(recordReferences({ definition: machine() }, "railSafety"), [{ kind: "resources", id: "machine" }, { kind: "railSafety", id: "limit" }]);
  const resource = { ...base, id: "machine", kind: "equipment" }, aGuard = { ...base, id: "guard-A", taskId: "A", definition: guard() }, bGuard = { ...base, id: "guard-B", taskId: "B", definition: guard() };
  const consumers: ManagementRecord[] = [aGuard];
  const reverseSource: RecordSource = { get: (kind, id) => kind === "resources" ? resource : consumers.find(v => v.id === id)!, list: kind => kind === "railSafety" ? consumers : [] };
  assert.equal(canAccessRecord(actor, "resources", resource, reverseSource), true, "a task-specific rail safety assignment binds the resource task scope");
  consumers.push(bGuard); assert.equal(canAccessRecord(actor, "resources", resource, reverseSource), false, "a resource shared by A and B is not disclosed to an A-only actor");
});
