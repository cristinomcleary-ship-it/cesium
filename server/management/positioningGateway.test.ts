import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagementStore } from "../managementStore.ts";
import { validatePositioningGatewayConfig, type PositioningGatewayConfig } from "./positioningGateway.ts";
import { evaluateRailSafetyPositioning } from "../../src/railSafetyPositioning.ts";
import type { RailSafetyGuard, RailSafetyPositionSample } from "../../src/railSafetyTypes.ts";
import type { ManagementCommandType } from "../../src/managementTypes.ts";

const projectId = "safety:project", deviceId = "tracker-01", guardId = "guard-01", password = `Gateway-${randomUUID()}`;
const now = Date.parse("2026-10-14T05:00:00Z");
const polygon = [{ longitude: 116.39, latitude: 39.9, height: 40 }, { longitude: 116.391, latitude: 39.9, height: 40 }, { longitude: 116.391, latitude: 39.901, height: 40 }, { longitude: 116.39, latitude: 39.901, height: 40 }];
const guard = (): RailSafetyGuard => ({ schemaVersion: 1, kind: "guard", station: polygon[0], polygon, resourceIds: [], workArea: { polygon, deviceId, staleAfterSeconds: 30 } });
const sample = (patch: Partial<RailSafetyPositionSample> = {}): RailSafetyPositionSample => ({ projectId, deviceId, coordinateSystem: "WGS84", position: { longitude: 116.3905, latitude: 39.9005, height: 40 }, timestamp: new Date(now).toISOString(), accuracyMeters: 0.5, source: "measured", ...patch });

