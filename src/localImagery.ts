import {
  Credit,
  Event as CesiumEvent,
  ImageryProvider,
  Rectangle,
  SingleTileImageryProvider,
  WebMercatorTilingScheme,
  type ImageryLayerFeatureInfo,
  type ImageryTypes,
  type Request,
} from "cesium";
import { fromBlob } from "geotiff";
import proj4 from "proj4";
import initSqlJs, { type Database } from "sql.js";

export type LocalImageryResult = {
  provider: ImageryProvider;
  name: string;
  rectangle: Rectangle;
  dispose: () => void;
  details: string;
};

export type ImageBounds = { west: number; south: number; east: number; north: number };

function validateBounds(bounds: ImageBounds) {
  if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) throw new Error("请填写完整的影像四至范围");
  if (bounds.west < -180 || bounds.east > 180 || bounds.south < -90 || bounds.north > 90) throw new Error("影像范围超出有效经纬度");
  if (bounds.west >= bounds.east || bounds.south >= bounds.north) throw new Error("影像范围必须满足西<东、南<北");
}

function rectangleFromBounds(bounds: ImageBounds): Rectangle {
  validateBounds(bounds);
  return Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成影像预览")), "image/png"));
}

async function geotiffPng(file: File): Promise<{ blob: Blob; bounds: ImageBounds; width: number; height: number }> {
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const geoKeys = image.getGeoKeys() ?? {};
  const rawBounds = image.getBoundingBox();
  let bounds: ImageBounds;
  const geographicCode = Number(geoKeys.GeographicTypeGeoKey);
  const projectedCode = Number(geoKeys.ProjectedCSTypeGeoKey);
  if (geographicCode === 4326 || (!projectedCode && rawBounds.every((value, index) => Math.abs(value) <= (index % 2 === 0 ? 180 : 90)))) {
    bounds = { west: rawBounds[0], south: rawBounds[1], east: rawBounds[2], north: rawBounds[3] };
  } else if (projectedCode === 3857) {
    const [west, south] = proj4("EPSG:3857", "EPSG:4326", [rawBounds[0], rawBounds[1]]);
    const [east, north] = proj4("EPSG:3857", "EPSG:4326", [rawBounds[2], rawBounds[3]]);
    bounds = { west, south, east, north };
  } else {
    throw new Error(`GeoTIFF 使用了暂不支持的投影坐标系${projectedCode ? ` EPSG:${projectedCode}` : ""}；请转换为 WGS84 或 Web Mercator`);
  }
  validateBounds(bounds);

  const sourceWidth = image.getWidth();
  const sourceHeight = image.getHeight();
  const scale = Math.min(1, 8192 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const rgb = await image.readRGB({ width, height, interleave: true });
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
  return { blob: await canvasBlob(canvas), bounds, width, height };
}

async function singleImage(file: File, suppliedBounds: ImageBounds): Promise<LocalImageryResult> {
  let blob: Blob = file;
  let bounds = suppliedBounds;
  let details = "单张本地影像";
  if (/\.tiff?$/i.test(file.name)) {
    const converted = await geotiffPng(file);
    blob = converted.blob;
    bounds = converted.bounds;
    details = `GeoTIFF · ${converted.width}×${converted.height} · 已自动读取范围`;
  }
  const rectangle = rectangleFromBounds(bounds);
  const url = URL.createObjectURL(blob);
  try {
    const provider = await SingleTileImageryProvider.fromUrl(url, { rectangle, credit: `本地影像：${file.name}` });
    let disposed = false;
    return {
      provider: provider as ImageryProvider,
      name: file.name,
      rectangle,
      details,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
function sqlEngine() {
  sqlPromise ??= initSqlJs({ locateFile: () => "/sqljs/sql-wasm.wasm" });
  return sqlPromise;
}

function scalar(db: Database, sql: string): string | number | Uint8Array | null {
  const result = db.exec(sql);
  return result[0]?.values[0]?.[0] ?? null;
}

function metadata(db: Database): Record<string, string> {
  const rows = db.exec("SELECT name, value FROM metadata")[0]?.values ?? [];
  return Object.fromEntries(rows.map((row) => [String(row[0]), String(row[1])]));
}

function emptyTile(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas;
}

class MbTilesImageryProvider {
  readonly tileWidth = 256;
  readonly tileHeight = 256;
  readonly minimumLevel: number;
  readonly maximumLevel: number;
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle: Rectangle;
  readonly tileDiscardPolicy = undefined as never;
  readonly errorEvent = new CesiumEvent();
  readonly credit: Credit;
  readonly proxy = undefined as never;
  readonly hasAlphaChannel = true;
  private disposed = false;

  constructor(private readonly db: Database, info: Record<string, string>, minimumLevel: number, maximumLevel: number) {
    this.minimumLevel = minimumLevel;
    this.maximumLevel = maximumLevel;
    this.credit = new Credit(info.attribution || info.name || "本地 MBTiles");
    const values = info.bounds?.split(",").map(Number);
    this.rectangle = values?.length === 4 && values.every(Number.isFinite) ? Rectangle.fromDegrees(values[0], values[1], values[2], values[3]) : this.tilingScheme.rectangle;
  }

  getTileCredits(): Credit[] { return [this.credit]; }

  async requestImage(x: number, y: number, level: number, _request?: Request): Promise<ImageryTypes> {
    if (this.disposed) return emptyTile();
    const tmsY = (2 ** level) - 1 - y;
    const statement = this.db.prepare("SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1");
    let data: Uint8Array | null = null;
    try {
      statement.bind([level, x, tmsY]);
      if (!statement.step()) return emptyTile();
      const value = statement.get()[0];
      if (value instanceof Uint8Array) data = value.slice();
    } finally { statement.free(); }
    if (!data || this.disposed) return emptyTile();
    return await createImageBitmap(new Blob([data as BlobPart]));
  }

  pickFeatures(_x: number, _y: number, _level: number, _longitude: number, _latitude: number): Promise<ImageryLayerFeatureInfo[]> | undefined { return undefined; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.db.close();
  }
}

async function mbtiles(file: File): Promise<LocalImageryResult> {
  const SQL = await sqlEngine();
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tiles','metadata')")[0]?.values.flat().map(String) ?? [];
    if (!tables.includes("tiles") || !tables.includes("metadata")) throw new Error("文件不是有效的 MBTiles：缺少 tiles 或 metadata 表");
    const info = metadata(db);
    if ((info.format || "").toLowerCase().includes("pbf")) throw new Error("当前只支持 PNG/JPG/WEBP 栅格 MBTiles，不支持 PBF 矢量瓦片");
    const minimumLevel = Number(scalar(db, "SELECT MIN(zoom_level) FROM tiles"));
    const maximumLevel = Number(scalar(db, "SELECT MAX(zoom_level) FROM tiles"));
    if (!Number.isFinite(minimumLevel) || !Number.isFinite(maximumLevel)) throw new Error("MBTiles 中没有影像瓦片");
    const provider = new MbTilesImageryProvider(db, info, minimumLevel, maximumLevel);
    return {
      provider: provider as unknown as ImageryProvider,
      name: file.name,
      rectangle: provider.rectangle,
      details: `MBTiles · ${info.format || "栅格"} · 层级 ${minimumLevel}–${maximumLevel}`,
      dispose: () => provider.dispose(),
    };
  } catch (error) { db.close(); throw error; }
}

export async function loadLocalImagery(file: File, bounds: ImageBounds): Promise<LocalImageryResult> {
  if (/\.mbtiles$/i.test(file.name)) return mbtiles(file);
  if (/\.(png|jpe?g|webp|tiff?)$/i.test(file.name)) return singleImage(file, bounds);
  throw new Error("请选择 PNG、JPG、WEBP、GeoTIFF 或 MBTiles 文件");
}
