import type { PlanXY } from './temporaryWorksGeometry';

function inside(point: PlanXY, ring: readonly PlanXY[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x) result = !result;
  }
  return result;
}

/** A bounded, distributed sample for a rigid bottom plane; does not deform the GLB. */
export function glbGroundSamplePoints(footprints: readonly (readonly PlanXY[])[]) {
  const points: PlanXY[] = [];
  const add = (point: PlanXY) => {
    if (!points.some(p => Math.hypot(p.x-point.x,p.y-point.y) < 0.01)) points.push(point);
  };
  for (const ring of footprints) {
    if (ring.length < 3) throw new Error('建筑底面轮廓不完整，无法读取摄影高程。');
    const perimeter = ring.reduce((sum,p,i) => sum+Math.hypot(p.x-ring[(i+1)%ring.length].x,p.y-ring[(i+1)%ring.length].y),0);
    const spacing = Math.max(5,perimeter/48);
    for (let i=0;i<ring.length;i++) {
      const a=ring[i],b=ring[(i+1)%ring.length],steps=Math.max(2,Math.ceil(Math.hypot(a.x-b.x,a.y-b.y)/spacing));
      for (let j=0;j<steps;j++) add({x:a.x+(b.x-a.x)*j/steps,y:a.y+(b.y-a.y)*j/steps});
    }
    const minX=Math.min(...ring.map(p=>p.x)),maxX=Math.max(...ring.map(p=>p.x));
    const minY=Math.min(...ring.map(p=>p.y)),maxY=Math.max(...ring.map(p=>p.y));
    for(let x=1;x<6;x++) for(let y=1;y<6;y++) {
      const point={x:minX+(maxX-minX)*x/6,y:minY+(maxY-minY)*y/6};
      if(inside(point,ring)) add(point);
    }
  }
  if(points.length>2048) throw new Error('建筑底面过于复杂，自动摄影取高采样量超限，请核对模型轮廓。');
  return points;
}

export function summarizeGlbGroundSamples(heights: readonly (number|null)[]) {
  const valid=heights.filter((height):height is number => height !== null && Number.isFinite(height));
  if(valid.length<3 || valid.length/heights.length<0.8)
    throw new Error(`建筑底面摄影高程不足（有效 ${valid.length}/${heights.length}），不能确认自动落位。请检查摄影覆盖或切换手动输入实测高程。`);
  return {status:'sampled' as const,sampleCount:heights.length,validCount:valid.length,minimum:Math.min(...valid),maximum:Math.max(...valid)};
}
