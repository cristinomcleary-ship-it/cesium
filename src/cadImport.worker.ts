/// <reference lib="webworker" />

import { createCadImportFromDwg } from "./cadImport";

type CadWorkerRequest = { name: string; data: ArrayBuffer };

self.onmessage = async (event: MessageEvent<CadWorkerRequest>) => {
  try {
    self.postMessage({ type: "progress", message: "正在独立线程解析 DWG…" });
    const file = new File([event.data.data], event.data.name, { type: "application/acad" });
    const value = await createCadImportFromDwg(file);
    self.postMessage({ type: "progress", message: "正在生成 CAD 导入文件…" });
    const cadImportData = new TextEncoder().encode(JSON.stringify(value)).buffer;
    self.postMessage({ type: "result", value, cadImportData }, { transfer: [cadImportData] });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};

export {};
