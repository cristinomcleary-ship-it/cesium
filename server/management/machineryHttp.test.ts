import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createManagementStore } from "../managementStore.ts";
import { MACHINERY_ASSET_VERSION, type MachineryAssetId, type MachineryMetadata } from "../../src/machineryTypes.ts";
import { MACHINERY_PARAMETER_DEFAULTS, MachineryValidationError, validateMachineryMetadata } from "../../src/machineryValidation.ts";
import type { ManagementCommandType } from "../../src/managementTypes.ts";

const projectId = "safety:project", password = `Machinery-${randomUUID()}!`;
function model(assetId: MachineryAssetId = "crane", scale = 1): MachineryMetadata {
  return { schemaVersion: 1, assetId, assetVersion: MACHINERY_ASSET_VERSION, proportional: true,
    parameters: Object.fromEntries(Object.entries(MACHINERY_PARAMETER_DEFAULTS[assetId]).map(([k, v]) => [k, k === "boom_rotation_deg" || k === "boom_elevation_deg" ? v : v * scale])),
    placement: { longitude: 116.397, latitude: 39.908, height: 47.25, heading: 120 }, visible: true };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cesium-machinery-http-"));
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
    const text = await response.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data, text };
  }
  async function command(type: ManagementCommandType, payload: Record<string, unknown> = {}, id?: string, expectedRevision?: number, options: { projectId?: string; key?: string; cookie?: string } = {}) {
    return request("/__management/commands", { projectId: options.projectId ?? projectId, type, payload, id, expectedRevision, idempotencyKey: options.key ?? `machinery-${++sequence}` }, options.cookie);
  }
  async function ok(type: ManagementCommandType, payload: Record<string, unknown> = {}, id?: string, expectedRevision?: number, options: { projectId?: string; key?: string } = {}) {
    const r = await command(type, payload, id, expectedRevision, options); assert.equal(r.status, 200, `${type}: ${r.text}`); return r.data;
  }
  async function record(id: string, project = projectId) { return request(`/__management/records/resources/${id}?projectId=${encodeURIComponent(project)}`); }
  async function state(project = projectId) { const r = await request(`/__management/state?projectId=${encodeURIComponent(project)}`); assert.equal(r.status, 200, r.text); return r.data; }
  async function login(username: string) { const r = await request("/__management/session", { username, password, projectId }); assert.equal(r.status, 200, r.text); return cookie; }
  await start();
  await ok("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  const ownerId = (await state()).session.userId;
  return { request, command, ok, record, state, login, ownerId, async restart(editFixture?: (database: DatabaseSync) => void) {
    await stop();
    if (editFixture) {
      const database = new DatabaseSync(join(root, "management.sqlite"));
      try { editFixture(database); } finally { database.close(); }
    }
    await start();
  }, async close() { await stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("machinery HTTP persists in the equipment resource across SQLite restart; revisions, receipts and audit remain authoritative", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "隔离设备", kind: "equipment", specification: "未核验厂家规格", quantity: 1, unit: "台", ownerId: f.ownerId, locationDescription: "原台账站位说明", availability: "disabled", validUntil: "2099-01-01" }, "machine");
    const original = (await f.record("machine")).data, metadata = model("crane", 2);
    metadata.parameters.boom_rotation_deg = 90;
    const saved = await f.ok("machinery.save", { machinery: metadata, reason: "保存显示模型" }, "machine", 1, { key: "save-once" });
    const attached = saved.collections.resources.find((r: any) => r.id === "machine");
    assert.equal(attached.revision, 2); assert.deepEqual(attached.machinery, metadata);
    for (const [key, value] of Object.entries(original)) if (!["revision", "updatedAt"].includes(key)) assert.deepEqual(attached[key], value, `resource ${key} is preserved`);
    assert.equal(attached.availability, "disabled"); assert.equal(attached.confirmedAt, undefined); assert.equal(attached.qualityAcceptedAt, undefined);
    const replay = await f.ok("machinery.save", { machinery: metadata, reason: "保存显示模型" }, "machine", 1, { key: "save-once" });
    assert.equal(replay.collections.resources[0].revision, 2);
    assert.equal(replay.audit.filter((a: any) => a.command === "machinery.save").length, 1);
    const conflict = await f.command("machinery.save", { machinery: { ...metadata, visible: false } }, "machine", 1, { key: "save-once" });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, "IDEMPOTENCY_CONFLICT");
    const stale = await f.command("machinery.save", { machinery: metadata }, "machine", 1);
    assert.equal(stale.status, 409); assert.equal(stale.data.code, "REVISION_CONFLICT"); assert.equal(stale.data.current.revision, 2);
    await f.restart();
    assert.deepEqual((await f.record("machine")).data, attached, "persisted metadata survives closing and reopening the real SQLite database");
    const moved = { ...metadata, parameters: { ...metadata.parameters, boom_rotation_deg: 0 }, visible: false, placement: { longitude: -180, latitude: 90, height: -10, heading: 0 } };
    await f.ok("machinery.save", { machinery: moved }, "machine", 2);
    await f.restart();
    assert.deepEqual((await f.record("machine")).data.machinery, moved, "zero rotation is a persisted angle, not a missing or invalid dimension");
    const removed = await f.ok("machinery.remove", { reason: "解除显示模型" }, "machine", 3);
    assert.equal(removed.collections.resources.length, 1);
    const remaining = removed.collections.resources[0]; assert.equal(remaining.revision, 4); assert.equal(remaining.machinery, undefined);
    for (const [key, value] of Object.entries(original)) if (!["revision", "updatedAt"].includes(key)) assert.deepEqual(remaining[key], value);
    const audits = removed.audit.filter((a: any) => a.command.startsWith("machinery."));
    assert.deepEqual(audits.map((a: any) => [a.command, a.beforeRevision, a.afterRevision, a.actorId]).sort((a: any, b: any) => a[1] - b[1]), [["machinery.save", 1, 2, f.ownerId], ["machinery.save", 2, 3, f.ownerId], ["machinery.remove", 3, 4, f.ownerId]]);
    await f.restart(); assert.equal((await f.record("machine")).data.machinery, undefined);
  } finally { await f.close(); }
});

