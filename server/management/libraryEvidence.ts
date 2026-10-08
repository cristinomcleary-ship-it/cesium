import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

export type LibraryEvidence = { name: string; url: string; size: number; sha256?: string; requiredPermission?: "files" | "media" | "models" };
const validId = /^[a-zA-Z0-9_-]{1,80}$/;
function inside(root: string, file: string): boolean {
  const part = relative(root, file);
  return !!part && part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part);
}

/** Read-only manifest adapter: never grants permissions and never accepts a caller-supplied filesystem path. */
export function createLibraryEvidenceResolver(libraryRoot: string, projectId: string) {
  return async (requestedProject: string, recordId: string, fileKey: string): Promise<LibraryEvidence | undefined> => {
    if (requestedProject !== projectId || !validId.test(recordId) || !validId.test(fileKey)) return;
    const root = resolve(libraryRoot);
    try {
      try { await stat(join(root, "deleted", recordId + ".json")); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const actualRoot = await realpath(root), recordRoot = await realpath(join(root, "records", recordId));
      if (!inside(actualRoot, recordRoot)) return;
      const recordPath = await realpath(join(recordRoot, "record.json"));
      if (!inside(recordRoot, recordPath)) return;
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1 || record.id !== recordId || !["CAD", "GIS", "3D Tiles", "Model", "Imagery", "Drone Video"].includes(record.kind)) return;
      if (fileKey === "video" && record.kind !== "Drone Video") return;
      const file = record.files?.[fileKey], prefix = `/__library/files/${recordId}/${fileKey}/`;
      if (!file || typeof file.name !== "string" || !file.name.trim() || typeof file.url !== "string" || !file.url.startsWith(prefix) || /[?#]/.test(file.url)) return;
      const decoded = decodeURIComponent(file.url.slice(prefix.length));
      if (!decoded || /[\\\0:]/.test(decoded) || decoded.split("/").some(part => !part || part === "." || part === "..")) return;
      const slot = await realpath(join(recordRoot, fileKey)), target = await realpath(join(slot, decoded));
      if (!inside(recordRoot, slot) || !inside(slot, target) || target.endsWith("record.json") || target.endsWith(".pending")) return;
      const info = await stat(target);
      if (!info.isFile() || info.size <= 0) return;
      return { name: file.name, url: file.url, size: info.size, requiredPermission: record.kind === "Drone Video" ? "media" : ["3D Tiles", "Model", "Imagery"].includes(record.kind) ? "models" : "files" };
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "") || error instanceof SyntaxError || error instanceof URIError) return;
      throw error;
    }
  };
}
