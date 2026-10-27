import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProjectLibrary } from "./projectLibrary.ts";
import { setManagementActor } from "./management/actorContext.ts";

async function fixture(options: { removeOwnedDirectory?: (path: string) => Promise<void>; actor?: Parameters<typeof setManagementActor>[1] } = {}) {
  await mkdir("tmp/library-unit", { recursive: true });
  const root = await mkdtemp(resolve("tmp/library-unit/case-"));
  const { actor, ...libraryOptions } = options;
  const library = createProjectLibrary(root, { ...libraryOptions, resolveTiles: path => ({ root: path, entry: join(path, "tileset.json") }) });
  const server = createServer((req, res) => { if (actor) setManagementActor(req, actor); void library.middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const url = "http://127.0.0.1:" + port + "/__library";
  const call = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url + path, { method, headers: { "X-Cesium-Library": "1", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { root, library, url, call, close: async () => { server.closeAllConnections(); await new Promise<void>((done, fail) => server.close(e => e ? fail(e) : done())); await rm(root, { recursive: true, force: true }); } };
}
function record(id: string, file: { name: string; url: string }) {
  return { version: 1, id, name: "测试资料.json", kind: "GIS", visible: true, settings: {}, files: { source: file } };
}
test("uploaded bytes, visibility and settings survive a fresh server instance; deletion is durable and scoped", async () => {
  const f = await fixture();
  try {
    const payload = '{"type":"FeatureCollection","features":[]}';
    const file = await f.call("/records/a/files/source?name=中文资料.json", "POST", payload);
    assert.equal(file.status, 200);
    assert.equal((await f.call("/records/a", "PUT", record("a", file.data))).status, 200);
    const second = await f.call("/records/b/files/source?name=other.json", "POST", payload);
    await f.call("/records/b", "PUT", record("b", second.data));
    assert.equal((await f.call("/records/a", "PATCH", { visible: false, settings: { scale: 2 } })).status, 200);
    const restarted = createProjectLibrary(f.root);
    const list = await restarted.list();
    assert.equal(list.records.length, 2);
    const a = list.records.find(r => r.id === "a")!;
    assert.equal(a.visible, false); assert.equal(a.settings.scale, 2);
    assert.equal(await (await fetch(f.url.replace("/__library", "") + a.files.source.url)).text(), payload);
    assert.equal((await f.call("/records/a", "DELETE")).status, 200);
    assert.deepEqual((await createProjectLibrary(f.root).list()).records.map(r => r.id), ["b"]);
    assert.equal((await f.call("/records/a", "PATCH", { visible: true })).status, 410);
    assert.equal((await f.call("/records/a", "PUT", record("a", file.data))).status, 410);
    assert.equal((await f.call("/records/a/files/source?name=x", "POST", "resurrection")).status, 410);
  } finally { await f.close(); }
});
test("uncommitted uploads are never presented as successful imports; missing files cannot commit", async () => {
  const f = await fixture();
  try {
    await f.call("/records/uncommitted/files/source?name=x.json", "POST", "test");
    assert.equal((await f.library.list()).records.length, 0);
    assert.equal((await f.call("/records/missing", "PUT", record("missing", { name: "x", url: "/__library/files/missing/source/x" }))).status, 400);
    assert.equal((await f.library.list()).records.length, 0);
  } finally { await f.close(); }
});
test("local tiles are copied with nested content and remain after moving the source", async () => {
  const f = await fixture();
  try {
    const source = join(f.root, "original");
    await mkdir(join(source, "Data"), { recursive: true });
    await writeFile(join(source, "tileset.json"), '{"asset":{"version":"1.0"},"root":{"content":{"uri":"Data/tile.bin"}}}');
    await writeFile(join(source, "Data/tile.bin"), Buffer.from([0, 1, 2, 255]));
    const copied = await f.call("/records/tiles/copy", "POST", { type: "tiles", path: source });
    assert.equal(copied.status, 200);
    const r = { version: 1, id: "tiles", name: "tiles", kind: "3D Tiles", visible: true, settings: { url: copied.data.url }, files: { tiles: copied.data } };
    assert.equal((await f.call("/records/tiles", "PUT", r)).status, 200);
    await rm(source, { recursive: true });
    assert.equal((await createProjectLibrary(f.root).list()).records.length, 1);
    const response = await fetch(f.url + "/files/tiles/tiles/Data/tile.bin");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0,1,2,255]));
    await f.call("/records/tiles", "DELETE");
    assert.equal((await f.library.list()).records.length, 0);
  } finally { await f.close(); }
});
test("a corrupt record is reported without erasing it or healthy records", async () => {
  const f = await fixture();
  try {
    const dir = join(f.library.root, "records/broken");
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "record.json"), "{broken");
    const list = await f.library.list();
    assert.equal(list.problems[0].id, "broken");
    assert.equal(await readFile(join(dir, "record.json"), "utf8"), "{broken");
  } finally { await f.close(); }
});
test("rejects cross-site writes and traversal; serves binary ranges correctly", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/records/a/files/source?name=x.bin", "POST", "abcdef", { Origin: "https://evil.example" })).status, 403);
    const response = await fetch(f.url + "/records/a/files/source?name=x", { method: "POST", body: "x" });
    assert.equal(response.status, 403);
    assert.equal((await f.call("/records/bad%2fpath", "DELETE")).status, 400);
    const file = await f.call("/records/a/files/source?name=x.bin", "POST", "abcdef");
    await f.call("/records/a", "PUT", record("a", file.data));
    const range = await fetch(f.url + "/files/a/source/x.bin", { headers: { Range: "bytes=1-3" } });
    assert.equal(range.status, 206); assert.equal(await range.text(), "bcd");
    const suffix = await fetch(f.url + "/files/a/source/x.bin", { headers: { Range: "bytes=-2" } });
    assert.equal(await suffix.text(), "ef");
    assert.equal((await fetch(f.url + "/files/a/source/%2e%2e%2frecord.json")).status, 400);
    assert.equal((await fetch(f.url + "/files/a/source/x.bin", { headers: { Range: "bytes=99-" } })).status, 416);
  } finally { await f.close(); }
});
test("concurrent partial updates preserve both visibility and model transform", async () => {
  const f = await fixture();
  try {
    const file = await f.call("/records/a/files/source?name=x.json", "POST", "{}");
    await f.call("/records/a", "PUT", record("a", file.data));
    await Promise.all([
      f.call("/records/a", "PATCH", { visible: false }),
      f.call("/records/a", "PATCH", { settings: { scale: 3, matrix: Array(16).fill(1) } }),
    ]);
    const a = (await createProjectLibrary(f.root).list()).records[0];
    assert.equal(a.visible, false); assert.equal(a.settings.scale, 3);
  } finally { await f.close(); }
});