test("legacy crane SQLite records default rotation only in detached reads and preserve IDs, placement and history when saved", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "旧版吊机", kind: "equipment", locationDescription: "保留原站位" }, "legacy-crane");
    const legacy = model(); delete legacy.parameters.boom_rotation_deg;
    await f.ok("machinery.save", { machinery: legacy }, "legacy-crane", 1);
    assert.equal((await f.record("legacy-crane")).data.machinery.parameters.boom_rotation_deg, 0, "old clients can still save their complete pre-rotation parameter set");
    // Represent an existing pre-upgrade database inside this test's isolated temporary directory.
    await f.restart(database => {
      const row = database.prepare("SELECT data FROM records WHERE project_id=? AND collection='resources' AND id=?").get(projectId, "legacy-crane")!;
      const record = JSON.parse(String(row.data)); delete record.machinery.parameters.boom_rotation_deg;
      database.prepare("UPDATE records SET data=? WHERE project_id=? AND collection='resources' AND id=?").run(JSON.stringify(record), projectId, "legacy-crane");
    });
    const before = (await f.record("legacy-crane")).data;
    const beforeState = await f.state();
    assert.equal(Object.hasOwn(before.machinery.parameters, "boom_rotation_deg"), false);
    const restored = validateMachineryMetadata(before.machinery);
    assert.equal(restored.parameters.boom_rotation_deg, 0);
    assert.deepEqual((await f.record("legacy-crane")).data, before, "loading does not migrate or revise the stored equipment");
    restored.parameters.boom_rotation_deg = 359.999;
    await f.ok("machinery.save", { machinery: restored }, "legacy-crane", before.revision);
    await f.restart();
    const saved = (await f.record("legacy-crane")).data;
    for (const [key, value] of Object.entries(before)) if (!["machinery", "revision", "updatedAt"].includes(key)) assert.deepEqual(saved[key], value, `legacy resource ${key} is retained`);
    assert.deepEqual(saved.machinery, restored);
    assert.deepEqual(saved.machinery.placement, before.machinery.placement);
    assert.equal(saved.revision, before.revision + 1);
    const savedState = await f.state();
    for (const previousAudit of beforeState.audit) assert.deepEqual(savedState.audit.find((entry: any) => entry.id === previousAudit.id), previousAudit, "existing audit entries are not rewritten");
  } finally { await f.close(); }
});

