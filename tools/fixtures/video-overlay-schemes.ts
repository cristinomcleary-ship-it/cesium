import type { Viewer } from 'cesium';
import { SceneLibrary, type VideoOverlaySaveProgress } from '../../src/sceneLibrary';
import type { ModelEditor } from '../../src/modelEditor';
import type { ImportRecord } from '../../src/types';
import type { SavedVideoOverlaySettings } from '../../src/videoModelOverlay';

// This fixture exercises persistence, not rendering. Already-loaded engineering
// dependencies are represented by fixed objects so no real user model is read.
const imports: ImportRecord[] = ['model', 'cad', 'tiles'].map((id, index) => ({
  id, name: id, kind: (['Model', 'CAD', '3D Tiles'] as const)[index], resource: {}, visible: true,
}));
const viewer = {
  camera: {
    moveEnd: { addEventListener() {} }, positionWC: { x: 1, y: 2, z: 3 },
    directionWC: { x: 0, y: 0, z: -1 }, upWC: { x: 0, y: 1, z: 0 },
  },
  scene: { requestRender() {} },
} as unknown as Viewer;
const files = {
  video: new File([new Uint8Array(1048576)], 'synthetic.mp4', { type: 'video/mp4', lastModified: 1600000000100 }),
  source: new File(['synthetic xml'], 'synthetic.xml', { type: 'application/xml', lastModified: 1600000000200 }),
  manifest: new File(['synthetic manifest'], 'manifest.json', { type: 'application/json', lastModified: 1600000000300 }),
};
const fileMetadata = Object.fromEntries(Object.entries(files).map(([slot, file]) => [slot, {
  name: file.name, size: file.size, lastModified: file.lastModified, type: file.type,
}]));
const settings: SavedVideoOverlaySettings & { fileMetadata: typeof fileMetadata } = {
  version: 1, mode: 'cc-overlay', schemeName: 'Synthetic named scheme',
  videoName: files.video.name, videoSize: files.video.size, width: 640, height: 360,
  selectedIds: ['model', 'cad'], opacity: .8, currentTime: 0,
  timing: { mode: 'ordinal', firstTimeSeconds: 0, intervalSeconds: 2, heightReference: 'ellipsoid' },
  sceneReference: { recordId: 'tiles', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  occlusion: { enabled: true, sourceId: 'tiles' },
  adjustments: { cad: { east: 0, north: 0, up: 29, heading: 0 } }, fileMetadata,
};
const calls: Array<{ recordId?: string; settings: unknown; files: Array<{
  slot: string; name: string; size: number; type: string; lastModified: number; text?: string;
}> }> = [];
const progress: VideoOverlaySaveProgress[] = [];
let mediaAllowed = true;
const library = new SceneLibrary({
  viewer, getImports: () => imports, addImport: () => '', removeImport() {}, modelEditor: {} as ModelEditor,
  waitForModelReady: async () => {}, cacheGisBoundingSphere: async () => {}, replaceImagery() {},
  setBasemap() {}, getBasemap: () => 'none', notify() {}, layersChanged() {}, clearVideo() {},
  canReadRecord: record => mediaAllowed || record.kind !== 'Drone Video',
  restoreVideo: async (restoredFiles, restoredSettings, recordId) => {
    calls.push({ recordId, settings: restoredSettings, files: await Promise.all(Object.entries(restoredFiles).map(async ([slot, file]) => ({
      slot, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
      ...(file.size < 100 ? { text: await file.text() } : {}),
    }))) });
  },
});
const harness = {
  library, calls, progress, settings, fileMetadata,
  setMediaAllowed(allowed: boolean) { mediaAllowed = allowed; },
  save: () => library.save('scheme', 'synthetic', 'Drone Video', { video: settings as unknown as Record<string, unknown> },
    Object.fromEntries(Object.entries(files).map(([slot, file]) => [slot, { name: file.name, blob: file }])), undefined,
    value => progress.push(value)),
};
declare global { interface Window { __videoSchemes: typeof harness } }
window.__videoSchemes = harness;
