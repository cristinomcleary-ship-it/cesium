import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Cartesian2, Cartesian3, CustomDataSource, Event, Matrix4, Model,
  ScreenSpaceEventType, Transforms,
} from 'cesium';
import { SubsurfaceTools } from '../src/subsurfaceTools.ts';

function fixture() {
  const originalDocument = globalThis.document;
  const inputs = new Map([
    ['#sectionEnabled', { checked: true }],
    ['#sectionDirection', { value: 'northSouth' }],
    ['#sectionInvert', { checked: false }],
    ['#sectionOffset', { value: '0' }],
    ['#clipExcavationSurface', { checked: false }],
    ['#sectionPointStatus', { textContent: '' }],
  ]);
  globalThis.document = { querySelector: selector => inputs.get(selector) };
  const preUpdate = new Event(), actions = new Map(), notifications = [], picks = [];
  let destroyed = false, requested = 0;
  const models = [];
  const makeModel = () => {
    const model = Object.assign(Object.create(Model.prototype), {
      modelMatrix: Matrix4.clone(Matrix4.IDENTITY), _drawCommandsBuilt: true,
    });
    models.push(model);
    return model;
  };
  const model = makeModel();
  let items = [{ id: 'first', kind: 'Model', resource: model }];
  const picked = Cartesian3.fromDegrees(120, 30, 50);
  const scene = {
    preUpdate, globe: {}, pickPositionSupported: true, pickTranslucentDepth: false,
    requestRender: () => { requested++; },
    isDestroyed: () => destroyed,
    pick() {
      // Observe the same-event pick's input state; do not fake a texture or GPU result.
      picks.push(model.clippingPlanes);
      return { primitive: model };
    },
    pickPosition: () => Cartesian3.clone(picked),
  };
  const viewer = { scene, isDestroyed: () => destroyed };
  const tools = Object.assign(Object.create(SubsurfaceTools.prototype), {
    viewer, imports: () => items,
    notify: (message, error = false) => notifications.push({ message, error }),
    overlay: new CustomDataSource('section-scheduling-test'),
    handler: { setInputAction: (callback, type) => actions.set(type, callback) },
    interactionMode: null, interactionSuspensionDepth: 0,
    sectionAnchor: Cartesian3.clone(picked),
    excavationFinished: false, excavationPoints: [], excavationPointSources: [],
    clippingTargets: new Map(), excavationClipTargets: new Map(),
  });
  return {
    tools, viewer, scene, preUpdate, inputs, model, picked, picks, actions, notifications,
    makeModel, requests: () => requested,
    setImports: next => { items = next; },
    destroyViewer: () => { destroyed = true; },
    close() {
      try {
        tools.clearSectionClipping();
        const collections = new Set([
          scene.globe.clippingPlanes, scene.globe.clippingPolygons,
          ...tools.clippingTargets.values(), ...tools.excavationClipTargets.values(),
          ...models.flatMap(item => [item.clippingPlanes, item.clippingPolygons]),
        ]);
        for (const collection of collections) if (collection && !collection.isDestroyed()) collection.destroy();
        tools.overlay.entities.removeAll();
        actions.clear();
      } finally {
        globalThis.document = originalDocument;
      }
    },
  };
}

test('refreshClipping defers new plane ownership until preUpdate so same-event picks see no new collection', () => {
  const f = fixture();
  try {
    f.tools.refreshClipping();
    f.scene.pick(new Cartesian2(12, 16));
    f.scene.pick(new Cartesian2(12, 16));
    assert.deepEqual(f.picks, [undefined, undefined]);
    assert.equal(f.model.clippingPlanes, undefined);
    assert.equal(f.preUpdate.numberOfListeners, 1);
    assert.ok(f.requests() > 0, 'scheduling must wake request-render scenes');

    f.preUpdate.raiseEvent(f.scene);
    const collection = f.model.clippingPlanes;
    assert.ok(collection);
    assert.equal(collection.enabled, true);
    assert.equal(collection.length, 1);
    assert.equal(f.preUpdate.numberOfListeners, 0, 'the apply listener is one-shot');
    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.model.clippingPlanes, collection);
  } finally { f.close(); }
});

