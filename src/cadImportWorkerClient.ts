import type { CadImportPackage } from "./cadImport";

type CadWorkerMessage =
  | { type: "progress"; message: string }
  | { type: "result"; value: CadImportPackage; cadImportData: ArrayBuffer }
  | { type: "error"; message: string; stack?: string };

/** Parses one DWG in a disposable worker so LibreDWG's large WASM heap is reclaimed afterwards. */
export async function createCadImportFromDwgInWorker(
  file: File,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<{ value: CadImportPackage; blob: Blob }> {
  const worker = new Worker(new URL("./cadImport.worker.ts", import.meta.url), { type: "module", name: "cad-import" });
  try {
    const data = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("CAD 加载已取消", "AbortError");
    return await new Promise<{ value: CadImportPackage; blob: Blob }>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const succeed = (result: { value: CadImportPackage; blob: Blob }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(new DOMException("CAD 加载已取消", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.onmessage = (event: MessageEvent<CadWorkerMessage>) => {
        const message = event.data;
        if (message.type === "progress") onProgress?.(message.message);
        else if (message.type === "result") succeed({
          value: message.value,
          blob: new Blob([message.cadImportData], { type: "application/vnd.cesium.cadimport+json" }),
        });
        else fail(new Error(message.message));
      };
      worker.onerror = (event) => fail(new Error(event.message || "DWG 独立解析线程异常退出"));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      worker.postMessage({ name: file.name, data }, [data]);
    });
  } finally {
    worker.terminate();
  }
}
