export type ProjectionPoint2 = Readonly<{ x: number; y: number }>;
export type ProjectionPoint3 = Readonly<{ x: number; y: number; z: number }>;

export type ProjectiveGrid = {
  points: ProjectionPoint3[];
  textureCoordinates: number[];
  /** Interpolate (u*q, v*q, q), then divide by q in the fragment shader. */
  textureWeights: number[];
  indices: number[];
  projective: boolean;
};

type QuadMapper = {
  pointAt: (u: number, v: number) => ProjectionPoint3;
  homogeneousWeightAt: (u: number, v: number) => number;
  projective: boolean;
};

const EPSILON = 1e-12;

function finitePoint(point: ProjectionPoint3) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function subtract(left: ProjectionPoint3, right: ProjectionPoint3): ProjectionPoint3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function cross(left: ProjectionPoint3, right: ProjectionPoint3): ProjectionPoint3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dominantPlane(corners: readonly ProjectionPoint3[]) {
  const origin = corners[0];
  const translated = corners.map((point) => subtract(point, origin));
  const scale = Math.max(...translated.map((point) => Math.hypot(point.x, point.y, point.z)));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Projection quad is degenerate");
  const local = translated.map((point) => ({ x: point.x / scale, y: point.y / scale, z: point.z / scale }));
  const boundary = [local[0], local[1], local[3], local[2]];
  // Newell's normal is stable for tilted/vertical quads and avoids selecting
  // a nearly collinear three-corner subset.
  const normal = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < boundary.length; index += 1) {
    const value = cross(boundary[index], boundary[(index + 1) % boundary.length]);
    normal.x += value.x;
    normal.y += value.y;
    normal.z += value.z;
  }
  const magnitude = Math.hypot(normal.x, normal.y, normal.z);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) throw new Error("Projection quad is degenerate or self-intersecting");
  normal.x /= magnitude;
  normal.y /= magnitude;
  normal.z /= magnitude;
  const planarityError = Math.max(...local.map((point) => Math.abs(
    point.x * normal.x + point.y * normal.y + point.z * normal.z,
  ))) * scale;
  // Source heights may be rounded and an ENU footprint may have small curvature.
  // Greater relief needs explicit triangles; a homography cannot model it.
  const planarityTolerance = Math.max(0.1, scale * 1e-4);
  if (planarityError > planarityTolerance) {
    throw new Error("Projection quad is nonplanar; provide an explicit visible-surface mesh");
  }
  const largest = Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
  const points = local.map((point) => largest === Math.abs(normal.x)
    ? { x: point.y, y: point.z }
    : largest === Math.abs(normal.y)
      ? { x: point.z, y: point.x }
      : { x: point.x, y: point.y });
  const boundary2 = [points[0], points[1], points[3], points[2]];
  let sign = 0;
  for (let index = 0; index < boundary2.length; index += 1) {
    const a = boundary2[index];
    const b = boundary2[(index + 1) % boundary2.length];
    const c = boundary2[(index + 2) % boundary2.length];
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!Number.isFinite(turn) || Math.abs(turn) <= EPSILON) throw new Error("Projection quad has a degenerate edge");
    const currentSign = Math.sign(turn);
    if (sign && sign !== currentSign) throw new Error("Projection quad must be convex and must not self-intersect");
    sign = currentSign;
  }
  return points;
}

/**
 * Build a square-to-quadrilateral homography in the quad's dominant plane.
 *
 * A pinhole image projected onto a plane is projective, not bilinear.
 * The homogeneous texture weight makes triangle interpolation exact, including
 * strongly oblique and vertical surfaces; increasing mesh density alone cannot.
 */
