/// <reference lib="webworker" />
import { computeMachineryFallEnvelope } from './railSafetyGeometry';
import type { LoadedMachineryAsset } from './machinery/types';
import type { RailSafetyWorkerRequest, RailSafetyWorkerResponse } from './railSafetyComputation';

const assets = new Map<string, LoadedMachineryAsset>();
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<RailSafetyWorkerRequest>) => {
  const request = event.data;
  try {
    if (!request || request.type !== 'compute' || !Number.isSafeInteger(request.requestId) || typeof request.assetKey !== 'string') {
      throw new Error('倾覆几何计算请求无效');
    }
    if (request.asset) {
      if (`${request.asset.id}@${request.asset.version}` !== request.assetKey) throw new Error('机械资产缓存标识不匹配');
      if (!assets.has(request.assetKey)) assets.set(request.assetKey, request.asset);
    }
    const asset = assets.get(request.assetKey);
    if (!asset) throw new Error('计算线程缺少机械模型资产，请重新加载机械');
    const envelope = computeMachineryFallEnvelope(asset, request.metadata, request.support);
    const response: RailSafetyWorkerResponse = { type: 'result', requestId: request.requestId, envelope };
    scope.postMessage(response);
  } catch (error) {
    const response: RailSafetyWorkerResponse = { type: 'error', requestId: request?.requestId ?? -1, message: error instanceof Error ? error.message : String(error) };
    scope.postMessage(response);
  }
};
