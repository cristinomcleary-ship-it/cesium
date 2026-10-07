import type { CadImportEntity, CadPoint } from "./cadImport.ts";

export type CadPreviewBounds = { cx: number; cy: number; spanX: number; spanY: number; mode: "selected" | "numbered" | "all" };
const usable = (point: CadPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/** Fit a view to known CAD entity indices, retaining every original entity for pan/full drawing. */
export function cadPreviewBounds(entities: CadImportEntity[], indices?: number[], all = false): CadPreviewBounds | undefined {
  let mode: CadPreviewBounds["mode"] = "all";
  let points: CadPoint[] = [];
  if (!all) {
    points = (indices || []).filter(Number.isSafeInteger).flatMap(index => entities[index]?.vertices || []).filter(usable);
    if (points.length) mode = "selected";
    else {
      points = entities.filter(entity => entity.type === "TEXT" && /(?:^|[^0-9])\d{1,3}\s*[-－—]\s*\d{1,3}(?:$|[^0-9])/.test(entity.text || ""))
        .flatMap(entity => entity.vertices).filter(usable);
      if (points.length) mode = "numbered";
    }
  }
  if (!points.length) points = entities.filter(entity => entity.type !== "POINT").flatMap(entity => entity.vertices || []).filter(usable);
  if (!points.length) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
  const margin = mode === "all" ? 0 : Math.max(8, Math.max(maxX - minX, maxY - minY) * .3);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, spanX: Math.max(1, maxX - minX + margin * 2), spanY: Math.max(1, maxY - minY + margin * 2), mode };
}
