/** Railway field-work associations. Importing a file or saving a model never grants work permission. */
export type FieldObjectReference = { kind: "resources" | "railSafety" | "anchors"; id: string };
export type RailwayWorkflowCategory = "agreement" | "construction-plan" | "supervision-plan" | "other" | "personnel-certificate";
export type RailwayPlanSource = {
  kind: "construction" | "supervision";
  number: string;
  sourceEvidenceId: string;
  sheetName: string;
  rowNumber: number;
  verificationStatus: "pending";
  resourceText?: string;
  unmatchedResources?: string[];
};
export type GuardPersonnel = {
  name: string;
  unit?: string;
  phone?: string;
  role?: string;
  certificateNumber?: string;
  trainingOrganization?: string;
  trainingDate?: string;
  validUntil?: string;
  certificateEvidenceIds: string[];
};
