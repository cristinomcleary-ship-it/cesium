/// <reference types="vite/client" />

declare const CESIUM_BASE_URL: string;

declare module "dxf-parser" {
  export default class DxfParser {
    parseSync(source: string): DxfDocument | null;
  }

  export interface DxfDocument {
    entities?: DxfEntity[];
    blocks?: Record<string, { entities?: DxfEntity[] }>;
  }

  export interface DxfEntity {
    type: string;
    layer?: string;
    color?: number;
    colorIndex?: number;
    vertices?: Array<{ x: number; y: number; z?: number; bulge?: number }>;
    position?: { x: number; y: number; z?: number };
    center?: { x: number; y: number; z?: number };
    radius?: number;
    startAngle?: number;
    endAngle?: number;
    text?: string;
    textHeight?: number;
    name?: string;
    xScale?: number;
    yScale?: number;
    zScale?: number;
    rotation?: number;
    shape?: boolean;
  }
}
