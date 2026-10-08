import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createModelOptimizationService, inspectPublishedModel } from "./modelOptimization.ts";
import { MODEL_OPTIMIZATION_API } from "../src/safetyModelOptimizationTypes.ts";
import { modelRegistryFixture, spatialSnapshot, spatialV3Fixture } from "../src/safetySpatial.testFixtures.ts";

const bounds = { sphere: [6378137, 0, 0, 20] };
function binaryTile(): Buffer {
  const feature = Buffer.from('{"BATCH_LENGTH":0}   ');
  const json = Buffer.from('{"asset":{"version":"2.0"}}  ');
  const glb = Buffer.alloc(20 + json.length); glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(json.length, 12); glb.write("JSON", 16); json.copy(glb, 20);
  const b3dm = Buffer.alloc(28 + feature.length + glb.length); b3dm.write("b3dm"); b3dm.writeUInt32LE(1, 4); b3dm.writeUInt32LE(b3dm.length, 8);
  b3dm.writeUInt32LE(feature.length, 12); feature.copy(b3dm, 28); glb.copy(b3dm, 28 + feature.length); return b3dm;
}
async function hashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(folder: string): Promise<void> {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const file = join(folder, item.name);
      if (item.isDirectory()) await walk(file);
      else result[relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  await walk(root); return result;
}
async function fixture() {
  const allowed = resolve("tmp/model-optimization-tests"); await mkdir(allowed, { recursive: true });
  const root = await mkdtemp(join(allowed, "case-")), library = join(root, "library"), model = modelRegistryFixture();
  const record = join(library, "records", model.assetId), tiles = join(record, "tiles"); await mkdir(tiles, { recursive: true });
  const source = join(root, "source-project"), scene = join(source, "Productions", "Production_2", "Scene");
  await mkdir(scene, { recursive: true }); await mkdir(join(source, "Project files", "Block_2", "Reconstruction_1", "Tile_1", "Textured_LOD"), { recursive: true });
  await writeFile(join(source, "project.ccm"), "original photography project");
  await writeFile(join(source, "Project files", "Block_2", "Reconstruction_1", "Tile_1", "Textured_LOD", "tile.3mxb"), "original intermediate mesh cache");
  await writeFile(join(record, "record.json"), JSON.stringify({ id: model.assetId, settings: { localPath: scene } }));
  await writeFile(join(tiles, "root.json"), JSON.stringify({ asset: { version: "1.0" }, geometricError: 16,
    root: { boundingVolume: bounds, geometricError: 8, refine: "REPLACE", content: { uri: "tile.b3dm" } } }));
  await writeFile(join(tiles, "tile.b3dm"), binaryTile());
  // An existing railway and its revision must survive every check and refused operation.
  await writeFile(join(library, "safety-spatial.json"), JSON.stringify(spatialSnapshot(spatialV3Fixture("railway", "existing-railway"))));
  await writeFile(join(library, "view.json"), JSON.stringify({ original: "camera and layer preferences" }));
  const options = { libraryDataDir: library, dataDir: library, modelRegistry: [model] };
  return { root, library, record, tiles, source, model, options, close: async () => {
    assert.ok(resolve(root).startsWith(allowed + sep)); await rm(root, { recursive: true, force: true });
  } };
}

test("published inspection reads real files and reports CC project/cache without inventing a repair candidate", async () => {
  const f = await fixture();
  try {
    const before = await hashes(f.root), report = await inspectPublishedModel(f.model, f.options);
    assert.equal(report.display.status, "checked"); assert.deepEqual(report.display.issues, []);
    assert.equal(report.inventory.tilesetDocuments, 1); assert.equal(report.inventory.binaryTiles, 1);
    assert.equal(report.inventory.referencedFiles, 1); assert.deepEqual(report.inventory.geometricErrorRange, [8, 8]);
    assert.equal(report.sourceEvidence.projectLocated, true); assert.equal(report.sourceEvidence.intermediateCacheLocated, true);
    assert.equal(report.sourceEvidence.supportedEditableMeshLocated, false); assert.match(report.mesh.reason, /已找到原摄影工程/);
    assert.equal(report.mesh.status, "unavailable"); assert.equal(report.texture.status, "unavailable");
    assert.equal(report.originalReadonly, true); assert.equal(report.activeVersion, f.model.assetVersion);
    assert.deepEqual(report.candidates, []); assert.equal(report.capabilities.createGeometryCandidate, false);
    assert.equal(report.capabilities.activateCandidate, false); assert.equal(report.capabilities.rollbackCandidate, false);
    assert.deepEqual(await hashes(f.root), before);
  } finally { await f.close(); }
});

test("missing/outside references and corrupt binary headers fail the display check without touching source bytes", async () => {
  const f = await fixture();
  try {
    const bad = binaryTile(); bad.writeUInt32LE(bad.length + 4, 8); await writeFile(join(f.tiles, "bad-length.b3dm"), bad);
    const empty = Buffer.alloc(28); empty.write("b3dm"); empty.writeUInt32LE(1, 4); empty.writeUInt32LE(28, 8); await writeFile(join(f.tiles, "empty.b3dm"), empty);
    const badPayload = binaryTile(); badPayload.write("XXXX", 28 + badPayload.readUInt32LE(12)); await writeFile(join(f.tiles, "bad-payload.b3dm"), badPayload);
    await writeFile(join(f.tiles, "root.json"), JSON.stringify({ root: { boundingVolume: { sphere: [1, 2, 3, -1] }, geometricError: -1,
      refine: "INVALID", transform: [1], contents: [{ uri: "missing.b3dm" }, { uri: "../private.b3dm" }, { uri: "%ZZ" }] } }));
    const before = await hashes(f.root), report = await inspectPublishedModel(f.model, f.options);
    const kinds = new Set(report.display.issues.map(i => i.kind));
    for (const kind of ["missing-content", "reference-outside", "content-uri", "invalid-b3dm", "invalid-glb-header", "bounding-volume", "geometric-error", "transform", "refine"]) assert.ok(kinds.has(kind), kind);
    assert.equal(report.display.status, "failed"); assert.equal(report.activeVersion, f.model.assetVersion);
    assert.deepEqual(await hashes(f.root), before);
  } finally { await f.close(); }
});

test("absent or malformed tileset entry cannot be reported as a completed successful file check", async () => {
  const f = await fixture();
  try {
    for (const entry of ["{broken", "{}", '{"root":{"children":{},"boundingVolume":{"box":"not-a-box"}}}']) {
      await writeFile(join(f.tiles, "root.json"), entry);
      const before = await hashes(f.root), report = await inspectPublishedModel(f.model, f.options);
      assert.equal(report.display.status, "failed"); assert.ok(report.display.issues.length);
      assert.deepEqual(await hashes(f.root), before);
    }
    const before = await hashes(f.root), missing = await inspectPublishedModel({ ...f.model, url: f.model.url.replace("root.json", "missing.json") }, f.options);
    assert.ok(missing.display.issues.some(i => i.kind === "missing-entry")); assert.equal(missing.display.status, "failed");
    assert.deepEqual(await hashes(f.root), before);
  } finally { await f.close(); }
});

test("inspection rejects stale initial versions and versions/transforms changed during the scan", async () => {
  const f = await fixture();
  try {
    const before = await hashes(f.root), service = createModelOptimizationService(f.options);
    await assert.rejects(service.inspect(f.model.assetId, "stale"), { status: 409, code: "VERSION_CHANGED" });
    await assert.rejects(service.inspect("unknown", f.model.assetVersion), { status: 404, code: "MODEL_UNAVAILABLE" });
    for (const field of ["assetVersion", "coordinateTransformVersion"] as const) {
      let reads = 0;
      const changing = createModelOptimizationService({ ...f.options, modelRegistry: async () => [{ ...f.model, [field]: ++reads === 1 ? f.model[field] : "changed-version" }] });
      await assert.rejects(changing.inspect(f.model.assetId, f.model.assetVersion), { status: 409, code: "VERSION_CHANGED" });
    }
    assert.deepEqual(await hashes(f.root), before);
  } finally { await f.close(); }
});

test("unavailable candidate/validation/activation/rollback endpoints never report success or mutate model/business hashes", async () => {
  const f = await fixture(), service = createModelOptimizationService(f.options);
  const server = createServer((req, res) => void service.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${MODEL_OPTIMIZATION_API}`;
  try {
    const before = await hashes(f.root);
    for (const operation of ["candidate", "validate", "activate", "rollback"]) {
      const response = await fetch(`${url}/${operation}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: f.model.assetId, expectedActiveVersion: f.model.assetVersion, candidateId: "not-real" }) });
      assert.equal(response.status, 409); const error = await response.json(); assert.equal(error.code, "PIPELINE_UNAVAILABLE");
      assert.equal(error.ok, undefined);
    }
    for (const origin of ["https://unrelated.example", "null"]) {
      const response = await fetch(`${url}/inspect?assetId=${f.model.assetId}&expectedVersion=${f.model.assetVersion}`, { headers: { Origin: origin } });
      assert.equal(response.status, 403); assert.equal((await response.json()).code, "CROSS_ORIGIN");
    }
    const response = await fetch(`${url}/inspect?assetId=${f.model.assetId}&expectedVersion=${f.model.assetVersion}`);
    assert.equal(response.status, 200); assert.equal((await response.json()).activeVersion, f.model.assetVersion);
    assert.deepEqual(await hashes(f.root), before);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.close(); }
});

test("asset records cannot escape the library through directory junctions", async () => {
  const f = await fixture();
  try {
    const external = join(f.root, "outside-library"), id = "outside-model";
    await mkdir(join(external, "tiles"), { recursive: true }); await writeFile(join(external, "tiles", "root.json"), "{}");
    await symlink(external, join(f.library, "records", id), "junction");
    const before = await hashes(f.root);
    await assert.rejects(inspectPublishedModel({ ...f.model, assetId: id }, f.options), { status: 400, code: "INVALID_PATH" });
    assert.deepEqual(await hashes(f.root), before);
  } finally { await f.close(); }
});

test("empty project folders do not count as located intermediate mesh evidence", async () => {
  const f = await fixture();
  try {
    await rm(join(f.source, "Project files", "Block_2", "Reconstruction_1", "Tile_1", "Textured_LOD", "tile.3mxb"));
    const before = await hashes(f.root), report = await inspectPublishedModel(f.model, f.options);
    assert.equal(report.sourceEvidence.projectLocated, true);
    assert.equal(report.sourceEvidence.intermediateCacheLocated, false);
    assert.deepEqual(await hashes(f.root), before);
  } finally { await f.close(); }
});