test('the real section LEFT_CLICK handler updates its UI but defers planes past both later pick handlers', () => {
  const f = fixture();
  try {
    f.inputs.get('#sectionEnabled').checked = false;
    f.tools.sectionAnchor = null;
    f.tools.interactionMode = 'section';
    f.tools.bindMapInteraction();
    const onClick = f.actions.get(ScreenSpaceEventType.LEFT_CLICK);
    assert.equal(typeof onClick, 'function');
    onClick({ position: new Cartesian2(50, 80) });
    assert.ok(f.requests() > 0, 'the click scheduler must request a normal frame without refreshClipping side effects');
    assert.equal(f.inputs.get('#sectionEnabled').checked, true);
    assert.equal(f.tools.interactionMode, null);
    assert.ok(Cartesian3.equals(f.tools.sectionAnchor, f.picked));
    assert.match(f.inputs.get('#sectionPointStatus').textContent, /剖面位置：.*倾斜摄影\/模型表面/);
    assert.equal(f.scene.pickTranslucentDepth, false, 'surface picking restores its previous depth preference');
    f.scene.pick(new Cartesian2(50, 80));
    f.scene.pick(new Cartesian2(50, 80));
    assert.deepEqual(f.picks, [undefined, undefined, undefined]);
    assert.equal(f.preUpdate.numberOfListeners, 1);

    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.model.clippingPlanes.length, 1);
    assert.equal(f.preUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('multiple refreshes coalesce and apply the latest anchor, input values and current imports', () => {
  const f = fixture();
  try {
    f.tools.refreshClipping();
    const current = f.makeModel();
    const latestAnchor = Cartesian3.fromDegrees(120.002, 30.003, 75);
    f.setImports([{ id: 'replacement', kind: 'Model', resource: current }]);
    f.tools.sectionAnchor = latestAnchor;
    f.inputs.get('#sectionDirection').value = 'eastWest';
    f.inputs.get('#sectionOffset').value = '37';
    f.tools.refreshClipping();
    f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 1);
    assert.equal(f.model.clippingPlanes, undefined);
    assert.equal(current.clippingPlanes, undefined);

    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.model.clippingPlanes, undefined, 'an import removed before the frame must not be touched');
    const collection = current.clippingPlanes;
    assert.ok(collection);
    assert.ok(Cartesian3.equals(collection.get(0).normal, Cartesian3.UNIT_Y));
    assert.equal(collection.get(0).distance, -37);
    assert.ok(Matrix4.equals(collection.modelMatrix, Transforms.eastNorthUpToFixedFrame(latestAnchor)));
    assert.equal(f.preUpdate.numberOfListeners, 0);
    f.tools.refreshClipping();
    f.tools.sectionAnchor = null;
    f.preUpdate.raiseEvent(f.scene);
    assert.equal(collection.enabled, false, 'the scheduled callback must recheck a cleared anchor');
    assert.equal(f.preUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});

test('closing before the frame cancels pending work and a later reopening can schedule again', () => {
  const f = fixture();
  try {
    f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 1);
    f.inputs.get('#sectionEnabled').checked = false;
    f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 0);
    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.model.clippingPlanes, undefined);

    f.inputs.get('#sectionEnabled').checked = true;
    f.tools.refreshClipping();
    f.inputs.get('#sectionEnabled').checked = false;
    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.model.clippingPlanes, undefined, 'the callback must recheck the latest checkbox without a refresh');
    assert.equal(f.preUpdate.numberOfListeners, 0);

    f.inputs.get('#sectionEnabled').checked = true;
    f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 1);
    f.preUpdate.raiseEvent(f.scene);
    const collection = f.model.clippingPlanes;
    assert.ok(collection);
    assert.equal(collection.enabled, true);
    const originalDistance = collection.get(0).distance;
    f.inputs.get('#sectionOffset').value = '19';
    f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 1);
    f.tools.clearSectionClipping();
    assert.equal(f.preUpdate.numberOfListeners, 0);
    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.model.clippingPlanes, collection);
    assert.equal(collection.enabled, false);
    assert.equal(collection.get(0).distance, originalDistance, 'a cancelled update must not apply its queued offset');
  } finally { f.close(); }
});

test('a viewer destroyed before the scheduled frame releases the callback without applying clipping', () => {
  const f = fixture();
  try {
    f.tools.refreshClipping();
    assert.equal(f.preUpdate.numberOfListeners, 1);
    f.destroyViewer();
    assert.doesNotThrow(() => f.preUpdate.raiseEvent(f.scene));
    assert.equal(f.preUpdate.numberOfListeners, 0);
    assert.equal(f.model.clippingPlanes, undefined);
    assert.equal(f.tools.clippingTargets.size, 0);
  } finally { f.close(); }
});

test('a deferred apply failure is reported without escaping preUpdate and later work can retry', () => {
  const f = fixture();
  try {
    const originalImports = f.tools.imports;
    f.tools.imports = () => { throw new Error('section-scheduling-apply-failure'); };
    assert.doesNotThrow(() => f.tools.refreshClipping(), 'the failure must not occur in the UI event');
    assert.equal(f.preUpdate.numberOfListeners, 1);
    assert.doesNotThrow(() => f.preUpdate.raiseEvent(f.scene), 'preUpdate errors would stop the normal render loop');
    assert.equal(f.preUpdate.numberOfListeners, 0);
    assert.equal(f.model.clippingPlanes, undefined);
    assert.ok(f.notifications.some(item => item.error && /section-scheduling-apply-failure/.test(item.message)));
    const count = f.notifications.length;
    f.preUpdate.raiseEvent(f.scene);
    assert.equal(f.notifications.length, count, 'a failed callback must not remain attached');
    f.tools.imports = originalImports;
    f.tools.refreshClipping();
    f.preUpdate.raiseEvent(f.scene);
    assert.ok(f.model.clippingPlanes);
    assert.equal(f.preUpdate.numberOfListeners, 0);
  } finally { f.close(); }
});
