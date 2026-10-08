import { modelOptimizationPlugin } from "./server/modelOptimization";
import { safetyEventPlugin } from "./server/safetyEventStore";
import { safetySpatialPlugin } from "./server/safetySpatialStore";
import { defineConfig } from "vite";
import { createProjectLibrary } from "./server/projectLibrary";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync, open as openAsync, stat as statAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createModelMiddleware } from "./server/modelMiddleware";
import { createLocalImageryMiddleware } from "./server/localImageryMiddleware";

type BoundingVolume = { sphere?: number[]; box?: number[]; region?: number[] };
type TileNode = {
  boundingVolume?: BoundingVolume;
  transform?: number[];
  geometricError?: number;
  refine?: string;
  content?: { uri?: string; url?: string };
  contents?: Array<{ uri?: string; url?: string }>;
  children?: TileNode[];
};

type TilesetDocument = {
  asset?: { version?: string };
  geometricError?: number;
  root?: TileNode;
};

type TilesetCandidate = {
  path: string;
  document: TilesetDocument;
  referencedJson: Set<string>;
  contentExtensions: Set<string>;
  nodeCount: number;
};

type Mount = { root: string; entry: string; aggregate?: TilesetDocument };
const localMounts = new Map<string, Mount>();

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.end(JSON.stringify(payload));
}

function collectCandidateJson(folder: string, depth = 0, output: string[] = []): string[] {
  if (depth > 10 || output.length >= 20_000) return output;
  for (const item of readdirSync(folder, { withFileTypes: true })) {
    if (output.length >= 20_000) break;
    const fullPath = join(folder, item.name);
    if (item.isDirectory() && !item.isSymbolicLink()) collectCandidateJson(fullPath, depth + 1, output);
    else if (item.isFile() && item.name.toLowerCase().endsWith(".json")) output.push(fullPath);
  }
  return output;
}

const unsupportedCesiumContent = new Set([".osgb", ".osg", ".3mx", ".3mxb", ".obj", ".fbx"]);

function inspectTileTree(tile: TileNode | undefined, baseFolder: string, referencedJson: Set<string>, contentExtensions: Set<string>): number {
  if (!tile) return 0;
  const contents = [tile.content, ...(tile.contents ?? [])];
  for (const content of contents) {
    const rawUri = content?.uri ?? content?.url;
    if (!rawUri) continue;
    const cleanUri = rawUri.split(/[?#]/, 1)[0].replace(/\\/g, "/");
    const extension = extname(cleanUri).toLowerCase();
    if (extension) contentExtensions.add(extension);
    if (/^[a-z]+:/i.test(rawUri)) continue;
    if (!cleanUri.toLowerCase().endsWith(".json")) continue;
    try { referencedJson.add(resolve(baseFolder, decodeURIComponent(cleanUri))); }
    catch { referencedJson.add(resolve(baseFolder, cleanUri)); }
  }
  return 1 + (tile.children ?? []).reduce((total, child) => total + inspectTileTree(child, baseFolder, referencedJson, contentExtensions), 0);
}

function readTilesetCandidate(candidatePath: string): TilesetCandidate | undefined {
  try {
    const document = JSON.parse(readFileSync(candidatePath, "utf8")) as TilesetDocument;
    if (!document.asset || !document.root) return undefined;
    const referencedJson = new Set<string>();
    const contentExtensions = new Set<string>();
    const nodeCount = inspectTileTree(document.root, dirname(candidatePath), referencedJson, contentExtensions);
    return { path: resolve(candidatePath), document, referencedJson, contentExtensions, nodeCount };
  } catch {
    return undefined;
  }
}

function unsupportedCandidateFormats(candidate: TilesetCandidate): string[] {
  return [...candidate.contentExtensions].filter((extension) => unsupportedCesiumContent.has(extension));
}

function isBrowserTileset(candidate: TilesetCandidate): boolean {
  return unsupportedCandidateFormats(candidate).length === 0;
}

function pathDepth(root: string, target: string): number {
  const value = relative(root, target);
  return value ? value.split(sep).length : 0;
}

function encodeRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).map(encodeURIComponent).join("/");
}

