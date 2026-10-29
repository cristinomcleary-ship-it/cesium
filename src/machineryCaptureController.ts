import type { Viewer } from 'cesium';
import type { MachineryMetadata } from './machineryTypes';
import type { LoadedMachineryAsset } from './machinery/types';
import { MachineryPoseHistoryUi } from './machineryPoseHistoryUi';
import { MachineryCaptureSession, type MachineryCaptureContext } from './machineryCaptureSession';
import { poseProvenanceFromTelemetry, type MachineryPoseSnapshot } from './machineryPoseRecorder';
import type { MachineryTelemetryFieldStatus } from './machineryTelemetry';
import { SceneVideoExportUi } from './sceneVideoExportUi';
import { waitForSceneVideoReady } from './sceneVideoReady';

type CaptureOptions = {
  viewer: Viewer; host: HTMLElement;
  getSnapshot: () => MachineryPoseSnapshot | undefined;
  getTelemetry: (resourceId: string) => { fields: readonly MachineryTelemetryFieldStatus[]; modelFrontAxisDeg: number };
  presetView: (signal: AbortSignal) => Promise<boolean>;
};
/** Controls share the existing Viewer. Recording history and video never alter a saved resource. */
export class MachineryCaptureController {
  private readonly root = document.createElement('details');
  private readonly session = new MachineryCaptureSession();
  private readonly history: MachineryPoseHistoryUi;
  private readonly video: SceneVideoExportUi;
  private contextKey = '';
  private selectedId = '';
  private visible = false;
  private available = false;
  constructor(private readonly options: CaptureOptions) {
    this.root.className = 'mp-capture'; this.root.dataset.role = 'machinery-capture';
    this.root.innerHTML = '<summary>姿态记录与视频</summary><p class="mp-help">姿态记录固定跟踪开始时的机械；关闭面板后继续记录。视频录制当前三维场景；关闭编辑器、切换机械或项目时取消录像。</p>';
    options.host.append(this.root);
    this.history = new MachineryPoseHistoryUi({ host: this.root, recorder: this.session.recorder,
      getSnapshot: () => this.currentSnapshot(), canRecord: () => this.session.canRecord });
    this.video = new SceneVideoExportUi({ viewer: options.viewer, host: this.root,
      title: '机械姿态视频（含场景）', presetLabel: '机械预设视角',
      fileName: () => (this.currentSnapshot()?.resourceName ?? '机械') + '-姿态与场景',
      onPrepare: async (view, signal) => {
        if (!this.available || !this.currentSnapshot()) throw new Error('请先选择具有有效姿态和位置的机械');
        await waitForSceneVideoReady(options.viewer, { signal, timeoutMs: 20_000,
          prepare: view === 'preset' ? async preparationSignal => {
            if (!await options.presetView(preparationSignal)) throw new Error('机械尚未完成场景加载，请稍后重试');
          } : undefined,
        });
      },
    });
    this.video.setAvailable(false, '请选择机械并打开编辑器后录像');
  }
  private currentSnapshot() { return this.session.remember(this.options.getSnapshot()); }
  setContext(context: MachineryCaptureContext, selectedId: string, editorVisible: boolean, selectedAvailable: boolean) {
    const key = `${context.actorId ?? ''}\u0000${context.projectId}\u0000${context.canView}\u0000${context.active}`;
    const changed = key !== this.contextKey || selectedId !== this.selectedId;
    if (changed || (this.visible && !editorVisible)) this.video.cancel('机械、项目或编辑状态已变化，录像已取消');
    this.contextKey = key; this.selectedId = selectedId; this.visible = editorVisible;
    this.session.setContext(context);
    this.history.setContext(this.session.recorder, () => this.currentSnapshot(), () => this.session.canRecord);
    const snapshot = this.currentSnapshot();
    if (snapshot) this.session.observe(snapshot.resourceId, snapshot.state, snapshot);
    this.available = context.canView && context.active && editorVisible && selectedAvailable;
    this.video.setAvailable(this.available, '请选择具有有效姿态和位置的机械，并打开编辑器后录像');
    this.root.hidden = !context.canView;
  }
  contextWillChange() { this.session.recorder.stop(); this.video.cancel('项目、账号或权限已变化，录像已取消'); }
  observeState(resourceId: string, state: MachineryMetadata, asset?: LoadedMachineryAsset) {
    const telemetry = this.options.getTelemetry(resourceId);
    this.session.observe(resourceId, state, { asset, modelFrontAxisDeg: telemetry.modelFrontAxisDeg,
      provenance: poseProvenanceFromTelemetry(telemetry.fields) });
  }
  observeLive(states: ReadonlyMap<string, MachineryMetadata>) {
    const id = this.session.recorder.activeResource?.resourceId;
    const state = id ? states.get(id) : undefined;
    if (id && state) this.observeState(id, state);
  }
  destroy() { this.session.destroy(); this.history.destroy(); this.video.destroy(); this.root.remove(); }
}
