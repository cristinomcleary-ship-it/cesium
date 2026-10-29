import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import { MachineryTelemetryGateway, validateMachineryTelemetryConfig, validateMachineryTelemetryFrame, type MachineryTelemetryFrame } from "./machineryTelemetryGateway.ts";
import { MACHINERY_ASSET_VERSION } from "../../src/machineryTypes.ts";
import { MACHINERY_PARAMETER_DEFAULTS } from "../../src/machineryValidation.ts";
import type { ManagementRecord, ManagementCommandType } from "../../src/managementTypes.ts";

const projectId = "safety:project", resourceId = "crane-01", sourceId = "sensor-01";
const epoch = Date.parse("2026-10-28T08:00:00Z");
const metadata = () => ({ schemaVersion: 1, assetId: "crane", assetVersion: MACHINERY_ASSET_VERSION, proportional: false,
  parameters: { ...MACHINERY_PARAMETER_DEFAULTS.crane }, placement: { longitude: 116.39, latitude: 39.9, height: 40, heading: 0 }, visible: true });
const sample = (patch: Partial<MachineryTelemetryFrame> = {}): MachineryTelemetryFrame => ({ schemaVersion: 1, projectId, resourceId, sourceId,
  timestamp: new Date(epoch).toISOString(), mode: "simulated", values: { boom_length_m: 4, boom_elevation_deg: 0 }, ...patch });
const record = () => ({ id: resourceId, projectId, kind: "equipment", status: "active", machinery: metadata() }) as unknown as ManagementRecord;

test("both deletion representations stop telemetry intake and hide buffered poses", () => {
  const gateway = new MachineryTelemetryGateway({ version: 1, devices: [] }, () => epoch);
  gateway.ingest(sample(), record());
  for (const deleted of [{ ...record(), status: "deleted" }, { ...record(), deletedAt: "2026-10-28T08:00:00Z" }]) {
    assert.throws(() => gateway.ingest(sample({ timestamp: new Date(epoch + 1).toISOString() }), deleted), { code: "MACHINERY_TELEMETRY_RESOURCE_INVALID" });
    assert.deepEqual(gateway.snapshot(projectId, [deleted]).frames, []);
  }
});