type Sphere = [number, number, number, number];

function transformPoint(matrix: number[], point: number[]): [number, number, number] {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function transformVector(matrix: number[], vector: number[]): [number, number, number] {
  return [
    matrix[0] * vector[0] + matrix[4] * vector[1] + matrix[8] * vector[2],
    matrix[1] * vector[0] + matrix[5] * vector[1] + matrix[9] * vector[2],
    matrix[2] * vector[0] + matrix[6] * vector[1] + matrix[10] * vector[2],
  ];
}

function vectorLength(value: number[]) {
  return Math.hypot(value[0], value[1], value[2]);
}

function cartographicToCartesian(longitude: number, latitude: number, height: number): [number, number, number] {
  const semiMajor = 6378137;
  const eccentricitySquared = 6.69437999014e-3;
  const sinLatitude = Math.sin(latitude);
  const primeVertical = semiMajor / Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);
  return [
    (primeVertical + height) * Math.cos(latitude) * Math.cos(longitude),
    (primeVertical + height) * Math.cos(latitude) * Math.sin(longitude),
    (primeVertical * (1 - eccentricitySquared) + height) * sinLatitude,
  ];
}

function sphereFromPoints(points: number[][]): Sphere | undefined {
  if (!points.length) return undefined;
  let minX = points[0]; let maxX = points[0];
  let minY = points[0]; let maxY = points[0];
  let minZ = points[0]; let maxZ = points[0];
  for (const point of points) {
    if (point[0] < minX[0]) minX = point; if (point[0] > maxX[0]) maxX = point;
    if (point[1] < minY[1]) minY = point; if (point[1] > maxY[1]) maxY = point;
    if (point[2] < minZ[2]) minZ = point; if (point[2] > maxZ[2]) maxZ = point;
  }
  const pairs = [[minX, maxX], [minY, maxY], [minZ, maxZ]];
  const diameter = pairs.reduce((best, pair) => vectorLength([pair[1][0] - pair[0][0], pair[1][1] - pair[0][1], pair[1][2] - pair[0][2]]) > vectorLength([best[1][0] - best[0][0], best[1][1] - best[0][1], best[1][2] - best[0][2]]) ? pair : best);
  const center: [number, number, number] = [(diameter[0][0] + diameter[1][0]) / 2, (diameter[0][1] + diameter[1][1]) / 2, (diameter[0][2] + diameter[1][2]) / 2];
  const radius = Math.max(...points.map((point) => vectorLength([point[0] - center[0], point[1] - center[1], point[2] - center[2]])));
  return [...center, radius];
}

function worldBoundingSphere(node: TileNode | undefined): Sphere | undefined {
  const volume = node?.boundingVolume;
  if (!volume) return undefined;
  const transform = node?.transform;
  if (volume.region?.length === 6) {
    const [west, south, east, north, minimumHeight, maximumHeight] = volume.region;
    const middleLongitude = west <= east ? (west + east) / 2 : (west + east + Math.PI * 2) / 2;
    const samples: number[][] = [];
    for (const longitude of [west, middleLongitude, east]) for (const latitude of [south, (south + north) / 2, north]) for (const height of [minimumHeight, maximumHeight]) samples.push(cartographicToCartesian(longitude, latitude, height));
    return sphereFromPoints(samples);
  }
  if (volume.sphere?.length === 4) {
    const [x, y, z, radius] = volume.sphere;
    if (!transform?.length) return [x, y, z, radius];
    const center = transformPoint(transform, [x, y, z]);
    const scale = Math.max(vectorLength(transformVector(transform, [1, 0, 0])), vectorLength(transformVector(transform, [0, 1, 0])), vectorLength(transformVector(transform, [0, 0, 1])));
    return [...center, radius * scale];
  }
  if (volume.box?.length === 12) {
    const center = volume.box.slice(0, 3);
    const axes = [volume.box.slice(3, 6), volume.box.slice(6, 9), volume.box.slice(9, 12)];
    const worldCenter = transform?.length ? transformPoint(transform, center) : center as [number, number, number];
    const worldAxes = transform?.length ? axes.map((axis) => transformVector(transform, axis)) : axes;
    return [...worldCenter, Math.sqrt(worldAxes.reduce((sum, axis) => sum + vectorLength(axis) ** 2, 0))];
  }
  return undefined;
}

