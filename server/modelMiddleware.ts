import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_KILL_WAIT_MS = 8_000;
const DEFAULT_TIMEOUT_MINUTES = 30;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 120;
const FORMATS = ["dwg", "rvt", "skp"] as const;
const supported = new Set(["glb", ...FORMATS]);

type ConverterFormat = typeof FORMATS[number];
type Converter = { executable: string; args: string[]; timeoutMinutes?: number; validated?: boolean };
type ConverterConfig = Partial<Record<ConverterFormat, Converter>>;
type ReadyConverter = { executable: string; args: string[]; timeoutMs: number };
type ConverterInspection = {
  available: boolean;
  reason: string;
  details: string[];
  converter?: ReadyConverter;
};

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

class ClientDisconnectedError extends Error {
  constructor() {
    super("客户端已取消模型上传或转换");
    this.name = "ClientDisconnectedError";
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function safeName(name: string) {
  return basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180) || "model";
}

function isContainedBy(parent: string, candidate: string) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function safeRemoveJob(cacheRoot: string, jobRoot: string) {
  if (!isContainedBy(cacheRoot, jobRoot) || resolve(cacheRoot) === resolve(jobRoot)) return;
  try { await rm(jobRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  catch (error) { console.warn("[models] 无法清理失败的转换任务目录", error); }
}

function loadConfig(configPath: string): { config: ConverterConfig; error?: string } {
  if (!existsSync(configPath)) return { config: {}, error: "未找到 model-converters.json" };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: {}, error: "model-converters.json 顶层必须是对象" };
    }
    return { config: parsed as ConverterConfig };
  } catch (error) {
    return { config: {}, error: `model-converters.json 无法解析：${error instanceof Error ? error.message : String(error)}` };
  }
}

function inspectConverter(format: ConverterFormat, loaded: ReturnType<typeof loadConfig>): ConverterInspection {
  const details: string[] = [];
  if (loaded.error) return { available: false, reason: loaded.error, details };
  const configured = loaded.config[format];
  if (!configured) return { available: false, reason: `${format.toUpperCase()} 转换器尚未配置`, details };
  if (configured.validated !== true) {
    return {
      available: false,
      reason: `${format.toUpperCase()} 转换器尚未通过本机验证`,
      details: ["请先完成转换器许可、首次启动和测试转换，再将 validated 设为 true"],
    };
  }
  if (typeof configured.executable !== "string" || !configured.executable.trim()) {
    return { available: false, reason: "转换器 executable 不能为空", details };
  }
  const executable = configured.executable.trim();
  if (!isAbsolute(executable)) return { available: false, reason: "转换器 executable 必须使用绝对路径", details };
  try {
    if (!statSync(executable).isFile()) return { available: false, reason: "转换器 executable 不是文件", details };
  } catch {
    return { available: false, reason: "转换器 executable 文件不存在或无法访问", details };
  }
  const executableExtension = extname(executable).toLowerCase();
  if ((executableExtension === ".cmd" || executableExtension === ".bat") && process.platform !== "win32") {
    return { available: false, reason: "CMD/BAT 转换器只能在 Windows 上运行", details };
  }
  if (!Array.isArray(configured.args) || configured.args.length > 64 || configured.args.some((item) => typeof item !== "string" || item.length > 4096 || /[\0\r\n]/.test(item))) {
    return { available: false, reason: "转换器 args 配置无效", details: ["参数必须是最多64项的字符串数组，且不能包含换行或空字符"] };
  }
  const joinedArguments = configured.args.join("\n");
  if (!joinedArguments.includes("{input}") || !joinedArguments.includes("{output}")) {
    return { available: false, reason: "转换器参数必须同时包含 {input} 和 {output}", details };
  }
  if ((executableExtension === ".cmd" || executableExtension === ".bat")
    && (executable.includes("%") || configured.args.some((item) => /[%&|<>]/.test(item.replaceAll("{input}", "").replaceAll("{output}", ""))))) {
    return { available: false, reason: "CMD/BAT 转换器路径或固定参数包含不安全的命令字符", details };
  }
  const requestedTimeout = Number(configured.timeoutMinutes);
  const timeoutMinutes = Number.isFinite(requestedTimeout)
    ? Math.max(MIN_TIMEOUT_MINUTES, Math.min(MAX_TIMEOUT_MINUTES, requestedTimeout))
    : DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(requestedTimeout)) details.push(`未设置有效超时，使用默认 ${DEFAULT_TIMEOUT_MINUTES} 分钟`);
  else if (requestedTimeout !== timeoutMinutes) details.push(`超时已限制为 ${timeoutMinutes} 分钟`);
  details.push(executableExtension === ".cmd" || executableExtension === ".bat" ? "Windows 命令脚本" : "本机可执行程序");
  return {
    available: true,
    reason: "转换器已配置并通过人工验证标记",
    details,
    converter: { executable, args: [...configured.args], timeoutMs: timeoutMinutes * 60_000 },
  };
}

