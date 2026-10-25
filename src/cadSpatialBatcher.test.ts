import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundingSphere, Cartesian3, Intersect, PerspectiveFrustum } from 'cesium';
import { cadSpatialBatchKey, CadSpatialBatcher } from './cadSpatialBatcher.ts';
import { CAD_PRIMITIVE_VERTEX_BUDGET, CAD_SOURCE_BUFFER_VERTEX_BUDGET } from './cadPrimitiveLoader.ts';

test('spatial buffers retain every whole item and partition while bounding pending work', () => {
  const emitted: Array<Array<{ id: number; key: string; partition: string; vertices: number }>> = [];
  const batches = new CadSpatialBatcher<{ id: number; key: string; partition: string; vertices: number }>({ maxBatchSize: 5, maxBufferedItems: 9,
    maxBufferedVertices: 25, maxBufferedBuckets: 3, emit: items => emitted.push(items) });
  const input = Array.from({ length: 100 }, (_, id) => ({ id,
    key: cadSpatialBatchKey({ x: (id % 7) * 300 - 1000, y: 0, z: 0 }, id % 2 ? 'red' : 'blue'),
    partition: id % 2 ? 'red' : 'blue',
    vertices: id === 13 ? 100 : 2 + id % 4,
  }));
  for (const item of input) {
    batches.add(item.key, item, item.vertices, item.partition);
    assert.ok(batches.bufferedItems <= 9);
    assert.ok(batches.bufferedVertices <= 25);
    assert.ok(batches.bufferedBuckets <= 3);
  }
  batches.flush();
  assert.equal(batches.bufferedItems + batches.bufferedVertices + batches.bufferedBuckets, 0);
  const output = emitted.flat().sort((a, b) => a.id - b.id);
  assert.equal(output.length, input.length);
  output.forEach((item, index) => assert.equal(item, input[index]));
  for (const batch of emitted) {
    assert.ok(batch.length <= 5);
    assert.equal(new Set(batch.map(item => item.partition)).size, 1);
    if (batch.some(item => item.vertices > 25)) assert.equal(batch.length, 1);
  }
});

test('129 interleaved cells degrade to bounded shared batches without one primitive per line', () => {
  const emitted: Array<Array<{ id: number; partition: string }>> = [];
  const batches = new CadSpatialBatcher<{ id: number; partition: string }>({ maxBatchSize: 1000,
    emit: items => emitted.push(items) });
  const count = 129 * 100;
  for (let id = 0; id < count; id++) {
    const partition = id % 2 ? 'red' : 'blue';
    batches.add(cadSpatialBatchKey({ x: id % 129 * 1024, y: 0, z: 0 }, partition), { id, partition }, 2, partition);
    assert.ok(batches.bufferedBuckets <= 128);
    assert.ok(batches.bufferedItems <= 4000);
    assert.ok(batches.bufferedVertices <= 131072);
  }
  batches.flush();
  assert.ok(emitted.length <= Math.ceil(count / 1000) + 128 + 2, `${emitted.length} batches for ${count} short lines`);
  assert.ok(emitted.every(batch => batch.length <= 1000 && new Set(batch.map(item => item.partition)).size === 1));
  assert.deepEqual(emitted.flat().map(item => item.id).sort((a, b) => a - b), Array.from({ length: count }, (_, index) => index));
});

test('many short lines in one cell still use the original instance limit', () => {
  const emitted: number[][] = [];
  const batches = new CadSpatialBatcher<number>({ maxBatchSize: 1000, emit: items => emitted.push(items) });
  for (let i = 0; i < 10_000; i++) batches.add('one-cell', i, 2);
  batches.flush();
  assert.equal(emitted.length, 10);
  assert.ok(emitted.every(batch => batch.length === 1000));
});

test('per-primitive vertex budgets bound local and overflow emissions without losing logical items', () => {
  for (const cells of [1, 9]) {
    const emitted: Array<Array<{ id: number; vertices: number; partition: string }>> = [];
    const batches = new CadSpatialBatcher<{ id: number; vertices: number; partition: string }>({
      maxBatchSize: 1000, maxBatchVertices: 32, maxBufferedVertices: 200, maxBufferedBuckets: 3,
      emit: items => emitted.push(items),
    });
    const source = Array.from({ length: 200 }, (_, id) => ({ id, vertices: 7 + id % 12, partition: id % 2 ? 'a' : 'b' }));
    for (const item of source) batches.add(`${item.id % cells}:${item.partition}`, item, item.vertices, item.partition);
    batches.flush();
    assert.deepEqual(emitted.flat().sort((a, b) => a.id - b.id), source);
    assert.ok(emitted.every(items => items.reduce((total, item) => total + item.vertices, 0) <= 32));
    assert.ok(emitted.every(items => new Set(items.map(item => item.partition)).size === 1));
    assert.throws(() => batches.add('oversized', { id: 999, vertices: 33, partition: 'a' }, 33), /vertex budget/);
    assert.equal(batches.bufferedItems, 0);
  }
});