function unionSpheres(spheres: Sphere[]): Sphere {
  if (!spheres.length) return [0, 0, 0, 10_000_000];
  let result = [...spheres[0]] as Sphere;
  for (const sphere of spheres.slice(1)) {
    const difference = [sphere[0] - result[0], sphere[1] - result[1], sphere[2] - result[2]];
    const distance = vectorLength(difference);
    if (distance + sphere[3] <= result[3]) continue;
    if (distance + result[3] <= sphere[3]) { result = [...sphere]; continue; }
    const radius = (result[3] + distance + sphere[3]) / 2;
    const shift = distance > 0 ? (radius - result[3]) / distance : 0;
    result = [result[0] + difference[0] * shift, result[1] + difference[1] * shift, result[2] + difference[2] * shift, radius];
  }
  return result;
}

function createAggregateTileset(root: string, candidates: TilesetCandidate[]): TilesetDocument {
  const childSpheres = candidates.map((candidate) => worldBoundingSphere(candidate.document.root));
  const children: TileNode[] = candidates.map((candidate, index) => ({
    // Convert each independent CC root volume to world coordinates. A globe-
    // sized volume here makes every production tile load at once and starves
    // visible 3D content and imagery requests.
    boundingVolume: { sphere: childSpheres[index] ?? [0, 0, 0, 10_000_000] },
    geometricError: candidate.document.geometricError ?? candidate.document.root?.geometricError ?? 0,
    refine: candidate.document.root?.refine,
    content: { uri: encodeRelativePath(root, candidate.path) },
  }));
  const maximumError = Math.max(0, ...children.map((child) => child.geometricError ?? 0));
  return {
    asset: { version: "1.1" },
    geometricError: maximumError,
    root: {
      boundingVolume: { sphere: unionSpheres(childSpheres.filter((sphere): sphere is Sphere => Boolean(sphere))) },
      geometricError: maximumError,
      refine: "ADD",
      children,
    },
  };
}

type TilesetResult = {
  entry: string;
  root: string;
  aggregate?: TilesetDocument;
  candidateCount: number;
  topLevelCount: number;
};

