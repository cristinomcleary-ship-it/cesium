import { readCadImport, type CadImportPackage } from "./cadImport";

export type CadWorkerRequest = { type: "dwg" | "read"; file: File };
export type CadWorkerMessage =
  | { type: "progress"; message: string }
  | { type: "result"; operation: "dwg"; value: CadImportPackage; cadImportData: ArrayBuffer }
  | { type: "result"; operation: "read"; value: CadImportPackage }
  | { type: "error"; message: string; stack?: string };

/** Small files avoid worker startup; larger JSON must not block scene input. */
export const CAD_IMPORT_WORKER_MIN_BYTES = 1024 * 1024;

function cancelled(): DOMException { return new DOMException("CAD 加载已取消", "AbortError"); }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

function runCadWorker<T>(
  request: CadWorkerRequest,
  result: (message: Extract<CadWorkerMessage, { type: "result" }>) => T,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (worker) {
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const finish = (error: Error | undefined, value?: T) => {
      if (settled) return;
      settled = true;
      try { cleanup(); }
      finally { if (error) reject(error); else resolve(value!); }
    };
    const onAbort = () => finish(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      worker = new Worker(new URL("./cadImport.worker.ts", import.meta.url), { type: "module", name: "cad-import" });
      worker.onmessage = (event: MessageEvent<CadWorkerMessage>) => {
        if (settled) return;
        try {
          const message = event.data;
          if (!message || typeof message !== "object") throw new Error("CAD 后台返回了无效的数据");
          if (message.type === "progress") onProgress?.(message.message);
          else if (message.type === "result") finish(undefined, result(message));
          else if (message.type === "error") {
            const error = new Error(message.message);
            if (message.stack) error.stack = message.stack;
            finish(error);
          } else throw new Error("CAD 后台返回了无法识别的消息");
        } catch (error) { finish(asError(error)); }
      };
      worker.onerror = event => finish(new Error(event.message || "CAD 独立解析线程异常退出"));
      worker.onmessageerror = () => finish(new Error("CAD 后台解析结果无法读取"));
      if (signal?.aborted) { onAbort(); return; }
      // File/Blob structured cloning shares immutable file bytes. Do not first
      // allocate a main-thread string or ArrayBuffer for a large drawing.
      worker.postMessage(request);
    } catch (error) { finish(asError(error)); }
  });
}

/** Parses one DWG in a disposable worker, then releases its LibreDWG WASM heap. */
export async function createCadImportFromDwgInWorker(
  file: File,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<{ value: CadImportPackage; blob: Blob }> {
  return runCadWorker({ type: "dwg", file }, message => {
    if (message.operation !== "dwg" || !(message.cadImportData instanceof ArrayBuffer) || !message.value) {
      throw new Error("DWG 后台解析结果不完整");
    }
    return { value: message.value, blob: new Blob([message.cadImportData], { type: "application/vnd.cesium.cadimport+json" }) };
  }, onProgress, signal);
}

/** Read a saved CAD package without doing large JSON parsing on the UI thread.
 * Worker startup/parse failures are surfaced, never silently retried on the UI.
 * Small files and CPU-only environments retain the original format reader.
 */
export async function readCadImportInWorker(
  file: File,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<CadImportPackage> {
  if (signal?.aborted) throw cancelled();
  if (file.size >= CAD_IMPORT_WORKER_MIN_BYTES && typeof Worker !== "undefined") {
    return runCadWorker({ type: "read", file }, message => {
      if (message.operation !== "read" || !message.value) throw new Error("CAD 后台解析结果不完整");
      return message.value;
    }, onProgress, signal);
  }
  // File.text() cannot be cancelled, but its result must not resurrect an import
  // after cancellation. The listener rejects immediately, even during file I/O.
  return new Promise<CadImportPackage>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: CadImportPackage) => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => finish(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    void readCadImport(file, signal).then(value => finish(undefined, value), error => finish(asError(error)));
  });
}