test("crane elevation accepts both endpoints and persists through SQLite restart; legacy reads keep source elevation and existing slew", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "俯仰吊机", kind: "equipment" }, "elevation-crane");
    const original = model(); original.parameters.boom_rotation_deg = 270;
    await f.ok("machinery.save", { machinery: original }, "elevation-crane", 1);
    await f.restart(database => {
      const row = database.prepare("SELECT data FROM records WHERE project_id=? AND collection='resources' AND id=?").get(projectId, "elevation-crane")!;
      const record = JSON.parse(String(row.data)); delete record.machinery.parameters.boom_elevation_deg;
      database.prepare("UPDATE records SET data=? WHERE project_id=? AND collection='resources' AND id=?").run(JSON.stringify(record), projectId, "elevation-crane");
    });
    const legacy = (await f.record("elevation-crane")).data;
    const restored = validateMachineryMetadata(legacy.machinery);
    assert.equal(restored.parameters.boom_elevation_deg, MACHINERY_PARAMETER_DEFAULTS.crane.boom_elevation_deg);
    assert.equal(restored.parameters.boom_rotation_deg, 270);
    assert.deepEqual((await f.record("elevation-crane")).data, legacy, "reading legacy elevation does not rewrite or revise the resource");
    const preAngles = structuredClone(legacy.machinery); delete preAngles.parameters.boom_rotation_deg;
    const noAngles = validateMachineryMetadata(preAngles);
    assert.equal(noAngles.parameters.boom_rotation_deg, 0);
    assert.equal(noAngles.parameters.boom_elevation_deg, MACHINERY_PARAMETER_DEFAULTS.crane.boom_elevation_deg);
    await f.ok("machinery.save", { machinery: preAngles }, "elevation-crane", 2);
    let revision = 3;
    for (const angle of [0, 45.25, 90, MACHINERY_PARAMETER_DEFAULTS.crane.boom_elevation_deg]) {
      const expected = { ...restored, parameters: { ...restored.parameters, boom_elevation_deg: angle } };
      await f.ok("machinery.save", { machinery: expected }, "elevation-crane", revision++);
      await f.restart();
      const saved = (await f.record("elevation-crane")).data;
      assert.deepEqual(saved.machinery, expected);
      assert.equal(saved.id, legacy.id);
      assert.equal(saved.revision, revision);
      assert.deepEqual(saved.machinery.placement, legacy.machinery.placement);
    }
  } finally { await f.close(); }
});

test("whole-machine headings persist for all assets without altering station, articulation, stable IDs or existing history", async () => {
  const f = await fixture(); try {
    for (const assetId of ["crane", "pile", "excavator"] as const) {
      const id = `heading-${assetId}`, original = model(assetId, 2);
      if (assetId === "crane") { original.parameters.boom_rotation_deg = 75; original.parameters.boom_elevation_deg = 30; }
      await f.ok("resource.create", { name: `整机旋转-${assetId}`, kind: "equipment", availability: "disabled", locationDescription: "既有工点" }, id);
      await f.ok("machinery.save", { machinery: original }, id, 1);
      const before = (await f.record(id)).data;
      let revision = 2;
      for (const heading of [0, 90, 359.999]) {
        const rotated = structuredClone(original); rotated.placement.heading = heading;
        await f.ok("machinery.save", { machinery: rotated }, id, revision++);
        await f.restart();
        const saved = (await f.record(id)).data;
        assert.deepEqual(saved.machinery, rotated, "the complete pose survives a real SQLite close/reopen");
        assert.deepEqual(saved.machinery.parameters, before.machinery.parameters, "global heading does not change boom angles or dimensions");
        for (const key of ["longitude", "latitude", "height"] as const) assert.equal(saved.machinery.placement[key], before.machinery.placement[key]);
        for (const [key, value] of Object.entries(before)) if (!["revision", "updatedAt", "machinery"].includes(key)) assert.deepEqual(saved[key], value, `heading preserves ${key}`);
        assert.equal(saved.revision, revision);
      }
    }
    const audits = (await f.state()).audit.filter((entry: any) => entry.command === "machinery.save");
    assert.equal(audits.length, 12, "each of the three attachments and nine heading edits retains its own history entry");
  } finally { await f.close(); }
});

