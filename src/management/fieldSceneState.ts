import type { ManagementFieldMachinery } from '../managementSceneTypes.ts';
import type { RailSafetyMachineResult } from '../railSafetyScene.ts';

type FieldResult = RailSafetyMachineResult & { preparationReason?: string };
type RiskState = Pick<ManagementFieldMachinery, 'risk' | 'riskLabel' | 'riskMessage' | 'intersectionCount' | 'draft'>;

/** Headlines describe committed geometry only; pending/draft/partial results never become a green zero. */
export function fieldMachineRisk(result: FieldResult | undefined, pending: boolean, placed: boolean): RiskState {
  const base = { draft: result?.draft };
  if (!placed) return { ...base, risk: 'unknown', riskLabel: '待布置', riskMessage: '尚未设置有效机械模型与位置' };
  if (pending) return { ...base, risk: 'unknown', riskLabel: '计算中', riskMessage: '正在按当前机械及限界版本重新计算' };
  if (result?.draft) return { ...base, risk: 'unknown', riskLabel: '草稿待保存', riskMessage: '当前是未保存的布置预览；保存后再核对筛查结果' };
  if (!result || result.preparationReason || result.status === 'unknown') return {
    ...base, risk: 'unknown', riskLabel: '待核实', riskMessage: result?.preparationReason || result?.message || '尚无有效筛查结果，请核对参数和限界',
  };
  const intersectionCount = result.limits.filter(limit => limit.status === 'overlap' || limit.status === 'touching').length;
  if ((result.status === 'overlap' || result.status === 'touching') && intersectionCount > 0) return {
    ...base, risk: 'crossing', riskLabel: result.label, riskMessage: result.message, intersectionCount,
  };
  if (result.status === 'clear' && result.limits.length > 0 && result.limits.every(limit => limit.status === 'clear')) return {
    ...base, risk: 'clear', riskLabel: result.label, riskMessage: result.message, intersectionCount: 0,
  };
  return { ...base, risk: 'unknown', riskLabel: '待核实', riskMessage: '部分限界尚未取得有效结果，请等待计算或核对配置' };
}
