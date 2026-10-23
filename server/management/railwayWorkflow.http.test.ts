import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import type { ManagementCollection, ManagementCommandType } from "../../src/managementTypes.ts";

const projectId = "safety:project", password = "Rail-Workflow-Test-20261015!";
const point = (offset = 0) => ({ longitude: 121 + offset, latitude: 31, height: 5 });
const guard = () => ({ schemaVersion: 1, kind: "guard", station: point(), polygon: [{ longitude: 121, latitude: 31, height: 5 }, { longitude: 121.0001, latitude: 31, height: 5 }, { longitude: 121.0001, latitude: 31.0001, height: 5 }], resourceIds: [] });

async function fixture(videoFixture = false) {
  const root = mkdtempSync(join(tmpdir(), "rail-workflow-"));
  let store: ReturnType<typeof createManagementStore>, server: Server, base = "", cookie = "", sequence = 0;
  async function start() { store = createManagementStore({ dataDir: root, libraryDataDir: root, ...(videoFixture ? { resolveLibraryEvidence: async (_project: string, recordId: string, fileKey: string) => recordId === "source-video" && fileKey === "video" ? { name: "现场录像.mp4", url: "/__library/files/source-video/video/original.mp4", size: 100, requiredPermission: "media" as const } : undefined } : {}) }); server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); }))); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
  async function stop() { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  async function request(path: string, input?: unknown) {
    const response = await fetch(base + path, { method: input === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie }, body: input === undefined ? undefined : JSON.stringify(input) });
    const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data, text };
  }
  async function command(type: ManagementCommandType, payload: Record<string, unknown>, id?: string, revision?: number, options: { project?: string; key?: string } = {}) { return request("/__management/commands", { type, projectId: options.project || projectId, payload, id, expectedRevision: revision, idempotencyKey: options.key || `workflow-${++sequence}` }); }
  async function ok(type: ManagementCommandType, payload: Record<string, unknown>, id?: string, revision?: number, options: { project?: string; key?: string } = {}) { const result = await command(type, payload, id, revision, options); assert.equal(result.status, 200, `${type}: ${result.text}`); return result.data; }
  async function upload(name: string, mime: string, options: { taskId?: string; objectRefs?: unknown; workflowCategory?: string; project?: string } = {}) {
    const query = new URLSearchParams({ projectId: options.project || projectId, name });
    if (options.taskId) query.set("taskId", options.taskId); if (options.objectRefs !== undefined) query.set("objectRefs", JSON.stringify(options.objectRefs)); if (options.workflowCategory) query.set("workflowCategory", options.workflowCategory);
    const response = await fetch(base + "/__management/uploads?" + query, { method: "POST", headers: { "content-type": mime, "x-cesium-library": "1", cookie }, body: Buffer.from("isolated workflow fixture content") });
    return { status: response.status, data: await response.json() as any };
  }
  async function record(id: string, kind: ManagementCollection) { const response = await request(`/__management/records/${kind}/${id}?projectId=${projectId}`); assert.equal(response.status, 200, response.text); return response.data; }
  async function login(username: string) { const response = await request("/__management/session", { username, password, projectId }); assert.equal(response.status, 200, response.text); }
  await start(); await ok("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  return { root, command, ok, upload, record, request, login, async restart() { await stop(); await start(); }, async close() { await stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("object documents, uploads, checks and issues retain server snapshots and explicit work context", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "吊机03", kind: "equipment" }, "machine");
    await f.ok("task.create", { name: "当天吊装", resourceIds: ["machine"] }, "work");
    const ref = { kind: "resources", id: "machine" };
    const file = await f.upload("协议.pdf", "application/pdf", { taskId: "work", objectRefs: [ref, ref], workflowCategory: "agreement" });
    assert.equal(file.status, 201); assert.equal(file.data.objectRefs.length, 1);
    await f.ok("document.create", { name: "安全协议", category: "安全协议", workflowCategory: "agreement", taskIds: ["work"], objectRefs: [ref] }, "doc");
    await f.ok("document.version", { documentId: "doc", evidenceId: file.data.id, revisionNote: "原件上传" }, "version");
    await f.ok("check.create", { name: "吊机检查", taskId: "work", objectRef: ref, businessDate: "2026-10-15", purpose: "safety", items: [{ id: "one", name: "核查防护", result: "pass" }] }, "check");
    await f.ok("issue.create", { name: "防护待核实", kind: "safety", taskId: "work", objectRef: ref }, "issue");
    const before = await f.record("check", "checks");
    assert.equal(before.items[0].result, "pending"); assert.equal(before.status, "draft"); assert.equal((await f.record("issue", "issues")).status, "pending-verification");
    await f.ok("resource.update", { name: "吊机新名称", kind: "equipment", reason: "修改名称" }, "machine", 1);
    assert.equal((await f.record("check", "checks")).objectSnapshot.data.name, "吊机03");
    assert.equal((await f.record("version", "documentVersions")).objectSnapshots[0].data.name, "吊机03");
    assert.equal((await f.record("version", "documentVersions")).status, "draft");
    assert.equal((await f.command("check.create", { name: "缺作业", objectRef: ref, businessDate: "2026-10-15", items: [{ name: "项点" }] }, "bad")).data.code, "OBJECT_TASK_REQUIRED");
    assert.equal((await f.command("issue.create", { name: "伪造快照", kind: "safety", taskId: "work", objectRef: { ...ref, data: { name: "伪造" } } }, "forged")).data.code, "INVALID_OBJECT_REF");
    await f.restart(); assert.deepEqual(await f.record("check", "checks"), before);
  } finally { await f.close(); }
});

