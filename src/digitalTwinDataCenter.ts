/**
 * A small, framework-free directory for digital-twin projects, scene resources,
 * and business records. Runtime resources remain in memory; only a safe catalog
 * projection is ever written to storage.
 */

export const DIGITAL_TWIN_DATA_CENTER_VERSION = 1 as const;

export interface DataCenterLimits {
  maxProjects: number;
  maxResources: number;
  maxBusinessRecords: number;
  maxNameLength: number;
  maxDescriptionLength: number;
  maxIdLength: number;
  maxTags: number;
  maxTagLength: number;
  maxMetadataEntries: number;
  maxMetadataKeyLength: number;
  maxMetadataValueLength: number;
  maxKeywordLength: number;
  maxFilterResults: number;
  maxStorageBytes: number;
}

export const DATA_CENTER_LIMITS: Readonly<DataCenterLimits> = Object.freeze({
  maxProjects: 100,
  maxResources: 1_000,
  maxBusinessRecords: 5_000,
  maxNameLength: 160,
  maxDescriptionLength: 2_000,
  maxIdLength: 128,
  maxTags: 16,
  maxTagLength: 48,
  maxMetadataEntries: 32,
  maxMetadataKeyLength: 64,
  maxMetadataValueLength: 512,
  maxKeywordLength: 160,
  maxFilterResults: 1_000,
  maxStorageBytes: 1_048_576,
});

export type ProjectType = "building" | "infrastructure" | "municipal" | "survey" | "other";
export type ProjectStatus = "planned" | "active" | "paused" | "completed" | "archived";

export type DataResourceType =
  | "CAD"
  | "3D Tiles"
  | "GIS"
  | "Model"
  | "Drone Video"
  | "Imagery"
  | "Document"
  | "Other";
export type DataResourceStatus = "loading" | "ready" | "hidden" | "error" | "archived";

export type BusinessRecordType = "inspection" | "monitoring" | "issue" | "maintenance" | "report" | "other";
export type BusinessRecordStatus = "open" | "in-progress" | "resolved" | "closed" | "archived";

export type SafeMetadataValue = string | number | boolean | null;
export type SafeMetadata = Readonly<Record<string, SafeMetadataValue>>;

