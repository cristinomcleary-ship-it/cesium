export type SafetyProvenance = "real" | "derived" | "demo" | "user";
export type SafetyPage = "overview" | "inspection" | "events" | "components";
export type SafetyMode = "presentation" | "inspection";
export type SafetySeverity = "high" | "medium" | "low";
export type SafetyPosition = { longitude: number; latitude: number; height: number };
export type SafetyNode = {
  id: string; parentId?: string; kind: "project" | "section" | "pier" | "component";
  name: string; position: SafetyPosition; sceneAvailable?: boolean; eventId?: string; riskLevel?: "unassessed" | SafetySeverity; provenance: SafetyProvenance; description: string;
  componentType?: "cap" | "column" | "footing" | "pile";
  boundary?: SafetyPosition[]; radius?: number; mediaIds: string[];
  sourceRecordId?: string; sourceEntityIndex?: number; modelFeatureId?: string;
  spatialKind?: "construction-area" | "railway" | "risk-point"; spatialObjectId?: string; navigationDisabledReason?: string;
};
export type SafetyMedia = {
  id: string; name: string; kind: "video" | "photo" | "drawing" | "document";
  url: string; previewUrl?: string; previewEntityIndices?: number[]; provenance: SafetyProvenance; relation: "project" | "object"; note: string;
  sourceRecordId?: string; recordedAt?: number; durationSeconds?: number;
};
export type SafetyAlert = {
  id: string; nodeId: string; title: string; severity: SafetySeverity; timestamp: number;
  eventId?: string; positionAvailable?: boolean; sourceLabel?: string;
  status: "open" | "rectifying" | "closed"; description: string; provenance: SafetyProvenance;
  mediaIds: string[]; mediaSeconds?: number; spatialObjectId?: string; rectifications: Array<{ timestamp: number; text: string }>;
};
export type SafetyTask = {
  id: string; nodeId: string; name: string; timestamp: number;
  status: "pending" | "active" | "complete"; provenance: SafetyProvenance;
};
export type SafetyTrackPoint = SafetyPosition & { time: number; mediaSeconds: number; segment?: number };
export type SafetyDevice = {
  id: string; nodeId: string; name: string; kind: "drone" | "camera";
  provenance: SafetyProvenance; status: "replay" | "online" | "offline" | "unknown";
  track: SafetyTrackPoint[]; mediaId?: string; coordinateNote: string;
};
export type SafetyDataset = {
  version: 1; projectId: string; name: string; nodes: SafetyNode[]; alerts: SafetyAlert[];
  tasks: SafetyTask[]; devices: SafetyDevice[]; media: SafetyMedia[];
  timeExtent: [number, number]; coordinateNote: string; sourceNotes: string[]; missingData: string[];
  railway?: { positions: SafetyPosition[]; provenance: SafetyProvenance; note: string };
};
export type SafetyLayers = { boundary: boolean; markers: boolean; track: boolean; heat: boolean; effects: boolean; links: boolean };
export type SafetyState = {
  selectedId: string; selectedAlertId?: string; page?: SafetyPage; eventStatus?: "all" | "open" | "rectifying" | "closed"; eventQuery?: string; mode: SafetyMode; severity: "all" | SafetySeverity;
  timeRange: [number, number]; time: number; playing: boolean; includeDemo: boolean;
  heatOpacity: number; cruise: boolean; animationPaused: boolean; engineeringAnnotations: boolean; layers: SafetyLayers;
};
export type SafetyView = {
  selected: SafetyNode; breadcrumbs: SafetyNode[]; children: SafetyNode[]; nodes: SafetyNode[];
  alerts: SafetyAlert[]; tasks: SafetyTask[]; devices: SafetyDevice[]; media: SafetyMedia[];
  metrics: { points: number; alerts: number; high: number; completed: number; tasks: number; demoAlerts: number };
};
export interface SafetyDataAdapter { load(signal?: AbortSignal): Promise<SafetyDataset> }
export type SafetySelection = { nodeId: string; alertId?: string; fly?: boolean };