test("cross-task, foreign-project and missing object references cannot expand document or upload access", async () => {
  const f = await fixture(); try {
    await f.ok("task.create", { name: "A" }, "A"); await f.ok("task.create", { name: "B" }, "B");
    await f.ok("railSafety.save", { name: "A防护员", taskId: "A", definition: guard() }, "guard-A", 0);
    await f.ok("railSafety.save", { name: "B防护员", taskId: "B", definition: guard() }, "guard-B", 0);
    await f.ok("member.save", { username: "scoped", displayName: "Scoped", password, roles: ["resource", "document", "quality"], taskIds: ["A"] });
    await f.login("scoped");
    const foreign = { kind: "railSafety", id: "guard-B" };
    assert.equal((await f.command("document.create", { name: "跨范围", category: "方案", taskIds: ["A"], objectRefs: [foreign] }, "deny")).status, 403);
    assert.equal((await f.upload("记录.pdf", "application/pdf", { taskId: "A", objectRefs: [foreign] })).status, 403);
    assert.equal((await f.command("issue.create", { name: "跨范围", kind: "safety", taskId: "A", objectRef: foreign }, "deny-issue")).status, 403);
    await f.login("owner");
    assert.equal((await f.command("check.create", { name: "错作业", taskId: "A", objectRef: foreign, businessDate: "2026-10-15", items: [{ name: "检查" }] }, "wrong")).data.code, "OBJECT_TASK_MISMATCH");
    await f.ok("project.create", { id: "foreign", name: "其他项目" }); await f.ok("railSafety.save", { name: "另一项目防护员", definition: guard() }, "foreign-guard", 0, { project: "foreign" });
    assert.equal((await f.command("document.create", { name: "跨项目", category: "资料", objectRefs: [{ kind: "railSafety", id: "foreign-guard" }] }, "foreign-doc")).status, 404);
    await f.ok("railSafety.remove", {}, "guard-A", 1);
    assert.equal((await f.command("document.create", { name: "已删除", category: "资料", objectRefs: [{ kind: "railSafety", id: "guard-A" }] }, "deleted-doc")).data.code, "OBJECT_UNAVAILABLE");
  } finally { await f.close(); }
});

