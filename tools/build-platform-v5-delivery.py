"""Build the V5 delivery only after final acceptance and the local Git commit.

Preparation does not run this script. Example final command:
  ar_v2/.venv/Scripts/python.exe tools/build-platform-v5-delivery.py

This does not run a browser, start services, edit project data, or commit/push Git.
It refuses incomplete reports, an uncommitted source tree, and existing destinations.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output/platform-v5"
BASELINE = "1f43dcdccf8344b8073c2dfb8fe422b67ca6a35d"
STATE_NAMES = [
    "01-home", "02-empty", "03-config", "04-draw-area", "05-draw-rail",
    "06-risk-create", "07-shape-edit", "08-saved", "09-inspection", "10-replay",
    "11-risk-list", "12-risk-detail", "13-risk-handle", "14-components",
    "15-component-detail", "16-drawing", "17-layers", "18-settings", "19-error",
    "20-inspection-empty", "21-video-roam", "22-model-optimize",
]
VIDEOS = [
    ("01-manual-definition-workflow.mp4", "人工定义、编辑、失败重试与刷新恢复", "isolated-real-project"),
    ("02-business-linkage-workflow.mp4", "实际历史视频、隔离处置记录与现有 CAD 资料联动", "isolated-real-project"),
    ("03-video-and-model-capabilities.mp4", "真实视频媒体时间与模型检查；漫游和几何修复阻塞如实展示", "isolated-real-project"),
    ("04-real-project-viewer.mp4", "真实工程同镜头展示／实景、纯三维与旋转侧壁", "isolated-real-project"),
    ("05-world-effects.mp4", "世界坐标动效、旋转缩放、暂停与减少动态", "isolated-real-project"),
]
SCENE_SHOTS = [
    "v5-01-showcase-overview.png", "v5-02-reality-same-camera.png",
    "v5-03-showcase-scene-only.png", "v5-04-reality-scene-only.png",
    "v5-05-rotated-sidewall.png", "v5-overview-2048x988.png", "v5-overview-1366x768.png",
]
MOTION_SHOTS = [
    "motion-01-focused.png", "motion-02-rotated.png", "motion-03-zoomed.png",
    "motion-04-paused-start.png", "motion-05-paused-after-3s.png",
    "motion-06-reduced-start.png", "motion-07-reduced-after-3s.png",
]
CORE_REPORTS = {
    "main": "acceptance-report.json",
    "scene": "scene-acceptance-report.json",
    "edges": "edge-acceptance-report.json",
    "motion": "motion-acceptance-report.json",
    "production": "production/production-acceptance-report.json",
}
REQUIRED_REPORTS = [
    "baseline-data.json", "video-roam-data-audit.json", "model-optimization-readonly.json",
    "workspace-integration-cpu.json", "cpu-regression-report.json", "unit-tests.log", "typecheck.log", "build.log",
    "cad-regression.log", "video-ar-regression.log", "video-roam-cpu-tests.log",
]
OPTIONAL_REPORTS = [
    "cpu-validation.json", "recording-decode-review.json", "cad-regression-report.json", "video-ar-regression-report.json", "material-pixel-comparison.json", "visual-review.json",
    "hotpath-regression-report.json", "hotpath-regression.log", "reference-inspection.json",
    "test-files.txt", "model-optimization-ui-tests.log", "model-optimization-ui-report.json",
    "ar-v2-unit-tests.log", "video-ar-backend-unit-tests.log", "video-ar-frame-state.log",
    "workspace-integration-cpu.log", "scene-acceptance.log", "acceptance.log",
    "edge-acceptance.log", "motion-acceptance.log", "production-acceptance.log",
    "final-wave.json", "evidence-manifest.json", "gallery-validation.json",
]
DOCS = ["docs/platform-v5-acceptance.md", "docs/platform-v5-video-roam.md"]
GATE_REPORT_KEYS = {
    "G01": ["scene", "production", "ui"], "G02": ["main", "production", "ui"],
    "G03": ["scene"], "G04": ["scene"], "G05": ["scene", "main", "production"],
    "G06": ["main", "motion", "production"], "G07": ["main", "edges"],
    "G08": ["main", "edges", "production"], "G09": ["main", "production"],
    "G10": ["main", "production", "ui"], "G11": ["main", "motion", "workspace"],
    "G12": ["main", "scene", "motion", "production"],
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def read_json(path: Path) -> dict:
    require(path.is_file(), f"缺少最终记录：{path}")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    require(isinstance(value, dict), f"报告必须是 JSON 对象：{path}")
    return value


def verified_empty_log(path: Path) -> bool:
    """Quiet compiler commands legitimately emit no text. Require their own result,
    rather than treating every empty log (or other empty artifact) as successful.
    """
    if path.suffix.lower() != ".log":
        return False
    resolved = path.resolve()
    for kind in ("typecheck", "build"):
        if resolved == (OUTPUT / (kind + ".log")).resolve():
            report = read_json(OUTPUT / "cpu-regression-report.json")
            result = report.get(kind, {})
            return (report.get("result") == "passed" and isinstance(result, dict)
                    and result.get("passed") is True and result.get("log") == path.name)
        if resolved == (ROOT / "output/platform-v5-ui" / (kind + ".log")).resolve():
            report = read_json(ROOT / "output/platform-v5-ui/final-validation.json")
            exit_code = report.get(kind + "Exit")
            return type(exit_code) is int and exit_code == 0
    return False


def existing(path: Path) -> Path:
    require(path.is_file(), f"缺少文件：{path}")
    require(path.stat().st_size > 0 or verified_empty_log(path),
            f"文件为空且缺少对应结构化成功结果：{path}")
    return path


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=ROOT)


def relative_asset(directory: Path, filename: str) -> Path:
    """Reports may name evidence, but cannot select unrelated local files."""
    require(isinstance(filename, str) and bool(filename), "证据文件名为空")
    candidate = (directory / filename).resolve()
    require(candidate.is_relative_to(directory.resolve()), f"证据超出指定目录：{filename}")
    return existing(candidate)


def validate_report(label: str, report: dict) -> None:
    require(not report.get("failure") and not report.get("recordingError"), f"{label} 仍有失败记录")
    require(bool(report.get("checks")), f"{label} 缺少实际检查条目")
    # Edge runner intentionally has no result field; require its complete 12 checks.
    if label == "edges" and "result" not in report:
        require(len(report["checks"]) >= 12, "边界验收记录未完成")
        for field in ("pageErrors", "consoleErrors", "blockedWrites"):
            require(not report.get(field), f"边界验收存在 {field}")
    else:
        require(report.get("result") == "passed", f"{label} 尚未通过，不打包阶段性记录")
    require(not any(isinstance(c, dict) and c.get("pass") is False for c in report["checks"]), f"{label} 有失败的检查")
    require(not report.get("errors") and not report.get("pageErrors"), f"{label} 存在页面错误")
    if label == "production":
        require(not report.get("unexpectedConsoleErrors"), "正式工程仍有未解释控制台错误")
        require(not report.get("unexpectedFailedRequests"), "正式工程仍有未解释请求失败")


def parse_final_gates(text: str) -> list[dict]:
    rows = {}
    for line in text.splitlines():
        cells = [part.strip() for part in line.split("|")]
        if len(cells) < 5:
            continue
        match = re.match(r"(G\d{2})\b", cells[1])
        if match:
            rows[match.group(1)] = {"id": match.group(1), "title": cells[1],
                "documentStatus": cells[2].replace("**", ""), "detail": cells[3]}
    require(len(rows) == 14, "验收文档尚未包含完整 G01—G14 结果表")
    for number in range(1, 13):
        gate = rows[f"G{number:02}"]
        status = gate["documentStatus"]
        require("通过" in status and not any(word in status for word in ("未通过", "待", "初验", "进行中", "整理中", "部分", "阻塞", "未完成")),
                f"{gate['id']} 文档尚未给出最终通过结论：{status}")
        gate["status"] = "passed"
        gate["reportKeys"] = GATE_REPORT_KEYS[gate["id"]]
    for number, reason in [(13, "同录像高程基准未核验，真实空间漫游和实际同步延迟尚未验收"),
                           (14, "尚无受支持可编辑源网格、处理服务和核验候选，几何修复未执行")]:
        gate = rows[f"G{number:02}"]
        require(any(word in gate["documentStatus"] for word in ("阻塞", "未通过", "未完成", "未执行")),
                f"{gate['id']} 必须保留当前真实阻塞，不能由打包脚本改成通过")
        gate["status"] = "blocked"
        gate["blockedReason"] = reason
    return [rows[f"G{number:02}"] for number in range(1, 15)]


def check_committed_source() -> tuple[str, str]:
    commit = git("rev-parse", "HEAD").decode().strip()
    branch = git("branch", "--show-current").decode().strip()
    subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, "HEAD"], cwd=ROOT, check=True)
    require(not git("diff", "--name-only", "HEAD").strip(),
            "源码／文档仍有未提交改动。最终验收完成并提交后再运行，避免源码 ZIP 与画面不一致。")
    untracked = git("ls-files", "--others", "--exclude-standard", "-z").decode("utf-8").split("\0")
    source_paths = [p for p in untracked if p and (p.startswith(("src/", "server/", "docs/", "tools/"))
                    or p in {"package.json", "pnpm-lock.yaml", "README.md"})]
    require(not source_paths, "还有未纳入源码归档的文件：" + ", ".join(source_paths[:8]))
    return commit, branch


def report_brief(report: dict) -> dict:
    return {key: report[key] for key in ("scope", "result", "summary", "startedAt", "completedAt",
            "checkedAt", "timings", "performance", "environment", "homeScreenshotFinalization", "pass", "fail", "passed", "failed") if key in report}


def make_gallery(metadata: dict, screenshots: list[dict], videos: list[dict], gate_rows: list[dict]) -> str:
    esc = lambda value: html.escape(str(value), quote=True)
    title = "Cesium V5 · 实际项目交付"
    screenshot_groups = []
    for category, heading, note in [
        ("production", "正式工程：保留原有 1 条铁路范围", "只读操作真实项目，没有创建验收对象；正式事件和资料缺项保持真实空态。"),
        ("scene", "真实三维场景与三种分辨率", "同一工程的展示、实景、纯三维与旋转侧壁。显示厚度不改工程高程。"),
        ("states", "22 个实际功能状态及操作记录", "使用真实工程模型、原视频与 CAD，业务创建写入隔离目录；其中事件为明确标注的人工验收记录。第 21、22 状态保留真实能力阻塞。"),
        ("motion", "世界坐标效果和静止对照", "旋转和缩放后的真实空间锚点；暂停和减少动态至少 3 秒对照。"),
    ]:
        items = [shot for shot in screenshots if shot["category"] == category]
        cards = "".join(f'<a class="shot" href="{esc(s["path"])}" target="_blank"><img loading="lazy" src="{esc(s["path"])}" alt="{esc(s["name"])}"><span>{esc(s["name"])}</span></a>' for s in items)
        screenshot_groups.append(f'<section><h2>{heading}</h2><p class="muted">{note}</p><div class="screens">{cards}</div></section>')
    video_html = "".join(f'<article><h3>{esc(v["title"])}</h3><video controls preload="metadata" src="{esc(v["path"])}" poster="screens/scene/v5-01-showcase-overview.png"></video><p class="muted">实际操作 {v["actualDurationMs"] / 1000:.3f} 秒 · 编码 {esc(v.get("encodedFps", "未记录"))} FPS（不代表平台帧率）</p><a download href="{esc(v["path"])}">下载录像</a></article>' for v in videos)
    gates_html = "".join(f'<tr><th>{esc(g["title"])}</th><td class="{g["status"]}">{esc(g["documentStatus"])}</td><td>{esc(g["detail"])}</td></tr>' for g in gate_rows)
    performance = metadata["reports"]["main"].get("performance", {})
    perf_html = "本次性能数据详见完整运行报告。"
    if isinstance(performance, dict) and isinstance(performance.get("fps"), (int, float)):
        dropped = performance.get("droppedVideoFrames", "未记录")
        perf_html = f'实际 Viewer 与原 4K 视频同时运行：{performance["fps"]:.2f} FPS；播放器累计丢帧 {esc(dropped)}（未分离采样窗增量）。'
        if performance.get("meetsTarget") is False:
            perf_html += "未达到记录中的目标帧率，不能以录像编码帧率代替此实测。"
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#07111e;color:#e4eff8;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}}main{{max-width:1380px;margin:auto;padding:32px 24px 64px}}h1{{font-size:30px;margin:0 0 14px}}h2{{font-size:23px;margin:38px 0 14px}}h3{{font-size:17px;margin:0 0 12px}}a{{color:#56cce7}}.muted,small{{color:#a2b4c5}}.links{{display:flex;gap:18px;flex-wrap:wrap;margin:20px 0}}.notice,article{{border:1px solid #2b4960;border-radius:10px;background:#0c1c2d;padding:18px}}.notice{{border-left:4px solid #ebaa58}}.blocked{{color:#ffd09a}}.passed{{color:#8be0c3}}.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}}video{{width:100%;aspect-ratio:16/9;background:#07111e}}.screens{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}}.shot{{display:block;border:1px solid #2b4960;border-radius:7px;overflow:hidden;background:#0c1c2d}}.shot img{{width:100%;aspect-ratio:16/9;object-fit:contain;display:block}}.shot span{{display:block;font-size:12px;padding:8px;overflow-wrap:anywhere}}.compare{{position:relative;aspect-ratio:16/9;overflow:hidden;border:1px solid #2b4960;border-radius:10px;background:#07111e}}.compare img{{position:absolute;width:100%;height:100%;object-fit:contain}}.compare .front{{clip-path:inset(0 50% 0 0)}}.tag{{position:absolute;top:12px;background:#07111edf;padding:3px 12px;border-radius:5px}}.left{{left:12px}}.right{{right:12px}}.slider{{width:100%;accent-color:#56cce7}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{border:1px solid #2b4960;padding:9px;text-align:left;vertical-align:top}}th{{min-width:150px}}code{{overflow-wrap:anywhere}}@media(max-width:850px){{main{{padding:20px}}.grid,.screens{{grid-template-columns:1fr}}h1{{font-size:24px}}.table-wrap{{overflow-x:auto}}}}
</style></head><body><main>
<p class="muted">邻近营业线施工安全平台 · 已有真实工程 · 单 Viewer</p><h1>{title}</h1>
<p>按认可模板接入当前平台，保留工程模型、原始视频和人工对象。源纹理保留蓝灰明暗，展示外缘、底座与业务范围分别管理。</p>
<div class="notice"><strong>G01—G12：结论来自最终实际验收报告和下表。G13、G14：仍有明确阻塞，未全部完成。</strong><br>
<span class="blocked">G13：同录像的高程基准尚未核验，正式空间漫游禁用；视频独立播放可用，未宣称实际飞行同步延迟通过。</span><br>
<span class="blocked">G14：真实发布瓦片检查可用，但尚无受支持源网格、处理服务和核验候选，未执行几何修复及真实版本应用／回退。</span><br>
<small>正式台账原有 1 条铁路范围继续保留。录像中的施工区、铁路范围、风险点和处置事件为隔离验收记录，没有写入正式台账。参考视频、概念图、合成场景未收作本页项目证据。</small></div>
<nav class="links"><a href="docs/acceptance.html">完整实施与验收说明</a><a href="docs/platform-v5-video-roam.md">视频数据与接线说明</a><a href="Cesium-V5-source.zip" download>源码 ZIP</a><a href="Cesium-V5-changes.patch" download>相对基线的补丁</a><a href="release.json">版本及证据来源</a><a href="manifest-sha256.json">文件 SHA-256 清单</a></nav>
<h2>实际三维同镜头对照</h2><div class="compare"><img src="screens/scene/v5-04-reality-scene-only.png" alt="同镜头原材质与完整工程"><img id="front" class="front" src="screens/scene/v5-03-showcase-scene-only.png" alt="蓝灰保色材质与独立展示底座"><span class="tag left">展示</span><span class="tag right">实景</span></div><label for="compare-range">拖动比较 <input id="compare-range" class="slider" type="range" min="0" max="100" value="50" oninput="document.getElementById('front').style.clipPath='inset(0 '+(100-this.value)+'% 0 0)'"></label>
<p class="muted">隐藏 HTML 面板拍摄，使用同一工程网格和同一镜头。以真实地物可辨、原材质恢复及显示外缘正确为准，不把色差大小或显示调整算作网格修复。</p>
<h2>五段实际浏览器操作录像</h2><div class="grid">{video_html}</div><p class="muted">{perf_html}</p>
{''.join(screenshot_groups)}
<h2>十四项验收结论</h2><div class="table-wrap"><table><thead><tr><th>门槛</th><th>最终结论</th><th>证据与范围</th></tr></thead><tbody>{gates_html}</tbody></table></div>
<nav class="links"><a href="reports/acceptance-report.json">隔离业务流程</a><a href="reports/scene-acceptance-report.json">真实三维</a><a href="reports/edge-acceptance-report.json">取点与保存边界</a><a href="reports/motion-acceptance-report.json">世界动效</a><a href="reports/production/production-acceptance-report.json">正式工程只读检查</a><a href="reports/video-roam-data-audit.json">真实视频数据审计</a><a href="reports/model-optimization-readonly.json">真实模型只读检查</a></nav>
<h2>继续使用现有工程</h2><p>在源码根目录双击 <code>启动安全巡检大屏.cmd</code>，或 <code>pnpm dev</code> 后打开 <a href="http://127.0.0.1:5173/?screen=safety">http://127.0.0.1:5173/?screen=safety</a>。原模型与视频仍使用当前 <code>project-data</code>；本包不复制 GB 级原资产。</p>
<p class="muted">分支 {esc(metadata['branch'])} · 提交 {esc(metadata['commit'])}<br>补丁基线 {BASELINE}。源码 ZIP 来自该提交的 git archive；正式数据不打进源码归档。工程精度、视频光学配准和模型几何修复分别保留核验范围。</p>
</main></body></html>'''


def build(args: argparse.Namespace) -> dict:
    out = OUTPUT.resolve()
    require(out.is_dir(), f"证据目录不存在：{out}")
    dest = (out / args.destination).resolve()
    archive = (out / args.archive_name).resolve()
    require(dest != out and dest.is_relative_to(out), "交付目录必须位于 output/platform-v5 内")
    require(archive.parent == out and archive.suffix.lower() == ".zip", "归档文件必须是证据目录下的 ZIP 文件")
    require(not dest.exists() and not archive.exists() and not archive.with_suffix(".sha256").exists(), "目标已存在；不覆盖旧包，请指定新的 --destination 和 --archive-name")

    reports = {key: read_json(out / name) for key, name in CORE_REPORTS.items()}
    for label, report in reports.items():
        validate_report(label, report)
    ui_path = ROOT / "output/platform-v5-ui/dom-report.json"
    reports["ui"] = read_json(ui_path)
    require(reports["ui"].get("passed", 0) > 0 and reports["ui"].get("failed") == 0 and not reports["ui"].get("errors"), "UI 回归尚未通过")
    reports["workspace"] = read_json(out / "workspace-integration-cpu.json")
    require(reports["workspace"].get("pass", 0) >= 14 and reports["workspace"].get("fail") == 0, "Workspace CPU 边界回归尚未通过")
    require(reports["workspace"].get("sourceSha256") == digest(ROOT / "src/safetyWorkspace.ts"), "Workspace 代码已改变，请重新生成其 CPU 回归证据")
    require(set(reports["main"].get("requiredStates", [])) == set(STATE_NAMES), "主报告不是完整 22 状态 V5 验收")
    required_images = {name + ".png" for name in STATE_NAMES}
    require(required_images.issubset(set(reports["main"].get("screenshots", []))), "主报告缺少 V5 状态截图")
    require(bool(reports["production"].get("screenshots")), "缺少正式工程实际截图")
    for path in REQUIRED_REPORTS:
        existing(out / path)
    for path in DOCS:
        existing(ROOT / path)
    document = (ROOT / DOCS[0]).read_text(encoding="utf-8-sig")
    gates = parse_final_gates(document)
    commit, branch = check_committed_source()

    baseline = read_json(out / "baseline-data.json")
    require(baseline.get("baselineCommit") == BASELINE, "基线报告与补丁基线不符")
    original = baseline.get("spatialSnapshot", {}).get("objects", [])
    original_railways = [obj for obj in original if obj.get("kind") == "railway" and not obj.get("deletedAt")]
    require(len(original_railways) == 1, "正式工程基线应保留 1 条既有铁路范围，请核对新数据来源后再打包")

    # Explicit categories prevent concept/reference media and CPU fixture screenshots
    # from being misrepresented as actual production evidence.
    screen_sources: list[tuple[Path, str, str]] = []
    for name in reports["production"]["screenshots"]:
        screen_sources.append((relative_asset(out / "production", name), "production", name))
    for name in SCENE_SHOTS:
        screen_sources.append((relative_asset(out, name), "scene", name))
    for name in reports["main"]["screenshots"]:
        require(name.endswith(".png") and Path(name).name == name and "acceptance-failure" not in name, f"不能收录阶段失败或非状态画面：{name}")
        screen_sources.append((relative_asset(out, name), "states", name))
    for name in MOTION_SHOTS:
        screen_sources.append((relative_asset(out, name), "motion", name))
    # A real final extra still needs an explicit name; never glob reference/concept images.
    for name in ["edge-acceptance-complete.png", "boundary-01-overhead-showcase.png", "boundary-02-overhead-reality.png", "boundary-03-overhead-rotated.png"]:
        if (out / name).is_file():
            screen_sources.append((out / name, "states", name))

    recordings = {}
    for key in ("main", "scene", "motion"):
        for record in reports[key].get("recordings", []):
            if isinstance(record, dict) and record.get("file"):
                recordings[record["file"]] = {**record, "reportKey": key}
    video_records = []
    for name, title, category in VIDEOS:
        existing(out / name)
        record = recordings.get(name)
        require(record is not None and record.get("actualDurationMs", 0) > 0 and record.get("capturedFrames", 0) > 5,
                f"录像缺少实际浏览器捕获记录：{name}")
        video_records.append({**record, "path": "videos/" + name, "title": title, "category": category})

    # All preflight checks precede creation. No deletion or movement of existing data.
    dest.mkdir(parents=True, exist_ok=False)
    packaged = set()
    provenance = {}

    def copy(source: Path, target: str, scope: str) -> None:
        target_path = (dest / target).resolve()
        require(target_path.is_relative_to(dest), f"非法交付路径：{target}")
        key = target_path.relative_to(dest).as_posix()
        if key in packaged:
            return
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(existing(source), target_path)
        packaged.add(key)
        provenance[key] = {"source": source.relative_to(ROOT).as_posix(), "scope": scope,
                           "sourceSha256": digest(source)}

    shots = []
    for source, category, name in screen_sources:
        path = f"screens/{category}/{name}"
        copy(source, path, "production-readonly" if category == "production" else "isolated-real-project")
        if not any(s["path"] == path for s in shots):
            shots.append({"name": name, "category": category, "path": path})
    for record in video_records:
        copy(out / record["file"], record["path"], "isolated-real-project-browser-recording")
    for filename in dict.fromkeys([*CORE_REPORTS.values(), *REQUIRED_REPORTS]):
        copy(out / filename, "reports/" + filename, "acceptance-report-or-log")
    for filename in OPTIONAL_REPORTS:
        if (out / filename).is_file():
            scope = "reference-reading-metadata-only-not-project-evidence" if filename == "reference-inspection.json" else "supporting-report-or-log"
            copy(out / filename, "reports/" + filename, scope)
    decode_report = out / "recording-decode-review.json"
    if decode_report.is_file():
        decoded = json.loads(decode_report.read_text(encoding="utf-8-sig"))
        require(isinstance(decoded, list) and len(decoded) == 5, "录像解码记录必须覆盖五段实际成片")
        for record in decoded:
            require(record.get("file") in {name for name, _, _ in VIDEOS}, "解码记录含未知录像")
            for frame in record.get("reviewFrames", []):
                require(frame.startswith("video-review/"), "抽帧证据必须来自实际成片核验目录")
                copy(relative_asset(out, frame), "reports/" + frame, "decoded-actual-project-recording-review-frame")
    copy(ui_path, "reports/ui/dom-report.json", "CPU-isolated-DOM-not-real-project-rendering")
    for filename in ("test-run.log", "typecheck.log", "build.log", "final-validation.json", "geocoder-attribution-report.json"):
        path = ui_path.parent / filename
        if path.is_file():
            copy(path, "reports/ui/" + filename, "isolated-UI-validation")
    for path in DOCS:
        copy(ROOT / path, "docs/" + Path(path).name, "implementation-and-limitations")
    doc_page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V5 实施与验收</title><style>body{max-width:1100px;margin:30px auto;padding:0 20px;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}pre{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}</style><a href="../index.html">返回交付画册</a><pre>' + html.escape(document) + '</pre></html>'
    (dest / "docs/acceptance.html").write_text(doc_page, encoding="utf-8")

    subprocess.run(["git", "archive", "--format=zip", "--output", str(dest / "Cesium-V5-source.zip"), commit], cwd=ROOT, check=True)
    with zipfile.ZipFile(dest / "Cesium-V5-source.zip") as source_zip:
        require(not any(n.startswith("project-data/") for n in source_zip.namelist()), "源码归档意外包含正式 project-data")
    (dest / "Cesium-V5-changes.patch").write_bytes(git("diff", "--binary", BASELINE, commit))
    metadata = {
        "version": 1, "createdAt": datetime.now(timezone.utc).isoformat(), "branch": branch, "commit": commit,
        "baseline": BASELINE, "releaseStatus": "G01-G12-verified-with-G13-G14-blocked", "gates": gates,
        "realModel": "Production_2", "viewerCount": 1,
        "productionData": {"existingRailwayCount": 1, "existingRailwayIds": [r["id"] for r in original_railways],
            "preservation": "See final production report and unchanged JSON/snapshot evidence. No test objects were written to this ledger."},
        "isolatedData": "Fresh 0/0/0 start; mouse-picked manual objects and an explicitly named test event were created only in isolated acceptance storage. Images use actual project model/video/CAD assets.",
        "sourceAssets": "Original GB-scale project-data assets are not included. Source ZIP is git archive of the stated commit; binary patch uses the stated baseline.",
        "excludedEvidence": "Reference videos, prototype/concept imagery, synthetic scenes and isolated DOM fixture screenshots are not presented as actual project evidence.",
        "recordings": video_records, "screenshots": shots,
        "reports": {key: report_brief(value) for key, value in reports.items()},
        "evidenceProvenance": provenance,
    }
    (dest / "release.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    (dest / "index.html").write_text(make_gallery(metadata, shots, video_records, gates), encoding="utf-8")
    manifest = {p.relative_to(dest).as_posix(): {"bytes": p.stat().st_size, "sha256": digest(p)}
                for p in sorted(dest.rglob("*")) if p.is_file()}
    (dest / "manifest-sha256.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=5) as bundle:
        for path in sorted(dest.rglob("*")):
            if path.is_file():
                bundle.write(path, "Cesium-V5/" + path.relative_to(dest).as_posix())
    summary = {"archive": str(archive), "gallery": str(dest / "index.html"), "bytes": archive.stat().st_size,
               "sha256": digest(archive), "files": len(manifest) + 1, "screenshots": len(shots), "recordings": len(video_records),
               "commit": commit, "blockedGates": ["G13", "G14"]}
    (archive.with_suffix(".sha256")).write_text(summary["sha256"] + "  " + archive.name + "\n", encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", default="delivery", help="New directory relative to output/platform-v5; existing directories are never replaced.")
    parser.add_argument("--archive-name", default="Cesium-V5-实际项目交付.zip", help="New ZIP basename under output/platform-v5.")
    args = parser.parse_args()
    try:
        result = build(args)
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"V5 交付未生成：{error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
