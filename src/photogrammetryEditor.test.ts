import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { BoundingSphere, Cartesian3, EntityCollection, Matrix4, Transforms, type Cesium3DTileset, type Viewer } from 'cesium';
import type { PhotogrammetryEditorHooks } from './photogrammetryEditor.ts';

registerHooks({ load(url, context, next) {
  if (url.endsWith('/photogrammetryEditor.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
  return next(url, context);
} });
const { PhotogrammetryEditor } = await import('./photogrammetryEditor.ts');

class Surface extends EventTarget {
  style = { cursor: 'grab' };
  clientWidth = 1000; clientHeight = 800; disableRootEvents = true;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (callback) {
      const set = this.listeners.get(type) ?? new Set(); set.add(callback); this.listeners.set(type, set);
      if (typeof options === 'object') options.signal?.addEventListener('abort', () => set.delete(callback), { once: true });
    }
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (callback) this.listeners.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  get count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
class Element extends Surface {
  hidden = false; removed = false; disabled = false; innerHTML = ''; textContent = ''; value = '';
  className = ''; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  children: Element[] = []; fields = new Map<string, Element>();
  classList = { toggle: (_name: string, _on?: boolean) => false };
  buttons = ['move-points', 'pick-pivot', 'reset', 'save', 'cancel'].map(action => ({
    dataset: { photoAction: action }, disabled: false, textContent: '',
  }));
  append(value: Element) { this.children.push(value); }
  remove() { this.removed = true; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector(selector: string) {
    const name = selector.match(/data-photogrammetry="([^"]+)"/)?.[1];
    if (!name) return null;
    if (!this.fields.has(name)) { const element = new Element(); element.dataset.photogrammetry = name; this.fields.set(name, element); }
    return this.fields.get(name)!;
  }
  querySelectorAll() { return this.buttons; }
  checkValidity() {
    const value = Number(this.value), key = this.dataset.photogrammetry;
    return key === 'pivotLon' ? value >= -180 && value <= 180 : key === 'pivotLat' ? value >= -90 && value <= 90 : true;
  }
}
type Internals = {
  action(action: string): Promise<void>;
  input(input: HTMLInputElement): void;
  session?: { draft: { east: number; north: number; up: number; heading: number } };
};
function fixture(t: TestContext, overrides: Partial<PhotogrammetryEditorHooks> = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const doc = Object.assign(new Surface(), { activeElement: null, createElement: () => new Element() });
  const win = new Surface(), canvas = new Surface(), parent = new Element();
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: doc });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: win });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  const center = Cartesian3.fromDegrees(121, 31, 15), frame = Transforms.eastNorthUpToFixedFrame(center);
  const original = Matrix4.fromTranslation(new Cartesian3(4, 6, 8));
  let destroyed = false, allowed = true, picked: Cartesian3 | undefined = center;
  const tiles = { modelMatrix: Matrix4.clone(original), boundingSphere: new BoundingSphere(center, 100), isDestroyed: () => destroyed };
  const notices: { message: string; error?: boolean }[] = [];
  let leases = 0, releases = 0, commits = 0, saves = 0;
  const viewer = {
    isDestroyed: () => false, canvas, entities: new EntityCollection(),
    scene: { canvas, pickPositionSupported: true, pickPosition: () => picked, globe: { pick: () => undefined },
      screenSpaceCameraController: { enableInputs: false }, requestRender() {} },
    camera: { getPickRay: () => undefined, pickEllipsoid: () => undefined },
  };
  const hooks: PhotogrammetryEditorHooks = {
    isValid: () => allowed,
    acquire: () => { leases++; return () => { leases--; releases++; }; },
    save: async () => { saves++; }, onCommitted: () => { commits++; }, notify: (message, error) => { notices.push({ message, error }); }, ...overrides,
  };
  const editor = new PhotogrammetryEditor(viewer as unknown as Viewer, parent as unknown as HTMLElement, hooks);
  t.after(() => editor.dispose());
  const root = parent.children[0], internals = editor as unknown as Internals;
  const field = (name: string) => root.querySelector(`[data-photogrammetry="${name}"]`)!;
  const type = (name: string, value: string) => { const input = field(name); input.value = value; internals.input(input as unknown as HTMLInputElement); };
  const open = () => editor.open({ id: 'photography', name: '合成摄影', tileset: tiles as unknown as Cesium3DTileset });
  const click = (point?: Cartesian3) => {
    picked = point;
    for (const name of ['mousedown', 'mouseup']) {
      const event = new Event(name, { cancelable: true }); Object.assign(event, { clientX: 10, clientY: 10, button: 0 }); canvas.dispatchEvent(event);
    }
  };
  const escape = () => { const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' }); win.dispatchEvent(event); };
  return { editor, internals, open, type, field, root, hooks, tiles, original, viewer, win, canvas, notices, click, escape,
    world: (x: number, y: number, z: number) => Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3()),
    revoke: () => { allowed = false; }, allow: () => { allowed = true; }, destroy: () => { destroyed = true; },
    leases: () => leases, releases: () => releases, commits: () => commits, saves: () => saves };
}
const matrix = (value: Matrix4) => Matrix4.toArray(value);
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('closed editor has no listeners or render callbacks; preview never saves and cancel restores the exact opening pose', t => {
  const f = fixture(t);
  assert.equal(f.win.count, 0); assert.equal(f.canvas.count, 0); assert.equal(f.root.count, 0);
  assert.equal(f.open(), true); assert.equal(f.editor.activeId, 'photography'); assert.equal(f.leases(), 1);
  assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(f.original)); assert.equal(f.viewer.entities.values.length, 2);
  f.type('east', '12.3456789123'); f.type('heading', '8');
  assert.equal(f.internals.session?.draft.east, 12.3456789123, 'editing an angle cannot round a previously precise planar offset');
  f.type('east', '12.5'); f.type('north', '-8'); f.type('heading', '30');
  assert.notDeepEqual(matrix(f.tiles.modelMatrix), matrix(f.original)); assert.equal(f.saves(), 0);
  assert.equal(f.editor.cancel(), true); assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(f.original));
  assert.equal(f.leases(), 0); assert.equal(f.releases(), 1); assert.equal(f.viewer.entities.values.length, 0);
  assert.equal(f.win.count, 0); assert.equal(f.root.count, 0); assert.equal(f.canvas.count, 0);
  f.editor.cancel(); f.editor.dispose(); assert.equal(f.releases(), 1); assert.equal(f.viewer.scene.screenSpaceCameraController.enableInputs, false);
});