test("Excel import is idempotent, duplicate-aware, source-frozen and always an unverified draft", async () => {
  const f = await fixture(); try {
    const source = await f.upload("日计划.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { workflowCategory: "construction-plan" }); assert.equal(source.status, 201);
    const railwayPlan = { kind: "construction", number: "计划-001", sourceEvidenceId: source.data.id, sheetName: "日计划", rowNumber: 2, verificationStatus: "pending", resourceText: "未知吊机", unmatchedResources: ["未知吊机"] };
    const payload = { name: "计划作业", planStart: "2026-10-15", planEnd: "2026-10-15", railwayPlan, status: "published" };
    await f.ok("task.create", payload, "plan", 0, { key: "once" }); await f.ok("task.create", payload, "plan", 0, { key: "once" });
    const saved = await f.record("plan", "tasks");
    assert.equal(saved.revision, 1); assert.equal(saved.status, "draft"); assert.equal(saved.railwayPlan.verificationStatus, "pending"); assert.equal(saved.railwayPlan.sourceSnapshot.sha256, source.data.sha256); assert.equal(saved.conditionPolicy, undefined); assert.deepEqual(saved.railwayPlan.unmatchedResources, ["未知吊机"]);
    assert.equal((await f.command("task.create", payload, "duplicate", 0)).data.code, "RAILWAY_PLAN_DUPLICATE");
    await f.ok("task.create", { ...payload, railwayPlan: { ...railwayPlan, kind: "supervision" } }, "supervision", 0);
    await f.ok("task.create", { ...payload, planStart: "2026-10-16", planEnd: "2026-10-16" }, "next-day", 0);
    assert.equal((await f.command("task.create", { ...payload, railwayPlan: { ...railwayPlan, verificationStatus: "verified" } }, "forged", 0)).data.code, "RAILWAY_PLAN_INVALID");
    const wrong = await f.upload("协议.pdf", "application/pdf");
    assert.equal((await f.command("task.create", { ...payload, railwayPlan: { ...railwayPlan, sourceEvidenceId: wrong.data.id } }, "wrong-file", 0)).data.code, "WORKFLOW_FILE_TYPE");
    assert.equal((await f.command("task.update", { railwayPlan: { ...railwayPlan, number: "覆盖来源" } }, "plan", 1)).data.code, "RAILWAY_PLAN_IMMUTABLE");
    await f.restart(); assert.deepEqual(await f.record("plan", "tasks"), saved);
  } finally { await f.close(); }
});

test("personnel certificates use real authorized evidence, preserve geometry and never assert attendance", async () => {
  const f = await fixture(); try {
    await f.ok("task.create", { name: "A" }, "A"); await f.ok("task.create", { name: "B" }, "B");
    await f.ok("railSafety.save", { name: "防护岗", taskId: "A", definition: guard() }, "guard", 0);
    const cert = await f.upload("培训证书.pdf", "application/pdf", { taskId: "A", workflowCategory: "personnel-certificate" }); assert.equal(cert.status, 201);
    const personnel = { name: "测试人员", unit: "测试单位", phone: "123456", role: "现场防护员", certificateNumber: "TEST-001", trainingDate: "2026-01-01", validUntil: "2027-01-01", certificateEvidenceIds: [cert.data.id] };
    await f.ok("railSafety.personnel", { personnel }, "guard", 1, { key: "person-once" }); await f.ok("railSafety.personnel", { personnel }, "guard", 1, { key: "person-once" });
    const saved = await f.record("guard", "railSafety"); assert.equal(saved.revision, 2); assert.equal(saved.name, personnel.name); assert.equal(saved.personnel.verificationStatus, "pending"); assert.equal(saved.personnel.attendance, undefined); assert.deepEqual(saved.definition, guard());
    await f.ok("railSafety.save", { name: "防护岗标记", taskId: "A", definition: { ...guard(), station: point(0.00001) } }, "guard", 2);
    assert.deepEqual((await f.record("guard", "railSafety")).personnel, saved.personnel);
    assert.equal((await f.command("railSafety.personnel", { personnel: { ...personnel, attendance: "present" } }, "guard", 3)).data.code, "PERSONNEL_INVALID");
    assert.equal((await f.command("railSafety.personnel", { personnel }, "guard", 1)).data.code, "REVISION_CONFLICT");
    const certB = await f.upload("B证书.pdf", "application/pdf", { taskId: "B" });
    await f.ok("member.save", { username: "scoped", displayName: "Scoped", password, roles: ["resource"], taskIds: ["A"] }); await f.login("scoped");
    assert.equal((await f.command("railSafety.personnel", { personnel: { ...personnel, certificateEvidenceIds: [certB.data.id] } }, "guard", 3)).status, 403);
    await f.login("owner");
    await f.ok("project.create", { id: "foreign", name: "其他项目" }); const other = await f.upload("外部证书.pdf", "application/pdf", { project: "foreign" });
    assert.equal((await f.command("railSafety.personnel", { personnel: { ...personnel, certificateEvidenceIds: [other.data.id] } }, "guard", 3)).status, 404);
    const missing = await f.upload("缺失证书.pdf", "application/pdf"); unlinkSync(join(f.root, "management-files", missing.data.storageName));
    assert.equal((await f.command("railSafety.personnel", { personnel: { ...personnel, certificateEvidenceIds: [missing.data.id] } }, "guard", 3)).data.code, "EVIDENCE_MISSING");
    assert.equal((await f.record("guard", "railSafety")).revision, 3);
  } finally { await f.close(); }
});

test("railway upload categories enforce user file types without restricting existing image evidence", async () => {
  const f = await fixture(); try {
    for (const [name, mime, category] of [["协议.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "agreement"], ["计划.pdf", "application/pdf", "supervision-plan"], ["照片.png", "image/png", "other"], ["证书.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "personnel-certificate"], ["伪装.pdf", "text/html", "agreement"]]) assert.equal((await f.upload(name, mime, { workflowCategory: category })).status, 400);
    assert.equal((await f.upload("现场照片.png", "image/png")).status, 201);
    assert.equal((await f.upload("交底.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", { workflowCategory: "other" })).status, 201);
    const word = await f.upload("说明.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await f.ok("document.create", { name: "安全协议", category: "协议", workflowCategory: "agreement" }, "agreement");
    assert.equal((await f.command("document.version", { documentId: "agreement", evidenceId: word.data.id, revisionNote: "错格式" }, "bad-version")).data.code, "WORKFLOW_FILE_TYPE");
  } finally { await f.close(); }
});

test("video evidence inherits the uploaded object association while retaining original media identity", async () => {
  const f = await fixture(true); try {
    await f.ok("resource.create", { name: "视频中的吊机", kind: "equipment" }, "machine");
    await f.ok("task.create", { name: "视频巡检", resourceIds: ["machine"] }, "work");
    const objectRefs = [{ kind: "resources", id: "machine" }];
    const image = await f.upload("现场取证.png", "image/png", { taskId: "work", objectRefs }); assert.equal(image.status, 201);
    await f.ok("evidence.register", { sourceRecordId: "source-video", fileKey: "video", fileId: image.data.id, mediaSeconds: 12.5, taskId: "work" }, "capture");
    const capture = await f.record("capture", "evidence");
    assert.deepEqual(capture.objectRefs, objectRefs); assert.equal(capture.objectSnapshots[0].data.name, "视频中的吊机"); assert.equal(capture.taskId, "work"); assert.equal(capture.mediaSeconds, 12.5); assert.equal(capture.sourceRecordId, "source-video"); assert.equal(capture.sha256, image.data.sha256);
    await f.ok("resource.update", { name: "修改后名称", kind: "equipment", reason: "修改资源台账" }, "machine", 1);
    assert.equal((await f.record("capture", "evidence")).objectSnapshots[0].data.name, "视频中的吊机");
  } finally { await f.close(); }
});

test("personnel receipt replay obeys live file and model capabilities before returning conflict details", async () => {
  const f = await fixture(); try {
    await f.ok("railSafety.save", { name: "防护岗", definition: guard() }, "guard", 0);
    const state = await f.ok("member.save", { username: "writer", displayName: "人员维护", password, roles: ["resource"] });
    const member = state.members.find((item: any) => item.username === "writer");
    await f.login("writer");
    const payload = { personnel: { name: "测试人员", certificateEvidenceIds: [] } };
    await f.ok("railSafety.personnel", payload, "guard", 1, { key: "writer-save" });
    await f.login("owner"); await f.ok("member.save", { username: "writer", displayName: "人员维护", roles: ["resource"], resourceAccess: { files: false } }, undefined, member.revision);
    await f.login("writer");
    const replay = await f.command("railSafety.personnel", payload, "guard", 1, { key: "writer-save" }); assert.equal(replay.status, 403); assert.equal(replay.data.current, undefined);
    const conflict = await f.command("railSafety.personnel", payload, "guard", 999); assert.equal(conflict.status, 403); assert.equal(conflict.data.current, undefined);
  } finally { await f.close(); }
});

test("existing document links accept field objects, freeze sources and preserve task and file authorization", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "原吊机", kind: "equipment" }, "machine");
    await f.ok("resource.create", { name: "第二台吊机", kind: "equipment" }, "machine-2");
    await f.ok("task.create", { name: "A作业", resourceIds: ["machine", "machine-2"] }, "A"); await f.ok("task.create", { name: "B作业" }, "B");
    await f.ok("railSafety.save", { name: "A防护员", taskId: "A", definition: guard() }, "guard-A", 0);
    await f.ok("railSafety.save", { name: "B防护员", taskId: "B", definition: guard() }, "guard-B", 0);
    const file = await f.upload("既有方案.pdf", "application/pdf", { taskId: "A", workflowCategory: "other" });
    await f.ok("document.create", { name: "既有方案", category: "施工方案", taskIds: ["A"], workflowCategory: "other" }, "doc");
    await f.ok("document.version", { documentId: "doc", evidenceId: file.data.id, revisionNote: "上传既有资料" }, "version");
    const payload = { sourceKind: "resources", sourceId: "machine", targetKind: "documents", targetId: "doc", taskId: "A" };
    await f.ok("link.create", payload, "link", 0, { key: "link-once" }); await f.ok("link.create", payload, "link", 0, { key: "link-once" });
    const saved = await f.record("link", "links"); assert.equal(saved.revision, 1); assert.equal(saved.objectSnapshot.data.name, "原吊机"); assert.equal(saved.targetSnapshot.data.name, "既有方案"); assert.deepEqual(saved.objectRef, { kind: "resources", id: "machine" });
    assert.equal((await f.command("link.create", payload, "duplicate", 0)).data.code, "DUPLICATE_LINK");
    await f.ok("link.create", { ...payload, sourceId: "machine-2" }, "second", 0);
    await f.ok("link.create", { ...payload, sourceKind: "railSafety", sourceId: "guard-A" }, "guard-link", 0);
    await f.ok("resource.update", { name: "更新后的吊机", kind: "equipment", reason: "台账变更" }, "machine", 1);
    assert.equal((await f.record("link", "links")).objectSnapshot.data.name, "原吊机");
    assert.equal((await f.command("link.create", { ...payload, sourceKind: "tasks", sourceId: "A" }, "bad-kind", 0)).data.code, "INVALID_OBJECT_REF");
    assert.equal((await f.command("link.create", { ...payload, sourceKind: "railSafety", sourceId: "guard-B" }, "wrong-task", 0)).data.code, "OBJECT_TASK_MISMATCH");
    await f.ok("document.create", { name: "B方案", category: "施工方案", taskIds: ["B"] }, "doc-B");
    await f.ok("member.save", { username: "scoped", displayName: "A资料员", password, roles: ["document"], taskIds: ["A"] });
    const noFilesState = await f.ok("member.save", { username: "no-files", displayName: "无原件权限", password, roles: ["document"], resourceAccess: { files: false } });
    assert.ok(noFilesState.members.some((member: any) => member.username === "no-files"));
    await f.login("scoped");
    assert.equal((await f.command("link.create", { ...payload, sourceKind: "railSafety", sourceId: "guard-B" }, "foreign-source", 0)).status, 403);
    assert.equal((await f.command("link.create", { ...payload, targetId: "doc-B" }, "foreign-doc", 0)).status, 403);
    await f.login("no-files"); assert.equal((await f.command("link.create", payload, "no-files-link", 0)).status, 403);
    await f.login("owner"); await f.restart(); assert.deepEqual(await f.record("link", "links"), saved);
    assert.equal((await f.record("version", "documentVersions")).status, "draft", "linking never publishes or approves a document");
  } finally { await f.close(); }
});

