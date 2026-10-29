import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadMachineryAsset, defaultMachineryParameters, resolveMachineryParameters, type LoadedMachineryAsset } from './machinery/index';
import { MACHINERY_ASSET_VERSION, type MachineryMetadata } from './machineryTypes';
import { defaultMachineryTelemetryConfig } from './machineryTelemetry';
import { MachineryTelemetryController, type TelemetryContext } from './machineryTelemetryController';

let assetPromise: Promise<LoadedMachineryAsset> | undefined;
const asset = () => assetPromise ??= loadMachineryAsset('crane', {
  baseUrl: new URL('../public/machinery/', import.meta.url).href,
  fetcher: async input => new Response(new Uint8Array(await readFile(fileURLToPath(String(input))))),
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function state(model: LoadedMachineryAsset): MachineryMetadata {
  return { schemaVersion: 1, assetId: 'crane', assetVersion: MACHINERY_ASSET_VERSION, proportional: true,
    parameters: defaultMachineryParameters(model), placement: { longitude: 120, latitude: 30, height: 0, heading: 0 }, visible: true };
}
function context(model: LoadedMachineryAsset, projectId = 'project-a', actorId = 'actor-a'): TelemetryContext {
  return { projectId, actorId, canView: true, canEdit: true, active: true,
    records: ['machine-a', 'machine-b'].map(id => ({ id, state: state(model) })) };
}
function config(projectId = 'project-a', resourceId = 'machine-a', target = 'heading') {
  return { ...defaultMachineryTelemetryConfig(projectId, resourceId), bindings: [
    { target, enabled: true, sourceId: 'browser-sim', sourceField: target, scale: 1, offset: 0 },
  ] };
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function snapshot(projectId: string, frames: unknown[] = [], cursor = 0) {
  return Response.json({ schemaVersion: 1, projectId, streamId: 'test-stream', cursor, reset: false, frames });
}

test('disabled telemetry owns no polling or simulation traffic and never publishes changed machine values', async t => {
  const model = await asset(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [], publications: ReadonlyMap<string, MachineryMetadata>[] = [];
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: async () => model,
    onLiveStatesChange: values => publications.push(values), fetcher: async input => { calls.push(String(input)); return snapshot('project-a'); } });
  try {
    controller.setContext(context(model));
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(calls, []); assert.equal(controller.enabledCount, 0);
    assert.ok(publications.every(values => values.size === 0));
    controller.destroy(); t.mock.timers.tick(30_000); await flush(); assert.deepEqual(calls, []);
  } finally { controller.destroy(); }
});

test('one poll delivers independent devices; disabling the last device and destroy stop all requests', async t => {
  const model = await asset(); t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0; const publications: ReadonlyMap<string, MachineryMetadata>[] = [];
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: async () => model,
    onLiveStatesChange: values => publications.push(values), fetcher: async () => {
      requests++;
      return snapshot('project-a', ['machine-a', 'machine-b'].map((resourceId, index) => ({
        schemaVersion: 1, projectId: 'project-a', resourceId, sourceId: 'browser-sim',
        timestamp: new Date().toISOString(), mode: 'simulated', values: { heading: 90 + index * 90 },
      })), requests);
    } });
  try {
    controller.setContext(context(model));
    await controller.configure('machine-a', config());
    await controller.configure('machine-b', config('project-a', 'machine-b'));
    t.mock.timers.tick(0); await flush();
    assert.equal(requests, 1); assert.equal(controller.getState('machine-a')?.placement.heading, 90);
    assert.equal(controller.getState('machine-b')?.placement.heading, 180);
    assert.equal(publications.at(-1)?.size, 2);
    const retained = controller.disable('machine-a'); assert.equal(retained?.placement.heading, 90);
    assert.equal(controller.enabledCount, 1);
    controller.disable('machine-b'); const before = requests;
    t.mock.timers.tick(30_000); await flush(); assert.equal(requests, before);
    controller.destroy(); t.mock.timers.tick(30_000); await flush(); assert.equal(requests, before);
  } finally { controller.destroy(); }
});

