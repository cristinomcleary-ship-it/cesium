import type { ImageryTypes } from "cesium";

const SAMPLE_SIZE = 32;
let sampleCanvas: HTMLCanvasElement | null = null;
let sampleContext: CanvasRenderingContext2D | null = null;

function samplingContext(): CanvasRenderingContext2D {
  if (!sampleCanvas || !sampleContext) {
    sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = SAMPLE_SIZE;
    sampleCanvas.height = SAMPLE_SIZE;
    sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleContext) throw new Error("Canvas 2D is unavailable");
  }
  return sampleContext;
}

function imageSize(image: ImageryTypes, fallbackWidth: number, fallbackHeight: number) {
  const value = image as ImageryTypes & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  return {
    width: value.naturalWidth || value.width || fallbackWidth,
    height: value.naturalHeight || value.height || fallbackHeight,
  };
}

function looksLikeUnavailableMapTile(image: ImageryTypes, fallbackWidth: number, fallbackHeight: number): boolean {
  try {
    const context = samplingContext();
    context.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { width, height } = imageSize(image, fallbackWidth, fallbackHeight);
    context.drawImage(image as CanvasImageSource, 0, 0, width, height, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const pixels = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    let grayscale = 0;
    let brightnessSum = 0;
    let brightnessSquareSum = 0;
    const buckets = new Uint16Array(16);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const brightness = (red + green + blue) / 3;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 10) grayscale += 1;
      brightnessSum += brightness;
      brightnessSquareSum += brightness * brightness;
      buckets[Math.min(15, Math.floor(brightness / 16))] += 1;
    }
    const count = pixels.length / 4;
    const mean = brightnessSum / count;
    const deviation = Math.sqrt(Math.max(0, brightnessSquareSum / count - mean * mean));
    const dominantRatio = Math.max(...buckets) / count;
    return grayscale / count > 0.96 && mean > 175 && mean < 235 && deviation < 28 && dominantRatio > 0.55;
  } catch {
    // A tainted/invalid canvas must not poison checks for all subsequent tiles.
    sampleCanvas = null;
    sampleContext = null;
    return false;
  }
}

/** Rejects Esri's successful HTTP placeholder so Cesium uses its own parent tile. */
export class UnavailableMapTileDiscardPolicy {
  isReady(): boolean { return true; }

  shouldDiscardImage(image: HTMLImageElement): boolean {
    return looksLikeUnavailableMapTile(image, image.naturalWidth || image.width || 256, image.naturalHeight || image.height || 256);
  }
}
