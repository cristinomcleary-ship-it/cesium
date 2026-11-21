#!/usr/bin/env node
/** Runs unchanged legacy browser acceptance with isolated data and Vite caches.
 * Usage: PLAYWRIGHT_MODULE=... node tools/engineering-compatibility-regression.mjs model-edit|video-overlay|surface-edit|photogrammetry-transform
 */
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const kind = process.argv[2];
const scripts = { 'model-edit': 'tests/model-edit-appearance-browser.mjs', 'video-overlay': 'tools/verify-video-overlay-spatial.mjs', 'surface-edit':'tests/surface-edit-browser.mjs', 'photogrammetry-transform':'tests/photogrammetry-transform-browser.mjs' };
if (!Object.hasOwn(scripts, kind)) throw new Error('Choose ' + Object.keys(scripts).join(', '));
const root = process.cwd();
const outputRoot = resolve('output/engineering-compatibility');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, `${kind}-`));
// /output is deliberately blocked by management storage middleware. Use the
// ignored workspace .vite directory, which is outside the shared node_modules.
const cache = resolve('.vite/engineering-compatibility', basename(output));
const data = join(output, 'isolated-data');
await mkdir(data);
const require = createRequire(import.meta.url);
const actualVite = pathToFileURL(require.resolve('vite')).href;
// Dependencies can be individual junctions while node_modules itself is local.
const dependencyRealPrefix = '/@fs/' + dirname(dirname(require.resolve('cesium/package.json'))).replaceAll('\\', '/') + '/';
const viteEnvironmentPath = '/@fs/' + (await realpath(join(dirname(require.resolve('vite/package.json')), 'dist/client/env.mjs'))).replaceAll('\\', '/');
const dependencyCandidatePrefix = '/@fs/' + resolve('node_modules').replaceAll('\\', '/') + '/';
const shim = join(output, 'vite-shim.mjs');
const preload = join(output, 'preload.mjs');
const cacheBrowserPath = '/' + cache.slice(root.length + 1).replaceAll('\\', '/') + '/deps/';
await writeFile(shim, `
export * from ${JSON.stringify(actualVite)};
import {createServer as actualCreateServer, loadConfigFromFile} from ${JSON.stringify(actualVite)};
import {createServer as createProbe} from 'node:net';
export async function createServer(options = {}) {
  const probe = createProbe();
  await new Promise((resolve,reject) => {probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve)});
  const port = probe.address().port;
  await new Promise((resolve,reject) => probe.close(error => error ? reject(error) : resolve()));
  if ([5173,5297].includes(port)) throw new Error('Reserved port selected');
  if (process.env.ENGINEERING_LEGACY_TEST === 'video-overlay') process.env.BASE_URL = 'http://127.0.0.1:' + port;
  const loaded = await loadConfigFromFile({command:'serve',mode:'development'},undefined,process.cwd(),undefined,undefined,'runner');
  if(!loaded) throw new Error('Candidate Vite configuration was not loaded');
  return actualCreateServer({...loaded.config,...options,configFile:false,cacheDir:${JSON.stringify(cache)},
    server:{...loaded.config.server,...options.server,port,strictPort:true},
    plugins:[{name:'legacy-isolated-dependency-urls',enforce:'pre',configureServer(server) {
      server.middlewares.use(async (request,response,next) => {
        // Vite recognizes its environment module by its real path; transform it
        // before sending rather than rewriting away that exact module identity.
        if (request.url?.split('?')[0] === ${JSON.stringify(viteEnvironmentPath)}) {
          try {
            const result=await server.transformRequest(request.url);
            if(!result) return next(new Error('Vite environment module transform failed'));
            response.setHeader('Content-Type','text/javascript');response.end(result.code);return;
          } catch(error) { next(error); return; }
        }
        if (request.url?.startsWith(${JSON.stringify(dependencyRealPrefix)})) request.url = ${JSON.stringify(dependencyCandidatePrefix)} + request.url.slice(${dependencyRealPrefix.length});
        if (request.url?.startsWith('/node_modules/.vite/deps/')) request.url = ${JSON.stringify(cacheBrowserPath)} + request.url.slice('/node_modules/.vite/deps/'.length);
        next();
      });
    }},...(loaded.config.plugins || []),...(options.plugins || [])]
  });
}
`);
// Resolve only the package entry; the shim's absolute Vite import remains untouched.
await writeFile(preload, `import {registerHooks} from 'node:module';\nregisterHooks({resolve(specifier, context, next) { return specifier === 'vite' ? {url:${JSON.stringify(pathToFileURL(shim).href)},shortCircuit:true} : next(specifier,context); }});\n`);
const launchOptions = join(output, 'edge-d3d11-launch.mjs');
await writeFile(launchOptions, `export default ${JSON.stringify({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--use-gl=angle', '--use-angle=d3d11', '--no-first-run', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required'] })};\n`);
const env = { ...process.env, ENGINEERING_LEGACY_TEST:kind, CESIUM_VITE_CACHE_DIR:cache,
  CESIUM_DATA_DIR:data,CESIUM_MANAGEMENT_DATA_DIR:data,CESIUM_SAFETY_DATA_DIR:data,
  MODEL_EDIT_BROWSER_OUT:output,SURFACE_EDIT_BROWSER_OUT:output,PHOTOGRAMMETRY_BROWSER_OUT:output,OUTPUT_DIR:output,BROWSER_LAUNCH_OPTIONS:launchOptions,
  BROWSER_EXECUTABLE:process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' };
// Overlay's entry captures BASE_URL before starting Vite, so reserve a port here.
if(kind === 'video-overlay') {
  const {createServer} = await import('node:net'); const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port; await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
  env.BASE_URL=`http://127.0.0.1:${port}`;env.START_VITE='1';env.ENGINEERING_OVERLAY_PORT=String(port);
  const source=await readFile(shim,'utf8');
  await writeFile(shim, source.replace('const port = probe.address().port;', 'const port = process.env.ENGINEERING_OVERLAY_PORT ? Number(process.env.ENGINEERING_OVERLAY_PORT) : probe.address().port;'));
}
const script=resolve(scripts[kind]);
const originalHash=createHash('sha256').update(await readFile(script)).digest('hex');
const report={kind,script,sourceSha256:originalHash,output,cache,data,startedAt:new Date().toISOString(),harnessChanges:['Explicit isolated data roots','Vite configLoader runner and ignored workspace cache','Original fixed Cesium optimized URL mapped to isolated cache','Verified dependency junction realpath URL mapped to workspace path before original access middleware; exact Vite env module transformed at original path','Ephemeral strict port'],browserMode:kind==='video-overlay'?'Original test Edge ANGLE SwiftShader arguments':'Edge D3D11 via BROWSER_LAUNCH_OPTIONS'};
console.log(JSON.stringify(report,null,2));
let log='';
const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,script],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk);});
child.stderr.on('data',chunk=>{log+=chunk;process.stderr.write(chunk);});
const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
report.finishedAt=new Date().toISOString();report.exitCode=result.code;report.signal=result.signal;
report.sourceUnchanged=createHash('sha256').update(await readFile(script)).digest('hex')===originalHash;
await writeFile(join(output,'harness-report.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(join(output,'console.log'),log);
console.log(JSON.stringify({output,exitCode:result.code,sourceUnchanged:report.sourceUnchanged}));
process.exitCode=result.code ?? 1;
