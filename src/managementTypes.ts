import type { MachineryMetadata } from "./machineryTypes.ts";
export type { FieldObjectReference, GuardPersonnel, RailwayPlanSource } from './railwayWorkflowTypes.ts';
/** Persistent management API. Identities and capabilities come from the server session. */
export const MANAGEMENT_API = "/__management";
export type ManagementRole = "owner" | "manager" | "planner" | "quality" | "inspector" | "resource" | "document" | "worker" | "viewer";
export type ManagementPermission = "read" | "plan" | "confirm" | "field" | "review" | "inspect" | "resource" | "document" | "publish" | "admin" | "models" | "files" | "media";
export type ManagementSession = { userId: string; displayName: string; roles: ManagementRole[]; authMode: "local-owner" | "local-account"; permissions: ManagementPermission[]; expiresAt?: string };
export type ManagementProject = { id: string; name: string; revision: number; timezone: string; calendar: { workingDays: number[] }; horizontalCrs: string; verticalDatum: string; units: string; isTest: boolean; createdAt: string; updatedAt: string };
export type ManagementMember = { id: string; projectId: string; revision: number; username: string; displayName: string; roles: ManagementRole[]; active: boolean; resourceAccess: { models: boolean; files: boolean; media: boolean }; taskIds?: string[]; createdAt: string; updatedAt: string };
export const MANAGEMENT_COLLECTIONS = ["wbs","tasks","baselines","commitments","progress","dailyLogs","checks","issues","inspections","resources","resourceNeeds","allocations","resourceUsage","batches","materialTransactions","tests","documents","documentVersions","documentRequirements","links","technicalQueries","changes","meetings","actions","evidence","anchors","bookmarks","monitoring","reports","railSafety"] as const;
export type ManagementCollection = typeof MANAGEMENT_COLLECTIONS[number];
export type ManagementRecord = { id: string; projectId: string; revision: number; name: string; status: string; createdAt: string; updatedAt: string; createdBy: string; taskId?: string; taskIds?: string[]; ownerId?: string; dueDate?: string; evidenceIds?: string[]; machinery?: MachineryMetadata; [key: string]: unknown };
/** Optional railway planning records. Local minute values use the project's Asia/Shanghai civil time;
 * recording a window or permit reference never constitutes permission to start work. */
