import { computeRailSafetyFallProjection, type PreparedRailSafetyFallProjection } from './railSafetyFallProjection';

let prepared: PreparedRailSafetyFallProjection | undefined;
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'prepare') { prepared = message.prepared; return; }
  if (message.type !== 'project') return;
  try {
    if (!prepared) throw new Error('机械投影尚未准备完成');
    const result = computeRailSafetyFallProjection(prepared, message.direction, message.angle);
    scope.postMessage({ id: message.id, result }, [result.mask.buffer]);
  } catch (error) {
    scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : '机械投影计算失败' });
  }
};