test('indivisible oversized items opt into complete isolated batches', () => {
  const emitted: Array<Array<{ id: number; vertices: number }>> = [];
  const batches = new CadSpatialBatcher<{ id: number; vertices: number }>({ maxBatchSize: 100,
    maxBatchVertices: 32, maxBufferedVertices: 128, allowOversizedItem: true, emit: items => emitted.push(items) });
  const source = [{ id: 0, vertices: 4 }, { id: 1, vertices: 33 }, { id: 2, vertices: 4 },
    { id: 3, vertices: 256 }, { id: 4, vertices: 4 }];
  for (const item of source) batches.add('same-cell', item, item.vertices);
  batches.flush();
  assert.deepEqual(emitted.flat(), source);
  for (const group of emitted) {
    if (group.some(item => item.vertices > 32)) assert.equal(group.length, 1);
    else assert.ok(group.reduce((sum, item) => sum + item.vertices, 0) <= 32);
    for (const item of group) assert.equal(item, source[item.id]);
  }
  assert.equal(batches.bufferedItems + batches.bufferedVertices, 0);
});

test('100000 interleaved curved entities stay in bounded full batches under source-cache pressure', () => {
  for (const cells of [32, 129]) for (const [budget, cache] of [
    [1024, 4096], // The former small cache must also avoid one primitive per entity.
    [CAD_PRIMITIVE_VERTEX_BUDGET.ground, CAD_SOURCE_BUFFER_VERTEX_BUDGET],
    [CAD_PRIMITIVE_VERTEX_BUDGET.absolute, CAD_SOURCE_BUFFER_VERTEX_BUDGET],
  ]) {
    const count = 100_000, points = 128, seen = new Uint8Array(count);
    let emitted = 0, singletons = 0;
    const batches = new CadSpatialBatcher<number>({ maxBatchSize: 1000, maxBatchVertices: budget,
      maxBufferedVertices: cache, emit: items => {
        emitted++; if (items.length === 1) singletons++;
        assert.ok(items.length * points <= budget);
        for (const id of items) { assert.equal(seen[id], 0); seen[id]++; }
      } });
    for (let id = 0; id < count; id++) {
      batches.add(String(id % cells), id, points);
      assert.ok(batches.bufferedVertices <= cache);
    }
    batches.flush();
    assert.ok(seen.every(value => value === 1), 'every source entity is emitted exactly once');
    assert.ok(emitted <= Math.ceil(count * points / budget) * 5 + 129, `${emitted} primitives for budget=${budget}, cells=${cells}`);
    assert.ok(singletons <= 129, `only final spatial tails may be singletons, got ${singletons}`);
    if (budget === CAD_PRIMITIVE_VERTEX_BUDGET.ground) assert.ok(emitted <= 3255, `${emitted} ground batches`);
  }
});

test('interleaved distant short lines submit less geometry in a nearby synthetic frustum', () => {
  type Item = { id: number; sphere: BoundingSphere; vertices: number };
  const input: Item[] = [];
  for (let repeat = 0; repeat < 64; repeat++) for (let site = 0; site < 32; site++) {
    input.push({ id: input.length, sphere: new BoundingSphere(new Cartesian3(site * 1024 + 1, 1, 0), 1), vertices: 2 });
  }
  const spatial: Item[][] = [];
  const batches = new CadSpatialBatcher<Item>({ maxBatchSize: 1000, emit: items => spatial.push(items) });
  for (const item of input) batches.add(cadSpatialBatchKey(item.sphere.center), item, item.vertices);
  batches.flush();
  const original: Item[][] = [];
  for (let i = 0; i < input.length; i += 1000) original.push(input.slice(i, i + 1000));
  // Same center-average / enclosing-radius rule as Cesium's combineInstances.
  const sphere = (items: Item[]) => {
    const center = items.reduce((sum, item) => Cartesian3.add(sum, item.sphere.center, sum), new Cartesian3());
    Cartesian3.divideByScalar(center, items.length, center);
    return new BoundingSphere(center, Math.max(...items.map(item => Cartesian3.distance(center, item.sphere.center) + item.sphere.radius)));
  };
  const frustum = new PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: .1, far: 1000 });
  const view = frustum.computeCullingVolume(new Cartesian3(1, 1, 100), new Cartesian3(0, 0, -1), Cartesian3.UNIT_Y);
  const submitted = (groups: Item[][]) => groups.filter(items => view.computeVisibility(sphere(items)) !== Intersect.OUTSIDE)
    .reduce((sum, items) => sum + items.reduce((total, item) => total + item.vertices, 0), 0);
  assert.equal(submitted(original), 4096);
  assert.equal(submitted(spatial), 128);
  assert.equal(spatial.length, 32, 'one batch per populated cell, not per short line');
  assert.deepEqual(spatial.flat().map(item => item.id).sort((a, b) => a - b), input.map(item => item.id));
});
