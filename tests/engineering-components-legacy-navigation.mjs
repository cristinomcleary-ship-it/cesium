// Test-only navigation and synthetic-survey isolation adapter for verify-temporary-works-glb.mjs.
// The original script and its business assertions remain byte-for-byte unchanged.
// Current and pre-engineering UI put controls and menu entries in native collapsed details.
// The optional survey isolation excludes the globe, which otherwise contributes an ellipsoid
// height inside the known mesh hole. This was reproduced against the unchanged 4239 build.
import { appendFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Cartesian3 } from 'cesium';
import { resolve } from 'node:path';

const actual = process.env.ENGINEERING_REAL_PLAYWRIGHT_MODULE;
if (!actual) throw new Error('Set ENGINEERING_REAL_PLAYWRIGHT_MODULE to the installed Playwright module');
const playwright = await import(actual);
let diagnosticClock;
// Node-only compatibility for the historical runner. Cartesian3.pack preserves x/y/z exactly.
// This does not alter the Cesium module loaded inside the browser application.
if (typeof Cartesian3.toArray !== 'function') {
  Cartesian3.toArray = (value, result = []) => Cartesian3.pack(value, result);
  assert.deepEqual(Cartesian3.toArray(new Cartesian3(1, 2, 3)), [1, 2, 3]);
  await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'runtime-adapter.jsonl'), JSON.stringify({ at: new Date().toISOString(), scope: 'Node test runner only', mapping: 'Cartesian3.toArray(value, result) -> Cartesian3.pack(value, result)', probe: [1, 2, 3] }) + '\n');
}
function preparePage(page) {
  if (process.env.ENGINEERING_LEGACY_HARDWARE === '1') {
    const navigate = page.goto.bind(page);
    page.goto = async (...args) => {
      const response = await navigate(...args);
      await page.waitForFunction(() => document.querySelector('#cesiumContainer canvas')?.getContext('webgl2'), null, { timeout: 60000 });
      const gpu = await page.evaluate(() => {
        const gl = document.querySelector('#cesiumContainer canvas').getContext('webgl2'), info = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
      });
      assert.doesNotMatch(gpu.renderer, /swiftshader|llvmpipe|software/i, 'This run requires physical GPU rendering');
      assert(gpu.maxTextureSize >= 10197, 'Keep the original steel texture width of 10,197 pixels');
      await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'render-environment.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...gpu }) + '\n');
      console.log('GPU', JSON.stringify(gpu)); return response;
    };
  }
  const locate = page.locator.bind(page);
  page.locator = (selector, ...args) => {
    const locator = locate(selector, ...args);
    for (const method of ['fill', 'click', 'selectOption', 'check', 'uncheck']) {
      const original = locator[method].bind(locator);
      locator[method] = async (...values) => {
        if (selector === '#tw-glb-elevation' && method === 'fill' && await locate('#tw-elevation-mode').inputValue() === 'automatic') {
          // The historical script explicitly reads and fills a height. Select that existing UI mode.
          await page.locator('#tw-elevation-mode').selectOption('manual');
          await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'navigation-adapter.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: 'selectOption', target: '#tw-elevation-mode', value: 'manual', reason: 'Original script explicitly requests manual point sampling and a height field' }) + '\n');
        }
        if (!await locator.isVisible()) {
          const closed = locator.locator('xpath=ancestor::details[not(@open)]');
          for (let count = 0; count < 10 && await closed.count() > 0; count++) {
            const details = closed.first();
            const summary = await details.locator(':scope > summary').textContent();
            await details.locator(':scope > summary').click();
            const action = { at: new Date().toISOString(), action: 'click', target: selector, summary, reason: 'Expand existing native details before the original UI action' };
            await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'navigation-adapter.jsonl'), JSON.stringify(action) + '\n');
            console.log('NAVIGATION', action.target, action.summary);
          }
        }
        const result = await original(...values);
        if (selector === '#tw-kind' && method === 'selectOption' && values[0] === 'road' && await locate('#tw-elevation-mode').inputValue() !== 'automatic') {
          await page.locator('#tw-elevation-mode').selectOption('automatic');
          await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'navigation-adapter.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: 'selectOption', target: '#tw-elevation-mode', value: 'automatic', reason: 'Original road checks explicitly require draped photography geometry after the prior manual-height facility cases' }) + '\n');
        }
        return result;
      };
    }
    return locator;
  };
  return page;
}
export const chromium = {
  async launch(options) {
    let configured = options;
    if (process.env.ENGINEERING_LEGACY_HARDWARE === '1') {
      configured = { ...options, args: [...(options.args || []).filter(value => !value.startsWith('--use-angle=') && value !== '--enable-unsafe-swiftshader'), '--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] };
      await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'render-environment.jsonl'), JSON.stringify({ at: new Date().toISOString(), mode: 'D3D11 hardware', reason: 'Original steel GLB texture exceeds the forced SwiftShader 8192 limit; retain the delivered asset unchanged', args: configured.args }) + '\n');
    }
    const browser = await playwright.chromium.launch(configured);
    const createContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await createContext(...args), createPage = context.newPage.bind(context);
      context.newPage = async (...values) => preparePage(await createPage(...values));
      const createCdp = context.newCDPSession.bind(context);
      context.newCDPSession = async (...values) => {
        const session = await createCdp(...values), send = session.send.bind(session);
        session.send = async (method, parameters) => {
          const sample = method === 'Runtime.callFunctionOn' && parameters?.functionDeclaration?.includes('sampleHeightMostDetailed');
          const pixels = method === 'Runtime.callFunctionOn' && parameters?.functionDeclaration?.includes('gl.readPixels(');
          if (pixels && process.env.ENGINEERING_ISOLATE_SURVEY_GLOBE === '1') {
            // Pixel comparisons across a reload require the same sky orientation and lighting.
            // Keep the real sky and all original pixel thresholds; only pin the fixture clock.
            const clock = await send(method, { ...parameters, arguments: [{ value: diagnosticClock }], functionDeclaration: `function(fixed){
              const viewer=this.find(v=>!v.isDestroyed()&&v.container===document.getElementById('cesiumContainer'));
              if(!viewer)throw Error('No current main viewer for synthetic survey pixel comparison');
              const primitives=Array.from({length:viewer.scene.primitives.length},(_,i)=>viewer.scene.primitives.get(i));
              if(!primitives.some(p=>p.root&&p.resource?.url.includes('/__glb_survey/')))throw Error('Synthetic survey fixture is missing');
              const before={dayNumber:viewer.clock.currentTime.dayNumber,secondsOfDay:viewer.clock.currentTime.secondsOfDay};
              const selected=fixed||before;
              viewer.clock.shouldAnimate=false;viewer.clock.canAnimate=false;
              viewer.clock.currentTime=new viewer.clock.currentTime.constructor(selected.dayNumber,selected.secondsOfDay);
              viewer.scene.requestRender();
              return {fixture:'__glb_survey',before,fixed:selected,globeShow:viewer.scene.globe.show};
            }` });
            if (clock.exceptionDetails) throw new Error('Synthetic survey clock isolation failed: ' + JSON.stringify(clock.exceptionDetails));
            diagnosticClock = clock.result.value.fixed;
            await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'pixel-clock-diagnostics.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...clock.result.value }) + '\n');
          }
          if (sample && process.env.ENGINEERING_ISOLATE_SURVEY_GLOBE === '1') {
            const isolated = await send(method, { ...parameters, arguments: [], functionDeclaration: `function(){
              const viewer=this.find(v=>!v.isDestroyed()&&v.container===document.getElementById('cesiumContainer'));
              if(!viewer)throw Error('No current main viewer for synthetic survey isolation');
              const primitives=Array.from({length:viewer.scene.primitives.length},(_,i)=>viewer.scene.primitives.get(i));
              if(!primitives.some(p=>p.root&&p.resource?.url.includes('/__glb_survey/')))throw Error('Synthetic survey fixture is missing');
              const before=viewer.scene.globe.show; viewer.scene.globe.show=false; viewer.scene.requestRender();
              return {fixture:'__glb_survey',globeBefore:before,globeAfter:viewer.scene.globe.show};
            }` });
            if (isolated.exceptionDetails) throw new Error('Synthetic survey isolation failed: ' + JSON.stringify(isolated.exceptionDetails));
            await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'survey-isolation.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...isolated.result.value }) + '\n');
          }
          const response = await send(method, parameters);
          if (pixels) {
            await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'pixel-diagnostics.jsonl'), JSON.stringify({ at: new Date().toISOString(), inputs: parameters.arguments, response }) + '\n');
            console.log('PIXELS', JSON.stringify(response.result?.value));
          }
          if (sample) {
            await appendFile(resolve(process.env.TW_GLB_OUT || 'output/temporary-works-glb', 'sample-diagnostics.jsonl'), JSON.stringify({ at: new Date().toISOString(), inputs: parameters.arguments, response }) + '\n');
            console.log('SAMPLE', JSON.stringify(response.result?.value));
          }
          return response;
        };
        return session;
      };
      return context;
    };
    return browser;
  },
};
