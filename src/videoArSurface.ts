export type SurfacePoint = Readonly<{ x: number; y: number; z: number }>;
export type SurfaceHit = { position: SurfacePoint; depth: number };
export type RaySurfaceGrid = {
  positions: SurfacePoint[]; textureCoordinates: Float32Array; textureWeights: Float32Array; indices: Uint16Array;
  missingSamples: number; rejectedTriangles: number;
};

/** Sample source-image rays independently; absent hits and depth breaks leave holes. */
export function buildRaySurfaceGrid(
  columns: number, rows: number, sourceTopFraction: number,
  hitAt: (u: number, v: number) => SurfaceHit | undefined,
  maximumDepthRatio = 1.75,
): RaySurfaceGrid {
  if (![columns, rows].every(value => Number.isInteger(value) && value >= 1 && value <= 64)
    || !Number.isFinite(sourceTopFraction) || sourceTopFraction < 0 || sourceTopFraction >= 0.5
    || !Number.isFinite(maximumDepthRatio) || maximumDepthRatio <= 1) throw new Error("Invalid ray grid settings");
  const hits: Array<SurfaceHit | undefined> = [];
  const uvs: number[] = [];
  let missingSamples = 0;
  for (let row = 0; row <= rows; row++) {
    const v = sourceTopFraction + (1 - sourceTopFraction) * Math.pow(row / rows, 1.4);
    for (let column = 0; column <= columns; column++) {
      const u = column / columns;
      const hit = hitAt(u, v);
      const valid = hit && [hit.position.x, hit.position.y, hit.position.z, hit.depth].every(Number.isFinite) && hit.depth > 0;
      hits.push(valid ? hit : undefined);
      uvs.push(u, v);
      if (!valid) missingSamples++;
    }
  }
  const sourceIndices: number[] = [];
  let rejectedTriangles = 0;
  const add = (a: number, b: number, c: number) => {
    const values = [hits[a], hits[b], hits[c]];
    if (values.some(hit => !hit)) { rejectedTriangles++; return; }
    const depths = values.map(hit => hit!.depth);
    if (Math.max(...depths) / Math.min(...depths) > maximumDepthRatio) { rejectedTriangles++; return; }
    const pa = values[0]!.position, pb = values[1]!.position, pc = values[2]!.position;
    const x1 = pb.x-pa.x, y1=pb.y-pa.y, z1=pb.z-pa.z;
    const x2 = pc.x-pa.x, y2=pc.y-pa.y, z2=pc.z-pa.z;
    if (Math.hypot(y1*z2-z1*y2, z1*x2-x1*z2, x1*y2-y1*x2) < 1e-8) { rejectedTriangles++; return; }
    sourceIndices.push(a,b,c);
  };
  const stride = columns + 1;
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const a = row * stride + col, b = a + 1, c = a + stride, d = c + 1;
    add(a,c,b); add(b,c,d);
  }
  const map = new Map<number, number>();
  const positions: SurfacePoint[] = [], coords: number[] = [], weights: number[] = [], indices: number[] = [];
  let maximumDepth = 1;
  for (const index of sourceIndices) maximumDepth = Math.max(maximumDepth, hits[index]!.depth);
  for (const index of sourceIndices) {
    if (!map.has(index)) {
      map.set(index, positions.length);
      positions.push(hits[index]!.position);
      coords.push(uvs[index*2], uvs[index*2+1]);
      // Camera-space Z is affine over each spatial triangle.
      weights.push(hits[index]!.depth / maximumDepth);
    }
    indices.push(map.get(index)!);
  }
  return { positions, textureCoordinates: new Float32Array(coords), textureWeights: new Float32Array(weights),
    indices: new Uint16Array(indices), missingSamples, rejectedTriangles };
}
