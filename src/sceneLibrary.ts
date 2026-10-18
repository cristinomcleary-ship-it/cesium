import type { SavedReplaySettings } from "./videoArFusion";
import type { SavedVideoOverlaySettings } from "./videoModelOverlay";
import {
  Cartesian3, Cesium3DTileset, Color, CzmlDataSource, GeoJsonDataSource, IonResource,
  KmlDataSource, Matrix4, Model, UrlTemplateImageryProvider, type Viewer,
} from "cesium";
import { readCadImport } from "./cadImport";
import { loadCadPrimitiveCollection } from "./cadPrimitiveLoader";
import { clampCadToScene, getCadBoundingSphere, loadCadImport, useSampledCadHeights } from "./dxfLoader";
import { loadLocalImagery, type LocalImageryResult } from "./localImagery";
import type { ModelEditor } from "./modelEditor";
import type { ImportRecord } from "./types";
import { libraryRequest, jsonRequest, type LibraryRecord, type LibrarySettings, type LibraryKind, type LibraryFile, type LibraryListing, type SceneView } from "./projectLibrary";

type Hooks = {
  viewer: Viewer; getImports: () => ImportRecord[];
  addImport: (name: string, kind: ImportRecord["kind"], resource: unknown, id: string, metadata?: Pick<ImportRecord, "representation" | "boundingSphere">) => string;
  removeImport: (item: ImportRecord) => void; modelEditor: ModelEditor;
  waitForModelReady: (model: Model, timeout: number) => Promise<void>;
  cacheGisBoundingSphere: (id: string, data: GeoJsonDataSource | KmlDataSource | CzmlDataSource) => Promise<void>;
  replaceImagery: (result: LocalImageryResult) => void;
  setBasemap: (kind: string) => void; getBasemap: () => string;
  notify: (message: string, error?: boolean) => void;
  restoreVideo: (files: Record<string, File>, settings: SavedReplaySettings | SavedVideoOverlaySettings, recordId?: string) => Promise<void>;
  shouldSaveView?: () => boolean;
  clearVideo: () => void;
  layersChanged: () => void;
};
type Draft = { id: string; name: string; kind: LibraryKind; settings: LibrarySettings; files: Record<string, { name: string; blob: Blob }>; copy?: { type: "tiles"; path: string } | { type: "model"; url: string } };
export class SceneLibrary {
  readonly records = new Map<string, LibraryRecord>();
  private failures = new Map<string, string>();
  private drafts = new Map<string, Draft>();
  private restoring = new Set<string>();
  private updates = new Map<string, { visible?: boolean; settings?: LibrarySettings }>();
  private updateTimer = 0;
  private flushTail: Promise<void> = Promise.resolve();
  private pending = 0;
  private starting = true;
  private error = "";
  private activeImageryId = "";
  private activeVideoId = "";
  private deleting = new Set<string>();
  private cameraTimer = 0;
  private viewReady = false;
  private lastMapView?: SceneView;
  ready: Promise<void> = Promise.resolve();
  constructor(private hooks: Hooks) {
    window.addEventListener("beforeunload", event => {
      if (this.pending || this.updates.size || this.drafts.size) { event.preventDefault(); event.returnValue = ""; }
    });
    window.addEventListener("pagehide", () => { void this.flush(true); });
    hooks.viewer.camera.moveEnd.addEventListener(() => this.saveView());
  }
  get activeVideoRecordId(): string { return this.activeVideoId; }
  get busy() { return this.starting || this.pending > 0 || this.restoring.size > 0; }
  start() {
    this.ready = this.initialize();
    return this.ready;
  }
  private async initialize() {
    this.render();
    try {
      const listing = await libraryRequest<LibraryListing>("/records");
      for (const record of listing.records) this.records.set(record.id, record);
      if (listing.problems.length) this.error = listing.problems.map(p => p.error).join("；");
      const priority = (kind: LibraryKind) => ({ "3D Tiles": 0, Model: 1, CAD: 2, GIS: 3, Imagery: 4, "Drone Video": 5 })[kind];
      const selectedImagery = listing.view?.activeImageryId || listing.records.filter(r => r.kind === "Imagery").at(-1)?.id;
      const selectedVideo = listing.view?.activeVideoId || listing.records.filter(r => r.kind === "Drone Video").at(-1)?.id;
      for (const record of [...listing.records].sort((a, b) => priority(a.kind) - priority(b.kind))) {
        if (record.kind === "Imagery" && record.id !== selectedImagery) continue;
        if (record.kind === "Drone Video" && record.id !== selectedVideo) continue;
        await this.restore(record.id);
      }
      if (listing.view) {
        const v = listing.view;
        this.hooks.viewer.camera.cancelFlight();
        this.hooks.viewer.camera.setView({ destination: Cartesian3.fromArray(v.position), orientation: { direction: Cartesian3.fromArray(v.direction), up: Cartesian3.fromArray(v.up) } });
        if (v.basemap !== "local" || this.activeImageryId) this.hooks.setBasemap(v.basemap);
        const select = document.querySelector<HTMLSelectElement>("#basemap");
        if (select) select.value = this.hooks.getBasemap();
      }
      this.lastMapView = this.captureView();
      this.viewReady = true;
    } catch (error) { this.error = this.message(error); }
    finally { this.starting = false; this.render(); }
  }
  private message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  async save(id: string, name: string, kind: LibraryKind, settings: LibrarySettings, files: Draft["files"] = {}, copy?: Draft["copy"]) {
    const retrying = this.drafts.has(id);
    const draft: Draft = { id, name, kind, settings, files, copy };
    this.drafts.set(id, draft);
    this.pending++; this.render();
    try {
      if (retrying) {
        const response = await fetch("/__library/records/" + id, { cache: "no-store" });
        if (response.ok) {
          const recovered = await response.json() as LibraryRecord;
          this.records.set(id, recovered); this.drafts.delete(id); this.failures.delete(id); this.error = "";
          return recovered;
        }
        if (response.status !== 404) throw new Error("暂时无法核实上次保存结果，请稍后重试");
      }
      const savedFiles: Record<string, LibraryFile> = {};
      for (const [slot, file] of Object.entries(files)) {
        savedFiles[slot] = await libraryRequest<LibraryFile>("/records/" + id + "/files/" + slot + "?name=" + encodeURIComponent(file.name), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file.blob });
      }
      const savedSettings = { ...settings };
      if (copy) {
        const file = await libraryRequest<LibraryFile>("/records/" + id + "/copy", jsonRequest("POST", copy));
        if (copy.type === "tiles") { savedSettings.url = file.url; savedSettings.localPath = copy.path; savedFiles.tiles = file; }
        else savedFiles.data = file;
      }
      const record = await libraryRequest<LibraryRecord>("/records/" + id, jsonRequest("PUT", {
        version: 1, id, name, kind, visible: true, createdAt: "", updatedAt: "", settings: savedSettings, files: savedFiles,
      }));
      this.records.set(id, record); this.failures.delete(id); this.drafts.delete(id); this.error = "";
      return record;
    } catch (error) {
      this.error = "尚未保存：" + name + "。请在资料库重试，保存完成前不要退出。";
      this.failures.set(id, this.message(error)); throw error;
    } finally { this.pending--; this.render(); }
  }
  queueUpdate(id: string, patch: { visible?: boolean; settings?: LibrarySettings }) {
    if (!this.records.has(id) || this.restoring.has(id) || this.deleting.has(id)) return;
    const previous = this.updates.get(id);
    this.updates.set(id, { ...previous, ...patch, settings: { ...previous?.settings, ...patch.settings } });
    if (!this.updateTimer) this.updateTimer = window.setTimeout(() => { this.updateTimer = 0; void this.flush(); }, 120);
    this.render();
  }
  private flush(keepalive = false) {
    this.flushTail = this.flushTail.catch(() => undefined).then(() => this.writeUpdates(keepalive));
    return this.flushTail;
  }
  private async writeUpdates(keepalive = false) {
    const batch = [...this.updates]; this.updates.clear();
    for (const [id, patch] of batch) {
      if (this.deleting.has(id) || !this.records.has(id)) continue;
      this.pending++; this.render();
      try {
        const record = await libraryRequest<LibraryRecord>("/records/" + id, { ...jsonRequest("PATCH", patch), keepalive });
        if (!this.deleting.has(id)) this.records.set(id, record);
        this.failures.delete(id);
      } catch (error) {
        this.failures.set(id, "更改未保存：" + this.message(error));
        if (!this.deleting.has(id)) {
          const newer = this.updates.get(id);
          this.updates.set(id, { ...patch, ...newer, settings: { ...patch.settings, ...newer?.settings } });
        }
      } finally { this.pending--; this.render(); }
    }
  }
  private captureView(): SceneView {
    const camera = this.hooks.viewer.camera;
    const v = (p: Cartesian3) => [p.x, p.y, p.z];
    return { position: v(camera.positionWC), direction: v(camera.directionWC), up: v(camera.upWC), basemap: this.hooks.getBasemap(), activeImageryId: this.activeImageryId, activeVideoId: this.activeVideoId };
  }
  saveView() {
    if (!this.viewReady || this.starting || this.restoring.size) return;
    window.clearTimeout(this.cameraTimer);
    // Capture before the delayed write. A CC video camera must never replace the
    // user's map view, while selecting/saving a video still persists its record ID.
    if (this.hooks.shouldSaveView?.() !== false) this.lastMapView = this.captureView();
    if (!this.lastMapView) return;
    const view: SceneView = { ...this.lastMapView, activeImageryId: this.activeImageryId, activeVideoId: this.activeVideoId };
    this.cameraTimer = window.setTimeout(() => {
      void libraryRequest("/view", { ...jsonRequest("PUT", view), keepalive: true }).catch(error => {
        this.error = "视角未保存：" + this.message(error); this.render();
      });
    }, 150);
  }
  private async file(record: LibraryRecord, slot: string) {
    const file = record.files[slot]; if (!file) throw new Error("缺少已保存的 " + slot + " 文件");
    const response = await fetch(file.url);
    if (!response.ok) throw new Error("保存文件无法读取（HTTP " + response.status + "）");
    return new File([await response.blob()], file.name);
  }
  async restore(id: string) {
    const record = this.records.get(id);
    if (!record || this.restoring.has(id) || this.deleting.has(id)) return;
    const existing = this.hooks.getImports().find(i => i.id === id);
    if (existing) {
      if (existing.boundingSphere) this.hooks.viewer.camera.flyToBoundingSphere(existing.boundingSphere);
      else if (existing.kind === "Model") this.hooks.viewer.camera.flyToBoundingSphere((existing.resource as Model).boundingSphere);
      else void this.hooks.viewer.flyTo(existing.resource as never);
      return;
    }
    this.restoring.add(id); this.render();
    const h = this.hooks; const s = record.settings;
    let cleanup: (() => void) | undefined;
    try {
      if (record.kind === "3D Tiles") {
        const url = s.assetId ? await IonResource.fromAssetId(s.assetId) : s.url;
        if (!url) throw new Error("缺少倾斜摄影入口");
        const tiles = await Cesium3DTileset.fromUrl(url, {
          maximumScreenSpaceError: s.tiles?.maximumScreenSpaceError ?? 4,
          cacheBytes: 384 * 1024 * 1024, maximumCacheOverflowBytes: 192 * 1024 * 1024,
          dynamicScreenSpaceError: s.quality === "balanced", enableCollision: true,
        });
        if (s.matrix) tiles.modelMatrix = Matrix4.fromArray(s.matrix);
        h.viewer.scene.primitives.add(tiles); cleanup = () => { h.viewer.scene.primitives.remove(tiles); };
        tiles.show = record.visible;
        h.addImport(record.name, "3D Tiles", tiles, id);
      } else if (record.kind === "Model") {
        const url = record.files.data?.url ?? record.files.source?.url;
        if (!url) throw new Error("缺少保存的 GLB");
        const model = await Model.fromGltfAsync({ url, modelMatrix: s.matrix ? Matrix4.fromArray(s.matrix) : Matrix4.clone(Matrix4.IDENTITY), scale: s.scale ?? 1, minimumPixelSize: 0, id: { engineeringModelId: id } });
        h.viewer.scene.primitives.add(model); cleanup = () => { h.viewer.scene.primitives.remove(model); };
        await h.waitForModelReady(model, 30_000);
        h.addImport(record.name, "Model", model, id); h.modelEditor.add(id, record.name, model, s.editor);
        model.show = record.visible;
      } else if (record.kind === "CAD") {
        if (!s.coordinates) throw new Error("CAD 坐标参数缺失");
        const imported = await readCadImport(await this.file(record, "data"));
        const displayMode = s.displayMode ?? "absolute";
        const loaded = h.getImports();
        if (displayMode === "model" && !loaded.some(i => i.kind === "3D Tiles" || i.kind === "Model")) throw new Error("依附的模型尚未恢复；加载模型后可重试此图纸");
        if (displayMode === "model" && !loaded.some(i => i.kind === "3D Tiles")) {
          const data = await loadCadImport(imported, s.coordinates, displayMode);
          await h.viewer.dataSources.add(data); cleanup = () => { h.viewer.dataSources.remove(data, true); };
          await clampCadToScene(data, h.viewer.scene, 2000); useSampledCadHeights(data);
          h.addImport(record.name, "CAD", data, id, { representation: "dataSource", boundingSphere: getCadBoundingSphere(data) });
          data.show = record.visible;
        } else {
          const result = await loadCadPrimitiveCollection(imported, s.coordinates, { displayMode, scene: h.viewer.scene, beforePopulate: collection => {
            h.viewer.scene.primitives.add(collection); cleanup = () => { h.viewer.scene.primitives.remove(collection); };
          } });
          result.collection.show = record.visible;
          h.addImport(record.name, "CAD", result.collection, id, { representation: "primitive", boundingSphere: result.boundingSphere });
        }
      } else if (record.kind === "GIS") {
        const file = await this.file(record, "source");
        const extension = file.name.split(".").pop()?.toLowerCase();
        let data;
        if (extension === "kml" || extension === "kmz") data = await KmlDataSource.load(file, { camera: h.viewer.scene.camera, canvas: h.viewer.scene.canvas, clampToGround: true });
        else if (extension === "czml") data = await CzmlDataSource.load(JSON.parse(await file.text()));
        else data = await GeoJsonDataSource.load(JSON.parse(await file.text()), { clampToGround: true, stroke: Color.fromCssColorString("#f9d65c"), fill: Color.fromCssColorString("#f9d65c").withAlpha(0.25), strokeWidth: 3 });
        await h.viewer.dataSources.add(data); cleanup = () => { h.viewer.dataSources.remove(data, true); };
        data.show = record.visible;
        h.addImport(record.name, "GIS", data, id); void h.cacheGisBoundingSphere(id, data);
      } else if (record.kind === "Imagery") {
        let result: LocalImageryResult;
        if (s.imageryUrl) {
          const provider = new UrlTemplateImageryProvider({ url: s.imageryUrl, maximumLevel: 23, credit: record.name });
          result = { provider, name: record.name, rectangle: provider.rectangle, details: "已保存的影像服务", dispose: () => undefined };
        } else {
          if (!s.bounds) throw new Error("本地影像范围缺失");
          result = await loadLocalImagery(await this.file(record, "source"), s.bounds);
        }
        h.replaceImagery(result); this.activeImageryId = id;
        const select = document.querySelector<HTMLSelectElement>("#basemap"); if (select) select.value = "local";
      } else if (record.kind === "Drone Video") {
        const files: Record<string, File> = {};
        for (const slot of Object.keys(record.files)) files[slot] = await this.file(record, slot);
        await h.restoreVideo(files, s.video as unknown as SavedReplaySettings | SavedVideoOverlaySettings, record.id);
        this.activeVideoId = id;
      }
      const item = h.getImports().find(i => i.id === id); if (item) item.visible = record.visible;
      this.failures.delete(id); h.viewer.scene.requestRender();
    } catch (error) {
      const partial = h.getImports().find(i => i.id === id);
      if (partial) h.removeImport(partial); else cleanup?.();
      this.failures.set(id, this.message(error));
    } finally { this.restoring.delete(id); this.render(); this.hooks.layersChanged(); if (!this.starting) this.saveView(); }
  }
  projectionModelRecord(id: string) {
    const record = this.records.get(id);
    return record ? { id: record.id, updatedAt: record.updatedAt, files: structuredClone(record.files), savedSettings: structuredClone(record.settings) } : null;
  }

  async updateVideoControls(controls: Record<string, string | boolean>, calibrationSessions?: SavedReplaySettings["calibrationSessions"], requireSaved = false) {
    const record = this.records.get(this.activeVideoId);
    if (!record || record.kind !== "Drone Video" || record.settings.video?.mode === "cc-overlay") {
      if (requireSaved) throw new Error("视频尚未保存到资料库，请先完成加载保存再记录校准");
      return;
    }
    // Carry controls and complete history in the same update: rapid edits cannot drop a newly recorded session.
    this.queueUpdate(record.id, { settings: { video: { ...record.settings.video, controls,
      ...(calibrationSessions === undefined ? {} : { calibrationSessions }) } } });
    if (requireSaved) {
      await this.flush();
      if (this.failures.has(record.id)) throw new Error(this.failures.get(record.id));
    }
  }

  async updateVideoOverlaySettings(id: string, settings: SavedVideoOverlaySettings): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.kind !== "Drone Video" || record.settings.video?.mode !== "cc-overlay") throw new Error("找不到对应的 CC 融合录像，请重新保存录像");
    if (this.restoring.has(id) || this.deleting.has(id)) throw new Error("录像正在恢复或删除，请稍后保存");
    this.queueUpdate(id, { settings: { video: structuredClone(settings) as unknown as Record<string, unknown> } });
    await this.flush();
    if (this.failures.has(id)) throw new Error(this.failures.get(id));
    if (!this.records.has(id)) throw new Error("录像已被删除，融合参数未能保存");
  }

  markVideo(id: string) { this.activeVideoId = id; this.render(); this.saveView(); }
  markImagery(id: string) { this.activeImageryId = id; this.render(); this.saveView(); }
  async delete(id: string, confirm = true): Promise<boolean> {
    if (this.restoring.has(id) || this.pending) { this.hooks.notify("请等待当前资料保存或恢复完成后再删除",true); return false; }
    const name = this.records.get(id)?.name ?? this.drafts.get(id)?.name ?? id;
    if (confirm && !window.confirm("删除“" + name + "”及其本机保存副本？原始导入文件不会被删除。")) return false;
    const unsaved = this.updates.get(id);
    this.deleting.add(id); this.updates.delete(id); this.pending++; this.render();
    try {
      await libraryRequest("/records/" + id, { method: "DELETE" });
      this.records.delete(id); this.failures.delete(id); this.drafts.delete(id);
      const item = this.hooks.getImports().find(i => i.id === id); if (item) this.hooks.removeImport(item);
      if (this.activeVideoId === id) { this.hooks.clearVideo(); this.activeVideoId = ""; }
      if (this.activeImageryId === id) {
        this.hooks.setBasemap("street"); this.activeImageryId = "";
        const select = document.querySelector<HTMLSelectElement>("#basemap"); if (select) select.value = "street";
      }
      this.error = ""; this.saveView();return true;
    } catch (error) {
      if (unsaved) this.updates.set(id, unsaved);
      this.error = "删除未完成，资料保留：" + this.message(error); this.hooks.notify(this.error, true);return false;
    }
    finally {
      this.deleting.delete(id); this.pending--;
      if (this.updates.has(id) && !this.updateTimer) this.updateTimer = window.setTimeout(() => { this.updateTimer = 0; void this.flush(); }, 120);
      this.render();
    }
  }
  async clear() {
    if (this.busy) return this.hooks.notify("请等待资料保存或恢复完成", true);
    if (!window.confirm("删除全部已保存的工程资料？关闭软件不需要执行此操作。")) return;
    for (const id of new Set([...this.records.keys(), ...this.drafts.keys()])) await this.delete(id, false);
    this.render();
  }
  render() {
    const status = document.querySelector<HTMLElement>("#libraryStatus");
    const list = document.querySelector<HTMLElement>("#savedLibrary");
    if (!status || !list) return;
    status.textContent = this.error || (this.starting ? "正在恢复上次资料…" : this.pending ? "正在保存，请稍候…" : this.failures.size ? "已保存到本机 · " + this.failures.size + " 项需展开重试" : this.updates.size ? "正在保存，请稍候…" : "已保存到本机 · 关闭后自动恢复");
    status.classList.toggle("error-text", Boolean(this.error || this.failures.size));
    list.replaceChildren();
    for (const id of new Set([...this.records.keys(), ...this.drafts.keys()])) {
      const record = this.records.get(id); const draft = this.drafts.get(id);
      const row = document.createElement("div"); row.className = "saved-record"; row.dataset.savedId = id;
      const title = document.createElement("span"); title.textContent = record?.name ?? draft!.name; title.title = title.textContent;
      const detail = document.createElement("small");
      detail.textContent = this.restoring.has(id) ? "恢复中…" : this.failures.get(id) ?? (record ? record.kind + " · 已保存" : "等待保存");
      const retry = document.createElement("button"); retry.textContent = draft ? "重试保存" : this.failures.has(id) ? "重试" : record?.kind === "Imagery" || record?.kind === "Drone Video" ? "使用" : this.hooks.getImports().some(item => item.id === id) ? "定位" : "恢复";
      retry.disabled = this.busy;
      retry.addEventListener("click", () => {
        if (draft) void this.save(draft.id, draft.name, draft.kind, draft.settings, draft.files, draft.copy).then(() => this.restore(id)).catch(e => this.hooks.notify(this.message(e), true));
        else if (this.updates.has(id)) void this.flush();
        else void this.restore(id);
      });
      const remove = document.createElement("button"); remove.textContent = "删除"; remove.disabled = this.busy;
      remove.addEventListener("click", () => void this.delete(id));
      row.append(title, detail, retry, remove);
      const source = record?.files.source;
      if (source) { const link = document.createElement("a"); link.href = source.url; link.download = source.name; link.textContent = "下载原文件"; row.append(link); }
      list.append(row);
    }
    if (!list.childElementCount) { const empty = document.createElement("p"); empty.textContent = "导入的资料会自动保存在这里"; list.append(empty); }
    const clear = document.querySelector<HTMLButtonElement>("#clearAll"); if (clear) clear.disabled = this.busy;
  }
}

