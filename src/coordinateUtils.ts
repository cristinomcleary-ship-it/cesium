import proj4 from "proj4";

export type GaussEllipsoid = "GRS80" | "WGS84" | "IAU76" | "krass";
export type GaussAxisOrder = "eastNorth" | "northEast";

export type GaussKrugerDefinition = {
  centralMeridian: number;
  ellipsoid: GaussEllipsoid;
  axisOrder: GaussAxisOrder;
  hasZonePrefix: boolean;
  zoneNumber: number;
};

/** Accepts decimal degrees or DMS such as 120°47′30″ / 120 47 30 / 120:47:30. */
export function parseLongitude(input: string): number {
  const raw = input.trim().toUpperCase();
  const west = /[西W]/.test(raw);
  const normalized = raw.replace(/[东西EW]/g, "").replace(/^\+/, "");
  if (!normalized) throw new Error("请输入中央子午线经度");
  const numericValue = Number(normalized);
  const simple = west ? -Math.abs(numericValue) : numericValue;
  if (Number.isFinite(simple)) {
    if (simple < -180 || simple > 180) throw new Error("中央子午线经度应在 -180° 到 180° 之间");
    return simple;
  }
  const negative = normalized.startsWith("-") || west;
  const parts = normalized.replace(/^[-+]/, "").split(/[^0-9.]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) throw new Error("中央子午线格式无法识别，请输入十进制度或度分秒");
  const [degrees, minutes = 0, seconds = 0] = parts;
  if (minutes >= 60 || seconds >= 60) throw new Error("中央子午线的分、秒必须小于 60");
  const value = (negative ? -1 : 1) * (degrees + minutes / 60 + seconds / 3600);
  if (value < -180 || value > 180) throw new Error("中央子午线经度应在 -180° 到 180° 之间");
  return value;
}

export function inferredZoneNumber(centralMeridian: number, width: 3 | 6): number {
  return width === 3 ? Math.round(centralMeridian / 3) : Math.round((centralMeridian + 3) / 6);
}

export function createGaussKrugerToWgs84Converter(definition: GaussKrugerDefinition) {
  const ellipsoids: Record<GaussEllipsoid, string> = {
    GRS80: "+ellps=GRS80",
    WGS84: "+ellps=WGS84",
    IAU76: "+a=6378140 +rf=298.257",
    krass: "+ellps=krass",
  };
  const projection = `+proj=tmerc +lat_0=0 +lon_0=${definition.centralMeridian} +k=1 +x_0=500000 +y_0=0 ${ellipsoids[definition.ellipsoid]} +units=m +no_defs +type=crs`;
  const converter = proj4(projection, "EPSG:4326");
  return (x: number, y: number): [number, number] => {
    let easting = definition.axisOrder === "eastNorth" ? x : y;
    const northing = definition.axisOrder === "eastNorth" ? y : x;
    if (definition.hasZonePrefix) easting -= definition.zoneNumber * 1_000_000;
    return converter.forward([easting, northing]) as [number, number];
  };
}

export function gaussKrugerToWgs84(x: number, y: number, definition: GaussKrugerDefinition): [number, number] {
  return createGaussKrugerToWgs84Converter(definition)(x, y);
}
