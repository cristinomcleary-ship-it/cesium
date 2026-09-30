// Isolated browser regression for DJI MP4 + SRT trajectory projection.
// Run with PLAYWRIGHT_MODULE pointing to the installed Playwright package if
// it is not on Node's normal module search path. Real project-data is untouched.
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.VIDEO_AR_TEST_PORT || 5188);
const base = "http://127.0.0.1:" + port;
const runRoot = path.join(root, "tmp", "video-ar-browser-" + Date.now());
const dataRoot = path.join(runRoot, "project-data");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const pageErrors = [];
const webglErrors = [];
let server, browser, page;
let serverLog = "";
const deadline = setTimeout(() => {
  console.error("Video AR browser verification exceeded 240 seconds", runRoot);
  process.exitCode = 1;
  void browser?.close();
  server?.kill();
}, 240000);
deadline.unref();

async function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => output += data);
    child.stderr.on("data", data => output += data);
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(program + " exited " + code + "\n" + output)));
  });
}
async function start() {
  server = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root, env: { ...process.env, CESIUM_DATA_DIR: dataRoot },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", data => serverLog += data);
  server.stderr.on("data", data => serverLog += data);
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("Server exited: " + serverLog);
    try { if ((await fetch(base + "/__library/records", { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error("Isolated server did not start: " + serverLog);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once("exit", resolve));
  server.kill();
  await exited;
  server = null;
}
async function records() { return (await (await fetch(base + "/__library/records")).json()).records; }
async function until(description, action, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await action(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error("Timeout: " + description + " (last: " + JSON.stringify(last) + ")");
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1024 } });
  // Inspect the actual GPU path rather than relying on an optimistic UI label.
  await context.addInitScript(() => {
    window.videoArGpu = { linkedProjectivePrograms: 0, projectiveDraws: 0, failures: [] };
    window.videoArDecodedFrames = [];
    const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (requestFrame) HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
      return requestFrame.call(this, (time, metadata) => {
        window.videoArDecodedFrames.push({ mediaTime: metadata.mediaTime, currentTime: this.currentTime });
        if (window.videoArDecodedFrames.length > 60) window.videoArDecodedFrames.shift();
        callback(time, metadata);
      });
    };
    const sources = new WeakMap();
    const projectivePrograms = new WeakSet();
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
      if (!proto) continue;
      const shaderSource = proto.shaderSource;
      const compileShader = proto.compileShader;
      const linkProgram = proto.linkProgram;
      proto.shaderSource = function(shader, source) {
        sources.set(shader, source);
        return shaderSource.call(this, shader, source);
      };
      proto.compileShader = function(shader) {
        const result = compileShader.call(this, shader);
        if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
          window.videoArGpu.failures.push(this.getShaderInfoLog(shader) || "Shader compile failed");
        }
        return result;
      };
      proto.linkProgram = function(program) {
        const result = linkProgram.call(this, program);
        if (!this.getProgramParameter(program, this.LINK_STATUS)) {
          window.videoArGpu.failures.push(this.getProgramInfoLog(program) || "Program link failed");
        }
        const isProjection = (this.getAttachedShaders(program) || []).some(shader => (sources.get(shader) || "").includes("v_projectiveSt"));
        if (isProjection) {
          projectivePrograms.add(program);
          window.videoArGpu.linkedProjectivePrograms++;
        }
        return result;
      };
      for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
        if (typeof proto[name] !== "function") continue;
        const draw = proto[name];
        proto[name] = function(...args) {
          if (projectivePrograms.has(this.getParameter(this.CURRENT_PROGRAM))) window.videoArGpu.projectiveDraws++;
          return draw.apply(this, args);
        };
      }
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /shader|WebGL|rendering has stopped|compile|link program/i.test(message.text())) webglErrors.push(message.text());
  });
  page.on("dialog", dialog => dialog.accept());
  const mapImage = await fs.readFile(path.join(root, "node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg"));
  await page.route("**/__basemap/**", route => route.fulfill({ status: 200, contentType: "image/jpeg", body: mapImage }));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => document.querySelector("#libraryStatus")?.textContent?.includes("已保存到本机"));
  await page.locator('[data-tab="videoar"]').click();
  return context;
}
async function field(id, value) {
  const locator = page.locator("#" + id);
  await locator.evaluate(input => { let parent = input.parentElement; while (parent) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; } });
  await locator.fill(String(value));
  await locator.dispatchEvent("change");
}
async function openCalibration() {
  await page.locator(".video-ar-calibration").evaluate(element => { element.open = true; });
}
async function projectionReady() {
  await page.waitForFunction(() =>
    document.querySelector("#videoArPreview")?.getAttribute("data-texture-upload") === "stable"
    && document.querySelector("#videoArProjectionMode")?.textContent?.includes("相机射线网格")
    && window.videoArGpu.projectiveDraws > 0
  );
  const gpu = await page.evaluate(() => window.videoArGpu);
  assert.ok(gpu.linkedProjectivePrograms > 0, "Projective shader must actually link");
  assert.ok(gpu.projectiveDraws > 0, "Projective shader must actually draw");
  assert.deepEqual(gpu.failures, []);
  const preview = await page.locator("#videoArPreview").evaluate(container => {
    const children = [...container.querySelectorAll("video, canvas")].filter(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    return {
      media: children.map(element => element.tagName),
      previewHeight: container.getBoundingClientRect().height,
      videoHeight: container.querySelector("video").getBoundingClientRect().height,
    };
  });
  assert.deepEqual(preview.media, ["VIDEO"], "Native video preview must not show an empty staging canvas");
  assert.ok(preview.previewHeight <= Math.max(240, preview.videoHeight + 10), "Preview must not contain a blank canvas row above the video: " + JSON.stringify(preview));
  return gpu;
}
async function createFixtures() {
  await fs.mkdir(runRoot, { recursive: true });
  const ffmpeg = process.env.FFMPEG_EXECUTABLE || path.join(root, "video_ar_backend/tools/FFmpeg/bin/ffmpeg.exe");
  assert.ok(existsSync(ffmpeg), "Install the local FFmpeg runtime or set FFMPEG_EXECUTABLE");
  const videoPath = path.join(runRoot, "DJI_TEST.MP4");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=10:duration=3",
    "-vf", "drawgrid=width=64:height=36:thickness=2:color=white",
    "-an", "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-y", videoPath,
  ]);
  const size = (await fs.stat(videoPath)).size;
  const fx = 440, fy = 440, width = 640, height = 360;
  const document = {
    schema_version: "cesium-dji-trajectory/v1", source_crs: "EPSG:4326",
    flight_info: {
      generator: "DJI 航拍视频信息提取器 browser-regression",
      video_file: "DJI_TEST.MP4",
      video: { width, height, frame_count: 30, duration_ms: 3000, frame_rate_fps: 10, size_bytes: size },
      timeline: "exact SRT PTS anchored to first DJI wall-clock sample",
      altitude_reference: "absolute", ground_altitude_m: 20,
      camera_model: { intrinsics_status: "estimated_from_35mm_equivalent", lens_distortion_status: "not_present_in_DJI_SRT" },
      ar_projection: { mode: "dji_srt_pose_terrain_intersection", readiness: { ready: true } },
    },
    trajectory_points: Array.from({ length: 30 }, (_, i) => ({
      source_timestamp_ms: 1790700000000 + i * 100,
      video_frame_timestamp_ms: 1790700000000 + i * 100,
      video_frame_time_delta_ms: 0, video_sample_index: i, video_time_ms: i * 100,
      coordinates: { longitude: 120 + i * 0.0000005, latitude: 30, altitude: 120, relative_altitude: 100 },
      gimbal_attitude: { yaw: 10, pitch: -65, roll: 4 },
      attitude: { heading: 10, pitch: 0, roll: 0 },
      ar_projection_ready: true,
      camera: { estimated_intrinsics: {
        fx_px: fx, fy_px: fy, cx_px: width / 2, cy_px: height / 2,
        horizontal_fov_degrees: 2 * Math.atan(width / (2 * fx)) * 180 / Math.PI,
        vertical_fov_degrees: 2 * Math.atan(height / (2 * fy)) * 180 / Math.PI,
        quality: "estimated_not_calibrated", method: "35mm-equivalent focal length",
      } },
    })),
  };
  await fs.writeFile(path.join(runRoot, "DJI_TEST_Cesium轨迹.json"), JSON.stringify(document));
  document.flight_info.video_file = "DJI_SECOND.MP4";
  await fs.copyFile(videoPath, path.join(runRoot, "DJI_SECOND.MP4"));
  await fs.writeFile(path.join(runRoot, "DJI_SECOND_Cesium轨迹.json"), JSON.stringify(document));
  document.flight_info.video_file = "DJI_TEST.MP4";
  document.flight_info.video.size_bytes += 1; // Correct codec/media, deliberately wrong source identity.
  await fs.writeFile(path.join(runRoot, "DJI_WRONG_Cesium轨迹.json"), JSON.stringify(document));
}

