import test from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceEditStore, SURFACE_EDIT_STORAGE_PREFIX, validateSurfaceEditPlan, validateSurfaceEditPlans } from './surfaceEditStore.ts';
import { SURFACE_EDIT_LIMITS, type SurfaceEditPlan } from './surfaceEditTypes.ts';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const outline = (count = 4) => Array.from({ length: count }, (_, index) => ({
  longitude: 121 + Math.cos(index * Math.PI * 2 / count) * .001,
  latitude: 31 + Math.sin(index * Math.PI * 2 / count) * .001, height: 12,
}));
function plan(id = 'pit'): SurfaceEditPlan {
  return { version: 1, id, name: '承台开挖', kind: 'excavation', targetId: '摄影-1', targetTransform: [...identity],
    boundary: outline(), holes: [], targetHeight: -8, clipTerrain: true, bottomVisible: true,
    texture: { ground: 'soil', wall: 'sand', scaleMeters: 2, groundImage: png }, enabled: true,
    createdAt: '2026-11-12T01:02:03.000Z', updatedAt: '2026-11-12T01:02:03.000Z' };
}
const context = (project: string, user: string) => JSON.stringify([project, user]);
const key = (scope: string) => SURFACE_EDIT_STORAGE_PREFIX + encodeURIComponent(scope);
function fixture() {
  const data = new Map<string, string>(); let writes = 0, quota = false;
  const storage = {
    getItem(name: string) { return data.get(name) ?? null; },
    setItem(name: string, value: string) {
      if (quota) throw new DOMException('Storage full', 'QuotaExceededError');
      writes++; data.set(name, value);
    },
  };
  return { data, store: new SurfaceEditStore(storage), writes: () => writes, exhaust: () => { quota = true; } };
}
function headerImage(bytes: number, format: 'png' | 'jpeg' | 'webp' = 'png'): string {
  const data = Buffer.alloc(bytes);
  if (format === 'png') Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  else if (format === 'jpeg') Buffer.from([255, 216, 255]).copy(data);
  else { data.write('RIFF', 0); data.write('WEBP', 8); }
  return `data:image/${format};base64,${data.toString('base64')}`;
}

test('project and actor contexts isolate data, with one write and no unrelated changes', () => {
  const f = fixture(), a = context('项目/一', '用户A'), b = context('项目/一', '用户B'), c = context('项目二', '用户A');
  f.data.set('existing-temporary-works', 'original');
  assert.deepEqual(f.store.load(a), []);
  f.store.save(a, [plan('A')]); assert.equal(f.writes(), 1);
  f.store.save(b, [plan('B')]); f.store.save(c, [plan('C')]);
  assert.equal(f.store.load(a)[0].id, 'A'); assert.equal(f.store.load(b)[0].id, 'B'); assert.equal(f.store.load(c)[0].id, 'C');
  assert.equal(f.data.get('existing-temporary-works'), 'original'); assert.equal(f.data.size, 4);
  assert.ok(f.data.has(key(a))); assert.ok(f.data.has(key(b))); assert.ok(f.data.has(key(c)));
});

test('enabled, terrain, bottom, texture and transform settings round-trip unchanged and detached', () => {
  const f = fixture(), scope = context('p', 'u'), original = plan();
  original.kind = 'flatten'; original.enabled = false; original.clipTerrain = false; original.bottomVisible = false;
  original.targetTransform = [...identity, ...identity]; original.texture.wallImage = png; original.holes = [outline(3)];
  const before = structuredClone(original); f.store.save(scope, [original]);
  original.boundary[0].height = 999; original.texture.ground = 'gravel'; original.targetTransform[0] = 2;
  const loaded = f.store.load(scope); assert.deepEqual(loaded, [before]);
  loaded[0].boundary[0].height = -999; loaded[0].holes[0][0].longitude = 0; loaded[0].texture.ground = 'sand';
  assert.deepEqual(f.store.load(scope), [before]);
  const validated = validateSurfaceEditPlan(before); validated.boundary[0].height = 123;
  assert.notEqual(validated.boundary[0].height, before.boundary[0].height);
});

