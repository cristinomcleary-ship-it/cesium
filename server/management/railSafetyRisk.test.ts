import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagementStore } from "../managementStore.ts";
import type { ManagementCommandType } from "../../src/managementTypes.ts";
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from "../../src/machineryTypes.ts";
import { MACHINERY_PARAMETER_DEFAULTS } from "../../src/machineryValidation.ts";
import { RAIL_SAFETY_RISK_METHOD, type RailSafetyRiskReportPayload } from "../../src/railSafetyRiskTypes.ts";

const projectId = "safety:project", now = "2026-10-14T07:00:00.000Z", password = `Risk-${randomUUID()}!`;
const polygon = [
  { longitude: 116.397, latitude: 39.908, height: 45 },
  { longitude: 116.3973, latitude: 39.908, height: 45 },
  { longitude: 116.3973, latitude: 39.9083, height: 45 },
  { longitude: 116.397, latitude: 39.9083, height: 45 },
];
const model = (): MachineryMetadata => ({ schemaVersion: 1, assetId: "crane", assetVersion: MACHINERY_ASSET_VERSION, proportional: true,
  parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane }, placement: { longitude: 116.3972, latitude: 39.9082, height: 45, heading: 35 }, visible: true });
const limit = () => ({ schemaVersion: 1, kind: "limit", polygon: structuredClone(polygon) });
const config = () => ({ schemaVersion: 1, kind: "machine", resourceId: "machine", selectedLimitIds: ["limit"], support: { length: 4, width: 2, centerX: 0, centerZ: 0 } });
const report = (taskId?: string): RailSafetyRiskReportPayload => ({ name: "吊机与铁路限界潜在相交", description: "请现场核对站位与机械工况", resourceId: "machine", resourceRevision: 2,
  machineConfigId: "config", machineConfigRevision: 1, limitId: "limit", limitRevision: 1,
  ...(taskId ? { taskId, taskRevision: 1 } : {}),
  screening: { schemaVersion: 1, source: "browser-geometric-screening", method: RAIL_SAFETY_RISK_METHOD, capturedAt: now, status: "overlap", distanceMeters: 0, maxDistanceMeters: 8.4, warnings: ["保守几何外包，待现场核实"] } });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cesium-risk-workflow-"));
  let store: ReturnType<typeof createManagementStore>, server: Server, base = "", cookie = "", sequence = 0;
  async function start() {
    store = createManagementStore({ dataDir: root, libraryDataDir: root, now: () => now });
    server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); })));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function stop() { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  async function request(path: string, body?: unknown, auth = cookie) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie: auth }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data, text };
  }
  const command = (type: ManagementCommandType, payload: object = {}, id?: string, expectedRevision?: number, options: { key?: string; cookie?: string; projectId?: string } = {}) => request("/__management/commands", { projectId: options.projectId ?? projectId, type, payload, id, expectedRevision, idempotencyKey: options.key ?? `risk-${++sequence}` }, options.cookie);
  async function ok(type: ManagementCommandType, payload: object = {}, id?: string, expectedRevision?: number, options: { key?: string; projectId?: string } = {}) {
    const result = await command(type, payload, id, expectedRevision, options); assert.equal(result.status, 200, `${type}: ${result.text}`); return result.data;
  }
  async function state() { const result = await request(`/__management/state?projectId=${projectId}`); assert.equal(result.status, 200, result.text); return result.data; }
  async function login(username: string) { const result = await request("/__management/session", { username, password, projectId }); assert.equal(result.status, 200, result.text); return cookie; }
  await start(); await ok("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  return { command, ok, state, request, login, async restart() { await stop(); await start(); }, async close() { await stop(); rmSync(root, { recursive: true, force: true }); } };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, taskId?: string) {
  if (taskId) await f.ok("task.create", { name: "营业线旁吊装任务", areaIds: [] }, taskId);
  await f.ok("resource.create", { name: "现场吊机", kind: "equipment", availability: "disabled" }, "machine");
  await f.ok("machinery.save", { machinery: model() }, "machine", 1);
  await f.ok("railSafety.save", { name: "铁路设备限界", ...(taskId ? { taskId } : {}), definition: limit() }, "limit", 0);
  await f.ok("railSafety.save", { name: "吊机管控", ...(taskId ? { taskId } : {}), definition: config() }, "config", 0);
}

