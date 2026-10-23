import test from "node:test";
import assert from "node:assert/strict";
import { RailSafetyPositioningClient, type RailSafetyPositioningClientStatus } from "./railSafetyPositioningClient.ts";
import type { RailSafetyPositioningSnapshot } from "./railSafetyPositioningTransport.ts";

const sample = { projectId: "project:a", deviceId: "tracker", coordinateSystem: "WGS84" as const, position: { longitude: 116, latitude: 39, height: 40 }, timestamp: "2026-10-14T05:00:00Z", accuracyMeters: 0.5, source: "measured" as const };
const snapshot = (projectId = "project:a"): RailSafetyPositioningSnapshot => ({ schemaVersion: 1, projectId, serverTime: sample.timestamp, enabled: true, devices: [{ guardId: "guard", deviceId: "tracker", configured: true, sample: { ...sample, projectId } }] });
const tick = () => new Promise<void>(done => setImmediate(done));

test("polling uses only session credentials, emits whole snapshots but deduplicates unchanged samples", async () => {
  const calls: RequestInit[] = [], updates: number[] = [], snaps: RailSafetyPositioningSnapshot[] = [];
  const client = new RailSafetyPositioningClient({ intervalMs: 250, fetch: (async (_url, options) => { calls.push(options!); return Response.json(snapshot()); }) as typeof fetch, onSnapshot: (s, u) => { snaps.push(s); updates.push(u.length); } });
  try {
    client.setContext({ projectId: "project:a", actorId: "owner", enabled: true });
    await new Promise<void>(done => setTimeout(done, 290));
    assert.deepEqual(updates, [1, 0]); assert.equal(snaps.length, 2);
    assert.equal(calls[0].credentials, "same-origin"); assert.equal(calls[0].cache, "no-store"); assert.equal(new Headers(calls[0].headers).get("authorization"), null);
    client.setContext({ projectId: "project:a", actorId: "reader", enabled: true }); await tick();
    assert.equal(updates.at(-1), 1, "new actor receives a fresh snapshot without the old actor's dedupe state");
  } finally { client.dispose(); }
});

test("scope changes and disposal abort pending polls and ignore even late non-abortable responses", async () => {
  const pending: Array<{ resolve: (value: Response) => void; signal: AbortSignal }> = [], seen: string[] = [];
  const client = new RailSafetyPositioningClient({ fetch: ((_url, options) => new Promise<Response>(resolve => pending.push({ resolve, signal: options!.signal! }))) as typeof fetch, onSnapshot: s => seen.push(s.projectId) });
  client.setContext({ projectId: "project:a", actorId: "owner", enabled: true });
  client.setContext({ projectId: "project:b", actorId: "owner", enabled: true });
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(Response.json(snapshot())); pending[1].resolve(Response.json(snapshot("project:b"))); await tick();
  assert.deepEqual(seen, ["project:b"]);
  client.setContext({ projectId: "project:c", actorId: "owner", enabled: true }); client.dispose();
  assert.equal(pending[2].signal.aborted, true); pending[2].resolve(Response.json(snapshot("project:c"))); await tick(); assert.deepEqual(seen, ["project:b"]);
});

test("authorization loss is explicit and foreign or simulated responses never enter browser state", async () => {
  for (const body of [Response.json({}, { status: 403 }), Response.json(snapshot("project:foreign")), Response.json({ ...snapshot(), devices: [{ guardId: "guard", deviceId: "tracker", configured: true, sample: { ...sample, source: "simulated" } }] })]) {
    const status: RailSafetyPositioningClientStatus[] = [], seen: unknown[] = [];
    const client = new RailSafetyPositioningClient({ fetch: (async () => body) as typeof fetch, onSnapshot: s => seen.push(s), onStatus: s => status.push(s) });
    client.setContext({ projectId: "project:a", actorId: "owner", enabled: true }); await tick(); client.dispose();
    assert.deepEqual(seen, []); assert.equal(status.at(-1)?.state, "error"); if (body.status === 403) assert.equal(status.at(-1)?.httpStatus, 403);
  }
});
