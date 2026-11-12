import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Matrix4 } from 'cesium';

// Run the production controller and real schema/geometry preflight. Only the UI,
// GPU and async worker/photogrammetry boundaries are replaced with controllable ports.
// No private lifecycle method is reimplemented in this fixture.
let temporary, SurfaceEditController, control;
before(async () => {
  temporary = await mkdtemp(resolve('tests/.surface-controller-'));
  const stubs = {
    './surfaceEditPanel': `export class SurfaceEditPanel {
      constructor(options){this.options=options;this.busyHistory=[];this.statusHistory=[];this.plans=[];}
      setEditable(value){this.editable=value;} setStatus(message,error){this.statusHistory.push({message,error});}
      setPlans(plans){this.plans=plans;} fill(){} setBoundary(){} refreshTargets(){}
      setBusy(message){this.busyHistory.push(message);} destroy(){this.destroyed=true;}
      getSelectedTargetId(){return 'photo';} getBoundarySource(){return 'picked';}
    }`,
    './surfaceEditScene': `import {control} from 'surface-controller-control';
      export class SurfaceEditScene {
        constructor(viewer,options){this.options=options;this.viewer=viewer;this.suspended=false;}
        async prepare(...args){control.prepares.push(args);return control.prepareFn(...args);}
        setSuspended(value){this.suspended=value;} destroy(){this.destroyed=true;}
      }`,
    './surfaceEditJobs': `import {control} from 'surface-controller-control';
      export function runSurfaceEditGeometry(...args){control.jobs.push(args);return control.jobFn(...args);}
      export function refineSurfaceEditBoundary(...args){control.refinements.push(args);return control.refineFn(...args);}
      export function estimateBoundarySampling(...args){control.estimates.push(args);return {};}`,
    './temporaryWorksScene': `import {control} from 'surface-controller-control';
      export function withPlanningSurface(viewer,target,options,run){control.surfaces.push({viewer,target,signal:options.signal});
        return run(async points=>points.map(()=>10),options.signal);}`,
    './machinerySurfacePicker': 'export function pickMachinerySurface(){return undefined;}',
  };
  const bundled = await build({ bundle: true, platform: 'node', format: 'esm', write: false,
    external: ['cesium', 'three', 'polygon-clipping'], loader: { '.css': 'empty' },
    stdin: { resolveDir: process.cwd(), contents: `export {SurfaceEditController} from './src/surfaceEditController.ts'; export {control} from 'surface-controller-control';` },
    plugins: [{ name: 'controller-async-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /^surface-controller-control$/ }, () => ({ path: 'control', namespace: 'controller-test' }));
      plugin.onResolve({ filter: /^\.\/(surfaceEditPanel|surfaceEditScene|surfaceEditJobs|temporaryWorksScene|machinerySurfacePicker)$/ }, args =>
        Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'controller-test' } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: 'controller-test' }, args => ({ contents: args.path === 'control' ? 'export const control={};' : stubs[args.path], loader: 'js' }));
    } }],
  });
  const filename = join(temporary, 'controller.mjs'); await writeFile(filename, bundled.outputFiles[0].text);
  ({ SurfaceEditController, control } = await import(pathToFileURL(filename).href));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const drain = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
const result = { boundaryPoints: 4, area: 100, surface: {}, walls: {} };
const transform = [...Matrix4.toArray(Matrix4.IDENTITY), ...Matrix4.toArray(Matrix4.IDENTITY)];
function boundary(offset = 0) {
  return [{ longitude: 120 + offset, latitude: 30, height: 10 }, { longitude: 120.0001 + offset, latitude: 30, height: 10 },
    { longitude: 120.0001 + offset, latitude: 30.0001, height: 10 }, { longitude: 120 + offset, latitude: 30.0001, height: 10 }];
}
function plan(id = 'p1', extra = {}) {
  return { version: 1, id, name: id, kind: 'excavation', targetId: 'photo', targetTransform: [...transform], boundary: boundary(), holes: [],
    targetHeight: 0, clipTerrain: true, bottomVisible: true, texture: { ground: 'soil', wall: 'soil', scaleMeters: 2 },
    enabled: true, createdAt: '2026-11-12T12:00:00.000Z', updatedAt: '2026-11-12T12:00:00.000Z', ...extra };
}
const draft = (source = 'picked') => ({ name: '候选方案', kind: 'excavation', targetId: 'photo', targetHeight: 0, clipTerrain: true,
  bottomVisible: true, texture: { ground: 'soil', wall: 'soil', scaleMeters: 2 }, boundarySource: source, boundaryHeight: 10 });
