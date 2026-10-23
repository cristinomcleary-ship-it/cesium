import type { RailSafetyPositionSample } from "./railSafetyTypes.ts";

/** No credentials, histories or other projects are exposed to the browser. */
export type RailSafetyPositioningSnapshot = {
  schemaVersion: 1;
  projectId: string;
  serverTime: string;
  enabled: boolean;
  devices: Array<{ guardId: string; deviceId: string; configured: boolean; sample?: RailSafetyPositionSample; receivedAt?: string }>;
};
