export type ContactPoint = [number, number, number];
export type ContactBounds = [number, number, number, number, number, number];
export type ContactPrimitiveInput = {
  positions: Float64Array; indices: Uint32Array; groupId: string; nodeIndex: number;
};
/** Positions already include each node/instance transform, in root-model space. */
export type ContactMeshInput = { primitives: ContactPrimitiveInput[]; worldFromLocal: readonly number[] };
export type ContactGeometryStats = {
  sourceTriangles: number; sourcePrimitives: number; sourceGroups: number;
  shells: number; solidEntities: number; surfaceEntities: number; cavityShells: number;
  openShells: number; nonManifoldShells: number; inconsistentShells: number;
  duplicateTriangles: number; degenerateTriangles: number; selfIntersectingShells: number;
  ambiguousShells: number; packedTriangles: number; bvhNodes: number; maxDepth: number;
  topologyChecks: number; milliseconds: number; warnings: string[];
};
/** Immutable-by-contract, transferable result. No source mesh is rewritten.
 * BVH records: min.xyz, escape, max.xyz, count, start, kind, unused.xy.
 * kind: 0 internal; 1 entity leaf; 2 triangle leaf. Triangle records: a.xyz,0,
 * b.xyz,0,c.xyz,0. Entity records: triangleRoot,triangleEnd,solidFlag,0.
 * Top-level BVH begins at zero and ends at entityTreeEnd. */
export type ContactGeometry = {
  origin: ContactPoint; bounds: ContactBounds; nodes: Float32Array; triangles: Float32Array;
  entities: Float32Array; trianglePositions: Float64Array; entityTreeEnd: number;
  numericalTolerance: number; stats: ContactGeometryStats;
};
export type ContactBuildOptions = { onProgress?: (message: string) => void; shouldAbort?: () => boolean };
export type ContactVolume = { geometry: ContactGeometry; worldFromLocal: readonly number[] };
export type ContactPointResult = { clipped: boolean; mode: 'solid' | 'surface' | 'none'; entityIndex?: number };
