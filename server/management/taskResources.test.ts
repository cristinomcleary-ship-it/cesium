import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createManagementStore } from "../managementStore.ts";
import type { ManagementCollection, ManagementCommandType } from "../../src/managementTypes.ts";

const projectId = "safety:project", password = "Task-Resource-Isolated-20261014";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cesium-task-resources-"));
  let store: ReturnType<typeof createManagementStore>, server: Server, base = "", cookie = "", sequence = 0;
  async function start() {
    store = createManagementStore({ dataDir: root, libraryDataDir: root });
    server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); })));
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function stop() { await new Promise<void>(done => server.close(() => done())); store.close(); }
  async function request(path: string, body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data, text };
  }
  async function command(type: ManagementCommandType, payload: Record<string, unknown> = {}, id?: string, expectedRevision?: number, project = projectId, key?: string) {
    return request("/__management/commands", { projectId: project, type, payload, id, expectedRevision, idempotencyKey: key ?? `task-resources-${++sequence}` });
  }
  async function ok(type: ManagementCommandType, payload: Record<string, unknown> = {}, id?: string, expectedRevision?: number, project = projectId, key?: string) {
    const response = await command(type, payload, id, expectedRevision, project, key); assert.equal(response.status, 200, `${type}: ${response.text}`); return response.data;
  }
  async function record(id: string, kind: ManagementCollection = "tasks") { return request(`/__management/records/${kind}/${id}?projectId=${encodeURIComponent(projectId)}`); }
  async function state() { const response = await request(`/__management/state?projectId=${encodeURIComponent(projectId)}`); assert.equal(response.status, 200); return response.data; }
  async function login(username: string) { const response = await request("/__management/session", { username, password, projectId }); assert.equal(response.status, 200); }
  await start(); await ok("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  return { request, command, ok, record, state, login, async restart(edit?: (database: DatabaseSync) => void) {
    await stop();
    if (edit) { const database = new DatabaseSync(join(root, "management.sqlite")); try { edit(database); } finally { database.close(); } }
    await start();
  }, async close() { await stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("task equipment references persist independently of resources, safety bindings and admission decisions", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "吊机", kind: "equipment", availability: "disabled" }, "machine");
    await f.ok("resource.create", { name: "待布置机械", kind: "equipment" }, "unplaced");
    await f.ok("railSafety.save", { name: "未关联作业的管控配置", definition: { schemaVersion: 1, kind: "machine", resourceId: "machine", selectedLimitIds: [], inspectionStatus: "unknown", support: { length: 8, width: 5, centerX: 0, centerZ: 0 } } }, "machine-config", 0);
    const before = await f.state(), ownerId = before.session.userId;
    const payload = { name: "现场作业卡", resourceIds: ["machine", "unplaced", "machine"], ownerId, planStart: "2026-10-14", planEnd: "2026-10-15" };
    await f.ok("task.create", payload, "task", 0, projectId, "create-once");
    await f.ok("task.create", payload, "task", 0, projectId, "create-once");
    let task = (await f.record("task")).data;
    assert.deepEqual(task.resourceIds, ["machine", "unplaced"]);
    assert.equal(task.conditionPolicy, undefined); assert.equal(task.status, "draft");
    let after = await f.state();
    assert.deepEqual(after.collections.resources, before.collections.resources);
    assert.deepEqual(after.collections.railSafety, before.collections.railSafety);
    assert.equal(after.audit.filter((entry: any) => entry.command === "task.create").length, 1);
    await f.ok("task.update", { name: "只更新名称" }, "task", task.revision);
    task = (await f.record("task")).data; assert.deepEqual(task.resourceIds, ["machine", "unplaced"]);
    await f.restart(); assert.deepEqual((await f.record("task")).data, task);
    await f.ok("task.publish", {}, "task", task.revision);
    assert.equal((await f.command("task.start", {}, "task", (await f.record("task")).data.revision)).data.code, "TASK_CONDITIONS_BLOCKED", "equipment association never grants start clearance");
    const stale = await f.command("task.update", { name: "过期修订", resourceIds: [] }, "task", 1);
    assert.equal(stale.status, 409); assert.equal(stale.data.code, "REVISION_CONFLICT");
    assert.equal((await f.command("resource.update", { name: "改为班组", kind: "crew", reason: "变更类别" }, "unplaced", 1)).data.code, "TASK_RESOURCE_KIND");
    await f.ok("task.update", { resourceIds: [], reason: "解除作业关联" }, "task", (await f.record("task")).data.revision);
    await f.ok("resource.update", { name: "解除后改为班组", kind: "crew", reason: "变更类别" }, "unplaced", 1);
    assert.deepEqual((await f.record("task")).data.resourceIds, []);
    await f.ok("task.create", { name: "旧客户端任务" }, "legacy");
    await f.ok("task.update", { description: "兼容旧字段" }, "legacy", 1);
    assert.equal((await f.record("legacy")).data.resourceIds, undefined, "old tasks do not receive an invented equipment association");
    after = await f.state(); assert.deepEqual(after.collections.railSafety, before.collections.railSafety);
  } finally { await f.close(); }
});

