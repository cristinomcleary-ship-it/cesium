import { createScenePresentation } from './scene-presentation.js';
import { createWorldEffects } from './effects.js';

// One owned installation per existing Viewer, including an installation in progress.
const installations = new WeakMap();
const ACTIONS = ['showcase', 'reality', 'home', 'pauseEffects', 'resumeEffects'];
const errorText = error => String(error?.message || error);

/**
 * Wire the presentation modules into an EXISTING project page. Does not create a
 * Viewer, load a tileset, seed objects, read demo assets, or write a business store.
 *
 * Required: { Cesium, viewer, tilesets, displayEnvelope } — the same explicit inputs
 * as createScenePresentation. tilesets contains loaded {id, tileset, contentType:'model'}.
 * Optional: buttons:{showcase?,reality?,home?,pauseEffects?,resumeEffects?} DOM references;
 * subscribe(handler) => unsubscribe for host events; onStatus(status); home camera options;
 * effects initial options from effects.js, empty by default.
 * Advanced options must identify their existing configurationSource. Replacing an
 * existing material additionally requires allowMaterialReplacement:true and a reason.
 * No property is enabled merely to make a capability/ownership error disappear.
 *
 * Returns Promise<{ok,status,controller?,reused?}>. Repeating an identical installation
 * reuses the existing controller/listeners. For different input or button bindings,
 * explicitly destroy the old controller, then install the new configuration.
 */
export async function installPresentation(options = {}) {
  const notifyFailure = (code, message, details) => {
    const status = { ok: false, state: 'not-installed', code, message, ...details };
    try { options.onStatus?.(status); } catch (error) { status.hostStatusCallbackError = errorText(error); }
    return { ok: false, status };
  };
  const { Cesium: C, viewer, tilesets, displayEnvelope, buttons = {}, subscribe,
    advanced = {}, home = {} } = options;
  if (!C || !viewer?.scene || viewer.isDestroyed?.()) {
    return notifyFailure('VIEWER_REQUIRED', '请传入项目当前使用的 Cesium 和已存在的 Viewer。');
  }
  if (options.onStatus !== undefined && typeof options.onStatus !== 'function') {
    return notifyFailure('STATUS_CALLBACK_INVALID', 'onStatus 必须是函数。');
  }
  if (subscribe !== undefined && typeof subscribe !== 'function') {
    return notifyFailure('SUBSCRIBE_INVALID', 'subscribe 必须接收事件处理函数，并返回解除订阅函数。');
  }
  if (!buttons || typeof buttons !== 'object' || Array.isArray(buttons) ||
      Object.keys(buttons).some(name => !ACTIONS.includes(name)) ||
      Object.values(buttons).some(button => button != null &&
        (typeof button.addEventListener !== 'function' || typeof button.removeEventListener !== 'function'))) {
    return notifyFailure('BUTTON_REFS_INVALID', 'buttons 只接受展示、实景、总览和动效按钮的实际 DOM 引用。');
  }
  const advancedKeys = ['configurationSource', 'allowMaterialReplacement', 'materialReplacementReason', 'ellipsoid'];
  if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced) ||
      Object.keys(advanced).some(key => !advancedKeys.includes(key))) {
    return notifyFailure('ADVANCED_OPTIONS_INVALID', '高级参数包含未知字段；请按接线层约定传入。');
  }
  if (Object.keys(advanced).length && (typeof advanced.configurationSource !== 'string' || !advanced.configurationSource.trim())) {
    return notifyFailure('CONFIGURATION_SOURCE_REQUIRED', '高级参数必须注明来自哪个既有项目配置。');
  }
  if (advanced.allowMaterialReplacement !== undefined && typeof advanced.allowMaterialReplacement !== 'boolean') {
    return notifyFailure('MATERIAL_REPLACEMENT_FLAG_INVALID', 'allowMaterialReplacement 必须显式使用布尔值，默认 false。');
  }
  if (advanced.allowMaterialReplacement === true &&
      (typeof advanced.materialReplacementReason !== 'string' || !advanced.materialReplacementReason.trim())) {
    return notifyFailure('MATERIAL_REPLACEMENT_REASON_REQUIRED', '替换已有材质前必须说明已有材质由谁管理以及为何允许替换。');
  }
  let signature;
  try {
    signature = JSON.stringify({
      envelope: displayEnvelope && { id: displayEnvelope.id, heightSource: displayEnvelope.heightSource,
        baseDepthMeters: displayEnvelope.baseDepthMeters,
        positions: displayEnvelope.positions?.map(p => [p?.x, p?.y, p?.z]),
        clippingPositions: displayEnvelope.clippingPositions?.map(p => [p?.x, p?.y, p?.z]) },
      home, homeOnInstall: options.homeOnInstall !== false, allowMaterialReplacement: advanced.allowMaterialReplacement === true,
      configurationSource: advanced.configurationSource, materialReplacementReason: advanced.materialReplacementReason,
      effects: options.effects
    });
  } catch (error) {
    return notifyFailure('CONFIGURATION_INVALID', `显示配置无法读取：${errorText(error)}`);
  }
  const prior = installations.get(viewer);
  if (prior) {
    const same = prior.C === C && prior.signature === signature && prior.subscribe === subscribe && prior.onStatus === options.onStatus &&
      prior.ellipsoid === advanced.ellipsoid && Array.isArray(tilesets) &&
      prior.tilesets.length === tilesets.length && prior.tilesets.every((item, i) =>
        item.id === tilesets[i]?.id && item.tileset === tilesets[i]?.tileset && item.contentType === tilesets[i]?.contentType) &&
      ACTIONS.every(name => prior.buttons[name] === buttons[name]);
    if (!same) return notifyFailure('INSTALLATION_EXISTS',
      '这个 Viewer 已有不同的展示配置或按钮绑定。请先调用原控制器 destroy()，再安装新配置。');
    const result = await prior.promise;
    return { ...result, status: result.ok ? result.controller.getStatus() : result.status, reused: result.ok };
  }
  if (!Array.isArray(tilesets) || !tilesets.length) {
    return notifyFailure('LOADED_TILESETS_REQUIRED', '请从项目现有模型管理器传入已加载的模型实例及明确的 model 类型。');
  }
  const record = { C, signature, tilesets: tilesets.map(item => ({ ...item })),
    buttons: { ...buttons }, subscribe, onStatus: options.onStatus, ellipsoid: advanced.ellipsoid };
  installations.set(viewer, record);
  // Defer initialization one microtask, so re-entrant/concurrent installation sees its Promise.
  record.promise = Promise.resolve().then(() => connect(options, record)).then(result => {
    if (!result.ok && installations.get(viewer) === record) installations.delete(viewer);
    return result;
  });
  return record.promise;
}