export interface DirectoryEntryBase<TType extends string, TStatus extends string> {
  id: string;
  name: string;
  type: TType;
  status: TStatus;
  description: string;
  tags: readonly string[];
  metadata: SafeMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalTwinProject extends DirectoryEntryBase<ProjectType, ProjectStatus> {
  owner: string;
}

export interface DigitalTwinDataResource extends DirectoryEntryBase<DataResourceType, DataResourceStatus> {
  projectId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  visible: boolean;
  /** Cesium object, File, Blob, object URL, or other live handle. Never persisted. */
  runtimeResource?: unknown;
}

export interface DigitalTwinBusinessRecord extends DirectoryEntryBase<BusinessRecordType, BusinessRecordStatus> {
  projectId?: string;
  resourceId?: string;
  recordedAt: string;
}

type CommonEntryInput = {
  id: string;
  name: string;
  description?: string;
  tags?: readonly string[];
  metadata?: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export type ProjectInput = CommonEntryInput & {
  type?: ProjectType;
  status?: ProjectStatus;
  owner?: string;
};

export type DataResourceInput = CommonEntryInput & {
  type: DataResourceType;
  status?: DataResourceStatus;
  projectId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  visible?: boolean;
  runtimeResource?: unknown;
};

export type BusinessRecordInput = CommonEntryInput & {
  type?: BusinessRecordType;
  status?: BusinessRecordStatus;
  projectId?: string;
  resourceId?: string;
  recordedAt?: string;
};

export type DirectoryCatalog = "projects" | "resources" | "businessRecords";

export interface DirectoryFilter<TType extends string, TStatus extends string> {
  type?: TType | readonly TType[];
  status?: TStatus | readonly TStatus[];
  keyword?: string;
  projectId?: string;
  tags?: readonly string[];
  limit?: number;
}

export interface CatalogStatistics<TType extends string, TStatus extends string> {
  total: number;
  byType: Readonly<Partial<Record<TType, number>>>;
  byStatus: Readonly<Partial<Record<TStatus, number>>>;
}

export interface DataCenterSnapshot {
  generatedAt: string;
  total: number;
  projects: CatalogStatistics<ProjectType, ProjectStatus>;
  resources: CatalogStatistics<DataResourceType, DataResourceStatus>;
  businessRecords: CatalogStatistics<BusinessRecordType, BusinessRecordStatus>;
}

export type DataCenterEventAction = "upsert" | "remove" | "reconcile" | "restore";

export interface DataCenterEvent {
  action: DataCenterEventAction;
  catalog: DirectoryCatalog | "all";
  ids: readonly string[];
  snapshot: DataCenterSnapshot;
}

export type DataCenterListener = (event: DataCenterEvent) => void;

export interface ReconcileResult {
  inserted: number;
  updated: number;
  removed: number;
  total: number;
}

export interface ImportLike {
  id: string;
  name: string;
  kind: Extract<DataResourceType, "CAD" | "3D Tiles" | "GIS" | "Model" | "Drone Video">;
  resource?: unknown;
  visible: boolean;
  adjustable?: boolean;
  representation?: "dataSource" | "primitive";
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface DataCenterOptions {
  storage?: StorageLike | null;
  storageKey?: string;
  autoRestore?: boolean;
  limits?: Partial<DataCenterLimits>;
  clock?: () => Date;
}

export interface PersistenceStatus {
  available: boolean;
  lastWriteSucceeded: boolean;
  reason?: "unavailable" | "read-failed" | "write-failed" | "capacity-exceeded" | "invalid-data";
}

type PersistedDataResource = Omit<DigitalTwinDataResource, "runtimeResource">;
type PersistedState = {
  version: typeof DIGITAL_TWIN_DATA_CENTER_VERSION;
  projects: DigitalTwinProject[];
  resources: PersistedDataResource[];
  businessRecords: DigitalTwinBusinessRecord[];
};

const PROJECT_TYPES: readonly ProjectType[] = ["building", "infrastructure", "municipal", "survey", "other"];
const PROJECT_STATUSES: readonly ProjectStatus[] = ["planned", "active", "paused", "completed", "archived"];
const RESOURCE_TYPES: readonly DataResourceType[] = ["CAD", "3D Tiles", "GIS", "Model", "Drone Video", "Imagery", "Document", "Other"];
const RESOURCE_STATUSES: readonly DataResourceStatus[] = ["loading", "ready", "hidden", "error", "archived"];
const BUSINESS_TYPES: readonly BusinessRecordType[] = ["inspection", "monitoring", "issue", "maintenance", "report", "other"];
const BUSINESS_STATUSES: readonly BusinessRecordStatus[] = ["open", "in-progress", "resolved", "closed", "archived"];
const SENSITIVE_METADATA_KEY = /(?:password|passwd|secret|token|authorization|cookie|credential|private[-_ ]?key|access[-_ ]?key)/i;
const RESERVED_METADATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NON_PERSISTABLE_URL = /^(?:blob|data):/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const DEFAULT_STORAGE_KEY = "cesium.digital-twin-data-center.v1";

function cleanText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function cleanRequiredText(value: unknown, label: string, maximumLength: number): string {
  const cleaned = cleanText(value, maximumLength);
  if (!cleaned) throw new TypeError(`${label} must be a non-empty string`);
  return cleaned;
}

function cleanOptionalId(value: unknown, maximumLength: number): string | undefined {
  const cleaned = cleanText(value, maximumLength);
  return cleaned || undefined;
}

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function cleanTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : fallback;
}

function cloneMetadata(metadata: SafeMetadata): SafeMetadata {
  return Object.freeze({ ...metadata });
}

function cleanMetadata(value: unknown, limits: DataCenterLimits): SafeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const result: Record<string, SafeMetadataValue> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (Object.keys(result).length >= limits.maxMetadataEntries) break;
    const key = cleanText(rawKey, limits.maxMetadataKeyLength);
    if (!key || RESERVED_METADATA_KEYS.has(key.toLocaleLowerCase()) || SENSITIVE_METADATA_KEY.test(key) || Object.hasOwn(result, key)) continue;
    if (rawValue === null || typeof rawValue === "boolean") result[key] = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) result[key] = rawValue;
    else if (typeof rawValue === "string") {
      const cleaned = cleanText(rawValue, limits.maxMetadataValueLength);
      if (cleaned && !NON_PERSISTABLE_URL.test(cleaned)) result[key] = cleaned;
    }
  }
  return Object.freeze(result);
}