test("a planner may upload Excel plan sources without gaining other upload permissions", async () => {
  const f = await fixture(); try {
    const state = await f.ok("member.save", { username: "planner", displayName: "计划工程", password, roles: ["planner"] });
    const member = state.members.find((item: any) => item.username === "planner");
    await f.login("planner");
    const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const construction = await f.upload("施工计划.xlsx", mime, { workflowCategory: "construction-plan" }); assert.equal(construction.status, 201);
    assert.equal((await f.upload("安全监督计划.xlsx", mime, { workflowCategory: "supervision-plan" })).status, 201);
    await f.ok("task.create", { name: "计划员导入的待核验作业", planStart: "2026-10-15", planEnd: "2026-10-15", railwayPlan: { kind: "construction", number: "PLAN-PLANNER-1", sourceEvidenceId: construction.data.id, sheetName: "日计划", rowNumber: 2, verificationStatus: "pending" } }, "planner-task", 0);
    assert.equal((await f.record("planner-task", "tasks")).status, "draft");
    for (const [name, type, category] of [["普通表格.xlsx", mime, undefined], ["协议.pdf", "application/pdf", "agreement"], ["其他资料.pdf", "application/pdf", "other"], ["证书.pdf", "application/pdf", "personnel-certificate"], ["现场.png", "image/png", undefined]] as const) assert.equal((await f.upload(name, type, { workflowCategory: category })).status, 403);
    assert.equal((await f.upload("伪装计划.pdf", "application/pdf", { workflowCategory: "construction-plan" })).status, 400);
    await f.login("owner"); await f.ok("member.save", { username: "planner", displayName: "计划工程", roles: ["planner"], resourceAccess: { files: false } }, undefined, member.revision);
    await f.login("planner"); assert.equal((await f.upload("施工计划.xlsx", mime, { workflowCategory: "construction-plan" })).status, 403);
  } finally { await f.close(); }
});