test("machinery HTTP validates complete versioned parameters and placement atomically before any write", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "验证设备", kind: "equipment" }, "machine");
    const original = (await f.record("machine")).data, source = model();
    const invalid: [string, (m: any) => void][] = [
      ["schema", m => m.schemaVersion = 2], ["version", m => m.assetVersion = "old"], ["asset", m => m.assetId = "unknown"],
      ["missing key", m => delete m.parameters.body_height_m], ["extra key", m => m.parameters.unsafe_scale = 2],
      ["zero", m => m.parameters.boom_length_m = 0], ["negative", m => m.parameters.boom_length_m = -1],
      ["numeric string", m => m.parameters.boom_length_m = "3"], ["null", m => m.parameters.boom_length_m = null],
      ["overflow", m => m.parameters.boom_length_m = 1e100], ["underflow", m => m.parameters.overall_scale = 1e-200],
      ["body mismatch", m => m.parameters.body_height_m *= 2], ["local minimum", m => m.parameters.boom_length_m = 0.1],
      ["negative rotation", m => m.parameters.boom_rotation_deg = -0.01], ["full turn", m => m.parameters.boom_rotation_deg = 360],
      ["rotation string", m => m.parameters.boom_rotation_deg = "90"], ["rotation null", m => m.parameters.boom_rotation_deg = null],
      ["rotation overflow", m => m.parameters.boom_rotation_deg = 1e100],
      ["negative elevation", m => m.parameters.boom_elevation_deg = -0.01], ["elevation above vertical", m => m.parameters.boom_elevation_deg = 90.01],
      ["elevation string", m => m.parameters.boom_elevation_deg = "45"], ["elevation null", m => m.parameters.boom_elevation_deg = null],
      ["longitude", m => m.placement.longitude = 180.01], ["latitude", m => m.placement.latitude = -90.01],
      ["height", m => m.placement.height = 100001], ["heading", m => m.placement.heading = 360],
      ["negative heading", m => m.placement.heading = -0.001], ["heading overflow", m => m.placement.heading = 1e100],
      ["heading string", m => m.placement.heading = "90"], ["heading null", m => m.placement.heading = null],
      ["mode", m => m.proportional = "true"], ["visibility", m => m.visible = 1],
      ["injected qualification", m => m.qualified = true], ["placement extra", m => m.placement.modelMatrix = []],
    ];
    for (const [label, mutate] of invalid) {
      const metadata = structuredClone(source); mutate(metadata);
      const r = await f.command("machinery.save", { machinery: metadata }, "machine", 1);
      assert.equal(r.status, 400, `${label}: ${r.text}`); assert.equal(r.data.code, "INVALID_MACHINERY", label);
      assert.deepEqual((await f.record("machine")).data, original, `${label} does not increment or overwrite the resource`);
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      const metadata = model(); metadata.parameters.overall_scale = value;
      assert.throws(() => validateMachineryMetadata(metadata), MachineryValidationError, "non-JSON numeric values also fail the shared validator");
      const rotated = model(); rotated.parameters.boom_rotation_deg = value;
      assert.throws(() => validateMachineryMetadata(rotated), MachineryValidationError, "rotation must be finite before JSON encoding");
      const elevated = model(); elevated.parameters.boom_elevation_deg = value;
      assert.throws(() => validateMachineryMetadata(elevated), MachineryValidationError, "elevation must be finite before JSON encoding");
      const heading = model(); heading.placement.heading = value;
      assert.throws(() => validateMachineryMetadata(heading), MachineryValidationError, "whole-machine heading must be finite before JSON encoding");
    }
    const wrongAsset = model("pile"); wrongAsset.parameters.boom_rotation_deg = 90;
    assert.equal((await f.command("machinery.save", { machinery: wrongAsset }, "machine", 1)).status, 400, "rotation is not an allowed pile parameter");
    for (const assetId of ["pile", "excavator"] as const) {
      const unexpectedElevation = model(assetId); unexpectedElevation.parameters.boom_elevation_deg = 45;
      assert.equal((await f.command("machinery.save", { machinery: unexpectedElevation }, "machine", 1)).status, 400, "elevation is only a crane parameter");
    }
    assert.equal((await f.command("machinery.save", { machinery: source, availability: "ready" }, "machine", 1)).data.code, "INVALID_MACHINERY_PAYLOAD");
    assert.equal((await f.state()).audit.filter((a: any) => a.command.startsWith("machinery.")).length, 0);
  } finally { await f.close(); }
});

