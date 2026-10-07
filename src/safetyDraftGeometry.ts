import type { SafetyPosition } from "./safetyTypes.ts";
import type { SpatialKind } from "./safetySpatialTypes.ts";

type XY = { x: number; y: number };
export type DraftShapeValidation = { ok: true; badEdges: number[] } | { ok: false; message: string; badEdges: number[] };
const cross = (a: XY, b: XY, c: XY) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const on = (a: XY, b: XY, p: XY) => Math.abs(cross(a, b, p)) < 1e-7 && p.x >= Math.min(a.x, b.x) - 1e-7
  && p.x <= Math.max(a.x, b.x) + 1e-7 && p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7;
const intersect = (a: XY, b: XY, c: XY, d: XY) => {
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  return ((x > 0 && y < 0 || x < 0 && y > 0) && (z > 0 && w < 0 || z < 0 && w > 0)) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
};

/** Same local horizontal geometry rules as persistence, additionally returning edges for feedback. */
export function validateDraftShape(kind: SpatialKind, positions: readonly SafetyPosition[]): DraftShapeValidation {
  const fail = (message: string, badEdges: number[] = []): DraftShapeValidation => ({ ok: false, message, badEdges });
  if (positions.some(p => ![p.longitude, p.latitude, p.height].every(Number.isFinite))) return fail("这个位置暂不可用，请重新点选");
  if (kind === "risk-point") return positions.length === 1 ? { ok: true, badEdges: [] } : fail("请先在模型上选择风险位置");
  if (positions.length < 3) return fail("至少选择 3 个不同的边界点");
  const origin = positions[0], cos = Math.cos(origin.latitude * Math.PI / 180);
  const p = positions.map(v => ({ x: (v.longitude - origin.longitude) * 111_320 * cos, y: (v.latitude - origin.latitude) * 111_320 }));
  if (p.some(v => Math.hypot(v.x, v.y) > 100_000)) return fail("绘制范围过大，请分别定义较小的区域");
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    if (Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y) < .001) return fail("边界点重合，请移动或删除重复的点", [i, j]);
  }
  let area = 0;
  const bad = new Set<number>();
  for (let i = 0; i < p.length; i++) {
    const next = (i + 1) % p.length;
    area += p[i].x * p[next].y - p[next].x * p[i].y;
    for (let j = i + 1; j < p.length; j++) {
      const nextJ = (j + 1) % p.length;
      if (j === next || nextJ === i) continue;
      if (intersect(p[i], p[next], p[j], p[nextJ])) { bad.add(i); bad.add(j); }
    }
  }
  if (bad.size) return fail("边界存在交叉，请调整标出的边", [...bad]);
  if (Math.abs(area / 2) < .01) return fail("边界尚未形成有效范围，请调整顶点", p.map((_, i) => i));
  return { ok: true, badEdges: [] };
}

export function nextSpatialName(kind: SpatialKind, existingNames: readonly string[]): string {
  const label = { "construction-area": "施工区域", railway: "铁路范围", "risk-point": "风险点" }[kind];
  let sequence = 1;
  while (existingNames.includes(`${label} ${String(sequence).padStart(2, "0")}`)) sequence++;
  return `${label} ${String(sequence).padStart(2, "0")}`;
}