test('quota failure preserves the previous serialized record and does not touch other contexts', () => {
  const f = fixture(), scope = context('p', 'u');
  f.store.save(scope, [plan()]); f.store.save(context('other', 'u'), [plan('other')]);
  const before = new Map(f.data), writes = f.writes(); f.exhaust();
  assert.throws(() => f.store.save(scope, [plan('new')]), { name: 'QuotaExceededError' });
  assert.deepEqual(f.data, before); assert.equal(f.writes(), writes); assert.equal(f.store.load(scope)[0].id, 'pit');
});

test('malformed, future-version and unknown-field records block both load and overwrite', () => {
  const f = fixture(), scope = context('p', 'u');
  for (const raw of ['{bad json', '', JSON.stringify({ version: 2, plans: [] }),
    JSON.stringify({ version: 1, plans: [], future: true }),
    JSON.stringify({ version: 1, plans: [{ ...plan(), future: 'keep me' }] })]) {
    f.data.set(key(scope), raw);
    assert.throws(() => f.store.load(scope));
    assert.throws(() => f.store.save(scope, []));
    assert.equal(f.data.get(key(scope)), raw); assert.equal(f.writes(), 0);
  }
});

test('oversized existing documents are rejected before parsing and cannot be overwritten', () => {
  const f = fixture(), scope = context('p', 'u');
  for (const raw of ['x'.repeat(SURFACE_EDIT_LIMITS.documentBytes + 1), '土'.repeat(6 * 1024 * 1024)]) {
    f.data.set(key(scope), raw);
    assert.throws(() => f.store.load(scope), /16 MB/); assert.throws(() => f.store.save(scope, []), /16 MB/);
    assert.equal(f.data.get(key(scope)), raw); assert.equal(f.writes(), 0);
  }
});

test('schema validation rejects invalid numbers, switches, required fields and arbitrary extensions', () => {
  const invalid: unknown[] = [null, [], {}, { ...plan(), version: 2 }, { ...plan(), enabled: 'false' },
    { ...plan(), clipTerrain: 1 }, { ...plan(), bottomVisible: null }, { ...plan(), kind: 'other' },
    { ...plan(), id: ' ' }, { ...plan(), name: 'x'.repeat(161) }, { ...plan(), targetId: '' },
    { ...plan(), id: 'a\nb' }, { ...plan(), targetHeight: NaN }, { ...plan(), extra: true },
    { ...plan(), targetTransform: identity.slice(1) }, { ...plan(), targetTransform: [...identity.slice(1), Infinity] },
    { ...plan(), targetTransform: new Array(16) }, { ...plan(), boundary: [{ longitude: 181, latitude: 0, height: 1 }, ...outline(3)] },
    { ...plan(), boundary: [{ longitude: 121, latitude: 91, height: 1 }, ...outline(3)] },
    { ...plan(), boundary: [{ ...outline()[0], height: Infinity }, ...outline(3)] },
    { ...plan(), boundary: [{ ...outline()[0], unused: 1 }, ...outline(3)] },
    { ...plan(), boundary: new Array(4) }, { ...plan(), holes: [new Array(3)] },
    { ...plan(), texture: { ground: 'soil', wall: 'soil', scaleMeters: 0 } },
    { ...plan(), texture: { ground: 'soil', wall: 'gravel', scaleMeters: 2 } },
    { ...plan(), texture: { ground: 'soil', wall: 'soil', scaleMeters: 2, secret: true } }];
  for (const value of invalid) assert.throws(() => validateSurfaceEditPlan(value));
  const hidden = plan(); Object.defineProperty(hidden, 'name', { value: 'hidden', enumerable: false });
  assert.throws(() => validateSurfaceEditPlan(hidden), /无法识别/);
  const accessor = plan(); let invoked = false;
  Object.defineProperty(accessor, 'name', { enumerable: true, get() { invoked = true; return 'changed'; } });
  assert.throws(() => validateSurfaceEditPlan(accessor), /无法识别/); assert.equal(invoked, false);
  const f = fixture();
  assert.throws(() => f.store.save(context('p', 'u'), [{ ...plan(), targetHeight: Infinity }]));
  assert.equal(f.writes(), 0); assert.equal(f.data.size, 0);
});

test('dates must be valid UTC timestamps, including calendar-day validity', () => {
  for (const date of ['yesterday', '2026-02-30T00:00:00.000Z', '2026-11-12T25:00:00.000Z', '2026-11-12', ''])
    assert.throws(() => validateSurfaceEditPlan({ ...plan(), updatedAt: date }), /日期时间/);
  assert.equal(validateSurfaceEditPlan({ ...plan(), createdAt: '2024-02-29T00:00:00Z' }).createdAt, '2024-02-29T00:00:00Z');
});