test("machinery HTTP accepts all three assets and preserved independent poses in either editing mode, without confirming resource needs", async () => {
  const f = await fixture(); try {
    for (const assetId of ["crane", "pile", "excavator"] as const) {
      await f.ok("resource.create", { name: assetId, kind: "equipment", availability: "available" }, assetId);
      await f.ok("machinery.save", { machinery: model(assetId, 2) }, assetId, 1);
    }
    await f.ok("task.create", { name: "隔离任务", ownerId: f.ownerId }, "task");
    await f.ok("need.create", { name: "需用机械", kind: "equipment", taskId: "task", resourceId: "crane", dueDate: "2099-01-01" }, "need");
    let crane = model("crane", 2); crane.parameters.outrigger_lateral_m *= 1.5; crane.proportional = false;
    await f.ok("machinery.save", { machinery: crane }, "crane", 2);
    crane = { ...crane, proportional: true }; await f.ok("machinery.save", { machinery: crane }, "crane", 3);
    assert.deepEqual((await f.record("crane")).data.machinery.parameters, crane.parameters, "changing editing mode keeps an independent pose");
    let state = await f.state(); assert.equal(state.collections.resourceNeeds[0].status, "unconfirmed", "geometry cannot confirm equipment readiness");
    await f.ok("need.confirm", { basis: "隔离业务核验" }, "need", 1);
    await f.ok("machinery.remove", {}, "crane", 4);
    state = await f.state(); assert.equal(state.collections.resourceNeeds[0].status, "confirmed", "detaching display geometry does not rewrite business confirmation");
    const pile = model("pile", 2); pile.parameters.total_height_m *= 1.5; pile.proportional = false;
    await f.ok("machinery.save", { machinery: pile }, "pile", 2);
    await f.ok("machinery.save", { machinery: { ...pile, proportional: true } }, "pile", 3);
    const shortPile = model("pile", 2); shortPile.parameters.total_height_m = 0.5;
    assert.equal((await f.command("machinery.save", { machinery: shortPile }, "pile", 4)).status, 400);
    const distorted = model("excavator", 2); distorted.parameters.overall_height_m *= 1.5;
    assert.equal((await f.command("machinery.save", { machinery: distorted }, "excavator", 2)).status, 400);
  } finally { await f.close(); }
});

