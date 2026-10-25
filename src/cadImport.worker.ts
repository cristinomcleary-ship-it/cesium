/// <reference lib="webworker" />

import { createCadImportFromDwg, readCadImport } from "./cadImport";
import type { CadWorkerMessage, CadWorkerRequest } from "./cadImportWorkerClient";

self.onmessage = async (event: MessageEvent<CadWorkerRequest>) => {
  const send = (message: CadWorkerMessage, transfer?: Transferable[]) => self.postMessage(message, { transfer });
  try {
    const request = event.data;
    if (request.type === "read") {
      send({ type: "progress", message: "正在后台读取 CAD 导入文件…" });
      const value = await readCadImport(request.file);
      // This path already has the saved file. Return the parsed package once,
      // without also serializing or copying a second full JSON representation.
      send({ type: "result", operation: "read", value });
      return;
    }
    if (request.type !== "dwg") throw new Error("无法识别 CAD 后台解析请求");
    send({ type: "progress", message: "正在独立线程解析 DWG…" });
    const value = await createCadImportFromDwg(request.file);
    send({ type: "progress", message: "正在生成 CAD 导入文件…" });
    const cadImportData = new TextEncoder().encode(JSON.stringify(value)).buffer;
    send({ type: "result", operation: "dwg", value, cadImportData }, [cadImportData]);
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined });
  }
};

export {};