test("manual risk registration freezes saved source revisions without approving machinery and survives restart", async () => {
  const f = await fixture(); try {
    await seed(f, "A"); const before = await f.state(), payload = report("A");
    const after = await f.ok("railSafety.reportRisk", payload, "risk", 0, { key: "register-once" });
    const issue = after.collections.issues[0], risk = issue.railSafetyRisk;
    assert.equal(issue.status, "pending-verification"); assert.equal(issue.kind, "safety"); assert.equal(issue.taskId, "A"); assert.equal(issue.blocksCompletion, false);
    assert.equal(risk.serverRecomputed, false); assert.equal(risk.physicalPrediction, false); assert.equal(risk.source, "browser-geometric-screening");
    assert.equal(risk.resourceRevision, 2); assert.equal(risk.machineConfigRevision, 1); assert.equal(risk.limitRevision, 1); assert.equal(risk.taskRevision, 1);
    assert.deepEqual(risk.resourceSnapshot.machinery, model()); assert.deepEqual(risk.machineConfigSnapshot.definition, config()); assert.deepEqual(risk.limitSnapshot.definition, limit());
    assert.deepEqual(after.collections.resources, before.collections.resources); assert.deepEqual(after.collections.railSafety, before.collections.railSafety); assert.deepEqual(after.collections.tasks, before.collections.tasks);
    const audit = after.audit.find((entry: any) => entry.command === "railSafety.reportRisk"); assert.equal(audit.recordId, "risk");
    const replay = await f.ok("railSafety.reportRisk", payload, "risk", 0, { key: "register-once" }); assert.deepEqual(replay, after);
    assert.equal((await f.command("railSafety.reportRisk", { ...payload, name: "changed" }, "risk", 0, { key: "register-once" })).data.code, "IDEMPOTENCY_CONFLICT");
    await f.restart(); assert.deepEqual((await f.state()).collections.issues[0], issue);
  } finally { await f.close(); }
});

test("source revisions and selected saved geometry must remain current; rejected reports write nothing", async () => {
  const f = await fixture(); try {
    await seed(f, "A"); const before = await f.state();
    for (const field of ["resourceRevision", "machineConfigRevision", "limitRevision", "taskRevision"] as const) {
      const payload = report("A"); payload[field] = 99;
      const result = await f.command("railSafety.reportRisk", payload, `stale-${field}`, 0); assert.equal(result.status, 409); assert.equal(result.data.code, "RAIL_SAFETY_SOURCE_CHANGED");
    }
    assert.deepEqual(await f.state(), before);
    await f.ok("railSafety.save", { name: "未选择的限界", taskId: "A", definition: limit() }, "other-limit", 0);
    assert.equal((await f.command("railSafety.reportRisk", { ...report("A"), limitId: "other-limit" }, "unselected", 0)).data.code, "INVALID_RAIL_SAFETY_RISK");
    await f.ok("railSafety.remove", { reason: "停用" }, "limit", 1);
    assert.equal((await f.command("railSafety.reportRisk", { ...report("A"), limitRevision: 2 }, "deleted-limit", 0)).data.code, "INVALID_RAIL_SAFETY_RISK");
    await f.ok("machinery.remove", {}, "machine", 2);
    assert.equal((await f.command("railSafety.reportRisk", { ...report("A"), resourceRevision: 3, limitRevision: 2 }, "missing-model", 0)).data.code, "INVALID_RAIL_SAFETY_RISK");
    assert.equal((await f.state()).collections.issues.length, 0);
  } finally { await f.close(); }
});