async function fixture(initialClock: number | (() => number) = epoch, useEnvironmentConfig = false) {
  const root = mkdtempSync(join(tmpdir(), "cesium-machinery-telemetry-")), token = randomBytes(32).toString("base64url"), password = `Test-${randomUUID()}`;
  let clock = typeof initialClock === "function" ? initialClock() : initialClock, cookie = "";
  const config = { version: 1 as const, devices: [{ projectId, resourceId, sourceId, enabled: true, tokenSha256: createHash("sha256").update(token).digest("hex") }] };
  const store = createManagementStore({ dataDir: root, libraryDataDir: root, machineryTelemetryConfig: useEnvironmentConfig ? undefined : config, now: () => new Date(typeof initialClock === "function" ? initialClock() : clock).toISOString() });
  const server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); })));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data: await response.json() as any };
  }
  async function command(type: ManagementCommandType, payload: Record<string, unknown>, id?: string, expectedRevision?: number, project = projectId) {
    const r = await request("/__management/commands", { projectId: project, type, payload, id, expectedRevision, idempotencyKey: randomUUID() });
    assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data;
  }
  async function login(username: string) { const r = await request("/__management/session", { username, password, projectId }); assert.equal(r.status, 200); }
  await command("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  await command("resource.create", { name: "Crane", kind: "equipment" }, resourceId);
  await command("machinery.save", { machinery: metadata() }, resourceId, 1);
  const ingest = (value: unknown = sample(), headers: Record<string, string> = {}) => request("/__management/machinery-telemetry", value, { authorization: `Bearer ${token}`, cookie: "", ...headers });
  return { request, command, login, ingest, config, token, password, base, advance(ms: number) { clock += ms; },
    async close() { await new Promise<void>(done => server.close(() => done())); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("HTTP accepts explicit session simulation and device telemetry while preserving business records", async () => {
  const f = await fixture(); try {
    const before = (await f.request("/__management/state")).data;
    const r = await f.request("/__management/machinery-telemetry", sample()); assert.equal(r.status, 202);
    assert.equal(r.data.frame.mode, "simulated"); assert.equal(r.data.frame.values.boom_elevation_deg, 0);
    assert.equal((await f.request("/__management/machinery-telemetry", sample({ mode: "measured" }))).status, 403);
    assert.equal((await f.ingest(sample({ mode: "measured" }))).status, 202);
    const first = (await f.request("/__management/machinery-telemetry?projectId=safety:project")).data;
    assert.equal(first.frames.length, 2); assert.equal(first.cursor, 2);
    assert.ok(!JSON.stringify(first).includes(f.token)); assert.ok(!JSON.stringify(first).includes("tokenSha256"));
    const next = (await f.request(`/__management/machinery-telemetry?after=${first.cursor}&streamId=${first.streamId}`)).data;
    assert.deepEqual(next.frames, []); assert.equal(next.reset, false);
    const after = (await f.request("/__management/state")).data;
    assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.audit, before.audit); assert.equal(after.revision, before.revision);
  } finally { await f.close(); }
});

test("HTTP rejects unauthorised, cross-project/source, cross-origin, removed and unknown resource writes", async () => {
  const f = await fixture(); try {
    assert.equal((await f.request("/__management/machinery-telemetry", sample(), { cookie: "" })).status, 401);
    assert.equal((await f.ingest(sample(), { authorization: `Bearer ${randomBytes(32).toString("base64url")}` })).status, 401);
    assert.equal((await f.ingest(sample(), { origin: "https://evil.invalid" })).status, 403);
    for (const patch of [{ projectId: "other" }, { resourceId: "other" }, { sourceId: "other" }]) assert.equal((await f.ingest(sample(patch))).data.code, "DEVICE_SCOPE_MISMATCH");
    assert.equal((await f.request("/__management/machinery-telemetry", sample(), { "x-cesium-library": "" })).status, 403);
    assert.equal((await f.request("/__management/machinery-telemetry", sample({ resourceId: "missing" }))).status, 404);
    assert.equal((await f.ingest()).status, 202);
    await f.command("machinery.remove", {}, resourceId, 2);
    assert.equal((await f.ingest(sample({ timestamp: new Date(epoch + 1).toISOString() }))).status, 422);
    assert.deepEqual((await f.request("/__management/machinery-telemetry")).data.frames, []);
    assert.equal((await f.request("/__management/machinery-telemetry?after=NaN")).status, 400);
  } finally { await f.close(); }
});

test("permissions are checked on each poll and simulation; device tokens cannot read", async () => {
  const f = await fixture(); try {
    await f.ingest();
    assert.equal((await f.request("/__management/machinery-telemetry", undefined, { cookie: "", authorization: `Bearer ${f.token}` })).status, 401);
    const state = await f.command("member.save", { username: "reader", displayName: "Reader", password: f.password, roles: ["viewer"], resourceAccess: { models: true, files: false, media: false } });
    const memberId = state.members.find((m: any) => m.username === "reader").id;
    await f.login("reader");
    assert.equal((await f.request("/__management/machinery-telemetry")).data.frames.length, 1);
    assert.equal((await f.request("/__management/machinery-telemetry", sample())).status, 403);
    await f.login("owner");
    await f.command("member.save", { username: "reader", displayName: "Reader", roles: ["viewer"], resourceAccess: { models: false, files: false, media: false } }, memberId, 1);
    await f.login("reader"); assert.equal((await f.request("/__management/machinery-telemetry")).status, 403);
    await f.login("owner"); await f.command("project.create", { id: "other-project", name: "Other" });
    assert.deepEqual((await f.request("/__management/machinery-telemetry?projectId=other-project")).data.frames, []);
  } finally { await f.close(); }
});

test("numeric/timestamp validation is strict and per-field ordering commits whole frames atomically", () => {
  const gateway = new MachineryTelemetryGateway({ version: 1, devices: [] }, () => epoch);
  gateway.ingest(sample({ values: { length: 4 } }), record());
  gateway.ingest(sample({ timestamp: new Date(epoch - 1).toISOString(), values: { angle: 0 } }), record());
  gateway.ingest(sample({ sourceId: "other", timestamp: new Date(epoch - 10).toISOString(), values: { length: 5 } }), record());
  assert.throws(() => gateway.ingest(sample({ values: { length: 6, angle: 10 } }), record()), /重复或乱序/);
  assert.equal(gateway.snapshot(projectId, [record()]).frames.length, 3);
  for (const values of [{ length: null }, { length: "4" }, { length: NaN }, {}, { length: Infinity }, { constructor: 1 }]) assert.throws(() => validateMachineryTelemetryFrame({ ...sample(), values }));
  for (const timestamp of ["2026-02-30T08:00:00Z", "2026-10-28 08:00:00", "2026-10-28T08:00:00", "invalid"]) assert.throws(() => validateMachineryTelemetryFrame({ ...sample(), timestamp }));
  for (const offset of [-60_001, 5001]) assert.throws(() => gateway.ingest(sample({ timestamp: new Date(epoch + offset).toISOString() }), record()), /60秒|5秒/);
  assert.throws(() => gateway.ingest(sample(), { ...record(), projectId: "other" }));
});

test("buffer is bounded, a lost cursor is reported, restart resets stream, and stale frames expire", () => {
  let clock = epoch;
  const gateway = new MachineryTelemetryGateway({ version: 1, devices: [] }, () => clock);
  for (let i = 0; i < 2050; i++) { clock++; gateway.ingest(sample({ timestamp: new Date(clock).toISOString() }), record()); }
  const result = gateway.snapshot(projectId, [record()], 1, gateway.streamId);
  assert.equal(result.frames.length, 2048); assert.equal(result.cursor, 2050); assert.equal(result.reset, true);
  const fresh = new MachineryTelemetryGateway({ version: 1, devices: [] }, () => clock);
  assert.equal(fresh.snapshot(projectId, [record()], result.cursor, gateway.streamId).reset, true);
  clock += 60_001; assert.deepEqual(gateway.snapshot(projectId, [record()]).frames, []);
});

test("disabled or malformed device configuration fails closed", () => {
  const gateway = new MachineryTelemetryGateway({ version: 1, devices: [] });
  assert.throws(() => gateway.authenticate(undefined), /尚未配置/);
  const d = { projectId, resourceId, sourceId, enabled: true, tokenSha256: "a".repeat(64) };
  for (const config of [{ version: 1, devices: [{ ...d, token: "secret" }] }, { version: 1, devices: [d, d] }, { version: 1, devices: [{ ...d, tokenSha256: "bad" }] }]) assert.throws(() => validateMachineryTelemetryConfig(config), /配置无效/);
});

test("CLI creates private hashed config and sends a real HTTP simulated frame", async () => {
  const run = promisify(execFile), root = mkdtempSync(join(tmpdir(), "cesium-telemetry-cli-")), file = join(root, "gateway.json");
  // The external CLI samples the real clock after process startup. Keep this server's
  // clock moving too; CPU contention during setup must not resemble a future sensor fix.
  const f = await fixture(Date.now);
  try {
    await run(process.execPath, ["tools/simulate-machinery-telemetry.mjs", "--init-config", file, "--project", projectId, "--resource", resourceId, "--source", sourceId]);
    const config = JSON.parse(readFileSync(file, "utf8")), token = readFileSync(file + ".token", "utf8").trim();
    assert.equal(config.devices[0].tokenSha256, createHash("sha256").update(token).digest("hex"));
    assert.ok(!readFileSync(file, "utf8").includes(token));
    const result = await run(process.execPath, ["tools/simulate-machinery-telemetry.mjs", "--url", f.base, "--project", projectId, "--resource", resourceId, "--source", sourceId, "--values", '{"boom_length_m":4,"boom_elevation_deg":0}', "--once"], { env: { ...process.env, CESIUM_MACHINERY_TELEMETRY_TOKEN: f.token } });
    assert.match(result.stdout, /接受 1 帧模拟数据/); assert.ok(!result.stdout.includes(f.token));
    const frames = (await f.request("/__management/machinery-telemetry")).data.frames;
    assert.equal(frames.length, 1); assert.equal(frames[0].mode, "simulated"); assert.equal(frames[0].values.boom_elevation_deg, 0);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("missing or malformed optional device config only disables external ingestion, not platform or page simulation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-telemetry-invalid-config-"));
  const previous = process.env.CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE;
  try {
    for (const content of [undefined, "{broken-json", '{"version":1,"devices":[{"token":"private-secret"}]}']) {
      const file = join(root, randomUUID() + ".json");
      if (content !== undefined) writeFileSync(file, content);
      process.env.CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE = file;
      const f = await fixture(epoch, true);
      try {
        assert.equal((await f.request("/__management/state")).status, 200, "platform starts and remains readable");
        const edited = metadata(); edited.placement.heading = 90;
        await f.command("machinery.save", { machinery: edited }, resourceId, 2);
        assert.equal((await f.request("/__management/state")).data.collections.resources[0].machinery.placement.heading, 90, "manual machinery edits remain usable");
        assert.equal((await f.request("/__management/machinery-telemetry", sample())).status, 202, "authorised page simulation remains usable");
        const snap = (await f.request("/__management/machinery-telemetry")).data;
        assert.equal(snap.externalEnabled, false);
        assert.equal(snap.externalConfigurationError.code, "MACHINERY_TELEMETRY_CONFIG_INVALID");
        assert.equal(snap.frames.length, 1);
        const external = await f.ingest(sample({ mode: "measured" }));
        assert.equal(external.status, 503); assert.equal(external.data.code, "MACHINERY_TELEMETRY_CONFIG_INVALID");
        for (const value of [JSON.stringify(snap), JSON.stringify(external.data)]) {
          assert.ok(!value.includes(file)); assert.ok(!value.includes("private-secret")); assert.ok(!value.includes(f.token));
        }
      } finally { await f.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE;
    else process.env.CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
