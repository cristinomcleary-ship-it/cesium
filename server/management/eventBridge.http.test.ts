import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createManagementStore } from "../managementStore.ts";
import { createSafetyEventStore } from "../safetyEventStore.ts";
import { spatialV3Fixture } from "../../src/safetySpatial.testFixtures.ts";
import type { ManagementRecord } from "../../src/managementTypes.ts";
import type { SafetyEventRecord } from "../../src/safetyEventTypes.ts";

const projectId = "safety:project";
function manual(id: string, more: Partial<SafetyEventRecord> = {}): SafetyEventRecord {
  const at = new Date().toISOString();
  return { id, projectId, title: "隔离HTTP事件 " + id, severity: "medium", status: "pending", occurredAt: Date.now(), mediaIds: [], source: { kind: "manual-record" }, createdAt: at, updatedAt: at, ...more };
}
async function fixture() {
  const parent = resolve("tmp/reliability-a4-http"); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(join(parent, "case-"));
  const risk = { ...spatialV3Fixture("risk-point", "risk-verified"), revision: 3 };
  const legacy = createSafetyEventStore({ dataDir: dir });
  await legacy.mutate({ operation: "create", event: manual("historical-event"), expectedRevision: 0, mutationId: "seed-legacy" });
  await legacy.mutate({ operation: "complete", id: "historical-event", expectedRevision: 1, mutationId: "seed-result", result: { description: "历史直接处理结果（未声明管理复核）", attachmentIds: ["historical-unverified-attachment"] } });
  const original = await readFile(legacy.path, "utf8");
  let store = createManagementStore({ dataDir: dir, libraryDataDir: dir, spatialDataDir: dir, resolveSpatialReference: async (_project, key) => key === risk.id ? risk : undefined });
  const calls: { method: string; path: string; status: number; code?: string }[] = [];
  const server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => void legacy.middleware(req, res, () => { res.statusCode = 404; res.end(); }))));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function call(path: string, value?: unknown, cookie = "") {
    const method = value === undefined ? "GET" : "POST";
    const res = await fetch(base + path, { method, headers: { "x-cesium-library": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await res.json(); calls.push({ method, path, status: res.status, ...(body.code ? { code: body.code } : {}) });
    return { status: res.status, body, cookie: res.headers.get("set-cookie")?.split(";")[0] || "" };
  }
  const command = (type: string, payload: unknown, id?: string, expectedRevision?: number, cookie = "", key = randomUUID()) => call("/__management/commands", { projectId, type, id, expectedRevision, idempotencyKey: key, payload }, cookie);
  async function upload(taskId: string, cookie = "") {
    const path = `/__management/upload?projectId=${projectId}&taskId=${taskId}&name=real-upload.txt`;
    const res = await fetch(base + path, { method: "POST", headers: { "x-cesium-library": "1", "content-type": "text/plain", ...(cookie ? { cookie } : {}) }, body: Buffer.from("Actual isolated evidence bytes. Not a project photograph.") });
    const body = await res.json(); calls.push({ method: "POST", path, status: res.status, code: body.code }); assert.equal(res.status, 201, JSON.stringify(body)); return body as ManagementRecord;
  }
  return { dir, risk, original, legacy, calls, call, command, upload, reopen() { store.close(); store = createManagementStore({ dataDir: dir, libraryDataDir: dir, spatialDataDir: dir, resolveSpatialReference: async (_project, key) => key === risk.id ? risk : undefined }); },
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close(); } };
}

test("A4 actual HTTP: map and management share one issue, reviewed lifecycle, verified evidence, durable retries and preserved legacy", async () => {
  const f = await fixture(); const checks: string[] = [];
  try {
    const bootstrap = await f.command("member.save", { username: "a4owner", displayName: "A4Owner", password: "A4-Owner-Secret-Only-Test", roles: ["owner"] });
    assert.equal(bootstrap.status, 200); const owner = bootstrap.cookie;
    for (const id of ["task-a", "task-b"]) assert.equal((await f.command("task.create", { name: id }, id, undefined, owner)).status, 200);
    const worker = await f.command("member.save", { username: "a4worker", displayName: "A4Worker", password: "A4-Worker-Secret-Test", roles: ["worker"], taskIds: ["task-a"] }, undefined, undefined, owner);
    assert.equal(worker.status, 200); const workerId = worker.body.members.find((m: { username: string }) => m.username === "a4worker").id;
    const workerCookie = (await f.call("/__management/session", { username: "a4worker", password: "A4-Worker-Secret-Test" })).cookie;
    const fileA = await f.upload("task-a", workerCookie), fileB = await f.upload("task-b", owner);
    const create = { operation: "create", expectedRevision: 0, mutationId: "map-create-one", event: manual("map-one", { taskId: "task-a", spatialObjectId: f.risk.id, evidenceIds: [fileA.id] }) };
    assert.equal((await f.call("/__safety/events", create, workerCookie)).status, 403, "task scope does not grant full-model source geometry");
    const created = await f.call("/__safety/events", create, owner); assert.equal(created.status, 200, JSON.stringify(created.body));
    const state = (await f.call("/__management/state", undefined, owner)).body;
    assert.equal(state.collections.issues.filter((r: ManagementRecord) => r.id === "map-one").length, 1);
    let issue = state.collections.issues.find((r: ManagementRecord) => r.id === "map-one");
    assert.deepEqual(issue.discovery.position, f.risk.geometry.type === "Point" ? f.risk.geometry.position : null);
    assert.equal(issue.discovery.spatialRevision, 3); assert.equal(issue.discovery.spatialReference.revision, 3);
    assert.equal(created.body.events.find((r: SafetyEventRecord) => r.id === "map-one").issueStatus, issue.status);
    assert.equal((await f.call("/__safety/events", undefined, workerCookie)).body.events.some((r: SafetyEventRecord) => r.id === "historical-event"), false);
    checks.push("Map creates exactly one authoritative SQLite issue; position/revision is server-read; scoped user cannot see unmapped history");
    assert.equal((await f.call("/__safety/events", { operation: "complete", mutationId: "old-complete", expectedRevision: 0, id: "map-one", result: { description: "bypass", attachmentIds: [fileA.id] } }, workerCookie)).body.code, "MANAGEMENT_REVIEW_REQUIRED");
    const transition = async (operation: string, payload: unknown, cookie: string) => {
      const result = await f.call("/__safety/events", { operation, id: "map-one", expectedIssueRevision: issue.revision, mutationId: randomUUID(), payload }, cookie);
      if (result.status === 200) {
        const snapshot = (await f.call("/__management/state", undefined, owner)).body;
        issue = snapshot.collections.issues.find((r: ManagementRecord) => r.id === "map-one");
        assert.equal(result.body.events.find((r: SafetyEventRecord) => r.id === "map-one").issueStatus, issue.status);
      }
      return result;
    };
    assert.equal((await transition("assign", { ownerId: workerId, dueDate: "2026-10-12" }, owner)).status, 200);
    assert.equal((await transition("submit", { description: "不存在附件", evidenceIds: ["missing-evidence"] }, workerCookie)).status, 404);
    assert.equal((await transition("submit", { description: "越权附件", evidenceIds: [fileB.id] }, workerCookie)).status, 403);
    assert.equal(issue.status, "pending-rectification");
    assert.equal((await transition("submit", { description: "第一轮整改", evidenceIds: [fileA.id] }, workerCookie)).status, 200);
    assert.equal(issue.status, "pending-review");
    assert.equal((await transition("review", { passed: true, reason: "执行人试图自复核" }, workerCookie)).status, 403);
    assert.equal((await transition("review", { passed: false, reason: "仍需整改" }, owner)).status, 200);
    assert.equal(issue.status, "rectifying");
    assert.equal((await transition("submit", { description: "第二轮整改", evidenceIds: [fileA.id] }, workerCookie)).status, 200);
    assert.equal((await transition("review", { passed: true, reason: "核对通过", evidenceIds: [fileA.id] }, owner)).status, 200);
    assert.equal(issue.status, "closed"); assert.equal(issue.rounds.length, 2);
    assert.equal(issue.rounds[0].passed, false); assert.equal(issue.rounds[1].passed, true);
    checks.push("Only authorized review closes; reject/resubmit/pass transitions match both HTTP read models; invalid or unauthorized evidence rejected");
    f.reopen();
    assert.equal((await f.call("/__safety/events", create, owner)).status, 200);
    assert.equal((await f.call("/__management/state", undefined, owner)).body.collections.issues.length, 1);
    assert.equal((await f.call("/__safety/events", { ...create, event: { ...create.event, title: "different" } }, owner)).body.code, "IDEMPOTENCY_CONFLICT");
    checks.push("Lost acknowledgement retry after reopen creates no duplicate and changed retry is rejected");
    const history = (await f.call("/__safety/events", undefined, owner)).body.events.find((r: SafetyEventRecord) => r.id === "historical-event");
    assert.equal(history.lifecycle, "legacy-readonly"); assert.equal(history.status, "completed");
    const adopt = { operation: "adopt-legacy", id: "historical-event", mutationId: "adopt-one", payload: { taskId: "task-a" } };
    assert.equal((await f.call("/__safety/events", adopt, workerCookie)).status, 403);
    const adopted = await f.call("/__safety/events", adopt, owner); assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    const newState = (await f.call("/__management/state", undefined, owner)).body;
    const historicalIssue = newState.collections.issues.find((r: ManagementRecord) => r.id === "historical-event");
    assert.equal(historicalIssue.status, "pending-verification"); assert.deepEqual(historicalIssue.rounds, []);
    assert.equal(historicalIssue.discovery.legacySnapshot.status, "completed");
    assert.deepEqual(historicalIssue.discovery.legacySnapshot.handling.attachmentIds, ["historical-unverified-attachment"]);
    assert.equal(adopted.body.events.filter((r: SafetyEventRecord) => r.id === "historical-event").length, 1);
    assert.equal(await readFile(f.legacy.path, "utf8"), f.original);
    checks.push("Explicit legacy adoption preserves ID and full historical state without fabricated reviews; original JSON byte-identical");
    assert.equal((await f.call("/__safety/events", { operation: "create", mutationId: "missing-surface", event: manual("bad-model", { spatialObjectId: "unknown-risk", taskId: "task-a" }) }, workerCookie)).status, 400);
    const denied = await f.command("issue.create", { name: "无核验客户端坐标", kind: "safety", taskId: "task-a", discovery: { kind: "manual", position: { longitude: 1, latitude: 1, height: 1 } } }, "fake-position", undefined, workerCookie);
    assert.equal(denied.body.code, "UNVERIFIED_POSITION"); checks.push("Unknown model source and client-invented coordinates cannot become verified discovery positions");
    await mkdir("output/reliability-a", { recursive: true });
    await writeFile("output/reliability-a/a4-after.json", JSON.stringify({ passed: true, capturedAt: new Date().toISOString(), isolationDirectory: f.dir, evidenceKind: "actual HTTP with isolated business fixtures, no claim of real scene accuracy", checks, requestCount: f.calls.length, calls: f.calls, legacyBytesUnchanged: true }, null, 2));
  } finally { await f.close(); }
});

test("A4 actual HTTP: saved video/check discovery binds source identity/time/revision and rejects mismatched or missing evidence", async () => {
  const f = await fixture(); const checks: string[] = [];
  try {
    for (const id of ["task-a", "task-b"]) assert.equal((await f.command("task.create", { name: id }, id)).status, 200);
    const videoDir = join(f.dir, "records", "isolated-video", "video"); await mkdir(videoDir, { recursive: true });
    const videoBytes = Buffer.from("ISOLATED STORED SOURCE FIXTURE; NOT REAL VIDEO PRECISION EVIDENCE");
    await writeFile(join(videoDir, "source.mp4"), videoBytes);
    await writeFile(join(f.dir, "records", "isolated-video", "record.json"), JSON.stringify({ version: 1, id: "isolated-video", kind: "Drone Video", files: { video: { name: "source.mp4", url: "/__library/files/isolated-video/video/source.mp4" } } }));
    const register = await f.command("evidence.register", { recordId: "isolated-video", fileKey: "video", mediaSeconds: 12.5, taskId: "task-a" }, "video-evidence");
    assert.equal(register.status, 200, JSON.stringify(register.body));
    const create = await f.command("issue.create", { name: "录像发现", kind: "safety", taskId: "task-a", discovery: { kind: "video", mediaEvidenceId: "video-evidence", mediaSeconds: 12.5 } }, "video-issue");
    assert.equal(create.status, 200, JSON.stringify(create.body));
    const issue = create.body.collections.issues.find((r: ManagementRecord) => r.id === "video-issue");
    assert.equal(issue.discovery.mediaId, "video:isolated-video"); assert.equal(issue.discovery.mediaSeconds, 12.5); assert.equal(issue.discovery.evidenceRevision, 1);
    const map = (await f.call("/__safety/events")).body.events.find((r: SafetyEventRecord) => r.id === "video-issue");
    assert.deepEqual(map.mediaIds, ["video:isolated-video"]); assert.equal(map.mediaSeconds, 12.5);
    assert.equal((await f.command("issue.create", { name: "伪造媒体时间", kind: "safety", taskId: "task-a", discovery: { kind: "video", mediaEvidenceId: "video-evidence", mediaSeconds: 99 } }, "wrong-time")).body.code, "MEDIA_TIME_MISMATCH");
    assert.equal((await f.command("issue.create", { name: "错配任务", kind: "safety", taskId: "task-b", discovery: { kind: "video", mediaEvidenceId: "video-evidence" } }, "wrong-task")).body.code, "DISCOVERY_TASK_MISMATCH");
    assert.equal((await f.command("issue.create", { name: "虚构证据", kind: "safety", taskId: "task-a", discovery: { kind: "video", mediaEvidenceId: "not-stored" } }, "wrong-source")).status, 404);
    checks.push("Video discovery uses authorized persisted source identity, time and revision; projected map media matches; invented time/source and mismatched task rejected");
    const check = await f.command("check.create", { name: "现场检查", taskId: "task-a", purpose: "safety", businessDate: "2026-10-09", items: [{ id: "critical", name: "关键项目", required: true }] }, "source-check");
    assert.equal(check.status, 200, JSON.stringify(check.body));
    const fromCheck = await f.command("issue.create", { name: "检查发现", kind: "safety", taskId: "task-a", checkId: "source-check" }, "check-issue");
    assert.equal(fromCheck.status, 200, JSON.stringify(fromCheck.body));
    const checkIssue = fromCheck.body.collections.issues.find((r: ManagementRecord) => r.id === "check-issue");
    assert.equal(checkIssue.discovery.checkRevision, 1); assert.equal(checkIssue.discovery.checkSnapshot.items[0].id, "critical");
    assert.equal((await f.command("issue.create", { name: "错配检查", kind: "quality", taskId: "task-b", discovery: { kind: "check", checkId: "source-check" } }, "wrong-check")).body.code, "DISCOVERY_TASK_MISMATCH");
    checks.push("Check discovery preserves immutable checklist revision/source snapshot and rejects unrelated task");
    const file = await f.upload("task-a");
    await unlink(join(f.dir, "management-files", String(file.storageName)));
    assert.equal((await f.command("issue.create", { name: "文件已丢失", kind: "safety", taskId: "task-a", evidenceIds: [file.id] }, "missing-upload")).body.code, "EVIDENCE_MISSING");
    await unlink(join(videoDir, "source.mp4"));
    const missingSource = await f.command("issue.create", { name: "原片已丢失", kind: "safety", taskId: "task-a", discovery: { kind: "video", mediaEvidenceId: "video-evidence" } }, "missing-video");
    assert.equal(missingSource.body.code, "EVIDENCE_MISSING", JSON.stringify(missingSource.body));
    checks.push("Missing uploaded bytes and deleted imported source are rejected at mutation time after earlier registration");
    await mkdir("output/reliability-a", { recursive: true }); await writeFile("output/reliability-a/a4-discovery-after.json", JSON.stringify({ passed: true, capturedAt: new Date().toISOString(), isolationDirectory: f.dir, evidenceKind: "actual HTTP storage fixtures only; not real video decode/registration proof", checks, requestCount: f.calls.length, calls: f.calls }, null, 2));
  } finally { await f.close(); }
});