export type RailwayTaskDetails = { railwayLine?: string; railwaySection?: string; railwayMileage?: string; railwayTrack?: string; railwayWorkType?: string; workWindowStart?: string; workWindowEnd?: string; permitReference?: string; batchLabel?: string };
export type TaskExecutionEvent = { action: "pause" | "resume"; at: string; by: string; reason: string; taskRevision: number };
export type PlanTask = ManagementRecord & RailwayTaskDetails & { status: "draft" | "published" | "in-progress" | "paused" | "pending-completion" | "completed" | "cancelled"; wbsId?: string; areaIds: string[]; resourceIds?: string[]; predecessorIds: string[]; planStart?: string; planEnd?: string; forecastEnd?: string; forecastReason?: string; targetQuantity?: number; unit?: string; weight?: number; milestone?: boolean; planVersion: number; completionConfirmedAt?: string; qualityAcceptedAt?: string; pausedAt?: string; pausedBy?: string; pauseReason?: string; resumedAt?: string; resumedBy?: string; resumeReason?: string; executionHistory?: TaskExecutionEvent[] };
export type ProgressRevision = { revision: number; quantity: number; unit: string; businessDate: string; shift: string; crew: string; measurementKey: string; explanation: string; evidenceIds: string[]; status: "draft" | "submitted" | "returned" | "confirmed"; createdAt: string; submittedAt?: string; confirmedAt?: string; confirmedBy?: string; returnReason?: string };
export type ProgressEntry = ManagementRecord & { taskId: string; entryId: string; revisions: ProgressRevision[]; confirmations: { entryRevision: number; confirmedAt: string; confirmedBy: string; revokedAt?: string; revokedBy?: string; reason?: string }[] };
/** User-recorded actual attendance/use. Allocation remains a separate planned record. */
export type ResourceUsage = ManagementRecord & { status: "recorded" | "confirmed"; taskId: string; resourceId: string; kind: "crew" | "equipment"; quantity: number; unit: string; businessDate: string; startAt: string; endAt: string; description: string; allocationId?: string; resourceRevision: number; allocationRevision?: number; recordedAt: string; recordedBy: string; confirmationBasis?: string; confirmedAt?: string; confirmedBy?: string };
export type ManagementCheckItem = { id: string; name: string; required: boolean; result: "pending" | "pass" | "fail" | "not-applicable"; basis?: string; evidenceIds?: string[]; allowNotApplicable?: boolean };
export type ManagementMetric = { id: string; name: string; numerator: number | null; denominator: number | null; value: number | null; unit: string; reason?: string; detailIds: string[]; detailRecords?: { kind: "tasks" | "actions"; record: ManagementRecord }[]; filters: ManagementFilters; businessAsOf: string; confirmedAsOf: string; formulaVersion: string; baselineId?: string; dataVersion: number; coverage: string; updatedAt: string };
export type ManagementFilters = { periodStart?: string; periodEnd?: string; taskIds?: string[]; areaIds?: string[]; ownerId?: string; status?: string; query?: string };
export type ManagementMetrics = { businessAsOf: string; confirmedAsOf: string; formulaVersion: string; taskProgress: { taskId: string; quantity: number; unit?: string; target?: number; percent: number | null; entryRevisions: { entryId: string; revision: number }[] }[]; metrics: ManagementMetric[]; dashboard: ManagementMetric[] };
export type ManagementAudit = { id: number; projectId: string; actorId: string; command: string; recordId: string; beforeRevision: number | null; afterRevision: number; at: string; reason: string };
export type ManagementSnapshot = { schemaVersion: 1; revision: number; projectId: string; session: ManagementSession; projects: ManagementProject[]; members: ManagementMember[]; collections: Record<ManagementCollection, ManagementRecord[]>; updatedAt: string; audit: ManagementAudit[] };
export type ManagementCommandType =
 | "project.create" | "project.update" | "member.save"
 | "wbs.create" | "wbs.update" | "task.create" | "task.update" | "task.publish" | "task.start" | "task.pause" | "task.resume" | "task.request-completion" | "task.confirm-completion" | "task.cancel" | "task.forecast"
 | "task.conditions.configure"
 | "baseline.create" | "baseline.approve" | "commitment.create" | "commitment.publish" | "commitment.change"
 | "progress.create" | "progress.revise" | "progress.submit" | "progress.return" | "progress.confirm" | "progress.revoke" | "dailyLog.create"
 | "check.create" | "check.copy" | "check.record" | "check.confirm"
 | "issue.create" | "issue.assign" | "issue.start" | "issue.submit" | "issue.review" | "issue.dismiss" | "issue.reschedule"
 | "inspection.create" | "inspection.record" | "inspection.confirm"
 | "resource.create" | "resource.update" | "need.create" | "need.update" | "need.confirm" | "allocation.create" | "allocation.cancel" | "usage.create" | "usage.confirm"
 | "machinery.create" | "machinery.save" | "machinery.remove" | "machinery.delete"
 | "railSafety.save" | "railSafety.remove" | "railSafety.reportRisk" | "railSafety.personnel"
 | "batch.create" | "batch.receive" | "batch.accept" | "test.create" | "test.confirm" | "material.issue" | "material.return" | "material.correct"
 | "document.create" | "document.version" | "document.submit" | "document.return" | "document.publish" | "document.void" | "document.requirement" | "document.fulfill" | "link.create" | "link.remove"
 | "technical.create" | "technical.comment" | "technical.answer" | "technical.publish" | "change.create" | "change.confirm"
 | "anchor.create" | "anchor.update" | "meeting.create" | "action.create" | "action.complete" | "evidence.register" | "bookmark.create" | "bookmark.update" | "monitoring.create" | "monitoring.record" | "monitoring.threshold"
 | "report.freeze" | "report.publish";
export type ManagementCommand = { projectId: string; type: ManagementCommandType; id?: string; expectedRevision?: number; idempotencyKey: string; payload: Record<string, unknown> };
export type ManagementApiError = { error: string; code: string; current?: ManagementRecord | ManagementProject | ManagementMember; details?: unknown };
export const MANAGEMENT_ROLE_LABELS: Record<ManagementRole,string> = { owner:"本机所有者",manager:"项目负责人",planner:"计划工程",quality:"质量安全",inspector:"巡检管理",resource:"物资机械",document:"技术资料",worker:"现场填报",viewer:"授权查看" };

/** Explicit task admission policies. Missing legacy configuration remains unconfigured. */
export type TaskConditionKind = "predecessors" | "preconstruction-checks" | "resources" | "documents" | "external-permit" | "acceptance" | "blocking-issues" | "quantity";
export type TaskConditionMode = "required" | "advisory" | "not-applicable";
export type TaskConditionStage = "start" | "completion";
export type TaskConditionRule = { id: string; kind: TaskConditionKind; stage: TaskConditionStage; mode: TaskConditionMode; referenceIds: string[]; note?: string; basis?: string; evidenceIds?: string[]; validUntil?: string };
export type TaskConditionPolicy = { version: number; taskType: "quantity" | "milestone" | "non-quantity"; rules: TaskConditionRule[]; configuredAt: string; configuredBy: string; reason: string };
export type TaskConditionResult = { id: string; kind: TaskConditionKind | "configuration"; stage: TaskConditionStage; mode: TaskConditionMode; satisfied: boolean | null; status: "satisfied" | "blocked" | "advisory" | "not-applicable" | "configuration-required"; reason: string; references: { collection: ManagementCollection; id: string; revision: number; name: string }[] };
export type TaskConditionsResponse = { taskId: string; taskRevision: number; dataVersion: number; policy: TaskConditionPolicy | null; stages: { start: TaskConditionResult[]; completion: TaskConditionResult[] }; evaluatedAt: string };
export type TaskConditionException = { conditionIds: string[]; reason: string; basis: string; evidenceIds?: string[] };