test('invalid form values cannot silently save the preceding preview; reset only previews until explicit commit', async t => {
  const f = fixture(t); f.open(); f.type('east', '15'); const preview = matrix(f.tiles.modelMatrix);
  f.type('east', ''); await f.internals.action('save'); assert.equal(f.saves(), 0); assert.deepEqual(matrix(f.tiles.modelMatrix), preview);
  await f.internals.action('move-points'); assert.equal(f.root.dataset.picking, undefined, 'invalid numeric input must be corrected before map picking');
  f.type('east', '1e309'); await f.internals.action('save'); assert.equal(f.saves(), 0);
  f.type('east', '20'); await f.internals.action('reset'); assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(f.original)); assert.equal(f.saves(), 0);
  f.type('up', '3'); const committed = matrix(f.tiles.modelMatrix);
  await f.internals.action('save'); assert.equal(f.saves(), 1); assert.equal(f.commits(), 1);
  assert.deepEqual(matrix(f.tiles.modelMatrix), committed); assert.equal(f.editor.isOpen, false); assert.equal(f.leases(), 0);
});

test('a rejected save keeps the preview editable, leaves the lease intact and can retry the same transaction', async t => {
  const f = fixture(t); f.open(); f.type('east', '23'); const preview = matrix(f.tiles.modelMatrix);
  let attempts = 0;
  f.hooks.save = async () => { if (++attempts === 1) throw new Error('synthetic disk failure'); };
  await f.internals.action('save'); assert.equal(f.editor.busy, false); assert.equal(f.editor.isOpen, true);
  assert.equal(f.leases(), 1); assert.equal(f.commits(), 0); assert.deepEqual(matrix(f.tiles.modelMatrix), preview);
  assert.match(f.field('status').textContent, /保存失败/);
  await f.internals.action('save'); assert.equal(attempts, 2); assert.equal(f.commits(), 1); assert.equal(f.leases(), 0);
  assert.deepEqual(matrix(f.tiles.modelMatrix), preview);
});

