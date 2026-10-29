import type { LoadedMachineryAsset } from './machinery/types';
import type { MachineryMetadata } from './machineryTypes';
import { MachineryPoseRecorder, type MachineryPoseSnapshot, type MachineryPoseProvenance } from './machineryPoseRecorder';

export type MachineryCaptureContext = {
  actorId?: string; projectId: string; canView: boolean; canEdit: boolean; active: boolean;
  records: ReadonlyArray<{ id: string; name: string; assetId?: MachineryMetadata['assetId'] }>;
};
/** Retains history by account/project while a recorder remains fixed to its started resource. */
export class MachineryCaptureSession {
  private readonly archives = new Map<string, MachineryPoseRecorder>();
  private readonly assets = new Map<MachineryMetadata['assetId'], LoadedMachineryAsset>();
  private readonly hiddenRecorder = new MachineryPoseRecorder();
  private scope = '';
  private context: MachineryCaptureContext = { projectId: '', canView: false, canEdit: false, active: false, records: [] };
  recorder = this.hiddenRecorder;
  constructor(private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>) {}
  get canRecord() { return !!this.scope && this.context.canView && this.context.active; }
  setContext(next: MachineryCaptureContext) {
    const scope = next.canView && next.active && next.projectId
      ? `cesium:machinery-pose-history:v1:${encodeURIComponent(next.actorId ?? '')}:${encodeURIComponent(next.projectId)}` : '';
    if (scope !== this.scope) {
      this.recorder.stop(); this.scope = scope;
      if (scope && !this.archives.has(scope)) this.archives.set(scope, new MachineryPoseRecorder({ storageKey: scope, storage: this.storage }));
      this.recorder = scope ? this.archives.get(scope)! : this.hiddenRecorder;
    }
    if ((this.context.canEdit && !next.canEdit) || !next.canView || !next.active) this.recorder.stop();
    const active = this.recorder.activeResource;
    if (active) {
      const previous = this.context.records.find(record => record.id === active.resourceId);
      const current = next.records.find(record => record.id === active.resourceId);
      if (!current || (previous?.assetId && current.assetId !== previous.assetId)) this.recorder.stop();
    }
    this.context = next;
  }
  /** Called before an explicit UI start; remembers the immutable asset for background observations. */
  remember(snapshot: MachineryPoseSnapshot | undefined): MachineryPoseSnapshot | undefined {
    if (!snapshot || !this.canRecord || snapshot.projectId !== this.context.projectId
      || !this.context.records.some(record => record.id === snapshot.resourceId)) return;
    this.assets.set(snapshot.asset.id, snapshot.asset); return snapshot;
  }
  observe(resourceId: string, state: MachineryMetadata, options: {
    asset?: LoadedMachineryAsset; modelFrontAxisDeg?: number; provenance?: Readonly<Record<string, MachineryPoseProvenance>>;
  } = {}): boolean {
    if (!this.canRecord || this.recorder.activeResource?.resourceId !== resourceId) return false;
    const record = this.context.records.find(item => item.id === resourceId), asset = options.asset ?? this.assets.get(state.assetId);
    if (!record || !asset || (record.assetId && record.assetId !== state.assetId) || asset.id !== state.assetId) { this.recorder.stop(); return false; }
    this.assets.set(asset.id, asset);
    try {
      return this.recorder.observe({ projectId: this.context.projectId, resourceId, resourceName: record.name,
        asset, state, modelFrontAxisDeg: options.modelFrontAxisDeg, provenance: options.provenance });
    } catch { this.recorder.stop(); return false; }
  }
  destroy() { for (const recorder of this.archives.values()) recorder.stop(); this.hiddenRecorder.stop(); }
}
