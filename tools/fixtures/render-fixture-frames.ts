type RenderEvent = { addEventListener(listener: () => void): () => void };
type FixtureScene = { postRender: RenderEvent; requestRender(): void };

/** Drive only the requested fixture frames, including an otherwise idle AR scene.
 * Requesting the next frame from postRender preserves requestRenderMode and the
 * application's render-time policy. It does not run a parallel render loop. */
export function renderFixtureFrames(scene: FixtureScene, count: number, errors: () => readonly string[] = () => []): Promise<void> {
  if (!Number.isInteger(count) || count < 1) return Promise.reject(new RangeError('Fixture frame count must be a positive integer'));
  return new Promise<void>((resolve, reject) => {
    let frames = 0, settled = false;
    let stop = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop();
      if (error !== undefined) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Synthetic scene frame timeout (${frames}/${count}): ${errors().join('\n')}`)), 20_000);
    const request = () => {
      try { scene.requestRender(); } catch (error) { finish(error); }
    };
    try {
      stop = scene.postRender.addEventListener(() => {
        if (++frames >= count) finish();
        else request();
      });
      request();
    } catch (error) { finish(error); }
  });
}
