import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore, ManagementError } from "../managementStore.ts";
import { applyDomain, rolePermissions, type DomainContext } from "./domain.ts";
import type { ManagementCommand, ManagementRecord, TaskConditionRule } from "../../src/managementTypes.ts";

const projectId = "safety:project";
const rules = (overrides: Record<string, Partial<TaskConditionRule>> = {}): TaskConditionRule[] =>
  ["predecessors", "preconstruction-checks", "resources", "documents", "external-permit", "acceptance", "blocking-issues", "quantity"].map(kind => ({
    id: kind, kind: kind as TaskConditionRule["kind"], stage: ["acceptance", "blocking-issues", "quantity"].includes(kind) ? "completion" : "start",
    mode: "not-applicable", referenceIds: [], note: "仅隔离测试明确不适用", ...overrides[kind],
  }));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cesium-railway-task-"));
  let now = "2026-10-14T12:00:00.000Z", sequence = 0;
  let store = createManagementStore({ dataDir: dir, libraryDataDir: dir, now: () => now });
  const snapshot = () => store.load(projectId, store.localActor());
  const record = (id: string, kind = "tasks") => (snapshot().collections as Record<string, ManagementRecord[]>)[kind].find(item => item.id === id)!;
  const command = (type: ManagementCommand["type"], id: string, payload: Record<string, unknown> = {}, revision?: number, key?: string) =>
    store.command({ projectId, type, id, payload, expectedRevision: revision, idempotencyKey: key || `railway-${++sequence}` }, store.localActor());
  const change = (type: ManagementCommand["type"], id: string, payload: Record<string, unknown> = {}, kind = "tasks") => command(type, id, payload, record(id, kind).revision);
  async function published(id: string, fields: Record<string, unknown> = {}, overrides: Record<string, Partial<TaskConditionRule>> = {}) {
    await command("task.create", id, { name: id, ownerId: "local-owner", planStart: "2026-10-14", planEnd: "2026-10-15", ...fields });
    await change("task.conditions.configure", id, { taskType: "non-quantity", rules: rules(overrides), reason: "隔离测试配置" });
    await change("task.publish", id);
  }
  return { dir, get store() { return store; }, snapshot, record, command, change, published,
    setTime: (value: string) => { now = value; },
    reopen: () => { store.close(); store = createManagementStore({ dataDir: dir, libraryDataDir: dir, now: () => now }); },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const rejects = (operation: Promise<unknown>, code: string) => assert.rejects(operation, error => error instanceof ManagementError && error.code === code);

test("railway fields persist local cross-midnight minutes and never supply missing admission rules", async () => {
  const f = fixture();
  try {
    const fields = { railwayLine: " 测试铁路 ", railwaySection: "甲站—乙站", railwayMileage: "K12+300～K12+400", railwayTrack: "上行", railwayWorkType: "邻线吊装", workWindowStart: "2026-10-14T23:30", workWindowEnd: "2026-10-15T01:20", permitReference: "人工登记编号", batchLabel: "夜间第一批" };
    await f.command("task.create", "night", { name: "跨日吊装", ownerId: "local-owner", planStart: "2026-10-14", planEnd: "2026-10-15", ...fields });
    let task = f.record("night");
    assert.equal(task.railwayLine, "测试铁路");
    assert.equal(task.workWindowStart, fields.workWindowStart);
    assert.equal(task.workWindowEnd, fields.workWindowEnd);
    assert.equal(task.conditionPolicy, undefined);
    await f.change("task.publish", "night");
    await rejects(f.change("task.start", "night"), "TASK_CONDITIONS_BLOCKED");
    f.reopen(); task = f.record("night");
    assert.equal(task.workWindowStart, fields.workWindowStart);
    assert.equal(task.permitReference, "人工登记编号");
    const before = f.snapshot();
    for (const payload of [
      { workWindowStart: "2026-10-15T01:30" },
      { workWindowEnd: "2026-10-14T23:30" },
      { workWindowEnd: "2026-02-30T01:20" },
      { workWindowEnd: "2026-10-15T24:00" },
      { workWindowEnd: "2026-10-15T01:20:30" },
      { workWindowEnd: "2026-10-15T01:20+08:00" },
      { workWindowEnd: "" },
      { railwayLine: 123 },
      { batchLabel: "x".repeat(201) },
    ]) {
      await assert.rejects(f.change("task.update", "night", { reason: "无效变更", ...payload }));
      assert.deepEqual(f.snapshot(), before, "invalid updates cannot write a revision, audit or receipt");
    }
    await f.change("task.update", "night", { reason: "撤回时段记录", workWindowStart: "", workWindowEnd: " ", permitReference: "" });
    task = f.record("night");
    assert.equal(task.workWindowStart, undefined); assert.equal(task.workWindowEnd, undefined); assert.equal(task.permitReference, undefined);
    await rejects(f.command("task.create", "half", { name: "不完整时段", workWindowStart: "2026-10-14T23:30" }), "WORK_WINDOW_INCOMPLETE");
  } finally { f.close(); }
});

test("legacy tasks retain their data and rules; pause/resume is revisioned, idempotent and durable", async () => {
  const f = fixture();
  try {
    await f.published("legacy");
    assert.equal(f.record("legacy").railwayLine, undefined);
    await f.change("task.start", "legacy");
    const running = structuredClone(f.record("legacy"));
    await rejects(f.change("task.pause", "legacy", { reason: " " }), "INVALID_FIELD");
    await rejects(f.command("task.pause", "legacy", { reason: "现场复核" }, running.revision - 1), "REVISION_CONFLICT");
    assert.deepEqual(f.record("legacy"), running);
    await f.command("task.pause", "legacy", { reason: "现场复核", status: "completed", pausedBy: "forged" }, running.revision, "pause-retry");
    await f.command("task.pause", "legacy", { reason: "现场复核", status: "completed", pausedBy: "forged" }, running.revision, "pause-retry");
    let paused = f.record("legacy");
    assert.equal(paused.status, "paused"); assert.equal(paused.revision, running.revision + 1); assert.equal(paused.pausedBy, "local-owner");
    assert.equal((paused.executionHistory as unknown[]).length, 1);
    assert.equal(f.snapshot().audit.filter(a => a.command === "task.pause").length, 1);
    await rejects(f.change("task.pause", "legacy", { reason: "重复暂停" }), "INVALID_STATE");
    await rejects(f.change("task.start", "legacy"), "INVALID_STATE");
    await rejects(f.change("task.request-completion", "legacy", { reason: "绕过恢复" }), "INVALID_STATE");
    await rejects(f.change("task.confirm-completion", "legacy", { reason: "绕过验收" }), "INVALID_STATE");
    await f.change("task.update", "legacy", { reason: "调整安排", batchLabel: "复核后批次" });
    await f.change("task.conditions.configure", "legacy", { taskType: "non-quantity", rules: rules(), reason: "暂停中重新核查" });
    // Historical progress and site notes may still be recorded without silently resuming work.
    await f.command("progress.create", "backfill", { taskId: "legacy", quantity: 1, unit: "次", businessDate: "2026-10-14", shift: "day", crew: "A", measurementKey: "此前完成部分" });
    await f.command("progress.submit", "backfill", {}, 1);
    await f.command("dailyLog.create", "pause-note", { taskId: "legacy", businessDate: "2026-10-14", description: "暂停期间核查记录" });
    assert.equal(f.record("legacy").status, "paused");
    paused = structuredClone(f.record("legacy"));
    await rejects(f.change("task.resume", "legacy", {}), "INVALID_FIELD");
    await rejects(f.command("task.resume", "legacy", { reason: "核查完成" }, paused.revision - 1), "REVISION_CONFLICT");
    f.setTime("2026-10-14T12:30:00.000Z");
    await f.command("task.resume", "legacy", { reason: "核查完成" }, paused.revision, "resume-retry");
    await f.command("task.resume", "legacy", { reason: "核查完成" }, paused.revision, "resume-retry");
    const resumed = f.record("legacy");
    assert.equal(resumed.status, "in-progress"); assert.equal(resumed.resumedBy, "local-owner");
    assert.equal(resumed.resumeReason, "核查完成"); assert.equal((resumed.executionHistory as unknown[]).length, 2);
    assert.equal((resumed.conditionDecisions as unknown[]).length, 2, "resume has a fresh start-condition decision");
    assert.equal(f.snapshot().audit.filter(a => a.command === "task.resume").length, 1);
    await rejects(f.change("task.resume", "legacy", { reason: "重复恢复" }), "INVALID_STATE");
    f.reopen(); assert.deepEqual(f.record("legacy"), resumed);
    await f.change("task.request-completion", "legacy"); await f.change("task.confirm-completion", "legacy");
    assert.equal(f.record("legacy").status, "completed");
  } finally { f.close(); }
});

test("resume recomputes changed start conditions and cannot bypass open blocking issues", async () => {
  const f = fixture();
  try {
    await f.published("task"); await f.change("task.start", "task"); await f.change("task.pause", "task", { reason: "条件变化" });
    await f.change("task.conditions.configure", "task", { taskType: "non-quantity", rules: rules({ documents: { mode: "required" } }), reason: "新增必备资料要求" });
    let before = f.record("task");
    await rejects(f.change("task.resume", "task", { reason: "尝试恢复" }), "TASK_CONDITIONS_BLOCKED");
    assert.deepEqual(f.record("task"), before);
    await f.change("task.conditions.configure", "task", { taskType: "non-quantity", rules: rules(), reason: "现场确认资料要求不适用" });
    await f.command("issue.create", "blocking", { name: "阻断问题", kind: "safety", taskIds: ["task"], blocksCompletion: true });
    before = structuredClone(f.record("task"));
    await rejects(f.change("task.resume", "task", { reason: "仍有阻断问题" }), "TASK_RESUME_BLOCKED");
    assert.deepEqual(f.record("task"), before, "failed blocker check must not append a condition decision");
    await f.change("issue.assign", "blocking", { ownerId: "local-owner", dueDate: "2026-10-15" }, "issues");
    await f.change("issue.start", "blocking", {}, "issues");
    await f.change("issue.submit", "blocking", { description: "已整改，待复核" }, "issues");
    await rejects(f.change("task.resume", "task", { reason: "仅整改提交" }), "TASK_RESUME_BLOCKED");
    await f.change("issue.review", "blocking", { passed: false, reason: "复核退回" }, "issues");
    await rejects(f.change("task.resume", "task", { reason: "未通过复核" }), "TASK_RESUME_BLOCKED");
    await f.change("issue.submit", "blocking", { description: "再次整改" }, "issues");
    await f.change("issue.review", "blocking", { passed: true, reason: "复核通过" }, "issues");
    await f.command("issue.create", "screening", { name: "待现场核实的模型筛查", kind: "safety", taskId: "task", blocksCompletion: false });
    await f.change("task.resume", "task", { reason: "阻断问题已关闭，条件重新核查" });
    assert.equal(f.record("task").status, "in-progress");
    assert.equal(f.record("screening", "issues").status, "pending-verification", "resume never silently closes unverified findings");
    await f.change("task.pause", "task", { reason: "核查显式阻断规则" });
    await f.change("task.conditions.configure", "task", { taskType: "non-quantity", rules: rules({ "blocking-issues": { mode: "required", referenceIds: ["screening"] }, acceptance: { mode: "required" } }), reason: "指定问题为强制阻断" });
    await rejects(f.change("task.resume", "task", { reason: "显式引用尚未关闭" }), "TASK_RESUME_BLOCKED");
    await f.change("issue.dismiss", "screening", { disposition: "false-positive", reason: "现场复核后判定不成立" }, "issues");
    await f.change("task.resume", "task", { reason: "问题已核实" });
    await f.change("task.request-completion", "task");
    await rejects(f.change("task.confirm-completion", "task"), "TASK_CONDITIONS_BLOCKED");
    assert.equal(f.record("task").status, "pending-completion", "resume is not an acceptance substitute");
  } finally { f.close(); }
});

test("an already-running legacy task without a policy can pause but cannot silently resume", () => {
  const now = "2026-10-14T12:00:00.000Z";
  let task: ManagementRecord = { id: "legacy", projectId, revision: 3, name: "历史执行任务", status: "in-progress", createdAt: now, updatedAt: now, createdBy: "local-owner", ownerId: "local-owner", areaIds: [], predecessorIds: [], planVersion: 1 };
  let saves = 0;
  function run(type: "task.pause" | "task.resume") {
    const context: DomainContext = {
      actor: { id: "local-owner", displayName: "Owner", roles: ["owner"], permissions: rolePermissions.owner, authMode: "local-owner" },
      projectId, now, workingDays: [0, 1, 2, 3, 4, 5, 6], command: { projectId, type, id: task.id, expectedRevision: task.revision, idempotencyKey: type, payload: { reason: "历史任务核查" } },
      list: kind => kind === "tasks" ? [structuredClone(task)] : [],
      get: (kind, id) => { assert.equal(kind, "tasks"); assert.equal(id, task.id); return structuredClone(task); },
      save: (_kind, value) => { task = structuredClone(value); saves++; },
      member: () => {}, area: () => {}, evidence: () => {}, freeze: () => ({}),
    };
    return applyDomain(context);
  }
  run("task.pause");
  const paused = structuredClone(task);
  assert.equal(paused.status, "paused"); assert.equal(paused.conditionPolicy, undefined);
  assert.throws(() => run("task.resume"), error => error instanceof ManagementError && error.code === "TASK_CONDITIONS_BLOCKED");
  assert.deepEqual(task, paused); assert.equal(saves, 1);
});

test("paused tasks stay in metrics and retain historical as-of state", async () => {
  const f = fixture();
  try {
    await f.published("task", { planStart: "2026-10-13", planEnd: "2026-10-13" });
    await f.change("task.start", "task");
    const previous = "2026-10-14T12:00:00.000Z";
    f.setTime("2026-10-14T13:00:00.000Z"); await f.change("task.pause", "task", { reason: "现场核查" });
    const current = f.store.metrics(projectId, f.store.localActor(), "2026-10-14", "2026-10-14T13:00:00.000Z");
    assert.deepEqual(current.dashboard.find(m => m.id === "delayed-tasks")?.detailIds, ["task"]);
    assert.deepEqual(current.taskProgress.map(t => t.taskId), ["task"]);
    const historical = f.store.metrics(projectId, f.store.localActor(), "2026-10-14", previous);
    assert.equal(historical.dashboard.find(m => m.id === "delayed-tasks")?.detailRecords?.[0].record.status, "in-progress");
    assert.equal(current.dashboard.find(m => m.id === "delayed-tasks")?.detailRecords?.[0].record.status, "paused");
  } finally { f.close(); }
});

test("real HTTP pause/resume enforce task scope, assignee, roles and revision before mutation", async () => {
  const f = fixture();
  const server = createServer((req, res) => void f.store.accessMiddleware(req, res, () => void f.store.middleware(req, res, () => { res.statusCode = 404; res.end(); })));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "", sequence = 0;
  const password = "Railway-Task-Isolated-20261014";
  async function request(path: string, payload?: unknown) {
    const response = await fetch(base + path, { method: payload ? "POST" : "GET", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie }, body: payload ? JSON.stringify(payload) : undefined });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data: await response.json() as any };
  }
  const command = (type: string, id?: string, payload: Record<string, unknown> = {}, revision?: number) => request("/__management/commands", { projectId, type, id, payload, expectedRevision: revision, idempotencyKey: `http-railway-${++sequence}` });
  const login = async (username: string) => { const response = await request("/__management/session", { username, password }); assert.equal(response.status, 200); };
  const record = async (id: string) => (await request(`/__management/records/tasks/${id}?projectId=${projectId}`)).data;
  const change = async (type: string, id: string, payload: Record<string, unknown> = {}) => command(type, id, payload, (await record(id)).revision);
  try {
    let response = await command("member.save", undefined, { username: "owner", displayName: "Owner", password, roles: ["owner"] }); assert.equal(response.status, 200);
    const owner = response.data.session.userId;
    for (const id of ["own", "assigned-elsewhere", "outside"]) assert.equal((await command("task.create", id, { name: id === "outside" ? "PRIVATE TASK NAME" : id, ownerId: owner, planStart: "2026-10-14", planEnd: "2026-10-15" })).status, 200);
    for (const [username, roles, taskIds] of [["worker", ["worker"], ["own", "assigned-elsewhere"]], ["viewer", ["viewer"], ["own"]], ["manager", ["manager"], ["own"]]] as const) assert.equal((await command("member.save", undefined, { username, displayName: username, password, roles, taskIds })).status, 200);
    const state = (await request(`/__management/state?projectId=${projectId}`)).data;
    const worker = state.members.find((member: any) => member.username === "worker").id;
    assert.equal((await change("task.update", "own", { ownerId: worker })).status, 200);
    for (const id of ["own", "assigned-elsewhere", "outside"]) {
      assert.equal((await change("task.conditions.configure", id, { taskType: "non-quantity", rules: rules(), reason: "隔离授权测试" })).status, 200);
      assert.equal((await change("task.publish", id)).status, 200);
    }
    await login("worker");
    assert.equal((await change("task.start", "own")).status, 200);
    assert.equal((await change("task.start", "assigned-elsewhere")).data.code, "TASK_EXECUTOR_REQUIRED");
    let current = await record("own");
    response = await command("task.pause", "own", { reason: "复核" }, current.revision - 1); assert.equal(response.status, 409); assert.equal(response.data.code, "REVISION_CONFLICT");
    assert.equal((await change("task.pause", "own", { reason: "现场核查" })).status, 200);
    assert.equal((await change("task.resume", "own", { reason: "条件复核完成" })).status, 200);
    for (const type of ["task.pause", "task.resume"]) {
      response = await command(type, "assigned-elsewhere", { reason: "他人任务" }, 999); assert.equal(response.status, 403); assert.equal(response.data.code, "TASK_EXECUTOR_REQUIRED");
      response = await command(type, "outside", { reason: "越权" }, 999); assert.equal(response.status, 403); assert.equal(response.data.current, undefined); assert.equal(JSON.stringify(response.data).includes("PRIVATE TASK NAME"), false);
    }
    await login("viewer");
    response = await change("task.pause", "own", { reason: "只读账号" }); assert.equal(response.status, 403);
    await login("manager");
    assert.equal((await change("task.pause", "own", { reason: "有权管理人员暂停" })).status, 200);
    assert.equal((await change("task.resume", "own", { reason: "有权管理人员复核恢复" })).status, 200);
    current = await record("own"); assert.equal(current.status, "in-progress"); assert.equal(current.ownerId, worker);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); f.close();
  }
});
