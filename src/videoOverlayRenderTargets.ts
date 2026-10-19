import type { Scene } from 'cesium';

type TextureSize = { width: number; height: number };
type ReusableFramebufferManager = {
  destroy(): void;
  getColorTexture?(): TextureSize | undefined;
};
type SceneFramebuffer = {
  _colorFramebuffer: ReusableFramebufferManager;
  _idFramebuffer: ReusableFramebufferManager;
  update(context: unknown, viewport: { x: number; y: number; width: number; height: number }, hdr: boolean, samples: number): void;
};
type PostProcesses = {
  length: number;
  fxaa: { enabled: boolean }; bloom: { enabled: boolean }; ambientOcclusion: { enabled: boolean };
  update(context: unknown, useLogDepth: boolean, useHdr: boolean): void;
  _textureCache?: object;
};
type InternalScene = {
  _defaultView?: { sceneFramebuffer?: SceneFramebuffer };
  context?: { drawingBufferWidth: number; drawingBufferHeight: number };
  postProcessStages: PostProcesses;
  logarithmicDepthBuffer: boolean;
  highDynamicRange: boolean;
  msaaSamples: number;
  isDestroyed?(): boolean;
};
export type VideoOverlayRenderTargetCleanup = {
  cacheUpdated: boolean;
  releasedManagers: number;
  resizedTo?: [number, number];
  skipped: boolean;
};

/** Cesium 1.144 / engine 26.2 lifecycle adapter.
 *
 * Removing the last stage only sets _textureCacheDirty. When the normal map has
 * no postprocessing, Scene never calls the collection's update again, so the AR
 * stage's native-size textures and SceneFramebuffer survive indefinitely.
 * FramebufferManager.destroy() releases attachments, keeps the manager reusable,
 * and its isDirty() checks the missing framebuffer before the next allocation.
 * Do not destroy SceneFramebuffer, View, Context, picking, models or tile content.
 *
 * Capture before AR changes the scene. Invoke once AFTER restoring map settings,
 * removing the AR stage and restoring/resizing the normal canvas.
 */
export function captureVideoOverlayRenderTargets(scene: Scene): () => VideoOverlayRenderTargetCleanup {
  const host = scene as unknown as InternalScene;
  const view = host._defaultView, target = view?.sceneFramebuffer;
  const collection = host.postProcessStages, context = host.context;
  const managers = target ? [target._colorFramebuffer, target._idFramebuffer] : [];
  const compatible = !!context && !!target && !!collection?._textureCache
    && typeof collection.update === 'function' && typeof target.update === 'function'
    && managers.every(manager => !!manager && typeof manager.destroy === 'function');
  let completed: VideoOverlayRenderTargetCleanup | undefined;
  return () => {
    if (completed) return completed;
    const result: VideoOverlayRenderTargetCleanup = { cacheUpdated: false, releasedManagers: 0, skipped: false };
    completed = result;
    // Another scene/context owner may have replaced these objects during AR.
    if (!compatible || host.isDestroyed?.() || host.context !== context || host._defaultView !== view
      || view!.sceneFramebuffer !== target || host.postProcessStages !== collection) {
      result.skipped = true; return result;
    }
    try {
      // Flush removal and release dependencies even when Scene's normal render
      // skips every postprocess update. Active map effects retain their owners.
      collection.update(context, !!host.logarithmicDepthBuffer, !!host.highDynamicRange);
      result.cacheUpdated = true;
      const mapUsesPostprocessing = host.highDynamicRange || collection.length > 0
        || collection.fxaa.enabled || collection.bloom.enabled || collection.ambientOcclusion.enabled;
      if (mapUsesPostprocessing) {
        const width = context!.drawingBufferWidth, height = context!.drawingBufferHeight;
        if (width > 0 && height > 0) {
          target!.update(context, { x: 0, y: 0, width, height }, !!host.highDynamicRange, host.msaaSamples);
          result.resizedTo = [width, height];
        }
      } else {
        for (const manager of managers) {
          try { manager.destroy(); result.releasedManagers++; }
          catch { result.skipped = true; /* An independent manager must still release. */ }
        }
      }
    } catch { result.skipped = true; /* Host teardown must not interrupt the remaining AR exit. */ }
    return result;
  };
}
