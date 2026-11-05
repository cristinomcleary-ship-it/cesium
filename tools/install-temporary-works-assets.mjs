// Installs a privately supplied, audited asset bundle. Contains no model content.
// node tools/install-temporary-works-assets.mjs --from /private/bundle
// node tools/install-temporary-works-assets.mjs --check [--to /deployment/public/models/temporary-works]
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../public/models/temporary-works');
const expectedIds = ['camp', 'steel', 'wall'];
const prefix = 'models/temporary-works/';
const fail = message => { throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const finiteArray = (value, count) => Array.isArray(value) && value.length === count && value.every(Number.isFinite);

/** Restrict every asset to a simple filename in this bundle, never a URL or nested path. */
export function bundleFilename(url, extension) {
  if (typeof url !== 'string') fail('Asset URL must be a local bundle filename.');
  const name = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || !name.endsWith(extension)) {
    fail(`Unsafe or unsupported bundle path: ${url}`);
  }
  return name;
}

function integrityMetadata(entry, label) {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
    fail(`${label}: positive byte count and lowercase SHA-256 are required.`);
  }
}

function validateGeometryMetadata(asset) {
  if (asset.upAxis !== 'Y') fail(`${asset.id}: this private bundle must declare Y-up.`);
  if (!finiteArray(asset.anchor, 3) || !finiteArray(asset.bounds?.min, 3) || !finiteArray(asset.bounds?.max, 3)) {
    fail(`${asset.id}: finite anchor and bounds triples are required.`);
  }
  const size = asset.bounds.max.map((value, i) => value - asset.bounds.min[i]);
  if (size.some(value => value <= 0)) fail(`${asset.id}: bounds must have positive extent.`);
  for (const [name, axis] of [['length', 0], ['width', 2], ['height', 1]]) {
    const dimension = asset.dimensions?.[name];
    if (!Number.isFinite(dimension) || dimension <= 0 || dimension >= 100000
      || Math.abs(dimension - size[axis]) > Math.max(1e-5, size[axis] * 1e-5)) {
      fail(`${asset.id}: ${name} must match its metre-based Y-up bounds.`);
    }
  }
  if (asset.anchor.some((value, i) => value < asset.bounds.min[i] - 1e-5 || value > asset.bounds.max[i] + 1e-5)) {
    fail(`${asset.id}: bottom anchor lies outside the audited bounds.`);
  }
  if (asset.baseHeight !== undefined && (!Number.isFinite(asset.baseHeight) || Math.abs(asset.baseHeight - asset.anchor[1]) > 1e-5)) {
    fail(`${asset.id}: baseHeight must match the Y-up anchor height.`);
  }
  if (!Array.isArray(asset.footprints) || !asset.footprints.length) fail(`${asset.id}: audited footprints are required.`);
  for (const footprint of asset.footprints) {
    if (footprint.holes !== undefined && !Array.isArray(footprint.holes)) fail(`${asset.id}: invalid footprint holes.`);
    for (const ring of [footprint.outer, ...(footprint.holes ?? [])]) {
      if (!Array.isArray(ring) || ring.length < 3 || ring.some(point => !finiteArray(point, 2))) {
        fail(`${asset.id}: footprint rings must contain finite X,Z pairs.`);
      }
      const area = ring.reduce((sum, point, i) => {
        const next = ring[(i + 1) % ring.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) / 2;
      if (!Number.isFinite(area) || Math.abs(area) < 1e-10) fail(`${asset.id}: degenerate footprint ring.`);
      if (ring.some(point => [0, 2].some((axis, i) => point[i] < asset.bounds.min[axis] - 1e-4 || point[i] > asset.bounds.max[axis] + 1e-4))) {
        fail(`${asset.id}: footprint extends outside the audited bounds.`);
      }
    }
  }
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.unit !== 'metre' || !Array.isArray(manifest.assets)
    || JSON.stringify(manifest.assets.map(asset => asset?.id).sort()) !== JSON.stringify(expectedIds)) {
    fail('Manifest must use schemaVersion 1, unit metre, and exactly camp, steel and wall.');
  }
  const files = [];
  for (const asset of manifest.assets) {
    validateGeometryMetadata(asset);
    integrityMetadata(asset, asset.id);
    const filename = bundleFilename(asset.url, '.glb');
    if (asset.url !== prefix + filename) fail(`${asset.id}: URL must use the platform models/temporary-works/ prefix.`);
    files.push({ filename, entry: asset, kind: 'glb' });
  }
  if (!manifest.logo || typeof manifest.logo !== 'object') fail('Manifest logo metadata (url, bytes, sha256) is required.');
  integrityMetadata(manifest.logo, 'logo');
  const logoFilename = bundleFilename(manifest.logo.url, '.png');
  if (logoFilename !== 'cr24-logo.png' || manifest.logo.url !== prefix + logoFilename) fail('The current platform requires models/temporary-works/cr24-logo.png.');
  files.push({ filename: logoFilename, entry: manifest.logo, kind: 'png' });
  if (new Set(files.map(file => file.filename)).size !== files.length) fail('Bundle filenames must be unique.');
  return files;
}

/** Structural checks only. Decoded geometry and appearance still require the audit and browser acceptance. */
export function validateGlb(bytes, label) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length) fail(`${label}: invalid GLB 2.0 header or declared length.`);
  let offset = 12, json, binaryLength = 0, chunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail(`${label}: truncated GLB chunk header.`);
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > bytes.length) fail(`${label}: invalid GLB chunk length.`);
    if (chunks === 0) {
      if (type !== 0x4e4f534a) fail(`${label}: first GLB chunk must be JSON.`);
      try { json = JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')); }
      catch { fail(`${label}: invalid GLB JSON.`); }
    } else if (type === 0x004e4942 && chunks === 1) binaryLength = length;
    else fail(`${label}: unexpected GLB chunk.`);
    offset += length;
    chunks++;
  }
  if (json?.asset?.version !== '2.0') fail(`${label}: glTF asset.version must be 2.0.`);
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (entry.uri !== undefined) fail(`${label}: external or URI-based resources are not permitted in this self-contained GLB bundle.`);
  }
  if (json.buffers?.length) {
    if (json.buffers.length !== 1 || !Number.isSafeInteger(json.buffers[0].byteLength) || json.buffers[0].byteLength < 0
      || binaryLength < json.buffers[0].byteLength || binaryLength - json.buffers[0].byteLength > 3) {
      fail(`${label}: embedded binary buffer length is inconsistent.`);
    }
  }
}

