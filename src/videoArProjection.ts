export type ProjectionPoint2 = Readonly<{ x: number; y: number }>;
export type ProjectionPoint3 = Readonly<{ x: number; y: number; z: number }>;

export type ProjectiveGrid = {
  points: ProjectionPoint3[];
  textureCoordinates: number[];
  indices: number[];
  projective: boolean;
};

type QuadMapper = {
  pointAt: (u: number, v: number) => ProjectionPoint3;
  projective: boolean;
};

const EPSILON = 1e-10;

function finitePoint(point: ProjectionPoint3) {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function bilinearPoint(
  [topLeft, topRight, bottomLeft, bottomRight]: readonly ProjectionPoint3[],
  u: number,
  v: number,
): ProjectionPoint3 {
  const topWeight = 1 - v;
  const leftWeight = 1 - u;
  return {
    x: topLeft.x * leftWeight * topWeight
      + topRight.x * u * topWeight
      + bottomLeft.x * leftWeight * v
      + bottomRight.x * u * v,
    y: topLeft.y * leftWeight * topWeight
      + topRight.y * u * topWeight
      + bottomLeft.y * leftWeight * v
      + bottomRight.y * u * v,
    z: topLeft.z * leftWeight * topWeight
      + topRight.z * u * topWeight
      + bottomLeft.z * leftWeight * v
      + bottomRight.z * u * v,
  };
}

/**
 * Build a square-to-quadrilateral homography in a local Cartesian frame.
 *
 * A video projected by a pinhole camera onto a plane is projective, not
 * bilinear.  Interpolating only the four corner UVs therefore produces the
 * familiar two-triangle seam and severe stretching in an oblique footprint.
 */
export function createProjectiveQuadMapper(
  corners: readonly [ProjectionPoint3, ProjectionPoint3, ProjectionPoint3, ProjectionPoint3],
): QuadMapper {
  if (!corners.every(finitePoint)) throw new Error("Projection quad contains a non-finite coordinate");
  const [topLeft, topRight, bottomLeft, bottomRight] = corners;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const projectiveDelta = Math.max(Math.abs(dx3), Math.abs(dy3));
  const determinant = dx1 * dy2 - dx2 * dy1;

  if (projectiveDelta <= EPSILON || Math.abs(determinant) <= EPSILON) {
    return {
      pointAt: (u, v) => bilinearPoint(corners, u, v),
      projective: false,
    };
  }

  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  if (!Number.isFinite(g) || !Number.isFinite(h)) {
    return {
      pointAt: (u, v) => bilinearPoint(corners, u, v),
      projective: false,
    };
  }

  const a = {
    x: topRight.x - topLeft.x + g * topRight.x,
    y: topRight.y - topLeft.y + g * topRight.y,
    z: topRight.z - topLeft.z + g * topRight.z,
  };
  const b = {
    x: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    y: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    z: bottomLeft.z - topLeft.z + h * bottomLeft.z,
  };

  return {
    pointAt: (u, v) => {
      const denominator = g * u + h * v + 1;
      if (!Number.isFinite(denominator) || Math.abs(denominator) <= EPSILON) {
        return bilinearPoint(corners, u, v);
      }
      return {
        x: (a.x * u + b.x * v + topLeft.x) / denominator,
        y: (a.y * u + b.y * v + topLeft.y) / denominator,
        z: (a.z * u + b.z * v + topLeft.z) / denominator,
      };
    },
    projective: true,
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
  const indices: number[] = [];
  const stride = columns + 1;

  for (let row = 0; row <= rows; row += 1) {
    // Oblique aerial images change scale fastest near the far (top) edge.
    // Concentrating rows there removes most of the residual error of the
    // piecewise-linear WebGL triangles without materially increasing buffers.
    const v = Math.pow(row / rows, verticalSamplingExponent);
    const sourceV = sourceTopFraction + (1 - sourceTopFraction) * v;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      points.push(mapper.pointAt(u, v));
      // WebGL texture coordinates start at the bottom-left while video pixels
      // and the projection grid are enumerated from the top-left.
      textureCoordinates.push(u, 1 - sourceV);
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

  return { points, textureCoordinates, indices, projective: mapper.projective };
}