async function fixture(disabled = false) {
  const root = mkdtempSync(join(tmpdir(), "cesium-positioning-")), token = randomBytes(32).toString("base64url");
  const config: PositioningGatewayConfig = { version: 1, devices: disabled ? [] : [{ projectId, guardId, deviceId, enabled: true, tokenSha256: createHash("sha256").update(token).digest("hex") }] };
  let store: ReturnType<typeof createManagementStore>, server: Server, base = "", cookie = "", clock = now;
  async function start() {
    store = createManagementStore({ dataDir: root, libraryDataDir: root, positioningConfig: config, now: () => new Date(clock).toISOString() });
    server = createServer((req, res) => void store.accessMiddleware(req, res, () => void store.middleware(req, res, () => { res.statusCode = 404; res.end(); })));
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function stop() { await new Promise<void>(done => server.close(() => done())); store.close(); }
  async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cesium-library": "1", cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";")[0];
    return { status: response.status, data: await response.json() as any };
  }
  async function command(type: ManagementCommandType, payload: Record<string, unknown>, id?: string, expectedRevision?: number, project = projectId) {
    const result = await request("/__management/commands", { projectId: project, type, payload, id, expectedRevision, idempotencyKey: randomUUID() });
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  }
  async function login(username: string) { const r = await request("/__management/session", { username, password, projectId }); assert.equal(r.status, 200); return cookie; }
  const ingest = (value: unknown = sample(), headers: Record<string, string> = {}) => request("/__management/positioning/ingest", value, { authorization: `Bearer ${token}`, cookie: "", ...headers });
  await start(); await command("member.save", { username: "owner", displayName: "Owner", password, roles: ["owner"] });
  await command("railSafety.save", { name: "Guard", definition: guard() }, guardId, 0);
  return { request, command, login, ingest, config, token, advance: (ms: number) => { clock += ms; }, async restart() { await stop(); await start(); }, async close() { await stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("gateway requires an independent device token, rejects cookies, cross-origin and cross-binding writes", async () => {
  const f = await fixture(); try {
    for (const headers of [{ authorization: "" }, { authorization: `Bearer ${randomBytes(32).toString("base64url")}` }]) assert.equal((await f.ingest(sample(), headers)).status, 401);
    assert.equal((await f.request("/__management/positioning/ingest", sample())).status, 401, "owner session is not device auth");
    assert.equal((await f.ingest(sample(), { origin: "https://foreign.invalid" })).status, 403);
    for (const patch of [{ projectId: "other-project" }, { deviceId: "tracker-02" }, { source: "simulated" as const }]) assert.equal((await f.ingest(sample(patch))).status, 403);
    assert.equal((await f.ingest()).status, 202);
    const response = await f.request("/__management/positioning");
    assert.equal(response.status, 200); assert.equal(response.data.devices[0].sample.source, "measured");
    assert.ok(!JSON.stringify(response.data).includes(f.token)); assert.ok(!JSON.stringify(response.data).includes("tokenSha256"));
    assert.equal((await f.request("/__management/positioning", undefined, { cookie: "", authorization: `Bearer ${f.token}` })).status, 401, "device token cannot read personnel locations");
  } finally { await f.close(); }
});

test("time, accuracy and coordinate validation preserve the last accepted fix and business records", async () => {
  const f = await fixture(); try {
    const before = (await f.request("/__management/state")).data;
    assert.equal((await f.ingest()).status, 202);
    assert.equal((await f.ingest()).data.code, "POSITIONING_TIME_CONFLICT");
    for (const offset of [-1, 6000]) assert.equal((await f.ingest(sample({ timestamp: new Date(now + offset).toISOString() }))).data.code, "POSITIONING_TIME_CONFLICT");
    assert.equal((await f.ingest(sample({ timestamp: new Date(now - 30_000).toISOString() }))).data.code, "POSITIONING_STALE_SAMPLE");
    for (const value of [{ ...sample(), accuracyMeters: undefined }, { ...sample(), coordinateSystem: "GCJ-02" }, { ...sample(), accuracyMeters: -1 }, { ...sample(), extra: true }]) assert.equal((await f.ingest(value)).status, 400);
    const snap = (await f.request("/__management/positioning")).data;
    assert.deepEqual(snap.devices[0].sample, sample());
    assert.equal(evaluateRailSafetyPositioning(guard(), snap.devices[0].sample, { projectId, now }).state, "inside");
    f.advance(30_001);
    assert.equal(evaluateRailSafetyPositioning(guard(), snap.devices[0].sample, { projectId, now: now + 30_001 }).state, "stale");
    const after = (await f.request("/__management/state")).data;
    assert.deepEqual(after.collections, before.collections); assert.deepEqual(after.audit, before.audit); assert.equal(after.revision, before.revision);
  } finally { await f.close(); }
});

test("live authorization, project membership, guard binding and restart all govern readable samples", async () => {
  const f = await fixture(); try {
    await f.ingest();
    await f.restart(); assert.equal((await f.request("/__management/positioning")).data.devices[0].sample, undefined, "restart clears transient measured points");
    await f.ingest();
    const hidden = await f.command("member.save", { username: "hidden", displayName: "Hidden", password, roles: ["viewer"], resourceAccess: { models: false, files: false, media: false } });
    const hiddenId = hidden.members.find((m: any) => m.username === "hidden").id;
    await f.login("hidden"); assert.equal((await f.request("/__management/positioning")).status, 403);
    assert.equal((await f.request("/__management/positioning", undefined, { cookie: "" })).status, 401);
    await f.login("owner");
    await f.command("member.save", { username: "hidden", displayName: "Hidden", roles: ["viewer"], resourceAccess: { models: true, files: false, media: false } }, hiddenId, 1);
    const viewerCookie = await f.login("hidden"); assert.equal((await f.request("/__management/positioning")).data.devices.length, 1);
    await f.login("owner");
    await f.command("member.save", { username: "hidden", displayName: "Hidden", roles: ["viewer"], resourceAccess: { models: false, files: false, media: false } }, hiddenId, 2);
    assert.equal((await f.request("/__management/positioning", undefined, { cookie: viewerCookie })).status, 403, "already-issued session loses access immediately when models permission is revoked");
    await f.command("project.create", { id: "other-project", name: "Other" });
    await f.command("railSafety.save", { name: "Other guard", definition: guard() }, guardId, 0, "other-project");
    assert.equal((await f.request("/__management/positioning?projectId=other-project")).data.devices[0].configured, false);
    await f.login("hidden"); assert.equal((await f.request("/__management/positioning?projectId=other-project")).status, 403);
    await f.login("owner");
    await f.command("railSafety.remove", { reason: "reassign tracker" }, guardId, 1);
    await f.command("railSafety.save", { name: "Replacement", definition: guard() }, "guard-replacement", 0);
    assert.equal((await f.ingest(sample({ timestamp: new Date(now + 1).toISOString() }))).data.code, "DEVICE_BINDING_INVALID");
    assert.equal((await f.request("/__management/positioning")).data.devices[0].sample, undefined, "old personnel fix cannot follow a reused device id");
    await f.restart(); assert.equal((await f.request("/__management/positioning")).data.devices[0].sample, undefined);
  } finally { await f.close(); }
});

test("disabled configuration closes ingestion and malformed or shared device credentials fail closed", async () => {
  const f = await fixture(true); try { assert.equal((await f.ingest()).data.code, "POSITIONING_DISABLED"); assert.equal((await f.request("/__management/positioning")).data.enabled, false); }
  finally { await f.close(); }
  const d = { projectId, deviceId, guardId, enabled: true, tokenSha256: "a".repeat(64) };
  for (const config of [{ version: 1, devices: [{ ...d, token: "raw-secret" }] }, { version: 1, devices: [d, { ...d, projectId: "other" }] }, { version: 1, devices: [{ ...d, tokenSha256: "invalid" }] }]) assert.throws(() => validatePositioningGatewayConfig(config), /配置无效/);
});