async function rejectSymlinks(path, allowMissing = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail(`Symbolic links are not allowed: ${current}`);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function readRegularFile(path) {
  await rejectSymlinks(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) fail(`Expected a regular file: ${path}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function inspectBundle(directory) {
  directory = resolve(directory);
  await rejectSymlinks(directory);
  if (!(await lstat(directory)).isDirectory()) fail('Bundle source must be a directory.');
  const manifestBytes = await readRegularFile(join(directory, 'manifest.json'));
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('manifest.json is not valid JSON.'); }
  const metadata = validateManifest(manifest), files = [];
  for (const file of metadata) {
    const bytes = await readRegularFile(join(directory, file.filename));
    if (bytes.length !== file.entry.bytes || sha256(bytes) !== file.entry.sha256) fail(`${file.filename}: byte count or SHA-256 mismatch.`);
    if (file.kind === 'glb') validateGlb(bytes, file.filename);
    else if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(`${file.filename}: invalid PNG signature.`);
    files.push({ filename: file.filename, bytes });
  }
  // Install the manifest last, after every referenced resource is available.
  files.push({ filename: 'manifest.json', bytes: manifestBytes });
  return { directory, manifest, files };
}

export async function installBundle(source, destination = defaultDirectory) {
  const bundle = await inspectBundle(source);
  destination = resolve(destination);
  await rejectSymlinks(destination, true);
  const missing = [];
  for (const file of bundle.files) {
    const path = join(destination, file.filename);
    try {
      const current = await readRegularFile(path);
      if (!current.equals(file.bytes)) fail(`Existing file differs and was preserved: ${path}. Use a new isolated deployment directory or back up and move the existing bundle yourself.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(file);
    }
  }
  await mkdir(destination, { recursive: true });
  await rejectSymlinks(destination);
  let installed = 0;
  for (const file of missing) {
    const path = join(destination, file.filename);
    // Exclusive creation also protects files created after the collision preflight.
    try { await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 }); installed++; }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await readRegularFile(path)).equals(file.bytes)) throw error;
    }
  }
  return { directory: destination, verified: true, installed, unchanged: bundle.files.length - installed,
    assets: expectedIds, files: bundle.files.map(file => ({ name: file.filename, bytes: file.bytes.length, sha256: sha256(file.bytes) })) };
}

export async function main(args = process.argv.slice(2)) {
  let source, destination = defaultDirectory, check = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--help') {
      console.log('Usage: node tools/install-temporary-works-assets.mjs (--from DIRECTORY | --check) [--to DIRECTORY]\nCopies only a validated private bundle. Different existing files are never overwritten.');
      return;
    }
    if (option === '--check') { check = true; continue; }
    if (!['--from', '--to'].includes(option) || !args[i + 1] || args[i + 1].startsWith('--')) fail(`Unknown or incomplete option: ${option}`);
    if (option === '--from') source = args[++i]; else destination = args[++i];
  }
  if (check === Boolean(source)) fail('Specify exactly one of --from DIRECTORY or --check.');
  if (check) {
    const bundle = await inspectBundle(destination);
    console.log(JSON.stringify({ directory: bundle.directory, verified: true, assets: expectedIds, files: bundle.files.length }, null, 2));
  } else console.log(JSON.stringify(await installBundle(source, destination), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Private asset installation failed: ${error.message}`); process.exitCode = 1; });
}