function contentLength(request: IncomingMessage) {
  const header = request.headers["content-length"];
  if (header === undefined) return undefined;
  if (Array.isArray(header) || !/^\d+$/.test(header)) throw new RequestError(400, "Content-Length 请求头无效");
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) throw new RequestError(400, "上传文件大小无效");
  return bytes;
}

async function receiveUpload(request: IncomingMessage, destination: string, signal: AbortSignal) {
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) callback(new RequestError(413, "模型文件超过 1GB 上传限制"));
      else callback(null, chunk);
    },
  });
  await pipeline(request, counter, createWriteStream(destination, { flags: "wx" }), { signal });
  if (received === 0) throw new RequestError(400, "上传的模型文件为空");
}

function validateGlb(path: string) {
  const size = statSync(path).size;
  if (size < 20 || size > 0xffff_ffff) throw new Error("转换结果不是完整的 GLB 2.0 文件");
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.allocUnsafe(12);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) throw new Error("无法读取 GLB 文件头");
    if (header.toString("ascii", 0, 4) !== "glTF") throw new Error("转换结果缺少 GLB glTF 文件标识");
    if (header.readUInt32LE(4) !== 2) throw new Error("转换结果不是 GLB 2.0");
    if (header.readUInt32LE(8) !== size) throw new Error("GLB 声明长度与实际文件大小不一致");
  } finally {
    closeSync(descriptor);
  }
}

function appendProcessOutput(current: Buffer[], currentBytes: number, chunk: Buffer) {
  if (currentBytes >= MAX_PROCESS_OUTPUT_BYTES) return currentBytes;
  const remaining = MAX_PROCESS_OUTPUT_BYTES - currentBytes;
  current.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
  return currentBytes + Math.min(chunk.length, remaining);
}

function readableProcessOutput(chunks: Buffer[]) {
  const value = Buffer.concat(chunks).toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return value.length > 1500 ? value.slice(-1500) : value;
}

async function terminateProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const taskkill = join(systemRoot, "System32", "taskkill.exe");
    await new Promise<void>((resolveTermination) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolveTermination(); } };
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", finish);
      killer.once("close", finish);
      setTimeout(finish, PROCESS_KILL_WAIT_MS).unref();
    });
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* Best effort after taskkill. */ }
    }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* Process already exited. */ } }
  }
  if (child.exitCode === null) {
    await new Promise<void>((resolveExit) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolveExit(); } };
      child.once("close", finish);
      setTimeout(finish, PROCESS_KILL_WAIT_MS).unref();
    });
  }
}

function converterCommand(converter: ReadyConverter, args: string[]) {
  const extension = extname(converter.executable).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const commandProcessor = process.env.ComSpec || join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    return {
      executable: commandProcessor,
      args: ["/d", "/v:off", "/c", "call", converter.executable, ...args],
    };
  }
  return { executable: converter.executable, args };
}

