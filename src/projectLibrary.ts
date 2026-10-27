import type { CadCoordinateOptions, CadDisplayMode, TilesetOptions } from "./types";

export type LibraryKind = "CAD" | "3D Tiles" | "GIS" | "Model" | "Imagery" | "Drone Video";
export type LibraryFile = { name: string; url: string };
export type LibrarySettings = {
  coordinates?: CadCoordinateOptions; displayMode?: CadDisplayMode;
  url?: string; assetId?: number; localPath?: string; tiles?: TilesetOptions; quality?: string;
  matrix?: number[]; scale?: number;
  editor?: { baseMatrix: number[]; center: number[]; east: number; north: number; up: number; heading: number };
  bounds?: { west: number; south: number; east: number; north: number };
  imageryUrl?: string; video?: Record<string, unknown>;
};
export type LibraryRecord = {
  version: 1; id: string; name: string; kind: LibraryKind; visible: boolean;
  createdAt: string; updatedAt: string; files: Record<string, LibraryFile>; settings: LibrarySettings;
};
export type SceneView = { position: number[]; direction: number[]; up: number[]; basemap: string; activeImageryId?: string; activeVideoId?: string };
export type LibraryListing = {
  records: LibraryRecord[]; problems: Array<{ id: string; error: string; deleted?: boolean; name?: string; kind?: LibraryKind }>; view?: SceneView;
  deletedVideoIds?: string[];
};
export class LibraryRequestError extends Error {
  constructor(message: string, readonly status: number, readonly deleted = false, readonly code?: string) { super(message); }
}
export async function libraryRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/__library" + path, {
    ...init, cache: "no-store",
    headers: { "X-Cesium-Library": "1", ...init.headers },
  });
  const body = await response.json().catch(() => ({ error: "资料库服务不可用，请使用本机启动脚本重新启动软件" }));
  if (!response.ok || body.error) throw new LibraryRequestError(body.error || "资料保存失败", response.status, body.deleted === true, body.code);
  return body as T;
}
export function jsonRequest(method: string, value: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}