test('a late GET from the previous actor/project cannot apply and does not strand polling in the new context', async t => {
  const model = await asset(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldRequest = deferred<Response>(), seen: string[] = [];
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: async () => model,
    onLiveStatesChange: () => {}, fetcher: async input => {
      const project = new URL(String(input), 'http://test').searchParams.get('projectId')!; seen.push(project);
      if (project === 'project-a') return oldRequest.promise;
      return snapshot(project, [{ schemaVersion: 1, projectId: project, resourceId: 'machine-a', sourceId: 'browser-sim',
        timestamp: new Date().toISOString(), mode: 'simulated', values: { heading: 180 } }], 1);
    } });
  try {
    controller.setContext(context(model)); await controller.configure('machine-a', config());
    t.mock.timers.tick(0); await flush(); assert.deepEqual(seen, ['project-a']);
    controller.setContext(context(model, 'project-b', 'actor-b'));
    await controller.configure('machine-a', config('project-b'));
    oldRequest.resolve(snapshot('project-a', [{ schemaVersion: 1, projectId: 'project-a', resourceId: 'machine-a', sourceId: 'browser-sim',
      timestamp: new Date().toISOString(), mode: 'simulated', values: { heading: 270 } }], 1));
    await flush(); t.mock.timers.tick(1001); await flush();
    assert.ok(seen.includes('project-b'), 'new runtime schedules after the aborted old poll settles');
    assert.equal(controller.getState('machine-a')?.placement.heading, 180);
  } finally { oldRequest.resolve(snapshot('project-a')); controller.destroy(); }
});

test('a deferred asset load cannot activate a deleted resource or persist after edit permission is revoked', async () => {
  const model = await asset();
  for (const revoke of ['resource', 'permission'] as const) {
    const loading = deferred<LoadedMachineryAsset>();
    const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: () => loading.promise,
      onLiveStatesChange: () => {}, fetcher: async () => snapshot('project-a') });
    try {
      const initial = context(model); controller.setContext(initial);
      const activation = controller.configure('machine-a', config());
      controller.setContext(revoke === 'resource' ? { ...initial, records: [] } : { ...initial, canEdit: false });
      loading.resolve(model); await assert.rejects(activation, /资源|权限/);
      assert.equal(controller.enabledCount, 0);
    } finally { loading.resolve(model); controller.destroy(); }
  }
});

test('activation uses the newest saved initialization when parameters change during asset loading', async () => {
  const model = await asset(), loading = deferred<LoadedMachineryAsset>();
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: () => loading.promise,
    onLiveStatesChange: () => {}, fetcher: async () => snapshot('project-a') });
  try {
    const initial = context(model); controller.setContext(initial);
    const activation = controller.configure('machine-a', config());
    const updated = structuredClone(initial); updated.records[0].state.placement.heading = 150;
    controller.setContext(updated); loading.resolve(model); await activation;
    assert.equal(controller.getState('machine-a')?.placement.heading, 150);
  } finally { loading.resolve(model); controller.destroy(); }
});

test('the simulator uses the actual POST endpoint and stops producing frames after stop or destroy', async t => {
  const model = await asset(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts: Record<string, unknown>[] = [];
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: async () => model,
    onLiveStatesChange: () => {}, fetcher: async (input, init) => {
      if (init?.method === 'POST') {
        assert.equal(String(input), '/__management/machinery-telemetry');
        assert.equal((init.headers as Record<string, string>)['x-cesium-library'], '1');
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); return Response.json({ accepted: true }, { status: 202 });
      }
      return snapshot('project-a');
    } });
  try {
    controller.setContext(context(model)); await controller.configure('machine-a', config());
    controller.startSimulation('machine-a'); await flush();
    assert.equal(posts.length, 1); assert.equal(posts[0].mode, 'simulated'); assert.equal(posts[0].sourceId, 'browser-sim');
    controller.stopSimulation('machine-a'); t.mock.timers.tick(5000); await flush(); assert.equal(posts.length, 1);
    controller.startSimulation('machine-a'); await flush(); assert.equal(posts.length, 2);
    controller.destroy(); t.mock.timers.tick(5000); await flush(); assert.equal(posts.length, 2);
  } finally { controller.destroy(); }
});

