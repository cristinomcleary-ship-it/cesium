export type SketchupSdkStatus = {
  available: boolean;
  reason: string;
  details: string[];
  directory?: string;
  library?: string;
};
export function findSketchupSdk(projectRoot: string, options?: { platform?: string; arch?: string; sdkDirectory?: string }): SketchupSdkStatus;
