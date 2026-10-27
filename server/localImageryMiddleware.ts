import { createReadStream, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

type LyrResult = {
  ok: boolean;
  error?: string;
  name?: string;
  source?: string;
  extension?: string;
  spatialReference?: string;
  bounds?: { west: number; south: number; east: number; north: number };
};

type TileChoice = { id: string; label: string; url: string };

const sources = new Map<string, string>();

function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function contentType(path: string) {
  const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff" };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function findArcPyPython(): string | null {
  const candidates = [
    "C:\\Python27\\ArcGIS10.8\\python.exe",
    "C:\\Python27\\ArcGIS10.7\\python.exe",
    "C:\\Python27\\ArcGIS10.6\\python.exe",
    "C:\\Python27\\ArcGIS10.5\\python.exe",
  ];
  return candidates.find(existsSync) ?? null;
}

function embeddedTileChoices(content: Buffer): TileChoice[] {
  const text = content.toString("utf16le");
  const pattern = /https:\/\/wayback\.maptiles\.arcgis\.com\/arcgis\/rest\/services\/World_Imagery\/WMTS\/1\.0\.0\/(?:default028mm|\{TileMatrixSet\})\/MapServer\/tile\/(\d+)\/(?:\{level\}|%7Blevel%7D|\{TileMatrix\})\/(?:\{row\}|%7Brow%7D|\{TileRow\})\/(?:\{col\}|%7Bcol%7D|\{TileCol\})/gi;
  const found = new Map<string, TileChoice>();
  for (const match of text.matchAll(pattern)) {
    const release = match[1];
    found.set(release, {
      id: release,
      label: `World Imagery 历史版本 ${release}`,
      url: `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${release}/{z}/{y}/{x}`,
    });
  }
  const urls = text.match(/https?:\/\/[^\u0000\s"<>]+/gi) ?? [];
  for (const rawUrl of urls) {
    if (!/(\{TileMatrix\}|%7BTileMatrix%7D)/i.test(rawUrl) || !/(\{TileRow\}|%7BTileRow%7D)/i.test(rawUrl) || !/(\{TileCol\}|%7BTileCol%7D)/i.test(rawUrl)) continue;
    const normalized = rawUrl
      .replace(/(?:\{TileMatrix\}|%7BTileMatrix%7D)/gi, "{z}")
      .replace(/(?:\{TileRow\}|%7BTileRow%7D)/gi, "{y}")
      .replace(/(?:\{TileCol\}|%7BTileCol%7D)/gi, "{x}")
      .replace(/&amp;/gi, "&");
    const id = `service-${found.size + 1}`;
    if (![...found.values()].some((item) => item.url === normalized)) {
      found.set(id, { id, label: `LYR 瓦片影像服务 ${found.size + 1}`, url: normalized });
    }
  }
  return [...found.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

export function createLocalImageryMiddleware(projectRoot: string) {
  const cache = resolve(projectRoot, ".local-imagery-cache");
  mkdirSync(cache, { recursive: true });
  const inspector = resolve(projectRoot, "server", "inspect_lyr.py");

  return function localImageryMiddleware(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/__local_imagery/lyr" && request.method === "POST") {
      const python = findArcPyPython();
      if (!python) return json(response, 501, { error: "未找到 ArcGIS Desktop ArcPy，无法解析二进制 LYR" });
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 50 * 1024 * 1024) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        const id = Math.random().toString(36).slice(2, 12);
        const lyrPath = join(cache, `${id}.lyr`);
        const content = Buffer.concat(chunks);
        writeFileSync(lyrPath, content);
        const cleanup = () => {
          try { rmSync(lyrPath, { force: true }); }
          catch (error) { console.warn("[local-imagery] 临时 LYR 副本清理失败", error); }
        };
        const choices = embeddedTileChoices(content);
        if (choices.length) {
          cleanup();
          return json(response, 200, {
            ok: true,
            kind: "tiles",
            name: "ArcGIS World Imagery 历史影像",
            choices,
          });
        }

        const child = spawn(python, [inspector, lyrPath], { cwd: projectRoot, windowsHide: true });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let finished = false;
        const finish = (status: number, payload: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          json(response, status, payload);
        };
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", (error) => { cleanup(); finish(500, { error: `ArcPy 启动失败：${error.message}` }); });
        child.on("close", () => {
          cleanup();
          if (finished) return;
          let result: LyrResult;
          try { result = JSON.parse(Buffer.concat(stdout).toString("utf8").trim() || "{}"); }
          catch { return finish(500, { error: Buffer.concat(stderr).toString("utf8").trim() || "ArcPy 没有返回有效结果" }); }
          if (!result.ok || !result.source || !result.bounds) return finish(400, { error: result.error || "LYR 解析失败" });
          sources.set(id, result.source);
          return finish(200, { ...result, kind: "raster", url: `/__local_imagery/files/${id}${result.extension || extname(result.source)}` });
        });
        const timer = setTimeout(() => {
          child.kill();
          finish(408, { error: "LYR 解析超时。它可能引用了失效的网络路径、数据库，或包含不受支持的复合图层。" });
        }, 30_000);
      });
      request.on("error", () => json(response, 400, { error: "LYR 文件读取中断" }));
      return;
    }

    const match = requestUrl.pathname.match(/^\/__local_imagery\/files\/([a-z0-9]+)(\.[a-z0-9]+)$/i);
    if (!match) return next();
    const source = sources.get(match[1]);
    if (!source || !existsSync(source)) return json(response, 404, { error: "LYR 引用的影像文件已不可用，请重新选择 LYR" });
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(source));
    response.setHeader("Cache-Control", "no-store");
    createReadStream(source).pipe(response);
  };
}