function cleanTags(value: unknown, limits: DataCenterLimits): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const tags: string[] = [];
  for (const rawTag of value) {
    const tag = cleanText(rawTag, limits.maxTagLength);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= limits.maxTags) break;
  }
  return Object.freeze(tags);
}

function cloneEntry<T extends DirectoryEntryBase<string, string>>(entry: T): T {
  return { ...entry, tags: Object.freeze([...entry.tags]), metadata: cloneMetadata(entry.metadata) };
}

function requestedValues<T extends string>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value as T];
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

export function dataResourceFromImport(record: ImportLike, projectId?: string): DataResourceInput {
  return {
    id: record.id,
    name: record.name,
    type: record.kind,
    status: record.visible ? "ready" : "hidden",
    visible: record.visible,
    projectId,
    fileName: record.name,
    runtimeResource: record.resource,
    metadata: {
      ...(record.representation ? { representation: record.representation } : {}),
      ...(typeof record.adjustable === "boolean" ? { adjustable: record.adjustable } : {}),
    },
  };
}

export class DigitalTwinDataCenter {
  readonly limits: DataCenterLimits;

  private projects = new Map<string, DigitalTwinProject>();
  private resources = new Map<string, DigitalTwinDataResource>();
  private businessRecords = new Map<string, DigitalTwinBusinessRecord>();
  private readonly listeners = new Set<DataCenterListener>();
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly clock: () => Date;
  private persistence: PersistenceStatus;

  constructor(options: DataCenterOptions = {}) {
    this.limits = Object.freeze({
      maxProjects: positiveInteger(options.limits?.maxProjects, DATA_CENTER_LIMITS.maxProjects),
      maxResources: positiveInteger(options.limits?.maxResources, DATA_CENTER_LIMITS.maxResources),
      maxBusinessRecords: positiveInteger(options.limits?.maxBusinessRecords, DATA_CENTER_LIMITS.maxBusinessRecords),
      maxNameLength: positiveInteger(options.limits?.maxNameLength, DATA_CENTER_LIMITS.maxNameLength),
      maxDescriptionLength: positiveInteger(options.limits?.maxDescriptionLength, DATA_CENTER_LIMITS.maxDescriptionLength),
      maxIdLength: positiveInteger(options.limits?.maxIdLength, DATA_CENTER_LIMITS.maxIdLength),
      maxTags: positiveInteger(options.limits?.maxTags, DATA_CENTER_LIMITS.maxTags),
      maxTagLength: positiveInteger(options.limits?.maxTagLength, DATA_CENTER_LIMITS.maxTagLength),
      maxMetadataEntries: positiveInteger(options.limits?.maxMetadataEntries, DATA_CENTER_LIMITS.maxMetadataEntries),
      maxMetadataKeyLength: positiveInteger(options.limits?.maxMetadataKeyLength, DATA_CENTER_LIMITS.maxMetadataKeyLength),
      maxMetadataValueLength: positiveInteger(options.limits?.maxMetadataValueLength, DATA_CENTER_LIMITS.maxMetadataValueLength),
      maxKeywordLength: positiveInteger(options.limits?.maxKeywordLength, DATA_CENTER_LIMITS.maxKeywordLength),
      maxFilterResults: positiveInteger(options.limits?.maxFilterResults, DATA_CENTER_LIMITS.maxFilterResults),
      maxStorageBytes: positiveInteger(options.limits?.maxStorageBytes, DATA_CENTER_LIMITS.maxStorageBytes),
    });
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.storageKey = cleanText(options.storageKey, 200) || DEFAULT_STORAGE_KEY;
    this.clock = options.clock ?? (() => new Date());
    this.persistence = { available: this.storage !== null, lastWriteSucceeded: false, ...(this.storage ? {} : { reason: "unavailable" as const }) };
    if (options.autoRestore !== false) this.restore();
  }

