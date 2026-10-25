type SceneEvent<T extends unknown[]> = { addEventListener(listener: (...args: T) => void): () => void };
type RecoveryViewer = {
  isDestroyed(): boolean;
  useDefaultRenderLoop: boolean;
  scene: {
    renderError: SceneEvent<[unknown, unknown]>;
    postRender: SceneEvent<[]>;
    requestRender(): void;
  };
};

export function renderErrorDetails(error: unknown): string {
  // Errors can come from workers or another realm, so do not depend on instanceof.
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    const message = typeof value.message === 'string' ? value.message : '';
    const name = typeof value.name === 'string' ? value.name : 'Error';
    const stack = typeof value.stack === 'string' ? value.stack : '';
    if (stack || message) return [message ? `${name}: ${message}` : '', stack].filter(Boolean).join('\n');
  }
  return String(error);
}

/** CesiumWidget's message argument is HTML; exception text is not markup. */
export function renderErrorSummaryHtml(details: string): string {
  const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return details.split('\n').filter(Boolean).slice(0, 2).join('\n').slice(0, 600)
    .replace(/[&<>"']/g, character => escaped[character]);
}

type RecoveryOptions = {
  record(error: unknown, details: string): void;
  /** Returns only the number of resources actually repaired or detached. */
  repair(): number;
  failure(error: unknown, details: string): void;
  recovering(): void;
  recovered(): void;
  canResume?: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
};

/** A stopped Cesium loop is resumed only after a demonstrated repair. Unknown
 * failures remain visible. A newer failure cancels all work from an older one,
 * and success is reported only after the repaired scene renders a frame.
 * Does not recreate the Viewer, change camera inputs or remove live resources.
 */
export function installRenderErrorRecovery(viewer: RecoveryViewer, options: RecoveryOptions): () => void {
  const recent: number[] = [];
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? (callback => setTimeout(callback, 180));
  const cancel = options.cancel ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeFrame: (() => void) | undefined;
  let generation = 0, disposed = false;
  let lastFailure = '', lastFailureAt = -Infinity;
  const clearPending = () => {
    generation++;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    removeFrame?.(); removeFrame = undefined;
  };
  const fail = (error: unknown, details: string) => {
    if (disposed || viewer.isDestroyed()) return;
    viewer.useDefaultRenderLoop = false;
    // Repeated renderError notifications must not stack identical modal panels.
    if (details === lastFailure && now() - lastFailureAt < 1000) return;
    lastFailure = details; lastFailureAt = now();
    options.failure(error, details);
  };
  const removeError = viewer.scene.renderError.addEventListener((_scene, error) => {
    if (disposed || viewer.isDestroyed()) return;
    clearPending();
    const details = renderErrorDetails(error);
    try { options.record(error, details); }
    catch (diagnosticError) { console.warn('[Cesium diagnostics]', diagnosticError); }
    if (!/object was destroyed|destroy\(\) was called/i.test(details)) { fail(error, details); return; }
    const time = now();
    while (recent.length && recent[0] < time - 5000) recent.shift();
    if (recent.length >= 3) { fail(error, `${details}\n\n已停止连续恢复，请保留错误详情。`); return; }
    try {
      if (options.canResume && !options.canResume()) { fail(error, details); return; }
      const repaired = options.repair();
      if (!Number.isFinite(repaired) || repaired <= 0) { fail(error, details); return; }
      recent.push(time);
      options.recovering();
      const attempt = generation;
      timer = schedule(() => {
        if (disposed || attempt !== generation || viewer.isDestroyed()) return;
        timer = undefined;
        try {
          if (options.canResume && !options.canResume()) { fail(error, details); return; }
          removeFrame = viewer.scene.postRender.addEventListener(() => {
            if (disposed || attempt !== generation || viewer.isDestroyed()) return;
            removeFrame?.(); removeFrame = undefined;
            lastFailure = '';
            options.recovered();
          });
          viewer.useDefaultRenderLoop = true;
          viewer.scene.requestRender();
        } catch (recoveryError) {
          clearPending();
          fail(error, `${details}\n\n恢复失败：${renderErrorDetails(recoveryError)}`);
        }
      });
    } catch (recoveryError) {
      clearPending();
      fail(error, `${details}\n\n恢复失败：${renderErrorDetails(recoveryError)}`);
    }
  });
  return () => {
    if (disposed) return;
    disposed = true; clearPending(); removeError();
  };
}
