import type * as Cesium from "cesium";
import type { DisplayEnvelope, PresentationController, PresentationHome, PresentationModel, PresentationStatus } from "./types";
export function installPresentation(options: {
  Cesium: typeof Cesium; viewer: Cesium.Viewer; tilesets: PresentationModel[]; displayEnvelope: DisplayEnvelope;
  home?: PresentationHome; homeOnInstall?: boolean;
  effects?: { externalClock?: boolean; paused?: boolean; reducedMotion?: boolean };
  onStatus?: (status: PresentationStatus) => void;
}): Promise<{ ok: boolean; status: PresentationStatus; controller?: PresentationController; reused?: boolean }>;