test("machinery HTTP requires both live resource and models permissions before conflicts and idempotent replay", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "SECRET EQUIPMENT", kind: "equipment" }, "machine");
    await f.ok("member.save", { username: "resource", displayName: "Resource", password, roles: ["resource"] });
    await f.ok("member.save", { username: "no-models", displayName: "No models", password, roles: ["resource"], resourceAccess: { models: false } });
    await f.ok("member.save", { username: "viewer", displayName: "Viewer", password, roles: ["viewer"] });
    await f.ok("task.create", { name: "A", ownerId: f.ownerId }, "A");
    await f.ok("member.save", { username: "scoped", displayName: "Scoped", password, roles: ["resource"], taskIds: ["A"] });
    for (const username of ["no-models", "viewer", "scoped"]) {
      await f.login(username);
      for (const type of ["machinery.save", "machinery.remove"] as const) {
        const r = await f.command(type, type === "machinery.save" ? { machinery: model() } : {}, "machine", 999);
        assert.equal(r.status, 403, `${username}: ${r.text}`); assert.equal(r.data.current, undefined); assert.equal(r.text.includes("SECRET"), false);
      }
    }
    await f.login("resource");
    await f.ok("machinery.save", { machinery: model() }, "machine", 1, { key: "resource-save" });
    const resourceCookie = await f.login("resource"); await f.login("owner");
    const member = (await f.state()).members.find((m: any) => m.username === "resource");
    await f.ok("member.save", { username: "resource", displayName: "Resource", roles: ["resource"], resourceAccess: { models: false } }, undefined, member.revision);
    const replay = await f.command("machinery.save", { machinery: model() }, "machine", 1, { key: "resource-save", cookie: resourceCookie });
    assert.equal(replay.status, 403, "a still-valid session and old receipt cannot bypass a live models grant revocation");
    assert.equal((await f.record("machine")).data.revision, 2);
    const anonymous = await f.command("machinery.remove", {}, "machine", 2, { cookie: "" }); assert.equal(anonymous.status, 401);
  } finally { await f.close(); }
});

test("machinery HTTP cannot create a parallel resource, attach to other resource kinds, cross projects, or alter attached equipment kind", async () => {
  const f = await fixture(); try {
    assert.equal((await f.command("machinery.save", { machinery: model() }, "missing", 0)).status, 404);
    await f.ok("resource.create", { name: "班组", kind: "crew", machinery: model() }, "crew");
    assert.equal((await f.record("crew")).data.machinery, undefined, "generic creation cannot inject model data");
    assert.equal((await f.command("machinery.save", { machinery: model() }, "crew", 1)).data.code, "MACHINERY_RESOURCE_KIND");
    await f.ok("resource.create", { name: "设备", kind: "equipment" }, "machine");
    await f.ok("machinery.save", { machinery: model() }, "machine", 1);
    assert.equal((await f.command("resource.update", { name: "班组", kind: "crew", reason: "改类别" }, "machine", 2)).data.code, "MACHINERY_RESOURCE_KIND");
    await f.ok("resource.update", { name: "设备改名", kind: "equipment", machinery: model("pile"), reason: "正常台账修改" }, "machine", 2);
    assert.equal((await f.record("machine")).data.machinery.assetId, "crane", "generic updates cannot replace model metadata");
    await f.ok("project.create", { id: "project-b", name: "隔离项目B", isTest: true });
    await f.ok("resource.create", { name: "B only", kind: "equipment" }, "only-b", undefined, { projectId: "project-b" });
    const wrongProject = await f.command("machinery.save", { machinery: model() }, "only-b", 1);
    assert.equal(wrongProject.status, 404); assert.equal(wrongProject.data.current, undefined);
    await f.ok("machinery.save", { machinery: model("pile") }, "only-b", 1, { projectId: "project-b" });
    await f.ok("member.save", { username: "only-a", displayName: "A only", password, roles: ["resource"] });
    await f.login("only-a");
    assert.equal((await f.command("machinery.remove", {}, "only-b", 2, { projectId: "project-b" })).status, 403);
    assert.equal((await f.record("only-b", "project-b")).status, 403);
    await f.login("owner"); assert.equal((await f.record("only-b", "project-b")).data.machinery.assetId, "pile");
    await f.ok("machinery.remove", {}, "machine", 3);
    assert.equal((await f.command("machinery.remove", {}, "machine", 4)).data.code, "MACHINERY_NOT_ATTACHED");
    await f.ok("resource.update", { name: "已解除模型", kind: "crew", reason: "解除后改类别" }, "machine", 4);
    assert.equal((await f.record("machine")).data.kind, "crew");
  } finally { await f.close(); }
});

