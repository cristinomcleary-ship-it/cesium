import { MachineryPoseRecorder, machineryPoseBeijingTime, machineryPoseProcessDescription, type MachineryPoseSnapshot, type MachineryPoseHistoryFilter } from './machineryPoseRecorder';
import './machineryPoseHistoryUi.css';

export type MachineryPoseHistoryUiOptions = {
  host: HTMLElement; recorder: MachineryPoseRecorder; getSnapshot: () => MachineryPoseSnapshot | undefined;
  canRecord?: () => boolean;
  getSelectedResourceId?: () => string;
};
/** Selected-resource controls; the recorder itself keeps its original capture target. */
export class MachineryPoseHistoryUi {
  private readonly root = document.createElement('details');
  private readonly abort = new AbortController();
  private recorder: MachineryPoseRecorder;
  private getSnapshot: () => MachineryPoseSnapshot | undefined;
  private canRecord: () => boolean;
  private readonly getSelectedResourceId?: () => string;
  private unsubscribe: () => void;
  private clearPending = false;
  private notice = '';
  constructor(options: MachineryPoseHistoryUiOptions) {
    this.recorder = options.recorder; this.getSnapshot = options.getSnapshot; this.canRecord = options.canRecord ?? (() => true);
    this.getSelectedResourceId = options.getSelectedResourceId;
    this.root.className = 'mp-pose-history'; this.root.dataset.role = 'pose-history';
    this.root.open = true;
    this.root.innerHTML = `<summary>机械姿态变化过程表 <span data-role="pose-history-badge">已停止</span></summary>
      <p class="mp-help">点击开始后，固定记录当前机械的初始姿态及后续参数变化。切换选择或关闭编辑面板不会更换记录对象；暂停、换项目或权限变化时停止。</p>
      <p class="mp-help">记录模型目标姿态；角度采用正北顺时针方位角、吊臂背离车头共线为 0°。记录时间取浏览器实际时钟，遥测采样时间逐字段保留。倾覆演示动画不作为实测姿态记录。</p>
      <p data-role="pose-history-target" class="mp-help"></p>
      <div class="mp-actions"><button type="button" data-pose-action="start" class="mp-primary">开始记录当前机械</button><button type="button" data-pose-action="stop">停止记录</button></div>
      <p data-role="pose-history-status" class="mp-status" role="status" aria-live="polite"></p>
      <p data-role="pose-history-count" class="mp-help"></p>
      <ol data-role="pose-history-recent" class="mp-pose-history-recent"></ol>
      <fieldset class="mp-pose-export"><legend>导出姿态变化过程表</legend>
        <label class="mp-label">机械范围<select data-role="pose-export-scope"><option value="current">当前机械</option><option value="all">当前项目全部已记录机械</option></select></label>
        <div class="mp-pose-range"><label class="mp-label">开始时间（北京时间）<input type="datetime-local" step="1" data-role="pose-export-from"></label><label class="mp-label">结束时间（北京时间）<input type="datetime-local" step="1" data-role="pose-export-to"></label></div>
        <p data-role="pose-export-count" class="mp-help" role="status"></p>
        <div class="mp-actions"><button type="button" data-pose-action="process-csv" class="mp-primary">导出姿态变化过程表（CSV）</button><button type="button" data-pose-action="reset-range">清除时间筛选</button></div>
        <p class="mp-help">时间留空表示全部已记录时段。按记录时间筛选，每个变化参数占一行，包含变化前后值和数据来源；CSV 可用 Excel 打开。未开始记录的时段没有历史数据，不会补造。</p>
      </fieldset>
      <div class="mp-actions"><button type="button" data-pose-action="json">导出项目原始 JSON</button><button type="button" data-pose-action="csv">导出项目原始 CSV</button><button type="button" data-pose-action="clear" class="mp-danger">清空记录</button></div>
      <div data-role="pose-history-confirm" hidden><p class="mp-help">清空将删除当前账号与项目下的姿态记录。需要保留时请先导出。</p><div class="mp-actions"><button type="button" data-pose-action="confirm-clear" class="mp-danger">确认清空</button><button type="button" data-pose-action="cancel-clear">保留记录</button></div></div>
      <p class="mp-help">JSON 保留原始数值与逐字段来源；CSV 可用 Excel 打开。记录不会写入机械业务台账，达到容量上限会停止并提示，已有记录不会被轮换删除。</p>`;
    options.host.append(this.root);
    this.root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-pose-action]');
      if (button && !button.disabled) { event.stopPropagation(); this.action(button.dataset.poseAction!); }
    }, { signal: this.abort.signal });
    this.root.addEventListener('change', event => {
      if ((event.target as HTMLElement).dataset.role?.startsWith('pose-export-')) { this.notice = ''; this.refresh(); }
    }, { signal: this.abort.signal });
    this.unsubscribe = this.recorder.onChange(() => this.refresh()); this.refresh();
  }
  private find<T extends Element>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  /** A caller must retain old recorder instances when switching scope; this UI never clears them. */
  setContext(recorder: MachineryPoseRecorder, getSnapshot = this.getSnapshot, canRecord = this.canRecord): void {
    if (recorder !== this.recorder) {
      this.unsubscribe(); this.recorder = recorder;
      this.unsubscribe = recorder.onChange(() => this.refresh()); this.clearPending = false; this.notice = '';
      this.clearRange();
    }
    this.getSnapshot = getSnapshot; this.canRecord = canRecord; this.refresh();
  }
  refresh(): void {
    const recorder = this.recorder, active = recorder.activeResource;
    let input: MachineryPoseSnapshot | undefined;
    try { input = this.getSnapshot(); } catch { /* the editor may temporarily contain incomplete parameters */ }
    this.find<HTMLElement>('[data-role="pose-history-badge"]').textContent = recorder.isRecording ? '记录中' : '已停止';
    this.find<HTMLElement>('[data-role="pose-history-target"]').textContent = active
      ? `正在记录：${active.equipmentCode ? active.equipmentCode + ' · ' : ''}${active.resourceName}${input && input.resourceId !== active.resourceId ? '；当前面板选中了另一台机械。' : ''}`
      : input ? `待记录：${input.equipmentCode ? input.equipmentCode + ' · ' : ''}${input.resourceName}` : '请先选择具有有效姿态与位置的机械。';
    this.find<HTMLElement>('[data-role="pose-history-status"]').textContent = recorder.hasStorageFailure || recorder.count >= recorder.maxEntries ? recorder.status : this.notice || recorder.status;
    this.find<HTMLElement>('[data-role="pose-history-count"]').textContent = `${recorder.count} / ${recorder.maxEntries} 条姿态记录 · 时间显示：北京时间（Asia/Shanghai） · ${recorder.isPersisted ? '已保存于当前浏览器' : '请导出以保留记录'}`;
    const list = this.find<HTMLOListElement>('[data-role="pose-history-recent"]'); list.replaceChildren();
    for (const entry of recorder.recent(4).reverse()) {
      const item = document.createElement('li'); item.textContent = machineryPoseProcessDescription(entry);
      list.append(item);
    }
    let matching = 0, filterMessage = '';
    try { matching = recorder.countMatching(this.exportFilter()); filterMessage = `可导出 ${matching} 条姿态记录（每个变化参数占一行）`; }
    catch (error) { filterMessage = error instanceof Error ? error.message : String(error); }
    this.find<HTMLElement>('[data-role="pose-export-count"]').textContent = filterMessage;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-pose-action]')) {
      const action = button.dataset.poseAction;
      button.disabled = false;
      if (action === 'start') button.disabled = recorder.isRecording || !input || !this.canRecord();
      if (action === 'stop') button.disabled = !recorder.isRecording;
      if (action === 'json' || action === 'csv') button.disabled = recorder.count === 0;
      if (action === 'process-csv') button.disabled = matching === 0;
      if (action === 'clear') button.disabled = recorder.count === 0 && !recorder.hasStorageFailure;
    }
    this.find<HTMLElement>('[data-role="pose-history-confirm"]').hidden = !this.clearPending;
  }
  private clearRange(): void {
    this.find<HTMLInputElement>('[data-role="pose-export-from"]').value = '';
    this.find<HTMLInputElement>('[data-role="pose-export-to"]').value = '';
  }
  private exportFilter(): MachineryPoseHistoryFilter {
    const selected = this.find<HTMLSelectElement>('[data-role="pose-export-scope"]').value === 'current';
    const resourceId = selected ? this.getSelectedResourceId?.() || this.getSnapshot()?.resourceId : undefined;
    if (selected && !resourceId) throw new Error('请先选择机械，或改为导出当前项目全部已记录机械');
    return { resourceId, from: machineryPoseBeijingTime(this.find<HTMLInputElement>('[data-role="pose-export-from"]').value),
      to: machineryPoseBeijingTime(this.find<HTMLInputElement>('[data-role="pose-export-to"]').value, true) };
  }
  private download(format: 'json' | 'csv' | 'process-csv'): void {
    const content = format === 'json' ? this.recorder.exportJson() : format === 'csv' ? this.recorder.exportCsv() : this.recorder.exportProcessCsv(this.exportFilter());
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${format === 'process-csv' ? '机械姿态变化过程表' : 'machinery-pose'}-${new Date().toISOString().replace(/[:.]/g, '-')}.${format === 'json' ? 'json' : 'csv'}`;
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
      else if (action === 'reset-range') this.clearRange();
      else if (action === 'json' || action === 'csv' || action === 'process-csv') this.download(action);
    } catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
    this.refresh();
  }
  destroy(): void { this.unsubscribe(); this.abort.abort(); this.root.remove(); }
}
