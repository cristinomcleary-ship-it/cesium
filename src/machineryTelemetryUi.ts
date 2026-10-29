import type { LoadedMachineryAsset } from './machinery/index';
import { machineryTelemetryFields } from './machineryTelemetry';
import { MachineryTelemetryController, type TelemetryConfig } from './machineryTelemetryController';
import type { MachineryMetadata } from './machineryTypes';

type UiOptions = {
  host: HTMLElement; controller: MachineryTelemetryController;
  onBeforeEnable: () => boolean;
  onDisabled: (state?: MachineryMetadata) => void;
  onConfigured: () => void;
  onApplyInitialAngles: (heading: number, boom?: number) => void;
};
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Rebuild only on resource/asset selection; incoming data updates status text in place. */
export class MachineryTelemetryUi {
  private readonly root = document.createElement('details');
  private readonly events = new AbortController();
  private id = '';
  private projectId = '';
  private actorId = '';
  private asset?: LoadedMachineryAsset;
  private writable = false;
  private saved = false;
  private busy = false;
  private generation = 0;
  constructor(private readonly options: UiOptions) {
    this.root.className = 'mp-telemetry'; this.root.dataset.role = 'telemetry';
    this.root.innerHTML = `<summary>传感器参数关联 <span data-role="telemetry-badge">未启用</span></summary>
      <p class="mp-help">默认关闭。先保存初始模型，再勾选需要关联的参数。未关联参数继续手动编辑；关联配置仅保存在当前浏览器，按账号、项目和机械隔离。</p>
      <p class="mp-help">吊臂回传角：背离车头并共线为 0°，俯视顺时针为正。整机方位角：正北 0°、顺时针为正。吊臂回转的手工输入、实时值和传感器回传使用同一角度定义。</p>
      <details class="mp-telemetry-initial"><summary>按接口角度设置初始姿态</summary>
        <p class="mp-help">吊臂 0°：背离车头并与车身共线。应用后更新上方初始角度，保存到资源再启用关联。</p>
        <label class="mp-label">初始整机方位角（°）<input type="number" step="any" value="0" data-role="telemetry-initial-heading"></label>
        <label class="mp-label" data-role="telemetry-initial-boom-row">初始吊臂相对回转角（°）<input type="number" step="any" value="0" data-role="telemetry-initial-boom"></label>
        <button type="button" data-action="telemetry-initial">应用初始角到草稿</button>
      </details>
      <p class="mp-telemetry-identity" data-role="telemetry-identity"></p>
      <button type="button" data-action="telemetry-copy">复制项目与机械 ID</button>
      <div data-role="telemetry-fields" class="mp-telemetry-fields"></div>
      <p class="mp-help">换算后数值 = 原始数据 × 倍率 + 偏移；长度 m、角度 °。位置须为 WGS84 经纬度和椭球高。相同来源的多个参数可分别关联不同字段。</p>
      <label class="mp-label">数据过期阈值（秒）<input data-role="telemetry-stale" type="number" min="1" max="60" step="1" value="5"></label>
      <div class="mp-actions"><button type="button" data-action="telemetry-enable" class="mp-primary">启用所选关联</button><button type="button" data-action="telemetry-disable">停用并转为手工草稿</button></div>
      <p class="mp-status" data-role="telemetry-status" role="status">未启用</p>
      <details class="mp-telemetry-test"><summary>无现场数据：模拟测试</summary>
        <p class="mp-help">模拟器经真实 HTTP 接口发送与接收，每秒一帧；测试参数来源请设为 browser-sim。模拟数据仅用于演示，不能作为现场监测数据。</p>
        <div class="mp-actions"><button type="button" data-action="telemetry-sim-start">开始模拟</button><button type="button" data-action="telemetry-sim-stop">停止模拟</button><button type="button" data-action="telemetry-sample">生成单帧 JSON</button></div>
        <label class="mp-label">测试报文<textarea data-role="telemetry-json" rows="10" spellcheck="false" aria-label="传感器测试 JSON"></textarea></label>
        <div class="mp-actions"><button type="button" data-action="telemetry-send">发送单帧 JSON</button><button type="button" data-action="telemetry-time">更新时间戳</button></div>
        <p class="mp-help">停止模拟后保持最后姿态，超过阈值显示“过期”。关闭编辑面板后，已启用的机械继续接收数据。停用所有机械后停止轮询。</p>
      </details>`;
    options.host.append(this.root);
    this.root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action^="telemetry-"]');
      if (button && !button.disabled) { event.stopPropagation(); void this.action(button.dataset.action!); }
    }, { signal: this.events.signal });
  }
  private find<T extends Element>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  setContext(id: string, projectId: string, actorId: string, asset: LoadedMachineryAsset | undefined, saved: boolean, writable: boolean) {
    const changed = id !== this.id || projectId !== this.projectId || actorId !== this.actorId || asset !== this.asset;
    this.id = id; this.projectId = projectId; this.actorId = actorId; this.asset = asset; this.saved = saved; this.writable = writable;
    if (changed) { ++this.generation; this.busy = false; this.renderFields(); }
    this.refresh();
  }
  private renderFields() {
    const container = this.find<HTMLElement>('[data-role="telemetry-fields"]'); container.replaceChildren();
    this.find<HTMLElement>('[data-role="telemetry-identity"]').textContent = this.id ? `项目：${this.projectId}\n机械：${this.id}` : '请选择机械资源';
    this.find<HTMLTextAreaElement>('[data-role="telemetry-json"]').value = '';
    this.find<HTMLElement>('[data-role="telemetry-initial-boom-row"]').hidden = this.asset?.id !== 'crane';
    if (!this.id || !this.asset) return;
    const config = this.options.controller.getConfig(this.id);
    this.find<HTMLInputElement>('[data-role="telemetry-stale"]').value = String(config.staleAfterMs / 1000);
    for (const field of machineryTelemetryFields(this.asset)) {
      const binding = config.bindings.find(value => value.target === field.key);
      const row = document.createElement('div'); row.className = 'mp-telemetry-field'; row.dataset.telemetryTarget = field.key;
      const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.telemetryInput = 'enabled'; checkbox.checked = binding?.enabled ?? false;
      label.append(checkbox, document.createTextNode(`${field.label}（${field.unit}）`)); row.append(label);
      const grid = document.createElement('div'); grid.className = 'mp-telemetry-mapping';
      for (const [key, caption, value, type] of [
        ['sourceId', '来源 ID', binding?.sourceId ?? 'browser-sim', 'text'],
        ['sourceField', '回传字段', binding?.sourceField ?? field.key, 'text'],
        ['scale', '倍率', binding?.scale ?? 1, 'number'],
        ['offset', '偏移', binding?.offset ?? 0, 'number'],
      ]) {
        const item = document.createElement('label'); item.className = 'mp-label'; item.textContent = String(caption);
        const input = document.createElement('input'); input.dataset.telemetryInput = String(key); input.type = String(type); input.value = String(value); input.step = 'any';
        input.setAttribute('aria-label', `${field.label} ${caption}`); item.append(input); grid.append(item);
      }
      const status = document.createElement('p'); status.className = 'mp-telemetry-value'; status.dataset.telemetryValue = field.key; status.textContent = '未关联 · 使用人工值';
      row.append(grid, status); container.append(row);
    }
  }
  private readConfig(): TelemetryConfig {
    const config = this.options.controller.getConfig(this.id);
    config.staleAfterMs = Number(this.find<HTMLInputElement>('[data-role="telemetry-stale"]').value) * 1000;
    config.bindings = [...this.root.querySelectorAll<HTMLElement>('[data-telemetry-target]')].map(row => {
      const input = (key: string) => row.querySelector<HTMLInputElement>(`[data-telemetry-input="${key}"]`)!;
      return { target: row.dataset.telemetryTarget!, enabled: input('enabled').checked,
        sourceId: input('sourceId').value.trim(), sourceField: input('sourceField').value.trim(),
        scale: input('scale').value.trim() ? Number(input('scale').value) : NaN,
        offset: input('offset').value.trim() ? Number(input('offset').value) : NaN };
    });
    return config;
  }
  refresh() {
    const controller = this.options.controller, enabled = controller.isEnabled(this.id), simulation = controller.isSimulating(this.id);
    this.find<HTMLElement>('[data-role="telemetry-badge"]').textContent = simulation ? '模拟中' : enabled ? '已启用' : '未启用';
    this.root.dataset.enabled = String(enabled);
    this.find<HTMLElement>('[data-role="telemetry-status"]').textContent = !this.saved ? '请先保存初始模型与位置，再配置关联。' : controller.status;
    const statuses = new Map(controller.getFieldStatus(this.id).map(item => [item.target, item]));
    for (const output of this.root.querySelectorAll<HTMLElement>('[data-telemetry-value]')) {
      const status = statuses.get(output.dataset.telemetryValue!);
      output.dataset.freshness = status?.status ?? 'manual';
      output.textContent = status ? `${Number(status.value.toFixed(6))} · ${status.status === 'fresh' ? '新鲜' : status.status === 'stale' ? '过期，保持最后值' : '等待数据'}${status.ageMs === null ? '' : ` · ${(status.ageMs / 1000).toFixed(1)} 秒前`} · ${status.mode === 'simulated' ? '模拟' : status.mode === 'measured' ? '实测' : '尚无采样'}\n${status.sourceId} / ${status.sourceField}${status.lastError ? '\n拒绝：' + status.lastError : ''}` : '未关联 · 使用人工值';
    }
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-telemetry-input], [data-role="telemetry-stale"]')) input.disabled = !this.writable || !this.saved || this.busy;
    for (const input of this.root.querySelectorAll<HTMLInputElement>('.mp-telemetry-initial input')) input.disabled = !this.writable || enabled || this.busy;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      const action = button.dataset.action;
      button.disabled = !this.writable || !this.saved || this.busy;
      if (action === 'telemetry-copy') button.disabled = !this.id;
      if (action === 'telemetry-initial') button.disabled = !this.writable || !this.asset || enabled || this.busy;
      if (action === 'telemetry-sample') button.disabled ||= !enabled;
      if (action === 'telemetry-disable') button.disabled ||= !enabled;
      if (action === 'telemetry-sim-start') button.disabled ||= !enabled || simulation;
      if (action === 'telemetry-sim-stop') button.disabled ||= !simulation;
    }
    this.find<HTMLButtonElement>('[data-action="telemetry-enable"]').textContent = enabled ? '应用关联设置' : '启用所选关联';
  }
  private notice(value: string, error = false) {
    const output = this.find<HTMLElement>('[data-role="telemetry-status"]'); output.textContent = value; output.classList.toggle('is-error', error);
  }
  private async action(action: string) {
    const controller = this.options.controller, generation = this.generation;
    try {
      if (action === 'telemetry-initial') {
        const headingInput = this.find<HTMLInputElement>('[data-role="telemetry-initial-heading"]');
        const boomInput = this.find<HTMLInputElement>('[data-role="telemetry-initial-boom"]');
        const heading = headingInput.value.trim() ? Number(headingInput.value) : NaN;
        const boom = this.asset?.id === 'crane' ? (boomInput.value.trim() ? Number(boomInput.value) : NaN) : undefined;
        if (!Number.isFinite(heading) || (boom !== undefined && !Number.isFinite(boom))) throw new Error('请输入有效初始角度');
        this.options.onApplyInitialAngles(heading, boom); this.notice('初始角已应用到草稿。请设置位置并保存到资源，再启用关联。');
      } else if (action === 'telemetry-enable') {
        if (!this.options.onBeforeEnable()) return;
        this.busy = true; this.refresh(); await controller.configure(this.id, this.readConfig());
        if (generation !== this.generation) return;
        this.options.onConfigured(); this.notice('关联已启用。未勾选参数继续使用人工值；配置保存在当前浏览器。');
      } else if (action === 'telemetry-disable') {
        const state = controller.disable(this.id); this.options.onDisabled(state); this.refresh(); this.notice('已停用。最后姿态已转为手工草稿，点击“保存到资源”保留。');
      } else if (action === 'telemetry-sim-start') { controller.startSimulation(this.id); this.refresh(); }
      else if (action === 'telemetry-sim-stop') { controller.stopSimulation(this.id); this.refresh(); this.notice('模拟已停止；保持最后姿态，超过阈值后显示过期。'); }
      else if (action === 'telemetry-sample') {
        this.find<HTMLTextAreaElement>('[data-role="telemetry-json"]').value = JSON.stringify(controller.sampleFrame(this.id), null, 2);
      } else if (action === 'telemetry-time') {
        const input = this.find<HTMLTextAreaElement>('[data-role="telemetry-json"]'), frame = JSON.parse(input.value); frame.timestamp = new Date().toISOString(); input.value = JSON.stringify(frame, null, 2);
      } else if (action === 'telemetry-send') {
        const frame = JSON.parse(this.find<HTMLTextAreaElement>('[data-role="telemetry-json"]').value);
        if (frame.resourceId !== this.id) throw new Error('测试报文机械 ID 必须与当前选中机械一致');
        this.busy = true; this.refresh(); await controller.sendFrame(frame);
        if (generation === this.generation) this.notice('模拟帧已发送；姿态将在下一次接口轮询时更新。');
      } else if (action === 'telemetry-copy') { await navigator.clipboard.writeText(JSON.stringify({ projectId: this.projectId, resourceId: this.id }, null, 2)); this.notice('项目与机械 ID 已复制。'); }
    } catch (error) { if (generation === this.generation) this.notice(text(error), true); }
    finally { if (generation === this.generation) { this.busy = false; this.refreshButtons(); } }
  }
  private refreshButtons() {
    // Preserve the operation message while restoring controls.
    const output = this.find<HTMLElement>('[data-role="telemetry-status"]'), message = output.textContent;
    this.refresh(); output.textContent = message;
  }
  destroy() { this.events.abort(); this.root.remove(); }
}
