import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { modelRegistryFixture } from "./safetySpatial.testFixtures.ts";
import type { ModelRegistryEntry } from "./safetySpatialTypes.ts";

// CSS is a Vite side effect; this CPU test exercises the actual controller and request lifecycle.
const css = new URL("./safetyModelOptimization.css", import.meta.url).href;
registerHooks({ load(url, context, next) { return url === css ? { format: "module", shortCircuit: true, source: "export {};" } : next(url, context); } });
const { SafetyModelOptimization } = await import("./safetyModelOptimization.ts");
class Panel {
  className = ""; hidden = true; innerHTML = "";
  listeners = new Map<string, (event: unknown) => void>();
  setAttribute() {} remove() {}
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, listener); }
  click(action: string) { this.listeners.get("click")?.({ target: { closest: () => ({ disabled: false, dataset: { optimize: action } }) } }); }
  select(value: string) { this.listeners.get("change")?.({ target: { matches: () => true, value } }); }
}
function fixture() {
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch, panel = new Panel();
  globalThis.document = { createElement: () => panel } as unknown as Document;
  let models = [modelRegistryFixture()];
  const requests: { signal: AbortSignal; complete: (source: ModelRegistryEntry, ok?: boolean) => void }[] = [];
  globalThis.fetch = ((_url: unknown, options: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ signal: options.signal as AbortSignal, complete: (source, ok = true) => resolve(new Response(JSON.stringify(ok ? {
      id: source.assetVersion, source, activeVersion: source.assetVersion,
      display: { status: "checked", issues: [] }, inventory: { tilesetDocuments: 1, binaryTiles: 1 },
      mesh: { reason: "source processing unavailable" }, texture: { reason: "not inspected" }, candidates: [], capabilities: {},
    } : { error: "read failed" }), { status: ok ? 200 : 500 })) });
  })) as typeof fetch;
  const visibility: boolean[] = [];
  const controller = new SafetyModelOptimization({ host: { append() {} } as unknown as HTMLElement,
    getModels: () => models, onVisibility: visible => visibility.push(visible), onCompare() {} });
  controller.open();
  return { panel, controller, requests, visibility, get models() { return models; }, setModels(value: ModelRegistryEntry[]) { models = value; },
    close() { controller.dispose(); globalThis.document = oldDocument; globalThis.fetch = oldFetch; } };
}
const settle = () => new Promise<void>(done => setImmediate(done));

test("changing model aborts in-flight inspection and an old reply cannot clear the new request", async () => {
  const f = fixture();
  try {
    const first = f.models[0], second = { ...first, assetId: "another-model", assetVersion: "second-version" };
    f.setModels([first, second]); f.panel.click("inspect");
    f.panel.select(second.assetId); assert.equal(f.requests[0].signal.aborted, true);
    f.panel.click("inspect"); assert.equal(f.requests.length, 2);
    f.requests[0].complete(first); await settle();
    assert.equal(f.controller.debugStats().loading, true); assert.equal(f.controller.debugStats().reportId, undefined);
    f.requests[1].complete(second); await settle();
    assert.equal(f.controller.debugStats().loading, false); assert.equal(f.controller.debugStats().activeVersion, second.assetVersion);
  } finally { f.close(); }
});

test("same model with changed current version or transform rejects the earlier successful response", async () => {
  for (const field of ["assetVersion", "coordinateTransformVersion"] as const) {
    const f = fixture();
    try {
      const old = f.models[0]; f.panel.click("inspect"); f.setModels([{ ...old, [field]: "new-value" }]);
      f.requests[0].complete(old); await settle();
      assert.equal(f.controller.debugStats().reportId, undefined); assert.match(String(f.controller.debugStats().error), /版本或坐标变换已变化/);
      assert.equal(f.controller.debugStats().loading, false);
    } finally { f.close(); }
  }
});

test("close aborts inspection, preserves visibility callback, and ignores late failure", async () => {
  const f = fixture();
  try {
    f.panel.click("inspect"); f.controller.close(); assert.equal(f.requests[0].signal.aborted, true);
    f.requests[0].complete(f.models[0], false); await settle();
    assert.deepEqual(f.visibility, [true, false]); assert.equal(f.controller.debugStats().error, "");
    assert.equal(f.controller.debugStats().visible, false); assert.equal(f.controller.debugStats().loading, false);
    f.controller.open(); assert.equal(f.controller.debugStats().reportId, undefined);
  } finally { f.close(); }
});

test("a stored report is invalidated when the active model version changes before reopening", async () => {
  const f = fixture();
  try {
    f.panel.click("inspect"); f.requests[0].complete(f.models[0]); await settle();
    assert.equal(f.controller.debugStats().activeVersion, f.models[0].assetVersion);
    f.controller.close(); f.setModels([{ ...f.models[0], assetVersion: "replacement" }]); f.controller.open();
    assert.equal(f.controller.debugStats().reportId, undefined);
  } finally { f.close(); }
});

test("opening from reality initializes the rendered display comparison state without changing modes", async () => {
  const f = fixture();
  try {
    f.controller.close(); f.controller.open(true);
    f.panel.click("inspect"); f.requests[0].complete(f.models[0]); await settle();
    assert.equal(f.controller.debugStats().originalPreview, true);
    assert.match(f.panel.innerHTML, /data-optimize="original" aria-pressed="true"/);
    assert.match(f.panel.innerHTML, /data-optimize="display" aria-pressed="false"/);
    f.controller.close(); f.controller.open();
    assert.match(f.panel.innerHTML, /data-optimize="original" aria-pressed="false"/);
    assert.match(f.panel.innerHTML, /data-optimize="display" aria-pressed="true"/);
  } finally { f.close(); }
});
