/**
 * Build the original railway protection worker used by the safety scene.
 * No textures or third-party assets: all geometry is generated here.
 * Run from any directory: node tools/build-rail-guard.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const output = new URL('../public/models/rail-safety/guard.gltf', import.meta.url);
const materials = [
  ['High-visibility orange vest', [0.98, 0.25, 0.025, 1], 0.84],
  ['Navy workwear', [0.025, 0.07, 0.16, 1], 0.92],
  ['Yellow safety helmet', [1, 0.72, 0.025, 1], 0.48],
  ['Reflective silver tape', [0.91, 0.96, 0.90, 1], 0.32],
  ['Skin', [0.72, 0.43, 0.27, 1], 0.90],
  ['Boots, eyes and belt', [0.028, 0.032, 0.04, 1], 0.83],
  ['Red signal flag', [0.93, 0.025, 0.025, 1], 0.90],
  ['Flag staff', [0.60, 0.38, 0.15, 1], 0.87],
];
const pieces = materials.map(() => []);

function add(material, geometry, center = [0, 0, 0], rotation = null) {
  if (rotation) geometry.applyQuaternion(rotation);
  geometry.translate(...center);
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.deleteAttribute('uv');
  pieces[material].push(flat);
}

function box(material, center, size) {
  add(material, new THREE.BoxGeometry(...size), center);
}

function ellipsoid(material, center, radii, segments = 12, rings = 8) {
  const geometry = new THREE.SphereGeometry(1, segments, rings);
  geometry.scale(...radii);
  add(material, geometry, center);
}

function limb(material, from, to, bottomRadius, topRadius = bottomRadius, segments = 10) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const delta = end.clone().sub(start);
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), delta.clone().normalize(),
  );
  add(material, new THREE.CylinderGeometry(topRadius, bottomRadius, delta.length(), segments),
    start.add(end).multiplyScalar(0.5).toArray(), rotation);
}

function torso(material, yBottom, yTop, widthBottom, widthTop, depth) {
  // CCW outward-facing triangles, so no double-sided materials are needed.
  const vertices = [
    -widthBottom / 2, yBottom, -depth / 2, widthBottom / 2, yBottom, -depth / 2,
    widthTop / 2, yTop, -depth / 2, -widthTop / 2, yTop, -depth / 2,
    -widthBottom / 2, yBottom, depth / 2, widthBottom / 2, yBottom, depth / 2,
    widthTop / 2, yTop, depth / 2, -widthTop / 2, yTop, depth / 2,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  ]);
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  add(material, flat);
}

// Feet sit exactly on Y=0. The slightly offset toes identify forward (+Z).
for (const side of [-1, 1]) {
  const x = side * 0.105;
  box(5, [x, 0.075, 0.045], [0.155, 0.15, 0.29]);
  box(5, [x, 0.025, 0.045], [0.167, 0.05, 0.305]);
  limb(1, [x, 0.15, 0.006], [x, 0.51, 0], 0.068, 0.077);
  limb(1, [x, 0.50, 0], [side * 0.092, 0.94, 0], 0.075, 0.095);
  ellipsoid(1, [x, 0.52, 0.018], [0.077, 0.086, 0.076], 10, 6);
}
box(1, [0, 0.955, 0], [0.355, 0.19, 0.255]);
torso(1, 1.00, 1.445, 0.325, 0.455, 0.258);
torso(0, 1.015, 1.435, 0.345, 0.458, 0.274);
box(5, [0, 1.015, 0], [0.352, 0.041, 0.284]);
box(3, [0, 1.017, 0.147], [0.052, 0.037, 0.01]);

// Tape is actual geometry and remains visible in untextured or distant views.
for (const z of [-0.140, 0.140]) {
  box(3, [0, 1.13, z], [0.383, 0.038, 0.007]);
  box(3, [-0.125, 1.307, z], [0.033, 0.224, 0.008]);
  box(3, [0.125, 1.307, z], [0.033, 0.224, 0.008]);
}
box(1, [0, 1.282, 0.143], [0.015, 0.289, 0.009]);
box(0, [-0.091, 1.196, 0.151], [0.074, 0.061, 0.018]);
box(0, [0.091, 1.196, 0.151], [0.074, 0.061, 0.018]);
box(3, [-0.091, 1.228, 0.162], [0.075, 0.012, 0.006]);
box(3, [0.091, 1.228, 0.162], [0.075, 0.012, 0.006]);

// Left arm relaxed; right arm bent forward and outward to hold a signal flag.
ellipsoid(1, [-0.245, 1.366, 0], [0.081, 0.097, 0.083]);
limb(1, [-0.252, 1.38, 0], [-0.317, 1.16, 0.02], 0.078, 0.064);
limb(1, [-0.317, 1.16, 0.02], [-0.347, 0.974, 0.05], 0.060, 0.046);
ellipsoid(4, [-0.350, 0.941, 0.06], [0.049, 0.064, 0.042]);
ellipsoid(1, [0.245, 1.366, 0], [0.081, 0.097, 0.083]);
limb(1, [0.251, 1.38, 0], [0.335, 1.15, 0.025], 0.078, 0.064);
ellipsoid(1, [0.334, 1.15, 0.025], [0.062, 0.062, 0.062], 10, 6);
limb(1, [0.335, 1.15, 0.025], [0.456, 1.268, 0.105], 0.057, 0.046);
ellipsoid(4, [0.466, 1.284, 0.110], [0.046, 0.053, 0.043]);
limb(7, [0.468, 1.245, 0.105], [0.468, 1.742, 0.105], 0.009, 0.009, 8);
box(6, [0.579, 1.627, 0.105], [0.226, 0.19, 0.009]);

// Neck, head and simple readable facial features. Nose points along local +Z.
limb(4, [0, 1.411, 0], [0, 1.523, 0], 0.058);
ellipsoid(4, [0, 1.590, 0.008], [0.112, 0.144, 0.105], 14, 10);
ellipsoid(4, [-0.111, 1.584, 0], [0.018, 0.034, 0.026], 8, 6);
ellipsoid(4, [0.111, 1.584, 0], [0.018, 0.034, 0.026], 8, 6);
ellipsoid(4, [0, 1.585, 0.112], [0.023, 0.033, 0.033], 8, 6);
for (const x of [-0.043, 0.043]) {
  ellipsoid(5, [x, 1.622, 0.103], [0.010, 0.012, 0.006], 8, 6);
}
box(5, [0, 1.536, 0.101], [0.036, 0.005, 0.005]);

// Helmet shell + brim + raised central reinforcing ridge.
const helmet = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
helmet.scale(0.145, 0.112, 0.138);
add(2, helmet, [0, 1.687, 0]);
const brim = new THREE.CylinderGeometry(1, 1, 0.022, 20);
brim.scale(0.159, 1, 0.164);
add(2, brim, [0, 1.687, 0.016]);
ellipsoid(2, [0, 1.788, 0], [0.018, 0.014, 0.080], 8, 6);
box(5, [0, 1.668, -0.087], [0.15, 0.012, 0.033]);

const chunks = [];
const bufferViews = [];
const accessors = [];
const primitives = [];
let byteLength = 0;
let triangleCount = 0;
const bounds = new THREE.Box3();

function attribute(array, type, target, min, max) {
  const buffer = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const padding = (4 - byteLength % 4) % 4;
  if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
  const bufferView = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.length, target });
  chunks.push(buffer);
  byteLength += buffer.length;
  const accessor = { bufferView, componentType: 5126, count: array.length / 3, type };
  if (min) accessor.min = min;
  if (max) accessor.max = max;
  accessors.push(accessor);
  return accessors.length - 1;
}

for (let material = 0; material < pieces.length; material++) {
  const geometry = mergeGeometries(pieces[material], false);
  geometry.computeBoundingBox();
  bounds.union(geometry.boundingBox);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  // Check geometry before serializing; catches NaNs, invalid normals and winding.
  for (let i = 0; i < position.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(position, i);
    const n = new THREE.Vector3().fromBufferAttribute(normal, i);
    if (![...p.toArray(), ...n.toArray()].every(Number.isFinite) || Math.abs(n.length() - 1) > 0.001) {
      throw new Error(`Invalid position/normal in material ${material}, vertex ${i}`);
    }
  }
  for (let i = 0; i < position.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(position, i);
    const b = new THREE.Vector3().fromBufferAttribute(position, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(position, i + 2);
    const face = b.sub(a).cross(c.sub(a));
    const n = new THREE.Vector3().fromBufferAttribute(normal, i);
    if (face.lengthSq() > 1e-14 && face.dot(n) < -1e-9) throw new Error(`Reversed winding in material ${material}`);
  }
  const positions = attribute(position.array, 'VEC3', 34962, geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray());
  const normals = attribute(normal.array, 'VEC3', 34962);
  primitives.push({ attributes: { POSITION: positions, NORMAL: normals }, material, mode: 4 });
  triangleCount += position.count / 3;
}
const binary = Buffer.concat(chunks);
const gltf = {
  asset: { version: '2.0', generator: 'Cesium railway safety platform: tools/build-rail-guard.mjs', copyright: 'Original procedural geometry created for this project; no third-party model assets.' },
  scene: 0,
  scenes: [{ name: 'Railway protection worker', nodes: [0] }],
  nodes: [{ name: 'Guard (feet at origin, Y up, facing +Z)', mesh: 0 }],
  meshes: [{ name: 'Helmet, reflective vest, workwear and signal flag', primitives }],
  materials: materials.map(([name, color, roughness]) => ({ name, pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: name.includes('silver') ? 0.15 : 0, roughnessFactor: roughness }, doubleSided: false })),
  accessors,
  bufferViews,
  buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString('base64')}` }],
  extras: { units: 'meters', upAxis: '+Y', forwardAxis: '+Z', groundY: 0, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, triangles: triangleCount, source: 'tools/build-rail-guard.mjs' },
};

// Validate actual accessor byte ranges, not only the source geometry.
for (const accessor of accessors) {
  const view = bufferViews[accessor.bufferView];
  if (view.byteOffset % 4 || accessor.count * 3 * 4 !== view.byteLength || view.byteOffset + view.byteLength > binary.length) {
    throw new Error('Invalid glTF accessor byte range');
  }
}
if (Math.abs(bounds.min.y) > 1e-6 || bounds.max.y < 1.75 || bounds.max.y > 1.85) throw new Error('Incorrect model scale or floor origin');
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, JSON.stringify(gltf));
console.log(JSON.stringify({ file: fileURLToPath(output), triangles: triangleCount, bytes: JSON.stringify(gltf).length, bounds: gltf.extras.bounds }, null, 2));
