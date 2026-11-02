import type { PlanningCadFeature, PlanningPoint } from './temporaryWorksCad';

type Node = { point: PlanningPoint; roundoff: number; parent: number; edges: number[] };

// Separately stored ARC endpoints are evaluated with trigonometry. Compare
// only their floating-point roundoff; two authored LINE endpoints match exactly.
function topology(edges: PlanningCadFeature[]) {
  const nodes: Node[] = [], exact = new Map<string, number>();
  let maxRoundoff = 0;
  function node(point: PlanningPoint, roundoff: number) {
    const key = point.x + ',' + point.y;
    const known = exact.get(key);
    if (known !== undefined) {
      nodes[known].roundoff = Math.max(nodes[known].roundoff, roundoff);
      return known;
    }
    const id = nodes.length;
    nodes.push({ point, roundoff, parent:id, edges:[] }); exact.set(key, id);
    return id;
  }
  const ends = edges.map(edge => {
    const tolerance = /^(ARC|ELLIPSE)$/.test(edge.sourceType)
      ? 16 * Number.EPSILON * edge.points.reduce((largest,p) => Math.max(largest,Math.abs(p.x),Math.abs(p.y)),1)
      : 0;
    maxRoundoff = Math.max(maxRoundoff, tolerance);
    return [node(edge.points[0],tolerance), node(edge.points[edge.points.length-1],tolerance)];
  });
  function root(id: number): number {
    while (id !== nodes[id].parent) { nodes[id].parent = nodes[nodes[id].parent].parent; id = nodes[id].parent; }
    return id;
  }
  if (maxRoundoff > 0) {
    const buckets = new Map<string, number[]>();
    function bin(p: PlanningPoint) { return [Math.floor(p.x/maxRoundoff), Math.floor(p.y/maxRoundoff)]; }
    for (const [i,n] of nodes.entries()) {
      const cell = bin(n.point).join(',');
      const members = buckets.get(cell);
      if (members) members.push(i); else buckets.set(cell, [i]);
    }
    for (const [i,n] of nodes.entries()) {
      if (!n.roundoff) continue;
      const [x,y] = bin(n.point);
      for (const dx of [-1,0,1]) for (const dy of [-1,0,1]) {
        for (const j of buckets.get((x+dx)+','+(y+dy)) ?? []) {
          if (j === i) continue;
          const q = nodes[j].point;
          if (Math.hypot(n.point.x-q.x, n.point.y-q.y) <= n.roundoff) nodes[root(j)].parent = root(i);
        }
      }
    }
  }
  for (const [index,pair] of ends.entries()) for (let j = 0; j < 2; j++) {
    pair[j] = root(pair[j]);
    nodes[pair[j]].edges.push(index);
  }
  return { nodes, ends };
}

function layerChains(edges: PlanningCadFeature[], closedOnly = false) {
  if (edges.length < 2) return [];
  const {nodes, ends} = topology(edges);
  const visited = new Set<number>(), explored = new Set<number>(), chains: PlanningCadFeature[] = [];
  for (let first = 0; first < edges.length; first++) {
    if (visited.has(first)) continue;
    const component = [first];
    visited.add(first);
    let start = ends[first][0], branched = false;
    for (let i = 0; i < component.length; i++) for (const id of ends[component[i]]) {
      if (explored.has(id)) continue;
      explored.add(id);
      const neighbours = nodes[id].edges;
      if (neighbours.length === 1) start = id;
      if (neighbours.length > 2) branched = true;
      for (const next of neighbours) if (!visited.has(next)) { visited.add(next); component.push(next); }
    }
    if (branched || component.length < 2) continue;
    const closed = nodes[start].edges.length === 2;
    const linesOnly = component.every(i => edges[i].sourceType === 'LINE');
    if ((closedOnly && !closed) || (closed && !linesOnly)) continue;
    let id = start, previous = -1, reverse = false;
    const points: PlanningPoint[] = [];
    const factors = !closed && component.some(i => edges[i].stationFactors) ? [] as number[] : undefined;
    for (let i = 0; i < component.length; i++) {
      const index = nodes[id].edges.find(n => n !== previous)!;
      const feature = edges[index], line = feature.points;
      const forward = ends[index][0] === id;
      if (index === first) reverse = !forward;
      if (!points.length) points.push(forward ? line[0] : line[line.length-1]);
      for (let j = 1; j < line.length; j++) {
        points.push(forward ? line[j] : line[line.length-1-j]);
        factors?.push(feature.stationFactors?.[forward ? j-1 : line.length-1-j] ?? 1);
      }
      id = ends[index][forward ? 1 : 0]; previous = index;
    }
    // Make the first CAD object's own drawing direction the positive chainage.
    if (reverse) { points.reverse(); factors?.reverse(); }
    if (closed) points.pop();
    if (points.length >= (closed ? 3 : 2)) chains.push({ id:'chain-'+edges[first].id, layer:edges[first].layer,
      sourceType:linesOnly ? 'LINE 组合' : '组合中心线', closed, points, ...(factors ? {stationFactors:factors} : {}) });
  }
  return chains;
}

export function joinPlanningCadFeatures(features: PlanningCadFeature[]) {
  const layers = new Map<string, PlanningCadFeature[]>();
  for (const f of features) {
    if (f.closed || f.points.length < 2) continue;
    const group = layers.get(f.layer);
    if (group) group.push(f); else layers.set(f.layer,[f]);
  }
  const chains: PlanningCadFeature[] = [];
  for (const edges of layers.values()) {
    const joined = layerChains(edges);
    for (const path of joined) chains.push(path);
    // Keep v1's standalone, closed LINE boundaries when an open arc meets
    // a vertex. No traversing a branched junction to manufacture an open route.
    const lines = edges.filter(edge => edge.sourceType === 'LINE');
    if (lines.length !== edges.length && lines.length >= 3) {
      const ids = new Set(joined.map(f => f.id));
      const rings = layerChains(lines,true);
      for (const ring of rings) if (!ids.has(ring.id)) chains.push(ring);
    }
  }
  return chains;
}
