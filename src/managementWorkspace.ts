import { fieldMachineRisk } from './management/fieldSceneState';
import { VideoDiagnostics } from './management/videoDiagnostics';
import { Cartesian2, Cartesian3, Color, ConstantPositionProperty, ConstantProperty, Entity, HeadingPitchRange, ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from 'cesium';
import { ManagementStudio } from './managementStudio';
import { readMachineryState, type MachineryPlacementPick } from './machineryScene';
import { MachineryPanel } from './machineryPanel';
import { RailSafetyPanel } from './railSafetyPanel';
import type { MachineryMetadata } from './machineryTypes';
import { MANAGEMENT_API, type ManagementCommandType } from './managementTypes';
import type { ManagementSession, ManagementSnapshot } from './managementTypes';
import type { ManagementFieldContext, ManagementSceneContext } from './managementSceneTypes';
import type { FieldObjectReference } from './railwayWorkflowTypes';
import type { RailSafetyRiskSnapshot } from './railSafetyRiskTypes';
import type { SafetyWorkspace } from './safetyWorkspace';
import { strictModelSurfacePick, type SurfacePickResult } from './safetyModelSurfacePicker';
import './managementWorkspace.css';
import './managementField.css';

export type WorkbenchMachineryOptions = {
  onChange?: () => void;
  panelHost?: HTMLElement;
  onDisplayManager?: () => void;
  /** Reparents the existing display panel; it must retain its single preference store. */
  onDisplayMount?: (host?: HTMLElement) => void;
  onPanelChange?: (open: boolean) => void;
  pickPosition?: (pixel: Cartesian2) => MachineryPlacementPick | undefined;
};

type Selection = { kind: string; id: string; areaIds?: string[]; spatialObjectId?: string };
type CameraState = { position: number[]; direction: number[]; up: number[]; models: Array<{ assetId: string; assetVersion: string; coordinateTransformVersion: string }> };
const vector = (v: Cartesian3) => [v.x, v.y, v.z];
const cartesian = (v: number[]) => new Cartesian3(v[0], v[1], v[2]);
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));

/** Owns navigation only; model, original video, geometry drafts and Viewer remain owned by the existing workspace. */
export class ManagementWorkspace {
  readonly ui: ManagementStudio;
  private readonly viewer: Viewer;
  private readonly events = new AbortController();
  private readonly feedback = document.createElement('div');
  private readonly layersDialog = document.createElement('dialog');
  private readonly videoDiagnostics: VideoDiagnostics;
  private readonly machinery: MachineryPanel;
  private readonly railSafety: RailSafetyPanel;
  private machineryReceipt?: { signature: string; key: string };
  private readonly machineryRefreshTimer: ReturnType<typeof setInterval>;
  private sessionExpiryTimer?: ReturnType<typeof setTimeout>;
  private machineryRefresh?: Promise<void>;
  private machineryMutationCount = 0;
  private disposed = false;
  private machineryStatus = '正在读取施工机械…';
  private machineryContextGeneration = 0;
  private machineryCreation?: { signature: string; id: string };
  private active = false;
  private openedScene = false;
  private defaultScenePending = true;
  private sceneHostReady = false;
  private selectedMachineryId?: string;
  private selectedFieldObject?: FieldObjectReference;
  private fieldUpdateQueued = false;
  private fieldVisibilitySignature = '';
  private machineryContextSignature = '';
  private mode: 'management' | 'scene' = 'management';
  private session: ManagementSession | null = null;
  private selection: Selection | null = null;
  private syncingSelection = false;
  private backViews: CameraState[] = [];
  private capturing = false;
  private messageTimer?: ReturnType<typeof setTimeout>;
  private measurement?: { handler: ScreenSpaceEventHandler; points: Cartesian3[]; entities: Entity[] };
  private data?: ManagementSnapshot;
  private anchorPicking?: ScreenSpaceEventHandler;
  private readonly anchorEntities = new Map<string, Entity>();
  private readonly anchorSelector: ScreenSpaceEventHandler;
  private topic = "overview";
  private topicTaskIds?: string[];
  private anchorSignature = "";
  private topicProgress: Array<{taskId:string;percent:number|null}> = [];
  private topicSignature = "";
  private nativeDoubleClick?: ReturnType<ScreenSpaceEventHandler['getInputAction']>;

