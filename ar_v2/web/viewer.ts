import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FixedSceneRenderer, type FrameImage, type Pose } from './renderer';
import './viewer.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><strong>无人机视频 AR · V2</strong><a href="/">返回工程平台</a><small>模型视觉定位 · 固定场景 · 独立融合</small></header>
<main><aside><span class="badge">开发验证版</span><div id="connection">连接本地计算服务…</div>
<p>先生成固定场景与参考图，再对视频画面求解位姿。未通过定位的画面显示模型原纹理。</p>
<h2>数据准备</h2><div class="actions"><button data-command="doctor">环境诊断</button><button data-command="prepare-scene">准备场景</button><button data-command="extract-frames">提取验证帧</button><button data-command="build-references">生成参考图</button></div>
<h2>视觉定位</h2><div class="field"><label for="time">视频时间</label><input id="time" type="number" min="0" value="10.01" step="0.01"><span>秒</span></div>
<select id="matcher"><option value="aliked-lightglue">ALIKED + LightGlue</option><option value="sift">SIFT · CPU 基线</option></select>
<div class="actions" style="margin-top:12px"><button data-command="localize">定位此帧</button><button data-command="refine">多帧优化</button><button data-command="validate">检查结果</button></div>
<h2>已处理画面</h2><select id="frames"><option value="">尚无位姿结果</option></select><div class="actions" style="margin-top:10px"><button id="load">查看融合</button><button id="base">原始模型</button></div>
<div id="error" role="alert"></div><h2>任务进度</h2><div id="jobs"></div></aside>
<section id="stage"><canvas id="scene"></canvas><div class="hud"><p id="pose">尚未载入固定场景</p><small id="quality">独立检查点：未提供；绝对地理精度：未验证</small></div><img id="preview" alt="当前定位帧的重投影检查"></section></main>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const api = new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:5199';
const artifact = (path: string) => `${api}/artifacts/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
let renderer: FixedSceneRenderer | undefined, controls: OrbitControls | undefined, sceneVersion = '', selectionToken = 0;
let poses: Array<{ path: string; pose: Pose & { metrics?: Record<string, unknown>; artifacts?: Record<string, string>; reasons?: string[] } }> = [];
const camera = new THREE.PerspectiveCamera(55, 1, .1, 10000); camera.up.set(0, 0, 1);
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init); const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
async function post(path: string, body: unknown) { return json(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
function error(value: unknown) { $('error').textContent = value instanceof Error ? value.message : String(value); }
async function loadScene(manifest: any) {
  if (manifest.geometry_version === sceneVersion) return;
  renderer?.dispose(); controls?.dispose(); renderer = undefined; sceneVersion = '';
  $('pose').textContent = '正在载入固定几何与纹理…';
  const next = new FixedSceneRenderer($<HTMLCanvasElement>('scene'));
  await next.load(manifest, artifact('scene/'));
  const bounds = new THREE.Box3().setFromObject(next.scene), center = bounds.getCenter(new THREE.Vector3());
  const size = Math.max(30, bounds.getSize(new THREE.Vector3()).length());
  camera.position.copy(center).add(new THREE.Vector3(size * .4, -size * .5, size * .4)); camera.lookAt(center);
  controls = new OrbitControls(camera, $('scene')); controls.target.copy(center); controls.update();
  renderer = next; sceneVersion = manifest.geometry_version;
  $('pose').textContent = `固定场景已载入 · ${next.triangleCount.toLocaleString()} 个三角面`;
}
function image(url: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error(`无法读取画面：${url}`)); img.src = url; }); }
async function showSelected() {
  const token = ++selectionToken; renderer?.cancel();
  const selected = poses[Number($<HTMLSelectElement>('frames').value)]; if (!selected || !renderer) return;
  const pose = selected.pose;
  $('pose').textContent = `${pose.status} · PTS ${pose.original_pts} · 帧 ${pose.original_frame_id}`;
  const metrics = pose.metrics || {};
  $('quality').textContent = `内点 ${metrics.inliers ?? '—'} · 覆盖 ${metrics.grid_cells ?? '—'}/12 · 独立检查：${metrics.independent_checkpoints ? '见验证报告' : '未提供'}${pose.reasons?.length ? ' · ' + pose.reasons.join('；') : ''}`;
  if (pose.artifacts?.overlay) { $<HTMLImageElement>('preview').src = artifact(pose.artifacts.overlay); $('preview').style.display = 'block'; }
  if (!['LOCALIZED', 'TRACKED'].includes(pose.status)) return;
  const response = await json(`${api}/api/frame?pts=${pose.original_pts}&profile=${encodeURIComponent(pose.camera_profile_id)}`);
  const bitmap = await image(artifact(response.rectified_path));
  const validMask = response.valid_mask_path ? await image(artifact(response.valid_mask_path)) : undefined;
  if (token !== selectionToken) return;
  await renderer.commit({ ...response, image: bitmap, validMask } as FrameImage, pose);
}
let sceneLoading = false;
async function refresh() {
  try {
    const status = await json(api + '/api/status');
    $('connection').textContent = `已连接 · ${status.input_names.video_path}`;
    const manifest = status.products['scene/scene_manifest.json'];
    if (manifest && !sceneLoading && manifest.geometry_version !== sceneVersion) { sceneLoading = true; try { await loadScene(manifest); } finally { sceneLoading = false; } }
    const active = status.jobs.some((job: any) => ['RUNNING', 'QUEUED'].includes(job.status));
    document.querySelectorAll<HTMLButtonElement>('button[data-command]').forEach(button => button.disabled = active);
    $('jobs').replaceChildren();
    for (const job of status.jobs.slice(0, 8)) {
      const item = document.createElement('div'); item.className = 'job';
      const label = document.createElement('div'); label.textContent = `${job.command} · ${job.status} · ${job.phase || ''}`; item.append(label);
      if (job.progress) { const progress = document.createElement('progress'); progress.max = job.progress.total || 1; progress.value = job.progress.completed || 0; item.append(progress); }
      if (job.error) { const detail = document.createElement('div'); detail.textContent = job.error; item.append(detail); }
      if (['RUNNING', 'QUEUED'].includes(job.status)) { const cancel = document.createElement('button'); cancel.textContent = '取消任务'; cancel.onclick = () => post('/api/cancel', { job_id: job.job_id }).then(refresh).catch(error); item.append(cancel); }
      $('jobs').append(item);
    }
    const result = await json(api + '/api/poses');
    const prior = $<HTMLSelectElement>('frames').selectedIndex;
    poses = result.poses;
    if (poses.length) {
      $<HTMLSelectElement>('frames').replaceChildren(...poses.map((item, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${item.pose.original_frame_id} · ${item.pose.status}`; return option; }));
      $<HTMLSelectElement>('frames').selectedIndex = Math.min(Math.max(prior, 0), poses.length - 1);
    }
  } catch (problem) { $('connection').textContent = '服务未连接。运行“启动 AR V2.cmd”后重试。'; error(problem); }
}
document.querySelectorAll<HTMLButtonElement>('button[data-command]').forEach(button => button.onclick = async () => {
  $('error').textContent = ''; try { await post('/api/jobs', { command: button.dataset.command, time: Number($<HTMLInputElement>('time').value), matcher: $<HTMLSelectElement>('matcher').value }); await refresh(); } catch (problem) { error(problem); }
});
$('load').onclick = () => showSelected().catch(error);
$('base').onclick = () => { selectionToken++; renderer?.cancel(); $('pose').textContent = '显示固定模型原纹理'; };
function animate() { requestAnimationFrame(animate); if (!renderer) return; const stage = $('stage'); const width = stage.clientWidth, height = stage.clientHeight; camera.aspect = width / height; camera.updateProjectionMatrix(); controls?.update(); renderer.render(camera, width, height); }
animate(); void refresh(); window.setInterval(() => void refresh(), 2500);
