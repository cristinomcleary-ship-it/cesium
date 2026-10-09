import type { SpatialObject } from './safetySpatialTypes';
import type { SafetyMedia } from './safetyTypes';
import type { SafetyVideoRoamState } from './safetyVideoRoam';

/** Actual scene capabilities. Business dates/metrics are deliberately absent. */
export type ManagementSceneContext = {
  mode?: 'presentation' | 'inspection';
  spatialObjects: SpatialObject[];
  media: SafetyMedia[];
  sourceAssets: SafetyMedia[];
  models: Array<{ id: string; name: string; version: string }>;
  layers: Array<{ id: string; name: string; kind: string; visible: boolean; quality?: string }>;
  selectedSpatialId?: string;
  videoState: {
    selectedId?: string; available: boolean; playing: boolean; currentTime: number;
    duration: number; rate: number; previewActive?: boolean; roam?: SafetyVideoRoamState; error?: string;
  };
  toolState: { visible: boolean; drawing: boolean; stage: string; canUndo: boolean; canRedo: boolean; draftVertices: number };
};

export type ManagementSceneHost = {
  videoHost: HTMLElement;
  onContext(context: ManagementSceneContext): void;
  onSpatialSelected(id: string): void;
  onIssueSelected?(id: string): void;
  getStageRect(): { left: number; top: number; width: number; height: number } | undefined;
};