async function connect(options, record) {
  const { Cesium: C, viewer, buttons = {}, subscribe, onStatus = () => {}, home = {}, advanced = {} } = options;
  const removers = [];
  let engine, effects, destroyed = false, installed = false, lastEngineStatus;
  let effectsPaused = !!options.effects?.paused, reducedMotion = !!options.effects?.reducedMotion;
  let lastStatus = { ok: true, state: 'installing', message: '正在接入现有三维场景。' };
  const publish = status => {
    lastStatus = { ...status };
    try { onStatus(lastStatus); } catch (error) { lastStatus.hostStatusCallbackError = errorText(error); }
    return lastStatus;
  };
  const engineStatus = status => {
    lastEngineStatus = status;
    if (!destroyed) publish({ ...status, state: installed ? status.state : 'installing', engineStatus: status });
  };
  const ensureAlive = () => {
    if (destroyed || viewer.isDestroyed?.()) throw new Error('展示接线层或现有 Viewer 已销毁。');
  };
  const getEffects = () => {
    ensureAlive();
    if (!effects) effects = createWorldEffects(C, viewer, { paused: effectsPaused, reducedMotion, externalClock: !!options.effects?.externalClock });
    return effects;
  };
  const failure = (code, error) => publish({ ok: false, state: destroyed ? 'destroyed' : 'error',
    code, message: errorText(error), engineStatus: lastEngineStatus });
  function destroy() {
    if (destroyed) return lastStatus;
    destroyed = true;
    installed = false;
    const cleanupErrors = [];
    for (const remove of removers.splice(0).reverse()) {
      try { remove(); } catch (error) { cleanupErrors.push(errorText(error)); }
    }
    try { effects?.dispose(); } catch (error) { cleanupErrors.push(errorText(error)); }
    let engineCleanup;
    try {
      engineCleanup = engine?.destroy();
      if (engineCleanup?.restoreConflicts?.length) {
        cleanupErrors.push('展示安装期间有其他功能修改了同一场景属性；冲突项已保留供宿主处理。');
      }
    } catch (error) { cleanupErrors.push(errorText(error)); }
    if (installations.get(viewer) === record) installations.delete(viewer);
    return publish({ ok: cleanupErrors.length === 0, state: 'destroyed', cleanupErrors, engineStatus: engineCleanup,
      message: '已解除本层事件绑定并释放本层展示资源；现有 Viewer 由原项目继续管理。' });
  }
  function setMode(mode) {
    try {
      ensureAlive();
      // Manual appearance switches intentionally do not call home or any camera method.
      const status = engine.setMode(mode);
      return status.ok ? status : publish({ ...status, state: status.state || 'error',
        message: status.message || '外观切换未完成，请检查模式参数和场景所有权冲突。' });
    } catch (error) { return failure('MODE_CHANGE_FAILED', error); }
  }
  function returnHome(override = {}) {
    try {
      ensureAlive();
      const appearance = engine.setMode('showcase');
      if (!appearance.ok) return appearance;
      const camera = engine.home({ ...home, ...override });
      if (!camera.ok) return publish({ ok: false, state: 'error', code: camera.code || 'HOME_FAILED',
        message: '展示外观已应用，但总览取景参数无效；请检查项目的相机与面板留白配置。', engineStatus: engine.getStatus(), camera });
      return publish({ ...engine.getStatus(), camera, action: 'home' });
    } catch (error) { return failure('HOME_FAILED', error); }
  }
  function effectAction(action, value) {
    try {
      ensureAlive();
      if (action === 'pauseEffects') { effectsPaused = true; effects?.pause(); }
      if (action === 'resumeEffects') { effectsPaused = false; effects?.resume(); }
      if (action === 'reducedMotion') { reducedMotion = !!value; effects?.setReducedMotion(reducedMotion); }
      return publish({ ...engine.getStatus(), action, effectsPaused, reducedMotion });
    } catch (error) { return failure('EFFECT_CONTROL_FAILED', error); }
  }
  function dispatch(event) {
    const type = typeof event === 'string' ? event : event?.type;
    if (destroyed) return { ok: false, state: 'destroyed', code: 'INSTALLATION_DESTROYED' };
    if (type === 'showcase' || type === 'reality') return setMode(type);
    if (type === 'home') return returnHome();
    if (type === 'pauseEffects' || type === 'resumeEffects') return effectAction(type);
    if (type === 'reducedMotion' && typeof event.value === 'boolean') return effectAction(type, event.value);
    return failure('UNKNOWN_ACTION', '事件类型无效；请选择 showcase、reality、home、pauseEffects、resumeEffects 或 reducedMotion。');
  }
  const controller = Object.freeze({
    setMode, home: returnHome, dispatch, destroy,
    setEffectsTime: seconds => { if (effects) effects.setTime(seconds); },
    samplingExclusions: () => [...(engine?.getOwnedObjects() || []), ...(effects?.getOwnedObjects() || [])],
    addPulseRing: config => getEffects().addPulseRing(config),
    addFlowRoute: config => getEffects().addFlowRoute(config),
    addSelectionOutline: config => getEffects().addSelectionOutline(config),
    removeEffect: id => effects ? effects.remove(id) : false,
    setEffectVisible: (id, visible) => effects ? effects.setVisible(id, visible) : false,
    pauseEffects: () => effectAction('pauseEffects'),
    resumeEffects: () => effectAction('resumeEffects'),
    setReducedMotion: value => effectAction('reducedMotion', value),
    getStatus: () => {
      const currentEngine = engine?.getStatus();
      const current = installed && currentEngine && !currentEngine.ok
        ? { ...lastStatus, ok: false, state: currentEngine.state,
          message: currentEngine.message || '场景显示存在错误或所有权冲突，请查看 engineStatus。' }
        : lastStatus;
      return { ...current, engineStatus: currentEngine,
        effects: effects?.getState() || { effects: [], paused: effectsPaused, reducedMotion } };
    },
    getEvidence: () => ({ scope: 'existing-viewer-host-wiring', source: 'Cesium_Platform_Design_v4/runtime/install-presentation.js', createdViewerCount: 0,
      businessGeometryWrites: 0, installed, destroyed, boundCleanupCount: removers.length,
      scene: engine?.getEvidence(), effects: effects?.getState() || { effects: [] },
      advancedConfigurationSource: advanced.configurationSource || null,
      materialReplacementAllowed: advanced.allowMaterialReplacement === true })
  });
  try {
    const created = await createScenePresentation({
      Cesium: C, viewer, tilesets: record.tilesets, displayEnvelope: options.displayEnvelope,
      initialMode: 'showcase', allowMaterialReplacement: advanced.allowMaterialReplacement === true,
      ellipsoid: advanced.ellipsoid, onStatus: engineStatus
    });
    if (!created.ok) {
      if (installations.get(viewer) === record) installations.delete(viewer);
      return { ok: false, status: publish({ ...created.status, state: 'not-installed', engineStatus: created.status }) };
    }
    engine = created.controller;
    if (options.effects) effects = createWorldEffects(C, viewer, options.effects);
    const camera = options.homeOnInstall === false ? { ok: true, preserved: true } : engine.home(home);
    if (!camera.ok) throw Object.assign(new Error(`总览取景失败：${camera.code || 'HOME_FAILED'}`), { code: camera.code });
    for (const name of ACTIONS) {
      const button = buttons[name];
      if (!button) continue;
      const listener = () => dispatch(name);
      button.addEventListener('click', listener);
      removers.push(() => button.removeEventListener('click', listener));
    }
    if (subscribe) {
      const unsubscribe = subscribe(event => { if (!destroyed) dispatch(event); });
      if (typeof unsubscribe !== 'function') throw Object.assign(
        new Error('subscribe 必须返回解除订阅函数；当前订阅回调已停止执行，宿主应修正该接口。'),
        { code: 'UNSUBSCRIBE_REQUIRED' });
      removers.push(unsubscribe);
    }
    installed = true;
    return { ok: true, status: publish({ ...engine.getStatus(), state: 'installed', camera,
      message: options.homeOnInstall === false ? '已使用现有 Viewer 接入展示，保持当前镜头。' : '已使用现有 Viewer 进入展示总览。' }), controller, reused: false };
  } catch (error) {
    const cause = { code: error.code || 'INSTALL_FAILED', message: errorText(error) };
    const cleanup = destroy();
    return { ok: false, status: publish({ ok: false, state: 'not-installed', ...cause,
      cleanupErrors: cleanup.cleanupErrors, engineStatus: lastEngineStatus }) };
  }
}
