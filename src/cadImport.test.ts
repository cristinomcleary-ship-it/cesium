import assert from 'node:assert/strict';
import test from 'node:test';
import type { DwgDatabase } from '@mlightcad/libredwg-web';
import { expandCadDatabase, type CadPoint } from './cadImport.ts';

type RawEntity = Record<string, unknown>;
const entity = (type: string, fields: RawEntity): RawEntity => ({ type, layer: '0', colorIndex: 256, ...fields });
function expand(entities: RawEntity[], blocks: RawEntity[] = []) {
  return expandCadDatabase({ entities, tables: { BLOCK_RECORD: { entries: blocks }, LAYER: { entries: [] } } } as unknown as DwgDatabase).entities;
}
function close(actual: CadPoint, expected: CadPoint, tolerance = 1e-9) {
  for (const key of ['x', 'y', 'z'] as const) assert.ok(Math.abs((actual[key] ?? 0) - (expected[key] ?? 0)) < tolerance,
    `${key}: ${actual[key]} != ${expected[key]}`);
}

test('default +Z and absent OCS preserve existing planar CAD exactly', () => {
  const sources = [
    entity('CIRCLE', { center: { x: 3, y: 4, z: 5 }, radius: 2 }),
    entity('LWPOLYLINE', { elevation: 8, vertices: [{ x: 1, y: 2, bulge: 0.5 }, { x: 3, y: 4 }] }),
    entity('LINE', { startPoint: { x: 1, y: 2, z: 3 }, endPoint: { x: 4, y: 5, z: 6 } }),
  ];
  assert.deepEqual(expand(sources), expand(sources.map(source => ({ ...source, extrusionDirection: { x: 0, y: 0, z: 1 } }))));
});

test('circles and arcs use their OCS plane and elevation', () => {
  const sources = ['CIRCLE', 'ARC'].map(type => entity(type, {
    center: { x: 0, y: 0, z: 4 }, radius: 10, startAngle: 0, endAngle: Math.PI,
    extrusionDirection: { x: 0, y: 2, z: 0 }, // A nonunit normal still defines the same plane.
  }));
  for (const output of expand(sources)) {
    close(output.vertices[0], { x: -10, y: 4, z: 0 });
    for (const vertex of output.vertices) {
      assert.ok(Math.abs(vertex.y - 4) < 1e-9);
      assert.ok(Math.abs(Math.hypot(vertex.x, vertex.z ?? 0) - 10) < 1e-9);
    }
    assert.ok(output.vertices.some(vertex => Math.abs((vertex.z ?? 0) - 10) < 1e-9));
  }
});

test('2D polyline bulges are interpolated in OCS before conversion', () => {
  for (const type of ['LWPOLYLINE', 'POLYLINE2D']) {
    const output = expand([entity(type, {
      elevation: 3, vertices: [{ x: -10, y: 0, bulge: 1 }, { x: 10, y: 0 }],
      extrusionDirection: { x: 0, y: 1, z: 0 },
    })])[0];
    close(output.vertices[0], { x: 10, y: 3, z: 0 });
    close(output.vertices.at(-1)!, { x: -10, y: 3, z: 0 });
    assert.ok(output.vertices.length > 2);
    for (const vertex of output.vertices) assert.ok(Math.abs(vertex.y - 3) < 1e-9);
    assert.ok(output.vertices.some(vertex => Math.abs(vertex.z ?? 0) > 9));
  }
});

test('POLYLINE2D parent elevation overrides explicit zero vertex Z before OCS conversion', () => {
  // Matches LibreDWG convertPolyline2d: vertex.point.z is explicitly emitted.
  const vertices = [{ x: 1, y: 2, z: 0 }, { x: 3, y: 4, z: 0 }];
  const source = entity('POLYLINE2D', { elevation: 12, vertices });
  assert.deepEqual(expand([source])[0].vertices, [{ x: 1, y: 2, z: 12 }, { x: 3, y: 4, z: 12 }]);
  assert.deepEqual(expand([{ ...source, extrusionDirection: { x: 0, y: 1, z: 0 } }])[0].vertices,
    [{ x: -1, y: 12, z: 2 }, { x: -3, y: 12, z: 4 }]);
  const spatialVertices = [{ x: 1, y: 2, z: 7 }, { x: 3, y: 4, z: 9 }];
  const spatial = entity('POLYLINE3D', { elevation: 12, vertices: spatialVertices, extrusionDirection: { x: 0, y: 1, z: 0 } });
  assert.deepEqual(expand([spatial])[0].vertices, spatialVertices);
  assert.deepEqual(vertices, [{ x: 1, y: 2, z: 0 }, { x: 3, y: 4, z: 0 }]);
});

