import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { MANAGEMENT_COLLECTIONS, type ManagementCollection, type ManagementRecord } from "../../src/managementTypes.ts";
import { recordReferences } from "./authorization.ts";
import { ManagementError, ensure, id } from "./domain.ts";

export const MACHINERY_DOCUMENT_CATEGORIES = ["performance", "certificate", "inspection", "submission"] as const;
export function machineryDocumentCategory(value: unknown): string | undefined {
  if (value === undefined || value === null) return;
  ensure(typeof value === "string" && (MACHINERY_DOCUMENT_CATEGORIES as readonly string[]).includes(value), "MACHINERY_DOCUMENT_CATEGORY", "机械资料分类无效");
  return value;
}
export function validateMachineryDocumentRefs(category: string | undefined, refs: unknown) {
  if (!category) return;
  ensure(Array.isArray(refs) && refs.length === 1 && refs[0]?.kind === "resources", "MACHINERY_DOCUMENT_RESOURCE", "每份机械资料必须关联一台当前项目机械");
}
const live = (record: ManagementRecord) => !record.deletedAt && !["deleted", "deleting", "removed"].includes(record.status);
export function assertEvidenceUnreferenced(target: ManagementRecord, list: (kind: ManagementCollection) => ManagementRecord[]) {
  for (const kind of MANAGEMENT_COLLECTIONS) for (const record of list(kind)) {
    if (!live(record) || kind === "evidence" && record.id === target.id) continue;
    const references = recordReferences(record, kind);
    if (kind === "reports" && Array.isArray(record.sourceRevisions)) for (const source of record.sourceRevisions as { kind: ManagementCollection; id: string; data: ManagementRecord }[]) {
      if (source.kind === "evidence" && source.id === target.id) references.push({ kind: "evidence", id: source.id });
      references.push(...recordReferences(source.data, source.kind));
    }
    if (references.some(ref => ref.kind === "evidence" && ref.id === target.id)
      || kind === "evidence" && target.storageName && record.storageName === target.storageName) {
      throw new ManagementError(409, "FILE_IN_USE", "附件仍被其他资料或业务记录引用，请先解除关联后再删除");
    }
  }
}
/** Only removes a managed upload, never an external source or a symlink target. */
export function removeEvidenceBytes(root: string, record: ManagementRecord, remove: (path: string) => void = unlinkSync): void {
  ensure(typeof record.storageName === "string", "FILE_EXTERNAL", "原资料附件请从场景资料库删除");
  const directory = join(root, "management-files"), path = join(directory, id(record.storageName));
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const actualRoot = realpathSync(directory), actual = realpathSync(path), part = relative(actualRoot, actual);
  ensure(!info.isSymbolicLink() && info.isFile() && !!part && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part), "FILE_PATH_INVALID", "附件位置不属于受控存储");
  remove(path);
}
