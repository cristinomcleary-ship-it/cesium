import type { MachineryModelId, MachineryModelType } from './types';

export { MACHINERY_ASSET_VERSION } from '../machineryTypes';
export const MACHINERY_CATALOG: readonly Readonly<{ id: MachineryModelId; name: string; type: MachineryModelType }>[] = [
  { id: 'crane', name: '吊机', type: 'crane' },
  { id: 'pile', name: '桩机', type: 'pile_rig' },
  { id: 'excavator', name: '挖机', type: 'excavator' },
];
