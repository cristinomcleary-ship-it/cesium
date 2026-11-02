// A horizontal glTF tile in a surveyed east/north/up frame for the live Cesium browser checks.
import { Cartesian3, Matrix4, Transforms } from 'cesium';
export const lon = 116.391, lat = 39.907;
const center = Cartesian3.fromDegrees(lon, lat, 50);
export const transform = Matrix4.toArray(Transforms.eastNorthUpToFixedFrame(center));
export function surface(maxEast, top, minEast = -60, halfNorth = 40, slopeEast = 0) {
  const low = top + minEast * slopeEast, high = top + maxEast * slopeEast;
  const floor = Math.min(low,high), ceiling = Math.max(low,high);
  const coordinates = new Float32Array([minEast, low, -halfNorth, maxEast, high, -halfNorth, maxEast, high, halfNorth, minEast, low, halfNorth]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);
  const binary = Buffer.concat([Buffer.from(coordinates.buffer), Buffer.from(indices.buffer)]);
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.22, 0.48, 0.31, 1] }, doubleSided: true }],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteLength: coordinates.byteLength, target: 34962 }, { buffer: 0, byteOffset: coordinates.byteLength, byteLength: indices.byteLength, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [minEast, floor, -halfNorth], max: [maxEast, ceiling, halfNorth] }, { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }],
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + binary.length, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + jsonLength);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(bytes, 28 + jsonLength);
  const box = [(maxEast + minEast) / 2, 0, (floor+ceiling)/2, (maxEast - minEast) / 2, 0, 0, 0, halfNorth, 0, 0, 0, 0.1 + (ceiling-floor)/2];
  return { glb: bytes, tileset: { asset: { version: '1.1', gltfUpAxis: 'Y' }, geometricError: 500, root: { transform, boundingVolume: { box }, geometricError: 500, refine: 'ADD', content: { uri: 'surface.glb' } } } };
}
export function dxf(name, polylines) {
  const groups = [0, 'SECTION', 2, 'ENTITIES'];
  for (const { layer, points, closed } of polylines) {
    groups.push(0, 'LWPOLYLINE', 100, 'AcDbEntity', 8, layer, 100, 'AcDbPolyline', 90, points.length, 70, closed ? 1 : 0);
    for (const [x, y, bulge] of points) {
      groups.push(10, x, 20, y);
      if (bulge !== undefined) groups.push(42,bulge);
    }
  }
  groups.push(0, 'ENDSEC', 0, 'EOF');
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(groups.join('\n') + '\n') };
}