  constructor(private readonly safety: SafetyWorkspace, host: HTMLElement, private readonly workbench: WorkbenchMachineryOptions = {}) {
    this.viewer = safety.getManagementViewer();
    this.videoDiagnostics = new VideoDiagnostics({ read: () => safety.getManagementVideoDiagnostics(), quality: mode => safety.managementVideoQuality(mode), reset: () => safety.managementVideoPerformanceReset(), capture: () => safety.managementCaptureVideoTexture(), fps: value => safety.managementProjectionFps(value), preview: enabled => { if(enabled && (this.measurement || this.anchorPicking)) throw new Error("请先结束测量或资料取点，再开始融合试算"); if(!this.session?.permissions.includes("media") || !this.session.permissions.includes("models")) throw new Error("当前账户无模型融合试算权限"); safety.managementSetProjectionPreview(enabled); }, calibration: () => this.exitToWorkbench("videoar") });
    this.ui = new ManagementStudio(host, {
      onViewMode: mode => this.changeMode(mode),
      onBeforeNavigate: () => this.guardNavigation(),
      onSelect: selection => this.select(selection),
      onLocate: selection => this.locate(selection),
      onSceneAction: (action, args) => this.sceneAction(action, args).catch(e => {this.message(e instanceof Error ? e.message : String(e), true);return false;}),
      onSessionChange: session => this.sessionChanged(session),
      onSnapshot: data => this.acceptSharedSnapshot(data),
      onContextInvalidated: () => { this.data = undefined; this.machineryContextGeneration++; this.machineryStatus = '请通过“现场工作台”登录或核对当前项目权限。'; this.syncMachinery(); },
      onExit: () => { this.exitToWorkbench(); },
      getCameraSnapshot: () => this.cameraSnapshot(),
    });
    this.machinery = new MachineryPanel({ viewer: this.viewer, host, workbenchHost: this.workbench.panelHost,
      save: (id, machinery, revision) => this.mutateMachinery('machinery.save', id, revision, { machinery }).then(() => undefined),
      remove: (id, revision) => this.mutateMachinery('machinery.remove', id, revision, { reason: '在三维机械面板解除模型绑定' }).then(() => undefined),
      createResource: async name => {
        const signature = JSON.stringify([this.data?.projectId, this.session?.userId, name]);
        if (this.machineryCreation?.signature !== signature) this.machineryCreation = { signature, id: `equipment:${crypto.randomUUID()}` };
        const id = this.machineryCreation.id;
        await this.mutateMachinery('resource.create', id, undefined, { name, kind: 'equipment', unit: '台', availability: 'available' });
        this.machineryCreation = undefined;
        return { id };
      },
      onOpenChange: open => { if (!this.active) this.workbench.onPanelChange?.(open); else this.queueFieldUpdate(); },
      onSelectionChange: id => { this.selectedMachineryId = id || undefined; if(id)this.selectedFieldObject={kind:'resources',id}; this.queueFieldUpdate(); },
      onPreviewChange: (id, state) => this.railSafety?.setMachineryPreview(id, state),
      pickPosition: pixel => {
        if (!this.active) return this.workbench.pickPosition?.(pixel);
        const hit = strictModelSurfacePick(this.viewer, pixel, this.safety.getManagementModels(), () => this.safety.effects.suspendOverlaysForPicking(), this.data?.projectId);
        return hit.ok ? { ...hit.position, source: 'model' as const } : undefined;
      },
      onPickingChange: picking => {
        if (picking) { if (this.active) { this.safety.managementPause(); this.safety.managementSetProjectionPreview(false); } this.viewer.camera.cancelFlight(); }
        if (this.active) { this.safety.effects.setPickingEnabled(!picking); this.safety.effects.setAuthoring(picking); }
      },
    });
    this.railSafety = new RailSafetyPanel({ viewer: this.viewer, host, workbenchHost: this.workbench.panelHost,
      onDisplayChange: () => { this.workbench.onChange?.(); this.queueFieldUpdate(); }, onDisplayManager: () => this.openDisplayManager(),
      onSelectionChange: (kind, id) => { if (kind === 'machine') {this.selectedMachineryId = id || undefined;if(id)this.selectedFieldObject={kind:'resources',id};} else if(id)this.selectedFieldObject={kind:'railSafety',id}; this.queueFieldUpdate(); },
      onSelectObject: (kind, id) => { if (this.active && this.mode === 'scene') { if(kind==='machine'){const direct=this.data?.collections.resources.find(r=>r.id===id);const config=this.data?.collections.railSafety.find(r=>r.id===id);const resourceId=direct?.id||(config?.definition as {resourceId?:string}|undefined)?.resourceId;if(resourceId)this.selectFieldMachine(resourceId);else this.message('机械已移除或不在当前授权范围内。',true);}else this.selectFieldObject({kind:'railSafety',id}); } },
      save: (id, name, definition, revision, taskId) => this.mutateMachinery('railSafety.save', id, revision, { name, definition, taskId, reason: '用户编辑邻近营业线管控定义' }),
      remove: (id, revision) => this.mutateMachinery('railSafety.remove', id, revision, { reason: '用户移除管控定义，历史记录保留' }),
      openTasks: taskId => { void this.openRailSafetyTasks(taskId).catch(error => this.message(error instanceof Error ? error.message : '任务页面打开失败', true)); },
      openIssue: issueId => { void this.openRailSafetyIssue(issueId).catch(error => this.message(error instanceof Error ? error.message : '处置单打开失败', true)); },
      reportRisk: payload => this.mutateMachinery('railSafety.reportRisk', `issue:${crypto.randomUUID()}`, undefined, payload),
      editMachinery: id => {
        if (!this.railSafety.close()) return;
        this.machinery.open(); this.selectedMachineryId = id; void this.machinery.selectResource(id); this.queueFieldUpdate();
      },
      pickPosition: pixel => {
        if (!this.active) return this.workbench.pickPosition?.(pixel);
        const hit = strictModelSurfacePick(this.viewer, pixel, this.safety.getManagementModels(), () => this.safety.effects.suspendOverlaysForPicking(), this.data?.projectId);
        return hit.ok ? { ...hit.position, source: 'model' as const } : undefined;
      },
      onOpenChange: open => { if (!this.active) this.workbench.onPanelChange?.(open); else this.queueFieldUpdate(); },
      onPickingChange: picking => {
        if (picking) { this.viewer.camera.cancelFlight(); if (this.active) { this.safety.managementPause(); this.safety.managementSetProjectionPreview(false); } }
        if (this.active) { this.safety.effects.setPickingEnabled(!picking); this.safety.effects.setAuthoring(picking); }
      },
    });
    this.machinery.setManagementHost(this.ui.sceneEditorHost);
    this.railSafety.setManagementHost(this.ui.sceneEditorHost);
    this.feedback.className = 'management-scene-feedback'; this.feedback.hidden = true; this.feedback.setAttribute('role','status');
    this.layersDialog.className = 'management-layers-dialog';
    this.layersDialog.setAttribute('aria-label','图层与显示设置');
    host.append(this.feedback, this.layersDialog);
    this.layersDialog.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-scene-config]');
      if (!el) return;
      if (el.dataset.sceneConfig === 'close') this.layersDialog.close();
      if (el.dataset.sceneConfig === 'mode') this.safety.managementMode(el.dataset.mode as 'presentation'|'inspection');
      if (el.dataset.sceneConfig === 'measure') { this.layersDialog.close(); this.beginMeasurement(); }
    }, { signal: this.events.signal });
    this.layersDialog.addEventListener('change', e => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.layerId) this.safety.managementLayer(input.dataset.layerId, input.checked);
    }, { signal: this.events.signal });
    this.viewer.canvas.addEventListener('pointerdown', () => { if (this.active) this.viewer.camera.cancelFlight(); }, { signal: this.events.signal });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { if(this.measurement)this.endMeasurement(); if(this.anchorPicking)this.endAnchorPick(); } }, { signal: this.events.signal });
    this.anchorSelector = new ScreenSpaceEventHandler(this.viewer.canvas);
    this.anchorSelector.setInputAction(({position}: {position:Cartesian2})=>{
      if(!this.active||this.mode!=='scene'||this.measurement||this.anchorPicking||this.machinery?.isPicking||this.railSafety?.isPicking||this.safety.spatial.debugStats().visible)return;
      const hit=this.viewer.scene.pick(position),entity=hit?.id;
      const id=entity instanceof Entity ? entity.properties?.managementAnchorId?.getValue() : undefined;
      if (entity instanceof Entity && entity.id.startsWith('machinery:')) {
        const resourceId = entity.id.slice('machinery:'.length);
        if (this.machinery.getDisplayVisibility(resourceId)) this.selectFieldMachine(resourceId);
        return;
      }
      if(id&&this.anchorEntities.get(id)===entity){const selected={kind:'anchors',id};this.select(selected);this.ui.setExternalSelection(selected);}
    },ScreenSpaceEventType.LEFT_CLICK);
    this.viewer.canvas.addEventListener('wheel',()=>{if(this.active)this.viewer.camera.cancelFlight();},{signal:this.events.signal,passive:true});
    this.ui.setVisible(false);
    this.machinery.setPresentation('workbench');
    this.railSafety.setPresentation('workbench');
    this.machineryRefreshTimer = setInterval(() => { if (!document.hidden && !this.machineryMutationCount) void this.refreshMachineryContext(); }, 10000);
    window.addEventListener('focus', () => { void this.refreshMachineryContext(); }, { signal: this.events.signal });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.refreshMachineryContext();
    }, { signal: this.events.signal });
    window.addEventListener('beforeunload', () => this.dispose(), { signal: this.events.signal, once: true });
  }

  get isOpen(): boolean { return this.active; }
  get isSceneOpen(): boolean { return this.active && this.mode === 'scene'; }

  /** External display-directory actions stay in the active scene and use its guards. */
  async editFieldObject(kind: string, id: string): Promise<void> {
    if (!this.active) return;
    await this.sceneAction(kind === 'machine' ? 'field-edit-machine' : 'field-rail-config', { kind, id });
  }
  openEngineeringTool(tab: string): boolean {
    if (!this.active) return true;
    this.exitToWorkbench(tab); return !this.active;
  }
  openDisplayManager(): void {
    if (this.active) { if (this.mode !== 'scene' && !this.changeMode('scene')) return; this.ui.setScenePanel('display'); }
    else this.workbench.onDisplayManager?.();
  }

  /** Both entrances use the same session, records and renderer; no second project store exists. */
  private acceptSharedSnapshot(data: ManagementSnapshot): void {
    if (this.disposed) return;
    if (this.data?.projectId === data.projectId && this.data.session.userId === data.session.userId && this.data.revision > data.revision) return;
    const changed = this.data && this.data.projectId !== data.projectId;
    if (changed) this.machineryContextGeneration++;
    this.data = data;
    if (JSON.stringify(this.session) !== JSON.stringify(data.session)) this.sessionChanged(data.session);
    this.machineryStatus = data.projectId !== 'safety:project' ? '当前项目尚未接入机械三维场景。' : !data.session.permissions.includes('models') ? '当前账号没有模型查看权限。' : '';
    this.syncMachinery();
    if (!this.active) return;
    if (changed) { this.selection = null; this.selectedFieldObject = undefined; this.selectedMachineryId = undefined; this.backViews = []; this.videoDiagnostics.close(); this.safety.managementInvalidateProjection('project-change'); this.safety.managementPause(); this.applyMode('management'); }
    this.safety.setManagementIssues(data.collections.issues, data.revision, !Array.isArray(data.members.find(member => member.id === data.session.userId)?.taskIds));
    this.refreshAnchors(); this.maybeOpenInitialScene(); this.updateContext(this.safety.getManagementContext());
  }

  async refreshMachineryContext(): Promise<void> {
    if (this.disposed) return;
    if (this.machineryRefresh) return this.machineryRefresh;
    this.machineryRefresh = this.ui.refresh().finally(() => { this.machineryRefresh = undefined; });
    return this.machineryRefresh;
  }

  getWorkbenchMachineryState() {
    const canView = !!this.session?.permissions.includes('models') && this.data?.projectId === 'safety:project';
    return { projectId: this.data?.projectId, actorId: this.session?.userId, canView, canEdit: canView && !!this.session?.permissions.includes('resource'),
      records: canView ? (this.data?.collections.resources ?? []).filter(record => record.projectId === this.data?.projectId && (record.kind === 'equipment' || record.category === 'equipment') && readMachineryState(record.machinery)) : [],
      status: this.machineryStatus, panelOpen: this.machinery.isOpen, hasDraft: this.machinery.hasDraft, picking: this.machinery.isPicking };
  }

  /** Match the existing scene resource gate; personal display overrides cannot grant access. */
  getWorkbenchLayerAccess() { return this.safety.getManagementResourceAccess(); }

  getWorkbenchDisplayObjects() { return this.railSafety.getDisplayObjects(); }
  setWorkbenchDisplayVisibility(overrides: Record<string, boolean>, labelsVisible: boolean) {
    const machines: Record<string, boolean> = Object.create(null);
    for (const [key, value] of Object.entries(overrides)) if (key.startsWith('machine:')) machines[key.slice(8)] = value;
    this.machinery.setDisplayVisibility(machines);
    this.railSafety.setDisplayVisibility(overrides, labelsVisible);
    const signature = JSON.stringify([this.data?.projectId, this.session?.userId, machines]);
    if (signature !== this.fieldVisibilitySignature) { this.fieldVisibilitySignature = signature; this.queueFieldUpdate(); }
  }
  locateRailDisplayObject(id: string) { return this.railSafety.locateDisplayObject(id); }
  selectRailDisplayObject(kind: string, id: string) { this.railSafety.selectDisplayObject(kind, id); }

  /** Root workbench navigation must not abandon an unsaved mechanical placement. */
  prepareWorkbenchNavigation(): boolean {
    if (this.active) return true;
    if (this.railSafety.hasDraft || this.railSafety.isPicking || this.railSafety.isBusy) {
      this.railSafety.open(); this.message('请先保存或取消管控草稿，或结束范围绘制。'); return false;
    }
    if (!this.railSafety.close()) return false;
    if (this.machinery.hasDraft || this.machinery.isPicking || this.machinery.isBusy) {
      this.machinery.open(); this.message('请先保存、取消机械草稿或结束位置点选。'); return false;
    }
    return this.machinery.close();
  }

  async openWorkbenchMachinery(recordId?: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    if (this.active) return false;
    if (this.railSafety.hasDraft || this.railSafety.isPicking || this.railSafety.isBusy) { this.message('请先保存或取消管控草稿。'); return false; }
    if (!this.railSafety.close()) return false;
    await this.refreshMachineryContext();
    if (this.disposed || this.active || !isCurrent()) return false;
    if (!this.getWorkbenchMachineryState().canView) {
      this.message(this.machineryStatus || '请通过“现场工作台”登录或核对当前项目模型权限。', true); return false;
    }
    this.machinery.setPresentation('workbench'); this.syncMachinery(); this.machinery.open();
    if (recordId) await this.machinery.selectResource(recordId);
    return this.machinery.isOpen;
  }

  async openWorkbenchRailSafety(isCurrent: () => boolean = () => true): Promise<boolean> {
    if (this.active || !this.prepareWorkbenchNavigation()) return false;
    await this.refreshMachineryContext();
    if (this.disposed || this.active || !isCurrent()) return false;
    if (!this.getWorkbenchMachineryState().canView) {
      this.message(this.machineryStatus || '请先登录并核对模型查看权限。', true); return false;
    }
    this.railSafety.setPresentation('workbench'); this.syncMachinery(); this.railSafety.open();
    return this.railSafety.isOpen;
  }

  /** Future device adapters submit explicit WGS84 samples through the same visible-project checks as the panel. */
  ingestRailSafetyPosition(input: unknown) {
    if (this.disposed) throw new Error('工作台已关闭，不能接收定位数据');
    return this.railSafety.ingestPositionSample(input);
  }

  private async openRailSafetyTasks(taskId?: string): Promise<void> {
    if (!this.session || !this.data) { this.message('请先登录并读取当前项目。', true); return; }
    const keepScene = this.isSceneOpen;
    if (!this.guardNavigation() || !this.railSafety.close()) return;
    const projectId = this.data?.projectId, actorId = this.session.userId;
    if (!this.active) await this.open();
    if (this.disposed || !this.active || this.data?.projectId !== projectId || this.session?.userId !== actorId) return;
    if (taskId && this.data.collections.tasks.some(task => task.id === taskId)) {
      if (!keepScene && !this.changeMode('management')) return;
      this.ui.showRecord('tasks', taskId);
    } else { if (this.changeMode('management')) this.ui.openTaskList(); }
  }

  private async openRailSafetyIssue(issueId: string): Promise<void> {
    if (!this.session || !this.data?.collections.issues.some(issue => issue.id === issueId)) { this.message('处置单不可见，请刷新当前项目。', true); return; }
    const keepScene = this.isSceneOpen;
    if (!this.guardNavigation() || !this.railSafety.close()) return;
    const projectId = this.data.projectId, actorId = this.session.userId;
    if (!this.active) await this.open();
    if (this.disposed || !this.active || this.data?.projectId !== projectId || this.session?.userId !== actorId) return;
    if (!keepScene && !this.changeMode('management')) return;
    if (this.data.collections.issues.some(issue => issue.id === issueId)) this.ui.showRecord('issues', issueId);
  }

  async locateWorkbenchMachinery(recordId: string): Promise<void> {
    const projectId = this.data?.projectId, actorId = this.session?.userId, generation = this.machineryContextGeneration;
    await this.refreshMachineryContext();
    if (this.disposed || generation !== this.machineryContextGeneration || this.data?.projectId !== projectId || this.session?.userId !== actorId) throw new Error('定位上下文已变化，请重新选择当前机械。');
    const state = this.getWorkbenchMachineryState();
    const record = state.records.find(item => item.id === recordId);
    if (!state.canView || !record) throw new Error('当前账号无权定位此机械，或记录已移除。');
    if (!this.machinery.getDisplayVisibility(recordId)) throw new Error('该机械当前隐藏，请在右侧显示管理中显示后再定位。');
    if (this.machinery.hasDraft || this.machinery.isPicking) throw new Error('请先保存或取消当前机械草稿。');
    if (await this.machinery.locate(recordId)) return;
    const saved = readMachineryState(record.machinery)!;
    const height = saved.parameters.overall_height_m ?? saved.parameters.total_height_m ?? 10;
    this.viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(saved.placement.longitude, saved.placement.latitude, saved.placement.height + Math.max(30, height * 6)), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: .8 });
  }

  async setWorkbenchMachineryVisibility(recordId: string, visible: boolean): Promise<void> {
    if (this.machinery.hasDraft || this.machinery.isPicking || this.machinery.isBusy) throw new Error('请先保存或取消当前机械草稿。');
    await this.refreshMachineryContext();
    const state = this.getWorkbenchMachineryState(), record = state.records.find(item => item.id === recordId);
    if (!state.canEdit || !record) throw new Error('当前账号没有此机械的编辑权限。');
    const machinery = readMachineryState(record.machinery)!;
    await this.mutateMachinery('machinery.save', recordId, record.revision, { machinery: { ...machinery, visible } });
  }

  async open(): Promise<void> {
    if (this.active || !this.prepareWorkbenchNavigation()) return;
    this.workbench.onPanelChange?.(false); this.machinery.setPresentation('management'); this.railSafety.setPresentation('management');
    this.active = true; this.defaultScenePending = true; this.sceneHostReady = false; this.mode = 'management'; this.ui.setViewMode('management'); this.ui.setVisible(true); this.syncMachinery();
    this.safety.attachManagementHost({ videoHost: this.ui.videoHost,
      onContext: context => this.updateContext(context), onSpatialSelected: id => this.spatialSelected(id),
      onIssueSelected: id => { if (!this.syncingSelection && this.data?.collections.issues.some(issue => issue.id === id)) this.ui.showRecord('issues', id); },
      getStageRect: () => this.mode === 'scene' ? this.ui.getSceneStageRect() : undefined });
    this.nativeDoubleClick = this.viewer.screenSpaceEventHandler.getInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    await this.safety.open();
    if (!this.active) return;
    this.safety.spatial.setManagementSelection([]);
    this.sceneHostReady = true; this.maybeOpenInitialScene();
    this.applyMode(this.mode);
    this.updateContext(this.safety.getManagementContext());
  }

  private exitToWorkbench(tab?: string): void {
    if (!this.guardNavigation()) return;
    if (this.data?.projectId !== 'safety:project') { this.message('当前项目尚未关联工程资料库，请在当前项目中继续办理业务。', true); return; }
    if (!['models','media','files'].every(p=>this.session?.permissions.some(v=>v===p))) { this.message('当前账户未获完整工程工作台权限，请由授权管理员接入资料。',true); return; }
    this.safety.spatial.requestClose(()=>{this.close();if(tab)document.querySelector<HTMLButtonElement>(`.tab[data-tab="${tab}"]`)?.click();});
  }

  close(): void {
    if (!this.active) return;
    this.machinery.close(); this.railSafety.close(); this.active = false; this.sceneHostReady = false; this.workbench.onDisplayMount?.(); this.machinery.setPresentation('workbench'); this.railSafety.setPresentation('workbench'); this.endMeasurement(); this.endAnchorPick(); this.layersDialog.close(); this.videoDiagnostics.close(); this.feedback.hidden = true;
    this.safety.spatial.setManagementSelection(undefined); this.safety.spatial.setManagementTopic(undefined); this.topicSignature=""; this.clearAnchors(); this.safety.attachManagementHost(undefined);
    this.safety.setManagementResourceAccess({models:this.data?.projectId === 'safety:project' && !!this.session?.permissions.includes('models'),files:this.data?.projectId === 'safety:project' && !!this.session?.permissions.includes('files'),media:this.data?.projectId === 'safety:project' && !!this.session?.permissions.includes('media')});
    this.safety.close(); this.ui.setVisible(false); this.syncMachinery();
    if (this.nativeDoubleClick) this.viewer.screenSpaceEventHandler.setInputAction(this.nativeDoubleClick, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  private sessionChanged(session: ManagementSession | null): void {
    const actorChanged=this.session?.userId!==session?.userId;
    if (JSON.stringify(this.session) !== JSON.stringify(session)) this.machineryContextGeneration++;
    this.session = session;
    clearTimeout(this.sessionExpiryTimer);
    if (session?.expiresAt) this.sessionExpiryTimer = setTimeout(() => this.ui.invalidateAccess(), Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    if (actorChanged) { this.selectedMachineryId = undefined; this.selectedFieldObject = undefined; this.defaultScenePending = true; if (this.data?.session.userId !== session?.userId) this.data = undefined; }
    if (!session) { this.data = undefined; this.machineryStatus = '会话已失效，请通过“现场工作台”重新登录。'; }
    this.syncMachinery();
    if (!this.active) return;
    if (actorChanged || !session) this.safety.clearManagementEvents();
    this.videoDiagnostics.close();
    if (actorChanged || !session?.permissions.includes("media") || !session.permissions.includes("models")) this.safety.managementSetProjectionPreview(false);
    this.session = session; this.syncMachinery();
    if(actorChanged){this.selection=null;this.backViews=[];this.ui?.setExternalSelection(null);this.safety.spatial.setManagementSelection([]);}
    this.safety.spatial.setActive(this.active && this.data?.projectId === 'safety:project' && !!session?.permissions.includes('models'));
    this.safety.setManagementResourceAccess({models:this.data?.projectId === 'safety:project' && !!session?.permissions.includes('models'),files:this.data?.projectId === 'safety:project' && !!session?.permissions.includes('files'),media:this.data?.projectId === 'safety:project' && !!session?.permissions.includes('media')});
    this.refreshAnchors();
    if (!session?.permissions.includes('models')) {
      this.endMeasurement(); this.endAnchorPick(); this.safety.managementPause(); this.mode = 'management';
      this.workbench.onDisplayMount?.(); this.ui?.setViewMode('management'); this.safety.setManagementSceneVisible(false);
    }
    this.safety.setManagementMediaAccess(!!session?.permissions.includes('media'));
    if (this.ui) this.updateContext(this.safety.getManagementContext());
  }
  private updateContext(context: ManagementSceneContext): void {
    if (!this.ui || !this.active) return;
    this.refreshAnchors();
    if(this.mode==='scene'&&!this.openedScene&&context.models.length&&this.safety.debugStats().data){this.openedScene=true;this.safety.managementHome();}
    const sceneProject = this.data?.projectId === "safety:project";
    const canModels = sceneProject && !!this.session?.permissions.includes('models'), canMedia = sceneProject && !!this.session?.permissions.includes('media'), canFiles = sceneProject && !!this.session?.permissions.includes('files');
    this.safety.setManagementResourceAccess({models:canModels,files:canFiles,media:canMedia});
    this.ui.updateSceneContext({ ...context,
      mode: canModels ? context.mode : undefined,
      field: canModels ? this.fieldContext() : undefined,
      toolState: canModels ? context.toolState : {visible:false,drawing:false,stage:'choose',canUndo:false,canRedo:false,draftVertices:0},
      models: canModels ? context.models : [], layers: context.layers.filter(layer=>['CAD','GIS'].includes(layer.kind)?canFiles:canModels),
      spatialObjects: canModels ? context.spatialObjects.filter(o => o.projectId === (this.data?.projectId ?? "safety:project")) : [],
      media: context.media.filter(m => m.kind === 'video' ? canMedia : canFiles),
      sourceAssets: context.sourceAssets.filter(m => m.kind === 'video' ? canMedia : canFiles),
      videoState: canMedia ? context.videoState : { available:false, playing:false, currentTime:0, duration:0, rate:1, error:'当前账户没有录像权限' },
    });
    this.applyTopic(context);
    document.body.classList.toggle('management-spatial-tool', this.mode === 'scene' && context.toolState.visible);
  }
  private maybeOpenInitialScene(): void {
    if (!this.active || !this.sceneHostReady || !this.defaultScenePending || !this.data || !this.session) return;
    this.defaultScenePending = false;
    if (this.data.projectId === 'safety:project' && this.session.permissions.includes('models')) this.applyMode('scene');
  }
  private queueFieldUpdate(): void {
    if (this.fieldUpdateQueued || this.disposed) return;
    this.fieldUpdateQueued = true;
    queueMicrotask(() => { this.fieldUpdateQueued = false; if (this.active && !this.disposed) this.updateContext(this.safety.getManagementContext()); });
  }
  private fieldContext(): ManagementFieldContext {
    const summary = this.railSafety.getFieldSummary();
    const results = new Map(summary.machines.map(result => [result.resourceId, result]));
    const records = (this.data?.collections.resources ?? []).filter(record => record.projectId === this.data?.projectId && record.status !== 'deleted' && !record.deletedAt && (record.kind === 'equipment' || record.category === 'equipment' || !!record.machinery));
    const seen = new Set<string>();
    const machinery: ManagementFieldContext['machinery'] = records.filter(record => !seen.has(record.id) && !!seen.add(record.id)).map(record => {
      const state = readMachineryState(record.machinery), result = results.get(record.id);
      const config = this.data?.collections.railSafety.find(item => item.status === 'active' && (item.definition as {resourceId?:string})?.resourceId === record.id);
      const task = this.data?.collections.tasks.find(item => item.id === config?.taskId);
      return { id: record.id, name: record.name, placed: !!state, enabled: record.status !== 'disabled' && record.availability !== 'disabled', visible: !!state && this.machinery.getDisplayVisibility(record.id),
        kind: state?.assetId, taskId: config?.taskId, workpointId: Array.isArray(task?.areaIds) ? task.areaIds.find((value): value is string => typeof value === 'string') : undefined,
        ...fieldMachineRisk(result, summary.pending, !!state) };
    });
    if (this.selectedMachineryId && !machinery.some(record => record.id === this.selectedMachineryId)) this.selectedMachineryId = undefined;
    if(this.selectedFieldObject&&!this.data?.collections[this.selectedFieldObject.kind].some(r=>r.id===this.selectedFieldObject!.id&&!r.deletedAt&&r.status!=='deleted'))this.selectedFieldObject=undefined;
    return { machinery, selectedMachineryId: this.selectedMachineryId, selectedObject:this.selectedFieldObject, pending: summary.pending, guardCount: summary.guardCount, limitCount: summary.limitCount,
      editor: this.machinery.isOpen ? 'machinery' : this.railSafety.isOpen ? 'rail-safety' : undefined,
      editorTitle: this.machinery.isOpen ? '机械布置与参数' : this.railSafety.isOpen ? '限界、防护与倾覆分析' : undefined };
  }
  private selectFieldMachine(id: string): boolean {
    if(!this.ui.canChangeFieldContext())return false;
    if (!this.active || this.mode !== 'scene' || this.data?.projectId !== 'safety:project' || !this.session?.permissions.includes('models')) return false;
    const record = this.data.collections.resources.find(record => record.id === id && record.projectId === this.data!.projectId && record.status !== 'deleted' && !record.deletedAt && (record.kind === 'equipment' || record.category === 'equipment' || !!record.machinery));
    if (!record) { this.message('机械记录已移除或不在当前授权范围内。', true); return false; }
    if (this.selectedMachineryId !== id) {
      if (!this.guardNavigation() || !this.machinery.close() || !this.railSafety.close()) return false;
    }
    this.selectedMachineryId = id; this.selectedFieldObject={kind:'resources',id}; this.selection = { kind: 'resources', id };
    this.ui.setExternalSelection(this.selection); this.ui.setScenePanel('object'); this.queueFieldUpdate(); return true;
  }
  private selectFieldObject(ref: FieldObjectReference): boolean {
    if(ref.kind==='resources')return this.selectFieldMachine(ref.id);
    if(!this.active||this.mode!=='scene'||!this.session?.permissions.includes('models')||!this.ui.canChangeFieldContext())return false;
    const record=this.data?.collections[ref.kind].find(r=>r.id===ref.id&&!r.deletedAt&&r.status!=='deleted');
    if(!record){this.message('对象已移除或不在当前授权范围内。',true);return false;}
    if(!this.guardNavigation()||!this.machinery.close()||!this.railSafety.close())return false;
    this.selectedFieldObject=ref;this.selectedMachineryId=undefined;this.selection={...ref};
    this.ui.setExternalSelection(this.selection);this.ui.setScenePanel('object');this.queueFieldUpdate();return true;
  }
  private prepareFieldEditor(kind: 'machinery' | 'rail-safety'): boolean {
    if (!this.changeMode('scene') || !this.guardNavigation()) return false;
    if (!(kind === 'machinery' ? this.railSafety.close() : this.machinery.close())) return false;
    this.endMeasurement(); this.endAnchorPick(); this.safety.optimization.close(); this.videoDiagnostics.close();
    this.safety.managementPause(); this.safety.managementSetProjectionPreview(false); this.syncMachinery(); this.ui.setScenePanel('object');
    return true;
  }
  private async fieldAction(action: string, args: Record<string, unknown>): Promise<void | boolean> {
    if (action === 'field-panel' || action === 'field-display') {
      const panel = action === 'field-display' ? 'display' : args.panel;
      if (panel === 'object' || panel === 'display' || panel === 'issues') this.ui.setScenePanel(panel);
      return;
    }
    if (action === 'field-editor-close') {
      if (!this.machinery.close() || !this.railSafety.close()) return false;
      this.queueFieldUpdate(); return true;
    }
    if (this.data?.projectId !== 'safety:project' || !this.session?.permissions.includes('models')) throw new Error('当前项目或账号没有现场模型权限。');
    const id = String(args.id ?? this.selectedMachineryId ?? '');
    if (action === 'field-select-machine') return this.selectFieldMachine(id);
    if (action === 'field-select-object' || action === 'field-locate-object') {
      const kind=args.kind;if(kind!=='resources'&&kind!=='railSafety'&&kind!=='anchors')throw new Error('现场对象类型无效');
      if(!this.selectFieldObject({kind,id}))return false;
      if(action==='field-locate-object'){if(kind==='resources'){if(!readMachineryState(this.data.collections.resources.find(r=>r.id===id)?.machinery)){this.message('当前机械尚未布置，已选中对象资料。');return false;}await this.locateWorkbenchMachinery(id);}else if(kind==='railSafety'){if(!await this.locateRailDisplayObject(id)){this.message('当前对象隐藏或没有可定位布置。');return false;}}else this.locate({kind,id});}return true;
    }
    if (action === 'field-locate-machine') {
      if (!this.guardNavigation() || !this.selectFieldMachine(id)) return false;
      await this.locateWorkbenchMachinery(id); return true;
    }
    if (action === 'field-edit-machine') {
      if (!this.prepareFieldEditor('machinery')) return false;
      if (id && !this.selectFieldMachine(id)) return false;
      this.machinery.open(); if (id) await this.machinery.selectResource(id); this.queueFieldUpdate(); return true;
    }
    if (action === 'field-analyse' || action === 'field-risk') {
      if (!this.prepareFieldEditor('rail-safety') || !this.selectFieldMachine(id)) return false;
      if (action === 'field-analyse' && readMachineryState(this.data.collections.resources.find(record => record.id === id)?.machinery)) {
        const projectId = this.data.projectId, actorId = this.session.userId, generation = this.machineryContextGeneration;
        // The selected object can be outside the current view. Frame the actual
        // machinery before playback so the demonstration is immediately visible.
        await this.locateWorkbenchMachinery(id);
        if (this.disposed || !this.active || this.mode !== 'scene' || this.selectedMachineryId !== id
          || this.data?.projectId !== projectId || this.session?.userId !== actorId || generation !== this.machineryContextGeneration) return false;
      }
      const opened = action === 'field-analyse' ? this.railSafety.openMachineAnalysis(id) : this.railSafety.openMachineRisk(id);
      this.queueFieldUpdate(); return opened;
    }
    if (action === 'field-rail-config' || action === 'field-display-effects') {
      if (!this.prepareFieldEditor('rail-safety')) return false;
      this.railSafety.open();
      if (action === 'field-display-effects') this.railSafety.openDisplayEffects();
      else if (args.kind === 'limit' || args.kind === 'guard') this.railSafety.openDefinition(args.kind, args.id ? String(args.id) : undefined);
      else if (args.id) this.railSafety.selectDisplayObject(String(args.kind || 'limit'), String(args.id));
      this.queueFieldUpdate(); return true;
    }
    if (action === 'field-home') {
      if (!this.guardNavigation()) return false;
      const models = this.safety.getManagementModels().filter(model => model.tileset.show && !model.tileset.isDestroyed());
      if (!models.length) { this.message('当前没有可定位的实景模型，请先加载工点模型。'); return false; }
      this.safety.managementPause(); this.viewer.camera.cancelFlight(); this.safety.managementHome(); return true;
    }
    if (action === 'field-issue-locate') { await this.locateFieldIssue(String(args.id || '')); return true; }
    throw new Error('当前现场操作尚未接入：' + action);
  }
  private async locateFieldIssue(id: string): Promise<void> {
    if (!this.guardNavigation() || !this.changeMode('scene')) return;
    const issue = this.data?.collections.issues.find(record => record.id === id && record.projectId === this.data!.projectId);
    if (!issue) throw new Error('问题不在当前授权范围内，请刷新后重试。');
    const source = issue.railSafetyRisk as RailSafetyRiskSnapshot | undefined;
    if(!source&&issue.objectRef){const ref=issue.objectRef as FieldObjectReference;if(await this.fieldAction('field-locate-object',ref))this.message('已定位对象当前布置；发现时的对象修订保留在问题记录中。');return;}
    if (!source || source.schemaVersion !== 1) {
      const view = this.cameraSnapshot(); this.syncingSelection = true;
      try { if (this.safety.managementSelectIssue(id, true)) this.backViews.push(view); else this.message('此问题没有可核验模型位置。'); } finally { this.syncingSelection = false; }
      return;
    }
    const resource = this.data?.collections.resources.find(record => record.id === source.resourceId && record.projectId === this.data!.projectId && record.status !== 'deleted' && !record.deletedAt);
    if (!resource || !readMachineryState(resource.machinery)) throw new Error('当前机械已移除或尚未布置；登记时的历史来源仍保留在问题详情中。');
    const projectId = this.data!.projectId, actorId = this.session!.userId, generation = this.machineryContextGeneration;
    await this.locateWorkbenchMachinery(resource.id);
    if (!this.active || projectId !== this.data?.projectId || actorId !== this.session?.userId || generation !== this.machineryContextGeneration) return;
    this.selectFieldMachine(resource.id);
    this.message(resource.revision === source.resourceRevision ? '已定位当前机械；登记时的筛查与证据保留在问题详情中。' : '已定位当前机械。机械修订已变化，请对照问题中登记时的来源和证据复核。');
  }
  private syncMachinery(): void {
    if (!this.machinery || !this.railSafety) return;
    // Camera, video progress and model-quality updates do not change saved machine inputs.
    // Record revisions, access changes and workspace lifecycle transitions still sync immediately.
    const signature = JSON.stringify([this.data?.projectId, this.data?.revision, this.session?.userId, this.session?.permissions, this.active, this.mode, this.disposed]);
    if (signature === this.machineryContextSignature) return;
    this.machineryContextSignature = signature;
    const sceneProject = this.data?.projectId === 'safety:project';
    this.safety.setManagementResourceAccess({ models: sceneProject && !!this.session?.permissions.includes('models'), files: sceneProject && !!this.session?.permissions.includes('files'), media: sceneProject && !!this.session?.permissions.includes('media') });
    this.machinery?.setContext({
      projectId: this.data?.projectId ?? 'safety:project', actorId: this.session?.userId,
      records: this.data?.collections.resources ?? [],
      canView: !!this.session?.permissions.includes('models') && this.data?.projectId === 'safety:project',
      canEdit: this.data?.projectId === 'safety:project' && !!this.session?.permissions.includes('models') && !!this.session?.permissions.includes('resource'),
      active: !this.disposed && (!this.active || this.mode === 'scene'),
    });
    this.railSafety?.setContext({
      projectId: this.data?.projectId ?? 'safety:project', actorId: this.session?.userId,
      records: this.data?.collections.railSafety ?? [], resources: this.data?.collections.resources ?? [], tasks: this.data?.collections.tasks ?? [],
      canCreateTask: !!this.session?.permissions.includes('plan'),
      canReportRisk: !!this.session?.permissions.includes('models') && !!this.session.permissions.includes('field'),
      issues: this.data?.collections.issues ?? [], allocations: this.data?.collections.allocations ?? [],
      canView: !!this.session?.permissions.includes('models') && this.data?.projectId === 'safety:project',
      canEdit: this.data?.projectId === 'safety:project' && !!this.session?.permissions.includes('models') && !!this.session?.permissions.includes('resource'),
      active: !this.disposed && (!this.active || this.mode === 'scene'),
    });
    this.workbench.onChange?.();
  }
  private async mutateMachinery(type: ManagementCommandType, id: string, revision: number | undefined, payload: { machinery?: MachineryMetadata; [key: string]: unknown }): Promise<void> {
    const projectId = this.data?.projectId, actorId = this.session?.userId;
    const riskReport = type === 'railSafety.reportRisk';
    if (this.disposed || projectId !== 'safety:project' || !this.session?.permissions.includes('models') || !this.session.permissions.includes(riskReport ? 'field' : 'resource')) throw new Error(riskReport ? '当前项目或账号没有筛查风险登记权限' : '当前项目或账号没有机械布置权限');
    const signature = JSON.stringify([projectId, actorId, type, id, revision, payload]);
    if (this.machineryReceipt?.signature !== signature) this.machineryReceipt = { signature, key: crypto.randomUUID() };
    const key = this.machineryReceipt.key, generation = this.machineryContextGeneration;
    this.machineryMutationCount++;
    try {
    const response = await fetch(`${MANAGEMENT_API}/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cesium-Library': '1' }, signal: this.events.signal,
      body: JSON.stringify({ projectId, type, id, expectedRevision: revision, payload, idempotencyKey: key }),
    });
    const result = await response.json();
    if (this.disposed || generation !== this.machineryContextGeneration || this.data?.projectId !== projectId || this.session?.userId !== actorId) return;
    if (!response.ok) {
      if ([401,403].includes(response.status) && this.session?.userId === actorId) this.ui.invalidateAccess();
      throw Object.assign(new Error(result.error || (riskReport ? '风险登记失败，请重试' : '机械保存失败，输入已保留')), { status: response.status, current: result.current, code: result.code, details: result.details });
    }
    if (this.machineryReceipt?.key === key) this.machineryReceipt = undefined;
    if (this.disposed || generation !== this.machineryContextGeneration || this.data?.projectId !== projectId || this.session?.userId !== actorId) return;
    this.ui.acceptExternalSnapshot(result as ManagementSnapshot);
    } finally { this.machineryMutationCount--; }
  }
  private guardNavigation(): boolean {
    if (this.ui && !this.ui.canChangeFieldContext()) return false;
    if (this.railSafety?.hasDraft || this.railSafety?.isPicking || this.railSafety?.isBusy) { if (this.isSceneOpen) this.ui.setScenePanel('object'); this.railSafety.open(); this.message('请先保存或取消邻近营业线管控草稿。'); return false; }
    if (this.machinery?.hasDraft || this.machinery?.isPicking || this.machinery?.isBusy) { if (this.isSceneOpen) this.ui.setScenePanel('object'); this.machinery.open(); this.message('请先保存或取消机械布置草稿。'); return false; }
    if (this.measurement || this.anchorPicking) { this.message('请先结束当前取点或测量（Esc）。'); return false; }
    if (this.safety.spatial.debugStats().dirty) { this.message('请先完成、保存或取消当前几何草稿。'); return false; }
    return true;
  }
  private changeMode(mode: 'management'|'scene'): boolean {
    if (mode !== this.mode && !this.guardNavigation()) return false;
    if (mode === 'scene' && this.data?.projectId && this.data.projectId !== 'safety:project') { this.message('当前项目尚未关联独立模型资料库，请先完成项目模型配置。',true); return false; }
    if (mode === 'scene' && !this.session?.permissions.includes('models')) { this.message('当前账户未获模型访问权限，请在项目成员中配置。',true); return false; }
    if (this.measurement) this.endMeasurement();
    if (this.anchorPicking) this.endAnchorPick();
    return this.safety.spatial.requestClose(() => { this.applyMode(mode); this.ui.setViewMode(mode); });
  }
  private applyMode(mode: 'management'|'scene'): void {
    this.mode = mode; this.syncMachinery(); this.workbench.onDisplayMount?.(mode === 'scene' ? this.ui.sceneDisplayHost : undefined); this.ui.setViewMode(mode); this.safety.setManagementSceneVisible(mode === 'scene');
    if (mode === 'scene' && !this.openedScene && this.safety.debugStats().data && this.safety.getManagementContext().models.length) { this.openedScene = true; this.safety.managementHome(); if (this.selection) this.select(this.selection); }
    if (mode !== 'scene') { this.safety.optimization.close(); this.machinery?.close(); this.railSafety?.close(); }
    for(const entity of this.anchorEntities.values())entity.show=mode==='scene'&&!!this.session?.permissions.includes('models');
    this.updateContext(this.safety.getManagementContext());
  }
  private areas(selection: Selection): string[] {
    if (selection.kind === 'spatial' || selection.spatialObjectId) return [selection.spatialObjectId || selection.id];
    if (selection.areaIds?.length) return selection.areaIds;
    const record = this.data?.collections.tasks.find(t => t.id === selection.id);
    return Array.isArray(record?.areaIds) ? record.areaIds.filter((s):s is string=>typeof s==='string') : [];
  }
  private select(selection: Selection): void {
    this.selection = selection;
    if(['resources','railSafety','anchors'].includes(selection.kind))this.selectedFieldObject={kind:selection.kind as FieldObjectReference['kind'],id:selection.id};
    for(const [id,entity] of this.anchorEntities){if(entity.point){entity.point.color=new ConstantProperty(Color.fromCssColorString(selection.kind==='anchors'&&selection.id===id?'#F5B45C':'#A994EA'));entity.point.pixelSize=new ConstantProperty(selection.kind==='anchors'&&selection.id===id?14:9);}}
    if(selection.kind==='issues'){this.syncingSelection=true;try{this.safety.managementSelectSpatial(undefined,[]);this.safety.managementSelectIssue(selection.id);}finally{this.syncingSelection=false;}return;}
    const ids = this.areas(selection); this.syncingSelection = true;
    try { this.safety.managementSelectSpatial(ids[0], ids); } finally { this.syncingSelection = false; }
  }
  private spatialSelected(id: string): void {
    if (this.syncingSelection || !this.active) return;
    const current = this.selection && this.areas(this.selection).includes(id) ? this.selection : { kind:'spatial', id, spatialObjectId:id };
    this.selection = current; this.ui.setExternalSelection(current);
  }
  private locate(selection: Selection): void {
    if(selection.kind==='issues' && (this.data?.collections.issues.find(issue => issue.id === selection.id)?.railSafetyRisk||this.data?.collections.issues.find(issue=>issue.id===selection.id)?.objectRef)){void this.locateFieldIssue(selection.id).catch(error => this.message(error instanceof Error ? error.message : String(error), true));return;}
    if(selection.kind==='issues'){if(!this.changeMode('scene'))return;const view=this.cameraSnapshot();this.syncingSelection=true;try{if(this.safety.managementSelectIssue(selection.id,true))this.backViews.push(view);else this.message('此问题没有可核验模型位置。');}finally{this.syncingSelection=false;}return;}
    if(selection.kind==='anchors'){const anchor=this.anchorEntities.get(selection.id);if(!anchor){this.message('资料位置模型版本已变化或暂不可用',true);return;}if(!this.changeMode('scene'))return;this.backViews.push(this.cameraSnapshot());this.select(selection);this.safety.managementPause();void this.viewer.flyTo(anchor,{duration:1.2,offset:new HeadingPitchRange(this.viewer.camera.heading,-.65,130)});return;}
    const ids = this.areas(selection);
    if (!ids.length) { this.message('该记录未关联有效位置，仍可正常办理和统计。'); return; }
    if (!this.changeMode('scene')) return;
    const view = this.cameraSnapshot();
    this.select(selection);
    if (this.safety.managementLocateSpatial(ids[0])) { this.backViews.push(view); if (this.backViews.length > 20) this.backViews.shift(); }
    else this.message('该位置或模型版本暂不可用，请核对来源。',true);
  }
  private validSelection(selection:Selection):boolean {
    if(selection.kind==='spatial')return this.safety.spatial.getSnapshot().objects.some(o=>o.id===selection.id&&!o.deletedAt&&o.projectId===this.data?.projectId);
    const kind=selection.kind==='task'?'tasks':selection.kind;return !!this.data&&Object.entries(this.data.collections).some(([key,rows])=>key===kind&&rows.some(row=>row.id===selection.id));
  }
  private cameraSnapshot(): CameraState {
    const c = this.viewer.camera;
    return { position:vector(c.positionWC), direction:vector(c.directionWC), up:vector(c.upWC),
      models:this.safety.getManagementModels().map(({assetId,assetVersion,coordinateTransformVersion})=>({assetId,assetVersion,coordinateTransformVersion})) };
  }
  private validatedCamera(value: unknown): CameraState {
    const view = value as CameraState;
    if (!view || !['position','direction','up'].every(k=>Array.isArray(view[k as keyof CameraState]) && (view[k as keyof CameraState] as number[]).length===3 && (view[k as keyof CameraState] as number[]).every(Number.isFinite))) throw new Error('保存视角坐标无效');
    const current = this.safety.getManagementModelVersions();
    if(!Array.isArray(view.models)||!view.models.length||!view.models.every(saved=>current.some(actual=>actual.assetId===saved.assetId&&actual.assetVersion===saved.assetVersion&&actual.coordinateTransformVersion===saved.coordinateTransformVersion)))throw new Error('模型或变换版本已变化，旧视角需要重新核对');
    return view;
  }
  private restoreCamera(value: unknown): void {
    const view=this.validatedCamera(value);
    this.safety.managementPause(); this.viewer.camera.cancelFlight();
    this.viewer.camera.flyTo({destination:cartesian(view.position),orientation:{direction:cartesian(view.direction),up:cartesian(view.up)},duration:1});
  }
  private async sceneAction(action: string, args: Record<string, unknown> = {}): Promise<void | boolean> {
    if (!this.active) return false;
    if (action.startsWith('field-')) return this.fieldAction(action, args);
    if (action === 'rail-safety') {
      if (!this.changeMode('scene') || !this.guardNavigation() || !this.machinery.close()) return false;
      this.safety.spatial.requestClose(() => {
        this.endMeasurement(); this.endAnchorPick(); this.safety.optimization.close(); this.videoDiagnostics.close();
        this.safety.managementPause(); this.safety.managementSetProjectionPreview(false); this.syncMachinery(); this.ui.setScenePanel('object'); this.railSafety.open();
      });
      return;
    }
    if (action === 'machinery') {
      if (!this.changeMode('scene') || !this.guardNavigation() || !this.railSafety.close()) return false;
      this.safety.spatial.requestClose(() => {
        this.endMeasurement(); this.endAnchorPick(); this.safety.optimization.close(); this.videoDiagnostics.close();
        this.safety.managementPause(); this.safety.managementSetProjectionPreview(false); this.syncMachinery(); this.ui.setScenePanel('object'); this.machinery.open();
      });
      return;
    }
    if (['home','return','restore-view','draw','edit-spatial','define-anchor','quality','measure','play-media','play','follow','import-media','source-settings','calibration','model-settings','import-model','video-diagnostics'].includes(action) && (this.machinery?.isOpen || this.railSafety?.isOpen)) {
      if (!this.guardNavigation() || !this.machinery.close() || !this.railSafety.close()) return false;
    }
    if(action==='topic'||action==='theme'){this.topic=String(args.topic||args.theme||'overview');this.topicTaskIds=Array.isArray(args.taskIds)?args.taskIds.filter((v):v is string=>typeof v==='string'):undefined;this.topicProgress=Array.isArray(args.taskProgress)?args.taskProgress as typeof this.topicProgress:[];this.applyTopic(this.safety.getManagementContext());return;}
    if (['play-media','play','follow','seek'].includes(action)&&(this.measurement||this.anchorPicking||this.safety.spatial.debugStats().visible))throw new Error('请先结束绘制、资料取点或测量，再播放或恢复跟随');
    if (action === 'return') { const view=this.backViews.pop();if(view)this.restoreCamera(view);else this.message('尚无可返回的定位视角');return; }
    if (action === 'restore-view') {
      if(!this.guardNavigation()||!this.session?.permissions.includes('models'))return false;
      const view=this.validatedCamera(args.camera),context=this.safety.getManagementContext();
      const layers=Array.isArray(args.layers)?args.layers as Array<{id:string;visible:boolean}>:[];
      if(layers.some(layer=>typeof layer.visible!=='boolean'||!context.layers.some(current=>current.id===layer.id)))throw new Error('保存视图的图层已变化，请重新核对');
      const selection=args.selection as Selection|null|undefined;
      if(selection&&!this.validSelection(selection))throw new Error('保存视图的对象不在当前授权台账内');
      const mode=args.viewMode==='management'?'management':'scene';
      if(!this.changeMode(mode))return false;
      for(const layer of layers)if(context.layers.find(current=>current.id===layer.id)?.visible!==layer.visible)this.safety.managementLayer(layer.id,layer.visible);
      if(selection)this.select(selection);else{this.selection=null;this.safety.spatial.setManagementSelection([]);}
      this.safety.managementPause();this.viewer.camera.cancelFlight();
      const camera={destination:cartesian(view.position),orientation:{direction:cartesian(view.direction),up:cartesian(view.up)}};
      if(mode==='management')this.viewer.camera.setView(camera);else this.viewer.camera.flyTo({...camera,duration:1});
      return true;
    }
    if (action === 'home') { this.endMeasurement();this.endAnchorPick();this.safety.spatial.requestClose(()=>this.safety.managementHome());return; }
    if (action === 'draw' || action === 'edit-spatial') { if(!this.session?.permissions.includes('field'))throw new Error('当前账户没有空间对象编辑权限');if(!this.changeMode('scene'))return;this.endMeasurement();this.endAnchorPick();this.safety.managementOpenEditor(args.kind as 'construction-area'|'railway'|'risk-point'|undefined,action==='edit-spatial'?String(args.id):undefined);return; }
    if (['undo','redo','finish','cancel'].includes(action)) { this.safety.spatial.command(action as 'undo'|'redo'|'finish'|'cancel');this.updateContext(this.safety.getManagementContext());return; }
    if (action === 'define-anchor') { if (this.changeMode('scene')) this.beginAnchorPick(args.purpose === 'quality' ? 'quality' : 'document'); return; }
    if (action === 'quality') { this.endMeasurement();this.endAnchorPick();this.safety.managementQuality();return; }
    if (action === 'layer-settings') { this.openLayers(); return; }
    if (action === 'layers') { this.openDisplayManager();return; }
    if (action === 'layer') { this.safety.managementLayer(String(args.id),!!args.visible);return; }
    if (action === 'mode') { this.safety.managementMode(args.mode==='inspection'?'inspection':'presentation');return; }
    if (action === 'measure') { this.beginMeasurement();return; }
    if (action === 'end-measure') { this.endMeasurement();return; }
    if (action === 'play-media') { if(!this.session?.permissions.includes('media'))throw new Error('当前账户没有录像权限');if(!this.changeMode('scene'))return;await this.safety.managementPlayMedia(String(args.id));return; }
    if (['play','pause','seek','rate','follow'].includes(action)) { this.safety.managementMediaControl(action as 'play'|'pause'|'seek'|'rate'|'follow',action==='seek'?Number(args.seconds):action==='rate'?Number(args.rate):!!args.enabled);return; }
    if (action === 'end-fusion') { this.safety.managementSetProjectionPreview(false);return; }
    if (action === 'video-diagnostics') { if (!this.session?.permissions.includes('media') || !this.session.permissions.includes('models') || this.data?.projectId !== 'safety:project') throw new Error('当前项目或账户无视频与模型诊断权限'); this.videoDiagnostics.open(); return; }
    if (action === 'capture') { this.safety.managementPause();this.message('正在固定当前原片帧…');await this.captureEvidence();return; }
    if (action === 'import-media' || action === 'source-settings' || action === 'calibration') { this.exitToWorkbench('videoar');return; }
    if (action === 'model-settings' || action === 'import-model') { this.exitToWorkbench('tiles');return; }
    if (action === 'refresh-scene') { await this.safety.reload(true);return; }
    throw new Error('当前操作尚未接入：'+action);
  }
  private openLayers(): void {
    const layers=this.safety.getManagementContext().layers;
    this.layersDialog.innerHTML='<header><h2>图层与显示</h2><button type="button" data-scene-config="close">关闭</button></header><p>工程原始坐标不随显示配置改变。</p><div class="management-layer-list">'+layers.map(r=>`<label><input type="checkbox" data-layer-id="${escapeHtml(r.id)}" ${r.visible?'checked':''}><span>${escapeHtml(r.name)}<small>${escapeHtml(r.kind)}${r.quality ? ` · ${escapeHtml(r.quality)}` : ''}</small></span></label>`).join('')+'</div><footer><button type="button" data-scene-config="mode" data-mode="presentation">展示材质</button><button type="button" data-scene-config="mode" data-mode="inspection">原始实景</button><button type="button" data-scene-config="measure">两点空间测量</button></footer>';
    this.layersDialog.showModal();
  }
  private beginMeasurement(): void {
    if (!this.session?.permissions.includes('models')) return;
    this.safety.spatial.requestClose(()=>{
      this.endMeasurement();this.endAnchorPick();this.safety.managementSetProjectionPreview(false);this.safety.managementPause();this.safety.optimization.close();this.safety.effects.setPickingEnabled(false);this.safety.effects.setAuthoring(true);
      const handler=new ScreenSpaceEventHandler(this.viewer.canvas), state=this.measurement={handler,points:[] as Cartesian3[],entities:[] as Entity[]};
      handler.setInputAction(({position}:{position:Cartesian2})=>{
        const hit=strictModelSurfacePick(this.viewer,position,this.safety.getManagementModels(),()=>this.safety.effects.suspendOverlaysForPicking());
        if(!hit.ok){this.message('请点击当前倾斜摄影模型的有效表面。',true);return;}
        const a=hit.anchor.position,p=new Cartesian3(a.x,a.y,a.z);state.points.push(p);
        state.entities.push(this.viewer.entities.add({position:new ConstantPositionProperty(p),point:{pixelSize:8,color:Color.fromCssColorString('#F5B45C')}}));
        if(state.points.length===2){const distance=Cartesian3.distance(state.points[0],p);state.entities.push(this.viewer.entities.add({polyline:{positions:state.points,width:2,material:Color.fromCssColorString('#F5B45C')}}));this.message(`两点空间距离 ${distance.toFixed(3)} 米 · 原模型坐标 · Esc 退出`);handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);}
        else this.message('已选第一个模型点，请点选第二点；Esc 退出。');
        this.viewer.scene.requestRender();
      },ScreenSpaceEventType.LEFT_CLICK);
      this.message('测量已暂停视频与自动镜头；在模型表面选择两点，Esc 退出。');
    });
  }
  private endMeasurement(): void {
    const state=this.measurement;if(!state)return;state.handler.destroy();for(const e of state.entities)this.viewer.entities.remove(e);
    this.measurement=undefined;this.safety.effects.setAuthoring(false);this.safety.effects.setPickingEnabled(true);this.viewer.scene.requestRender();
  }
  private beginAnchorPick(purpose: 'document'|'quality'): void {
    this.safety.spatial.requestClose(()=>{
      this.endMeasurement();this.endAnchorPick();this.safety.managementSetProjectionPreview(false);this.safety.managementPause();this.safety.optimization.close();
      this.safety.effects.setPickingEnabled(false);this.safety.effects.setAuthoring(true);
      const handler=this.anchorPicking=new ScreenSpaceEventHandler(this.viewer.canvas);
      handler.setInputAction(({position}:{position:Cartesian2})=>{
        const result:SurfacePickResult=strictModelSurfacePick(this.viewer,position,this.safety.getManagementModels(),()=>this.safety.effects.suspendOverlaysForPicking());
        if(!result.ok){this.message('该处没有可核验模型表面，未建立资料位置。',true);return;}
        this.endAnchorPick();this.ui.anchorPicked({anchor:result.anchor,position:result.position,purpose});
      },ScreenSpaceEventType.LEFT_CLICK);
      this.message('请在模型表面选取独立资料位置；该点不会计入风险点。Esc 取消。');
    });
  }
  private endAnchorPick(): void { if(!this.anchorPicking)return;this.anchorPicking.destroy();this.anchorPicking=undefined;this.safety.effects.setAuthoring(false);this.safety.effects.setPickingEnabled(true); }
  private async captureEvidence(): Promise<void> {
    if(this.capturing)throw new Error('当前取证正在保存，请等待回执');
    const video=this.safety.getManagementVideo(), context=this.safety.getManagementContext();
    if(!video || !video.videoWidth || video.readyState<2 || !context.videoState.available)throw new Error('原片尚未就绪，未生成证据');
    if(!this.session?.permissions.includes('field'))throw new Error('当前账户没有证据登记权限');
    const media=context.media.find(m=>m.id===context.videoState.selectedId);
    if(!media?.sourceRecordId)throw new Error('无法核验原片来源，未生成证据');
    const projectId=this.data?.projectId??'safety:project',actorId=this.session.userId,mediaId=media.id,sourceUrl=video.currentSrc;
    const taskId=this.ui.getCurrentFieldTaskId();const objectRef=this.selectedFieldObject?{...this.selectedFieldObject}:undefined;
    const current=()=>this.active&&this.ui.getCurrentFieldTaskId()===taskId&&JSON.stringify(this.selectedFieldObject)===JSON.stringify(objectRef)&&this.data?.projectId===projectId&&this.session?.userId===actorId&&this.safety.getManagementContext().videoState.selectedId===mediaId&&video.currentSrc===sourceUrl;
    this.capturing=true;try {
    const seconds=video.currentTime,canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法读取录像帧');ctx.drawImage(video,0,0);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('原片帧导出失败，未登记证据')),'image/png'));
    if(!current())throw new Error('取证上下文已切换，未登记截图');
    const name=`录像取证-${seconds.toFixed(3)}s.png`;
    const captureQuery=new URLSearchParams({projectId,name,...(taskId?{taskId}:{}),...(objectRef?{objectRefs:JSON.stringify([objectRef])}:{})});
    const upload=await fetch(`/__management/upload?${captureQuery}`, {method:'POST',headers:{'Content-Type':'image/png','X-Cesium-Library':'1'},body:blob});
    const raw=await upload.json();if(!upload.ok)throw new Error(raw.error||'取证上传失败，未登记证据');
    const file=raw.record??raw; if(!file.id)throw new Error('上传回执无效，未登记证据');
    if(!current())throw new Error('取证上下文已切换，原截图已上传保留，未自动关联任务');
    const evidenceId=crypto.randomUUID();
    const response=await fetch('/__management/commands',{method:'POST',headers:{'Content-Type':'application/json','X-Cesium-Library':'1'},body:JSON.stringify({projectId,type:'evidence.register',id:evidenceId,idempotencyKey:crypto.randomUUID(),payload:{fileId:file.id,sourceRecordId:media.sourceRecordId,mediaSeconds:seconds,taskId,name,...(objectRef?{objectRefs:[objectRef]}:{})}})});
    const value=await response.json();if(!response.ok)throw new Error(value.error||'证据绑定失败，原文件已保留，可重试登记');
    const evidence=(value as ManagementSnapshot).collections.evidence.find(r=>r.id===evidenceId);if(!evidence)throw new Error('证据已提交，但回执未包含该记录，请刷新核对');if(current()){this.ui.evidenceCaptured(evidence);this.message(`已保存原片 ${seconds.toFixed(3)} 秒证据，继续登记发现。`);}
    } finally {this.capturing=false;}
  }
  private clearAnchors(): void { this.anchorSignature=""; for(const entity of this.anchorEntities.values())this.viewer.entities.remove(entity);this.anchorEntities.clear(); }
  private refreshAnchors(): void {
    const models=this.safety.getManagementModels().filter(m=>m.tileset.show&&!m.tileset.isDestroyed());
    const signature=JSON.stringify([this.active,this.data?.projectId,this.session?.userId,this.session?.permissions.includes('models'),this.data?.collections.anchors.map(r=>[r.id,r.revision]),models.map(m=>[m.assetId,m.assetVersion,m.coordinateTransformVersion])]);
    if(signature===this.anchorSignature)return;
    this.clearAnchors();this.anchorSignature=signature;
    if(!this.active||!this.data||this.data.projectId!=='safety:project'||!this.session?.permissions.includes('models'))return;
    for(const record of this.data.collections.anchors){
      const anchor=record.anchor as {model?:{assetId?:string;assetVersion?:string;coordinateTransformVersion?:string};position?:{x:number;y:number;z:number}}|undefined;
      if(!anchor?.position||![anchor.position.x,anchor.position.y,anchor.position.z].every(Number.isFinite)||!models.some(m=>m.assetId===anchor.model?.assetId&&m.assetVersion===anchor.model.assetVersion&&m.coordinateTransformVersion===anchor.model.coordinateTransformVersion))continue;
      const entity=this.viewer.entities.add({id:'management-anchor:'+record.id,name:record.name,show:this.mode==='scene',position:new Cartesian3(anchor.position.x,anchor.position.y,anchor.position.z),properties:{managementAnchorId:record.id},point:{pixelSize:9,color:Color.fromCssColorString('#A994EA'),outlineColor:Color.WHITE,outlineWidth:1},label:{text:(record.purpose==='quality'?'质量位置 · ':'资料位置 · ')+record.name,font:'12px sans-serif',fillColor:Color.fromCssColorString('#EAF2F8'),showBackground:true,backgroundColor:Color.fromCssColorString('#0D2438').withAlpha(.9),pixelOffset:new Cartesian2(0,-24),scale:.9}});
      this.anchorEntities.set(record.id,entity);
    }
    this.viewer.scene.requestRender();
  }
  private applyTopic(context:ManagementSceneContext):void {
    if(!this.active)return;
    const colors:Record<string,string>={},all=this.data?.collections;
    const tasks=(all?.tasks||[]).filter(t=>!this.topicTaskIds||this.topicTaskIds.includes(t.id));
    const filtered=this.topicTaskIds!==undefined&&this.topicTaskIds.length!==(all?.tasks.length||0);
    const visibleIds=filtered?[...new Set([...context.spatialObjects.filter(o=>o.kind==='railway').map(o=>o.id),...tasks.flatMap(t=>Array.isArray(t.areaIds)?t.areaIds as string[]:[])])]:undefined;
    const rank:Record<string,number>={'#697E8D':0,'#30B9D6':1,'#36A982':2,'#F5B45C':3,'#D86D64':4};
    if(this.topic!=='overview')for(const object of context.spatialObjects){
      const related=tasks.filter(t=>Array.isArray(t.areaIds)&&t.areaIds.includes(object.id));let color='#697E8D';
      for(const task of related){let candidate='#697E8D';
        if(this.topic==='progress'){const p=this.topicProgress.find(p=>p.taskId===task.id);candidate=p?.percent==null?'#697E8D':p.percent>=100?'#36A982':p.percent>0?'#30B9D6':'#697E8D';}
        else if(this.topic==='quality'||this.topic==='safety'||this.topic==='quality-safety'){const issues=(all?.issues||[]).filter(r=>r.taskId===task.id&&(this.topic==='quality-safety'||r.kind===this.topic)&&r.verifiedAt&&!['false-positive','duplicate'].includes(r.status));candidate=issues.some(r=>r.status!=='closed')?'#D86D64':issues.length?'#36A982':'#697E8D';}
        else if(this.topic==='resources'||this.topic==='resource'){const needs=(all?.resourceNeeds||[]).filter(r=>r.taskId===task.id&&r.required!==false);candidate=!needs.length?'#697E8D':needs.every(r=>r.status==='confirmed')?'#36A982':'#F5B45C';}
        if((rank[candidate]||0)>(rank[color]||0))color=candidate;
      }
      if(this.topic==='progress'){const progress=related.map(t=>this.topicProgress.find(p=>p.taskId===t.id));color=progress.length&&progress.every(p=>p?.percent!=null&&p.percent>=100)?'#36A982':progress.some(p=>p?.percent!=null&&p.percent>0)?'#30B9D6':'#697E8D';}
      if(this.topic==='inspection'){const inspections=(all?.inspections||[]).filter(r=>Array.isArray(r.areaIds)&&r.areaIds.includes(object.id)||related.some(t=>r.taskId===t.id||Array.isArray(r.taskIds)&&r.taskIds.includes(t.id)));color=!inspections.length?'#697E8D':inspections.every(r=>r.status==='confirmed')?'#36A982':'#30B9D6';}
      colors[object.id]=color;
    }
    const signature=JSON.stringify({colors,visibleIds});if(signature===this.topicSignature)return;this.topicSignature=signature;
    this.safety.spatial.setManagementTopic({colors,visibleIds});
  }
  private message(text:string,error=false):void {
    clearTimeout(this.messageTimer);this.feedback.hidden=false;this.feedback.textContent=text;this.feedback.classList.toggle('is-error',error);
    this.messageTimer=setTimeout(()=>{this.feedback.hidden=true},7000);
  }
  debugStats() {return{active:this.active,mode:this.mode,selection:this.selection,measurement:!!this.measurement,backViews:this.backViews.length,viewerCount:document.querySelectorAll('#cesiumContainer canvas').length,videoCount:document.querySelectorAll('video').length,listeners:{preRender:this.viewer.scene.preRender.numberOfListeners,postRender:this.viewer.scene.postRender.numberOfListeners,clock:this.viewer.clock.onTick.numberOfListeners,cameraChanged:this.viewer.camera.changed.numberOfListeners},scene:this.safety.debugStats()};}
  dispose():void {if(this.disposed)return;this.disposed=true;this.close();clearInterval(this.machineryRefreshTimer);clearTimeout(this.sessionExpiryTimer);this.events.abort();clearTimeout(this.messageTimer);this.ui.dispose();this.anchorSelector.destroy();this.feedback.remove();this.layersDialog.remove();this.videoDiagnostics.dispose();this.machinery.dispose();this.railSafety.dispose();}
}
