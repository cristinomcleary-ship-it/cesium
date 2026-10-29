import type { LoadedMachineryAsset } from './machinery/types';
import { canonicalBoomToSource, sourceBoomToCanonical, wrapMachineryAngle } from './machineryTelemetry';

/** Saved parameters retain their original source-axis convention; only the editor is adapted. */
export function machineryParameterForEditor(asset: LoadedMachineryAsset, key: string, stored: number, modelFrontAxisDeg = 0): number {
  return key === 'boom_rotation_deg' && asset.id === 'crane' ? sourceBoomToCanonical(asset, stored, modelFrontAxisDeg) : stored;
}
/** Avoid changing a previously saved angle through floating-point display round trips. */
export function machineryParameterFromEditor(asset: LoadedMachineryAsset, key: string, displayed: number, previousStored?: number, modelFrontAxisDeg = 0): number {
  if (key !== 'boom_rotation_deg' || asset.id !== 'crane') return displayed;
  if (!Number.isFinite(displayed) || displayed < 0 || displayed > 360) throw new RangeError('吊臂回转角必须为 0 至 360° 的有限数值');
  if (previousStored !== undefined) {
    const previousDisplayed = machineryParameterForEditor(asset, key, previousStored, modelFrontAxisDeg);
    const delta = wrapMachineryAngle(displayed - previousDisplayed + 180) - 180;
    if (Math.abs(delta) < 1e-9) return previousStored;
  }
  return canonicalBoomToSource(asset, displayed, modelFrontAxisDeg);
}
