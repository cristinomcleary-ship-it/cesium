// Synthetic test geometry only. No site coordinates, uploaded CAD or private model data.
export const syntheticOrigin = Object.freeze({ longitude: 121, latitude: 31, height: 0 });
export const syntheticRoadPoints = Object.freeze([[-65, -35], [-15, -35], [20, -10], [65, -10]]);

export function syntheticRoadDxf() {
  return ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'DEMO_ROAD',
    '90', String(syntheticRoadPoints.length), '70', '0',
    ...syntheticRoadPoints.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
    '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}

function documentFor(primitives, materials) {
  const chunks = [], bufferViews = [], accessors = [];
  let size = 0;
  const meshes = primitives.map(primitive => {
    const attributes = {};
    for (const [name, array] of [['POSITION', primitive.positions], ['NORMAL', primitive.normals]]) {
      if (!array) continue;
      const values = new Float32Array(array), bytes = new Uint8Array(values.buffer);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      values.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v); });
      bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length });
      chunks.push(bytes); size += bytes.length;
      attributes[name] = accessors.length;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / 3, type: 'VEC3', min, max });
    }
    return { attributes, material: primitive.material };
  });
  // This function runs in Node, while the DXF function is also imported by the page.
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const base64 = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
  return {
    asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_unlit', 'KHR_materials_pbrSpecularGlossiness'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: meshes }],
    buffers: [{ uri: `data:application/octet-stream;base64,${base64}`, byteLength: size }], bufferViews, accessors, materials,
  };
}

export function syntheticGround() {
  const groups = [0, 1].map(material => ({ positions: [], normals: [], material }));
  for (let x = -160; x < 160; x += 20) for (let y = -160; y < 160; y += 20) {
    const group = groups[(x / 20 + y / 20 + 16) % 2];
    const vertices = [[x, y, 0], [x + 20, y, 0], [x + 20, y + 20, 0], [x, y + 20, 0]];
    for (const i of [0, 1, 2, 0, 2, 3]) { group.positions.push(...vertices[i]); group.normals.push(0, 0, 1); }
  }
  return documentFor(groups, [[.24, .42, .27, 1], [.38, .49, .29, 1]].map(baseColorFactor => ({
    pbrMetallicRoughness: { baseColorFactor, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} },
  })));
}

export function syntheticMaterials() {
  const faces = [
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[0, 1, 0], [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]]],
  ];
  const primitives = Array.from({ length: 5 }, (_, material) => {
    const positions = [], normals = [];
    for (const [normal, vertices] of faces) for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(vertices[i][0] * 8 + (material - 2) * 12 - 4, vertices[i][1] * 8 - 4, vertices[i][2] * 12);
      normals.push(...normal);
    }
    return { positions, normals: material === 4 ? undefined : normals, material };
  });
  return documentFor(primitives, [
    { pbrMetallicRoughness: { baseColorFactor: [.8, .8, .8, 1], metallicFactor: 0, roughnessFactor: .65 } },
    { pbrMetallicRoughness: { baseColorFactor: [.7, .02, .015, 1], metallicFactor: .1, roughnessFactor: .5 } },
    { extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseFactor: [.02, .6, .02, 1], specularFactor: [.1, .1, .1], glossinessFactor: .4 } } },
    { alphaMode: 'BLEND', doubleSided: true, extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseFactor: [.8, .6, .02, .55], specularFactor: [.15, .15, .15], glossinessFactor: .6 } } },
    { pbrMetallicRoughness: { baseColorFactor: [.01, .03, .75, 1], metallicFactor: 0, roughnessFactor: 1 } },
  ]);
}

export function syntheticTileset(Cesium) {
  const { longitude, latitude, height } = syntheticOrigin;
  const transform = Cesium.Matrix4.toArray(Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(longitude, latitude, height)));
  // The tileset error describes omitting the entire ground. A zero value makes
  // Cesium stop before requesting even this leaf tile at preview distances.
  return { asset: { version: '1.1', gltfUpAxis: 'Z' }, geometricError: 1000, root: {
    boundingVolume: { box: [0, 0, 0, 165, 0, 0, 0, 165, 0, 0, 0, 1] }, geometricError: 0,
    transform, content: { uri: 'ground.gltf' },
  } };
}
