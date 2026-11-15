import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpBoundaryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function privateJson(response: ServerResponse, status: number, payload: unknown) {
  if (response.destroyed || response.headersSent) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Vary', 'Cookie');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
}

/** Count bytes, not characters. Oversized/slow requests are rejected without
 * parsing a valid prefix; drain remaining input without retaining it. */
export function boundedJson(request: IncomingMessage, limit: number, timeoutMs = 10_000): Promise<unknown> {
  const drain = () => {
    if (request.closed) return;
    const ignoreError = () => {};
    request.on('error', ignoreError); request.once('close', () => request.off('error', ignoreError)); request.resume();
  };
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    drain();
    return Promise.reject(new HttpBoundaryError(415, '请求必须为 JSON'));
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    drain();
    return Promise.reject(new HttpBoundaryError(413, '请求超过大小限制'));
  }
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks: Buffer[] = [];
    const stop = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('aborted', aborted);
      // IncomingMessage emits 'aborted' before a subsequent 'error'. Keep its
      // error observer until close so cancelling a body never crashes the host.
      if (error) { chunks.length = 0; request.resume(); reject(error); } else resolve(value);
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) stop(new HttpBoundaryError(413, '请求超过大小限制')); else chunks.push(buffer);
    };
    const end = () => {
      try { stop(undefined, JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
      catch { stop(new HttpBoundaryError(400, 'JSON 格式无效')); }
    };
    const aborted = () => stop(new HttpBoundaryError(400, '请求已中断'));
    const failed = () => stop(new HttpBoundaryError(400, '请求读取失败'));
    const closed = () => { request.off('error', failed); if (!settled) aborted(); };
    const timer = setTimeout(() => stop(new HttpBoundaryError(408, '请求读取超时')), timeoutMs);
    request.on('data', data); request.on('end', end); request.on('aborted', aborted); request.on('error', failed); request.once('close', closed);
  });
}

export function assertSameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpBoundaryError(403, '不允许跨站访问');
  if (!origin) return; // Authenticated non-browser clients have no Origin header.
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.host !== request.headers.host || url.username || url.password)
      throw new Error();
  } catch { throw new HttpBoundaryError(403, '不允许跨站访问'); }
}