function findTileset(inputPath: string): TilesetResult | { error: string } {
  const selected = resolve(inputPath);
  if (!isAbsolute(selected) || !existsSync(selected)) return { error: "目录不存在，请检查完整路径" };
  const selectedIsFile = statSync(selected).isFile();
  const selectedFolder = selectedIsFile ? dirname(selected) : selected;
  // ContextCapture commonly puts the master JSON beside the Data folder.
  const mountRoot = selectedFolder.toLowerCase().endsWith(`${sep}data`) ? dirname(selectedFolder) : selectedFolder;

  // Most CC productions have one shallow master JSON. Resolve it before the
  // recursive scan so a large Data tree does not block the UI for seconds.
  const shallowJson = new Set<string>();
  if (selectedIsFile) shallowJson.add(selected);
  for (const folder of new Set([mountRoot, selectedFolder])) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.isFile() && item.name.toLowerCase().endsWith(".json")) shallowJson.add(join(folder, item.name));
    }
  }
  const selectedDataFolder = selectedFolder.toLowerCase().endsWith(`${sep}data`);
  const shallowInspected = [...shallowJson]
    .map(readTilesetCandidate)
    .filter((candidate): candidate is TilesetCandidate => Boolean(candidate));
  const shallowCandidates = shallowInspected
    .filter(isBrowserTileset)
    .filter((candidate) => selectedIsFile
      || !selectedDataFolder
      || dirname(candidate.path) === mountRoot
      || candidate.path.toLowerCase().endsWith(`${sep}tileset.json`)
      || candidate.referencedJson.size > 0
      || candidate.nodeCount > 1);
  if (shallowCandidates.length) {
    shallowCandidates.sort((left, right) => {
      const preferredDifference = Number(right.path.toLowerCase().endsWith(`${sep}tileset.json`)) - Number(left.path.toLowerCase().endsWith(`${sep}tileset.json`));
      return preferredDifference || (right.referencedJson.size + right.nodeCount) - (left.referencedJson.size + left.nodeCount);
    });
    const best = shallowCandidates[0];
    return { entry: best.path, root: mountRoot, candidateCount: shallowCandidates.length, topLevelCount: 1 };
  }

  const jsonFiles = selectedIsFile ? [selected, ...collectCandidateJson(mountRoot)] : collectCandidateJson(mountRoot);
  const inspectedCandidates: TilesetCandidate[] = [];
  const seen = new Set<string>();

  for (const candidatePath of jsonFiles) {
    const normalized = resolve(candidatePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const candidate = readTilesetCandidate(normalized);
    if (candidate) inspectedCandidates.push(candidate);
  }

  const candidates = inspectedCandidates.filter(isBrowserTileset);

  if (candidates.length) {
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path.toLowerCase()));
    const referencedPaths = new Set<string>();
    candidates.forEach((candidate) => candidate.referencedJson.forEach((reference) => {
      if (candidatePaths.has(reference.toLowerCase())) referencedPaths.add(reference.toLowerCase());
    }));
    let topLevel = candidates.filter((candidate) => !referencedPaths.has(candidate.path.toLowerCase()));
    if (!topLevel.length) topLevel = [...candidates];

    topLevel.sort((left, right) => {
      if (selectedIsFile && left.path === selected) return -1;
      if (selectedIsFile && right.path === selected) return 1;
      const depthDifference = pathDepth(mountRoot, left.path) - pathDepth(mountRoot, right.path);
      if (depthDifference) return depthDifference;
      const preferredDifference = Number(right.path.toLowerCase().endsWith(`${sep}tileset.json`)) - Number(left.path.toLowerCase().endsWith(`${sep}tileset.json`));
      if (preferredDifference) return preferredDifference;
      return (right.referencedJson.size + right.nodeCount) - (left.referencedJson.size + left.nodeCount);
    });

    const best = topLevel[0];
    const bestDepth = pathDepth(mountRoot, best.path);
    const looksLikeMaster = selectedIsFile || topLevel.length === 1 || bestDepth <= 1 && (best.referencedJson.size > 0 || best.nodeCount > 1);
    if (looksLikeMaster) {
      return { entry: best.path, root: mountRoot, candidateCount: candidates.length, topLevelCount: 1 };
    }

    const aggregate = createAggregateTileset(mountRoot, topLevel);
    return {
      entry: join(mountRoot, "__aggregate__.json"),
      root: mountRoot,
      aggregate,
      candidateCount: candidates.length,
      topLevelCount: topLevel.length,
    };
  }


  const unsupportedFormats = [...new Set(inspectedCandidates.flatMap(unsupportedCandidateFormats))];
  if (unsupportedFormats.length) {
    const detected = unsupportedFormats.map((extension) => extension.slice(1).toUpperCase()).join("、");
    return { error: `检测到 ${detected} 倾斜摄影成果，但这不是浏览器可直接显示的 Cesium 3D Tiles。请在 ContextCapture 中新建 Production，输出格式选择 Cesium 3D Tiles（生成 .b3dm/.json）后再加载。` };
  }

  const formats = new Set<string>();
  const sampleFiles = readdirSync(selectedFolder, { withFileTypes: true }).slice(0, 2000);
  sampleFiles.forEach((item) => { if (item.isFile()) formats.add(extname(item.name).toLowerCase()); });
  const detected = [...formats].filter(Boolean).join("、") || "未识别";
  return { error: `没有找到有效的 3D Tiles 入口 JSON（检测到：${detected}）。如果这是 OSGB 或 3MX，请在 ContextCapture 中重新生产为 Cesium 3D Tiles。` };
}