function runConverter(converter: ReadyConverter, args: string[], cwd: string, signal: AbortSignal) {
  return new Promise<void>((resolveRun, rejectRun) => {
    if (signal.aborted) return rejectRun(signal.reason instanceof Error ? signal.reason : new ClientDisconnectedError());
    const command = converterCommand(converter, args);
    const child = spawn(command.executable, command.args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let completed = false;
    let stopping: Error | null = null;
    let termination: Promise<void> | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      cleanup();
      if (error) rejectRun(error); else resolveRun();
    };
    const stop = (error: Error) => {
      if (completed || stopping) return;
      stopping = error;
      termination = terminateProcessTree(child);
      void termination.then(() => finish(stopping ?? error));
    };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new ClientDisconnectedError());
    const timeout = setTimeout(() => stop(new RequestError(504, `模型转换超过 ${Math.round(converter.timeoutMs / 60_000)} 分钟，已终止整个转换进程树`)), converter.timeoutMs);
    timeout.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = appendProcessOutput(stdout, stdoutBytes, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = appendProcessOutput(stderr, stderrBytes, chunk); });
    child.once("error", (error) => finish(new Error(`无法启动本机模型转换器：${error.message}`)));
    child.once("close", (code, processSignal) => {
      if (completed) return;
      if (stopping) {
        void (termination ?? Promise.resolve()).then(() => finish(stopping ?? undefined));
        return;
      }
      if (code === 0) return finish();
      const output = readableProcessOutput(stderr) || readableProcessOutput(stdout);
      const suffix = output ? `：${output}` : "";
      finish(new Error(`本机模型转换器异常退出（代码 ${code ?? "未知"}${processSignal ? `，信号 ${processSignal}` : ""}）${suffix}`));
    });
  });
}