  subscribe(listener: DataCenterListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getPersistenceStatus(): Readonly<PersistenceStatus> {
    return Object.freeze({ ...this.persistence });
  }

  upsertProject(input: ProjectInput): DigitalTwinProject {
    const entry = this.prepareProject(input, this.projects.get(cleanText(input.id, this.limits.maxIdLength)));
    this.assertCapacity(this.projects, entry.id, this.limits.maxProjects, "projects");
    this.projects.set(entry.id, entry);
    this.commit("upsert", "projects", [entry.id]);
    return cloneEntry(entry);
  }

  upsertResource(input: DataResourceInput): DigitalTwinDataResource {
    const entry = this.prepareResource(input, this.resources.get(cleanText(input.id, this.limits.maxIdLength)));
    this.assertCapacity(this.resources, entry.id, this.limits.maxResources, "resources");
    this.resources.set(entry.id, entry);
    this.commit("upsert", "resources", [entry.id]);
    return cloneEntry(entry);
  }

  upsertBusinessRecord(input: BusinessRecordInput): DigitalTwinBusinessRecord {
    const entry = this.prepareBusinessRecord(input, this.businessRecords.get(cleanText(input.id, this.limits.maxIdLength)));
    this.assertCapacity(this.businessRecords, entry.id, this.limits.maxBusinessRecords, "business records");
    this.businessRecords.set(entry.id, entry);
    this.commit("upsert", "businessRecords", [entry.id]);
    return cloneEntry(entry);
  }

  removeProject(id: string): boolean {
    return this.removeFrom(this.projects, id, "projects");
  }

  removeResource(id: string): boolean {
    return this.removeFrom(this.resources, id, "resources");
  }

  removeBusinessRecord(id: string): boolean {
    return this.removeFrom(this.businessRecords, id, "businessRecords");
  }

  getProject(id: string): DigitalTwinProject | undefined {
    const entry = this.projects.get(cleanText(id, this.limits.maxIdLength));
    return entry ? cloneEntry(entry) : undefined;
  }

  getResource(id: string): DigitalTwinDataResource | undefined {
    const entry = this.resources.get(cleanText(id, this.limits.maxIdLength));
    return entry ? cloneEntry(entry) : undefined;
  }

  getBusinessRecord(id: string): DigitalTwinBusinessRecord | undefined {
    const entry = this.businessRecords.get(cleanText(id, this.limits.maxIdLength));
    return entry ? cloneEntry(entry) : undefined;
  }

  queryProjects(filter: DirectoryFilter<ProjectType, ProjectStatus> = {}): DigitalTwinProject[] {
    return this.query(this.projects.values(), filter);
  }

  queryResources(filter: DirectoryFilter<DataResourceType, DataResourceStatus> = {}): DigitalTwinDataResource[] {
    return this.query(this.resources.values(), filter);
  }

  queryBusinessRecords(filter: DirectoryFilter<BusinessRecordType, BusinessRecordStatus> = {}): DigitalTwinBusinessRecord[] {
    return this.query(this.businessRecords.values(), filter);
  }

  reconcileProjects(inputs: readonly ProjectInput[]): ReconcileResult {
    const next = new Map<string, DigitalTwinProject>();
    for (const input of inputs) {
      const id = cleanText(input.id, this.limits.maxIdLength);
      const entry = this.prepareProject(input, this.projects.get(id));
      next.set(entry.id, entry);
    }
    return this.replaceCatalog(this.projects, next, this.limits.maxProjects, "projects");
  }

  reconcileResources(inputs: readonly DataResourceInput[]): ReconcileResult {
    const next = new Map<string, DigitalTwinDataResource>();
    for (const input of inputs) {
      const id = cleanText(input.id, this.limits.maxIdLength);
      const entry = this.prepareResource(input, this.resources.get(id));
      next.set(entry.id, entry);
    }
    return this.replaceCatalog(this.resources, next, this.limits.maxResources, "resources");
  }

  reconcileBusinessRecords(inputs: readonly BusinessRecordInput[]): ReconcileResult {
    const next = new Map<string, DigitalTwinBusinessRecord>();
    for (const input of inputs) {
      const id = cleanText(input.id, this.limits.maxIdLength);
      const entry = this.prepareBusinessRecord(input, this.businessRecords.get(id));
      next.set(entry.id, entry);
    }
    return this.replaceCatalog(this.businessRecords, next, this.limits.maxBusinessRecords, "businessRecords");
  }

  reconcileImports(imports: readonly ImportLike[], projectId?: string): ReconcileResult {
    return this.reconcileResources(imports.map((record) => dataResourceFromImport(record, projectId)));
  }

  reconcile(input: {
    projects?: readonly ProjectInput[];
    resources?: readonly DataResourceInput[];
    businessRecords?: readonly BusinessRecordInput[];
  }): Readonly<Partial<Record<DirectoryCatalog, ReconcileResult>>> {
    const result: Partial<Record<DirectoryCatalog, ReconcileResult>> = {};
    if (input.projects) result.projects = this.reconcileProjects(input.projects);
    if (input.resources) result.resources = this.reconcileResources(input.resources);
    if (input.businessRecords) result.businessRecords = this.reconcileBusinessRecords(input.businessRecords);
    return Object.freeze(result);
  }

  snapshot(): DataCenterSnapshot {
    const projects = this.statistics<ProjectType, ProjectStatus>(this.projects.values());
    const resources = this.statistics<DataResourceType, DataResourceStatus>(this.resources.values());
    const businessRecords = this.statistics<BusinessRecordType, BusinessRecordStatus>(this.businessRecords.values());
    return Object.freeze({
      generatedAt: this.now(),
      total: projects.total + resources.total + businessRecords.total,
      projects,
      resources,
      businessRecords,
    });
  }

  private now(): string {
    const value = this.clock();
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
  }

  private prepareProject(input: ProjectInput, previous?: DigitalTwinProject): DigitalTwinProject {
    const timestamp = this.now();
    return Object.freeze({
      id: cleanRequiredText(input.id, "project id", this.limits.maxIdLength),
      name: cleanRequiredText(input.name, "project name", this.limits.maxNameLength),
      type: cleanEnum(input.type, PROJECT_TYPES, "other"),
      status: cleanEnum(input.status, PROJECT_STATUSES, "active"),
      owner: cleanText(input.owner, this.limits.maxNameLength),
      description: cleanText(input.description, this.limits.maxDescriptionLength),
      tags: cleanTags(input.tags, this.limits),
      metadata: cleanMetadata(input.metadata, this.limits),
      createdAt: previous?.createdAt ?? cleanTimestamp(input.createdAt, timestamp),
      updatedAt: cleanTimestamp(input.updatedAt, timestamp),
    });
  }

  private prepareResource(input: DataResourceInput, previous?: DigitalTwinDataResource): DigitalTwinDataResource {
    const timestamp = this.now();
    const sizeBytes = typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) && input.sizeBytes >= 0
      ? Math.floor(input.sizeBytes)
      : undefined;
    const visible = typeof input.visible === "boolean" ? input.visible : input.status !== "hidden";
    return Object.freeze({
      id: cleanRequiredText(input.id, "resource id", this.limits.maxIdLength),
      name: cleanRequiredText(input.name, "resource name", this.limits.maxNameLength),
      type: cleanEnum(input.type, RESOURCE_TYPES, "Other"),
      status: cleanEnum(input.status, RESOURCE_STATUSES, visible ? "ready" : "hidden"),
      description: cleanText(input.description, this.limits.maxDescriptionLength),
      tags: cleanTags(input.tags, this.limits),
      metadata: cleanMetadata(input.metadata, this.limits),
      createdAt: previous?.createdAt ?? cleanTimestamp(input.createdAt, timestamp),
      updatedAt: cleanTimestamp(input.updatedAt, timestamp),
      projectId: cleanOptionalId(input.projectId, this.limits.maxIdLength),
      fileName: cleanOptionalId(input.fileName, this.limits.maxNameLength),
      mimeType: cleanOptionalId(input.mimeType, 120),
      sizeBytes,
      visible,
      runtimeResource: input.runtimeResource,
    });
  }

