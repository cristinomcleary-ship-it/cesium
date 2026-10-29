import type { Viewer } from 'cesium';

export type SceneVideoReadyOptions = {
  signal: AbortSignal;
  timeoutMs?: number;
  /** Optional camera preparation shares the same bounded, cancellable wait. */
  prepare?: (signal: AbortSignal) => void | Promise<void>;
};
/** Public readiness/frame APIs only. It owns no listener or timer after settle/cancel. */
export function waitForSceneVideoReady(viewer: Viewer, options: SceneVideoReadyOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('场景准备等待时长无效'));
  return new Promise((resolve, reject) => {
    let settled = false, consecutiveReadyFrames = 0;
    let removeFrame: (() => void) | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const preparation = new AbortController();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; removeFrame?.(); clearTimeout(deadline);
      if (requestTimer !== undefined) clearTimeout(requestTimer);
      options.signal.removeEventListener('abort', cancel);
      if (error !== undefined) {
        preparation.abort(error);
        reject(error instanceof Error ? error : new Error('录像准备已取消'));
      } else resolve();
    };
    const cancel = () => finish(options.signal.reason instanceof Error ? options.signal.reason : new Error('录像准备已取消'));
    const deadline = setTimeout(() => finish(new Error('机械或场景仍在加载，等待已超过 20 秒；请稍后重新开始录像')), timeoutMs);
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) { cancel(); return; }
    const requestFrame = () => {
      if (settled) return;
      if (viewer.isDestroyed()) { finish(new Error('三维场景已关闭')); return; }
      try { viewer.scene.requestRender(); }
      catch (error) { finish(error); return; }
      // This pulse is local to preparation; requestRenderMode itself is unchanged.
      if (!settled) requestTimer = setTimeout(requestFrame, 50);
    };
    void (async () => {
      try {
        await options.prepare?.(preparation.signal);
        if (settled) return;
        if (viewer.isDestroyed()) { finish(new Error('三维场景已关闭')); return; }
        removeFrame = viewer.scene.postRender.addEventListener(() => {
          if (settled) return;
          if (viewer.isDestroyed()) { finish(new Error('三维场景已关闭')); return; }
          consecutiveReadyFrames = viewer.dataSourceDisplay.ready ? consecutiveReadyFrames + 1 : 0;
          if (consecutiveReadyFrames >= 2) finish();
        });
        requestFrame();
      } catch (error) { finish(error); }
    })();
  });
}
