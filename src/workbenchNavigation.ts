export type WorkbenchNavigationState = {
  modelBusy: boolean;
  markupPicking: boolean;
  pitPicking: boolean;
  closeTemporaryWorks: () => boolean;
  notify: (message: string) => void;
};

/** Check active gestures before any DOM switch or asynchronous workspace opening. */
export function prepareWorkbenchLeave(target: string | undefined, state: WorkbenchNavigationState): boolean {
  if (target !== 'models' && state.modelBusy) {
    state.notify('请先完成或取消当前模型放置，保存完成后再切换功能。'); return false;
  }
  if (target !== 'markup' && state.markupPicking) {
    state.notify('请先完成或取消当前标绘、重绘或贴图，再切换功能。'); return false;
  }
  if (target !== 'monitoring' && state.pitPicking) {
    state.notify('请先结束基坑取点或支撑绘制，再切换功能。'); return false;
  }
  return target === 'temporary-works' || state.closeTemporaryWorks();
}