  private prepareBusinessRecord(input: BusinessRecordInput, previous?: DigitalTwinBusinessRecord): DigitalTwinBusinessRecord {
    const timestamp = this.now();
    return Object.freeze({
      id: cleanRequiredText(input.id, "business record id", this.limits.maxIdLength),
      name: cleanRequiredText(input.name, "business record name", this.limits.maxNameLength),
      type: cleanEnum(input.type, BUSINESS_TYPES, "other"),
      status: cleanEnum(input.status, BUSINESS_STATUSES, "open"),
      description: cleanText(input.description, this.limits.maxDescriptionLength),
      tags: cleanTags(input.tags, this.limits),
      metadata: cleanMetadata(input.metadata, this.limits),
      createdAt: previous?.createdAt ?? cleanTimestamp(input.createdAt, timestamp),
      updatedAt: cleanTimestamp(input.updatedAt, timestamp),
      recordedAt: cleanTimestamp(input.recordedAt, timestamp),
      projectId: cleanOptionalId(input.projectId, this.limits.maxIdLength),
      resourceId: cleanOptionalId(input.resourceId, this.limits.maxIdLength),
    });
  }

  private assertCapacity<T>(catalog: Map<string, T>, id: string, maximum: number, label: string): void {
    if (!catalog.has(id) && catalog.size >= maximum) throw new RangeError(`${label} capacity (${maximum}) exceeded`);
  }

