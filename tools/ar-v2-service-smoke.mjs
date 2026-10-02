import fs from 'node:fs';
const api = 'http://127.0.0.1:5199';
const checks = [];
const check = (name, passed) => { checks.push({ name, passed }); if (!passed) throw new Error(name); };
const post = (path, value, extra = {}) => fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
let ownedJob;
try {
  const status = await (await fetch(api + '/api/status')).json();
  check('status-and-fixed-scene', status.products['scene/scene_manifest.json']?.status === 'ready');
  const manifest = status.products['media/video_manifest.json'];
  const frame = manifest.frames[0];
  const image = await (await fetch(`${api}/api/frame?pts=${frame.original_pts}&profile=${frame.camera_profile_id}`)).json();
  check('frame-preserves-identity-and-mask', image.source_video_hash === manifest.source_video_hash && image.width === 1920 && !!image.valid_mask_path);
  check('artifact-traversal-rejected', (await fetch(api + '/artifacts/%2e%2e%2foutside.json')).status === 400);
  check('unknown-origin-cannot-start-job', (await post('/api/jobs', { command: 'doctor' }, { Origin: 'https://untrusted.example' })).status === 403);
  const launched = await post('/api/jobs', { command: 'doctor' });
  check('job-started', launched.status === 202); ownedJob = (await launched.json()).job_id;
  check('concurrent-job-rejected', (await post('/api/jobs', { command: 'doctor' })).status === 409);
  const stopped = await post('/api/cancel', { job_id: ownedJob });
  check('owned-job-cancelled', stopped.status === 200 && (await stopped.json()).status === 'CANCELLED');
  const latest = await (await fetch(api + '/api/status')).json();
  check('cancel-state-visible', latest.jobs.find(job => job.job_id === ownedJob)?.status === 'CANCELLED');
  ownedJob = null;
} finally {
  if (ownedJob) await post('/api/cancel', { job_id: ownedJob });
  fs.writeFileSync('output/ar-v2/environment/service-smoke.json', JSON.stringify({ status: checks.length === 8 && checks.every(item => item.passed) ? 'PASSED' : 'FAILED', checks }, null, 2));
  console.log(JSON.stringify(checks));
}
