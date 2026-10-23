import type { SpatialObject } from './safetySpatialTypes';
import type { SafetyMedia } from './safetyTypes';
import type { SafetyVideoRoamState } from './safetyVideoRoam';
import type { FieldObjectReference } from './railwayWorkflowTypes';

export type ManagementFieldMachinery = {
  id: string; name: string; placed: boolean; enabled: boolean; visible: boolean;
  kind?: string; workpointId?: string; taskId?: string;
  risk: 'crossing' | 'clear' | 'unknown'; riskLabel: string; riskMessage: string;
  intersectionCount?: number; draft?: boolean;
};
export type ManagementFieldContext = {
  machinery: ManagementFieldMachinery[];
  selectedMachineryId?: string;
  selectedObject?: FieldObjectReference;
  editor?: 'machinery' | 'rail-safety'; editorTitle?: string;
  pending: boolean; guardCount: number; limitCount: number;
};

/** Actual scene capabilities. Business dates/metrics are deliberately absent. */
export type ManagementSceneContext = {
  mode?: 'presentation' | 'inspection';
  field?: ManagementFieldContext;
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