test("invalid, deleted, non-equipment and cross-project task references fail atomically over HTTP", async () => {
  const f = await fixture(); try {
    await f.ok("resource.create", { name: "机械", kind: "equipment" }, "machine");
    await f.ok("resource.create", { name: "班组", kind: "crew" }, "crew");
    await f.ok("resource.create", { name: "已删设备", kind: "equipment" }, "deleted");
    await f.ok("project.create", { id: "other-project", name: "独立项目" });
    await f.ok("resource.create", { name: "PRIVATE FOREIGN MACHINE", kind: "equipment" }, "foreign", undefined, "other-project");
    await f.ok("task.create", { name: "任务", resourceIds: ["machine"] }, "task");
    await f.restart(database => {
      const source = database.prepare("SELECT data FROM records WHERE project_id=? AND collection='resources' AND id=?").get(projectId, "deleted")!;
      const record = JSON.parse(String(source.data)); record.status = "deleted";
      database.prepare("UPDATE records SET data=? WHERE project_id=? AND collection='resources' AND id=?").run(JSON.stringify(record), projectId, "deleted");
    });
    const before = await f.state();
    for (const [index, resourceIds] of [null, "machine", [1], ["bad/id"], ["crew"], ["deleted"], ["missing"], ["foreign"]].entries()) {
      for (const type of ["task.create", "task.update"] as const) {
        const result = await f.command(type, { name: "无效关联", resourceIds }, type === "task.create" ? `invalid-${index}` : "task", type === "task.create" ? 0 : 1);
        assert.ok(result.status >= 400 && result.status < 500, `${type} ${index}: ${result.text}`);
        assert.equal(result.text.includes("PRIVATE FOREIGN MACHINE"), false);
      }
    }
    const after = await f.state();
    assert.equal(after.revision, before.revision); assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.audit, before.audit);
  } finally { await f.close(); }
});

test("task associations follow existing read scopes without granting resource edits or exposing hidden equipment", async () => {
  const f = await fixture(); try {
    for (const id of ["own-machine", "private-machine", "unassigned", "shared"]) await f.ok("resource.create", { name: id === "private-machine" ? "PRIVATE RESOURCE NAME" : id, kind: "equipment" }, id);
    await f.ok("task.create", { name: "任务A", resourceIds: ["own-machine"] }, "A");
    await f.ok("task.create", { name: "任务B", resourceIds: ["private-machine"] }, "B");
    for (const [username, roles, taskIds] of [["planner", ["planner"], ["A"]], ["wide-planner", ["planner"], undefined], ["viewer", ["viewer"], ["A"]]] as const) await f.ok("member.save", { username, displayName: username, password, roles, taskIds, resourceAccess: { models: false } });
    await f.login("wide-planner");
    await f.ok("task.create", { name: "仅计划权限的作业卡", resourceIds: ["unassigned"] }, "planner-created");
    assert.equal((await f.command("resource.update", { name: "越权编辑", kind: "equipment", reason: "测试" }, "unassigned", 1)).status, 403);
    await f.login("planner");
    assert.equal((await f.record("own-machine", "resources")).status, 200, "authorized task can read its directly linked equipment ledger");
    assert.equal((await f.record("private-machine", "resources")).status, 403);
    assert.equal((await f.record("unassigned", "resources")).status, 403);
    const snapshot = await f.state(); assert.deepEqual(snapshot.collections.resources.map((record: any) => record.id), ["own-machine"]);
    await f.ok("task.update", { resourceIds: ["own-machine", "own-machine"] }, "A", 1);
    const own = (await f.record("A")).data;
    for (const id of ["private-machine", "unassigned"]) {
      const forbidden = await f.command("task.update", { resourceIds: [id] }, "A", 999);
      assert.equal(forbidden.status, 403, "reference access is checked before returning a revision conflict");
      assert.equal(forbidden.data.current, undefined); assert.equal(forbidden.text.includes("PRIVATE RESOURCE NAME"), false);
    }
    assert.deepEqual((await f.record("A")).data, own);
    await f.login("viewer"); assert.equal((await f.command("task.update", { resourceIds: [] }, "A", own.revision)).status, 403);
    await f.login("owner");
    await f.ok("task.update", { resourceIds: ["own-machine", "shared"] }, "A", own.revision);
    await f.ok("task.update", { resourceIds: ["private-machine", "shared"] }, "B", 1);
    await f.login("planner");
    assert.equal((await f.record("shared", "resources")).status, 403, "existing all-related-tasks scope stays conservative for shared equipment");
    assert.equal((await f.record("A")).status, 403, "a forward reference does not expose the other task through the shared resource");
  } finally { await f.close(); }
});
