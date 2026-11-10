import { DEFAULT_MODEL_APPEARANCE, normalizeModelAppearance, type ModelAppearanceSettings } from "./modelAppearance";
import "./modelAppearancePanel.css";

type AppearanceTarget = { id: string; name: string; settings?: unknown };
type Options = {
  /** The host validates access, applies the override and queues the existing library update. */
  onChange: (id: string, settings: ModelAppearanceSettings) => void;
  onError?: (message: string) => void;
};

/** Independent of position editing: opening these controls never enables scene dragging. */
export class ModelAppearancePanel {
  private readonly root = document.createElement("section");
  private readonly events = new AbortController();
  private target?: AppearanceTarget;
  private settings = normalizeModelAppearance();
  private disposed = false;

  constructor(host: HTMLElement, private readonly options: Options) {
    this.root.className = "model-appearance-panel"; this.root.hidden = true;
    this.root.setAttribute("aria-label", "模型外观调整");
    this.root.innerHTML = `
      <header><div><strong>模型外观</strong><small data-appearance="name"></small></div><button type="button" data-appearance="close" aria-label="关闭模型外观">完成</button></header>
      <label><span>颜色模式</span><select data-appearance="colorMode"><option value="original">保留原材质</option><option value="tint">原材质混色</option><option value="replace">统一颜色</option></select></label>
      <div class="model-appearance-color"><label><span>模型颜色</span><input type="color" data-appearance="color" aria-label="模型颜色"></label><label><span>混色强度</span><input type="number" data-appearance="colorAmount" min="0" max="100" step="5" aria-label="混色强度百分比"></label></div>
      <label><span>不透明度（%）</span><input type="number" data-appearance="opacity" min="0" max="100" step="5"></label>
      <label><span>照明效果</span><select data-appearance="lighting"><option value="original">原始照明</option><option value="soft">柔和漫射</option><option value="bright">明亮展示</option></select></label>
      <label><span>亮度（%）</span><input type="number" data-appearance="brightness" min="25" max="250" step="5"></label>
      <p>调整作用于整个模型，自动保存。混色保留原贴图；统一颜色适合施工展示。位置与显隐由各自控件管理。</p>
      <button type="button" data-appearance="reset">恢复原材质与照明</button>
      <p class="model-appearance-error" data-appearance="error" role="status" hidden></p>`;
    host.append(this.root);
    this.root.addEventListener("change", event => this.change(event.target as HTMLInputElement | HTMLSelectElement), { signal: this.events.signal });
    this.root.addEventListener("click", event => {
      const action = (event.target as Element).closest<HTMLButtonElement>("button[data-appearance]")?.dataset.appearance;
      if (action === "close") this.close();
      if (action === "reset") this.commit({ ...DEFAULT_MODEL_APPEARANCE });
    }, { signal: this.events.signal });
    this.root.addEventListener("keydown", event => {
      if (event.key === "Escape" && !event.isComposing) { event.stopPropagation(); this.close(); }
    }, { signal: this.events.signal });
  }

  get activeId(): string | undefined { return this.target?.id; }
  open(target: AppearanceTarget): void {
    if (this.disposed) return;
    this.target = { ...target }; this.settings = normalizeModelAppearance(target.settings);
    this.find("name").textContent = target.name; this.root.hidden = false; this.error(""); this.render();
  }
  close(): void { this.target = undefined; this.root.hidden = true; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.close(); this.events.abort(); this.root.remove(); }
  private find<T extends HTMLElement = HTMLElement>(name: string): T { return this.root.querySelector<T>(`[data-appearance="${name}"]`)!; }
  private render(): void {
    for (const key of ["colorMode", "color", "lighting"] as const) this.find<HTMLInputElement>(key).value = this.settings[key];
    for (const key of ["colorAmount", "opacity", "brightness"] as const) this.find<HTMLInputElement>(key).value = String(Math.round(this.settings[key] * 100));
    this.find<HTMLInputElement>("color").disabled = this.settings.colorMode === "original";
    this.find<HTMLInputElement>("colorAmount").disabled = this.settings.colorMode !== "tint";
  }
  private change(input: HTMLInputElement | HTMLSelectElement): void {
    const key = input.dataset.appearance;
    if (!key || !["colorMode", "color", "colorAmount", "opacity", "lighting", "brightness"].includes(key)) return;
    if (input instanceof HTMLInputElement && input.type === "number" && (!input.value.trim() || !input.checkValidity())) {
      this.error("请输入控件范围内的有效数值。"); this.render(); return;
    }
    const value = ["colorAmount", "opacity", "brightness"].includes(key) ? Number(input.value) / 100 : input.value;
    this.commit(normalizeModelAppearance({ ...this.settings, [key]: value }));
  }
  private commit(settings: ModelAppearanceSettings): void {
    if (!this.target || this.disposed) return;
    try {
      this.options.onChange(this.target.id, settings);
      this.settings = settings; this.error(""); this.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(message); this.options.onError?.(message); this.render();
    }
  }
  private error(message: string): void { const target = this.find("error"); target.textContent = message; target.hidden = !message; }
}