test("machinery HTTP models read grant protects records, snapshots, receipts, conflicts and nested report history without erasing stored metadata", async () => {
  const f = await fixture(); try {
    const metadata = model("crane", 2);
    await f.ok("resource.create", { name: "可见设备台账", kind: "equipment", specification: "公开型号", quantity: 1, unit: "台", availability: "disabled" }, "machine");
    await f.ok("machinery.save", { machinery: metadata }, "machine", 1);
    await f.ok("report.freeze", { name: "含设备历史的报告", D: new Date().toISOString().slice(0, 10), F: new Date().toISOString() }, "history-report");
    for (const [username, roles, models] of [["resource-no-models", ["resource"], false], ["read-no-models", ["viewer"], false], ["read-models", ["viewer"], true]] as const) {
      await f.ok("member.save", { username, displayName: username, password, roles, resourceAccess: { models } });
    }
    function assertRedacted(resource: any) {
      assert.equal(resource.name, "可见设备台账"); assert.equal(resource.specification, "公开型号"); assert.equal(resource.quantity, 1);
      assert.equal(resource.availability, "disabled"); assert.equal(Object.hasOwn(resource, "machinery"), false);
    }
    function assertSnapshotRedacted(snapshot: any) {
      assertRedacted(snapshot.collections.resources.find((r: any) => r.id === "machine"));
      const historic = snapshot.collections.reports[0].sourceRevisions.find((r: any) => r.kind === "resources" && r.id === "machine").data;
      assertRedacted(historic); assert.equal(JSON.stringify(snapshot.collections).includes('"machinery"'), false);
    }
    for (const username of ["resource-no-models", "read-no-models"]) {
      await f.login(username);
      assertRedacted((await f.record("machine")).data);
      assertSnapshotRedacted(await f.state());
      const snapshotAlias = await f.request(`/__management/snapshot?projectId=${projectId}`); assert.equal(snapshotAlias.status, 200); assertSnapshotRedacted(snapshotAlias.data);
      const report = await f.request(`/__management/records/reports/history-report?projectId=${projectId}`);
      assert.equal(report.status, 200); assertRedacted(report.data.sourceRevisions.find((r: any) => r.kind === "resources" && r.id === "machine").data);
    }
    await f.login("resource-no-models");
    const payload = { name: "可见设备台账", kind: "equipment", reason: "只编辑台账说明", specification: "公开型号", quantity: 1, unit: "台", availability: "disabled", locationDescription: "业务描述更新" };
    const conflict = await f.command("resource.update", payload, "machine", 999);
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, "REVISION_CONFLICT"); assertRedacted(conflict.data.current);
    const updated = await f.ok("resource.update", payload, "machine", 2, { key: "no-models-update" });
    assertSnapshotRedacted(updated);
    const receipt = await f.ok("resource.update", payload, "machine", 2, { key: "no-models-update" });
    assertSnapshotRedacted(receipt); assert.equal(receipt.collections.resources[0].revision, 3);
    assert.equal((await f.command("resource.update", { name: "班组", kind: "crew", reason: "尝试隐藏模型" }, "machine", 3)).data.code, "MACHINERY_RESOURCE_KIND", "domain still sees the attached model and protects its kind");
    for (const username of ["owner", "read-models"]) {
      await f.login(username);
      const resource = (await f.record("machine")).data; assert.equal(resource.locationDescription, "业务描述更新"); assert.deepEqual(resource.machinery, metadata);
      const state = await f.state(); assert.deepEqual(state.collections.resources[0].machinery, metadata);
      assert.deepEqual(state.collections.reports[0].sourceRevisions.find((r: any) => r.kind === "resources" && r.id === "machine").data.machinery, metadata, "redacting report responses does not rewrite frozen history");
    }
    await f.login("owner");
    const authorizedConflict = await f.command("resource.update", payload, "machine", 999);
    assert.equal(authorizedConflict.status, 409); assert.deepEqual(authorizedConflict.data.current.machinery, metadata);
    await f.restart(); assert.deepEqual((await f.record("machine")).data.machinery, metadata);
  } finally { await f.close(); }
});
