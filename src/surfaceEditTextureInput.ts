import { SURFACE_EDIT_LIMITS } from './surfaceEditTypes';

export type SurfaceTextureSize = { width: number; height: number };
export function validateSurfaceTextureDimensions(size: SurfaceTextureSize): SurfaceTextureSize {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1
    || Math.max(size.width, size.height) > SURFACE_EDIT_LIMITS.imageDimension)
    throw new Error('贴图宽高须均不超过 2048 像素，请缩小后重新选择。');
  return size;
}

/** Read dimensions before invoking a browser decoder, including highly compressed oversized rasters. */
export function validateSurfaceTextureHeader(type: string, bytes: Uint8Array, size = bytes.byteLength): SurfaceTextureSize {
  if (!Number.isInteger(size) || size <= 0 || size > SURFACE_EDIT_LIMITS.imageBytes || bytes.byteLength !== size)
    throw new Error('贴图须大于 0 字节且不超过 2 MB。');
  const same = (at: number, values: readonly number[]) => values.every((value, i) => bytes[at + i] === value);
  const word = (at: number) => bytes[at] * 256 + bytes[at + 1];
  const dword = (at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false);
  const littleWord = (at: number) => bytes[at] + bytes[at + 1] * 256;
  const threeBytes = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
  let dimensions: SurfaceTextureSize | undefined;
  if (type === 'image/png' && bytes.length >= 24 && same(0, [137, 80, 78, 71, 13, 10, 26, 10]) && same(12, [73, 72, 68, 82])) {
    dimensions = { width: dword(16), height: dword(20) };
  } else if (type === 'image/jpeg' && same(0, [255, 216, 255])) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = word(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length >= 8) dimensions = { width: word(offset + 5), height: word(offset + 3) };
        break;
      }
      offset += length;
    }
  } else if (type === 'image/webp' && bytes.length >= 20 && same(0, [82, 73, 70, 70]) && same(8, [87, 69, 66, 80])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) break;
      if (same(offset, [86, 80, 56, 88]) && length >= 10) {
        if (bytes[data] & 2) throw new Error('地表贴图请使用静态图片，不支持动画 WebP。');
        dimensions = { width: threeBytes(data + 4) + 1, height: threeBytes(data + 7) + 1 }; break;
      }
      if (same(offset, [86, 80, 56, 32]) && length >= 10 && same(data + 3, [157, 1, 42])) {
        dimensions = { width: littleWord(data + 6) & 16383, height: littleWord(data + 8) & 16383 }; break;
      }
      if (same(offset, [86, 80, 56, 76]) && length >= 5 && bytes[data] === 47) {
        dimensions = { width: 1 + bytes[data + 1] + ((bytes[data + 2] & 63) << 8),
          height: 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 15) << 10) }; break;
      }
      offset = data + length + (length % 2);
    }
  }
  if (!dimensions) throw new Error('请选择内容有效的 PNG、JPEG 或 WebP 图片。');
  return validateSurfaceTextureDimensions(dimensions);
}
