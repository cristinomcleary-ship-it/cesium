import type { TemporaryWorksPlan, TemporaryWorksStore } from "./temporaryWorksPanel";

type SavedPlan = { projectId: string; id: string; plan: TemporaryWorksPlan };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("cesium-temporary-works-v1", 1);
    request.onupgradeneeded = () => {
      const plans = request.result.createObjectStore("plans", { keyPath: ["projectId", "id"] });
      plans.createIndex("projectId", "projectId");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

// Resolve writes on transaction completion so a quota or commit failure leaves the draft available.
async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("plans", mode);
      transaction.onabort = () => reject(transaction.error ?? new Error("临建规划读写已中止"));
      const request = operation(transaction.objectStore("plans"));
      transaction.oncomplete = () => resolve(request.result);
    });
  } finally {
    db.close();
  }
}

export const temporaryWorksStore: TemporaryWorksStore = {
  async list(projectId) {
    const rows: SavedPlan[] = await transact("readonly", store => store.index("projectId").getAll(projectId));
    return rows.map(row => row.plan);
  },
  async put(projectId, plan) {
    await transact("readwrite", store => store.put({ projectId, id: plan.id, plan } satisfies SavedPlan));
  },
  async updateExisting(projectId, id, update) {
    let result: TemporaryWorksPlan | undefined, updateError: unknown;
    try {
      await transact("readwrite", store => {
        const request = store.get([projectId,id]);
        request.onsuccess = () => {
          try {
            const row: SavedPlan | undefined = request.result;
            if (!row) throw new Error("原场坪方案已移除，请刷新方案列表。");
            result = update(row.plan);
            store.put({...row, plan:result});
          } catch (error) {
            updateError = error;
            store.transaction.abort();
          }
        };
        return request;
      });
    } catch (error) { throw updateError ?? error; }
    return result!;
  },
  async remove(projectId, id) {
    await transact("readwrite", store => store.delete([projectId, id]));
  },
};
