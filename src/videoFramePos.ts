/** CC position priors are sampled from measured telemetry, never invented from pixels. */
import type { VideoExtractedFrame } from './videoFrameExtraction';

export type VideoPosSample = { time: number; coordinateSystem: string; x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
export type VideoPosSource = { samples: VideoPosSample[]; name?: string };
export type VideoPosTiming = { frameRate: number; firstTime?: number; maxGapSeconds?: number };
export const VIDEO_POS_HEADER = 'name,coordinate_system,x,y,z,yaw,pitch,roll';

function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell.trim()); cell = '';
      if (char !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (char === '\r' && text[i + 1] === '\n') i++; }
    } else cell += char;
  }
  if (quoted) throw new Error('POS CSV 引号未闭合');
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** Explicit time_seconds is preferred; frame-number CSV requires its actual frame rate. */
export function parseVideoPosCsv(text: string, timing: VideoPosTiming): VideoPosSource {
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('POS CSV 没有定位记录');
  const headers = rows.shift()!.map(value => value.toLowerCase()), column = (name: string) => headers.indexOf(name);
  for (const name of ['name', 'coordinate_system', 'x', 'y', 'z']) if (column(name) < 0) throw new Error(`POS CSV 缺少 ${name} 列`);
  const timeColumn = ['time_seconds', 'time', 'mediatime', 'videotime'].map(column).find(index => index >= 0);
  const firstTime = timing.firstTime ?? 0;
  if (!Number.isFinite(firstTime) || firstTime < 0 || timeColumn === undefined && (!Number.isFinite(timing.frameRate) || timing.frameRate <= 0)) throw new Error('请填写 POS 编号对应的真实帧率和首条时间');
  let firstIndex: number | undefined;
  const samples = rows.map((row, index): VideoPosSample => {
    const value = (name: string, required = true) => {
      const raw = row[column(name)]?.trim();
      if (!raw && !required) return undefined;
      if (!raw || !Number.isFinite(Number(raw))) throw new Error(`POS 第 ${index + 2} 行的 ${name} 无效`);
      return Number(raw);
    };
    const coordinateSystem = row[column('coordinate_system')];
    if (!coordinateSystem) throw new Error(`POS 第 ${index + 2} 行缺少坐标系`);
    let time: number;
    if (timeColumn !== undefined) {
      const raw = row[timeColumn]; if (!raw || !Number.isFinite(Number(raw))) throw new Error(`POS 第 ${index + 2} 行时间无效`);
      time = Number(raw);
    } else {
      const match = row[column('name')]?.match(/(\d+)(?=\.[^.]+$)/);
      if (!match) throw new Error('POS 照片名没有帧号，请增加 time_seconds 列');
      const frameIndex = Number(match[1]); firstIndex ??= frameIndex;
      time = firstTime + (frameIndex - firstIndex) / timing.frameRate;
    }
    const sample = { time, coordinateSystem, x: value('x')!, y: value('y')!, z: value('z')!, yaw: value('yaw', false), pitch: value('pitch', false), roll: value('roll', false) };
    if (!Number.isFinite(time) || time < 0) throw new Error(`POS 第 ${index + 2} 行时间无效`);
    if (/^(wgs\s*84|epsg:?(4326|4979))$/i.test(coordinateSystem) && (Math.abs(sample.x) > 180 || Math.abs(sample.y) > 90)) throw new Error('WGS 84 POS 的 x 应为经度、y 应为纬度');
    return sample;
  });
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].time <= samples[i - 1].time) throw new Error('POS 时间或照片帧号必须严格递增，不能重复');
    if (samples[i].coordinateSystem !== samples[0].coordinateSystem) throw new Error('一份 POS CSV 不能混用不同坐标系');
  }
  return { samples };
}

export function sampleVideoPos(source: VideoPosSource, time: number, maxGapSeconds = 5): VideoPosSample {
  const samples = source.samples;
  if (!Number.isFinite(time) || !samples.length || time < samples[0].time - 1e-6 || time > samples.at(-1)!.time + 1e-6) throw new Error(`POS 未覆盖视频 ${time.toFixed(3)} 秒，请调整抽帧范围或补充真实定位数据`);
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (samples[mid].time < time - 1e-6) lo = mid + 1; else hi = mid; }
  const b = samples[lo];
  if (Math.abs(time - b.time) <= 1e-6) return { ...b, time };
  const a = samples[lo - 1], gap = b.time - a.time;
  if (gap > maxGapSeconds) throw new Error(`POS 在 ${a.time.toFixed(3)}–${b.time.toFixed(3)} 秒缺少连续定位，未插值生成虚假先验`);
  const fraction = (time - a.time) / gap, linear = (x: number, y: number) => x + (y - x) * fraction;
  const angle = (x?: number, y?: number) => x === undefined || y === undefined ? undefined : x + (((y - x + 180) % 360 + 360) % 360 - 180) * fraction;
  return { time, coordinateSystem: a.coordinateSystem, x: linear(a.x, b.x), y: linear(a.y, b.y), z: linear(a.z, b.z), yaw: angle(a.yaw, b.yaw), pitch: angle(a.pitch, b.pitch), roll: angle(a.roll, b.roll) };
}
const escapeCsv = (value: string) => /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
export function createVideoFramePosCsv(frames: readonly VideoExtractedFrame[], source?: VideoPosSource): string {
  const rows = frames.map(frame => {
    if (!source) return `${escapeCsv(frame.filename)},,,,,,,`;
    const sample = sampleVideoPos(source, frame.mediaTime);
    return [frame.filename, sample.coordinateSystem, sample.x, sample.y, sample.z, sample.yaw, sample.pitch, sample.roll]
      .map(value => value === undefined ? '' : escapeCsv(typeof value === 'number' ? String(Number(value.toFixed(9))) : value)).join(',');
  });
  return `\uFEFF${VIDEO_POS_HEADER}\r\n${rows.join('\r\n')}\r\n`;
}