export function createModelMiddleware(projectRoot: string) {
  const cacheRoot = resolve(projectRoot, ".model-cache");
  const configPath = resolve(projectRoot, "model-converters.json");
  mkdirSync(cacheRoot, { recursive: true });
  let conversionBusy = false;

  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/__models/status") {
      const loaded = loadConfig(configPath);
      const inspections = Object.fromEntries(FORMATS.map((format) => [format, inspectConverter(format, loaded)])) as Record<ConverterFormat, ConverterInspection>;
      return sendJson(response, 200, {
        native: ["glb"],
        converters: Object.fromEntries(FORMATS.map((format) => [format, inspections[format].available])),
        converterStatus: Object.fromEntries(FORMATS.map((format) => [format, {
          available: inspections[format].available,
          reason: inspections[format].reason,
          details: inspections[format].details,
        }])),
        busy: conversionBusy,
        maxUploadBytes: MAX_UPLOAD_BYTES,
      });
    }

    if (requestUrl.pathname === "/__models/import" && request.method === "POST") {
      const extension = (requestUrl.searchParams.get("extension") ?? "").toLowerCase();
      const originalName = safeName(requestUrl.searchParams.get("name") ?? `model.${extension}`);
      if (!supported.has(extension)) return sendJson(response, 400, { ok: false, error: "仅支持 DWG、RVT、SKP 和 GLB" });

      let converter: ReadyConverter | undefined;
      let ownsConversionSlot = false;
      if (extension !== "glb") {
        const inspection = inspectConverter(extension as ConverterFormat, loadConfig(configPath));
        if (!inspection.available || !inspection.converter) {
          return sendJson(response, 422, {
            ok: false,
            error: `${extension.toUpperCase()} 本机转换器不可用：${inspection.reason}。Cesium 不能原生解析该格式。`,
            details: inspection.details,
          });
        }
        if (conversionBusy) return sendJson(response, 429, { ok: false, error: "已有模型正在转换，请等待当前任务完成后再试" });
        conversionBusy = true;
        ownsConversionSlot = true;
        converter = inspection.converter;
      }

      let declaredLength: number | undefined;
      try { declaredLength = contentLength(request); }
      catch (error) {
        if (ownsConversionSlot) conversionBusy = false;
        const requestError = error instanceof RequestError ? error : new RequestError(400, "上传请求无效");
        return sendJson(response, requestError.status, { ok: false, error: requestError.message });
      }
      if (declaredLength !== undefined && declaredLength > MAX_UPLOAD_BYTES) {
        if (ownsConversionSlot) conversionBusy = false;
        return sendJson(response, 413, { ok: false, error: "模型文件超过 1GB 上传限制" });
      }

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      const jobRoot = resolve(cacheRoot, id);
      if (!isContainedBy(cacheRoot, jobRoot) || jobRoot === cacheRoot) {
        if (ownsConversionSlot) conversionBusy = false;
        return sendJson(response, 500, { ok: false, error: "无法创建安全的模型转换任务目录" });
      }
      mkdirSync(jobRoot, { recursive: false });
      const input = resolve(jobRoot, originalName);
      const output = extension === "glb" ? input : resolve(jobRoot, `${basename(originalName, extname(originalName))}.glb`);
      if (!isContainedBy(jobRoot, input) || !isContainedBy(jobRoot, output)) {
        if (ownsConversionSlot) conversionBusy = false;
        await safeRemoveJob(cacheRoot, jobRoot);
        return sendJson(response, 400, { ok: false, error: "模型文件名或输出路径无效" });
      }

      const controller = new AbortController();
      const abortForClient = () => {
        if (!controller.signal.aborted) controller.abort(new ClientDisconnectedError());
      };
      const abortForResponseClose = () => {
        if (!response.writableEnded) abortForClient();
      };
      request.once("aborted", abortForClient);
      response.once("close", abortForResponseClose);
      request.socket.once("close", abortForResponseClose);
      let keepJob = false;
      try {
        await receiveUpload(request, input, controller.signal);
        if (extension !== "glb") {
          if (!converter) throw new Error("模型转换器状态已失效");
          const args = converter.args.map((argument) => argument.replaceAll("{input}", input).replaceAll("{output}", output));
          await runConverter(converter, args, jobRoot, controller.signal);
        }
        if (controller.signal.aborted || response.destroyed) throw controller.signal.reason ?? new ClientDisconnectedError();
        validateGlb(output);
        keepJob = true;
        return sendJson(response, 200, {
          ok: true,
          url: `/__models/files/${id}/${encodeURIComponent(basename(output))}`,
          converted: extension !== "glb",
        });
      } catch (error) {
        if (error instanceof ClientDisconnectedError || controller.signal.aborted || response.destroyed) return;
        const status = error instanceof RequestError ? error.status : 500;
        return sendJson(response, status, { ok: false, error: error instanceof Error ? error.message : "模型转换失败" });
      } finally {
        request.off("aborted", abortForClient);
        response.off("close", abortForResponseClose);
        request.socket.off("close", abortForResponseClose);
        if (ownsConversionSlot) conversionBusy = false;
        if (!keepJob) await safeRemoveJob(cacheRoot, jobRoot);
      }
    }

    const match = requestUrl.pathname.match(/^\/__models\/files\/([^/]+)\/(.+)$/);
    if (!match) return next();
    if (!/^[a-z0-9-]{8,64}$/i.test(match[1])) return sendJson(response, 404, { error: "模型文件不存在" });
    let fileName: string;
    try { fileName = decodeURIComponent(match[2]); }
    catch { return sendJson(response, 400, { error: "模型文件地址编码无效" }); }
    if (!fileName || basename(fileName) !== fileName) return sendJson(response, 404, { error: "模型文件不存在" });
    const jobRoot = resolve(cacheRoot, match[1]);
    const requested = resolve(jobRoot, fileName);
    if (!isContainedBy(cacheRoot, jobRoot) || !isContainedBy(jobRoot, requested)) return sendJson(response, 404, { error: "模型文件不存在" });
    try {
      if (!statSync(requested).isFile()) return sendJson(response, 404, { error: "模型文件不存在" });
    } catch { return sendJson(response, 404, { error: "模型文件不存在" }); }
    response.statusCode = 200;
    response.setHeader("Content-Type", "model/gltf-binary");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Cookie");
    createReadStream(requested).pipe(response);
  };
}
