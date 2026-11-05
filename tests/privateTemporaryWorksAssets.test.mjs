import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bundleFilename, inspectBundle, installBundle, validateManifest } from '../tools/install-temporary-works-assets.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Self-contained synthetic fixtures only; no supplied model or private geometry.
function syntheticGlb(extra = {}) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, ...extra }));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(20 + paddedLength, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedLength, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'private-assets-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'installed');
  await mkdir(source);
  const glb = options.glb ?? syntheticGlb();
  const logo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const manifest = {
    schemaVersion: 1, unit: 'metre',
    assets: ['camp', 'steel', 'wall'].map(id => ({
      id, name: id, url: `models/temporary-works/${id}.glb`, upAxis: 'Y',
      bounds: { min: [0, 0, 0], max: [2, 3, 4] }, anchor: [1, 0, 2],
      dimensions: { length: 2, width: 4, height: 3 }, baseHeight: 0,
      footprints: [{ outer: [[0, 0], [2, 0], [2, 4], [0, 4]], holes: [] }],
      bytes: glb.length, sha256: digest(glb),
    })),
    logo: { url: 'models/temporary-works/cr24-logo.png', bytes: logo.length, sha256: digest(logo) },
  };
  for (const asset of manifest.assets) await writeFile(join(source, `${asset.id}.glb`), glb);
  await writeFile(join(source, 'cr24-logo.png'), logo);
  const saveManifest = async () => writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest();
  return { root, source, destination, glb, logo, manifest, saveManifest };
}

test('installs only validated references, verifies checksums and preserves unrelated destination files', async t => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(join(f.destination, 'keep.txt'), 'existing user file');
  await writeFile(join(f.source, 'unreferenced.bin'), 'must not be copied');
  const first = await installBundle(f.source, f.destination);
  assert.equal(first.installed, 5); assert.equal(first.verified, true);
  assert.deepEqual((await readdir(f.destination)).sort(), ['camp.glb', 'cr24-logo.png', 'keep.txt', 'manifest.json', 'steel.glb', 'wall.glb']);
  assert.equal(await readFile(join(f.destination, 'keep.txt'), 'utf8'), 'existing user file');
  assert.equal((await inspectBundle(f.destination)).files.length, 5);
  const repeated = await installBundle(f.source, f.destination);
  assert.equal(repeated.installed, 0); assert.equal(repeated.unchanged, 5);
});

test('different existing asset or manifest prevents all writes and preserves old files', async t => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(join(f.destination, 'wall.glb'), 'old private bytes');
  await assert.rejects(installBundle(f.source, f.destination), /Existing file differs and was preserved/);
  assert.deepEqual(await readdir(f.destination), ['wall.glb']);
  assert.equal(await readFile(join(f.destination, 'wall.glb'), 'utf8'), 'old private bytes');
});

test('corrupt GLB or logo integrity stops installation before creating the destination', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'cr24-logo.png'), Buffer.from('corrupt'));
  await assert.rejects(installBundle(f.source, f.destination), /byte count or SHA-256 mismatch/);
  await assert.rejects(readdir(f.destination), { code: 'ENOENT' });
});

test('rejects remote, absolute, encoded, nested and traversal asset locations', () => {
  for (const url of ['https://example.test/camp.glb', '//example.test/camp.glb', '/camp.glb', '../camp.glb',
    'models/temporary-works/../camp.glb', 'models/temporary-works/%2e%2e/camp.glb', 'folder/camp.glb',
    'models/temporary-works/camp.glb?query=1', 'C:\\private\\camp.glb', '..\\camp.glb', 'camp%2eglb']) {
    assert.throws(() => bundleFilename(url, '.glb'), /Unsafe/);
  }
  assert.equal(bundleFilename('models/temporary-works/camp.glb', '.glb'), 'camp.glb');
});

test('rejects duplicate resource ids, missing metadata, wrong unit and wrong axis', async t => {
  const f = await fixture(t);
  for (const change of [
    m => { m.assets[1].id = 'camp'; }, m => { m.assets.pop(); }, m => { delete m.logo; },
    m => { m.unit = 'millimetre'; }, m => { m.assets[0].upAxis = 'Z'; },
    m => { m.assets[0].bytes = -1; }, m => { m.assets[0].sha256 = ''; },
    m => { m.logo.url = 'https://example.test/logo.png'; },
  ]) {
    const changed = structuredClone(f.manifest); change(changed);
    assert.throws(() => validateManifest(changed));
  }
});

test('rejects invalid Y-up dimensions, bottom anchor and footprint data', async t => {
  const f = await fixture(t);
  for (const change of [
    a => { a.dimensions.width = 3; }, a => { a.anchor[1] = 5; }, a => { a.anchor[0] = NaN; },
    a => { a.bounds.max[1] = 0; }, a => { a.baseHeight = 1; },
    a => { a.footprints[0].outer = [[0, 0], [1, 0], [2, 0]]; },
    a => { a.footprints[0].outer[0] = [-1, 0]; }, a => { a.footprints[0].holes = {}; },
  ]) {
    const changed = structuredClone(f.manifest); change(changed.assets[0]);
    assert.throws(() => validateManifest(changed));
  }
});

test('rejects bad GLB magic even when checksum metadata matches', async t => {
  const glb = syntheticGlb(); glb.writeUInt32LE(0, 0);
  const f = await fixture(t, { glb });
  await assert.rejects(installBundle(f.source, f.destination), /invalid GLB 2.0 header/);
  await assert.rejects(readdir(f.destination), { code: 'ENOENT' });
});

test('rejects embedded external resources so a valid checksum cannot import a remote dependency', async t => {
  const f = await fixture(t, { glb: syntheticGlb({ images: [{ uri: 'https://example.test/texture.png' }] }) });
  await assert.rejects(inspectBundle(f.source), /external or URI-based resources/);
});

test('rejects source file and destination directory symlinks without altering their targets', async t => {
  const f = await fixture(t);
  const external = join(f.root, 'external.glb');
  await writeFile(external, f.glb);
  await rm(join(f.source, 'camp.glb'));
  await symlink(external, join(f.source, 'camp.glb'));
  await assert.rejects(installBundle(f.source, f.destination), /Symbolic links are not allowed/);
  await rm(join(f.source, 'camp.glb')); await writeFile(join(f.source, 'camp.glb'), f.glb);
  const externalDirectory = join(f.root, 'other'); await mkdir(externalDirectory);
  await symlink(externalDirectory, f.destination);
  await assert.rejects(installBundle(f.source, f.destination), /Symbolic links are not allowed/);
  assert.deepEqual(await readdir(externalDirectory), []);
  assert.deepEqual(await readFile(external), f.glb);
});