test('per-plan and total boundary budgets include retained holes, with exact boundary acceptance', () => {
  const exact = plan(); exact.boundary = outline(509); exact.holes = [outline(3)];
  assert.equal(validateSurfaceEditPlan(exact).boundary.length, 509);
  assert.throws(() => validateSurfaceEditPlan({ ...exact, boundary: outline(510) }), /512/);
  assert.throws(() => validateSurfaceEditPlan({ ...plan(), boundary: outline(513) }), /512/);
  assert.throws(() => validateSurfaceEditPlan({ ...plan(), holes: Array.from({ length: 17 }, () => outline(3)) }), /16/);
  const plans = Array.from({ length: 8 }, (_, index) => ({ ...plan(String(index)), boundary: outline(512) }));
  assert.equal(validateSurfaceEditPlans(plans).length, 8);
  assert.throws(() => validateSurfaceEditPlans([...plans, plan('overflow')]), /4096/);
});

test('plan quantity, uniqueness and sparse-array inputs are validated', () => {
  assert.equal(validateSurfaceEditPlans(Array.from({ length: 32 }, (_, index) => plan(String(index)))).length, 32);
  assert.throws(() => validateSurfaceEditPlans(Array.from({ length: 33 }, (_, index) => plan(String(index)))), /32/);
  assert.throws(() => validateSurfaceEditPlans([plan(), plan()]), /重复/);
  assert.throws(() => validateSurfaceEditPlans(new Array(2)));
  assert.throws(() => validateSurfaceEditPlans({ plans: [] }));
});

test('image MIME, binary signature, encoding and decoded byte budgets are enforced', () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const value = plan(); value.texture.groundImage = headerImage(12, format);
    assert.equal(validateSurfaceEditPlan(value).texture.groundImage, value.texture.groundImage);
  }
  for (const image of ['https://example.com/soil.png', 'data:image/svg+xml;base64,PHN2Zz4=',
    png.replace('image/png', 'image/jpeg'), 'data:image/png;base64,????', 'data:image/png;base64,AAAA===',
    'data:image/png;base64,', 'data:image/png;base64,A===', 'data:image/png;base64,AAAA']) {
    const value = plan(); value.texture.groundImage = image; assert.throws(() => validateSurfaceEditPlan(value));
  }
  const value = plan(); value.texture.groundImage = headerImage(SURFACE_EDIT_LIMITS.imageBytes);
  assert.equal(validateSurfaceEditPlan(value).texture.groundImage, value.texture.groundImage);
  value.texture.groundImage = headerImage(SURFACE_EDIT_LIMITS.imageBytes + 1);
  assert.throws(() => validateSurfaceEditPlan(value), /2 MB/);
});

test('many individually valid images cannot exceed the aggregate serialized document budget', () => {
  const image = headerImage(SURFACE_EDIT_LIMITS.imageBytes);
  const plans = Array.from({ length: 3 }, (_, index) => ({ ...plan(String(index)),
    texture: { ground: 'soil' as const, wall: 'soil' as const, scaleMeters: 2, groundImage: image, wallImage: image } }));
  const f = fixture(), scope = context('p', 'u'); f.store.save(scope, [plan()]); const before = f.data.get(key(scope));
  assert.throws(() => validateSurfaceEditPlans(plans), /16 MB/);
  assert.throws(() => f.store.save(scope, plans), /16 MB/);
  assert.equal(f.data.get(key(scope)), before); assert.equal(f.writes(), 1);
});

test('construction is independent of browser storage and access failures stay explicit', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++; throw new Error('blocked storage'); } });
  try {
    const store = new SurfaceEditStore(); assert.equal(reads, 0);
    assert.throws(() => store.load(context('p', 'u')), /blocked storage/); assert.equal(reads, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
  const f = fixture();
  for (const invalid of ['', ' ', 'x'.repeat(4097), '\ud800']) {
    assert.throws(() => f.store.load(invalid), /上下文/); assert.throws(() => f.store.save(invalid, []), /上下文/);
  }
  assert.equal(f.writes(), 0);
});