test("draft, pose-only, forged provenance, unsafe values and stale capture payloads cannot become risk issues", async () => {
  const f = await fixture(); try {
    await seed(f); const before = await f.state(), base = report();
    const inputs = [
      { ...base, draft: true }, { ...base, positionSnapshot: polygon }, { ...base, railSafetyRisk: { serverRecomputed: true } },
      { ...base, screening: { ...base.screening, draft: true } }, { ...base, screening: { ...base.screening, method: "current-angle-projection" } },
      { ...base, screening: { ...base.screening, source: "server-verified" } }, { ...base, screening: { ...base.screening, status: "clear" } },
      { ...base, screening: { ...base.screening, status: "unknown" } }, { ...base, screening: { ...base.screening, distanceMeters: -1 } },
      { ...base, screening: { ...base.screening, distanceMeters: 100_000 } }, { ...base, screening: { ...base.screening, status: "touching", distanceMeters: 0.01 } },
      { ...base, screening: { ...base.screening, maxDistanceMeters: 1e9 } }, { ...base, screening: { ...base.screening, warnings: "not a list" } },
      { ...base, screening: { ...base.screening, capturedAt: "2026-10-14T06:00:00Z" } }, { ...base, screening: { ...base.screening, capturedAt: "2026-10-14T08:00:00Z" } },
      { ...base, screening: { ...base.screening, capturedAt: "2026-10-14 07:00:00" } }, { ...base, taskRevision: 1 },
    ];
    for (const [index, payload] of inputs.entries()) { const result = await f.command("railSafety.reportRisk", payload, `bad-${index}`, 0); assert.equal(result.status, 400, `${index}: ${result.text}`); }
    assert.deepEqual(await f.state(), before);
  } finally { await f.close(); }
});

test("open machine-limit pair deduplicates across keys and source updates, and existing issue lifecycle remains authoritative", async () => {
  const f = await fixture(); try {
    await seed(f); await f.ok("railSafety.reportRisk", report(), "risk", 0);
    const dupe = await f.command("railSafety.reportRisk", report(), "second", 0); assert.equal(dupe.status, 409); assert.equal(dupe.data.code, "RAIL_SAFETY_RISK_EXISTS"); assert.equal(dupe.data.details.issueId, "risk");
    await f.ok("machinery.save", { machinery: { ...model(), placement: { ...model().placement, heading: 45 } } }, "machine", 2);
    const updated = { ...report(), resourceRevision: 3 };
    assert.equal((await f.command("railSafety.reportRisk", updated, "third", 0)).data.code, "RAIL_SAFETY_RISK_EXISTS");
    await f.ok("railSafety.remove", { reason: "重新建立机械管控配置" }, "config", 1);
    await f.ok("railSafety.save", { name: "重建吊机管控", definition: config() }, "replacement-config", 0);
    const replacement = { ...updated, machineConfigId: "replacement-config" };
    const rebuiltDuplicate = await f.command("railSafety.reportRisk", replacement, "rebuilt-duplicate", 0);
    assert.equal(rebuiltDuplicate.status, 409); assert.equal(rebuiltDuplicate.data.code, "RAIL_SAFETY_RISK_EXISTS"); assert.equal(rebuiltDuplicate.data.details.issueId, "risk");
    assert.equal((await f.state()).collections.issues.length, 1, "recreating a config cannot create a second open issue for the same machine and limit");
    const snapshot = (await f.state()).collections.issues[0].railSafetyRisk, owner = (await f.state()).members.find((member: any) => member.username === "owner").id;
    await f.ok("issue.assign", { ownerId: owner, dueDate: "2026-10-15" }, "risk", 1);
    await f.ok("issue.start", {}, "risk", 2);
    await f.ok("issue.submit", { description: "调整机械站位并现场检查", evidenceIds: [] }, "risk", 3);
    await f.ok("issue.review", { passed: false, reason: "请补充现场核对说明", evidenceIds: [] }, "risk", 4);
    await f.ok("issue.submit", { description: "已补充现场核对", evidenceIds: [] }, "risk", 5);
    await f.ok("issue.review", { passed: true, reason: "现场核对通过", evidenceIds: [] }, "risk", 6);
    const closed = (await f.state()).collections.issues[0]; assert.equal(closed.status, "closed"); assert.equal(closed.rounds.length, 2); assert.deepEqual(closed.railSafetyRisk, snapshot);
    await f.ok("railSafety.reportRisk", replacement, "new-after-closure", 0);
    await f.ok("issue.dismiss", { disposition: "false-positive", reason: "复核为现场尺寸录入误差" }, "new-after-closure", 1);
    await f.ok("railSafety.reportRisk", { ...replacement, screening: { ...replacement.screening, status: "touching", distanceMeters: 1e-7 } }, "new-after-dismissal", 0);
    assert.equal((await f.state()).collections.issues.length, 3);
  } finally { await f.close(); }
});

