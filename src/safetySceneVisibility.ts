import type { SafetyDataset, SafetyNode, SafetyPosition, SafetyView } from "./safetyTypes.ts";

export type SafetySpatialLayerVisibility = { constructionAreas?: boolean; railwayAreas?: boolean; riskPoints?: boolean };

/** Layer switches control presentation only; they never remove a saved definition or change selection. */
export function spatialNodeLayerVisible(node: SafetyNode, layers: SafetySpatialLayerVisibility): boolean {
  if (node.spatialKind === "construction-area") return layers.constructionAreas !== false;
  if (node.spatialKind === "railway") return layers.railwayAreas !== false;
  if (node.spatialKind === "risk-point") return layers.riskPoints !== false;
  return true;
}

/** Unlocated event nodes can carry internal placeholders, which must never become heat-map positions. */
export function safetyHeatWeights(dataset: SafetyDataset, view: SafetyView): Map<string, { position: SafetyPosition; count: number }> {
  const nodes = new Map(dataset.nodes.map(node => [node.id, node]));
  const weights = new Map<string, { position: SafetyPosition; count: number }>();
  for (const alert of view.alerts) {
    const node = nodes.get(alert.nodeId);
    if (alert.positionAvailable === false || !node || node.sceneAvailable === false || node.navigationDisabledReason) continue;
    const position = node.position;
    if (!Number.isFinite(position.longitude) || Math.abs(position.longitude) > 180
      || !Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90 || !Number.isFinite(position.height)) continue;
    const entry = weights.get(node.id) ?? { position, count: 0 };
    entry.count++;
    weights.set(node.id, entry);
  }
  return weights;
}