export function createProjectiveQuadMapper(
  corners: readonly [ProjectionPoint3, ProjectionPoint3, ProjectionPoint3, ProjectionPoint3],
): QuadMapper {
  if (corners.length !== 4 || !corners.every(finitePoint)) {
    throw new Error("Projection quad must contain four finite coordinates");
  }
  const [topLeft, topRight, bottomLeft, bottomRight] = dominantPlane(corners);
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const projective = Math.max(Math.abs(dx3), Math.abs(dy3)) > EPSILON;
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= EPSILON) {
    throw new Error("Projection homography is singular");
  }
  const g = projective ? (dx3 * dy2 - dx2 * dy3) / determinant : 0;
  const h = projective ? (dx1 * dy3 - dx3 * dy1) / determinant : 0;
  const denominators = [1, 1 + g, 1 + h, 1 + g + h];
  // The denominator is affine, so positive corners exclude poles throughout
  // the entire source image. Never silently replace a pole with bilinear data.
  if (!denominators.every((value) => Number.isFinite(value) && value > EPSILON)) {
    throw new Error("Projection homography crosses a pole");
  }
  const homogeneousWeightAt = (u: number, v: number) => {
    const denominator = 1 + g * u + h * v;
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(denominator) || denominator <= EPSILON) {
      throw new Error("Projection sample crosses a homography pole");
    }
    return 1 / denominator;
  };
  return {
    pointAt: (u, v) => {
      const weight = homogeneousWeightAt(u, v);
      if ((u === 0 || u === 1) && (v === 0 || v === 1)) return corners[v * 2 + u];
      // For coplanar corners the uv cross term cancels exactly. Keeping the
      // corner-weight form also preserves small accepted height-rounding
      // residuals instead of silently discarding bottomRight.z.
      const blends = [
        (1 - u) * (1 - v) * denominators[0],
        u * (1 - v) * denominators[1],
        (1 - u) * v * denominators[2],
        u * v * denominators[3],
      ];
      // Translate to the first corner to avoid precision loss in ECEF input.
      const result = { ...corners[0] };
      for (let index = 1; index < corners.length; index += 1) {
        result.x += (corners[index].x - corners[0].x) * blends[index] * weight;
        result.y += (corners[index].y - corners[0].y) * blends[index] * weight;
        result.z += (corners[index].z - corners[0].z) * blends[index] * weight;
      }
      return result;
    },
    homogeneousWeightAt,
    projective,
  };
}

export function buildProjectiveGrid(
  corners: readonly [ProjectionPoint3, ProjectionPoint3, ProjectionPoint3, ProjectionPoint3],
  columns: number,
  rows: number,
  sourceTopFraction = 0,
  verticalSamplingExponent = 1.7,
): ProjectiveGrid {
  if (!Number.isInteger(columns) || columns < 1 || columns > 64) throw new Error("Invalid projection grid column count");
  if (!Number.isInteger(rows) || rows < 1 || rows > 64) throw new Error("Invalid projection grid row count");
  if (!Number.isFinite(sourceTopFraction) || sourceTopFraction < 0 || sourceTopFraction >= 0.5) {
    throw new Error("Invalid source crop fraction");
  }
  if (!Number.isFinite(verticalSamplingExponent) || verticalSamplingExponent < 1 || verticalSamplingExponent > 4) {
    throw new Error("Invalid vertical sampling exponent");
  }
  const mapper = createProjectiveQuadMapper(corners);
  const points: ProjectionPoint3[] = [];
  const textureCoordinates: number[] = [];
  const textureWeights: number[] = [];
  const indices: number[] = [];
  const stride = columns + 1;

  for (let row = 0; row <= rows; row += 1) {
    const v = Math.pow(row / rows, verticalSamplingExponent);
    const sourceV = sourceTopFraction + (1 - sourceTopFraction) * v;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      points.push(mapper.pointAt(u, v));
      // Video pixels are top-left based; WebGL texture coordinates bottom-left.
      textureCoordinates.push(u, 1 - sourceV);
      textureWeights.push(mapper.homogeneousWeightAt(u, v));
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * stride + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  return { points, textureCoordinates, textureWeights, indices, projective: mapper.projective };
}