test("risk submission requires live field and model capabilities even for idempotent receipts; hidden geometry is redacted", async () => {
  const f = await fixture(); try {
    await seed(f);
    for (const [username, roles, models] of [["quality", ["quality"], true], ["resource", ["resource"], true], ["viewer", ["viewer"], true], ["no-models", ["quality"], false]] as const) {
      await f.ok("member.save", { username, displayName: username, password, roles, resourceAccess: { models } });
    }
    for (const username of ["resource", "viewer", "no-models"]) { await f.login(username); assert.equal((await f.command("railSafety.reportRisk", report(), `deny-${username}`, 0)).status, 403); }
    const qualityCookie = await f.login("quality"); await f.ok("railSafety.reportRisk", report(), "risk", 0, { key: "quality-once" });
    await f.login("owner"); await f.ok("report.freeze", { name: "风险处置快照", D: "2026-10-14", F: now }, "report");
    const member = (await f.state()).members.find((member: any) => member.username === "quality");
    await f.ok("member.save", { username: "quality", displayName: "quality", roles: ["quality"], resourceAccess: { models: false } }, undefined, member.revision);
    const denied = await f.command("railSafety.reportRisk", report(), "risk", 0, { key: "quality-once", cookie: qualityCookie }); assert.equal(denied.status, 403); assert.equal(denied.data.current, undefined);
    await f.login("no-models"); const hidden = await f.state(); assert.equal(hidden.collections.issues[0].railSafetyRisk, undefined);
    assert.equal(JSON.stringify(hidden.collections.reports).includes('"railSafetyRisk"'), false); assert.equal(JSON.stringify(hidden.collections.reports).includes('"machinery"'), false);
    await f.login("owner"); assert.equal((await f.state()).collections.issues[0].railSafetyRisk.source, "browser-geometric-screening");
  } finally { await f.close(); }
});

test("task and project sources cannot be substituted, and issue scope follows current source references", async () => {
  const f = await fixture(); try {
    await seed(f, "A"); await f.ok("task.create", { name: "其他任务", areaIds: [] }, "B");
    assert.equal((await f.command("railSafety.reportRisk", report("B"), "wrong-task", 0)).data.code, "INVALID_RAIL_SAFETY_RISK");
    assert.equal((await f.command("railSafety.reportRisk", report(), "global-bypass", 0)).data.code, "INVALID_RAIL_SAFETY_RISK");
    await f.ok("project.create", { id: "other-project", name: "其他项目" });
    await f.ok("railSafety.save", { name: "其他项目限界", definition: limit() }, "foreign-limit", 0, { projectId: "other-project" });
    assert.equal((await f.command("railSafety.reportRisk", { ...report("A"), limitId: "foreign-limit" }, "cross-project", 0)).status, 404);
    for (const taskId of ["A", "B"]) await f.ok("member.save", { username: `only-${taskId.toLowerCase()}`, displayName: taskId, password, roles: ["quality"], taskIds: [taskId] });
    await f.login("only-b"); assert.equal((await f.command("railSafety.reportRisk", report("A"), "scope-bypass", 0)).status, 403);
    await f.login("only-a"); assert.equal((await f.command("railSafety.reportRisk", report("A"), "scoped-models", 0)).status, 403, "existing account policy does not grant project models to task-scoped members");
    await f.login("owner"); await f.ok("railSafety.reportRisk", report("A"), "risk", 0);
    await f.login("only-a"); assert.equal((await f.state()).collections.issues.length, 1); assert.equal((await f.state()).collections.issues[0].railSafetyRisk, undefined);
    await f.login("owner"); await f.ok("railSafety.save", { name: "改为全局限界", definition: limit() }, "limit", 1);
    await f.ok("railSafety.save", { name: "机械改关联任务B", taskId: "B", definition: config() }, "config", 1);
    await f.login("only-a"); assert.equal((await f.state()).collections.issues.length, 0, "A issue must not expose current B-task model references");
    assert.equal((await f.request(`/__management/records/issues/risk?projectId=${projectId}`)).status, 403);
  } finally { await f.close(); }
});
