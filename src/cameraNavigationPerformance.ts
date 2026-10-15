type ContextCanvas = { getContext(contextId: 'webgl2' | 'webgl'): unknown };

/** Read the renderer of an already-initialized Cesium canvas. Unknown hardware
 * and privacy-blocked renderer information retain ordinary navigation. */
export function detectsSoftwareRenderer(canvas: ContextCanvas): boolean {
  try {
    const context = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (!context || typeof context.getExtension !== 'function' || typeof context.getParameter !== 'function') return false;
    const info = context.getExtension('WEBGL_debug_renderer_info');
    if (!info) return false;
    const renderer: unknown = context.getParameter(info.UNMASKED_RENDERER_WEBGL);
    if (typeof renderer !== 'string') return false;
    return /swiftshader|llvmpipe|softpipe|swrast|software[\s_-]+(?:rasterizer|renderer)|microsoft basic render driver/i.test(renderer);
  } catch {
    return false;
  }
}

type NavigationScene = {
  useDepthPicking: boolean;
  screenSpaceCameraController: object;
};
type NavigationUpdate = (this: unknown, ...args: unknown[]) => unknown;

export type CameraNavigationPerformanceOptions = {
  enabled?: boolean;
  /** Exclude tracked/non-world cameras, which may require depth-based orbiting. */
  shouldUseLightweightNavigation?: () => boolean;
};

export type CameraNavigationPerformanceHandle = {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly disposed: boolean;
  dispose(): void;
};

/** Compatibility adapter for the pinned Cesium 1.144.0 controller runtime.
 * `update` is an internal method, absent from Cesium's public type declarations;
 * feature-test it and leave navigation untouched if that entry point changes.
 *
 * Only synchronous camera navigation skips GPU depth reads. Explicit model,
 * engineering and measurement picks outside this call keep the caller's setting.
 * This does not change collision detection, scene geometry or model quality. */
export function installCameraNavigationPerformance(
  scene: NavigationScene,
  options: CameraNavigationPerformanceOptions = {},
): CameraNavigationPerformanceHandle {
  const controller = scene.screenSpaceCameraController as { update?: unknown };
  const original = controller.update;
  const enabled = options.enabled !== false && typeof original === 'function';
  let disposed = false;

  const wrapper: NavigationUpdate = function (...args) {
    let lightweight = enabled && !disposed;
    if (lightweight && options.shouldUseLightweightNavigation) {
      try { lightweight = options.shouldUseLightweightNavigation(); }
      catch { lightweight = false; } // A stale camera predicate must not disable navigation.
    }
    if (!lightweight) return (original as NavigationUpdate).apply(this, args);
    const previousDepthPicking = scene.useDepthPicking;
    try {
      scene.useDepthPicking = false;
      return (original as NavigationUpdate).apply(this, args);
    } finally {
      scene.useDepthPicking = previousDepthPicking;
    }
  };

  if (enabled) controller.update = wrapper;
  return {
    get enabled() { return enabled && !disposed; },
    get installed() { return enabled && !disposed && controller.update === wrapper; },
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Do not overwrite a replacement installed later by another owner.
      if (enabled && controller.update === wrapper) controller.update = original;
    },
  };
}