function handle(label = 'candidate') {
  return { label, status: { state: 'ready', message: '已显示' }, enabled: false, activations: [], destroyed: 0,
    setEnabled(value) { this.activations.push(value); this.enabled = value; return this.status; },
    destroy() { this.destroyed++; this.enabled = false; }, zoom() {} };
}
function fixture(plans = []) {
  for (const key of Object.keys(control)) delete control[key];
  Object.assign(control, { jobs: [], prepares: [], surfaces: [], refinements: [], estimates: [],
    jobFn: async () => result, prepareFn: async () => handle(), refineFn: async rings => rings });
  const state = { context: 'A', editable: true, changed: 0, toasts: [], saves: [], targets: [], saved: new Map(), saveError: undefined, feedback: undefined };
  state.targets = [{ id: 'photo', name: '摄影', tileset: { modelMatrix: Matrix4.clone(Matrix4.IDENTITY), root: { transform: Matrix4.clone(Matrix4.IDENTITY) }, isDestroyed: () => false, show: true } }];
  const viewer = { dataSources: { add: async source => source, remove: () => true }, isDestroyed: () => false };
  const root = { classList: { add() {}, remove() {} } };
  const controller = new SurfaceEditController({ viewer, root, getTargets: () => state.targets, getContext: () => state.context,
    canEdit: () => state.editable, beginInteractionSession: () => () => {}, onChanged: () => { state.changed++; state.feedback?.(); },
    toast: (...args) => state.toasts.push(args) });
  controller.store = {
    load(context) { return structuredClone(state.saved.get(context) ?? []); },
    save(context, next) { if (state.saveError) throw state.saveError; state.saves.push({ context, plans: structuredClone(next) }); state.saved.set(context, structuredClone(next)); },
  };
  controller.context = 'A'; controller.editable = true; controller.plans = structuredClone(plans);
  controller.boundary = boundary(); controller.holes = [];
  return { controller, state, panel: controller.panel, cleanup() { controller.destroy(); } };
}

test('empty restoration and onChanged feedback do not create a notification loop', async () => {
  const f = fixture();
  try {
    f.state.feedback = () => { if (f.state.changed > 4) throw new Error('notification loop'); f.controller.refreshTargets(); };
    f.controller.refreshTargets(); await drain();
    assert.equal(f.state.changed, 0); assert.equal(control.jobs.length, 0);
    f.state.context = 'B'; f.controller.setContext('B', true); await drain();
    assert.equal(f.state.changed, 1, 'only the context change is published');
  } finally { f.cleanup(); }
});

test('aborted restoration releases its attempt and a later refresh retries successfully', async () => {
  const f = fixture([plan()]), pending = deferred(), candidate = handle();
  try {
    control.jobFn = (_input, signal) => { signal.addEventListener('abort', () => pending.reject(new DOMException('cancelled', 'AbortError')), { once: true }); return pending.promise; };
    f.controller.refreshTargets(); await drain(); assert.equal(control.jobs.length, 1);
    f.controller.cancel(); await drain(); assert.equal(f.controller.attempts.has('p1'), false);
    control.jobFn = async () => result; control.prepareFn = async () => candidate;
    f.controller.refreshTargets(); await drain();
    assert.equal(control.jobs.length, 2); assert.deepEqual(candidate.activations, [true]); assert.equal(f.controller.handles.get('p1'), candidate);
  } finally { f.cleanup(); }
});

test('a hidden override while restore waits prevents candidate activation', async () => {
  const f = fixture([plan()]), pending = deferred(), candidate = handle();
  try {
    control.prepareFn = () => pending.promise;
    f.controller.refreshTargets(); await drain(); assert.equal(control.prepares.length, 1);
    f.controller.setPlanVisible('p1', false); pending.resolve(candidate); await drain();
    assert.deepEqual(candidate.activations, []); assert.equal(candidate.destroyed, 1); assert.equal(f.controller.handles.size, 0);
  } finally { f.cleanup(); }
});

test('edit-permission loss discards old restore and allows a fresh readonly restore', async () => {
  const f = fixture([plan()]), pending = deferred(), cancelled = handle('cancelled'), readonly = handle('readonly');
  try {
    control.prepareFn = () => control.prepares.length === 1 ? pending.promise : Promise.resolve(readonly);
    f.controller.refreshTargets(); await drain(); assert.equal(control.prepares.length, 1);
    f.state.editable = false; f.controller.setContext('A', false);
    assert.equal(control.prepares[0][4].aborted, true);
    pending.resolve(cancelled); await drain();
    assert.deepEqual(cancelled.activations, []); assert.equal(cancelled.destroyed, 1);
    assert.equal(control.prepares.length, 2); assert.deepEqual(readonly.activations, [true]);
    assert.equal(f.controller.handles.get('p1'), readonly); assert.equal(f.state.saves.length, 0);
  } finally { f.cleanup(); }
});

