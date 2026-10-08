import type * as Cesium from "cesium";
export type RoamVector = { x: number; y: number; z: number };
export type VideoRoamSample = { timeSeconds: number; position: RoamVector; direction?: RoamVector; up?: RoamVector };
export type VideoRoamTrack = { id: string; videoId: string; source: string; timeBasis: "media-seconds"; samples: VideoRoamSample[] };
export type VideoRoamRuntimeStatus = {
  ok: boolean; state: string; code?: string | null; message: string; enabled?: boolean; active?: boolean;
  destroyed?: boolean; buffering?: boolean; sourceBindingValid?: boolean; videoId?: string; trackId?: string;
  trackSource?: string; timeBasis?: string; mode?: "path" | "camera"; viewMatch?: string; hasCompleteAttitude?: boolean;
  timeRange?: number[]; mediaTime?: number | null; clockSource?: string | null; frameCount?: number;
  maxGapSeconds?: number; maxSegmentMeters?: number; pendingFrameCallback?: boolean; listenerCount?: number;
  visibility?: { track: boolean; marker: boolean };
  ownedEntityCount?: number; createdViewerCount?: number; businessGeometryWrites?: number;
  cameraTransformChangedByModule?: boolean; cameraTransformUnchanged?: boolean | null;
  lastPosition?: RoamVector | null; lastFrameTiming?: Record<string, number | null> | null; callbackError?: string | null;
};
export type VideoRoamController = {
  start(): VideoRoamRuntimeStatus; stop(): VideoRoamRuntimeStatus; sync(): VideoRoamRuntimeStatus;
  setFollowMode(mode: "path" | "camera"): VideoRoamRuntimeStatus;
  setVisibility(visibility: { track?: boolean; marker?: boolean }): VideoRoamRuntimeStatus;
  getState(): VideoRoamRuntimeStatus; destroy(): VideoRoamRuntimeStatus;
};
export function createVideoRoam(options: {
  Cesium: typeof Cesium; viewer: Cesium.Viewer; videoElement: HTMLVideoElement; videoId: string;
  track: VideoRoamTrack; followMode?: "path" | "camera"; showTrack?: boolean; showMarker?: boolean;
  maxGapSeconds?: number; maxSegmentMeters?: number; onStatus?: (status: VideoRoamRuntimeStatus) => void;
}): { ok: true; status: VideoRoamRuntimeStatus; controller: VideoRoamController }
  | { ok: false; status: VideoRoamRuntimeStatus };
