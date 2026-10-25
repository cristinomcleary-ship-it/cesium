import assert from 'node:assert/strict';
import test from 'node:test';
import { Event } from 'cesium';
import { installRenderErrorRecovery, renderErrorDetails, renderErrorSummaryHtml } from './renderErrorRecovery.ts';

function fixture() {
  const renderError = new Event(), postRender = new Event();
  let destroyed = false, repaired = 1, time = 0, contextAlive = true;
  let requests = 0, repairs = 0, recovered = 0, recovering = 0, records = 0;
  let repairError: unknown, requestError: unknown;
  const failures: string[] = [], jobs = new Map<number, () => void>();
  let nextJob = 0;
  const viewer = { isDestroyed: () => destroyed, useDefaultRenderLoop: true,
    scene: { renderError, postRender, requestRender() { requests++; if (requestError) throw requestError; } } };
  // CesiumWidget registers this before the application's listener.
  renderError.addEventListener(() => { viewer.useDefaultRenderLoop = false; });
  const dispose = installRenderErrorRecovery(viewer, {
    record() { records++; },
    repair() { repairs++; if (repairError) throw repairError; return repaired; },
    failure(_error, details) { failures.push(details); },
    recovering() { recovering++; }, recovered() { recovered++; },
    canResume: () => contextAlive, now: () => time,
    schedule(callback) { const id = ++nextJob; jobs.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel(handle) { jobs.delete(handle as unknown as number); },
  });
  return {
    viewer, failures, dispose, jobs,
    error: (error: unknown = new Error('This object was destroyed, i.e., destroy() was called.')) => renderError.raiseEvent(viewer.scene, error),
    frame: () => postRender.raiseEvent(),
    flush() { for (const [id, callback] of [...jobs]) { jobs.delete(id); callback(); } },
    setRepaired: (value: number) => { repaired = value; },
    setTime: (value: number) => { time = value; },
    loseContext: () => { contextAlive = false; },
    destroy: () => { destroyed = true; },
    breakRepair: () => { repairError = new Error('repair failed'); },
    breakRequest: () => { requestError = new Error('request failed'); },
    stats: () => ({ requests, repairs, recovered, recovering, records, frames: postRender.numberOfListeners }),
  };
}

test('unknown exceptions stay visible and never remove scene resources or restart the loop', () => {
  const f = fixture();
  f.error(new TypeError('Cannot read properties of undefined'));
  f.flush(); f.frame();
  assert.equal(f.stats().repairs, 0); assert.equal(f.stats().requests, 0);
  assert.equal(f.stats().recovered, 0); assert.equal(f.viewer.useDefaultRenderLoop, false);
  assert.match(f.failures[0], /Cannot read properties/);
});

test('destroyed-object errors without a concrete repair do not enter a retry loop', () => {
  const f = fixture(); f.setRepaired(0); f.error(); f.flush();
  assert.equal(f.stats().repairs, 1); assert.equal(f.stats().requests, 0);
  assert.equal(f.failures.length, 1); assert.equal(f.viewer.useDefaultRenderLoop, false);
});

test('a concrete repair resumes once and reports success only after a rendered frame', () => {
  const f = fixture(); f.error();
  assert.equal(f.stats().recovering, 1); assert.equal(f.stats().recovered, 0);
  assert.equal(f.viewer.useDefaultRenderLoop, false);
  f.flush(); assert.equal(f.viewer.useDefaultRenderLoop, true);
  assert.equal(f.stats().requests, 1); assert.equal(f.stats().recovered, 0);
  f.frame(); f.frame();
  assert.equal(f.stats().recovered, 1); assert.equal(f.stats().frames, 0);
});

test('new fatal errors cancel a pending recovery and stale timer callbacks cannot resume it', () => {
  const f = fixture(); f.error();
  const stale = [...f.jobs.values()][0];
  f.error(new Error('shader compilation failed')); stale(); f.flush(); f.frame();
  assert.equal(f.jobs.size, 0); assert.equal(f.stats().requests, 0);
  assert.equal(f.stats().recovered, 0); assert.equal(f.viewer.useDefaultRenderLoop, false);
});

test('a failing recovery frame cannot report ready later in that same frame', () => {
  const f = fixture(); f.error(); f.flush();
  f.error(new Error('framebuffer is incomplete')); f.frame();
  assert.equal(f.stats().recovered, 0); assert.equal(f.stats().frames, 0);
  assert.equal(f.viewer.useDefaultRenderLoop, false);
});

test('three actual recoveries per five seconds are the limit; no fourth cleanup occurs', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) { f.error(); f.flush(); f.frame(); }
  f.error(); f.flush();
  assert.equal(f.stats().repairs, 3); assert.equal(f.stats().requests, 3);
  assert.match(f.failures[0], /停止连续恢复/);
  f.setTime(5001); f.error(); f.flush(); f.frame();
  assert.equal(f.stats().recovered, 4);
});

test('lost context blocks both repair and delayed restart without changing resources', () => {
  const a = fixture(); a.loseContext(); a.error(); a.flush();
  assert.equal(a.stats().repairs, 0); assert.equal(a.stats().requests, 0);
  const b = fixture(); b.error(); b.loseContext(); b.flush();
  assert.equal(b.stats().requests, 0); assert.equal(b.viewer.useDefaultRenderLoop, false);
});

test('repair and resume exceptions retain the original error and stop safely', () => {
  const a = fixture(); a.breakRepair(); a.error();
  assert.match(a.failures[0], /object was destroyed[\s\S]*repair failed/);
  const b = fixture(); b.breakRequest(); b.error(); b.flush(); b.frame();
  assert.match(b.failures[0], /object was destroyed[\s\S]*request failed/);
  assert.equal(b.stats().recovered, 0); assert.equal(b.stats().frames, 0);
});

test('dispose or viewer destruction cancels delayed work and removes only owned listeners', () => {
  const a = fixture(); a.error(); a.dispose(); a.dispose(); a.flush(); a.frame();
  assert.equal(a.stats().requests, 0); assert.equal(a.stats().frames, 0);
  assert.equal(a.viewer.scene.renderError.numberOfListeners, 1);
  const b = fixture(); b.error(); b.destroy(); b.flush();
  assert.equal(b.stats().requests, 0);
});

test('duplicate failures do not stack dialogs; cross-realm exception detail is retained', () => {
  const f = fixture(); const error = { name: 'RuntimeError', message: 'Shader failed', stack: 'worker.ts:42' };
  f.error(error); f.error(error);
  assert.equal(f.failures.length, 1); assert.equal(f.stats().records, 2);
  assert.equal(renderErrorDetails(error), 'RuntimeError: Shader failed\nworker.ts:42');
  assert.equal(renderErrorDetails('plain failure'), 'plain failure');
  f.setTime(1001); f.error(error);
  assert.equal(f.failures.length, 2, 'a later failure after a user action must remain visible');
});

test('error summaries display file names and server messages as text, never active HTML', () => {
  const details = 'RuntimeError: <img src=x onerror="alert(1)"> & \'model\'\nresource: <script>bad()</script>\nthird';
  assert.equal(renderErrorSummaryHtml(details), 'RuntimeError: &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;model&#39;\nresource: &lt;script&gt;bad()&lt;/script&gt;');
  assert.equal(renderErrorSummaryHtml('x'.repeat(1000)).length, 600);
});
