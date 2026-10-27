import { MANAGEMENT_API, type ManagementRecord } from './managementTypes';

export const MACHINERY_DOCUMENT_CATEGORIES = {
  performance: '机械性能', certificate: '合格证', inspection: '检测报告', submission: '报验单',
} as const;
export type MachineryDocumentCategory = keyof typeof MACHINERY_DOCUMENT_CATEGORIES;
export type MachineryDocumentContext = {
  projectId: string; actorId?: string; resourceId: string; resourceName: string;
  canView: boolean; canEdit: boolean; active: boolean;
};
export const isMachineryDocumentCategory = (value: unknown): value is MachineryDocumentCategory => typeof value === 'string' && Object.hasOwn(MACHINERY_DOCUMENT_CATEGORIES, value);
/** Explicit project and object identity, never a name or shared task match. */
export function selectMachineryDocuments(records: readonly ManagementRecord[], projectId: string, resourceId: string): ManagementRecord[] {
  return records.filter(record => record.projectId === projectId && record.status === 'ready' && !record.deletedAt
    && isMachineryDocumentCategory(record.machineryDocumentCategory) && Array.isArray(record.objectRefs)
    && record.objectRefs.length === 1 && record.objectRefs[0]?.kind === 'resources' && record.objectRefs[0]?.id === resourceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
export function machineryDocumentUrl(record: ManagementRecord, projectId: string): string {
  return `${MANAGEMENT_API}/files/${encodeURIComponent(record.id)}/original?${new URLSearchParams({ projectId })}`;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const blankContext = (): MachineryDocumentContext => ({ projectId: '', resourceId: '', resourceName: '', canView: false, canEdit: false, active: false });

/** Small, scoped file client. Late network completions cannot replace another machine's files. */
export class MachineryDocumentSession {
  context = blankContext();
  records: ManagementRecord[] = [];
  pendingDeletions: ManagementRecord[] = [];
  loading = false;
  busy = false;
  message = '';
  error = false;
  private generation = 0;
  private request?: AbortController;
  private mutation?: AbortController;
  private disposed = false;
  constructor(private readonly notify: () => void, private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  setContext(context: MachineryDocumentContext): void {
    if (this.disposed) return;
    const before = this.context;
    const changed = ['projectId', 'actorId', 'resourceId', 'canView', 'canEdit', 'active'].some(key => before[key as keyof MachineryDocumentContext] !== context[key as keyof MachineryDocumentContext]);
    this.context = { ...context };
    if (!changed) { if (before.resourceName !== context.resourceName) this.notify(); return; }
    this.generation++; this.request?.abort(); this.mutation?.abort(); this.request = undefined; this.mutation = undefined;
    this.records = []; this.pendingDeletions = []; this.loading = false; this.busy = false; this.message = ''; this.error = false; this.notify();
    if (this.available()) void this.refresh();
  }
  private available() { return !this.disposed && this.context.active && this.context.canView && !!this.context.projectId && !!this.context.resourceId; }
  private current(generation: number) { return !this.disposed && generation === this.generation; }
  private async read<T>(response: Response): Promise<T> {
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : `文件请求失败（${response.status}）`), { code: value.code });
    return value as T;
  }
  async refresh(): Promise<void> {
    if (!this.available()) return;
    const generation = this.generation, context = this.context, request = new AbortController();
    this.request?.abort(); this.request = request; this.loading = true; this.notify();
    try {
      const value = await this.read<{ records: ManagementRecord[]; pendingDeletions?: ManagementRecord[] }>(await this.fetcher(`${MANAGEMENT_API}/machinery/${encodeURIComponent(context.resourceId)}/documents?${new URLSearchParams({ projectId: context.projectId })}`, { signal: request.signal, cache: 'no-store' }));
      if (!this.current(generation) || request.signal.aborted) return;
      this.records = selectMachineryDocuments(Array.isArray(value.records) ? value.records : [], context.projectId, context.resourceId);
      if (Array.isArray(value.pendingDeletions)) this.pendingDeletions = value.pendingDeletions.filter(record => record.status === 'deleting' && selectMachineryDocuments([{ ...record, status: 'ready', deletedAt: undefined }], context.projectId, context.resourceId).length > 0);
    } catch (error) {
      if (!this.current(generation) || request.signal.aborted) return;
      this.records = []; this.message = messageOf(error); this.error = true;
    } finally { if (this.current(generation) && this.request === request) { this.loading = false; this.notify(); } }
  }
  async upload(files: readonly File[], category: MachineryDocumentCategory): Promise<void> {
    if (!this.available() || !this.context.canEdit || this.busy || !files.length || !isMachineryDocumentCategory(category)) return;
    const context = { ...this.context }, generation = this.generation, mutation = new AbortController();
    this.mutation = mutation; this.busy = true; this.error = false; this.message = `正在上传到“${context.resourceName}”…`; this.notify();
    let uploaded = 0;
    try {
      for (const file of files) {
        if (!this.current(generation)) return;
        if (!file.size || file.size > 100 * 1024 * 1024) throw new Error(`“${file.name}”须为非空文件且不超过 100 MB。`);
        const query = new URLSearchParams({ projectId: context.projectId, name: file.name, machineryDocumentCategory: category, objectRefs: JSON.stringify([{ kind: 'resources', id: context.resourceId }]) });
        await this.read<ManagementRecord>(await this.fetcher(`${MANAGEMENT_API}/upload?${query}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Cesium-Library': '1' }, body: file, signal: mutation.signal }));
        uploaded++;
      }
      if (this.current(generation)) { this.message = `已保存 ${uploaded} 份${MACHINERY_DOCUMENT_CATEGORIES[category]}。`; this.error = false; }
    } catch (error) {
      if (this.current(generation) && !mutation.signal.aborted) { this.message = `${uploaded ? `已保存 ${uploaded} 份；` : ''}${messageOf(error)}`; this.error = true; }
    } finally {
      if (this.current(generation)) { this.busy = false; this.mutation = undefined; await this.refresh(); this.notify(); }
    }
  }
  async remove(id: string): Promise<void> {
    const record = [...this.records, ...this.pendingDeletions].find(record => record.id === id);
    if (!this.available() || !this.context.canEdit || this.busy || !record) return;
    const context = { ...this.context }, generation = this.generation, mutation = new AbortController();
    this.mutation = mutation; this.busy = true; this.message = '正在删除资料及本地文件…'; this.error = false; this.notify();
    try {
      await this.read(await this.fetcher(`${MANAGEMENT_API}/files/${encodeURIComponent(id)}?${new URLSearchParams({ projectId: context.projectId })}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' }, body: JSON.stringify({ expectedRevision: record.revision }), signal: mutation.signal }));
      if (this.current(generation)) { this.records = this.records.filter(record => record.id !== id); this.pendingDeletions = this.pendingDeletions.filter(record => record.id !== id); this.message = '资料及本地存储文件已删除。'; }
    } catch (error) { if (this.current(generation) && !mutation.signal.aborted) { this.message = messageOf(error); this.error = true; if (error instanceof Error && 'code' in error && error.code === 'FILE_DELETE_PENDING' && !this.pendingDeletions.some(item => item.id === id)) this.pendingDeletions.push(record); } }
    finally { if (this.current(generation)) { this.busy = false; this.mutation = undefined; await this.refresh(); this.notify(); } }
  }
  dispose() { this.disposed = true; this.generation++; this.request?.abort(); this.mutation?.abort(); this.records = []; this.pendingDeletions = []; }
}
