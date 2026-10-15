import type { RailSafetyAreaDisplay } from './railSafetyDisplay';
import type { RailSafetyFallProjectionResult } from './railSafetyFallProjectionClient';

/** A single union mask prevents overlapping triangles from accumulating opacity. */
export function colorRailSafetyFallProjection(
  result: Pick<RailSafetyFallProjectionResult, 'width' | 'height' | 'mask'>,
  area: RailSafetyAreaDisplay,
  color: string,
): Uint8ClampedArray {
  const { width, height, mask } = result, rgba = new Uint8ClampedArray(width * height * 4);
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : 'ffae39';
  const rgb = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const radius = Math.max(1, Math.min(4, Math.ceil(area.lineWidth / 2)));
  const fillAlpha = Math.round(Math.min(1, Math.max(0, area.opacity)) * 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!mask[index]) continue;
    let boundary = false;
    for (let offset = 1; offset <= radius && !boundary; offset++) {
      boundary = x < offset || x + offset >= width || y < offset || y + offset >= height
        || !mask[index - offset] || !mask[index + offset]
        || !mask[index - offset * width] || !mask[index + offset * width];
    }
    const alpha = boundary ? 255 : area.style === 'fill' ? fillAlpha : 0;
    if (!alpha) continue;
    const pixel = index * 4;
    rgba[pixel] = rgb[0]; rgba[pixel + 1] = rgb[1]; rgba[pixel + 2] = rgb[2]; rgba[pixel + 3] = alpha;
  }
  return rgba;
}