test("failed physical deletion is reported, tombstoned, and recovered after restart without resurrection", async () => {
  let blocked = true;
  const f = await fixture({ removeOwnedDirectory: async path => { if (blocked) throw new Error("EBUSY"); await rm(path, { recursive: true, force: true }); } });
  try {
    const file = await f.call("/records/pending/files/source?name=data.json", "POST", "{}");
    await f.call("/records/pending", "PUT", record("pending", file.data));
    const result = await f.call("/records/pending", "DELETE");
    assert.equal(result.status, 503); assert.equal(result.data.code, "FILE_DELETE_PENDING"); assert.equal(result.data.deleted, true);
    const listing = await f.library.list();
    assert.equal(listing.records.length, 0); assert.equal(listing.problems[0].deleted, true); assert.equal(listing.problems[0].kind, "GIS");
    assert.equal(await readFile(join(f.library.root, "records/pending/source/data.json"), "utf8"), "{}");
    assert.equal((await f.call("/records/pending", "PATCH", { visible: true })).status, 410);
    blocked = false;
    assert.equal((await createProjectLibrary(f.root).list()).records.length, 0);
    await assert.rejects(readFile(join(f.library.root, "records/pending/source/data.json")), { code: "ENOENT" });
    assert.equal((await f.call("/records/pending", "DELETE")).status, 200);
  } finally { await f.close(); }
});

test("converted model deletion reclaims owned conversion bytes only after its last shared import", async () => {
  const f = await fixture();
  try {
    const job = join(f.root, ".model-cache", "job-123456"); await mkdir(job, { recursive: true });
    await writeFile(join(job, "model.glb"), "model"); await writeFile(join(job, "original.skp"), "source");
    const external = join(f.root, "user-original.skp"); await writeFile(external, "external original");
    for (const key of ["first", "second"]) {
      const copied = await f.call(`/records/${key}/copy`, "POST", { type: "model", url: "/__models/files/job-123456/model.glb" });
      assert.equal(copied.status, 200);
      assert.equal((await f.call(`/records/${key}`, "PUT", { ...record(key, copied.data), kind: "Model", files: { data: copied.data } })).status, 200);
    }
    assert.equal((await f.call("/records/first", "DELETE")).status, 200);
    assert.equal(await readFile(join(job, "original.skp"), "utf8"), "source");
    assert.equal((await f.call("/records/second", "DELETE")).status, 200);
    await assert.rejects(readFile(join(job, "original.skp")), { code: "ENOENT" });
    assert.equal(await readFile(external, "utf8"), "external original");
  } finally { await f.close(); }
});

