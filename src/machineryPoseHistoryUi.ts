import { MachineryPoseRecorder, type MachineryPoseSnapshot } from './machineryPoseRecorder';
import './machineryPoseHistoryUi.css';

export type MachineryPoseHistoryUiOptions = {
  host: HTMLElement; recorder: MachineryPoseRecorder; getSnapshot: () => MachineryPoseSnapshot | undefined;
  canRecord?: () => boolean;
};
/** Selected-resource controls; the recorder itself keeps its original capture target. */
export class MachineryPoseHistoryUi {
  private readonly root = document.createElement('details');
  private readonly abort = new AbortController();
  private recorder: MachineryPoseRecorder;
  private getSnapshot: () => MachineryPoseSnapshot | undefined;
  private canRecord: () => boolean;
  private unsubscribe: () => void;
  private clearPending = false;
  private notice = '';
  constructor(options: MachineryPoseHistoryUiOptions) {
    this.recorder = options.recorder; this.getSnapshot = options.getSnapshot; this.canRecord = options.canRecord ?? (() => true);
    this.root.className = 'mp-pose-history'; this.root.dataset.role = 'pose-history';
    this.root.innerHTML = `<summary>机械姿态记录 <span data-role="pose-history-badge">已停止</span></summary>
      <p class="mp-help">点击开始后，固定记录当前机械的初始姿态及后续参数变化。切换选择或关闭编辑面板不会更换记录对象；暂停、换项目或权限变化时停止。</p>
      <p class="mp-help">记录模型目标姿态；角度采用正北顺时针方位角、吊臂背离车头共线为 0°。记录时间取浏览器实际时钟，遥测采样时间逐字段保留。倾覆演示动画不作为实测姿态记录。</p>
      <p data-role="pose-history-target" class="mp-help"></p>
      <div class="mp-actions"><button type="button" data-pose-action="start" class="mp-primary">开始记录当前机械</button><button type="button" data-pose-action="stop">停止记录</button></div>
      <p data-role="pose-history-status" class="mp-status" role="status" aria-live="polite"></p>
      <p data-role="pose-history-count" class="mp-help"></p>
      <ol data-role="pose-history-recent" class="mp-pose-history-recent"></ol>
      <div class="mp-actions"><button type="button" data-pose-action="json">导出 JSON</button><button type="button" data-pose-action="csv">导出 CSV</button><button type="button" data-pose-action="clear" class="mp-danger">清空记录</button></div>
      <div data-role="pose-history-confirm" hidden><p class="mp-help">清空将删除当前账号与项目下的姿态记录。需要保留时请先导出。</p><div class="mp-actions"><button type="button" data-pose-action="confirm-clear" class="mp-danger">确认清空</button><button type="button" data-pose-action="cancel-clear">保留记录</button></div></div>
      <p class="mp-help">JSON 保留原始数值与逐字段来源；CSV 可用 Excel 打开。记录不会写入机械业务台账，达到容量上限会停止并提示，已有记录不会被轮换删除。</p>`;
    options.host.append(this.root);
    this.root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-pose-action]');
      if (button && !button.disabled) { event.stopPropagation(); this.action(button.dataset.poseAction!); }
    }, { signal: this.abort.signal });
    this.unsubscribe = this.recorder.onChange(() => this.refresh()); this.refresh();
  }
  private find<T extends Element>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  /** A caller must retain old recorder instances when switching scope; this UI never clears them. */
  setContext(recorder: MachineryPoseRecorder, getSnapshot = this.getSnapshot, canRecord = this.canRecord): void {
    if (recorder !== this.recorder) {
      this.unsubscribe(); this.recorder = recorder;
      this.unsubscribe = recorder.onChange(() => this.refresh()); this.clearPending = false; this.notice = '';
    }
    this.getSnapshot = getSnapshot; this.canRecord = canRecord; this.refresh();
  }
  refresh(): void {
    const recorder = this.recorder, active = recorder.activeResource;
    let input: MachineryPoseSnapshot | undefined;
    try { input = this.getSnapshot(); } catch { /* the editor may temporarily contain incomplete parameters */ }
    this.find<HTMLElement>('[data-role="pose-history-badge"]').textContent = recorder.isRecording ? '记录中' : '已停止';
    this.find<HTMLElement>('[data-role="pose-history-target"]').textContent = active
      ? `正在记录：${active.resourceName}（${active.resourceId}）${input && input.resourceId !== active.resourceId ? '；当前面板选中了另一台机械。' : ''}`
      : input ? `待记录：${input.resourceName}（${input.resourceId}）` : '请先选择具有有效姿态与位置的机械。';
    this.find<HTMLElement>('[data-role="pose-history-status"]').textContent = recorder.hasStorageFailure || recorder.count >= recorder.maxEntries ? recorder.status : this.notice || recorder.status;
    this.find<HTMLElement>('[data-role="pose-history-count"]').textContent = `${recorder.count} / ${recorder.maxEntries} 条姿态记录 · 时间显示：${recorder.timeZone} · ${recorder.isPersisted ? '已保存于当前浏览器' : '请导出以保留记录'}`;
    const list = this.find<HTMLOListElement>('[data-role="pose-history-recent"]'); list.replaceChildren();
    for (const entry of recorder.recent(4).reverse()) {
      const item = document.createElement('li'); item.textContent = entry.description;
      list.append(item);
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-pose-action]')) {
      const action = button.dataset.poseAction;
      button.disabled = false;
      if (action === 'start') button.disabled = recorder.isRecording || !input || !this.canRecord();
      if (action === 'stop') button.disabled = !recorder.isRecording;
      if (action === 'json' || action === 'csv') button.disabled = recorder.count === 0;
      if (action === 'clear') button.disabled = recorder.count === 0 && !recorder.hasStorageFailure;
    }
    this.find<HTMLElement>('[data-role="pose-history-confirm"]').hidden = !this.clearPending;
  }
  private download(format: 'json' | 'csv'): void {
    const content = format === 'json' ? this.recorder.exportJson() : this.recorder.exportCsv();
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `machinery-pose-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private action(action: string): void {
    this.notice = '';
    try {
      if (action === 'start') {
        if (!this.canRecord()) throw new Error('当前状态不可开始记录');
        const input = this.getSnapshot(); if (!input) throw new Error('请先设置有效机械姿态和位置');
        this.recorder.start(input);
      } else if (action === 'stop') this.recorder.stop();
      else if (action === 'clear') this.clearPending = true;
      else if (action === 'cancel-clear') this.clearPending = false;
      else if (action === 'confirm-clear') { this.recorder.clear(); this.clearPending = false; }
      else if (action === 'json' || action === 'csv') this.download(action);
    } catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
    this.refresh();
  }
  destroy(): void { this.unsubscribe(); this.abort.abort(); this.root.remove(); }
}