function contentType(filePath: string): string {
  const types: Record<string, string> = { ".json": "application/json", ".b3dm": "application/octet-stream", ".i3dm": "application/octet-stream", ".pnts": "application/octet-stream", ".cmpt": "application/octet-stream", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".ktx2": "image/ktx2" };
  return types[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function localTilesMiddleware(request: IncomingMessage, response: ServerResponse, next: () => void) {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/__local_tiles/mount" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 16_384) request.destroy(); });
    request.on("end", () => {
      try {
        const path = (JSON.parse(body) as { path?: string }).path?.trim();
        if (!path) return json(response, 400, { ok: false, error: "未提供目录路径" });
        const found = findTileset(path);
        if ("error" in found) return json(response, 400, { ok: false, error: found.error });
        const id = Math.random().toString(36).slice(2, 10);
        localMounts.set(id, { root: found.root, entry: found.entry, aggregate: found.aggregate });
        const entryRelative = encodeRelativePath(found.root, found.entry);
        const relativeUrl = `/__local_tiles/files/${id}/${entryRelative}`;
        const requestHost = request.headers.host ?? "localhost:5173";
        const priorityHost = requestHost.toLowerCase().startsWith("localhost:")
          ? `127.0.0.1:${requestHost.split(":").pop()}`
          : requestHost.toLowerCase().startsWith("127.0.0.1:")
            ? `localhost:${requestHost.split(":").pop()}`
            : "";
        return json(response, 200, {
          ok: true,
          entry: found.entry,
          // A second loopback hostname gives local 3D Tiles an independent
          // Cesium RequestScheduler pool from slow online basemap requests.
          url: priorityHost ? `http://${priorityHost}${relativeUrl}` : relativeUrl,
          candidateCount: found.candidateCount,
          topLevelCount: found.topLevelCount,
          aggregate: Boolean(found.aggregate),
        });
      } catch (error) { return json(response, 500, { ok: false, error: error instanceof Error ? error.message : "目录检测失败" }); }
    });
    return;
  }

  const match = requestUrl.pathname.match(/^\/__local_tiles\/files\/([^/]+)\/(.+)$/);
  if (!match) return next();
  const mount = localMounts.get(match[1]);
  if (!mount) return json(response, 404, { error: "目录挂载已失效，请重新加载" });
  if (decodeURIComponent(match[2]) === "__aggregate__.json" && mount.aggregate) {
    return json(response, 200, mount.aggregate);
  }
  const requested = resolve(mount.root, decodeURIComponent(match[2]));
  const relativePath = relative(mount.root, requested);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || !existsSync(requested) || !statSync(requested).isFile()) return json(response, 404, { error: "文件不存在" });
  const fileStats = statSync(requested);
  response.statusCode = 200;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", contentType(requested));
  response.setHeader("Content-Length", fileStats.size);
  response.setHeader("Last-Modified", fileStats.mtime.toUTCString());
  response.setHeader("Cache-Control", extname(requested).toLowerCase() === ".json" ? "no-cache" : "public, max-age=86400, immutable");
  createReadStream(requested).pipe(response);
}

const basemapCacheRoot = resolve(process.cwd(), ".basemap-cache");
const renderErrorRoot = resolve(process.cwd(), ".render-errors");
mkdirSync(basemapCacheRoot, { recursive: true });
mkdirSync(renderErrorRoot, { recursive: true });
const pendingBasemapTiles = new Map<string, Promise<{ content: Buffer; contentType: string }>>();
const basemapWaiters: Array<() => void> = [];
let activeBasemapRequests = 0;

async function withBasemapSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeBasemapRequests >= 8) await new Promise<void>((resolveSlot) => basemapWaiters.push(resolveSlot));
  activeBasemapRequests += 1;
  try { return await task(); }
  finally {
    activeBasemapRequests -= 1;
    basemapWaiters.shift()?.();
  }
}

