export interface ProjectionRasterOptions {
  /** Maximum image dimension, including padding; clamped to 32–768 pixels. */
  maxPixels?: number;
  minCellSizeMeters?: number;
}

export interface ProjectedTriangleRaster {
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  width: number;
  height: number;
  /** North-up, row-major union of the projected triangles. Values are 0 or 1. */
  mask: Uint8Array;
  cellSizeMeters: number;
  /** Occupied-cell area, including conservative boundary cells; not exact mesh area. */
  areaMeters2: number;
}

/**
 * Conservatively rasterize a triangle mesh already projected into local ENU metres.
 * A cell is occupied whenever any triangle touches its closed square, including
 * zero-area triangles. Separate parts, concavities and holes remain separate at
 * the selected resolution. This is a display raster, not an exact intersection
 * polygon or a substitute for the safety screening geometry.
 */
export function rasterizeProjectedTriangles(
  positionsXY: Float64Array,
  indices: Uint32Array,
  options: ProjectionRasterOptions = {},
): ProjectedTriangleRaster {
  if (!(positionsXY instanceof Float64Array) || !(indices instanceof Uint32Array)) {
    throw new TypeError('Projected mesh requires Float64Array positions and Uint32Array indices.');
  }
  if (positionsXY.length % 2 || indices.length % 3) {
    throw new RangeError('Projected mesh requires complete XY pairs and triangle index triples.');
  }
  const requestedPixels = options.maxPixels ?? 384;
  const minCellSize = options.minCellSizeMeters ?? 0.1;
  if (!Number.isFinite(requestedPixels)) throw new RangeError('maxPixels must be finite.');
  if (!Number.isFinite(minCellSize) || minCellSize <= 0) {
    throw new RangeError('minCellSizeMeters must be finite and positive.');
  }
  const maxPixels = Math.min(768, Math.max(32, Math.floor(requestedPixels)));
  for (let i = 0; i < positionsXY.length; i++) {
    if (!Number.isFinite(positionsXY[i])) throw new RangeError('Projected coordinates must be finite.');
  }
  const vertexCount = positionsXY.length / 2;
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (index >= vertexCount) throw new RangeError('Projected triangle index is out of bounds.');
    const x = positionsXY[index * 2], y = positionsXY[index * 2 + 1];
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  if (!indices.length) {
    return { bounds: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }, width: 0, height: 0,
      mask: new Uint8Array(0), cellSizeMeters: minCellSize, areaMeters2: 0 };
  }
  const xSpan = xMax - xMin, ySpan = yMax - yMin;
  const cellSizeMeters = Math.max(minCellSize, Math.max(xSpan, ySpan) / (maxPixels - 2));
  if (!Number.isFinite(cellSizeMeters)) throw new RangeError('Projected coordinate extent is too large.');
  // The cap avoids a rounding-only extra pixel for the longest dimension.
  const width = Math.min(maxPixels, Math.max(1, Math.ceil(xSpan / cellSizeMeters)) + 2);
  const height = Math.min(maxPixels, Math.max(1, Math.ceil(ySpan / cellSizeMeters)) + 2);
  // Centre any fractional spare cell so both sides have at least one cell margin.
  const west = xMin - (width * cellSizeMeters - xSpan) / 2;
  const south = yMin - (height * cellSizeMeters - ySpan) / 2;
  const east = west + width * cellSizeMeters, north = south + height * cellSizeMeters;
  if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) {
    throw new RangeError('Projected coordinates cannot be represented at the selected cell size.');
  }
  const mask = new Uint8Array(width * height);
  // Pixel-space tolerance only protects floating point contact; it is not a
  // model-space buffer. Clipping edges to each row strip avoids triangle-size
  // allocations and visits thin diagonal surfaces without sampling their centres.
  const epsilon = 1e-9;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const ia = indices[triangle] * 2, ib = indices[triangle + 1] * 2, ic = indices[triangle + 2] * 2;
    const ax = (positionsXY[ia] - west) / cellSizeMeters, ay = (north - positionsXY[ia + 1]) / cellSizeMeters;
    const bx = (positionsXY[ib] - west) / cellSizeMeters, by = (north - positionsXY[ib + 1]) / cellSizeMeters;
    const cx = (positionsXY[ic] - west) / cellSizeMeters, cy = (north - positionsXY[ic + 1]) / cellSizeMeters;
    const firstRow = Math.max(0, Math.ceil(Math.min(ay, by, cy) - epsilon) - 1);
    const lastRow = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) + epsilon));
    for (let row = firstRow; row <= lastRow; row++) {
      let left = Infinity, right = -Infinity;
      const lower = row - epsilon, upper = row + 1 + epsilon;
      for (let edge = 0; edge < 3; edge++) {
        const x0 = edge === 0 ? ax : edge === 1 ? bx : cx;
        const y0 = edge === 0 ? ay : edge === 1 ? by : cy;
        const x1 = edge === 0 ? bx : edge === 1 ? cx : ax;
        const y1 = edge === 0 ? by : edge === 1 ? cy : ay;
        const dy = y1 - y0;
        if (dy === 0) {
          if (y0 >= lower && y0 <= upper) {
            left = Math.min(left, x0, x1); right = Math.max(right, x0, x1);
          }
        } else {
          const t0 = (lower - y0) / dy, t1 = (upper - y0) / dy;
          const start = Math.max(0, Math.min(t0, t1));
          const end = Math.min(1, Math.max(t0, t1));
          if (start <= end) {
            const dx = x1 - x0, startX = x0 + start * dx, endX = x0 + end * dx;
            left = Math.min(left, startX, endX); right = Math.max(right, startX, endX);
          }
        }
      }
      if (left > right) continue;
      const firstColumn = Math.max(0, Math.ceil(left - epsilon) - 1);
      const lastColumn = Math.min(width - 1, Math.floor(right + epsilon));
      mask.fill(1, row * width + firstColumn, row * width + lastColumn + 1);
    }
  }
  let occupied = 0;
  for (let i = 0; i < mask.length; i++) occupied += mask[i];
  return { bounds: { xMin: west, yMin: south, xMax: east, yMax: north }, width, height, mask,
    cellSizeMeters, areaMeters2: occupied * cellSizeMeters ** 2 };
}