(async () => {
  await createFixtures();
  await start();
  const executable = process.env.BROWSER_EXECUTABLE || [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ].find(existsSync);
  browser = await chromium.launch({
    executablePath: executable, headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  let context = await newPage();
  await page.locator("#videoArTrajectoryFile").setInputFiles(path.join(runRoot, "DJI_TEST_Cesium轨迹.json"));
  await page.locator("#videoArVideoFile").setInputFiles(path.join(runRoot, "DJI_TEST.MP4"));
  await page.locator("#videoArLoad").click();
  await until("one saved DJI replay", async () => (await records()).length === 1);
  await page.waitForFunction(() => document.querySelector("#videoArProjectionMode")?.textContent?.includes("DJI SRT"));
  assert.equal(await page.locator("#videoArEnableCalibration").isChecked(), false);
  assert.equal(await page.locator("#videoArTimeOffset").isDisabled(), true, "DJI frame PTS must remain authoritative");
  const initialGpu = await projectionReady();
  const pixels = await page.evaluate(() => {
    const video = document.querySelector("#videoArSourceVideo");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < rgba.length; i += 64) colors.add(rgba[i] + "," + rgba[i + 1] + "," + rgba[i + 2]);
    return colors.size;
  });
  assert.ok(pixels > 30, "Decoded grid video must contain actual image pixels");
  checks.push("Extractor-style DJI MP4/SRT identity and PTS accepted; default calibration off");
  checks.push("Projective shader compiles, links and draws real decoded video without GPU errors");
  checks.push("Native video preview occupies one row with no visible blank staging canvas");
  await page.screenshot({ path: path.join(runRoot, "dji-default.jpg"), quality: 75 });
  console.log("DJI video decoded and projected; testing calibration and persistence");

  await openCalibration();
  await page.locator("#videoArSurfaceMode").selectOption("model");
  await page.waitForFunction(() => document.querySelector("#videoArProjectionMode")?.textContent?.includes("倾斜摄影三维表面投影"));
  await page.waitForFunction(() => document.querySelector("#videoArModelStatus")?.textContent?.includes("没有显示"));
  await until("model surface choice saved", async () => (await records())[0]?.settings.video.controls.videoArSurfaceMode === "model");
  await page.locator(".video-ar-control-picker [data-action=start]").click();
  await page.waitForFunction(() => document.querySelector(".vacp-body")?.hidden === false);
  const frozenSize = await page.locator(".video-ar-control-picker canvas").evaluate(canvas => [canvas.width, canvas.height]);
  assert.deepEqual(frozenSize, [640, 360], "Control-point editor must freeze the original frame dimensions");
  await page.locator(".video-ar-control-picker [data-action=cancel]").click();
  await page.waitForFunction(() => document.querySelector(".vacp-body")?.hidden === true);
  await page.locator("#videoArPlay").click();
  await sleep(370);
  await page.locator("#videoArPlay").click();
  await page.locator(".video-ar-control-picker [data-action=start]").click();
  await page.waitForFunction(() => document.querySelector(".vacp-body")?.hidden === false);
  await page.locator(".video-ar-control-picker [data-action=cancel]").click();
  checks.push("Pausing between throttled geometry updates still freezes a matching decoded frame for calibration");

  checks.push("Model mode saves without a flat fallback when no model is loaded; frozen DJI control-point editor opens and cancels cleanly");
  await page.locator("#videoArEnableCalibration").check();
  const overrides = {
    videoArEastOffset: "12", videoArNorthOffset: "-8", videoArHeightOffset: "1.5",
    videoArYawCorrection: "2", videoArPitchCorrection: "-1", videoArRollCorrection: "1",
    videoArFootprintScale: "1.01", videoArTakeoffHeight: "25", videoArSurfaceHeight: "21",
    videoArCameraFx: "450", videoArCameraFy: "445", videoArCameraCx: "322", videoArCameraCy: "179",
    videoArK1: "0.005", videoArK2: "0", videoArK3: "0", videoArP1: "0.001", videoArP2: "0",
  };
  await page.locator("#videoArSurfaceMode").selectOption("plane");
  for (const [id, value] of Object.entries(overrides)) await field(id, value);
  await until("all calibration edits saved without re-upload", async () => {
    const saved = await records();
    if (saved.length !== 1) return false;
    const controls = saved[0].settings.video.controls;
    return controls.videoArEnableCalibration === true && controls.videoArSurfaceMode === "plane"
      && Object.entries(overrides).every(([id, value]) => String(controls[id]) === value);
  });
  const calibratedGpu = await projectionReady();
  assert.ok(calibratedGpu.projectiveDraws > initialGpu.projectiveDraws, "Calibration must redraw the projector");
  assert.equal(await page.locator("#videoArTimeOffset").isDisabled(), true);
  checks.push("Opt-in calibration saves position, datum, plane, attitude, intrinsics and lens coefficients to the same replay");
  await page.screenshot({ path: path.join(runRoot, "dji-calibrated.jpg"), quality: 75 });
  await page.locator("#videoArProgress").evaluate(input => {
    window.videoArDecodedFrames = [];
    input.value = "500"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector("#videoArSourceVideo").currentTime > 1.2);
  await page.waitForFunction(() => window.videoArDecodedFrames.at(-1)?.mediaTime > 1.2);
  const decoded = await page.evaluate(() => window.videoArDecodedFrames.at(-1));
  const expectedLongitude = (120 + Math.round(decoded.mediaTime * 10) * 0.0000005).toFixed(6);
  await until("telemetry follows the decoded video frame rather than the requested seek time", async () => (await page.locator("#videoArPosition").textContent()).startsWith(expectedLongitude + ","));
  assert.ok(Math.abs(decoded.currentTime - decoded.mediaTime) > 0.02, "Synthetic seek must land between coded frames to exercise PTS alignment");
  assert.ok((await page.locator("#videoArFrame").textContent()).includes("/ 30"));
  checks.push("Between-frame seeking projects the decoded frame PTS pose instead of the playback clock");
  await page.locator("#videoArPlay").click();
  await page.waitForFunction(() => document.querySelector("#videoArSourceVideo").currentTime > 1.8);
  await page.locator("#videoArPlay").click();
  checks.push("Seek and playback remain bound to the matching DJI video timeline");

  await context.close();
  await stop();
  await start();
  context = await newPage(); // Fresh storage plus full service restart.
  await projectionReady();
  assert.equal((await records()).length, 1);
  assert.equal(await page.locator("#videoArEnableCalibration").isChecked(), true);
  assert.equal(await page.locator("#videoArSurfaceMode").inputValue(), "plane");
  for (const [id, value] of Object.entries(overrides)) assert.equal(await page.locator("#" + id).inputValue(), value, id);
  assert.equal(await page.locator("#videoArTimeOffset").isDisabled(), true);
  checks.push("Full server restart and a fresh browser context restore calibration and projection");
  await page.screenshot({ path: path.join(runRoot, "dji-restored.jpg"), quality: 75 });
  console.log("Restart restored calibration; checking source isolation");
  const original = (await records())[0];
  let releaseUpload, uploadHeld = false;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadPattern = "**/__library/records/*/files/source?*";
  await page.route(uploadPattern, async route => {
    uploadHeld = true;
    await uploadGate;
    await route.continue();
  });
  await page.locator("#videoArTrajectoryFile").setInputFiles(path.join(runRoot, "DJI_SECOND_Cesium轨迹.json"));
  await page.locator("#videoArVideoFile").setInputFiles(path.join(runRoot, "DJI_SECOND.MP4"));
  assert.equal(await page.locator("#videoArEnableCalibration").isChecked(), false);
  assert.equal(await page.locator("#videoArK1").inputValue(), "0");
  assert.equal(await page.locator("#videoArCameraFx").inputValue(), "");
  assert.equal(await page.locator("#videoArTakeoffHeight").inputValue(), "");
  await openCalibration();
  await page.locator(".video-ar-control-picker [data-action=start]").click();
  assert.equal(await page.locator(".vacp-body").isVisible(), false, "Selecting a new source must not expose the old replay calibration frame");
  assert.ok((await page.locator(".vacp-status").textContent()).includes("请先加载"));
  checks.push("A newly selected but not yet loaded video cannot inherit control-point calibration from the old frame");
  await page.locator("#videoArLoad").click();
  await until("second video upload deliberately held", () => uploadHeld);
  await openCalibration();
  await page.locator("#videoArEnableCalibration").check();
  await field("videoArK1", "0.01");
  await sleep(300); // Let debounced settings writes expose a wrong active-record binding.
  assert.deepEqual((await records()).find(record => record.id === original.id).settings, original.settings);
  releaseUpload();
  await page.unroute(uploadPattern);
  await until("second video saved", async () => (await records()).length === 2);
  checks.push("Selecting a new source resets calibration; edits while its upload is pending cannot overwrite the prior replay");

  // Simulate a genuine record saved before calibration fields existed, then
  // switch A -> legacy B within one page so stale DOM values cannot hide.
  const second = (await records()).find(record => record.id !== original.id);
  await until("second video settings settled", async () => (await records()).find(record => record.id === second.id).settings.video.controls.videoArK1 === "0.01");
  const legacyVideo = { ...second.settings.video, controls: { videoArHfov: "84", videoArVfov: "53", videoArTerrain: true } };
  const patched = await fetch(base + "/__library/records/" + second.id, {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-Cesium-Library": "1", Origin: base },
    body: JSON.stringify({ settings: { video: legacyVideo } }),
  });
  assert.equal(patched.ok, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#libraryStatus")?.textContent?.includes("已保存到本机"));
  await page.locator('[data-tab="videoar"]').click();
  await page.locator(".saved-library").evaluate(details => { details.open = true; });
  await page.locator('[data-saved-id="' + original.id + '"]').getByRole("button", { name: "使用", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#videoArEnableCalibration")?.checked === true);
  await page.locator('[data-saved-id="' + second.id + '"]').getByRole("button", { name: "使用", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#videoArEnableCalibration")?.checked === false);
  for (const id of ["videoArCameraFx", "videoArCameraFy", "videoArTakeoffHeight", "videoArSurfaceHeight"]) {
    assert.equal(await page.locator("#" + id).inputValue(), "", id);
  }
  assert.equal(await page.locator("#videoArK1").inputValue(), "0");
  await projectionReady();
  checks.push("An older replay without calibration fields restores defaults after switching from a calibrated replay");
  console.log("Source isolation passed; checking wrong-video rejection");

  // Calibration permission must never turn a different video's telemetry into
  // a valid projector. No user-owned files or existing replay are changed.
  await page.locator("#videoArTrajectoryFile").setInputFiles(path.join(runRoot, "DJI_WRONG_Cesium轨迹.json"));
  await page.locator("#videoArVideoFile").setInputFiles(path.join(runRoot, "DJI_TEST.MP4"));
  await openCalibration();
  await page.locator("#videoArEnableCalibration").check();
  await page.locator("#videoArLoad").click();
  await page.waitForFunction(() => /不一致|错配|未投影/.test(document.querySelector("#videoArProjectionMode")?.textContent || ""));
  const rejectedMode = await page.locator("#videoArProjectionMode").textContent();
  assert.match(rejectedMode, /未投影|未加载|关闭|缺少|不一致/, "Mismatched video must not retain an active projection");
  const beforeRejectedDraws = await page.evaluate(() => window.videoArGpu.projectiveDraws);
  await sleep(650);
  assert.equal(await page.evaluate(() => window.videoArGpu.projectiveDraws), beforeRejectedDraws, "Rejected source must never draw another projected frame");
  checks.push("Wrong source-video size is rejected even when manual calibration is enabled");

  const gpu = await page.evaluate(() => window.videoArGpu);
  assert.deepEqual(gpu.failures, []);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(webglErrors, []);
  const result = { result: "PASS", checks, artifacts: runRoot, initialGpu, calibratedGpu, restoredGpu: gpu, pageErrors, webglErrors };
  await fs.writeFile(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
  console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(runRoot, "failure.jpg"), quality: 75 }).catch(() => {});
    const diagnostics = await page.evaluate(() => ({
      status: document.querySelector("#videoArStatus")?.textContent,
      mode: document.querySelector("#videoArProjectionMode")?.textContent,
      library: document.querySelector("#libraryStatus")?.textContent,
      frame: document.querySelector("#videoArFrame")?.textContent,
      gpu: window.videoArGpu,
    })).catch(() => ({}));
    console.error(JSON.stringify(diagnostics, null, 2));
  }
  await fs.writeFile(path.join(runRoot, "result.json"), JSON.stringify({ result: "FAIL", message: error.stack, checks, pageErrors, webglErrors }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  await browser?.close();
  await stop();
  await fs.writeFile(path.join(runRoot, "server.log"), serverLog);
});
