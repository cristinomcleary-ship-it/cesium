import type { SafetyDataset, SafetyNode } from "./safetyTypes.ts";
import type { SafetyEventSnapshot } from "./safetyEventTypes.ts";

/** Events are a read-only projection of their own ledger; never mutate manual definitions. */
export function mergeSafetyEvents(base: SafetyDataset, snapshot: SafetyEventSnapshot): SafetyDataset {
  const nodes = base.nodes.filter(node => !node.eventId);
  const alerts = base.alerts.filter(alert => !alert.eventId && !alert.id.startsWith("spatial-alert:"));
  let start = base.timeExtent[0], end = base.timeExtent[1];
  for (const event of snapshot.events) {
    if (event.projectId !== base.projectId) continue;
    const reference = nodes.find(node => event.nodeId === node.id || (!!event.spatialObjectId && node.spatialObjectId === event.spatialObjectId));
    // A current object relationship alone is not evidence of the event's historical coordinates.
    const position = event.position;
    const id = `safety-event:${event.id}`;
    const node: SafetyNode = {
      id, parentId: reference?.id || base.projectId, kind: "component", eventId: event.id,
      name: event.title, position: position || { longitude: 0, latitude: 0, height: 0 }, sceneAvailable: !!position,
      provenance: event.source.kind === "manual-record" ? "user" : "real",
      description: event.description || "", mediaIds: [...event.mediaIds],
    };
    nodes.push(node);
    alerts.push({ id: `event:${event.id}`, eventId: event.id, nodeId: id, title: event.title, severity: event.severity,
      timestamp: event.occurredAt, status: event.status === "completed" ? "closed" : event.status === "processing" ? "rectifying" : "open",
      description: event.description || "", provenance: node.provenance, mediaIds: [...event.mediaIds], spatialObjectId: event.spatialObjectId,
      positionAvailable: !!position, sourceLabel: event.source.kind === "manual-record" ? "人工记录" : "业务事件",
      rectifications: event.handling ? [{ timestamp: Date.parse(event.handling.handledAt), text: event.handling.description }] : [],
    });
    start = Math.min(start, event.occurredAt); end = Math.max(end, event.occurredAt);
  }
  return { ...base, nodes, alerts, timeExtent: [start, end] };
}
