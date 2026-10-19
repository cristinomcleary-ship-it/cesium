/** Small, seekable WebM muxer for offline WebCodecs VP8/VP9 + optional Opus. */
type Bytes = Uint8Array<ArrayBuffer>;
export type WebmPacket = { data: Bytes; timestamp: number; duration?: number; key: boolean; track: 1 | 2 };
export type WebmSettings = { width: number; height: number; frameRate: number; duration: number; codec: 'V_VP8' | 'V_VP9'; audio?: { channels: number; sampleRate: number; description?: Bytes }; maxBytes: number };
const utf8 = (text: string) => new TextEncoder().encode(text);
function concat(parts: readonly Bytes[]): Bytes { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function uint(value: number): Bytes { let n = BigInt(Math.round(value)), width = 1; while (n >= 1n << BigInt(8 * width)) width++; const result = new Uint8Array(width); for (let i = width - 1; i >= 0; i--) { result[i] = Number(n & 255n); n >>= 8n; } return result; }
function size(value: number): Bytes { let width = 1; while (BigInt(value) >= (1n << BigInt(7 * width)) - 1n) width++; let n = BigInt(value) | 1n << BigInt(7 * width); const result = new Uint8Array(width); for (let i = width - 1; i >= 0; i--) { result[i] = Number(n & 255n); n >>= 8n; } return result; }
function element(id: number, data: Bytes): Bytes { return concat([uint(id), size(data.length), data]); }
const master = (id: number, children: Bytes[]) => element(id, concat(children));
const number = (id: number, value: number) => element(id, uint(value));
const string = (id: number, value: string) => element(id, utf8(value));
function floating(id: number, value: number) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value); return element(id, bytes); }
function opusHead(channels: number): Bytes { const bytes = new Uint8Array(19); bytes.set(utf8('OpusHead')); bytes[8] = 1; bytes[9] = channels; new DataView(bytes.buffer).setUint32(12, 48000, true); return bytes; }

export function muxVideoOverlayWebm(settings: WebmSettings, packets: readonly WebmPacket[]): Blob {
  const header = master(0x1a45dfa3, [number(0x4286, 1), number(0x42f7, 1), number(0x42f2, 4), number(0x42f3, 8), string(0x4282, 'webm'), number(0x4287, 4), number(0x4285, 2)]);
  const info = master(0x1549a966, [number(0x2ad7b1, 1_000_000), string(0x4d80, 'Cesium AR offline'), string(0x5741, 'WebCodecs'), floating(0x4489, settings.duration * 1000)]);
  const video = master(0xae, [number(0xd7, 1), number(0x73c5, 1), number(0x83, 1), number(0x9c, 0), string(0x86, settings.codec), number(0x23e383, 1e9 / settings.frameRate), master(0xe0, [number(0xb0, settings.width), number(0xba, settings.height)])]);
  const tracks = [video];
  if (settings.audio) {
    const audio = settings.audio, description = audio.description?.length ? audio.description : opusHead(audio.channels);
    const preSkip = description.length >= 12 ? new DataView(description.buffer, description.byteOffset).getUint16(10, true) : 0;
    tracks.push(master(0xae, [number(0xd7, 2), number(0x73c5, 2), number(0x83, 2), number(0x9c, 0), string(0x86, 'A_OPUS'), element(0x63a2, description), number(0x56aa, preSkip / 48000 * 1e9), number(0x56bb, 80_000_000), master(0xe1, [floating(0xb5, audio.sampleRate), number(0x9f, audio.channels)])]));
  }
  const trackInfo = master(0x1654ae6b, tracks), clusters: Blob[] = [], cues: Bytes[] = [];
  const sorted = [...packets].sort((a, b) => a.timestamp - b.timestamp || a.track - b.track);
  let position = info.length + trackInfo.length, offset = 0;
  while (offset < sorted.length) {
    const time = Math.max(0, Math.floor(sorted[offset].timestamp / 1000)), children: BlobPart[] = [number(0xe7, time)]; let cue: number | undefined;
    while (offset < sorted.length && sorted[offset].timestamp / 1000 - time < 2000) {
      const packet = sorted[offset++], relative = Math.round(packet.timestamp / 1000) - time;
      if (relative < -32768 || relative > 32767) throw new Error('WebM 帧时间超出簇范围');
      const block = new Uint8Array(4); block[0] = 0x80 | packet.track;
      new DataView(block.buffer).setInt16(1, relative); block[3] = packet.key ? 0x80 : 0;
      if (packet.track === 1 && packet.duration !== undefined && packet.duration < 1e6 / settings.frameRate - 1) {
        // A fractional final frame has its true duration instead of a padded
        // full frame. The encoder explicitly makes this last frame a keyframe.
        block[3] = 0; // BlockGroup marks keyframes through the absence of references.
        const group = new Blob([uint(0xa1), size(4 + packet.data.length), block, packet.data, number(0x9b, Math.max(1, Math.round(packet.duration / 1000)))]);
        children.push(uint(0xa0), size(group.size), group);
      } else children.push(uint(0xa3), size(4 + packet.data.length), block, packet.data);
      if (packet.track === 1 && packet.key && cue === undefined) cue = Math.max(0, Math.round(packet.timestamp / 1000));
    }
    const payload = new Blob(children), cluster = new Blob([uint(0x1f43b675), size(payload.size), payload]); clusters.push(cluster);
    if (cue !== undefined) cues.push(master(0xbb, [number(0xb3, cue), master(0xb7, [number(0xf7, 1), number(0xf1, position)])]));
    position += cluster.size;
    if (position > settings.maxBytes) throw new Error('导出文件达到大小上限，请缩短范围或降低分辨率');
  }
  const cueInfo = master(0x1c53bb6b, cues);
  const length = position + cueInfo.length;
  const blob = new Blob([header, uint(0x18538067), size(length), info, trackInfo, ...clusters, cueInfo], { type: 'video/webm' });
  if (blob.size > settings.maxBytes) throw new Error('导出文件达到大小上限，请缩短范围或降低分辨率');
  return blob;
}