test('saving blocks ordinary cancel/open and forced disposal cannot be revived by a late success', async t => {
  const f = fixture(t), pending = deferred(); f.open(); f.type('north', '31'); f.hooks.save = () => pending.promise;
  const saving = f.internals.action('save'); assert.equal(f.editor.busy, true); assert.equal(f.root.attributes.get('aria-busy'), 'true');
  assert.equal(f.editor.cancel(), false); assert.equal(f.open(), false); f.type('east', '200');
  assert.equal(f.internals.session?.draft.east, 0);
  f.editor.dispose(); assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(f.original)); assert.equal(f.leases(), 0);
  pending.resolve(); await saving; assert.equal(f.commits(), 0); assert.equal(f.editor.isOpen, false); assert.equal(f.win.count, 0);
  assert.ok(!f.notices.some(item => /位置已保存/.test(item.message)));
});

test('context invalidation releases a pending commit and its late completion cannot close a newer session', async t => {
  const f = fixture(t), pending = deferred(); f.open(); f.type('east', '41'); f.hooks.save = () => pending.promise;
  const oldSave = f.internals.action('save'); f.revoke(); f.editor.refreshValidity();
  assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(f.original)); assert.equal(f.leases(), 0);
  f.allow(); assert.equal(f.open(), true); f.type('up', '12'); const current = matrix(f.tiles.modelMatrix);
  pending.resolve(); await oldSave; assert.equal(f.editor.isOpen, true); assert.equal(f.commits(), 0);
  assert.deepEqual(matrix(f.tiles.modelMatrix), current); assert.equal(f.leases(), 1);
});

test('an external matrix owner is preserved on invalidation; post-commit refresh failure cannot undo a successful save', async t => {
  const f = fixture(t); f.open(); f.type('east', '10');
  const external = Matrix4.fromTranslation(new Cartesian3(900, 800, 700)); f.tiles.modelMatrix = external;
  f.editor.refreshValidity(); assert.equal(f.editor.isOpen, false); assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(external)); assert.equal(f.leases(), 0);
  f.open(); f.type('east', '15'); const saved = matrix(f.tiles.modelMatrix);
  f.hooks.onCommitted = () => { throw new Error('synthetic dependent refresh'); };
  await f.internals.action('save'); assert.equal(f.saves(), 1); assert.deepEqual(matrix(f.tiles.modelMatrix), saved);
  assert.equal(f.editor.isOpen, false); assert.equal(f.leases(), 0);
  assert.ok(f.notices.some(item => /已保存，但场景刷新失败/.test(item.message)));
});

test('two real Cesium input picks change only planar ENU offsets and sky/Escape cleans picking without closing the editor', async t => {
  const f = fixture(t); f.open(); f.type('up', '9');
  const moving = f.internals.action('move-points'); assert.equal(f.root.dataset.picking, 'move-start');
  f.click(undefined); await Promise.resolve(); assert.equal(f.root.dataset.picking, 'move-start');
  f.click(f.world(1, 2, 3)); await Promise.resolve(); assert.equal(f.root.dataset.picking, 'move-end');
  f.click(f.world(13, -5, 33)); await moving;
  assert.ok(Math.abs(f.internals.session!.draft.east - 12) < 1e-7); assert.ok(Math.abs(f.internals.session!.draft.north + 7) < 1e-7);
  assert.equal(f.internals.session!.draft.up, 9); assert.equal(f.canvas.count, 0); assert.equal(f.canvas.style.cursor, 'grab');
  const before = matrix(f.tiles.modelMatrix), pivot = f.internals.action('pick-pivot');
  assert.ok(f.canvas.count > 0); f.escape(); await pivot;
  assert.equal(f.editor.isOpen, true); assert.deepEqual(matrix(f.tiles.modelMatrix), before); assert.equal(f.canvas.count, 0);
  f.escape(); assert.equal(f.editor.isOpen, false); assert.equal(f.win.count, 0); assert.equal(f.leases(), 0);
});

test('deletion during picking releases all handlers without writing a destroyed model', async t => {
  const f = fixture(t); f.open(); const picking = f.internals.action('move-points');
  f.destroy(); f.editor.refreshValidity(); await picking;
  assert.equal(f.editor.isOpen, false); assert.equal(f.canvas.count, 0); assert.equal(f.win.count, 0); assert.equal(f.leases(), 0);
  assert.deepEqual(matrix(f.tiles.modelMatrix), matrix(f.original));
});