  private removeFrom<T>(catalog: Map<string, T>, rawId: string, catalogName: DirectoryCatalog): boolean {
    const id = cleanText(rawId, this.limits.maxIdLength);
    if (!id || !catalog.delete(id)) return false;
    this.commit("remove", catalogName, [id]);
    return true;
  }

  private replaceCatalog<T>(
    current: Map<string, T>,
    next: Map<string, T>,
    maximum: number,
    catalog: DirectoryCatalog,
  ): ReconcileResult {
    if (next.size > maximum) throw new RangeError(`${catalog} capacity (${maximum}) exceeded`);
    let inserted = 0;
    let updated = 0;
    let removed = 0;
    for (const id of next.keys()) current.has(id) ? updated += 1 : inserted += 1;
    for (const id of current.keys()) if (!next.has(id)) removed += 1;
    current.clear();
    for (const [id, value] of next) current.set(id, value);
    this.commit("reconcile", catalog, [...next.keys()]);
    return Object.freeze({ inserted, updated, removed, total: next.size });
  }

  private query<T extends DirectoryEntryBase<TType, TStatus> & { projectId?: string }, TType extends string, TStatus extends string>(
    entries: IterableIterator<T>,
    filter: DirectoryFilter<TType, TStatus>,
  ): T[] {
    const types = requestedValues(filter.type);
    const statuses = requestedValues(filter.status);
    const projectId = cleanOptionalId(filter.projectId, this.limits.maxIdLength);
    const tags = cleanTags(filter.tags, this.limits).map((tag) => tag.toLocaleLowerCase());
    const keyword = cleanText(filter.keyword, this.limits.maxKeywordLength).toLocaleLowerCase();
    const limit = Math.min(positiveInteger(filter.limit, this.limits.maxFilterResults), this.limits.maxFilterResults);
    const result: T[] = [];
    for (const entry of entries) {
      if (types && !types.includes(entry.type)) continue;
      if (statuses && !statuses.includes(entry.status)) continue;
      if (projectId && entry.projectId !== projectId) continue;
      if (tags.length && !tags.every((tag) => entry.tags.some((candidate) => candidate.toLocaleLowerCase() === tag))) continue;
      if (keyword) {
        const haystack = [entry.id, entry.name, entry.type, entry.status, entry.description, ...entry.tags,
          ...Object.keys(entry.metadata), ...Object.values(entry.metadata).map(String)].join("\n").toLocaleLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      result.push(cloneEntry(entry));
      if (result.length >= limit) break;
    }
    return result;
  }

  private statistics<TType extends string, TStatus extends string>(
    entries: IterableIterator<DirectoryEntryBase<TType, TStatus>>,
  ): CatalogStatistics<TType, TStatus> {
    const byType: Partial<Record<TType, number>> = {};
    const byStatus: Partial<Record<TStatus, number>> = {};
    let total = 0;
    for (const entry of entries) {
      total += 1;
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    }
    return Object.freeze({ total, byType: Object.freeze(byType), byStatus: Object.freeze(byStatus) });
  }

  private commit(action: DataCenterEventAction, catalog: DirectoryCatalog, ids: readonly string[]): void {
    this.persist();
    const event = Object.freeze({ action, catalog, ids: Object.freeze([...ids]), snapshot: this.snapshot() });
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Subscribers cannot break directory updates. */ }
    }
  }

  private persistedState(): PersistedState {
    return {
      version: DIGITAL_TWIN_DATA_CENTER_VERSION,
      projects: [...this.projects.values()].map((entry) => cloneEntry(entry)),
      resources: [...this.resources.values()].map(({ runtimeResource: _runtimeResource, ...entry }) => cloneEntry(entry)),
      businessRecords: [...this.businessRecords.values()].map((entry) => cloneEntry(entry)),
    };
  }

  private persist(): void {
    if (!this.storage) {
      this.persistence = { available: false, lastWriteSucceeded: false, reason: "unavailable" };
      return;
    }
    const serialized = JSON.stringify(this.persistedState());
    if (new TextEncoder().encode(serialized).byteLength > this.limits.maxStorageBytes) {
      this.persistence = { available: true, lastWriteSucceeded: false, reason: "capacity-exceeded" };
      return;
    }
    try {
      this.storage.setItem(this.storageKey, serialized);
      this.persistence = { available: true, lastWriteSucceeded: true };
    } catch {
      this.persistence = { available: true, lastWriteSucceeded: false, reason: "write-failed" };
    }
  }

  private restore(): void {
    if (!this.storage) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      this.persistence = { available: true, lastWriteSucceeded: false, reason: "read-failed" };
      return;
    }
    if (!raw) return;
    try {
      if (new TextEncoder().encode(raw).byteLength > this.limits.maxStorageBytes) throw new Error("stored catalog exceeds capacity");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version !== DIGITAL_TWIN_DATA_CENTER_VERSION) throw new Error("unsupported catalog version");
      const projects = Array.isArray(parsed.projects) ? parsed.projects.slice(0, this.limits.maxProjects) : [];
      const resources = Array.isArray(parsed.resources) ? parsed.resources.slice(0, this.limits.maxResources) : [];
      const records = Array.isArray(parsed.businessRecords) ? parsed.businessRecords.slice(0, this.limits.maxBusinessRecords) : [];
      for (const input of projects) {
        const entry = this.prepareProject(input, undefined);
        this.projects.set(entry.id, entry);
      }
      for (const input of resources) {
        const entry = this.prepareResource(input, undefined);
        this.resources.set(entry.id, entry);
      }
      for (const input of records) {
        const entry = this.prepareBusinessRecord(input, undefined);
        this.businessRecords.set(entry.id, entry);
      }
      this.persistence = { available: true, lastWriteSucceeded: true };
      const event = Object.freeze({ action: "restore" as const, catalog: "all" as const, ids: Object.freeze([]), snapshot: this.snapshot() });
      for (const listener of this.listeners) {
        try { listener(event); } catch { /* Subscribers cannot break restoration. */ }
      }
    } catch {
      this.projects.clear();
      this.resources.clear();
      this.businessRecords.clear();
      this.persistence = { available: true, lastWriteSucceeded: false, reason: "invalid-data" };
    }
  }
}
