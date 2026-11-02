import type { PlanXY } from "./temporaryWorksGeometry";

export function formatRoadStation(metres: number): string {
  const mm = Math.round(metres * 1000);
  const kilometres = Math.floor(mm / 1_000_000);
  const remainder = ((mm % 1_000_000) / 1000).toFixed(3).padStart(7, '0');
  return `K${kilometres}+${remainder}`;
}

type ConflictKind = 'crossing' | 'retrace' | 'levels';

export class RoadRouteConflict extends Error {
  readonly kind: ConflictKind;
  readonly stations: readonly [number, number];

  constructor(kind: ConflictKind, stations: readonly [number, number]) {
    const [a,b] = [...stations].sort((u,v) => u-v) as [number, number];
    const locations = `${formatRoadStation(a)} 与 ${formatRoadStation(b)}`;
    const detail = kind === 'crossing' ? '两处中心线在同一位置相交，请核对交叉口或按独立路线建模。'
      : kind === 'retrace' ? '两段中心线沿同一路径重叠，请核对重复图线。'
      : '两段路基占用同一位置且设计高程冲突，请核对这两个里程的纵坡或分设方案。';
    super(locations + '：' + detail);
    this.name = 'RoadRouteConflict';
    this.kind = kind;
    this.stations = [a,b];
  }
}

export type RoadConflictMark = { from: PlanXY; to: PlanXY; point: PlanXY; station: number };

/** Interpolate on the directed CAD feature so the preview highlights the same station the solver reported. */
export function markConflictStations(cad: readonly PlanXY[], metric: readonly PlanXY[],
  factors: readonly number[] | undefined, stations: readonly [number, number]): RoadConflictMark[] {
  if (cad.length !== metric.length || cad.length < 2) return [];
  const result: RoadConflictMark[] = [];
  let start = 0, previous = 0;
  for (let i = 1; i < metric.length; i++) {
    const chord = Math.hypot(metric[i].x-metric[previous].x, metric[i].y-metric[previous].y);
    if (chord <= 1e-7) continue;
    const length = chord * (factors?.[i-1] ?? 1), end = start + length;
    while (result.length < stations.length && stations[result.length] <= end + 1e-7) {
      const station = stations[result.length], t = Math.max(0, Math.min(1, (station-start)/length));
      const from = cad[previous], to = cad[i];
      result.push({from, to, point:{x:from.x+(to.x-from.x)*t, y:from.y+(to.y-from.y)*t}, station});
    }
    if (result.length === stations.length) break;
    start=end; previous=i;
  }
  return result;
}
