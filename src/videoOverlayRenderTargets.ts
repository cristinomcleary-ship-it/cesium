import type { Scene } from 'cesium';

type TextureSize = { width: number; height: number };
type ReusableFramebufferManager = {
  destroy(): void;
  getColorTexture?(): TextureSize | undefined;
  getDepthStencilTexture?(): TextureSize | undefined;
  update?: (...args: never[]) => void;
  isDirty?: (...args: never[]) => boolean;
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
  _defaultView?: {
    sceneFramebuffer?: SceneFramebuffer;
    pickFramebuffer?: { _fb?: ReusableFramebufferManager };
    pickDepthFramebuffer?: { _framebuffer?: ReusableFramebufferManager };
    globeDepth?: { _pickColorFramebuffer?: ReusableFramebufferManager; _snapColorFramebuffer?: ReusableFramebufferManager };
  };
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
  releasedAuxiliaryManagers: string[];
  issues: Array<{ target: string; reason: 'unsupported-runtime' | 'owner-changed' | 'scene-destroyed' | 'invalid-size' | 'failed'; message?: string }>;
};

function textureSize(manager: ReusableFramebufferManager, depthOnly: boolean): TextureSize | undefined {
  // Cesium's depth-only manager has no _colorTextures array; its color getter
  // throws even before the first allocation. Use its attachment type directly.
  return depthOnly ? manager.getDepthStencilTexture?.() : manager.getColorTexture?.();
}

/** Cesium 1.144 / engine 26.2 lifecycle adapter.
 *
 * Removing the last stage only sets _textureCacheDirty. When the normal map has
 * no postprocessing, Scene never calls the collection's update again, so the AR
 * stage's native-size textures and SceneFramebuffer survive indefinitely.
 * FramebufferManager.destroy() releases attachments, keeps the manager reusable,
 * and its isDirty() checks the missing framebuffer before the next allocation.
 * Picking attachments which grew during AR can also outlive the native canvas:
 * their owners only update on the next pick. Release only oversized, changed
 * attachments through reusable managers; the next pick recreates them normally.
 * Do not destroy SceneFramebuffer, View, Context, picking owners, models or tiles.
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
  const auxiliary = [
    { name: 'pick', depthOnly: false, owner: () => view?.pickFramebuffer, manager: () => view?.pickFramebuffer?._fb },
    { name: 'pick-depth', depthOnly: true, owner: () => view?.pickDepthFramebuffer, manager: () => view?.pickDepthFramebuffer?._framebuffer },
    { name: 'globe-pick', depthOnly: false, owner: () => view?.globeDepth, manager: () => view?.globeDepth?._pickColorFramebuffer },
    { name: 'globe-snap', depthOnly: false, owner: () => view?.globeDepth, manager: () => view?.globeDepth?._snapColorFramebuffer },
  ].map(handle => {
    const owner = handle.owner(), manager = handle.manager();
    let before: TextureSize | undefined, inspected = true;
    try { const texture = manager && textureSize(manager, handle.depthOnly); if (texture) before = { width: texture.width, height: texture.height }; }
    catch { inspected = false; }
    return { ...handle, capturedOwner: owner, capturedManager: manager, before, inspected };
  });
  let completed: VideoOverlayRenderTargetCleanup | undefined;
  return () => {
    if (completed) return completed;
    const result: VideoOverlayRenderTargetCleanup = { cacheUpdated: false, releasedManagers: 0, skipped: false, releasedAuxiliaryManagers: [], issues: [] };
    completed = result;
    const issue = (target: string, reason: VideoOverlayRenderTargetCleanup['issues'][number]['reason'], error?: unknown) => {
      result.skipped = true;
      result.issues.push({ target, reason, ...(error === undefined ? {} : { message: error instanceof Error ? error.message : String(error) }) });
    };
    // Another scene/context owner may have replaced these objects during AR.
    if (!compatible) { issue('scene', 'unsupported-runtime'); return result; }
    if (host.isDestroyed?.()) { issue('scene', 'scene-destroyed'); return result; }
    if (host.context !== context || host._defaultView !== view || view!.sceneFramebuffer !== target || host.postProcessStages !== collection) {
      issue('scene', 'owner-changed'); return result;
    }
    try {
      // Flush removal and release dependencies even when Scene's normal render
      // skips every postprocess update. Active map effects retain their owners.
      collection.update(context, !!host.logarithmicDepthBuffer, !!host.highDynamicRange);
      result.cacheUpdated = true;
    } catch (error) { issue('postprocess-cache', 'failed', error); }
    const width = context!.drawingBufferWidth, height = context!.drawingBufferHeight;
    const validSize = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    const mapUsesPostprocessing = host.highDynamicRange || collection.length > 0
      || collection.fxaa.enabled || collection.bloom.enabled || collection.ambientOcclusion.enabled;
    if (mapUsesPostprocessing) {
      if (validSize) {
        try {
          target!.update(context, { x: 0, y: 0, width, height }, !!host.highDynamicRange, host.msaaSamples);
          result.resizedTo = [width, height];
        } catch (error) { issue('scene-framebuffer', 'failed', error); }
      } else { issue('scene-framebuffer', 'invalid-size'); }
    } else {
      for (const [index, manager] of managers.entries()) {
        try { manager.destroy(); result.releasedManagers++; }
        catch (error) { issue(index === 0 ? 'scene-color' : 'scene-id', 'failed', error); }
      }
    }
    for (const handle of auxiliary) {
      const manager = handle.manager();
      if (!manager && !handle.capturedManager) continue;
      if (handle.owner() !== handle.capturedOwner || manager !== handle.capturedManager) { issue(handle.name, 'owner-changed'); continue; }
      if (!manager || !handle.inspected || typeof manager.destroy !== 'function' || typeof manager.update !== 'function' || typeof manager.isDirty !== 'function'
        || typeof (handle.depthOnly ? manager.getDepthStencilTexture : manager.getColorTexture) !== 'function') {
        issue(handle.name, 'unsupported-runtime'); continue;
      }
      try {
        const size = textureSize(manager, handle.depthOnly);
        if (!size) continue;
        if (!validSize) { issue(handle.name, 'invalid-size'); continue; }
        const changed = !handle.before || size.width !== handle.before.width || size.height !== handle.before.height;
        if (changed && (size.width > width || size.height > height)) {
          manager.destroy(); result.releasedAuxiliaryManagers.push(handle.name);
        }
      } catch (error) { issue(handle.name, 'failed', error); }
    }
    return result;
  };
}
