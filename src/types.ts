import type { BoundingSphere } from "cesium";

export type ImportRecord = {
  id: string;
  name: string;
  kind: "CAD" | "3D Tiles" | "GIS" | "Model" | "Drone Video";
  resource: unknown;
  visible: boolean;
  adjustable?: boolean;
  representation?: "dataSource" | "primitive";
  boundingSphere?: BoundingSphere;
};

export type CadCoordinateOptions =
  | {
      mode: "crs";
      sourceCrs: string;
      heightOffset: number;
    }
  | {
      mode: "gaussKruger";
      centralMeridian: number;
      ellipsoid: "GRS80" | "WGS84" | "IAU76" | "krass";
      axisOrder: "eastNorth" | "northEast";
      hasZonePrefix: boolean;
      zoneNumber: number;
      heightOffset: number;
    }
  | {
      mode: "local";
      longitude: number;
      latitude: number;
      altitude: number;
      referenceX: number;
      referenceY: number;
      rotation: number;
      scale: number;
    };

export type TilesetOptions = {
  longitudeOffset: number;
  latitudeOffset: number;
  heightOffset: number;
  maximumScreenSpaceError: number;
};

export type CadDisplayMode = "absolute" | "terrain" | "model";
