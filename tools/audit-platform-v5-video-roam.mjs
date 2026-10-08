import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { adaptSafetyVideoRoam } from "../src/safetyVideoRoamData.ts";

// Read-only real-asset audit. No GPU, no generated recording, no survey datum inference.
const root = process.cwd(), output = path.join(root, "output/platform-v5");
const library = path.join(root, "project-data/records"), execute = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { scope: "Actual saved recording metadata plus DJI SRT source audit; not video-roam visual/synchronization acceptance",
  auditedAt: new Date().toISOString(), readOnly: true, createdFormalObjects: 0, records: [] };
for (const entry of await fs.readdir(library, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const recordPath = path.join(library, entry.name, "record.json");
  let recordBytes; try { recordBytes = await fs.readFile(recordPath); } catch { continue; }
  const record = JSON.parse(recordBytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (record.kind !== "Drone Video") continue;
  const resolveFile = file => {
    if (!file?.url?.startsWith(`/__library/files/${entry.name}/`)) throw new Error("Unexpected record file ownership");
    const relative = decodeURIComponent(file.url.slice(`/__library/files/${entry.name}/`.length));
    const target = path.resolve(library, entry.name, relative);
    if (!target.startsWith(path.resolve(library, entry.name) + path.sep)) throw new Error("File escaped record directory");
    return target;
  };
  const sourceBytes = await fs.readFile(resolveFile(record.files.source));
  const raw = JSON.parse(sourceBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const videoPath = resolveFile(record.files.video), videoStat = await fs.stat(videoPath);
  const { stdout } = await execute(path.join(root, "video_ar_backend/tools/FFmpeg/bin/ffprobe.exe"),
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration,nb_frames,codec_name:format=duration", "-of", "json", videoPath],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout), stream = probe.streams[0];
  const decoded = { name: record.files.video.name, sizeBytes: videoStat.size, width: stream.width, height: stream.height,
    durationSeconds: Number(stream.duration ?? probe.format.duration) };
  const result = adaptSafetyVideoRoam(record, raw, decoded);
  report.records.push({ id: record.id, videoName: record.files.video.name, metadata: decoded, sourceCodec: stream.codec_name,
    sourceFrameCount: Number(stream.nb_frames), sourceCrs: raw.source_crs, sourceAltitudeReference: raw.flight_info?.altitude_reference,
    sourceBodyAttitude: raw.flight_info?.body_attitude_status, sourceIntrinsics: raw.flight_info?.camera_model?.intrinsics_status,
    savedHeightMode: record.settings.video?.controls?.videoArHeightMode, savedCalibrationSessionCount: record.settings.video?.calibrationSessions?.length || 0,
    recordSha256: sha(recordBytes), sourceSha256: sha(sourceBytes), available: result.available, audit: result.audit,
    rawBusinessFilesUnchanged: sha(await fs.readFile(recordPath)) === sha(recordBytes) && sha(await fs.readFile(resolveFile(record.files.source))) === sha(sourceBytes) });
}
report.conclusion = report.records.every(record => !record.available && record.audit.recordingMatched && record.audit.timelineMatched)
  ? "Actual recording and media timeline are matched; camera roaming is correctly disabled because no verified vertical reference is supplied. G13 real-flight following remains blocked, not passed."
  : "Review individual source/clock/datum results. This metadata audit is not G13 rendering acceptance.";
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "video-roam-data-audit.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.records.map(record => ({ id: record.id, samples: record.audit.sampleCount,
  videoMatched: record.audit.recordingMatched, timelineMatched: record.audit.timelineMatched, available: record.available, missing: record.audit.missing })), null, 2));
