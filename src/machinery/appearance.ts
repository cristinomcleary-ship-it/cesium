import type { LoadedMachineryAsset, MachineryModelId, Vec3 } from './types';

/** Display styling only. Source FBX colors, material boundaries and geometry stay immutable. */
export const MACHINERY_APPEARANCE_PROFILE = 'construction-vivid/v1';

type Swatch = readonly [source: readonly [number, number, number], displaySrgb: string];
// Match reviewed source numeric RGB, rather than assuming a material's array index.
// The source numeric values have no certified color-space metadata. Only these
// deliberately authored display colors are interpreted as sRGB and linearized.
const SWATCHES: Record<MachineryModelId, readonly Swatch[]> = {
  crane: [
    [[0.8, 0, 0], '#FF3C45'], [[0.06, 0.0388235, 0], '#FFD43B'],
    [[0.4470589, 0.4470589, 0.4470589], '#76838D'], [[0.7490196, 0.7490196, 0.7490196], '#B9C4CE'],
    [[0.7764708, 0.7764708, 0.7764708], '#CFD9E2'], [[0.3764707, 0.3764707, 0.3764707], '#707E89'],
    [[0, 0, 0], '#171D24'], [[0.3372549, 0.3372549, 0.3372549], '#596975'],
    [[0.6666667, 0.6666667, 0.6666667], '#A9B9C6'], [[0.7098039, 0.1686275, 0], '#F3343E'],
    [[0.6, 0, 0], '#C91629'], [[0.8, 0.2, 0], '#FF9432'],
    [[0.1176471, 0.1176471, 0.1176471], '#293540'], [[0.8, 1, 1], '#BCDDE9'],
    [[0.227451, 0.227451, 0.227451], '#405362'], [[0.2901961, 0.2901961, 0.2901961], '#52616D'],
    [[0.1647059, 0.1647059, 0.1647059], '#34414D'], [[0.07, 0.0452941, 0], '#FFC928'],
    [[0.4000001, 0.2196079, 0.1568628], '#B89475'], [[0.1372549, 0.1372549, 0.1372549], '#252D36'],
    [[0.2078432, 0.2078432, 0.2078432], '#3D4B57'],
  ],
  pile: [
    [[0.4000001, 0.3960785, 0.3882354], '#697580'], [[0.2901961, 0.2901961, 0.2901961], '#35434F'],
    [[0.3294118, 0.3294118, 0.3294118], '#465663'], [[0.7098039, 0.1686275, 0], '#F3343E'],
    [[0.7529414, 0.7529414, 0.7529414], '#CFD9E2'], [[0.4470589, 0.4470589, 0.4470589], '#80929E'],
    [[0.372549, 0.3686275, 0.3764707], '#647383'], [[0, 0.2, 0.2], '#16ADB2'],
  ],
  excavator: [
    [[0.7098039, 0.4196079, 0.1568628], '#FFC52B'], [[1, 0.6666667, 0.1764706], '#FFD541'],
    [[0.3764706, 0.3764706, 0.3764706], '#788997'], [[0.4313726, 0.1019608, 0.1019608], '#E85531'],
    [[0.3137255, 0.3019608, 0.3019608], '#343E49'], [[0.3960785, 0.3960785, 0.3960785], '#677785'],
    [[0.3568628, 0.5215687, 0.7882354], '#659CCE'], [[0.8196079, 0.6117647, 0.2156863], '#F4AC19'],
    [[1, 0.3098039, 0.3098039], '#FF5047'], [[0.4352942, 0.4352942, 0.4352942], '#81909D'],
    [[0.6313726, 0.4235294, 0.2392157], '#E2A552'], [[0.0078431, 0.2745098, 0.4784314], '#267DAB'],
    [[1, 1, 1], '#EEF4F8'], [[0.3647059, 0.3529412, 0.3529412], '#414C59'],
  ],
};

const CRANE_PAINT: Vec3 = [0.7098039, 0.1686275, 0];
const CRANE_EXTENSION_SRGB = '#303B48';
const CRANE_OUTRIGGER_SRGB = '#FFD43B';
function matches(palette: Float32Array, offset: number, rgb: readonly number[]): boolean {
  return rgb.every((value, axis) => Math.abs(palette[offset + axis] - value) < 1e-5);
}

/** glTF COLOR_0 is linear RGB; display hex literals must not be written directly. */
function linearRgb(hex: string): Vec3 {
  return [1, 3, 5].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Vec3;
}

export function createMachineryAppearance(asset: LoadedMachineryAsset) {
  // Copies are deliberate: repeated export, reset, deformation and other callers
  // must still see the exact original arrays verified by the asset hashes.
  const palette = Array.from(asset.palette), faceColorIndices = asset.faceColorIndices.slice();
  let matchedSourceColors = 0, paintIndex = -1;
  for (let offset = 0; offset < asset.palette.length; offset += 3) {
    const swatch = SWATCHES[asset.id].find(([source]) => matches(asset.palette, offset, source));
    if (swatch) { palette.splice(offset, 3, ...linearRgb(swatch[1])); matchedSourceColors++; }
    if (matches(asset.palette, offset, CRANE_PAINT)) paintIndex = offset / 3;
  }
  if (asset.id === 'crane' && paintIndex >= 0) {
    const extensionColor = palette.length / 3; palette.push(...linearRgb(CRANE_EXTENSION_SRGB));
    const outriggerColor = palette.length / 3; palette.push(...linearRgb(CRANE_OUTRIGGER_SRGB));
    for (let face = 0; face < faceColorIndices.length; face++) {
      if (faceColorIndices[face] !== paintIndex) continue;
      const offset = face * 3, a = asset.partIds[asset.indices[offset]];
      // Override only whole reviewed parts; leave mixed-part faces and source
      // metal, glass, lamps and hoses on their own original material boundaries.
      if (a !== asset.partIds[asset.indices[offset + 1]] || a !== asset.partIds[asset.indices[offset + 2]]) continue;
      if (a === 1) faceColorIndices[face] = extensionColor;
      else if ((a >= 10 && a <= 13) || (a >= 20 && a <= 23)) faceColorIndices[face] = outriggerColor;
    }
  }
  return {
    palette: new Float32Array(palette), faceColorIndices,
    metadata: {
      profile: MACHINERY_APPEARANCE_PROFILE,
      inputColorSpace: 'sRGB display swatches', vertexColorSpace: 'linear RGB',
      sourceMaterialBoundaries: 'preserved; reviewed crane extension and outrigger paint regions contrasted',
      matchedSourceColors, sourcePaletteSize: asset.palette.length / 3,
      sourceArraysModified: false, texturesRestored: false,
      description: 'Enhanced construction paint colors; original source RGB remains in immutable assets; no texture or V-Ray shader baking',
    },
  };
}