for (const change of ['view-permission', 'project']) {
  test(`${change} change while restore waits never activates stale geometry`, async () => {
    const f = fixture([plan()]), pending = deferred(), candidate = handle();
    try {
      control.prepareFn = () => pending.promise;
      f.controller.refreshTargets(); await drain(); assert.equal(control.prepares.length, 1);
      f.state.context = change === 'view-permission' ? null : 'B';
      f.controller.setContext(f.state.context, change !== 'view-permission');
      pending.resolve(candidate); await drain();
      assert.deepEqual(candidate.activations, []); assert.equal(candidate.destroyed, 1);
      assert.equal(control.prepares.length, 1); assert.equal(f.state.saves.length, 0);
    } finally { f.cleanup(); }
  });
}

test('a generation belonging to project A cannot persist or activate after project B opens', async () => {
  const f = fixture(), pending = deferred(), candidate = handle();
  try {
    control.prepareFn = () => pending.promise;
    const generating = f.controller.generate(draft()); await drain(); assert.equal(control.prepares.length, 1);
    f.state.context = 'B'; f.controller.setContext('B', true); pending.resolve(candidate); await generating; await drain();
    assert.equal(f.state.saves.length, 0); assert.deepEqual(candidate.activations, []); assert.equal(candidate.destroyed, 1);
    assert.equal(f.controller.context, 'B'); assert.deepEqual(f.controller.plans, []);
  } finally { f.cleanup(); }
});

test('quota failure destroys candidate and preserves previous saved plan and live handle', async () => {
  const saved = plan(), f = fixture([saved]), previous = handle('previous'), candidate = handle();
  try {
    previous.enabled = true; f.controller.handles.set(saved.id, previous); f.controller.editingId = saved.id;
    f.state.saveError = new DOMException('quota full', 'QuotaExceededError'); control.prepareFn = async () => candidate;
    await f.controller.generate(draft());
    assert.deepEqual(candidate.activations, [true]); assert.equal(candidate.destroyed, 1);
    assert.equal(previous.destroyed, 0); assert.equal(previous.enabled, true); assert.equal(f.controller.handles.get(saved.id), previous);
    assert.deepEqual(f.controller.plans, [saved]); assert.equal(f.state.saves.length, 0);
    assert.match(f.panel.statusHistory.at(-1).message, /quota/);
  } finally { f.cleanup(); }
});

test('plan-count and cumulative boundary budgets reject before starting any photogrammetry sampling', async () => {
  const cases = [
    Array.from({ length: 32 }, (_, i) => plan(`p${i}`, { enabled: false, boundary: boundary(i * 0.001) })),
    Array.from({ length: 8 }, (_, i) => plan(`p${i}`, { enabled: false, boundary: Array.from({ length: 512 }, (_, j) => ({ longitude: 121 + i * 0.001 + Math.cos(j / 512 * Math.PI * 2) * 0.0001, latitude: 30 + Math.sin(j / 512 * Math.PI * 2) * 0.0001, height: 10 })) })),
  ];
  for (const plans of cases) {
    const f = fixture(plans);
    try {
      await f.controller.generate(draft('sampled'));
      assert.equal(control.surfaces.length, 0); assert.equal(control.refinements.length, 0); assert.equal(control.jobs.length, 0);
      assert.equal(f.state.saves.length, 0); assert.match(f.panel.statusHistory.at(-1).message, /上限|超限/);
    } finally { f.cleanup(); }
  }
});

test('old sample progress does not change the panel of a newly opened project', async () => {
  const f = fixture(), pending = deferred(); let progress;
  try {
    control.refineFn = (_rings, _sample, signal, listener) => { progress = listener; signal.addEventListener('abort', () => pending.reject(new DOMException('cancelled', 'AbortError')), { once: true }); return pending.promise; };
    const generating = f.controller.generate(draft('sampled')); await drain(); assert.equal(typeof progress, 'function');
    f.state.context = 'B'; f.controller.setContext('B', true); f.panel.setBusy('B 项目任务');
    progress({ message: 'A 项目迟到进度' }); await generating; await drain();
    assert.equal(f.panel.busyHistory.at(-1), 'B 项目任务'); assert.equal(f.panel.busyHistory.includes('A 项目迟到进度'), false);
    assert.equal(f.state.saves.length, 0);
  } finally { f.cleanup(); }
});

test('changing the active draft cancels generation and discards its late prepared candidate', async () => {
  const f = fixture(), pending = deferred(), candidate = handle();
  try {
    control.prepareFn = () => pending.promise;
    const generating = f.controller.generate(draft()); await drain();
    f.panel.options.onDraftChanged(); pending.resolve(candidate); await generating;
    assert.deepEqual(candidate.activations, []); assert.equal(candidate.destroyed, 1); assert.equal(f.state.saves.length, 0);
  } finally { f.cleanup(); }
});
