import { SPATIAL_API_PATH, type SpatialMutation, type SpatialObject, type SpatialSnapshot } from "./safetySpatialTypes.ts";
import { validateSpatialMutation, validateSpatialSnapshot } from "./safetySpatialValidation.ts";

export class SafetySpatialError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly snapshot?: SpatialSnapshot;
  readonly mutationId?: string;
  constructor(message: string, options: { code: string; status?: number; snapshot?: SpatialSnapshot; mutationId?: string }) {
    super(message); this.name = "SafetySpatialError"; this.code = options.code; this.status = options.status;
    this.snapshot = options.snapshot; this.mutationId = options.mutationId;
  }
}

export class SafetySpatialRepository {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; }

  async load(): Promise<SpatialSnapshot> { return this.request(); }
  async upsert(object: SpatialObject, expectedRevision: number): Promise<SpatialSnapshot> {
    return this.mutate({ operation: "upsert", object, expectedRevision, mutationId: crypto.randomUUID() });
  }
  async delete(id: string, expectedRevision: number): Promise<SpatialSnapshot> {
    return this.mutate({ operation: "delete", id, expectedRevision, mutationId: crypto.randomUUID() });
  }
  private async mutate(input: SpatialMutation): Promise<SpatialSnapshot> {
    let mutation: SpatialMutation;
    try { mutation = validateSpatialMutation(input); }
    catch (error) { throw new SafetySpatialError(error instanceof Error ? error.message : "空间对象无效", { code: "VALIDATION", mutationId: input.mutationId }); }
    // A lost acknowledgement retries the identical mutation ID. The server deduplicates it before revision checks.
    try { return await this.request(mutation); }
    catch (error) { if (!(error instanceof SafetySpatialError) || error.code !== "NETWORK") throw error; return this.request(mutation); }
  }
  private async request(mutation?: SpatialMutation): Promise<SpatialSnapshot> {
    let response: Response;
    try {
      response = await this.fetcher(SPATIAL_API_PATH, { method: mutation ? "POST" : "GET", cache: "no-store",
        headers: { "X-Cesium-Library": "1", ...(mutation ? { "Content-Type": "application/json" } : {}) },
        ...(mutation ? { body: JSON.stringify(mutation) } : {}) });
    } catch { throw new SafetySpatialError("空间对象服务连接失败；当前草稿仍保留，尚未确认保存结果", { code: "NETWORK", mutationId: mutation?.mutationId }); }
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new SafetySpatialError("空间对象服务响应无法确认，请重新读取已保存对象", { code: "INVALID_RESPONSE", status: response.status, mutationId: mutation?.mutationId }); }
    if (!response.ok) {
      const error = (body && typeof body === "object" ? body : {}) as { error?: string; code?: string; snapshot?: unknown };
      let snapshot: SpatialSnapshot | undefined;
      if (error.snapshot) { try { snapshot = validateSpatialSnapshot(error.snapshot); } catch { /* Keep the original server error. */ } }
      throw new SafetySpatialError(error.error || "空间对象未能保存", { code: error.code || "SERVER_ERROR", status: response.status, snapshot, mutationId: mutation?.mutationId });
    }
    try { return validateSpatialSnapshot(body); }
    catch { throw new SafetySpatialError("返回的空间对象未通过校验，当前草稿与原数据保留", { code: "INVALID_RESPONSE", status: response.status, mutationId: mutation?.mutationId }); }
  }
}
