#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';

const help = `机械传感器 HTTP 模拟工具（所有发送数据明确标记 simulated）

生成一台机械的私有设备配置及令牌文件：
  node tools/simulate-machinery-telemetry.mjs --init-config <工程目录外的绝对路径.json> --project <项目ID> --resource <机械资源ID> --source sensor-01
  配置服务端环境变量 CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE 后重启 npm run dev。
  将相邻 .token 文件内容设为客户端环境变量 CESIUM_MACHINERY_TELEMETRY_TOKEN。

发送一帧：
  node tools/simulate-machinery-telemetry.mjs --project <项目ID> --resource <机械资源ID> --source sensor-01 --values '{"boom_length_m":20,"boom_elevation_deg":55}' --once
连续发送（默认2Hz、30秒；wave是围绕values基值变化的幅度）：
  node tools/simulate-machinery-telemetry.mjs --project <项目ID> --resource <机械资源ID> --source sensor-01 --values '{"boom_length_m":20,"boom_elevation_deg":55}' --wave '{"boom_length_m":2,"boom_elevation_deg":10}' --hz 2 --duration 30

选项：--url 默认为 http://127.0.0.1:5173；--duration 0 持续到 Ctrl+C。
只发送 --values 中的字段；未关联参数不会变化。参数值与单位须符合页面绑定。
真实传感器应自行使用同一路径 POST，并设置 mode:"measured"。
`;

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--help', '-h', '--once'].includes(key)) { result[key] = true; continue; }
    if (!['--init-config', '--project', '--resource', '--source', '--url', '--values', '--wave', '--hz', '--duration'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`选项无效或缺少值：${key}`);
    result[key] = args[++i];
  }
  return result;
}
function identifier(value, label) {
  if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(value ?? '')) throw new Error(`${label}须填写页面显示的有效ID`);
  return value;
}
function channels(raw, label) {
  let value; try { value = JSON.parse(raw); } catch { throw new Error(`${label}须为JSON对象`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, v]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) || typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${label}须为字段到有限数值的JSON对象`);
  return value;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['--help'] || args['-h']) { console.log(help); return; }
  const projectId = identifier(args['--project'], '项目ID'), resourceId = identifier(args['--resource'], '机械资源ID'), sourceId = identifier(args['--source'] ?? 'sensor-01', '来源ID');
  if (args['--init-config']) {
    const file = resolve(args['--init-config']), tokenFile = file + '.token';
    const rel = relative(process.cwd(), file);
    if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.includes(':'))) throw new Error('私有配置必须保存到当前工程目录之外，避免经开发服务器暴露');
    if (existsSync(file) || existsSync(tokenFile)) throw new Error('配置或令牌文件已存在，未覆盖；为新增设备选择新路径并合并私有配置中的devices');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('base64url');
    const config = { version: 1, devices: [{ projectId, resourceId, sourceId, enabled: true, tokenSha256: createHash('sha256').update(token).digest('hex') }] };
    writeFileSync(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
    try { writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { unlinkSync(tokenFile); throw error; }
    console.log(`已生成私有配置：${file}\n已生成令牌文件：${tokenFile}\n配置变量：CESIUM_MACHINERY_TELEMETRY_CONFIG_FILE\n发送变量：CESIUM_MACHINERY_TELEMETRY_TOKEN（填入令牌文件内容）\n配置后重启服务；不要将两个文件放入工程或提交到Git。`);
    return;
  }
  const token = process.env.CESIUM_MACHINERY_TELEMETRY_TOKEN?.trim();
  if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('请先设置 CESIUM_MACHINERY_TELEMETRY_TOKEN');
  const values = channels(args['--values'] ?? '{}', '--values'), wave = channels(args['--wave'] ?? '{}', '--wave');
  if (!Object.keys(values).length || Object.keys(values).length > 64) throw new Error('--values须包含1至64个字段');
  if (Object.keys(wave).some(key => !Object.hasOwn(values, key))) throw new Error('--wave的字段必须同时存在于--values');
  const hz = Number(args['--hz'] ?? 2), duration = Number(args['--duration'] ?? 30);
  if (!Number.isFinite(hz) || hz < 0.1 || hz > 10 || !Number.isFinite(duration) || duration < 0) throw new Error('--hz须为0.1至10，--duration须为非负秒数');
  const url = new URL('/__management/machinery-telemetry', args['--url'] ?? 'http://127.0.0.1:5173');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('--url须为不含账号密码的HTTP地址');
  let running = true, count = 0, lastTime = 0;
  process.once('SIGINT', () => { running = false; });
  const start = Date.now();
  do {
    const elapsed = (Date.now() - start) / 1000, timestamp = Math.max(Date.now(), lastTime + 1); lastTime = timestamp;
    const current = Object.fromEntries(Object.entries(values).map(([key, base]) => {
      let value = base + (wave[key] ?? 0) * Math.sin(elapsed * 2 * Math.PI / 12);
      if (key === 'heading' || key === 'boom_rotation_deg') value = ((value % 360) + 360) % 360;
      return [key, Number(value.toFixed(8))];
    }));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ schemaVersion: 1, projectId, resourceId, sourceId, timestamp: new Date(timestamp).toISOString(), mode: 'simulated', values: current }), signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.code ?? ''} ${result.error ?? '回传失败'}`);
    count++; console.log(`模拟帧 ${count} / sequence ${result.frame.sequence}: ${JSON.stringify(current)}`);
    if (args['--once'] || (duration > 0 && (Date.now() - start) / 1000 >= duration)) break;
    await new Promise(done => setTimeout(done, 1000 / hz));
  } while (running);
  console.log(`结束，共接受 ${count} 帧模拟数据。停止后页面会保留最后姿态并显示超时。`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
