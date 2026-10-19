import { createVideoOverlayExport, downloadVideoOverlayExport, type VideoOverlayExportProgress } from '../../src/videoOverlayExport';

const video = document.querySelector<HTMLVideoElement>('#video')!;
const overlay = document.querySelector<HTMLCanvasElement>('#overlay')!;
const held = document.createElement('canvas');
let sourceUrl: string | undefined;
document.querySelector<HTMLInputElement>('#video-file')!.addEventListener('change', event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(file); video.src = sourceUrl;
});

async function run(options: { format?: 'auto' | 'webm'; pause?: boolean; cancel?: boolean; includeAudio?: boolean } = {}) {
  video.pause(); video.playbackRate = 1;
  if (Math.abs(video.currentTime - .5) > .001) {
    const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = .5; await seeked;
  }
  held.width = overlay.width = video.videoWidth; held.height = overlay.height = video.videoHeight;
  const heldContext = held.getContext('2d')!, context = overlay.getContext('2d')!;
  const progress: VideoOverlayExportProgress[] = [], commits: number[] = [];
  const session = createVideoOverlayExport({ video, overlayCanvas: overlay, range: { start: .5, end: 3.5 },
    format: options.format, includeAudio: options.includeAudio, fileName: 'synthetic-fused-video',
    onProgress: value => progress.push(value),
  });
  let callback = 0, resumed: ReturnType<typeof setTimeout> | undefined, didPause = false;
  const started = performance.now();
  const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
    const time = metadata.mediaTime;
    // This held frame + rendered overlay pair is the controller's public contract.
    // There is no independent recorder loop and no reread of a newer video frame.
    heldContext.drawImage(video, 0, 0); context.clearRect(0, 0, overlay.width, overlay.height);
    context.fillStyle = 'rgba(255,64,0,0.8)'; context.fillRect(0, 0, 120, 120);
    context.fillStyle = time >= 2 ? '#00ff00' : '#ff00ff'; context.fillRect(0, 160, 120, 100);
    if (session.commitFrame(time, held, overlay)) commits.push(time);
    if (options.cancel && time > 1) { session.cancel(); return; }
    if (time >= 3.5) { video.pause(); void session.finish(); return; }
    callback = video.requestVideoFrameCallback(frame);
    if (options.pause && !didPause && time >= 1.5) {
      didPause = true; video.pause(); session.setPaused(true);
      resumed = setTimeout(() => { session.setPaused(false); void video.play(); }, 700);
    }
  };
  callback = video.requestVideoFrameCallback(frame);
  try {
    await video.play();
    const result = await session.done;
    downloadVideoOverlayExport(result);
    return { ...result, blob: undefined, bytes: result.blob.size, elapsed: (performance.now() - started) / 1000, progress, commits };
  } catch (error) {
    if (!options.cancel) throw error;
    return { cancelled: error instanceof DOMException && error.name === 'AbortError', progress, commits };
  } finally {
    video.pause(); video.cancelVideoFrameCallback(callback);
    if (resumed !== undefined) clearTimeout(resumed);
    session.cancel();
  }
}

(window as unknown as { __ccExportHarness: object }).__ccExportHarness = {
  ready: () => video.readyState >= 2,
  run,
};