async function fetchBasemapTile(source: string, z: number, y: number, x: number, cacheFile: string) {
  const existing = pendingBasemapTiles.get(cacheFile);
  if (existing) return existing;
  const pending = withBasemapSlot(async () => {
    const upstreams = source === "esri"
      ? [
          `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
          `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
        ]
      : [
          `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
          `https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
          `https://${["a", "b", "c"][(x + y) % 3]}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
        ];
    let lastError: unknown;
    for (const upstream of upstreams) {
      try {
        const result = await fetch(upstream, {
          headers: { "User-Agent": "CesiumEngineeringViewer/1.0" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!result.ok) { lastError = new Error(`上游底图返回 ${result.status}`); continue; }
        const content = Buffer.from(await result.arrayBuffer());
        const contentType = result.headers.get("content-type") ?? (source === "esri" ? "image/jpeg" : "image/png");
        await mkdirAsync(dirname(cacheFile), { recursive: true });
        await writeFileAsync(cacheFile, content);
        return { content, contentType };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error("所有底图服务均不可用");
  });
  pendingBasemapTiles.set(cacheFile, pending);
  try { return await pending; }
  finally { pendingBasemapTiles.delete(cacheFile); }
}

async function cachedBasemapContentType(cacheFile: string): Promise<string> {
  const handle = await openAsync(cacheFile, "r");
  try {
    const signature = Buffer.allocUnsafe(8);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead >= 2 && signature[0] === 0xff && signature[1] === 0xd8 ? "image/jpeg" : "image/png";
  } finally {
    await handle.close();
  }
}

async function basemapAndDiagnosticsMiddleware(request: IncomingMessage, response: ServerResponse, next: () => void) {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/__diagnostics/render-error" && request.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 1024 * 1024) chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as unknown;
        const content = `${JSON.stringify(parsed, null, 2)}\n`;
        writeFileSync(join(renderErrorRoot, "latest.json"), content, "utf8");
        writeFileSync(join(renderErrorRoot, `${Date.now()}.json`), content, "utf8");
        return json(response, 200, { ok: true });
      } catch (error) {
        return json(response, 400, { ok: false, error: error instanceof Error ? error.message : "诊断记录无效" });
      }
    });
    return;
  }
  if (requestUrl.pathname === "/__diagnostics/render-error/latest" && request.method === "GET") {
    const latest = join(renderErrorRoot, "latest.json");
    if (!existsSync(latest)) return json(response, 404, { ok: false, error: "暂无渲染异常记录" });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    return createReadStream(latest).pipe(response);
  }

  const tile = requestUrl.pathname.match(/^\/__basemap\/(esri|osm)\/(\d+)\/(\d+)\/(\d+)$/);
  if (!tile) return next();
  const [, source, zText, yText, xText] = tile;
  const z = Number(zText); const y = Number(yText); const x = Number(xText);
  const maximum = 2 ** z;
  const maximumLevel = 19;
  if (!Number.isInteger(z) || z < 0 || z > maximumLevel || x < 0 || y < 0 || x >= maximum || y >= maximum) {
    return json(response, 400, { ok: false, error: "瓦片坐标无效" });
  }
  const extension = source === "esri" ? ".jpg" : ".png";
  const cacheFile = join(basemapCacheRoot, source, String(z), String(y), `${x}${extension}`);
  try {
    const cached = await statAsync(cacheFile);
    if (cached.isFile() && cached.size > 0) {
      const cachedContentType = await cachedBasemapContentType(cacheFile);
      response.statusCode = 200;
      response.setHeader("Content-Type", cachedContentType);
      response.setHeader("Cache-Control", "public, max-age=2592000, immutable");
      return createReadStream(cacheFile).pipe(response);
    }
  } catch {
    // Cache miss: fetch below. The hot cache path remains fully asynchronous.
  }
  try {
    const { content, contentType: tileContentType } = await fetchBasemapTile(source, z, y, x, cacheFile);
    response.statusCode = 200;
    response.setHeader("Content-Type", tileContentType);
    response.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    response.end(content);
  } catch (error) {
    return json(response, 502, { ok: false, error: error instanceof Error ? error.message : "底图代理请求失败" });
  }
}

const basemapAndDiagnosticsPlugin = {
  name: "basemap-and-render-diagnostics",
  configureServer(server: { middlewares: { use: (handler: typeof basemapAndDiagnosticsMiddleware) => void } }) { server.middlewares.use(basemapAndDiagnosticsMiddleware); },
  configurePreviewServer(server: { middlewares: { use: (handler: typeof basemapAndDiagnosticsMiddleware) => void } }) { server.middlewares.use(basemapAndDiagnosticsMiddleware); },
};

const localTilesPlugin = {
  name: "local-cc-tiles",
  configureServer(server: { middlewares: { use: (handler: typeof localTilesMiddleware) => void } }) { server.middlewares.use(localTilesMiddleware); },
  configurePreviewServer(server: { middlewares: { use: (handler: typeof localTilesMiddleware) => void } }) { server.middlewares.use(localTilesMiddleware); },
};

const engineeringModelsPlugin = {
  name: "engineering-models",
  configureServer(server: { middlewares: { use: (handler: ReturnType<typeof createModelMiddleware>) => void } }) { server.middlewares.use(createModelMiddleware(process.cwd())); },
  configurePreviewServer(server: { middlewares: { use: (handler: ReturnType<typeof createModelMiddleware>) => void } }) { server.middlewares.use(createModelMiddleware(process.cwd())); },
};

const localImageryPlugin = {
  name: "local-imagery",
  configureServer(server: { middlewares: { use: (handler: ReturnType<typeof createLocalImageryMiddleware>) => void } }) { server.middlewares.use(createLocalImageryMiddleware(process.cwd())); },
  configurePreviewServer(server: { middlewares: { use: (handler: ReturnType<typeof createLocalImageryMiddleware>) => void } }) { server.middlewares.use(createLocalImageryMiddleware(process.cwd())); },
};

const projectLibraryPlugin = {
  name: "persistent-project-library",
  configureServer(server: { middlewares: { use: (handler: ReturnType<typeof createProjectLibrary>["middleware"]) => void } }) { server.middlewares.use(createProjectLibrary(process.cwd(), { resolveTiles: findTileset, storageRoot: process.env.CESIUM_DATA_DIR }).middleware); },
  configurePreviewServer(server: { middlewares: { use: (handler: ReturnType<typeof createProjectLibrary>["middleware"]) => void } }) { server.middlewares.use(createProjectLibrary(process.cwd(), { resolveTiles: findTileset, storageRoot: process.env.CESIUM_DATA_DIR }).middleware); },
};

export default defineConfig({
  build: { rollupOptions: { input: { main: resolve(process.cwd(), "index.html"), arV2: resolve(process.cwd(), "ar-v2.html") } } },
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesiumStatic"),
  },
  server: {
    watch: {
      ignored: ["**/ar_v2/.venv/**", "**/output/**", "**/video_ar_backend/data/**", "**/video_ar_backend/.venv/**", "**/project-data/**", "**/.local-backups/**", "**/tmp/**"],
    },
  },
  plugins: [
    safetySpatialPlugin(),
    modelOptimizationPlugin(),
    safetyEventPlugin(),
    projectLibraryPlugin,
    basemapAndDiagnosticsPlugin,
    localImageryPlugin,
    engineeringModelsPlugin,
    localTilesPlugin,
    viteStaticCopy({
      targets: [
        { src: "node_modules/cesium/Build/Cesium/Workers", dest: "cesiumStatic" },
        { src: "node_modules/cesium/Build/Cesium/ThirdParty", dest: "cesiumStatic" },
        { src: "node_modules/cesium/Build/Cesium/Assets", dest: "cesiumStatic" },
        { src: "node_modules/cesium/Build/Cesium/Widgets", dest: "cesiumStatic" },
        { src: "node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm", dest: "libredwg" },
        { src: "node_modules/sql.js/dist/sql-wasm.wasm", dest: "sqljs" },
      ],
    }),
  ],
});