test('a single incompatible saved-scale update cannot throw through workspace context synchronization', async () => {
  const model = await asset(), original = context(model);
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: async () => model,
    onLiveStatesChange: () => {}, fetcher: async () => snapshot('project-a') });
  try {
    controller.setContext(original); await controller.configure('machine-a', config('project-a', 'machine-a', 'boom_length_m'));
    const scaled = state(model); scaled.parameters = resolveMachineryParameters(model, scaled.parameters, { overall_scale: 10 }, { proportional: true });
    assert.doesNotThrow(() => controller.setContext({ ...original, records: [{ id: 'machine-a', state: scaled }] }));
  } finally { controller.destroy(); }
});

test('a half-open GET times out and a subsequent poll resumes without resetting the last pose', async t => {
  const model = await asset(); t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const controller = new MachineryTelemetryController({ storage: storage(), loadAsset: async () => model,
    onLiveStatesChange: () => {}, fetcher: async (_input, init) => {
      requests++;
      if (requests === 2) return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
      return snapshot('project-a', [{ schemaVersion: 1, projectId: 'project-a', resourceId: 'machine-a', sourceId: 'browser-sim',
        timestamp: new Date().toISOString(), mode: 'simulated', values: { heading: 90 } }], requests);
    } });
  try {
    controller.setContext(context(model)); await controller.configure('machine-a', config());
    t.mock.timers.tick(0); await flush(); assert.equal(controller.getState('machine-a')?.placement.heading, 90);
    t.mock.timers.tick(1001); await flush(); assert.equal(requests, 2);
    t.mock.timers.tick(5001); await flush(); assert.match(controller.status, /5 秒/);
    assert.equal(controller.getState('machine-a')?.placement.heading, 90);
    t.mock.timers.tick(1001); await flush(); assert.equal(requests, 3); assert.match(controller.status, /接口已连接/);
  } finally { controller.destroy(); }
});

for (const status of [401, 403]) test(`HTTP ${status} clears every live pose, stops simulation and persists disabled bindings`, async t => {
  const model = await asset(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = storage(), publications: ReadonlyMap<string, MachineryMetadata>[] = [];
  let gets = 0, posts = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ accepted: true }, { status: 202 }); }
    gets++;
    if (gets > 1) return Response.json({ error: 'Access revoked' }, { status });
    return snapshot('project-a', ['machine-a', 'machine-b'].map(resourceId => ({
      schemaVersion: 1, projectId: 'project-a', resourceId, sourceId: 'browser-sim',
      timestamp: new Date().toISOString(), mode: 'simulated', values: { heading: 90 },
    })), 1);
  };
  const controller = new MachineryTelemetryController({ storage: saved, loadAsset: async () => model,
    onLiveStatesChange: values => publications.push(values), fetcher });
  let restored: MachineryTelemetryController | undefined;
  try {
    const initial = context(model); controller.setContext(initial);
    await controller.configure('machine-a', config());
    await controller.configure('machine-b', config('project-a', 'machine-b'));
    t.mock.timers.tick(0); await flush();
    assert.equal(controller.getState('machine-a')?.placement.heading, 90);
    assert.equal(controller.getState('machine-b')?.placement.heading, 90);
    controller.startSimulation('machine-a'); await flush(); assert.equal(posts, 1);
    // The workspace still holds its old permission snapshot. HTTP revocation alone
    // must immediately clear live data and stop network/simulation work.
    t.mock.timers.tick(1001); await flush();
    assert.equal(controller.enabledCount, 0); assert.equal(controller.isSimulating('machine-a'), false);
    assert.equal(controller.getState('machine-a'), undefined); assert.equal(controller.getState('machine-b'), undefined);
    assert.equal(publications.at(-1)?.size, 0); assert.match(controller.status, /访问权限已变更/);
    const counts = [gets, posts]; t.mock.timers.tick(30_000); await flush(); assert.deepEqual([gets, posts], counts);
    controller.destroy();
    restored = new MachineryTelemetryController({ storage: saved, loadAsset: async () => model, onLiveStatesChange: () => {}, fetcher });
    restored.setContext(initial); await flush(); t.mock.timers.tick(30_000); await flush();
    assert.equal(restored.enabledCount, 0); assert.deepEqual([gets, posts], counts, 'revoked bindings cannot auto-enable on page reload');
    assert.deepEqual(restored.getConfig('machine-a').bindings, config().bindings);
    assert.deepEqual(restored.getConfig('machine-b').bindings, config('project-a', 'machine-b').bindings);
  } finally { controller.destroy(); restored?.destroy(); }
});
