import { SAFETY_EVENTS_API_PATH, type SafetyEventMutation, type SafetyEventRecord, type SafetyEventResult, type SafetyEventSnapshot } from "./safetyEventTypes.ts";
import { validateSafetyEventMutation, validateSafetyEventSnapshot } from "./safetyEventValidation.ts";

export class SafetyEventError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly snapshot?: SafetyEventSnapshot) { super(message); this.name = "SafetyEventError"; }
}
export interface SafetyEventAdapter {
  load(): Promise<SafetyEventSnapshot>;
  create(event: SafetyEventRecord, expectedRevision: number): Promise<SafetyEventSnapshot>;
  complete(id: string, result: SafetyEventResult, expectedRevision: number): Promise<SafetyEventSnapshot>;
}
export class SafetyEventRepository implements SafetyEventAdapter {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; }
  load(): Promise<SafetyEventSnapshot> { return this.request(); }
  create(event: SafetyEventRecord, expectedRevision: number): Promise<SafetyEventSnapshot> {
    return this.mutate({ operation: "create", event, expectedRevision, mutationId: crypto.randomUUID() });
  }
  complete(id: string, result: SafetyEventResult, expectedRevision: number): Promise<SafetyEventSnapshot> {
    return this.mutate({ operation: "complete", id, result, expectedRevision, mutationId: crypto.randomUUID() });
  }
  private async mutate(value: SafetyEventMutation): Promise<SafetyEventSnapshot> {
    let mutation: SafetyEventMutation;
    try { mutation = validateSafetyEventMutation(value); } catch (error) { throw new SafetyEventError(error instanceof Error ? error.message : "事件未通过校验", "VALIDATION"); }
    try { return await this.request(mutation); }
    catch (error) { if (!(error instanceof SafetyEventError) || error.code !== "NETWORK") throw error; return this.request(mutation); }
  }
  private async request(mutation?: SafetyEventMutation): Promise<SafetyEventSnapshot> {
    let response: Response;
    try { response = await this.fetcher(SAFETY_EVENTS_API_PATH, { method: mutation ? "POST" : "GET", cache: "no-store", headers: { "X-Cesium-Library": "1", ...(mutation ? { "Content-Type": "application/json" } : {}) }, ...(mutation ? { body: JSON.stringify(mutation) } : {}) }); }
    catch { throw new SafetyEventError("事件保存结果尚未确认，输入已保留，请重新读取后重试", "NETWORK"); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new SafetyEventError("事件服务响应无法确认，输入已保留", "INVALID_RESPONSE", response.status); }
    if (!response.ok) {
      const error = body && typeof body === "object" ? body as { error?: string; code?: string; snapshot?: unknown } : {};
      let snapshot: SafetyEventSnapshot | undefined;
      try { if (error.snapshot) snapshot = validateSafetyEventSnapshot(error.snapshot); } catch { /* Retain original error. */ }
      throw new SafetyEventError(error.error || "事件保存失败，输入已保留", error.code || "SERVER_ERROR", response.status, snapshot);
    }
    try { return validateSafetyEventSnapshot(body); } catch { throw new SafetyEventError("事件快照无效，未变更当前状态", "INVALID_RESPONSE", response.status); }
  }
}