test('negative Z OCS mirrors planar geometry and converts text and face points', () => {
  const normal = { x: 0, y: 0, z: -1 };
  const text = expand(['TEXT', 'ATTRIB', 'ATTDEF'].map(type => entity(type, {
    startPoint: { x: 2, y: 3, z: 4 }, text: '标注', extrusionDirection: normal,
  })));
  for (const output of text) close(output.vertices[0], { x: -2, y: 3, z: -4 });
  for (const type of ['SOLID', 'TRACE']) {
    const output = expand([entity(type, {
      corner1: { x: 1, y: 2, z: 4 }, corner2: { x: 3, y: 2, z: 4 },
      corner3: { x: 1, y: 5, z: 4 }, corner4: { x: 3, y: 5, z: 4 }, extrusionDirection: normal,
    })])[0];
    assert.deepEqual(output.vertices, [{ x: -1, y: 2, z: -4 }, { x: -3, y: 2, z: -4 }, { x: -3, y: 5, z: -4 }, { x: -1, y: 5, z: -4 }]);
  }
});

test('WCS entities retain their 3D coordinates even with nondefault extrusion', () => {
  const points = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }];
  const sources = [
    entity('LINE', { startPoint: points[0], endPoint: points[1] }),
    entity('POLYLINE3D', { vertices: points }),
    entity('3DFACE', { corner1: points[0], corner2: points[1], corner3: points[2] }),
    entity('POINT', { position: points[0] }),
    entity('SPLINE', { fitPoints: points }),
    entity('MTEXT', { insertionPoint: points[0], text: '多行文字' }),
  ];
  assert.deepEqual(expand(sources), expand(sources.map(source => ({ ...source, extrusionDirection: { x: 0, y: 1, z: 0 } }))));
});

test('INSERT OCS cancels a block-local slope to restore a genuinely horizontal CAD', () => {
  // The same line is horizontal in AutoCAD: the block's -45 degree slope is
  // cancelled by its +45 degree INSERT. Ignoring INSERT OCS left it tilted.
  const s = Math.SQRT1_2;
  const block = { name: 'LEVEL', basePoint: { x: 0, y: 0, z: 0 }, entities: [entity('LINE', {
    startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 0, y: 100 * s, z: -100 * s },
  })] };
  const output = expand([entity('INSERT', {
    name: 'LEVEL', insertionPoint: { x: 0, y: 0, z: 0 }, extrusionDirection: { x: 0, y: -s, z: s },
  })], [block])[0];
  close(output.vertices[0], { x: 0, y: 0, z: 0 });
  close(output.vertices[1], { x: 0, y: 100, z: 0 });
});

test('nested INSERT normals compose after block base, scale, rotation and insertion', () => {
  const inner = entity('INSERT', {
    name: 'INNER', insertionPoint: { x: 3, y: 4, z: 5 }, xScale: 2, yScale: 3, zScale: 4,
    rotation: Math.PI / 2, extrusionDirection: { x: 0, y: 0, z: -1 },
  });
  const blocks = [
    { name: 'INNER', basePoint: { x: 1, y: 1, z: 1 }, entities: [entity('LINE', {
      startPoint: { x: 1, y: 1, z: 1 }, endPoint: { x: 2, y: 1, z: 2 },
    })] },
    { name: 'OUTER', basePoint: { x: 0, y: 0, z: 0 }, entities: [inner] },
  ];
  const output = expand([entity('INSERT', {
    name: 'OUTER', insertionPoint: { x: 10, y: 20, z: 30 }, extrusionDirection: { x: 0, y: -1, z: 0 },
  })], blocks)[0];
  close(output.vertices[0], { x: 7, y: -25, z: 24 });
  close(output.vertices[1], { x: 7, y: -21, z: 26 });
});

test('near-polar arbitrary-axis branch keeps a normalized right-handed circle plane', () => {
  const normal = { x: 0.001, y: -0.002, z: 1 };
  const output = expand([entity('CIRCLE', { center: { x: 0, y: 0, z: 0 }, radius: 10, extrusionDirection: normal })])[0];
  for (const vertex of output.vertices) {
    assert.ok(Math.abs(vertex.x * normal.x + vertex.y * normal.y + (vertex.z ?? 0) * normal.z) < 1e-9);
    assert.ok(Math.abs(Math.hypot(vertex.x, vertex.y, vertex.z ?? 0) - 10) < 1e-9);
  }
  // Near +Z, AutoCAD chooses worldY x normal, placing the first vertex on +X.
  assert.ok(output.vertices[0].x > 9.99);
  assert.ok(output.vertices[Math.floor((output.vertices.length - 1) / 4)].y > 9.99);
});

