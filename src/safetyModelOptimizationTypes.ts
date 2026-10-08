import type { ModelRegistryEntry } from "./safetySpatialTypes.ts";

export const MODEL_OPTIMIZATION_API = "/__safety/model-optimization";
export type ModelInspectionIssue = { category: "display" | "mesh" | "texture"; kind: string; summary: string; evidence?: string };
export type ModelInspection = {
  version: 1; id: string; checkedAt: string;
  source: ModelRegistryEntry;
  scope: "published-tiles-readonly";
  inventory: { files: number; bytes: number; tilesetDocuments: number; tileNodes: number; binaryTiles: number; referencedFiles: number; geometricErrorRange?: [number, number]; refineModes: string[]; externalReferences: number };
  display: { status: "checked" | "failed"; issues: ModelInspectionIssue[] };
  mesh: { status: "unavailable"; reason: string };
  texture: { status: "unavailable"; reason: string };
  sourceEvidence: { projectLocated: boolean; intermediateCacheLocated: boolean; supportedEditableMeshLocated: boolean; note: string };
  capabilities: { inspectPublishedTiles: true; compareDisplay: true; createGeometryCandidate: false; activateCandidate: false; rollbackCandidate: false; reason: string };
  activeVersion: string; candidates: []; originalReadonly: true;
};