test("delete racing stale writes remains deleted and scene view excludes deleted active IDs", async () => {
  const f = await fixture();
  try {
    const file = await f.call("/records/race/files/source?name=x.json", "POST", "{}");
    await f.call("/records/race", "PUT", record("race", file.data));
    await Promise.all([f.call("/records/race", "DELETE"), f.call("/records/race", "PATCH", { visible: true })]);
    const view = { position: [1,2,3], direction: [1,0,0], up: [0,0,1], basemap: "street", activeVideoId: "race", activeImageryId: "race" };
    assert.equal((await f.call("/view", "PUT", view)).status, 200);
    const listing = await createProjectLibrary(f.root).list();
    assert.equal(listing.records.length, 0); assert.equal(listing.view?.activeVideoId, undefined); assert.equal(listing.view?.activeImageryId, undefined);
  } finally { await f.close(); }
});


test("deleted video IDs survive successful disk cleanup and restart without inferring kinds for legacy tombstones", async () => {
  const f = await fixture();
  try {
    for (const [id, kind] of [["known-video", "Drone Video"], ["known-gis", "GIS"]]) {
      const file = await f.call(`/records/${id}/files/source?name=original.bin`, "POST", "original");
      assert.equal((await f.call(`/records/${id}`, "PUT", { ...record(id, file.data), kind })).status, 200);
      assert.equal((await f.call(`/records/${id}`, "DELETE")).status, 200);
    }
    await writeFile(join(f.library.root, "deleted", "legacy-video-name.json"), JSON.stringify({ deletedAt: "2026-10-01", cleanedAt: "2026-10-01" }));
    const restarted = createProjectLibrary(f.root);
    for (let attempt = 0; attempt < 2; attempt++) {
      const listing = await restarted.list();
      assert.deepEqual(listing.deletedVideoIds, ["known-video"]);
      assert.deepEqual(listing.problems, []); assert.deepEqual(listing.records, []);
    }
    await assert.rejects(readFile(join(f.library.root, "records", "known-video", "record.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("deleted video IDs include pending disk cleanup and remain after automatic retry succeeds", async () => {
  const f = await fixture({ removeOwnedDirectory: async () => { throw new Error("EBUSY"); } });
  try {
    const file = await f.call("/records/busy-video/files/source?name=original.mp4", "POST", "video");
    await f.call("/records/busy-video", "PUT", { ...record("busy-video", file.data), kind: "Drone Video" });
    assert.equal((await f.call("/records/busy-video", "DELETE")).status, 503);
    const pending = await f.library.list();
    assert.deepEqual(pending.deletedVideoIds, ["busy-video"]); assert.equal(pending.problems.length, 1);
    const recovered = await createProjectLibrary(f.root).list();
    assert.deepEqual(recovered.deletedVideoIds, ["busy-video"]); assert.equal(recovered.problems.length, 0);
  } finally { await f.close(); }
});

test("deleted video IDs require the same media and project scope as live video metadata", async () => {
  const actor: Parameters<typeof setManagementActor>[1] = { id: "fixture", displayName: "Fixture", roles: ["viewer"], authMode: "local-account", permissions: ["read", "files"] };
  const f = await fixture({ actor });
  try {
    const file = await f.call("/records/authorized-video/files/source?name=original.mp4", "POST", "video");
    await f.call("/records/authorized-video", "PUT", { ...record("authorized-video", file.data), kind: "Drone Video" });
    await f.call("/records/authorized-video", "DELETE");
    assert.deepEqual((await f.call("/records")).data.deletedVideoIds, []);
    actor.permissions.push("media");
    assert.deepEqual((await f.call("/records")).data.deletedVideoIds, ["authorized-video"]);
    actor.taskIds = [];
    assert.deepEqual((await f.call("/records")).data.deletedVideoIds, []);
  } finally { await f.close(); }
});