test('ellipse normal keeps WCS center and places the minor axis in its vertical plane', () => {
  const output = expand([entity('ELLIPSE', {
    center: { x: 10, y: 20, z: 30 }, majorAxisEndPoint: { x: 10, y: 0, z: 0 },
    axisRatio: 0.5, extrusionDirection: { x: 0, y: -2, z: 0 },
  })])[0];
  assert.ok(output);
  close(output.vertices[0], { x: 20, y: 20, z: 30 });
  close(output.vertices[(output.vertices.length - 1) / 4], { x: 10, y: 20, z: 35 });
  for (const vertex of output.vertices) {
    assert.ok(Math.abs(vertex.y - 20) < 1e-9);
    assert.ok(Math.abs(((vertex.x - 10) / 10) ** 2 + (((vertex.z ?? 0) - 30) / 5) ** 2 - 1) < 1e-9);
  }
});

test('oblique ellipse uses the full 3D major-axis length for its minor radius', () => {
  const output = expand([entity('ELLIPSE', {
    center: { x: 0, y: 0, z: 0 }, majorAxisEndPoint: { x: 3, y: 0, z: 4 },
    axisRatio: 0.4, extrusionDirection: { x: 0, y: -1, z: 0 },
  })])[0];
  close(output.vertices[0], { x: 3, y: 0, z: 4 });
  close(output.vertices[(output.vertices.length - 1) / 4], { x: -1.6, y: 0, z: 1.2 });
  for (const { x, y, z = 0 } of output.vertices) {
    assert.ok(Math.abs(y) < 1e-9);
    const majorCoordinate = (x * 0.6 + z * 0.8) / 5;
    const minorCoordinate = (-x * 0.8 + z * 0.6) / 2;
    assert.ok(Math.abs(majorCoordinate ** 2 + minorCoordinate ** 2 - 1) < 1e-9);
  }
});

test('vertical major-axis ellipse is retained instead of discarded as zero length', () => {
  const output = expand([entity('ELLIPSE', {
    center: { x: 0, y: 0, z: 0 }, majorAxisEndPoint: { x: 0, y: 0, z: 10 },
    axisRatio: 0.5, extrusionDirection: { x: 0, y: -1, z: 0 },
  })])[0];
  assert.ok(output);
  close(output.vertices[0], { x: 0, y: 0, z: 10 });
  close(output.vertices[(output.vertices.length - 1) / 4], { x: -5, y: 0, z: 0 });
});

test('ellipse default normal is +Z and a reversed normal reverses arc traversal without moving its WCS center', () => {
  const source = entity('ELLIPSE', {
    center: { x: 2, y: 3, z: 4 }, majorAxisEndPoint: { x: 10, y: 0, z: 0 },
    axisRatio: 0.5, startAngle: Math.PI / 2, endAngle: Math.PI,
  });
  const positive = expand([source])[0];
  assert.deepEqual(positive, expand([{ ...source, extrusionDirection: { x: 0, y: 0, z: 1 } }])[0]);
  close(positive.vertices[0], { x: 2, y: 8, z: 4 });
  const negative = expand([{ ...source, extrusionDirection: { x: 0, y: 0, z: -1 } }])[0];
  assert.equal(negative.closed, false);
  close(negative.vertices[0], { x: 2, y: -2, z: 4 });
  close(negative.vertices.at(-1)!, { x: -8, y: 3, z: 4 });
});

test('ellipse WCS sampling composes once with nested INSERT scale, rotation, OCS and translation', () => {
  const blocks = [
    { name: 'ELLIPSE_BLOCK', basePoint: { x: 1, y: 2, z: 3 }, entities: [entity('ELLIPSE', {
      center: { x: 1, y: 2, z: 3 }, majorAxisEndPoint: { x: 10, y: 0, z: 0 },
      axisRatio: 0.5, extrusionDirection: { x: 0, y: -1, z: 0 },
    })] },
    { name: 'OUTER', basePoint: { x: 0, y: 0, z: 0 }, entities: [entity('INSERT', {
      name: 'ELLIPSE_BLOCK', insertionPoint: { x: 3, y: 4, z: 5 }, xScale: 2, yScale: 3, zScale: 4,
      rotation: Math.PI / 2, extrusionDirection: { x: 0, y: 0, z: -1 },
    })] },
  ];
  const output = expand([entity('INSERT', {
    name: 'OUTER', insertionPoint: { x: 100, y: 200, z: 300 },
  })], blocks)[0];
  close(output.vertices[0], { x: 97, y: 224, z: 295 });
  close(output.vertices[(output.vertices.length - 1) / 4], { x: 97, y: 204, z: 275 });
});
